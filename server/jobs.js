/* Job queue: one GPU, so one job at a time.
   Jobs run in arrival order; state lives in SQLite (not memory), so a
   restart loses nothing already produced. */
import { PROFILS, profilDuJob } from './allege.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import { demoPublique, etatH3 } from './h3.js'
import { aiToolkitPret, arreterEntrainement, dureeEstimeeMs, entrainer, moteurEntrainementPret, MOTEURS_ENTRAINEMENT, preparerEntrainement } from './entrainement.js'

export const H3_MESSAGE_DEMO = 'MiniMax H3 n’est pas disponible sur cette démo : elle est hébergée dans l’Union européenne, que la licence MiniMax H3 exclut. Installe la version GitHub chez toi, si ta région est autorisée, pour l’utiliser.'
/* H3 availability refreshed every 30 s so enqueue stays synchronous. */
let h3Disponible = false
const relireH3 = () => etatH3().then(e => { h3Disponible = e.disponible }).catch(() => {})
relireH3(); setInterval(relireH3, 30_000).unref()
import * as comfy from './comfy.js'
import { blocOllama, pourRendu } from './gpu.js'
import { aReecrire, reecrireFlux3 } from './flux3Upsampler.js'
import * as sdk from './transport-sdk.js'
import * as store from './db.js'
import { enregistrer as enregistrerPersona, SANS_PERSONNAGE, identityPreambleFor, HUMAIN, lorasPhoto, persona, personaDuDepot, triggerPrefix } from './persona.js'
import { ensurePoster } from './poster.js'
import { controlerJob } from './controle.js'
import * as wildcards from './wildcards.js'
import * as vision from './vision.js'
import { t0Hit, t0Mineur } from './t0.js'
import * as plans from './plans.js'
import { MUSIQUES_DIR } from './montage.js'
import * as planlong from './planlong.js'

const CLIENT_ID = 'creatoros-' + crypto.randomUUID()

/* ---------- photo recipe ----------
   One register (SFW), one recipe per photo diffusion engine:
   Krea 2 by default, FLUX.2 Klein 9B optional (CREATOROS_PHOTO_ENGINE=klein).
   The persona LoRA is NOT in the recipe: the server stacks it at job time
   (see server/persona.js), so a recipe also runs without it.

   A job's `workflowFile` field overrides this table. */
export const RECIPES_PAR_MOTEUR = {
  klein: { sfw: 'PROD_gen_sfw.json' },
  krea: { sfw: 'PROD_gen_krea_sfw.json' },
  // MOSS Image: Apache-2.0, no identity LoRA; needs a recent ComfyUI (moss_image CLIP type)
  moss: { sfw: 'PROD_gen_moss_sfw.json' },
  // FLUX 3 Image Klein (distilled, int8): FLUX Kommunity License, content filter active; no identity LoRA
  flux3: { sfw: 'PROD_gen_flux3_sfw.json' },
}
export const PHOTO_ENGINE = CONFIG.photoEngine
export const RECIPES = RECIPES_PAR_MOTEUR[PHOTO_ENGINE] ?? RECIPES_PAR_MOTEUR.krea

/* ---------- image-to-video ----------
   Engines are picked manually in the console; each has different trade-offs.

   `speed`: factor applied to the GENERATED duration to deliver the requested
   one. No global correction on engines WITH VOICE (MiniMax, LTX): they speak in
   real time, and `atempo` would make speech too fast, so slow motion is handled
   in the prompt. Wan (silent) carries its correction in the recipe itself
   (frames are 1/16 s, played at 24 fps). `speed` stays in the table (and
   `conformVideo` downstream) for silent engines that need it. */
export const VIDEO_ENGINES = {
  wan: {
    maxSeconds: 12,
    /* Above directSeconds, the CONTEXT WINDOW recipe takes over (windows 33/8 on
       both stages): attention is no longer computed over the whole sequence, so
       longer clips fit at 720x1280. In direct mode 8 s is the hard VRAM limit. */
    directSeconds: 8,
    // 12 s in context mode: 289 frames, ~30 min, ~29 GB peak.
    fileCtx: 'PROD_video_wan_ctx.json',
    file: 'PROD_video_wan.json',
    label: 'Wan 2.2 (I2V A14B)',
    force: 'image la plus propre — c’est lui qu’on prend quand le plan doit tenir en grand',
    audio: false,
    speed: 1,
    minutes: 9,
    /* Draft: literal dimensions scaled to 0.4 MP (480x848 in 9:16), to judge
       the prompt, not the shot. Draft runs 2 + 2 steps; the final render stays at
       4 + 4 (2 + 2 can produce glassy eyes). */
    draft: { megapixels: 0.4, steps: 4, minutes: 2 },
  },
  ltx_hq: {
    // At 1.4 MP: 12 s ~6 min (27 GB), 16 s ~9 min (30.9 GB).
    maxSeconds: 16,
    file: 'PROD_video_ltx_hq.json',
    label: 'LTX-2.5 (22B)',
    force: 'avec le son, rapide — 896×1600 en plusieurs passes',
    audio: true,
    /* The recipe has its own "Switch to Text to Video?" toggle, which ignores the
       start image. Used for ambient (T2V) shots. */
    t2v: true,
    speed: 1,
    minutes: 5,
    // Draft: 0.7 MP instead of 1.4; the extra passes remain.
    draft: { megapixels: 0.7, minutes: 2 },
  },
}

/* MiniMax H3: optional engine, weights supplied by the owner of a local install
   (license, see h3.js). Recipe without content LoRA; arrival keyframe supported. */
VIDEO_ENGINES.minimax = {
  // beyond 12 s, native context windows take over (comfy.js fenetresH3Longues)
  maxSeconds: 16,
  file: 'PROD_video_minimax.json',
  label: 'MiniMax H3',
  force: 'le plus fluide, tient l’identité et sait tourner autour du sujet',
  audio: true,
  speed: 1,
  minutes: 12,
  optionnel: 'h3',
  draft: { megapixels: 0.4, minutes: 4 },
}

/* Wan 2.2 T2V-A14B: text to video WITH a character whose identity is held by a
   Wan high/low noise LoRA pair. No image: WanImageToVideo without start_image
   yields an empty latent, and all Wan injection (duration, aspect, draft) still
   applies. Recipe: lightx2v T2V, 4 + 4 euler steps, shift 5. The model animates
   at 16 fps; RIFE x2 interpolation follows at harvest. */
VIDEO_ENGINES.wan_t2v = {
  maxSeconds: 5,
  file: 'PROD_video_wan_t2v.json',
  label: 'Wan 2.2 T2V-A14B',
  force: 'le personnage depuis le texte seul, quand son identité est une LoRA Wan',
  audio: false,
  t2v: true,
  // no "Text to Video" toggle or neutral image: the recipe starts from text
  t2vNatif: true,
  speed: 1,
  minutes: 6,
  draft: { megapixels: 0.3, minutes: 2 },
}

/* Wan 2.1 I2V 14B 480p: the base model of the Apache-2.0 effect and camera LoRAs
   trained on it. Short recipe: lightx2v 4 steps, 480x832, 16 fps, RIFE x2 at
   harvest. Serves the "Camera & effects" gallery, not the engine picker. */
VIDEO_ENGINES.wan21 = {
  maxSeconds: 5,
  file: 'PROD_video_wan21_effets.json',
  label: 'Wan 2.1 I2V 480p (effets)',
  force: 'les effets et mouvements de caméra à LoRA dédiée',
  audio: false,
  speed: 1,
  minutes: 2,
}
/* EFFECTS variant: no lightx2v, 28 uni_pc steps, cfg 6, shift 5. The distilled
   4-step setting does not apply the effect to the subject; 28 steps does.
   ~8 min per 5 s clip. */
VIDEO_ENGINES.wan21_hq = {
  ...VIDEO_ENGINES.wan21,
  file: 'PROD_video_wan21_effets_hq.json',
  label: 'Wan 2.1 I2V 480p (effets, 28 pas)',
  minutes: 8,
}

/* Wan 2.2 Fun Camera: the camera follows a trajectory (WanCameraEmbedding) instead
   of a LoRA. Serves gallery presets that name a pose (`camera`). */
VIDEO_ENGINES.wan_funcam = {
  maxSeconds: 5,
  file: 'PROD_video_funcam.json',
  label: 'Wan 2.2 Fun Camera',
  force: 'mouvements de caméra simples pilotés par trajectoire',
  audio: false,
  speed: 1,
  minutes: 5,
}
export const POSES_CAMERA = ['Static', 'Pan Up', 'Pan Down', 'Pan Left', 'Pan Right', 'Zoom In', 'Zoom Out', 'Anti Clockwise (ACW)', 'ClockWise (CW)']

export const DEFAULT_VIDEO_ENGINE = 'wan'

/* ---------- render time estimate ----------
   Coefficients MEASURED on a 32 GB RTX. Single source, exposed to the front
   end via /api/health for pre-submit estimates; each job carries its estimate
   (`estimatedMs`) computed here at enqueue.
   - photo: ~7 s
   - i2v: render seconds per video second, per engine (see videoSecPerSec)
   - motion (Wan-Animate-2): per driver FRAME; time scales linearly with the
     driver length. */
export const RENDER_RATES = {
  photoMs: 7000,
  // Qwen-edit 2511 pass (20 steps, ~1 MP); provisional value.
  qwenFixMs: 60000,
  /* Approximation: the fixed cost (model and VAE loading) does not depend on clip
     length, while a per-second rate spreads it. `measuredEstimate` takes over
     once there is history. */
  videoSecPerSec: { wan: 150, ltx: 9, ltx_hq: 34, minimax: 105 },
  draftSecPerSec: { minimax: 27, wan: 75, ltx_hq: 17 },
  motionSecPerFrame: { final: 9.0, preview: 4.5 },
}

/** Duration and frame count of a driver as the motion chain will see them.
 *  null if unreadable. */
export function driverMeta(file) {
  try {
    const p = path.join(CONFIG.comfyInput, path.basename(file))
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8' }).trim().split('\n')
    const [n, d] = String(out[0]).split('/').map(Number); const fps = d ? n / d : n
    const seconds = Number(out[1])
    if (!Number.isFinite(seconds)) return null
    // The driver is resampled to 16 fps before transfer (see probeDriver), so the
    // frame count seen by the model, and the cost, follow 16 fps.
    const effFps = 16
    return { seconds, fps, frames: Math.max(1, Math.round(seconds * effFps)) }
  } catch { return null }
}

/* Average of the LAST finished jobs with the same recipe and profile, so the
   estimate reflects the real machine. RENDER_RATES is the FALLBACK (first run,
   empty database). Profile = draft, audio (mixing them would skew the average).
   Video is normalized in ms per GENERATED second, photo in plain ms. Motion
   uses the table: driver frame counts are not in past job payloads. */
const ESTIMATE_SAMPLES = 5
function measuredEstimate(row) {
  if (row.videoEngine === 'motion') return null
  let hist
  try { hist = store.doneDurations(row.workflowFile, 32) } catch { return null }
  const isVideo = row.mode === 'video'
  const samples = []
  for (const h of hist) {
    let p
    try { p = JSON.parse(h.payload) } catch { continue }
    if (!p || !Number.isFinite(h.duration_ms) || h.duration_ms <= 0) continue
    if (Boolean(p.videoDraft) !== Boolean(row.videoDraft)) continue
    if (Boolean(p.withAudio) !== Boolean(row.withAudio)) continue
    if (isVideo) {
      const gen = Number(p.videoSeconds) * (Number(p.videoSpeed) || 1)
      if (!Number.isFinite(gen) || gen <= 0) continue
      samples.push(h.duration_ms / gen)
    } else {
      samples.push(h.duration_ms)
    }
    if (samples.length >= ESTIMATE_SAMPLES) break
  }
  if (!samples.length) return null
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  if (!isVideo) return Math.round(avg)
  const gen = Number(row.videoSeconds) * (Number(row.videoSpeed) || 1)
  return Number.isFinite(gen) && gen > 0 ? Math.round(avg * gen) : null
}

/** Estimate in ms for a job as enqueued: measured if the workflow has history,
 *  fallback table otherwise. */
export function estimateMs(row) {
  const measured = measuredEstimate(row)
  if (measured != null) return measured
  if (row.mode !== 'video')
    return row.op === 'edit' ? RENDER_RATES.qwenFixMs : RENDER_RATES.photoMs
  if (row.videoEngine === 'motion') {
    const m = row.motionDriver ? driverMeta(row.motionDriver) : null
    if (!m) return null
    return Math.round(m.frames * RENDER_RATES.motionSecPerFrame[row.motionPreview ? 'preview' : 'final'] * 1000)
  }
  const rate = row.videoDraft
    ? (RENDER_RATES.draftSecPerSec[row.videoEngine] ?? RENDER_RATES.videoSecPerSec[row.videoEngine] / 3)
    : RENDER_RATES.videoSecPerSec[row.videoEngine]
  return Number.isFinite(rate) && row.videoSeconds ? Math.round(rate * row.videoSeconds * 1000) : null
}

/* ---------- Motion Control ----------
   Wan-Animate-2 animates a reference STILL (supplied by the operator) over the
   whole length of a "driver" video: motion is copied frame by frame, appearance
   comes from the still. No face swap: the source video only lends its motion.

   Motion is copied at the driver's fps (no slow-mo, no retiming). Native
   context windows or chained chunks cover the full length; the Animate-2 cache
   lives in RAM (it does not fit in VRAM alongside the model). */
/* V2V refine (low-denoise video refinement, motion kept): used to upscale a
   draft. The MASKED variant re-diffuses only a mask's area; it backs video
   brush retouching. */
export const REFINE_RECIPE = 'PROD_v2v_refine.json'
export const REFINE_MASKED_RECIPE = 'PROD_v2v_refine_masked.json'
/* Draft upscale: gentle denoise; higher values reinvent the facial expression. */
const UPSCALE_DENOISE = 0.30

/* ---------- photo "Go HD" ----------
   - GENTLE upscale is mandatory (sharp upscalers turn freckles into black dots);
   - Klein refine at 0.20 denoise (above ~0.26 skin spots darken);
   - the FACE is taken back from the source via a detected mask (face_yolov8m),
     the only area where refining degrades;
   - colors are matched to the source (refining darkens). */
export const PHOTO_HD_WORKFLOW = 'PROD_photo_hd.json'
const PHOTO_HD_DENOISE = 0.20
/** Engines whose i2v node accepts keyframes (MiniMaxH3ImageToVideo). */
const H3_KEYFRAMES = ['minimax']
export const MOTION_RECIPES = {
  preview: 'PROD_motion_480.json',   // ~2x faster, to judge the motion
  final: 'PROD_motion_720.json',     // 720x1280, delivery quality
}
/* Mix: WanAnimate 2.2 in replace mode (WanVideoWrapper); SAM2 tracks the
   driver's subject and the still's character takes its place in the original
   scene. Identity is held by the character's Wan video LoRA (high and low
   noise), or by the still alone without it. */
export const MIX_RECIPE = 'PROD_wananimate_mix.json'
const COMFY_PY = path.join(CONFIG.comfyDir, 'venv', 'bin', 'python')
const GDINO_POINTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'gdino_points.py')

/** In-place face-tracking crop (scripts/suivi_visage.py, ComfyUI's Python, CPU). */
function suiviVisage(full) {
  try {
    const out = execFileSync(path.join(CONFIG.comfyDir, 'venv', 'bin', 'python'),
      ['-I', path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'suivi_visage.py'),
        full, path.join(CONFIG.dataDir, 'modeles-controle')], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(out.trim().split('\n').pop())
  } catch (e) { return { ok: false, raison: String(e.message || e).slice(0, 160) } }
}

/* Ids of the controlled nodes in the motion recipes. The recipe is ours (a
   frozen export of the official template), so ids are stable; naming them is
   safer than a heuristic (conditioning goes through WanAnimate2ToVideo, not a
   KSampler, so generic injection does not recognize it). */
const MOTION_NODES = {
  ref: '189',          // LoadImage: the reference still
  driver: '240',       // LoadVideo: the source video
  animate: '261:247',  // WanAnimate2ToVideo: length
  prompt: '261:3',     // CLIPTextEncode: character + scene
  motion: '261:222',   // CLIPTextEncode: motion only
  seed: '261:19',      // SamplerCustom: noise_seed
  save: '246',         // SaveVideo
  context: '261:257',  // ContextWindowsManual: overlap (continuity between windows)
  contextSwitch: '261:258', // ComfySwitchNode: with or without context windows
}

/* Long clips: chained chunks.
   Beyond 81 frames, context windows make the background jump at the end of each
   window. Instead windows are disabled and 81-frame chunks are rendered: each
   continues from the previous chunk's last frames (`continue_motion`) and its
   position in the driver (`video_frame_offset`), the chaining the node is
   designed for. Context windows remain available via `motionJoin: 'fenetres'`. */
const MOTION_CHUNK = 81
const MOTION_CHUNK_NEW = 76   // new frames per subsequent chunk (5 carried over from the previous)
export function chainMotionChunks(g, seed) {
  const A = MOTION_NODES.animate
  const total = g[A].inputs.length
  const sampler = g[MOTION_NODES.seed].inputs
  const vae = g['261:6'].inputs.vae
  g[MOTION_NODES.contextSwitch].inputs.switch = false
  g[A].inputs.length = MOTION_CHUNK
  for (const k of [MOTION_NODES.seed, '261:223', '261:6', '261:298', '261:299']) delete g[k]
  const parts = []
  let prev = null
  for (let i = 0, done = 0; done < total; done += i === 0 ? MOTION_CHUNK : MOTION_CHUNK_NEW, i++) {
    const w = i === 0 ? A : `chunk${i}:animate`
    if (i) {
      g[w] = structuredClone(g[A])
      g[w].inputs.video_frame_offset = [prev.animate, 5]
      g[w].inputs.continue_motion = [prev.decode, 0]
    }
    g[`chunk${i}:sample`] = { class_type: 'SamplerCustom', inputs: { ...sampler,
      noise_seed: seed + i, positive: [w, 0], negative: [w, 1], latent_image: [w, 2] } }
    g[`chunk${i}:trim`] = { class_type: 'TrimVideoLatent', inputs: { trim_amount: [w, 3], samples: [`chunk${i}:sample`, 0] } }
    g[`chunk${i}:decode`] = { class_type: 'VAEDecode', inputs: { samples: [`chunk${i}:trim`, 0], vae } }
    // keep only the new frames: the chunk start repeats the previous one
    g[`chunk${i}:new`] = { class_type: 'ImageFromBatch', inputs: { image: [`chunk${i}:decode`, 0], batch_index: [w, 4], length: 4096 } }
    parts.push(`chunk${i}:new`)
    prev = { animate: w, decode: `chunk${i}:decode` }
  }
  g['289'] = { class_type: 'BatchImagesNode', inputs: Object.fromEntries(parts.map((n, j) => [`images.image${j}`, [n, 0]])) }
  g['chunk:cut'] = { class_type: 'ImageFromBatch', inputs: { image: ['289', 0], batch_index: 0, length: total } }
  g['245'].inputs.images = ['chunk:cut', 0]
  return parts.length
}

/* Offered aspect ratios: exactly those of the ResolutionSelector node; anything
   else would be rejected by ComfyUI at execution time. */
export const VIDEO_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']

/* ---------- speech: the quoted line and nothing else ----------
   Audio engines (MiniMax H3, LTX-2.5) denoise voice together with the image:
   when the prompt describes several seconds of action with a line in the
   middle, the model fills the time before it with invented mumbling. For any
   audio video job whose text has a quoted line, a silence directive is added
   here (after sampling, outside the LLM). Without a quoted line nothing changes. */
const SPEECH_QUOTE_RE = /«\s*([^»]+?)\s*»|"([^"\n]+?)"|“([^”]+?)”/g
export function speechGuard(text) {
  const lines = []
  for (const m of String(text).matchAll(SPEECH_QUOTE_RE)) lines.push((m[1] ?? m[2] ?? m[3]).trim())
  if (!lines.length) return null
  /* The line is NOT repeated here: quoting it again would make it spoken twice.
     Only the surrounding silence is described. */
  const guard = lines.length === 1
    ? 'The character speaks exactly once: the quoted line, and nothing else. Before and after it the character is silent — no other words, no mumbling, no humming, no off-screen voice.'
    : `The character speaks only the ${lines.length} quoted lines, in that order, and nothing else. Otherwise the character is silent — no other words, no mumbling, no humming, no off-screen voice.`
  const base = String(text).trim().replace(/[.\s]+$/, '')
  return { text: `${base}. ${guard}`, note: `parole verrouillée sur ${lines.length === 1 ? 'la réplique' : `${lines.length} répliques`} : ${lines.map(l => `"${l}"`).join(' · ')}` }
}

/** Delivered duration in seconds, capped per ENGINE: the upper limit is VRAM,
 *  not preference (see each table entry). Below 2 s there is nothing to see. */
const clampDuration = (v, engine) => {
  const n = Number(v)
  const cap = engine?.maxSeconds ?? 12
  if (!Number.isFinite(n)) return 5
  if (Math.round(n) > cap)
    throw new Error(`durée ${Math.round(n)} s hors capacité de ce moteur `
      + `(maximum ${cap} s en VRAM à sa résolution) — réduire la durée ou changer de moteur`)
  return Math.max(2, Math.round(n))
}

/** Frame rate of the delivered FILE. Does not change generation: engines animate
 *  at their native rate, and a higher value duplicates frames on export. */
const clampFps = v => ([24, 30].includes(Number(v)) ? Number(v) : 24)


/* Retired recipes: kept in the table so an archived job naming them in its
   provenance is flagged rather than silently replayed. */
export const DEPRECATED_RECIPES = {}

/* Instruction-based retouch (photo task `edit`), Qwen-Image-Edit 2511:
   source image (upload or gallery still) + free instruction composed by the
   LLM. Injection writes the source into the single LoadImage and the
   instruction into the TextEncodeQwenImageEdit encoder. */
export const EDIT_WORKFLOW = 'PROD_edit.json'
/** Retouch styles: one Qwen-Image-Edit LoRA each. The job names only the id,
 *  never a file: retouch accepts no other LoRA. */
export const STYLES_EDITION = {
  action: 'qwen-styles/QWEN_EDIT_ACTION_V1.safetensors',
  'noir-comic': 'qwen-styles/Noir-Comic-Book-Panel_20.safetensors',
  'anime-2000': 'qwen-styles/Qwen-Image-Edit-2511-Anime-2000.safetensors',
  manga: 'qwen-styles/tone001.safetensors',
}

/** Recipes actually SERVED by this instance (current photo engine, video engines,
 *  side chains): what diagnostics must check. */
export function recettesServies() {
  const video = Object.values(VIDEO_ENGINES).flatMap(e => [e.file, e.fileCtx]).filter(Boolean)
  return [...new Set([...Object.values(RECIPES), ...video, ...Object.values(MOTION_RECIPES),
    REFINE_RECIPE, REFINE_MASKED_RECIPE, PHOTO_HD_WORKFLOW, EDIT_WORKFLOW, MIX_RECIPE, SWAP_SCAIL_RECIPE])]
}

/* Default dimensions, overridable per job. Close-up framing uses a less
   elongated format so the face is not framed too wide or the chin cut off. */
export const DEFAULT_SIZE = { width: 768, height: 1344 } // 9:16 by default
export const CLOSEUP_SIZE = { width: 896, height: 1152 }

const queue = []
let running = false
/* The running job and its ComfyUI prompt, used to INTERRUPT it.
   The queue itself is emptied by removal. */
let current = null   // { jobId, promptId }

/** Cancels a job: removed from the queue if waiting, interrupted if running.
 *  Returns what was done, or null if the job is unknown here (already finished). */
/** Moves a waiting job to the head of the queue. Does not touch the running job;
 *  `enqueue`'s recipe ordering no longer applies afterwards. */
export function promoteJob(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i < 0) return null
  const [j] = queue.splice(i, 1)
  queue.unshift(j)
  return { id, position: 0, queued: queue.length }
}

/** Reorders the waiting queue according to `ids` (waiting jobs only).
 *  Jobs not listed stay behind, in their current order. */
export function reorderQueue(ids) {
  const byId = new Map(queue.map(j => [j.id, j]))
  const picked = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean)
  const rest = queue.filter(j => !picked.includes(j))
  queue.length = 0
  queue.push(...picked, ...rest)
  return { order: queue.map(j => j.id) }
}

/* Jobs cancelled while running: the interruption surfaces as a ComfyUI error,
   which must not be treated as a real failure (log, alert). */
const annulesEnCours = new Set()

export async function cancelJob(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i >= 0) {
    queue.splice(i, 1)
    store.markFailed(id, 0, 'annulé par l’utilisateur (jamais lancé)')
    return { id, cancelled: 'queued' }
  }
  if (current?.jobId === id) {
    // Remove the prompt if still pending in ComfyUI, and interrupt it if running.
    // Each is a no-op when it does not apply, so both are sent.
    annulesEnCours.add(id)
    if (arreterEntrainement(id)) return { id, cancelled: 'running' }
    await comfy.deleteQueued(current.promptId).catch(() => {})
    await comfy.interrupt(current.promptId).catch(() => {})
    // runJob will see the interrupted execution and record it as a cancellation.
    return { id, cancelled: 'running' }
  }
  return null
}

function ratio(w, h) {
  if (!w || !h) return null
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const g = gcd(w, h)
  return `${w / g}:${h / g}`
}

/** Rebuilds the queue after a restart. Jobs still "queued" in the database
 *  restart as is (full payload); those that died mid-render are re-attached to
 *  their prompt if it still exists, resubmitted otherwise. */
export async function recoverQueue() {
  const orphans = store.orphanedRunningRows()
  const rows = store.queuedPayloads()
  if (!orphans.length && !rows.length) return 0

  /* Nothing is decided until ComfyUI answers: a "fetch failed" here is a server
     not yet listening, not a job failure. */
  const waited = await comfy.waitReady()
  if (waited > 1500) console.log(`[reprise] ComfyUI joignable après ${(waited / 1000).toFixed(1)} s`)

  /* RE-ATTACH: a job in flight when CreatorOS restarts is not dead; its prompt
     lives in ComfyUI. Find its prompt_id, wait for completion and harvest via
     the normal path.

     If ComfyUI itself restarted, its in-memory queue is gone: the prompt is
     unknown and the render is lost, so resubmit from the payload. */
  for (const row of orphans) {
    const job = row.payload
    if (!job) {
      store.markFailed(row.id, 0, 'interrompu par un redémarrage du service — relancer')
      console.warn(`[reprise] job ${row.id} sans payload, marqué en échec`)
      continue
    }
    // editing export: ffmpeg ran in the old process, nothing to re-attach
    if (job.op === 'montage') {
      store.markFailed(row.id, 0, 'export interrompu par un redémarrage du service — relancer l’export')
      continue
    }
    let known = null
    if (row.comfy_prompt_id) {
      try { known = await comfy.promptKnown(row.comfy_prompt_id) } catch { known = null }
    }
    if (!known) {
      store.requeue(row.id)
      rows.unshift(job)
      console.log(`[reprise] job ${row.id} — prompt ${row.comfy_prompt_id || 'absent'} perdu (ComfyUI redémarré), remis en tête de file`)
      continue
    }
    console.log(`[reprise] job ${row.id} ré-attaché au prompt ${row.comfy_prompt_id} (${known})`)
    void (async () => {
      try {
        const history = await comfy.waitForPrompt(row.comfy_prompt_id, {
          onPhase: ph => store.setStatus(row.id, ph === 'queued' ? 'queued-comfy' : ph),
        })
        const n = await harvestJob(job, row.comfy_prompt_id, history)
        // Actual duration since the start time stored in the database (shown on the
        // library asset).
        store.markFinished(row.id, row.started_at ? Date.now() - row.started_at : 0)
        console.log(`[reprise] job ${row.id} récolté — ${n} image(s)`)
      } catch (e) {
        store.markFailed(row.id, 0, `reprise échouée : ${String(e.message || e).slice(0, 300)}`)
        console.error(`[reprise] job ${row.id} — ${e.message || e}`)
      }
      if (job.motionPlan) await assemblerPlans(job).catch(e => console.warn(`[plans] montage non produit — ${String(e.message || e).slice(0, 300)}`))
    })()
  }
  for (const row of rows) queue.push(row)
  if (rows.length) {
    console.log(`[reprise] ${rows.length} job(s) remis en file depuis la base`)
    pump()
  }
  return rows.length
}

/** Records the job and queues it. Returns immediately; the front end tracks
 *  progress via /api/jobs/:id. */
/** Source of a restoration, for before/after: studio paths only. */
const origineValide = u => (typeof u === 'string' && /^\/(api\/uploads|media)\/[\w.%-]+$/.test(u) ? u : undefined)
export function enqueue(job) {
  // references: FLUX.2 Klein by default; FLUX 3 Image Klein when it is the engine asked for (not for a face held by the first reference)
  if (job.mode === 'photo' && Array.isArray(job.references) && job.references.length) job = { ...job, photoEngine: job.photoEngine === 'flux3' && job.refVisage !== true ? 'flux3' : 'klein', workflowFile: undefined }
  /* Submission idempotency: if the client's key ALREADY produced a job, return
     that one instead of creating a second. The mobile client generates the key
     before its first POST and reuses it on every transport retry. Uniqueness is
     enforced by the database's unique index; this check only avoids an SQL error
     in the normal case. */
  const requestId = typeof job.requestId === 'string' && job.requestId.trim()
    ? job.requestId.trim().slice(0, 100) : null
  if (requestId) {
    const seen = store.jobsByRequestId(requestId)
    if (seen.length) return { id: seen[0].id, duplicate: true, queued: queue.length }
  }
  const id = String(job.id ?? Date.now())
  const seed = job.seed?.mode === 'lock' && Number.isFinite(job.seed?.value)
    ? Number(job.seed.value)
    : Math.floor(Math.random() * 0xffffffffffff)
  /* Features not in the public edition (face or head swap, character
     replacement in a video, old chained passes) are refused explicitly, never
     silently rerouted. */
  if (job.op === 'swap' || job.videoSwap)
    throw new Error('l’échange de visage ou de sujet n’existe pas dans cette édition')
  if (job.anatomyFix || job.bfsAfter)
    throw new Error('la passe de correction chaînée n’existe plus : utiliser la retouche (op « edit ») ou le pinceau')
  if (job.register && job.register !== 'sfw')
    throw new Error(`registre « ${job.register} » inconnu : seul le registre « sfw » existe`)
  // `op` distinguishes GENERATION from EDIT; the output is a photo in both cases,
  // so `mode` cannot carry the distinction.
  const op = job.op === 'edit' ? 'edit' : 'generate'
  const mode = job.mode ?? 'photo'
  /* The video engine is the operator's CHOICE. An unknown name is refused rather
     than silently replaced by another engine. */
  // Motion Control: dedicated chain, not another i2v engine. `motionDriver` is
  // the FILE NAME of the video uploaded via /api/upload.
  const isMotion = mode === 'video'
    && typeof job.motionDriver === 'string' && job.motionDriver.trim()
  const engineKey = (mode === 'video' && !isMotion)
    ? (job.videoEngine ?? DEFAULT_VIDEO_ENGINE)
    : null
  if (mode === 'video' && !isMotion && !VIDEO_ENGINES[engineKey])
    throw new Error(`moteur vidéo « ${engineKey} » inconnu : `
      + Object.keys(VIDEO_ENGINES).join(', '))
  const engine = engineKey ? VIDEO_ENGINES[engineKey] : null
  if (engine?.optionnel === 'h3' && !h3Disponible) throw new Error(demoPublique() ? H3_MESSAGE_DEMO : 'MiniMax H3 n’est pas installé sur ce studio : Paramètres > Modèles optionnels')
  // Wan has no audio stage: requesting audio on it is ignored (the UI disables
  // the checkbox, but the API is open).
  const withAudio = mode === 'video' && !isMotion ? Boolean(job.withAudio) && engine.audio : null
  const workflowFile = job.workflowFile
    || (isMotion ? (job.motionPreview ? MOTION_RECIPES.preview : MOTION_RECIPES.final)
      : mode === 'video'
        ? (engine.fileCtx && clampDuration(job.videoSeconds, engine) > (engine.directSeconds ?? Infinity)
          ? engine.fileCtx : engine.file)
      : op === 'edit' ? EDIT_WORKFLOW : (RECIPES_PAR_MOTEUR[job.photoEngine]?.sfw ?? RECIPES.sfw))
    || CONFIG.defaultWorkflow
  const positive = (job.composedPositive || job.userPrompt || '').trim()
  const sourceImage = typeof job.sourceImage === 'string' ? job.sourceImage.trim() : ''

  if (op === 'edit') {
    // Instruction-based retouch: BOTH a source image and an instruction are
    // required. Only a bare file name is accepted (a path could escape ComfyUI's
    // input folder).
    if (!sourceImage)
      throw new Error('retouche sans image source : rien à éditer '
        + '(sourceImage = nom de fichier dans le dossier input de ComfyUI)')
    if (sourceImage.includes('/') || sourceImage.includes('\\') || sourceImage.startsWith('.'))
      throw new Error(`image source « ${sourceImage} » invalide : nom de fichier nu attendu`)
    if (!positive)
      throw new Error('retouche sans instruction : décrire la modification '
        + '(« la robe devient rouge »)')
  } else if (isMotion) {
    // The driver is required for Motion Control.
    const d = job.motionDriver.trim()
    if (d.includes('/') || d.includes('\\') || d.startsWith('.'))
      throw new Error(`vidéo driver « ${d} » invalide : nom de fichier nu attendu`)
    // The still is the appearance reference: both files are required.
    // Mix: without a still, the server builds the character reference (see refDuPersonnage).
    const r = String(job.motionRef ?? '').trim()
    if (!r && job.motionMode !== 'replace') throw new Error('still de référence manquante : le motion control '
      + 'anime UNE IMAGE — déposer la still en plus de la vidéo source')
    if (r.includes('/') || r.includes('\\') || r.startsWith('.'))
      throw new Error(`still « ${r} » invalide : nom de fichier nu attendu`)
  } else if (mode === 'video' && job.t2v === true) {
    /* Ambient shot (T2V): no start image, no character. Only an engine whose
       recipe can start from text accepts it; otherwise refused. */
    if (!engine.t2v)
      throw new Error(`plan d'ambiance (texte → vidéo) indisponible sur « ${engineKey} » : `
        + Object.entries(VIDEO_ENGINES).filter(([, e]) => e.t2v).map(([k]) => k).join(', '))
    if (!positive) throw new Error('plan d’ambiance sans description : décrire le lieu et le mouvement de caméra')
  } else if (mode === 'video') {
    /* An i2v recipe starts from an image. Exception: MiniMax H3 can END on an end
       frame without a start frame (first_frame and last_frame are two optional
       keyframes of the same node). */
    // Wan too (prequel): WanFirstLastFrameToVideo, see comfy.js
    const finOk = H3_KEYFRAMES.includes(engineKey) || engineKey === 'wan'
    const finSeule = finOk && typeof job.endImage === 'string' && job.endImage.trim()
    if (!sourceImage && !finSeule)
      throw new Error('vidéo sans image de départ : choisir une still dans la bibliothèque'
        + (finOk ? ' (ou une frame de fin seule)' : ''))
    if (sourceImage && sourceImage.includes('/') || sourceImage.includes('\\') || sourceImage.startsWith('.'))
      throw new Error(`image de départ « ${sourceImage} » invalide : nom de fichier nu attendu`)
    if (!positive) throw new Error('brief de mouvement vide : rien à animer')
    // Video extension concat: ALSO deliver source + continuation as one file.
    // `concatWith` = bare name; `concatFrom` says where the source lives.
    if (typeof job.concatWith === 'string' && job.concatWith.trim()) {
      const c = job.concatWith.trim()
      if (c.includes('/') || c.includes('\\') || c.startsWith('.'))
        throw new Error(`vidéo à concaténer « ${c} » invalide : nom de fichier nu attendu`)
    }
    // Optional end image: same bare-name rule as the start still.
    if (typeof job.endImage === 'string' && job.endImage.trim()) {
      const e = job.endImage.trim()
      if (e.includes('/') || e.includes('\\') || e.startsWith('.'))
        throw new Error(`image de fin « ${e} » invalide : nom de fichier nu attendu`)
    }
  } else if (!positive) {
    throw new Error('prompt vide : rien à générer')
  }

  // Only photo and video recipes exist; any other mode is refused.
  if (mode !== 'photo' && mode !== 'video')
    throw new Error(`mode « ${mode} » non câblé : seules les recettes photo et vidéo existent`)

  const row = {
    id, createdAt: job.createdAt ?? Date.now(), status: 'queued',
    personaId: personaDuDepot(job.personaId), register: 'sfw',
    mode: job.mode ?? 'photo', purpose: job.purpose ?? 'creative',
    recipeId: job.recipeId ?? null, workflowFile, seed, op, sourceImage: (job.t2v === true && mode === 'video') ? null : sourceImage || null,
    videoEngine: isMotion ? 'motion' : engineKey, withAudio,
    t2v: mode === 'video' && !isMotion && job.t2v === true ? true : undefined,
    t2vPersonnage: mode === 'video' && !isMotion && job.t2v === true && job.t2vPersonnage === true ? true : undefined,
    origineUri: origineValide(job.origineUri),
    // Arrival keyframe (file name in input/). Only some engines support it; the
    // others report it as "not injected".
    endImage: (mode === 'video' && !isMotion && typeof job.endImage === 'string' && job.endImage.trim())
      ? job.endImage.trim() : null,
    // Timed keyframes (Movie Studio timeline): LTX places each at its time, see comfy.js
    keyframes: (mode === 'video' && !isMotion && Array.isArray(job.keyframes))
      ? job.keyframes.filter(k => k && typeof k.image === 'string' && /^[\w.-]+$/.test(k.image.trim()) && Number.isFinite(Number(k.t)))
          .slice(0, 8).map(k => ({ image: k.image.trim(), t: Math.max(0, Math.min(20, Number(k.t))) }))
      : null,
    // Continuation: video of the previous shot's last frames (bare name in input/), see comfy.js
    contexteVideo: (mode === 'video' && !isMotion && typeof job.contexteVideo === 'string' && /^[\w.-]+$/.test(job.contexteVideo.trim()))
      ? job.contexteVideo.trim() : null,
    concatWith: (mode === 'video' && !isMotion && typeof job.concatWith === 'string' && job.concatWith.trim())
      ? job.concatWith.trim() : null,
    concatFrom: job.concatFrom === 'input' ? 'input' : 'media',
    // Prequel: the render ENDS on the source's first frame (endImage) and is placed before it
    prequel: mode === 'video' && !isMotion && job.prequel === true,
    // requested photo recipe (Krea 2 / FLUX.2 Klein): also decides which identity LoRAs are stacked
    photoEngine: mode === 'photo' && op !== 'edit' && Array.isArray(job.references) && job.references.length ? (job.photoEngine === 'flux3' && job.refVisage !== true ? 'flux3' : 'klein')
      : mode === 'photo' && op !== 'edit' && RECIPES_PAR_MOTEUR[job.photoEngine] ? job.photoEngine : undefined,
    // up to 6 reference images (FLUX.2 Klein or FLUX 3 Image Klein), bare names from the input folder
    references: mode === 'photo' && op !== 'edit' && Array.isArray(job.references) ? job.references.filter(n => typeof n === 'string' && n && !/[\\/]/.test(n) && !n.startsWith('.')).slice(0, 6) : undefined,
    // without a character, the person in the first reference is the subject (carousel from a photo)
    refVisage: mode === 'photo' && op !== 'edit' && job.refVisage === true && Array.isArray(job.references) && job.references.length > 0,
    // Multi-person Mix: person rank (left to right), number of people, remaining characters
    mixRang: isMotion && Number.isInteger(job.mixRang) ? job.mixRang : undefined,
    mixTotal: isMotion && Number.isInteger(job.mixTotal) ? job.mixTotal : undefined,
    mixSuite: isMotion && Array.isArray(job.mixSuite) ? job.mixSuite.map(String).slice(0, 2) : undefined,
    // originating camera or effect preset: clip checking reads the expected motion from it
    presetId: typeof job.presetId === 'string' ? job.presetId.slice(0, 40) : undefined,
    cameraPose: POSES_CAMERA.includes(job.cameraPose) ? job.cameraPose : undefined,
    // low VRAM: profile forced for THIS job (the server only allows it for the owner)
    profilVram: PROFILS.includes(Number(job.profilVram)) ? Number(job.profilVram) : undefined,
    motionDriver: isMotion ? job.motionDriver.trim() : null,
    motionPreview: isMotion ? Boolean(job.motionPreview) : null,
    // Move (animate): the supplied still replays the driver's motion.
    // Mix (replace): the still's character replaces the driver's, in its scene.
    motionMode: isMotion ? (job.motionMode === 'replace' ? 'replace' : 'animate') : null,
    motionRef: isMotion ? String(job.motionRef ?? '').trim() || null : null,
    // Raw motion control parameters: clamped here, since the API is open.
    motionSceneText: isMotion && typeof job.motionSceneText === 'string'
      ? job.motionSceneText.trim() || null : null,
    motionSansTurbo: isMotion && job.motionSansTurbo === true ? true : undefined,
    motionTurbo: isMotion && Number.isFinite(job.motionTurbo) ? Math.min(1, Math.max(0, job.motionTurbo)) : undefined,
    motionPas: isMotion && Number.isInteger(job.motionPas) ? Math.min(30, Math.max(4, job.motionPas)) : undefined,
    motionCfg: isMotion && Number.isFinite(job.motionCfg) ? Math.min(6, Math.max(1, job.motionCfg)) : undefined,
    motionVisionRef: isMotion && job.motionVisionRef === true ? true : undefined,
    swapAnimation: isMotion && job.swapAnimation === true ? true : undefined,
    swapLong: isMotion && Number.isInteger(job.swapLong) ? job.swapLong : undefined,
    swapBlocs: isMotion && Number.isInteger(job.swapBlocs) ? job.swapBlocs : undefined,
    // owner test options: force Wan Animate, take the pose from another video (e.g. a 3D mannequin), keep the driver's fps
    mixWanAnimate: isMotion && job.mixWanAnimate === true ? true : undefined,
    motionPoseDriver: isMotion && typeof job.motionPoseDriver === 'string' && /^[\w.-]+$/.test(job.motionPoseDriver) ? job.motionPoseDriver : undefined,
    motionFpsNatif: isMotion && job.motionFpsNatif === true ? true : undefined,
    motionDistill: isMotion && typeof job.motionDistill === 'boolean' ? job.motionDistill : undefined,
    motionPoseFin: isMotion && Number.isFinite(job.motionPoseFin) ? Math.min(1, Math.max(0.3, job.motionPoseFin)) : undefined,
    danseSuivi: isMotion && job.danseSuivi === true ? true : undefined,
    motionPoseStrength: isMotion
      ? Math.min(1.5, Math.max(0.5, Number(job.motionPoseStrength ?? 1))) : null,
    motionRefStrength: isMotion
      ? Math.min(1, Math.max(0.5, Number(job.motionRefStrength ?? 1))) : null,
    // Clips > 81 frames: 'morceaux' (chunks, default) or 'fenetres' (context windows).
    motionJoin: isMotion ? (job.motionJoin === 'fenetres' ? 'fenetres' : 'morceaux') : null,
    /* Shot of an edited source (see enqueueParPlans): group, rank, exact shot
       duration in the source. Used to reassemble when the last shot is delivered. */
    motionPlan: isMotion && job.motionPlan?.group
      ? { group: String(job.motionPlan.group), index: Number(job.motionPlan.index), count: Number(job.motionPlan.count),
        seconds: Number(job.motionPlan.seconds), source: String(job.motionPlan.source ?? '') }
      : null,
    /* REQUESTED duration (that of the delivered file) and duration to GENERATE:
       they differ on engines that animate in slow motion. */
    // In motion mode, duration/aspect/fps come from the DRIVER.
    videoSeconds: mode === 'video' && !isMotion ? clampDuration(job.videoSeconds, engine) : null,
    videoFps: mode === 'video' && !isMotion ? clampFps(job.videoFps) : null,
    // "origine": EXACT ratio of the still. Front-end dims are only a fallback:
    // the actual file is probed at dispatch.
    videoAspect: mode === 'video' && !isMotion
      ? (job.videoAspect === 'origine'
          && (typeof job.sourceImage === 'string' && job.sourceImage
            || typeof job.endImage === 'string' && job.endImage
            || (Number(job.videoSrcW) > 0 && Number(job.videoSrcH) > 0))
        ? 'origine'
        : VIDEO_ASPECTS.includes(job.videoAspect) ? job.videoAspect : null)
      : null,
    videoSrcW: mode === 'video' && !isMotion ? (Number(job.videoSrcW) || null) : null,
    videoSrcH: mode === 'video' && !isMotion ? (Number(job.videoSrcH) || null) : null,
    videoSpeed: engine?.speed ?? 1,
    // Draft: refused rather than ignored on an engine that does not support it.
    videoDraft: mode === 'video' && !isMotion && Boolean(job.videoDraft)
      ? (engine.draft ? true
        : (() => { throw new Error(`mode brouillon indisponible sur « ${engineKey} » : `
          + Object.entries(VIDEO_ENGINES).filter(([, e]) => e.draft).map(([k]) => k).join(', ')) })())
      : null,
    // ControlNet (Generate task): reference image uploaded to input/,
    // modality = preprocessor, strength = the node's `strength`.
    controlNet: (typeof job.controlNet?.file === 'string'
      && job.controlNet.file.trim()
      && !/[\\/]/.test(job.controlNet.file))
      ? {
        file: job.controlNet.file.trim(),
        type: ['depth', 'openpose', 'canny'].includes(job.controlNet.type)
          ? job.controlNet.type : 'depth',
        strength: Math.min(1.5, Math.max(0, Number(job.controlNet.strength ?? 0.7))),
      }
      : null,
    userPrompt: job.userPrompt ?? null, userDirectives: job.userDirectives ?? null,
    /* Original brief overwritten on screen by the Enhancer's "Replace";
       stored only if it differs from the submitted prompt. */
    initialBrief: (typeof job.initialBrief === 'string' && job.initialBrief.trim()
      && job.initialBrief.trim() !== String(positive ?? '').trim())
      ? job.initialBrief.trim() : null,
    /* VLM description of the still, as given to the rewriter. Lets a reader tell
       whether a composed prompt's discrepancy comes from a misread image or a
       poorly followed directive. */
    promptVision: (typeof job.promptVision === 'string' && job.promptVision.trim())
      ? job.promptVision.trim() : null,
    composedPositive: positive, composedNegative: job.composedNegative ?? null,
    selections: job.selections ?? null,
    // Extra (style) LoRAs, stacked after the persona's. Normalized here so strings
    // and objects are both accepted; the contract is { name, strength }.
    editStyle: op === 'edit' && Object.hasOwn(STYLES_EDITION, job.editStyle) ? job.editStyle : undefined,
    loras: (Array.isArray(job.loras) ? job.loras : [])
      .map(l => (typeof l === 'string' ? { name: l, strength: 1 } : l))
      .filter(l => l && typeof l.name === 'string' && l.name)
      .map(l => ({
        name: l.name,
        strength: Number.isFinite(Number(l.strength)) ? Number(l.strength) : 1,
        // Keep the trigger override: the only option for LoRAs whose file has no
        // usable metadata.
        ...(typeof l.trigger === 'string' && l.trigger.trim() ? { trigger: l.trigger.trim() } : {}),
      })),
    // Video LoRAs (turbo, style...): same shape as `loras`,
    // stacked on the video recipe's model chain (not motion).
    videoLoras: (Array.isArray(job.videoLoras) ? job.videoLoras : [])
      .map(l => (typeof l === 'string' ? { name: l, strength: 1 } : l))
      .filter(l => l && typeof l.name === 'string' && l.name)
      .map(l => ({
        name: l.name,
        strength: Number.isFinite(Number(l.strength)) ? Number(l.strength) : 1,
        // Most H3 LoRAs work by presence alone, but some carry a word
        // (realism -> r34l1sm): keep it so it can be prefixed.
        ...(typeof l.trigger === 'string' && l.trigger.trim() ? { trigger: l.trigger.trim() } : {}),
      })),
    // Dimensions: explicit, else from framing, else default.
    // Not persisted as columns; the actual value is in workflowJson.
    width: Number(job.width) || (job.framing === 'closeup' ? CLOSEUP_SIZE.width : DEFAULT_SIZE.width),
    height: Number(job.height) || (job.framing === 'closeup' ? CLOSEUP_SIZE.height : DEFAULT_SIZE.height),
    /* Batch: id shared by the jobs of one submission; groups renders into one
       mosaic thumbnail. Must be kept here (the row IS the persisted payload). */
    batchId: typeof job.batchId === 'string' && job.batchId ? job.batchId : null,
    carouselLocks: (job.carouselLocks && typeof job.carouselLocks === 'object') ? job.carouselLocks : null,
    /* Operator prompt at the origin of the lineage: a carousel launched from a
       carousel plan restarts from it, not from the VLM paraphrase (see server/carrousel.js). */
    promptRacine: typeof job.promptRacine === 'string' && job.promptRacine.trim() ? job.promptRacine.trim() : null,
    // retake launched by automatic checking (server/controle.js): never retried itself
    priseDe: typeof job.priseDe === 'string' && job.priseDe ? job.priseDe : null,
  }
  // Duration estimate, carried by the job (payload); used by the UI's
  // "elapsed / estimated" bar.
  row.estimatedMs = estimateMs(row)
  row.requestId = requestId
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  /* Groups jobs with the SAME recipe: two heavy models do not fit in VRAM
     together, and each switch forces a full reload (alternating reloads can
     OOM). The sort is STABLE (arrival order kept for equal recipes) and the head
     job is never moved (it may already have started). */
  if (queue.length > 2) {
    const head = queue.shift()
    queue.sort((a, b) => a.workflowFile === b.workflowFile ? 0
      : a.workflowFile < b.workflowFile ? -1 : 1)
    queue.unshift(head)
  }
  pump()
  return { id, seed, workflowFile, queued: queue.length }
}

/* ---------- motion by shots (see server/plans.js) ----------
   An EDITED motion video is split into one job per shot: each shot is animated
   separately on the same reference still, so a cut never falls in the middle
   of a context window. Jobs share a batch (one gallery thumbnail) and a seed;
   the first keeps the submission id the UI already tracks.
   `motionPlans: false` on the job renders it in one block. */
export async function enqueueParPlans(job) {
  /* Mix: chosen start point in the source video. Mix keeps only 9.6 s: the source
     is trimmed at this start before upload; the rest of the path is unchanged. */
  const debut = Number(job?.mixDebut)
  if (job?.motionMode === 'replace' && typeof job.motionDriver === 'string' && Number.isFinite(debut) && debut > 0) {
    const nom = `crs_debut${Math.round(debut * 10)}_${path.basename(job.motionDriver)}`
    await new Promise((ok, ko) => execFile('ffmpeg', ['-y', '-v', 'error', '-ss', String(debut), '-i', path.join(CONFIG.comfyInput, path.basename(job.motionDriver)),
      '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-c:a', 'aac', path.join(CONFIG.comfyInput, nom)], e => e ? ko(e) : ok()))
    store.noterInput(nom, store.origineInput(path.basename(job.motionDriver)) ?? 'inconnu')
    job = { ...job, motionDriver: nom }
  }
  const driver = typeof job?.motionDriver === 'string' ? job.motionDriver.trim() : ''
  const concerne = (job?.mode ?? 'photo') === 'video' && driver
    && !job.motionPlan && job.motionPlans !== false
  if (!concerne) return enqueue(job)
  const rid = typeof job.requestId === 'string' && job.requestId.trim() ? job.requestId.trim().slice(0, 90) : null
  if (rid && store.jobsByRequestId(rid).length) return enqueue(job)      // retry of an already-seen submission
  let liste = null
  try { liste = await plans.decouper(driver) } catch (e) {
    console.warn(`[plans] découpage impossible, rendu d'un bloc — ${String(e.message || e).slice(0, 200)}`)
  }
  if (!liste) return enqueue(job)
  const group = crypto.randomUUID(), id0 = String(job.id ?? Date.now())
  const seed = job.seed?.mode === 'lock' && Number.isFinite(job.seed?.value)
    ? Number(job.seed.value) : Math.floor(Math.random() * 0xffffffffffff)
  const faits = liste.map((p, i) => enqueue({
    ...job, id: i ? `${id0}-p${i + 1}` : id0, requestId: rid ? (i ? `${rid}-p${i + 1}` : rid) : undefined,
    seed: { mode: 'lock', value: seed }, motionDriver: p.fichier, batchId: job.batchId || group,
    motionPlan: { group, index: i + 1, count: liste.length, seconds: p.seconds, source: driver },
  }))
  console.log(`[plans] « ${driver} » : ${liste.length} plans, jobs ${faits.map(r => r.id).join(', ')}`)
  return { ...faits[0], ids: faits.map(r => r.id), plans: liste.length }
}

/** Last shot of a finished group: delivered shots are joined into one file,
 *  delivered as an asset of the job closing the group. A failed shot is
 *  missing from the result, and provenance says so. */
async function assemblerPlans(job) {
  const g = job.motionPlan?.group
  if (!g) return
  const freres = store.jobsByPlanGroup(g)
  if (freres.some(f => !['done', 'blocked'].includes(f.status))) return     // other shots still pending
  const livres = freres
    .map(f => ({ ...f, plan: (() => { try { return JSON.parse(f.payload).motionPlan } catch { return null } })() }))
    .filter(f => f.plan && f.status === 'done')
    .map(f => ({ id: f.id, index: f.plan.index, seconds: f.plan.seconds,
      fichier: store.jobAssetFiles(f.id).map(n => path.join(CONFIG.mediaDir, n)).find(n => n.endsWith('.mp4') && !n.includes('-montage-') && fs.existsSync(n)) }))
    .filter(f => f.fichier)
    // a retried shot replaces its first attempt: keep the latest render per rank
    .reduce((m, f) => m.set(f.index, f), new Map()).values().toArray().sort((a, b) => a.index - b.index)
  if (livres.length < 2) return
  const rangs = new Set(freres.map(f => { try { return JSON.parse(f.payload).motionPlan?.index } catch { return null } }))
  const nom = `${job.id}-montage-${crypto.randomBytes(4).toString('hex')}.mp4`, complet = path.join(CONFIG.mediaDir, nom)
  await plans.recoller(livres, complet)
  void ensurePoster(nom).catch(() => {})
  const d = videoSize(complet), manquants = rangs.size - livres.length
  store.createAsset(
    { id: `a-${job.id}-montage`, jobId: job.id, createdAt: Date.now(), mediaType: 'video',
      uri: `/media/${nom}`, filename: nom, bytes: fs.statSync(complet).size,
      width: d.width, height: d.height, aspect: ratio(d.width ?? 9, d.height ?? 16),
      register: 'sfw', op: job.op ?? 'generate', videoEngine: job.videoEngine ?? null },
    { recipeId: job.recipeId, workflowFile: job.workflowFile, comfyPromptId: null,
      seed: job.seed, composedPositive: job.composedPositive, composedNegative: job.composedNegative,
      userPrompt: job.userPrompt, userDirectives: job.userDirectives, selections: job.selections, resolvedText: null,
      identityPreamble: null, registerClause: null, sourceImage: job.sourceImage ?? null, extraLoras: null,
      injections: {
        applied: [`montage par plans : ${livres.length} plans recollés à leur durée d'origine (source « ${job.motionPlan.source} »)`],
        skipped: manquants ? [`${manquants} plan(s) absent(s) du montage (échec) — rangs présents : ${livres.map(f => f.index).join(', ')} sur ${rangs.size}`] : [],
      },
      workflowJson: null })
  /* Assembled shots are marked "rejected": they stay in the gallery, greyed,
     behind the assembly. Shots already approved manually are untouched. */
  for (const f of livres)
    for (const a of store.assetsOfJob(f.id))
      if (!String(a.id).endsWith('-montage') && (a.review_status ?? 'pending') === 'pending') store.setReview(a.id, 'rejected')
  console.log(`[plans] montage livré : ${nom} (${livres.length} plans sur ${rangs.size})`)
}

/* ---------- video draft upscale ----------
   An approved draft render goes through V2V refine (motion kept, details
   refined) at the target resolution. Standard queue: one GPU. */
/** "Go HD" for a PHOTO: upscales to 2 MP and enhances detail.
 *  `strength` = refine denoise (0 = upscale only). */
export function enqueuePhotoHd({ sourceFile, parentAssetId, prompt, strength }) {
  const id = `phd-${Date.now().toString(36)}`
  const denoise = Number.isFinite(strength) ? Math.min(0.4, Math.max(0, strength)) : PHOTO_HD_DENOISE
  const row = {
    id, createdAt: Date.now(), status: 'queued',
    personaId: persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative',
    recipeId: 'photo_hd@v1', workflowFile: PHOTO_HD_WORKFLOW,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'photo_hd',
    sourceImage: sourceFile, photoHdDenoise: denoise,
    parentAssetId: parentAssetId ?? null,
    userPrompt: null, userDirectives: null,
    composedPositive: prompt ?? null, composedNegative: null,
    selections: null, loras: [], videoLoras: [],
    // ~35-45 s for a 760x1368 source taken to 2 MP.
    estimatedMs: 50000,
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

export function enqueueUpscale({ sourceFile, width, height, fps, videoEngine, parentAssetId, sourceLabel, h3 }) {
  const id = `ups-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued',
    personaId: persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative',
    recipeId: 'upscale_refine@v1', workflowFile: REFINE_RECIPE,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'upscale',
    sourceImage: null, videoEngine: videoEngine ?? null, withAudio: false,
    upscaleSource: sourceFile, upscaleW: width, upscaleH: height,
    upscaleH3: h3 === true || undefined,
    // SOURCE fps (drives the graph) and OUTPUT fps (display): sources < 24 fps
    // are RIFE x2 interpolated to 30; native H3 = 24.
    upscaleSrcFps: Number(fps) || 16,
    videoFps: h3 === true ? 24 : (Number(fps) || 16) < 24 ? 30 : Number(fps),
    parentAssetId: parentAssetId ?? null,
    videoDraft: null,
    userPrompt: null, userDirectives: null,
    composedPositive: `upscale refine ${width}x${height} (denoise ${UPSCALE_DENOISE}) de ${sourceLabel ?? sourceFile}`,
    composedNegative: null, selections: null, loras: [], videoLoras: [],
    /* ~160 s for 81 frames (16 fps); ~430 s for 150 frames (30 fps):
       per-frame cost grows with length (VRAM offload). */
    // H3: pass1 replay (~60 s) + pass2 (~220 s); Wan: half fps
    estimatedMs: h3 === true ? 290000
      : Math.round(160000 * Math.pow(((Number(fps) || 16) < 24 ? 15 : (Number(fps) || 16) / 2) / 15, 1.2)),
  }
  /* No idempotency key here: upscale is triggered by a button on a specific
     asset, not a form submission that could be replayed. */
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* NATIVE H3 LATENT upscale: replays the draft's exact pass 1 (provenance
   workflowJson, same seed => same clip) then chains 2x learned -> blur .5 ->
   contrast .90 -> pass2 4 steps -> TRIM 2 frames (the causal VAE's anchor
   token comes out waffled on frames 0-1). */
async function runUpscaleH3(job, t0) {
  const prov = store.getProvenance(job.parentAssetId)
  const g = JSON.parse(prov.workflow_json)
  // generic links from the pass1 graph (minimax recipe)
  const guiderId = Object.keys(g).find(k => g[k].class_type === 'BasicGuider')
  const samplerId = Object.keys(g).find(k => g[k].class_type === 'SamplerCustomAdvanced')
  const decodeId = Object.keys(g).find(k => g[k].class_type === 'VAEDecode')
  const audioDecId = Object.keys(g).find(k => g[k].class_type === 'VAEDecodeAudio')
  const selectId = Object.keys(g).find(k => g[k].class_type === 'KSamplerSelect')
  if (!guiderId || !samplerId || !decodeId || !audioDecId) throw new Error('graphe pass1 minimax incomplet en provenance')
  const modelLink = g[guiderId].inputs.model
  const condLink = g[guiderId].inputs.conditioning
  // pass 1 no longer decodes (its SaveVideo is removed): only the latent matters
  for (const k of Object.keys(g)) if (g[k].class_type === 'SaveVideo') delete g[k]
  // denoise 0.45: 0.5 slightly alters the expression, 0.35 causes doubling
  g['s2'] = { class_type: 'MiniMaxH3Pass2StaggeredScheduler', inputs: { model: modelLink, steps: 4, denoise: 0.45, rho: 7.0, shape: 'karras' } }
  g['n2'] = { class_type: 'RandomNoise', inputs: { noise_seed: (Number(job.seed) || 42) + 1 } }
  g['up'] = { class_type: 'MiniMaxH3LatentUpscaleCombined', inputs: {
    samples: [samplerId, 0], method: 'learned model',
    learned_model: 'h3_clean_latent_upscaler_film_epoch200.safetensors',
    model: modelLink, noise: ['n2', 0], sigmas: ['s2', 0],
    audio_denoise: 0.0, noise_resample: 'upscale', positive: condLink } }
  g['blr'] = { class_type: 'MiniMaxH3LatentBlur', inputs: { samples: ['up', 0], radius: 0.5 } }
  g['ctr'] = { class_type: 'MiniMaxH3LatentContrast', inputs: { samples: ['blr', 0], contrast: 0.90, preserve_norm: false } }
  g['dn2'] = { class_type: 'DisableNoise', inputs: {} }
  g['gd2'] = { class_type: 'BasicGuider', inputs: { model: modelLink, conditioning: ['up', 1] } }
  g['sp2'] = { class_type: 'SamplerCustomAdvanced', inputs: {
    noise: ['dn2', 0], guider: ['gd2', 0], sampler: [selectId, 0], sigmas: ['s2', 0], latent_image: ['ctr', 0] } }
  g['dec2'] = { class_type: 'VAEDecode', inputs: { samples: ['sp2', 0], vae: g[decodeId].inputs.vae } }
  g['aud2'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['sp2', 0], vae: g[audioDecId].inputs.vae } }
  g['trim'] = { class_type: 'ImageFromBatch', inputs: { image: ['dec2', 0], batch_index: 2, length: 4096 } }
  g['cv2'] = { class_type: 'CreateVideo', inputs: { fps: 24, bit_depth: 8, images: ['trim', 0], audio: ['aud2', 0] } }
  g['sv2'] = { class_type: 'SaveVideo', inputs: { filename_prefix: `creatoros/${job.id}/upscale`, format: 'auto', codec: 'auto', video: ['cv2', 0] } }
  await comfy.freeMemory().catch(() => { /* non-fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] UPSCALE LATENT H3 2x (replay ${job.parentAssetId}) prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [`upscale latent natif H3 2x (learned + blur .5 + contrast .90, pass2 4 steps d0.5, trim 2 frames d'ancrage) — replay pass1 même seed`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- brush retouch ----------
   The operator paints an area and describes what belongs there; only that area
   is redone, and the rest of the image is pasted back pixel-exact. No separate
   recipe: the graph starts from the generation recipe (same model, read as is,
   persona LoRAs stacked); its empty start latent is replaced by the encoded,
   masked source image, then the result is composited onto the source. */
const INPAINT_DENOISE = 0.9   // 0.75-0.8 keeps the original color
export function enqueueInpaint({ sourceFile, maskFile, parentAssetId, prompt, strength, personaId, agrandir }) {
  if (t0Hit(String(prompt ?? ''))) throw new Error('prompt refusé (liste T0)')
  const id = `inp-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: agrandir ? 'agrandir@v1' : 'inpaint@v1', workflowFile: agrandir ? EDIT_WORKFLOW : RECIPES.sfw,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'inpaint',
    sourceImage: sourceFile, inpaintMask: maskFile,
    inpaintDenoise: Number.isFinite(strength) ? Math.min(1, Math.max(0.3, strength)) : INPAINT_DENOISE,
    parentAssetId: parentAssetId ?? null,
    userPrompt: String(prompt ?? '').trim() || null, userDirectives: null,
    /* The operator's text ALONE: the original prompt describes what is being
       changed. The rest of the image provides context by itself. */
    composedPositive: String(prompt ?? '').trim() || null,
    composedNegative: null, selections: null, loras: [], videoLoras: [], estimatedMs: 25000,
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* Outpaint: Qwen Edit sees the whole enlarged image and only redraws the grey
   margins; the original photo is pasted back as is. No LoRA or preamble: the
   character is already in the image. */
function grapheAgrandir(job) {
  const g = comfy.loadWorkflow(job.workflowFile)
  g['10'].inputs.image = job.sourceImage
  delete g['12']
  for (const n of ['30', '31']) for (const [k, v] of Object.entries(g[n].inputs)) if (Array.isArray(v) && v[0] === '12') g[n].inputs[k] = ['10', 0]
  g['32'].inputs.pixels = ['10', 0]
  g['30'].inputs.prompt = job.composedPositive
  g.agr_peint = { class_type: 'LoadImage', inputs: { image: job.inpaintMask } }
  g.agr_masque = { class_type: 'ImageToMask', inputs: { image: ['agr_peint', 0], channel: 'red' } }
  g.agr_bord = { class_type: 'GrowMaskWithBlur', inputs: { mask: ['agr_masque', 0], expand: 0, incremental_expandrate: 0, tapered_corners: true, flip_input: false, blur_radius: 14, lerp_alpha: 1, decay_factor: 1, fill_holes: false } }
  g.agr_lat = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['32', 0], mask: ['agr_masque', 0] } }
  Object.assign(g['40'].inputs, { latent_image: ['agr_lat', 0], seed: Number(job.seed) || 42, denoise: 1 })
  g.agr_colle = { class_type: 'ImageCompositeMasked', inputs: { destination: ['10', 0], source: ['41', 0], x: 0, y: 0, resize_source: false, mask: ['agr_bord', 0] } }
  Object.assign(g['90'].inputs, { images: ['agr_colle', 0], filename_prefix: `creatoros/${job.id}/agrandir` })
  return g
}

async function runInpaint(job, t0) {
  if (job.recipeId === 'agrandir@v1') {
    const g = grapheAgrandir(job)
    const promptId = await comfy.submitPrompt(g, CLIENT_ID)
    current = { jobId: job.id, promptId }
    store.markStarted(job.id, promptId)
    const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
    const n = await harvestJob(job, promptId, history, { applied: ['agrandir : Qwen-Image-Edit 2511, marges redessinées, photo d’origine recollée'], skipped: [], finalWorkflow: g })
    store.markFinished(job.id, Date.now() - t0)
    return n
  }
  const g = comfy.loadWorkflow(job.workflowFile)
  const un = classe => Object.keys(g).filter(k => g[k].class_type === classe)
  const [ks] = un('KSampler'), [dec] = un('VAEDecode'), saves = un('SaveImage')
  if (!ks || !dec || !saves.length) throw new Error(`retouche au pinceau : la recette « ${job.workflowFile} » n'a pas la forme attendue (échantillonneur, décodage, sortie)`)
  const preamble = identityPreambleFor(job.personaId)
  const texte = g[g[ks].inputs.positive?.[0]]
  if (texte?.class_type !== 'CLIPTextEncode') throw new Error('retouche au pinceau : prompt positif introuvable dans la recette')
  texte.inputs.text = `${preamble?.text ?? ''}${job.composedPositive ?? ''}`.trim()
  // persona LoRAs, stacked as on the generation path
  const pl = comfy.empilerLoras(g, lorasPhoto(persona(job.personaId), PHOTO_ENGINE)).applied
  g.inp_src = { class_type: 'LoadImage', inputs: { image: job.sourceImage } }
  g.inp_peint = { class_type: 'LoadImage', inputs: { image: job.inpaintMask } }
  g.inp_masque = { class_type: 'ImageToMask', inputs: { image: ['inp_peint', 0], channel: 'red' } }
  // redone area slightly wider than the stroke, feathered edge: no visible seam when compositing
  g.inp_bord = { class_type: 'GrowMaskWithBlur', inputs: { mask: ['inp_masque', 0], expand: 10, incremental_expandrate: 0, tapered_corners: true,
    flip_input: false, blur_radius: 8, lerp_alpha: 1, decay_factor: 1, fill_holes: false } }
  g.inp_enc = { class_type: 'VAEEncode', inputs: { pixels: ['inp_src', 0], vae: g[dec].inputs.vae } }
  g.inp_lat = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['inp_enc', 0], mask: ['inp_bord', 0] } }
  Object.assign(g[ks].inputs, { latent_image: ['inp_lat', 0], denoise: job.inpaintDenoise ?? INPAINT_DENOISE, seed: Number(job.seed) || 42 })
  g.inp_colle = { class_type: 'ImageCompositeMasked', inputs: { destination: ['inp_src', 0], source: [dec, 0], x: 0, y: 0, resize_source: false, mask: ['inp_bord', 0] } }
  for (const id of saves) Object.assign(g[id].inputs, { images: ['inp_colle', 0], filename_prefix: `creatoros/${job.id}/pinceau` })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] PINCEAU denoise ${g[ks].inputs.denoise} sur ${job.sourceImage} (masque ${job.inpaintMask}) prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [`retouche au pinceau : zone peinte refaite (denoise ${g[ks].inputs.denoise}, recette « ${job.workflowFile} »), reste de l'image recollé à l'identique`, ...pl],
    skipped: [], preamble, finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- video brush retouch ----------
   Same gesture as on a photo: the operator paints the area on the clip's FIRST
   frame and describes what they want. SAM3 tracks the area frame by frame from
   that mask (`suivi`), or the area stays fixed in the frame. The area is redrawn
   by the masked video refine (Wan T2V low noise, recipe read as is), then
   composited onto the source: outside the area, the source frames. Works at
   16 fps, RIFE interpolation afterwards. Single block: clips up to ~10 s
   (longer runs out of memory). */
const INPAINT_VIDEO_DENOISE = 0.75
const INPAINT_VIDEO_MAX_IMAGES = 161
/* Prompt edit: same chain, but the area is not painted; SAM3 finds it from
   `cible` ("dress", "sunglasses"...) on each frame and tracks it; the prompt
   says what belongs there. Nothing changes if the target is not in the image. */
/* Video reframe: the clip is placed at the center of a frame at the new aspect; the edges
   (pre-filled with the clip's colors only, no shapes that would become ghosts) are redrawn by the Wan retouch, fixed area. */
const FORMATS_RECADRAGE = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5 }
/* Reframe: Wan 2.2 Fun VACE sees the clip centered on a grey canvas and generates the
   edges frame by frame, continuing the scene, perspective and motion. The original
   clip is then pasted back at the center (its fps, its audio), with a feathered seam. */
const VACE_IMAGES = 81
export function enqueueRecadrage({ source, format, prompt, parentAssetId, personaId }) {
  const ar = FORMATS_RECADRAGE[format]
  if (!ar) throw new Error('format inconnu')
  const vace = 'wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors'
  if (![path.join(CONFIG.comfyDir, 'models', 'diffusion_models'), path.join(os.homedir(), 'models', 'diffusion_models')].some(d => fs.existsSync(path.join(d, vace)))) throw new Error('modèle Wan 2.2 Fun VACE absent (voir l’installateur, groupe recadrage)')
  const sonde = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', source], { encoding: 'utf8' }).trim().split('\n')
  const [w, h] = sonde.slice(0, 2).map(Number), duree = Number(sonde[3])
  const [fn, fd] = String(sonde[2]).split('/').map(Number), fpsOrig = Math.min(60, fd ? fn / fd : fn) || 24
  if (Math.abs(w / h - ar) < 0.02) throw new Error('le clip est déjà à ce format')
  if (!(duree > 0)) throw new Error('vidéo illisible')
  if (duree > 10.5) throw new Error('clip trop long pour le recadrage : 10 s au plus')
  // final canvas: the clip keeps its size, long side capped at 1280 px; generation canvas: long side 1024
  const pair = v => Math.max(16, Math.round(v / 16) * 16)
  let W = w / h < ar ? h * ar : w, H = w / h < ar ? h : w / ar
  const k = Math.min(1, 1280 / Math.max(W, H)); W = pair(W * k); H = pair(H * k)
  const cw = Math.min(W, Math.round(w * k / 2) * 2), ch = Math.min(H, Math.round(h * k / 2) * 2)
  const kg = 1024 / Math.max(W, H), Wg = pair(W * kg), Hg = pair(H * kg)
  const cwg = Math.round(cw * Wg / W / 2) * 2, chg = Math.round(ch * Hg / H / 2) * 2
  // 81 frames cover the whole clip: beyond 5 s the generation fps drops
  const fpsGen = Math.min(16, (VACE_IMAGES - 1) / duree)
  const cle = Date.now().toString(36), ctrl = `RCD_${cle}.mp4`, masque = `RCD_${cle}_masque.png`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-f', 'lavfi', '-i', `color=0x808080:s=${Wg}x${Hg}:r=${fpsGen}`, '-filter_complex',
    `[0:v]fps=${fpsGen},scale=${cwg}:${chg},setsar=1[c];[1:v][c]overlay=(W-w)/2:(H-h)/2:shortest=1,tpad=stop_mode=clone:stop=${VACE_IMAGES}[v]`,
    '-map', '[v]', '-frames:v', String(VACE_IMAGES), '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', path.join(CONFIG.comfyInput, ctrl)])
  // mask: white = generate; the clip keeps a 6 px overlap so the edges extend it
  const m = 6
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=white:s=${Wg}x${Hg}`, '-vf',
    `drawbox=x=${(Wg - cwg) / 2 + m}:y=${(Hg - chg) / 2 + m}:w=${Math.max(2, cwg - 2 * m)}:h=${Math.max(2, chg - 2 * m)}:color=black:t=fill`, '-frames:v', '1', path.join(CONFIG.comfyInput, masque)])
  const texte = String(prompt ?? '').trim() || 'the same place continues naturally on every side, same light, coherent perspective'
  if (t0Hit(texte)) throw new Error('prompt refusé (liste T0)')
  const id = `rcd-${cle}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'recadrage@v3', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'recadrage', videoEngine: null,
    recadrage: { source, ctrl, masque, W, H, cw, ch, Wg, Hg, fpsGen, duree, fpsOrig },
    parentAssetId: parentAssetId ?? null, userPrompt: texte, userDirectives: null, composedPositive: texte, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 90_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}

/* Wan 2.2 Fun VACE in 4 steps: lightx2v pair on both experts, euler, cfg 1, experts split at step 2
   (bench of 11/11: same quality as uni_pc 20 steps cfg 3.5, about 7 times faster). */
const VACE_LIGHTX2V = ['wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors', 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors']
function vaceQuatrePas(g) {
  g.lx_h = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['uh', 0], lora_name: VACE_LIGHTX2V[0], strength_model: 1 } }
  g.lx_l = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['ul', 0], lora_name: VACE_LIGHTX2V[1], strength_model: 1 } }
  g.mh.inputs.model = ['lx_h', 0]; g.ml.inputs.model = ['lx_l', 0]
  Object.assign(g.kh.inputs, { steps: 4, cfg: 1, sampler_name: 'euler', start_at_step: 0, end_at_step: 2 })
  Object.assign(g.kl.inputs, { steps: 4, cfg: 1, sampler_name: 'euler', start_at_step: 2 })
  return g
}

function grapheRecadrage(job) {
  const r = job.recadrage, s = Number(job.seed) || 42
  const neg = 'black bars, letterbox, picture frame, border, doorway, window frame, split screen, blurry edges, smeared, distorted, duplicated people, text, watermark'
  const ks = (model, debut, fin, latent, bruit) => ({ class_type: 'KSamplerAdvanced', inputs: { model, add_noise: bruit ? 'enable' : 'disable', noise_seed: s, steps: 20, cfg: 3.5,
    sampler_name: 'uni_pc', scheduler: 'simple', positive: ['vace', 0], negative: ['vace', 1], latent_image: latent, start_at_step: debut, end_at_step: fin, return_with_leftover_noise: bruit ? 'enable' : 'disable' } })
  return {
    uh: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    ul: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    mh: { class_type: 'ModelSamplingSD3', inputs: { model: ['uh', 0], shift: 8 } },
    ml: { class_type: 'ModelSamplingSD3', inputs: { model: ['ul', 0], shift: 8 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp16.safetensors', type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: job.composedPositive } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: neg } },
    ctrl: { class_type: 'VHS_LoadVideo', inputs: { video: r.ctrl, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: VACE_IMAGES, skip_first_frames: 0, select_every_nth: 1 } },
    mimg: { class_type: 'LoadImage', inputs: { image: r.masque } },
    mrep: { class_type: 'RepeatImageBatch', inputs: { image: ['mimg', 0], amount: VACE_IMAGES } },
    mm: { class_type: 'ImageToMask', inputs: { image: ['mrep', 0], channel: 'red' } },
    vace: { class_type: 'WanVaceToVideo', inputs: { positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0], width: r.Wg, height: r.Hg, length: VACE_IMAGES, batch_size: 1, strength: 1,
      control_video: ['ctrl', 0], control_masks: ['mm', 0] } },
    kh: ks(['mh', 0], 0, 10, ['vace', 2], true),
    kl: ks(['ml', 0], 10, 10000, ['kh', 0], false),
    trim: { class_type: 'TrimVideoLatent', inputs: { samples: ['kl', 0], trim_amount: ['vace', 3] } },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['trim', 0], vae: ['vae', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: 16 } },
    out: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/bords`, format: 'mp4', codec: 'h264' } },
  }
}

async function runRecadrage(job, t0) {
  const r = job.recadrage
  const g = vaceQuatrePas(grapheRecadrage(job))
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { timeoutMs: 30 * 60_000, onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const sortie = Object.values(history.outputs ?? {}).flatMap(o => [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]).find(f => /\.mp4$/.test(f.filename))
  if (!sortie) throw new Error('recadrage : aucune vidéo en sortie')
  const bords = path.join(CONFIG.comfyOutput, sortie.subfolder ?? '', sortie.filename)
  // original clip pasted back at the center, at its fps, 12 px feathered seam; edges follow its duration
  const f = 12, tmp = `${bords}.final.mp4`
  await executer('ffmpeg', ['-v', 'error', '-y', '-i', r.source, '-i', bords, '-f', 'lavfi', '-i', `color=black:s=${r.cw}x${r.ch}`, '-filter_complex',
    `[0:v]scale=${r.cw}:${r.ch},setsar=1,format=yuva420p[c];` +
    `[2:v]drawbox=x=${f}:y=${f}:w=${r.cw - 2 * f}:h=${r.ch - 2 * f}:color=white:t=fill,boxblur=${f / 2}:2,format=gray[a];` +
    `[c][a]alphamerge[ca];` +
    `[1:v]setpts=N/(${r.fpsGen}*TB),fps=${r.fpsOrig ?? 24},scale=${r.W}:${r.H}:flags=lanczos,setsar=1[b];` +
    `[b][ca]overlay=(W-w)/2:(H-h)/2:shortest=1:eval=init,format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a?', '-t', String(r.duree), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeout: 300_000 })
  fs.renameSync(tmp, bords)
  const n = await harvestJob(job, promptId, history, { applied: [`recadrage : Wan 2.2 Fun VACE génère les bords (${r.Wg}×${r.Hg}, 81 images à ${r.fpsGen.toFixed(1)} i/s), clip d'origine recollé au centre`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

export function enqueueInpaintVideo({ sourceFile, maskFile, parentAssetId, prompt, strength, suivi, cible, inverser, retirer, objet, objetNom, loin, epargner }) {
  if (t0Hit(`${prompt ?? ''} ${cible ?? ''}`)) throw new Error('prompt refusé (liste T0)')
  const zoneTexte = String(cible ?? '').trim().slice(0, 80) || null
  if (!maskFile && !zoneTexte) throw new Error('rien à éditer : ni zone peinte ni élément à modifier')
  const m = driverMeta(sourceFile)
  if (!m) throw new Error('vidéo illisible')
  if (m.frames > INPAINT_VIDEO_MAX_IMAGES) throw new Error(`clip trop long pour la retouche (${m.seconds.toFixed(1)} s) : 10 s au plus — retoucher plan par plan`)
  const id = `inpv-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'inpaint_video@v1', workflowFile: REFINE_MASKED_RECIPE,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'inpaint_video', videoEngine: null,
    sourceImage: null, inpaintVideo: sourceFile, inpaintMask: maskFile ?? null, inpaintSuivi: suivi !== false, inpaintCible: zoneTexte,
    // "change background": track the person and redraw everything EXCEPT them (inverted mask)
    inpaintInverser: !!inverser && !!zoneTexte,
    // "remove": the area is first blurred with neighboring colors, otherwise the model redraws the object
    inpaintRetirer: !!retirer && !!zoneTexte && !inverser,
    // object to place: reference photo (input) and name for SAM3; the paste blends at moderate strength
    inpaintObjet: objet ?? null, inpaintObjetNom: objet ? String(objetNom ?? '').trim().slice(0, 80) || 'main object' : null,
    // far away: the object stays behind people, follows the camera, takes on distance blur
    inpaintLoin: !!objet && !!loin,
    // element tracked by SAM3 and kept out of the redrawn area (e.g. the face when redrawing hair)
    inpaintEpargne: String(epargner ?? '').trim().slice(0, 80) || null,
    inpaintDenoise: Number.isFinite(strength) ? Math.min(1, Math.max(0.3, strength)) : INPAINT_VIDEO_DENOISE,
    parentAssetId: parentAssetId ?? null,
    userPrompt: String(prompt ?? '').trim() || null, userDirectives: null,
    composedPositive: String(prompt ?? '').trim() || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [],
    // prompt edit of one element -> Ripple (runRipple): ~112 s for 5 s on the bench
    estimatedMs: Math.round(zoneTexte && !maskFile && !inverser && !retirer && !objet && !String(epargner ?? '').trim()
      ? 40_000 + m.seconds * 15_000 : (objet ? 90_000 : 60_000) + m.frames * 2500),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* ---------- new background for a clip (Wan 2.2 Fun VACE) ----------
   1) Qwen-Image-Edit 2511 redoes the first frame's scenery while keeping the
      person: this is the reference image for the new scenery.
   2) SAM3 tracks the person(s) and BiRefNet cuts them out within that area (gaps
      between arms and body are excluded); everything else turns grey in the
      control video, and the mask (person shrunk by ~12 px, inverted) tells VACE
      what to redraw, so gaps are wide enough for it to paint scenery. VACE redoes
      the scenery over the whole clip, guided by the reference.
   3) The source's people are pasted back on top at source resolution (short side
      up to 720): the cutout comes from BiRefNet (hair strands, soft edges),
      limited to the area SAM3 tracks so only the people are kept. */
const FOND_VACE_MAX_IMAGES = 161
function grapheFondVace(job) {
  const src = path.join(CONFIG.comfyInput, path.basename(job.inpaintVideo))
  const { width: sw, height: sh } = videoSize(src)
  const ratio = sw && sh ? sw / sh : 16 / 9
  const aire = 832 * 480
  const W = Math.max(256, Math.round(Math.sqrt(aire * ratio) / 16) * 16)
  const H = Math.max(256, Math.round(Math.sqrt(aire / ratio) / 16) * 16)
  const m = driverMeta(job.inpaintVideo)
  const N = Math.min(FOND_VACE_MAX_IMAGES, Math.floor(((m?.frames ?? 81) - 1) / 4) * 4 + 1)
  // paste resolution: the source's, short side capped at 720
  const k = Math.min(1, 720 / Math.max(1, Math.min(sw || W, sh || H)))
  const W2 = Math.round(((sw || W) * k) / 16) * 16, H2 = Math.round(((sh || H) * k) / 16) * 16
  const decor = String(job.composedPositive ?? '').trim()
  const cible = job.inpaintCible || 'person'
  const seed = Number(job.seed) || 42
  const ks = (model, a, b, lat, bruit) => ({ class_type: 'KSamplerAdvanced', inputs: { model, add_noise: bruit ? 'enable' : 'disable', noise_seed: seed,
    steps: 20, cfg: 3.5, sampler_name: 'uni_pc', scheduler: 'simple', positive: ['vace', 0], negative: ['vace', 1], latent_image: lat,
    start_at_step: a, end_at_step: b, return_with_leftover_noise: bruit ? 'enable' : 'disable' } })
  const g = {
    v: { class_type: 'VHS_LoadVideo', inputs: { video: job.inpaintVideo, force_rate: 16, custom_width: W, custom_height: H, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    // 1) reference: the first frame, scenery redone by Qwen-Image-Edit
    qe_img: { class_type: 'ImageFromBatch', inputs: { image: ['v', 0], batch_index: 0, length: 1 } },
    qe_px: { class_type: 'ImageScaleToTotalPixels', inputs: { upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1, image: ['qe_img', 0] } },
    qe_unet: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_fp8mixed.safetensors', weight_dtype: 'default' } },
    qe_clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    qe_vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    qe_att: { class_type: 'ModelAttentionBackend', inputs: { model: ['qe_unet', 0], attention: 'pytorch attention' } },
    qe_ms: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['qe_att', 0] } },
    qe_norm: { class_type: 'CFGNorm', inputs: { strength: 1, model: ['qe_ms', 0] } },
    qe_pos: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { prompt: `Replace the whole background with: ${decor}. Keep every person exactly identical: same face, hair, clothes, pose, size and position in the frame. Match the new light to the scene.`, clip: ['qe_clip', 0], vae: ['qe_vae', 0], image1: ['qe_px', 0] } },
    qe_neg: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { prompt: '', clip: ['qe_clip', 0], vae: ['qe_vae', 0], image1: ['qe_px', 0] } },
    qe_lat: { class_type: 'VAEEncode', inputs: { pixels: ['qe_px', 0], vae: ['qe_vae', 0] } },
    qe_ks: { class_type: 'KSampler', inputs: { seed, denoise: 1, model: ['qe_norm', 0], positive: ['qe_pos', 0], negative: ['qe_neg', 0], latent_image: ['qe_lat', 0], steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple' } },
    qe_dec: { class_type: 'VAEDecode', inputs: { samples: ['qe_ks', 0], vae: ['qe_vae', 0] } },
    refs: { class_type: 'ImageScale', inputs: { image: ['qe_dec', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
    // 2) people tracking, control video with grey scenery
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    txt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: cible } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['v', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 4, detect_interval: 1, conditioning: ['txt', 0] } },
    m: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '' } },
    // person = BiRefNet cutout within the SAM3-tracked area: gaps between arms and body,
    // which the SAM3 mask includes, are excluded and VACE redraws them too
    bir: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: 'birefnet.safetensors' } },
    detw: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bir', 0], image: ['v', 0] } },
    zonew: { class_type: 'GrowMask', inputs: { mask: ['m', 0], expand: 4, tapered_corners: true } },
    pw: { class_type: 'MaskComposite', inputs: { destination: ['detw', 0], source: ['zonew', 0], x: 0, y: 0, operation: 'multiply' } },
    pb: { class_type: 'ThresholdMask', inputs: { mask: ['pw', 0], value: 0.5 } },
    // VACE also redraws a band around the person (a few-pixel gap would stay grey);
    // the real person is pasted back on top with the BiRefNet cutout
    mg: { class_type: 'GrowMask', inputs: { mask: ['pb', 0], expand: -Math.max(6, Math.round(W / 70)), tapered_corners: true } },
    bg: { class_type: 'InvertMask', inputs: { mask: ['mg', 0] } },
    gris: { class_type: 'EmptyImage', inputs: { width: W, height: H, batch_size: N, color: 8355711 } },
    ctrl: { class_type: 'ImageCompositeMasked', inputs: { destination: ['v', 0], source: ['gris', 0], x: 0, y: 0, resize_source: false, mask: ['bg', 0] } },
    uh: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    ul: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    mh: { class_type: 'ModelSamplingSD3', inputs: { model: ['uh', 0], shift: 8 } },
    ml: { class_type: 'ModelSamplingSD3', inputs: { model: ['ul', 0], shift: 8 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp16.safetensors', type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: `${decor}. Nobody else in the background, the place is empty around the subject. Realistic, cinematic, consistent light.` } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: 'other people, passers-by, crowd, extra person, blurry, distorted, deformed, flicker, halo, outline, glow around the person, cartoon, text, watermark' } },
    vace: { class_type: 'WanVaceToVideo', inputs: { positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0], width: W, height: H, length: N, batch_size: 1, strength: 1,
      control_video: ['ctrl', 0], control_masks: ['bg', 0], reference_image: ['refs', 0] } },
    kh: ks(['mh', 0], 0, 10, ['vace', 2], true),
    kl: ks(['ml', 0], 10, 10000, ['kh', 0], false),
    trim: { class_type: 'TrimVideoLatent', inputs: { samples: ['kl', 0], trim_amount: ['vace', 3] } },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['trim', 0], vae: ['vae', 0] } },
    // 3) source people pasted back at its resolution: BiRefNet cutout within the SAM3-tracked area
    vh: { class_type: 'VHS_LoadVideo', inputs: { video: job.inpaintVideo, force_rate: 16, custom_width: W2, custom_height: H2, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    det: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bir', 0], image: ['vh', 0] } },
    mh2: { class_type: 'ResizeMask', inputs: { mask: ['pb', 0], width: W2, height: H2, keep_proportions: false, upscale_method: 'bilinear', crop: 'disabled' } },
    // tight area: grown by only a few pixels, otherwise the gap between arm and body lets the old ground back in
    zone: { class_type: 'GrowMaskWithBlur', inputs: { mask: ['mh2', 0], expand: Math.max(3, Math.round(W2 / 320)), incremental_expandrate: 0, tapered_corners: true, flip_input: false, blur_radius: 2, lerp_alpha: 1, decay_factor: 1 } },
    alpha: { class_type: 'MaskComposite', inputs: { destination: ['det', 0], source: ['zone', 0], x: 0, y: 0, operation: 'multiply' } },
    fond: { class_type: 'ImageScale', inputs: { image: ['dec', 0], upscale_method: 'lanczos', width: W2, height: H2, crop: 'disabled' } },
    colle: { class_type: 'ImageCompositeMasked', inputs: { destination: ['fond', 0], source: ['vh', 0], x: 0, y: 0, resize_source: false, mask: ['alpha', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['colle', 0], fps: 16 } },
    out: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/fond`, format: 'mp4', codec: 'h264' } },
  }
  return { g, W, H, N }
}

/* ---------- clip colorization (Wan 2.2 Fun VACE) ----------
   The black and white clip is the guide (structure and motion), an already
   colorized reference image (its first frame restored by Qwen-Image-Edit)
   provides the colors, and a full mask makes VACE repaint the whole image.
   Motion and framing stay the clip's; HD comes afterwards (SeedVR2). */
const COLORISER_MAX_IMAGES = 161
export function enqueueColorisationVideo({ source, reference, masque, bordsSeuls = false, parentAssetId, origineUri }) {
  // bordsSeuls: no color, VACE only rebuilds the edges left empty by stabilization (mask required)
  for (const n of [source, ...(bordsSeuls ? [] : [reference]), ...(masque || bordsSeuls ? [masque] : [])]) if (!n || /[\\/]/.test(n) || n.startsWith('.')) throw new Error('fichier invalide')
  const src = path.join(CONFIG.comfyInput, source)
  if (!fs.existsSync(src)) throw new Error('clip introuvable')
  const duree = videoDurationOf(src)
  if (!duree) throw new Error('vidéo illisible')
  if (duree > 10) throw new Error('10 s au plus pour la colorisation')
  const id = `couleur-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: SANS_PERSONNAGE, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'coloriser_video@v2', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'coloriser_video', videoEngine: null,
    colSource: source, colReference: bordsSeuls ? null : reference, colMasque: masque ?? null, colBordsSeuls: bordsSeuls || undefined, origineUri: origineValide(origineUri),
    parentAssetId: parentAssetId ?? null, userPrompt: bordsSeuls ? 'bords reconstruits' : 'colorisation', userDirectives: null,
    composedPositive: bordsSeuls ? `bords de ${source} reconstruits` : `colorisation de ${source} (référence ${reference})`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(30_000 + duree * 11_000),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
function grapheColoriser(job) {
  const src = path.join(CONFIG.comfyInput, path.basename(job.colSource))
  const { width: sw, height: sh } = videoSize(src)
  const ratio = sw && sh ? sw / sh : 4 / 3
  const aire = 832 * 624
  const W = Math.max(256, Math.round(Math.sqrt(aire * ratio) / 16) * 16)
  const H = Math.max(256, Math.round(Math.sqrt(aire / ratio) / 16) * 16)
  const m = driverMeta(job.colSource)
  const N = Math.min(COLORISER_MAX_IMAGES, Math.floor(((m?.frames ?? 81) - 1) / 4) * 4 + 1)
  const seed = Number(job.seed) || 42
  const ks = (model, a, b, lat, bruit) => ({ class_type: 'KSamplerAdvanced', inputs: { model, add_noise: bruit ? 'enable' : 'disable', noise_seed: seed,
    steps: 20, cfg: 3.5, sampler_name: 'uni_pc', scheduler: 'simple', positive: ['vace', 0], negative: ['vace', 1], latent_image: lat,
    start_at_step: a, end_at_step: b, return_with_leftover_noise: bruit ? 'enable' : 'disable' } })
  const g = {
    v: { class_type: 'VHS_LoadVideo', inputs: { video: job.colSource, force_rate: 16, custom_width: W, custom_height: H, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    blanc: { class_type: 'EmptyImage', inputs: { width: W, height: H, batch_size: N, color: 16777215 } },
    tout: { class_type: 'ImageToMask', inputs: { image: ['blanc', 0], channel: 'red' } },
    ...(job.colReference ? {
      ref0: { class_type: 'LoadImage', inputs: { image: job.colReference } },
      refs: { class_type: 'ImageScale', inputs: { image: ['ref0', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
    } : {}),
    // empty edges left by stabilization (white = original image): grey in the guide, for VACE to invent
    ...(job.colMasque ? {
      mv: { class_type: 'VHS_LoadVideo', inputs: { video: job.colMasque, force_rate: 16, custom_width: W, custom_height: H, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
      mvm: { class_type: 'ImageToMask', inputs: { image: ['mv', 0], channel: 'red' } },
      valide: { class_type: 'ThresholdMask', inputs: { mask: ['mvm', 0], value: 0.9 } },
      bord0: { class_type: 'InvertMask', inputs: { mask: ['valide', 0] } },
      bord: { class_type: 'GrowMask', inputs: { mask: ['bord0', 0], expand: 6, tapered_corners: true } },
      gris: { class_type: 'EmptyImage', inputs: { width: W, height: H, batch_size: N, color: 8355711 } },
      ctrl: { class_type: 'ImageCompositeMasked', inputs: { destination: ['v', 0], source: ['gris', 0], x: 0, y: 0, resize_source: false, mask: ['bord', 0] } },
    } : {}),
    uh: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    ul: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    mh: { class_type: 'ModelSamplingSD3', inputs: { model: ['uh', 0], shift: 8 } },
    ml: { class_type: 'ModelSamplingSD3', inputs: { model: ['ul', 0], shift: 8 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp16.safetensors', type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: job.colBordsSeuls
      ? 'The same film footage, the edges of the frame continue the scene seamlessly, same colors, same grain, same motion.'
      : 'Colorized archival film footage with natural, realistic, true-to-life period colors, matching the colors of the reference image. The same shot, the same framing, the same motion, clean and sharp. Nothing new appears in the frame: the edges simply continue the same scene, no foreground objects.' } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: 'black and white, monochrome, sepia, grayscale, oversaturated, cartoon, flicker, color bleeding, blurry, distorted, foreground leaves, branches, foliage, new objects, vignette, frame border' } },
    vace: { class_type: 'WanVaceToVideo', inputs: { positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0], width: W, height: H, length: N, batch_size: 1, strength: 1,
      control_video: [job.colMasque ? 'ctrl' : 'v', 0], control_masks: [job.colBordsSeuls ? 'bord' : 'tout', 0], ...(job.colReference ? { reference_image: ['refs', 0] } : {}) } },
    kh: ks(['mh', 0], 0, 10, ['vace', 2], true),
    kl: ks(['ml', 0], 10, 10000, ['kh', 0], false),
    trim: { class_type: 'TrimVideoLatent', inputs: { samples: ['kl', 0], trim_amount: ['vace', 3] } },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['trim', 0], vae: ['vae', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: 16 } },
    out: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/${job.colBordsSeuls ? 'bords' : 'couleur'}`, format: 'mp4', codec: 'h264' } },
  }
  return { g, W, H, N }
}
async function runColoriserVideo(job, t0) {
  const { g: g0, W, H, N } = grapheColoriser(job), g = vaceQuatrePas(g0)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] COLORISATION (VACE) ${W}×${H}, ${N} images, référence ${job.colReference} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [job.colBordsSeuls ? `bords reconstruits : Wan 2.2 Fun VACE (${W}×${H}, ${N} images à 16 i/s) sur les bords vides de la stabilisation`
      : `colorisation : Wan 2.2 Fun VACE (${W}×${H}, ${N} images à 16 i/s), couleurs de ${job.colReference}, mouvement du clip d'origine${job.colMasque ? ', bords de la stabilisation reconstruits' : ''}`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

async function runFondVace(job, t0) {
  const { g, W, H, N } = grapheFondVace(job)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] NOUVEAU FOND (VACE) ${W}×${H}, ${N} images, SAM3 « ${job.inpaintCible} » sur ${job.inpaintVideo} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`nouveau fond : 1re image refaite par Qwen-Image-Edit 2511, décor du clip refait par Wan 2.2 Fun VACE (${W}×${H}, ${N} images à 16 i/s), `
      + `personnes suivies par SAM3 (« ${job.inpaintCible} ») et recollées depuis la source`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- prompt edit of one element in a clip: Ripple (Paint a Plate) ----------
   Bench of 11/11: our masked Wan pass at 0.75 did not change the dress at all;
   this one turns it red over the whole clip in 112 s instead of 242 s.
   1) SAM3 tracks the named element; FLUX.2 Klein redraws it on the FIRST frame
      only (masked, at ~0.25 Mpx, then refined at full size, denoise 0.35, soft paste).
   2) LTX-2.5 + IC-LoRA Ripple v1.1 (WepeNerd, LTX-2.x community license, 1.35)
      propagates that first frame over the clip, the source as motion reference.
   3) SAM3 tracks the element again on the result; the union of both mattes,
      grown and blurred, pastes the redrawn element over the source, the rest of
      the frame stays the source pixel for pixel. Source sound kept. */
const RIPPLE_BUDGET = 1856 * 768 * 121   // pixels x frames of the bench (30 GB peak on the 5090)
export function grapheRipple(job, src) {
  const fps = 24
  const frames = Math.max(9, Math.floor((Math.min(src.secondes * fps, 241) - 1) / 8) * 8 + 1)
  const aire = Math.min(1856 * 768, RIPPLE_BUDGET / frames)
  const k = Math.min(1, Math.sqrt(aire / (src.width * src.height)))
  const r32 = x => Math.max(256, Math.round(x / 32) * 32)
  const W = r32(src.width * k), H = r32(src.height * k)
  const kq = Math.sqrt(0.25e6 / (W * H))
  const qW = Math.max(256, Math.round(W * kq / 16) * 16), qH = Math.max(256, Math.round(H * kq / 16) * 16)
  const seed = Number(job.seed) || 42
  const cible = job.inpaintCible, change = String(job.composedPositive ?? '').trim()
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', weight_dtype: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
    src: { class_type: 'VHS_LoadVideo', inputs: { video: job.inpaintVideo, force_rate: fps, custom_width: 0, custom_height: 0, frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
    plate: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'disabled' } },
    sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    st: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: cible } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['plate', 0], model: ['sam', 0], detection_threshold: 0.35, max_objects: 1, detect_interval: 1, conditioning: ['st', 0] } },
    m: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '0' } },
    m0_i: { class_type: 'MaskToImage', inputs: { mask: ['m', 0] } },
    m0_f: { class_type: 'ImageFromBatch', inputs: { image: ['m0_i', 0], batch_index: 0, length: 1 } },
    m0: { class_type: 'ImageToMask', inputs: { image: ['m0_f', 0], channel: 'red' } },
    f0: { class_type: 'ImageFromBatch', inputs: { image: ['plate', 0], batch_index: 0, length: 1 } },
    // 1) first frame redrawn by Klein
    ku: { class_type: 'UNETLoader', inputs: { unet_name: 'flux3-image-klein-int8-convrot.safetensors', weight_dtype: 'default' } },
    kc: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_int8_convrot.safetensors', type: 'flux3', device: 'default' } },
    kv: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    kpos: { class_type: 'CLIPTextEncode', inputs: { clip: ['kc', 0], text: `The ${cible} becomes ${change}.` } },
    kneg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['kpos', 0] } },
    qbase: { class_type: 'ImageScale', inputs: { image: ['f0', 0], upscale_method: 'lanczos', width: qW, height: qH, crop: 'disabled' } },
    qmask_i: { class_type: 'MaskToImage', inputs: { mask: ['m0', 0] } },
    qmask_s: { class_type: 'ImageScale', inputs: { image: ['qmask_i', 0], upscale_method: 'bilinear', width: qW, height: qH, crop: 'disabled' } },
    qmask: { class_type: 'ImageToMask', inputs: { image: ['qmask_s', 0], channel: 'red' } },
    qref: { class_type: 'ReferenceMultiLatent', inputs: { positive: ['kpos', 0], negative: ['kneg', 0], vae: ['kv', 0], resolution: 'keep resolution', 'images.image0': ['qbase', 0] } },
    qgrow: { class_type: 'GrowMask', inputs: { mask: ['qmask', 0], expand: 16, tapered_corners: true } },
    qenc: { class_type: 'VAEEncode', inputs: { pixels: ['qbase', 0], vae: ['kv', 0] } },
    qnm: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['qenc', 0], mask: ['qgrow', 0] } },
    qk: { class_type: 'KSampler', inputs: { model: ['ku', 0], seed, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: ['qref', 0], negative: ['qref', 1], latent_image: ['qnm', 0], denoise: 1 } },
    qdec: { class_type: 'VAEDecode', inputs: { samples: ['qk', 0], vae: ['kv', 0] } },
    qmi: { class_type: 'MaskToImage', inputs: { mask: ['qgrow', 0] } },
    qblur: { class_type: 'ImageBlur', inputs: { image: ['qmi', 0], blur_radius: 6, sigma: 3 } },
    qalpha: { class_type: 'ImageToMask', inputs: { image: ['qblur', 0], channel: 'red' } },
    qres: { class_type: 'ImageCompositeMasked', inputs: { destination: ['qbase', 0], source: ['qdec', 0], x: 0, y: 0, resize_source: false, mask: ['qalpha', 0] } },
    start: { class_type: 'ImageScale', inputs: { image: ['qres', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'disabled' } },
    fref: { class_type: 'ReferenceMultiLatent', inputs: { positive: ['kpos', 0], negative: ['kneg', 0], vae: ['kv', 0], resolution: 'keep resolution', 'images.image0': ['f0', 0] } },
    fgrow: { class_type: 'GrowMask', inputs: { mask: ['m0', 0], expand: 39, tapered_corners: true } },
    fenc: { class_type: 'VAEEncode', inputs: { pixels: ['start', 0], vae: ['kv', 0] } },
    fnm: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['fenc', 0], mask: ['fgrow', 0] } },
    fk: { class_type: 'KSampler', inputs: { model: ['ku', 0], seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: ['fref', 0], negative: ['fref', 1], latent_image: ['fnm', 0], denoise: 0.35 } },
    fdec: { class_type: 'VAEDecode', inputs: { samples: ['fk', 0], vae: ['kv', 0] } },
    fmi: { class_type: 'MaskToImage', inputs: { mask: ['fgrow', 0] } },
    fblur: { class_type: 'ImageBlur', inputs: { image: ['fmi', 0], blur_radius: 12, sigma: 6 } },
    falpha: { class_type: 'ImageToMask', inputs: { image: ['fblur', 0], channel: 'red' } },
    fres: { class_type: 'ImageCompositeMasked', inputs: { destination: ['f0', 0], source: ['fdec', 0], x: 0, y: 0, resize_source: false, mask: ['falpha', 0] } },
    rest: { class_type: 'ImageFromBatch', inputs: { image: ['plate', 0], batch_index: 1, length: 4096 } },
    batch: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['fres', 0], 'images.image1': ['rest', 0] } },
    // 2) propagation by LTX + Ripple
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'ltx/LTX25_Ripple_v11.safetensors', strength_model: 1.35 } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: `Use the reference video for motion, timing, camera movement, framing and lighting changes; follow the edited first frame for every change of content, light and style. Changed in the first frame: the ${cible} becomes ${change}; it keeps moving naturally and stays in place on what it touches for the whole shot.` } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: 'blurry, low resolution, ugly, garbled mess, compression artifacts, glitch, flicker, still image' } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: frames, batch_size: 1 } },
    guide: { class_type: 'LTXAddVideoICLoRAGuide', inputs: { positive: ['cond', 0], negative: ['cond', 1], vae: ['vae', 0], latent: ['lat', 0], image: ['batch', 0], frame_idx: 0, strength: 1, latent_downscale_factor: 1, crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64, use_streaming: false, tile_frames: 97 } },
    alat: { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['avae', 0], frames_number: frames, frame_rate: fps, batch_size: 1 } },
    n: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    gd: { class_type: 'CFGGuider', inputs: { model: ['lora', 0], positive: ['guide', 0], negative: ['guide', 1], cfg: 1 } },
    smp: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sch: { class_type: 'BasicScheduler', inputs: { model: ['lora', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['guide', 2], audio_latent: ['alat', 0] } },
    k: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['n', 0], guider: ['gd', 0], sampler: ['smp', 0], sigmas: ['sch', 0], latent_image: ['av', 0] } },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['k', 0] } },
    crop: { class_type: 'LTXVCropGuides', inputs: { positive: ['guide', 0], negative: ['guide', 1], latent: ['sep', 0] } },
    dec: { class_type: 'VAEDecodeTiled', inputs: { samples: ['crop', 2], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 } },
    // 3) paste-back through the union of both SAM3 mattes
    st2: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: cible } },
    trk2: { class_type: 'SAM3_VideoTrack', inputs: { images: ['dec', 0], model: ['sam', 0], detection_threshold: 0.35, max_objects: 1, detect_interval: 1, conditioning: ['st2', 0] } },
    m2: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk2', 0], object_indices: '0' } },
    mu: { class_type: 'MaskComposite', inputs: { destination: ['m', 0], source: ['m2', 0], x: 0, y: 0, operation: 'add' } },
    cm: { class_type: 'GrowMaskWithBlur', inputs: { mask: ['mu', 0], expand: 12, incremental_expandrate: 0, tapered_corners: true, flip_input: false, blur_radius: 19, lerp_alpha: 1, decay_factor: 1, fill_holes: false } },
    out: { class_type: 'ImageCompositeMasked', inputs: { destination: ['plate', 0], source: ['dec', 0], x: 0, y: 0, resize_source: false, mask: ['cm', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['out', 0], fps, bit_depth: 8 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/ripple`, format: 'auto', codec: 'auto' } },
  }
  if (src.audio) {
    g.son = { class_type: 'TrimAudioDuration', inputs: { audio: ['src', 2], start_index: 0, duration: Math.round(frames / fps * 1000) / 1000 } }
    g.vid.inputs.audio = ['son', 0]
  }
  return { g, W, H, frames }
}

async function runRipple(job, t0) {
  const fichier = path.join(CONFIG.comfyInput, path.basename(job.inpaintVideo))
  const d = videoSize(fichier), m = driverMeta(job.inpaintVideo)
  if (!d.width || !d.height || !m) throw new Error('vidéo illisible')
  let audio = false
  try { audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', fichier], { encoding: 'utf8' }).trim() !== '' } catch { /* no sound */ }
  const { g, W, H, frames } = grapheRipple(job, { width: d.width, height: d.height, secondes: m.seconds, audio })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] RETOUCHE VIDÉO Ripple « ${job.inpaintCible} » ${W}×${H}, ${frames} images sur ${job.inpaintVideo} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`édition vidéo au prompt : « ${job.inpaintCible} » suivi par SAM3, redessiné par Klein sur la 1re image, propagé par LTX-2.5 + Ripple v1.1 (${W}×${H}, ${frames} images à 24 i/s), recollé sur la source par la matte SAM3`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

async function runInpaintVideo(job, t0) {
  if (job.inpaintCible && !job.inpaintInverser && !job.inpaintRetirer && !job.inpaintObjet && !job.inpaintEpargne && !job.inpaintMask) return runRipple(job, t0)
  if (job.inpaintInverser && !job.inpaintObjet) return runFondVace(job, t0)
  if (job.inpaintObjet) await preparerObjet(job)
  const g = comfy.loadWorkflow(REFINE_MASKED_RECIPE)
  const req = (id, classe) => { if (g[id]?.class_type !== classe) throw new Error(`retouche vidéo : la recette « ${REFINE_MASKED_RECIPE} » a changé (nœud ${id} ≠ ${classe})`) }
  req('20', 'VHS_LoadVideo'); req('12', 'KSampler'); req('8', 'CLIPTextEncode'); req('14', 'VAEDecode'); req('15', 'CreateVideo'); req('trk', 'SAM3_VideoTrack')
  Object.assign(g['20'].inputs, { video: job.inpaintVideo, force_rate: 16, frame_load_cap: 0, skip_first_frames: 0 })
  g['8'].inputs.text = `${triggerPrefix(job.personaId)}${job.composedPositive ?? ''}`.trim()
  Object.assign(g['12'].inputs, { denoise: job.inpaintDenoise ?? INPAINT_VIDEO_DENOISE, seed: Number(job.seed) || 42 })
  let zone
  if (job.inpaintCible) {
    // prompt edit: SAM3 detects and tracks the named element, frame by frame
    g.cface.inputs.text = job.inpaintCible
    zone = ['m0', 0]
    if (job.inpaintInverser) {
      g.trk.inputs.max_objects = 4
      g.inp_inv = { class_type: 'InvertMask', inputs: { mask: ['m0', 0] } }
      zone = ['inp_inv', 0]
    }
  } else {
  g.inp_peint = { class_type: 'LoadImage', inputs: { image: job.inpaintMask } }
  g.inp_masque = { class_type: 'ImageToMask', inputs: { image: ['inp_peint', 0], channel: 'red' } }
  if (job.inpaintSuivi) {
    // the area painted on the first frame seeds tracking; no detection text
    Object.assign(g.trk.inputs, { initial_mask: ['inp_masque', 0], max_objects: 1 })
    delete g.trk.inputs.conditioning
    delete g.cface
    zone = ['m0', 0]
  } else {
    // fixed area in the frame: the painted mask, repeated on every frame
    for (const k of ['trk', 'm0', 'cface', 'sam3']) delete g[k]
    g.inp_compte = { class_type: 'GetImageSizeAndCount', inputs: { image: ['20', 0] } }
    g.inp_rep = { class_type: 'RepeatImageBatch', inputs: { image: ['inp_peint', 0], amount: ['inp_compte', 3] } }
    g.inp_masque.inputs.image = ['inp_rep', 0]
    zone = ['inp_masque', 0]
    if (job.inpaintLoin) {
      // far away: the retouch spares people, the object stays behind them
      Object.assign(g, {
        loin_sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
        loin_t: { class_type: 'CLIPTextEncode', inputs: { clip: ['loin_sam', 1], text: 'person' } },
        loin_trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['20', 0], model: ['loin_sam', 0], detection_threshold: 0.35, max_objects: 6, detect_interval: 1, conditioning: ['loin_t', 0] } },
        loin_m: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['loin_trk', 0], object_indices: '' } },
        loin_gros: { class_type: 'GrowMask', inputs: { mask: ['loin_m', 0], expand: 10, tapered_corners: true } },
        loin_zone: { class_type: 'MaskComposite', inputs: { destination: ['inp_masque', 0], source: ['loin_gros', 0], x: 0, y: 0, operation: 'subtract' } },
      })
      zone = ['loin_zone', 0]
    }
  }
  }
  g.mg.inputs.mask = zone; g.mg.inputs.expand = 12
  // new background: the redone area barely overlaps the person, and the final composite blends
  // over a wide, soft band, without a fringe of the old scenery or a redrawn outline
  if (job.inpaintInverser) g.mg.inputs.expand = 4
  if (job.inpaintRetirer) {
    /* Pre-fill: the image scaled down to 24 px then up and blurred keeps only the
       scenery's colors; pasted into the (enlarged) area, it erases the object before
       encoding, so the model redraws scenery instead of recovering the object. */
    g.mg.inputs.expand = 40     // also swallows what "suggests" the object (a saucer leads to a cup being redrawn)
    g.inp_taille = { class_type: 'GetImageSizeAndCount', inputs: { image: ['20', 0] } }
    g.inp_mini = { class_type: 'ImageScale', inputs: { image: ['20', 0], upscale_method: 'area', width: 24, height: 0, crop: 'disabled' } }
    g.inp_maxi = { class_type: 'ImageScale', inputs: { image: ['inp_mini', 0], upscale_method: 'bilinear', width: ['inp_taille', 1], height: ['inp_taille', 2], crop: 'disabled' } }
    g.inp_lisse = { class_type: 'ImageBlur', inputs: { image: ['inp_maxi', 0], blur_radius: 31, sigma: 10 } }
    g.inp_efface = { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: ['inp_lisse', 0], x: 0, y: 0, resize_source: false, mask: ['mg', 0] } }
    g['21'].inputs.pixels = ['inp_efface', 0]
    if (g['9']?.inputs) g['9'].inputs.text = `${job.inpaintCible}, ${g['9'].inputs.text ?? ''}`.replace(/, $/, '')
  }
  g.inp_bord = { class_type: 'GrowMaskWithBlur', inputs: { mask: zone, expand: job.inpaintRetirer ? 40 : job.inpaintInverser ? 2 : 14, incremental_expandrate: 0, tapered_corners: true,
    flip_input: false, blur_radius: job.inpaintInverser ? 12 : 6, lerp_alpha: 1, decay_factor: 1, fill_holes: false } }
  // the Wan VAE decodes 4n+1 frames: the source is cut to that count, otherwise the last redrawn frame is repeated over the moving source
  g.inp_n = { class_type: 'GetImageSizeAndCount', inputs: { image: ['14', 0] } }
  g.inp_src = { class_type: 'ImageFromBatch', inputs: { image: ['20', 0], batch_index: 0, length: ['inp_n', 3] } }
  g.inp_colle = { class_type: 'ImageCompositeMasked', inputs: { destination: ['inp_src', 0], source: ['14', 0], x: 0, y: 0, resize_source: false, mask: ['inp_bord', 0] } }
  if (job.inpaintEpargne) {
    // the spared element is subtracted after growth, from both the redrawn latent area and the paste-back mask
    Object.assign(g, {
      ep_sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
      ep_t: { class_type: 'CLIPTextEncode', inputs: { clip: ['ep_sam', 1], text: job.inpaintEpargne } },
      ep_trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['20', 0], model: ['ep_sam', 0], detection_threshold: 0.3, max_objects: 1, detect_interval: 1, conditioning: ['ep_t', 0] } },
      ep_m: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['ep_trk', 0], object_indices: '' } },
      ep_g: { class_type: 'GrowMask', inputs: { mask: ['ep_m', 0], expand: 6, tapered_corners: true } },
      ep_lat: { class_type: 'MaskComposite', inputs: { destination: ['mg', 0], source: ['ep_g', 0], x: 0, y: 0, operation: 'subtract' } },
      ep_colle: { class_type: 'MaskComposite', inputs: { destination: ['inp_bord', 0], source: ['ep_g', 0], x: 0, y: 0, operation: 'subtract' } },
    })
    g.mlat.inputs.mask = ['ep_lat', 0]
    g.inp_colle.inputs.mask = ['ep_colle', 0]
  }
  g['15'].inputs.images = ['inp_colle', 0]
  g['16'].inputs.filename_prefix = `creatoros/${job.id}/pinceau`
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const mode = job.inpaintRetirer ? `retrait (SAM3 « ${job.inpaintCible} », zone pré-effacée)` : job.inpaintInverser ? `nouveau fond (tout sauf SAM3 « ${job.inpaintCible} »)` : job.inpaintCible ? `édition au prompt (SAM3 « ${job.inpaintCible} »)` : job.inpaintSuivi ? 'suivi SAM3' : 'zone fixe'
  console.log(`[job ${job.id}] PINCEAU VIDÉO ${mode} denoise ${g['12'].inputs.denoise} sur ${job.inpaintVideo} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [`${job.inpaintCible ? `édition vidéo au prompt : « ${job.inpaintCible} » détecté et suivi par SAM3` : `retouche vidéo au pinceau : zone ${job.inpaintSuivi ? 'suivie par SAM3 depuis le masque peint' : 'fixe dans le cadre'}`}, `
      + `redessinée (denoise ${g['12'].inputs.denoise}, « ${REFINE_MASKED_RECIPE} »), reste de la vidéo recollé depuis la source`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- talking avatar ----------
   A photo + a voice audio -> the character says the text, lip-synced.
   LTX-2.5 audio-to-video with the talking-head LoRA (elix3r, OpenRAIL): the voice
   is encoded into the audio latent and frozen (noise mask 0), the video is
   generated around it in two passes (half resolution, then x2 latent upscale),
   distilled sigmas, cfg 1. Bench of 11/11: 80 s instead of 179 s with InfiniteTalk,
   lips in sync.
   Second engine when MiniMax H3 is installed (never on the public demo): the H3
   recipe of the studio + MiniMaxH3AddGuide(audio), the voice guides the lips and
   is decoded back as the clip's sound. Bench of 11/11: 60 s for 7.3 s of voice
   (PDMD 4 steps), 12 s at most (context windows untested with the audio guide). */
const PAROLE_MAX_S = 20
const PAROLE_H3_MAX_S = 12
export function enqueueParole({ image, audio, texte, parentAssetId, personaId, moteur }) {
  const h3 = moteur === 'h3'
  if (h3 && !h3Disponible) throw new Error(demoPublique() ? H3_MESSAGE_DEMO : 'MiniMax H3 n’est pas installé sur ce studio : Paramètres > Modèles optionnels')
  const t = String(texte ?? '').trim().slice(0, 400)
  if (t0Hit(t)) throw new Error('texte refusé (liste T0)')
  for (const f of [image, audio]) if (!f || /[\\/]/.test(f) || f.startsWith('.')) throw new Error('fichier invalide : nom nu attendu (dossier input/)')
  const duree = videoDurationOf(path.join(CONFIG.comfyInput, audio))
  if (!duree) throw new Error('audio illisible')
  const max = h3 ? PAROLE_H3_MAX_S : PAROLE_MAX_S
  if (duree > max) throw new Error(`audio trop long (${duree.toFixed(1)} s) : ${max} s au plus${h3 ? ' avec MiniMax H3' : ''}`)
  const id = `parole-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: h3 ? 'parole-h3@v1' : 'parole@v2', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'parole', videoEngine: h3 ? 'minimax' : 'ltx',
    sourceImage: image, paroleAudio: audio, paroleDuree: duree, parentAssetId: parentAssetId ?? null,
    userPrompt: t || null, userDirectives: null, composedPositive: t || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(h3 ? 20_000 + duree * 8_500 : 35_000 + duree * 6_000),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id, duree }
}

const PAROLE_SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0'
const PAROLE_SIGMAS_2 = '0.909375, 0.725, 0.421875, 0.0'
export function grapheParole(job, w, h) {
  const texte = `She is talking to the camera with natural facial expressions and small head movements, her lips moving in sync with her words. ${job.composedPositive ?? ''}`.trim()
  const seed = Number(job.seed) || 42
  const images = Math.ceil(job.paroleDuree * 24 / 8) * 8 + 1
  const passe = (k, latent, sigmas) => ({
    [`g${k}`]: { class_type: 'CFGGuider', inputs: { model: ['lora', 0], positive: ['cond', 0], negative: ['cond', 1], cfg: 1 } },
    [`smp${k}`]: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    [`sig${k}`]: { class_type: 'ManualSigmas', inputs: { sigmas } },
    [`n${k}`]: { class_type: 'RandomNoise', inputs: { noise_seed: seed + k - 1 } },
    [`k${k}`]: { class_type: 'SamplerCustomAdvanced', inputs: { noise: [`n${k}`, 0], guider: [`g${k}`, 0], sampler: [`smp${k}`, 0], sigmas: [`sig${k}`, 0], latent_image: latent } },
    [`sep${k}`]: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: [`k${k}`, 0] } },
  })
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', weight_dtype: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
    upm: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'ltx/LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors', strength_model: 1 } },
    img: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    aud: { class_type: 'LoadAudio', inputs: { audio: job.paroleAudio } },
    trim: { class_type: 'TrimAudioDuration', inputs: { audio: ['aud', 0], start_index: 0, duration: Math.round(job.paroleDuree * 1000) / 1000 } },
    aenc: { class_type: 'LTXVAudioVAEEncode', inputs: { audio: ['trim', 0], audio_vae: ['avae', 0] } },
    m0: { class_type: 'SolidMask', inputs: { value: 0, width: 1024, height: 1024 } },
    afz: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['aenc', 0], mask: ['m0', 0] } },
    rs: { class_type: 'ResizeImageMaskNode', inputs: { input: ['img', 0], resize_type: 'scale longer dimension', scale_method: 'lanczos', 'resize_type.longer_size': 1536 } },
    pre: { class_type: 'LTXVPreprocess', inputs: { image: ['rs', 0], img_compression: 18 } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: texte } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: 'blurry, distorted face, warped mouth' } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: 24 } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w, height: h, length: images, batch_size: 1 } },
    i2v1: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vae', 0], image: ['pre', 0], latent: ['lat', 0], strength: 0.7, bypass: false } },
    av1: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['i2v1', 0], audio_latent: ['afz', 0] } },
    ...passe(1, ['av1', 0], PAROLE_SIGMAS),
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['sep1', 0], upscale_model: ['upm', 0], vae: ['vae', 0] } },
    i2v2: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vae', 0], image: ['rs', 0], latent: ['up', 0], strength: 1, bypass: false } },
    av2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['i2v2', 0], audio_latent: ['afz', 0] } },
    ...passe(2, ['av2', 0], PAROLE_SIGMAS_2),
    dec: { class_type: 'VAEDecodeTiled', inputs: { samples: ['sep2', 0], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: 24, audio: ['trim', 0] } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/parole`, format: 'auto', codec: 'auto' } },
  }
}

/* H3 variant: the studio's H3 recipe (PDMD 4 steps, Kitchen attention, int8 VAE)
   with the voice as an audio guide on the conditioning. */
export function grapheParoleH3(job, w, h) {
  const g = comfy.loadWorkflow(VIDEO_ENGINES.minimax.file)
  const i2v = Object.keys(g).find(k => g[k].class_type === 'MiniMaxH3ImageToVideo')
  const guide = Object.keys(g).find(k => g[k].class_type === 'BasicGuider')
  const duree = Object.keys(g).find(k => g[k].class_type === 'PrimitiveFloat' && /duration/i.test(g[k]._meta?.title ?? ''))
    ?? Object.keys(g).find(k => g[k].class_type === 'PrimitiveFloat')
  const vae = g[i2v].inputs.vae
  const avae = Object.keys(g).find(k => g[k].class_type === 'VAELoader' && /audio/.test(g[k].inputs.vae_name))
  const img = Object.keys(g).find(k => g[k].class_type === 'LoadImage')
  if (!i2v || !guide || !duree || !avae || !img) throw new Error('recette H3 du studio inattendue : nœuds du clip parlant introuvables')
  g[img].inputs.image = job.sourceImage
  Object.assign(g[i2v].inputs, { width: w, height: h,
    prompt: `She is talking to the camera with natural facial expressions and small head movements, her lips moving in sync with her words. ${job.composedPositive ?? ''}`.trim() })
  g[duree].inputs.value = Math.round(job.paroleDuree * 1000) / 1000
  for (const n of Object.values(g)) if (n.class_type === 'RandomNoise') n.inputs.noise_seed = Number(job.seed) || 42
  for (const n of Object.values(g)) if (n.class_type === 'SaveVideo') n.inputs.filename_prefix = `creatoros/${job.id}/parole`
  g.voix = { class_type: 'LoadAudio', inputs: { audio: job.paroleAudio } }
  g.guide_audio = { class_type: 'MiniMaxH3AddGuide', inputs: { positive: [i2v, 0], latent: [i2v, 1], vae, audio_vae: [avae, 0], audio: ['voix', 0], frame_idx: 0 } }
  g[guide].inputs.conditioning = ['guide_audio', 0]
  return g
}

async function runParole(job, t0) {
  if (job.videoEngine === 'minimax') return runParoleH3(job, t0)
  // first pass at half size (x2 latent upscale after): portrait, landscape or square depending on the photo
  let w = 544, h = 960
  try {
    const d = videoSize(path.join(CONFIG.comfyInput, job.sourceImage))
    if (d.width && d.height) {
      if (d.width > d.height * 1.15) { w = 960; h = 544 } else if (d.width * 1.15 >= d.height) { w = 704; h = 704 }
    }
  } catch { /* portrait by default */ }
  const g = grapheParole(job, w, h)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] AVATAR PARLANT LTX talking-head, ${job.paroleDuree.toFixed(1)} s d'audio, ${w * 2}×${h * 2} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`avatar parlant : LTX-2.5 audio vers vidéo + LoRA talking-head, deux passes, ${w * 2}×${h * 2}, audio « ${job.paroleAudio} » (${job.paroleDuree.toFixed(1)} s)`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

async function runParoleH3(job, t0) {
  // H3 sizes (about 0.9 Mpx, multiples of 32): portrait, landscape or square depending on the photo
  let w = 768, h = 1344
  try {
    const d = videoSize(path.join(CONFIG.comfyInput, job.sourceImage))
    if (d.width && d.height) {
      if (d.width > d.height * 1.15) { w = 1344; h = 768 } else if (d.width * 1.15 >= d.height) { w = 960; h = 960 }
    }
  } catch { /* portrait by default */ }
  const g = grapheParoleH3(job, w, h)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] AVATAR PARLANT MiniMax H3 + guide audio, ${job.paroleDuree.toFixed(1)} s d'audio, ${w}×${h} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`avatar parlant : MiniMax H3 (PDMD 4 pas) + MiniMaxH3AddGuide(audio), ${w}×${h}, audio « ${job.paroleAudio} » (${job.paroleDuree.toFixed(1)} s)`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- re-shoot: the same shot, seen from elsewhere ----------
   A library clip + an angle -> the same moment filmed by another camera.
   MoGe-2 (metric geometry, core node) -> CrossViewWarp (Cseti, Apache-2.0)
   reprojects the clip into the new view, holes in magenta -> LTX-2.5 distilled
   + IC-LoRA CrossView-Warp v2 (Apache-2.0, trained on LTX-2.3) fills the holes
   and renders the shot; two IC guides on pass 1 (the warp for geometry, the
   source for identity), the source alone on the x2 pass. Strength 1.3, auto
   pivot on the subject, camera keeps the source's aim. */
export const RESHOOT_ANGLES = {
  gauche: { az: -35, el: 0 },
  droite: { az: 35, el: 0 },
  'trois-quarts': { az: -45, el: 10 },
  plongee: { az: 15, el: 30 },
  'contre-plongee': { az: 15, el: -15 },
  balayage: { cles: [{ f: 1, az: -35, el: 5 }, { f: -1, az: 35, el: 5 }] },
  descente: { cles: [{ f: 1, az: 20, el: 35 }, { f: -1, az: 20, el: 0 }] },
  orbite: { cles: [{ f: 1, az: -50, el: 10 }, { f: -1, az: 50, el: 10 }] },
}
const RESHOOT_LORA = 'LTX2/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2_6000.safetensors'
export function enqueueReshoot({ source, angle, azimut, elevation, cles, texte, parentAssetId, personaId }) {
  const t = String(texte ?? '').trim().slice(0, 400)
  if (t0Hit(t)) throw new Error('texte refusé (liste T0)')
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const duree = videoDurationOf(path.join(CONFIG.mediaDir, source))
  if (!duree) throw new Error('vidéo illisible')
  // 8n+1 frames at 24 fps, 5 s max: the length IC guides accept
  const images = Math.max(25, Math.min(121, Math.floor((Math.floor(duree * 24) - 1) / 8) * 8 + 1))
  const borne = (az, el) => ({ az: Math.max(-90, Math.min(90, az)), el: Math.max(-35, Math.min(45, el)) })
  let a = RESHOOT_ANGLES[angle]
  if (!a && Array.isArray(cles) && cles.length >= 2) {
    // motion set in the 3D view: 2 to 4 poses, t from 0 (clip start) to 1 (end)
    const k = cles.slice(0, 4).map(c => ({ t: Number(c?.t), az: Number(c?.az), el: Number(c?.el) }))
    if (k.some(c => ![c.t, c.az, c.el].every(Number.isFinite))) throw new Error('mouvement invalide')
    k.sort((x, y) => x.t - y.t)
    a = { cles: k.map(c => ({ f: Math.max(1, Math.round(1 + Math.max(0, Math.min(1, c.t)) * (images - 1))), ...borne(c.az, c.el) })) }
  }
  if (!a) {
    const az = Number(azimut), el = Number(elevation)
    if (!Number.isFinite(az) || !Number.isFinite(el)) throw new Error('angle inconnu')
    a = borne(az, el)
  }
  const id = `reshoot-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'reshoot@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'reshoot', videoEngine: 'ltx_crossview',
    reshootSource: source, reshootAngle: angle in RESHOOT_ANGLES ? angle : a.cles ? 'mouvement' : 'libre', reshootCamera: a, reshootImages: images,
    parentAssetId: parentAssetId ?? null,
    userPrompt: t || null, userDirectives: null, composedPositive: t || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(30_000 + images * 1_100),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id, images }
}

/* Clean plate: remove people or vehicles from a clip, rebuilding the scenery
   behind them. Official LTX-2.5 Clean-Plate IC-LoRA (Lightricks, LTX-2.x
   Community license) on the same graph as Re-shoot, guided by the clip itself
   instead of its shifted view. The original audio is kept. */
const CLEANPLATE_LORA = 'ltx/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors'
/* Guard: "Remove" erases what it is told; naming clothing would undress someone.
   Clothing, underwear or body parts are refused, for everyone. */
const CIBLE_INTERDITE = /\b(cloth(es|ing)?|outfits?|garments?|dress(es)?|shirts?|t-?shirts?|tops?|blouses?|sweaters?|hoodies?|jackets?|coats?|skirts?|pants|trousers|jeans|shorts|leggings|tights|stockings|bikinis?|swimsuits?|swimwear|lingerie|underwear|panties|thongs?|bras?|towels?|robes?|sarongs?|veils?|hijabs?|fabric|skin|chest|breasts?|nipples?|butt|crotch|vêtements?|habits?|robes?|chemises?|jupes?|pantalons?|culottes?|soutien-?gorges?|maillots?|sous-vêtements?)\b/i
export function enqueueCleanPlate({ source, cible, decor, parentAssetId, personaId }) {
  const c = String(cible ?? '').trim().slice(0, 80) || 'people'
  if (CIBLE_INTERDITE.test(`${c} ${decor ?? ''}`)) throw new Error('ce mode retire des personnes ou des objets, jamais des vêtements')
  const d = String(decor ?? '').trim().slice(0, 300)
  if (t0Hit(`${c} ${d}`)) throw new Error('texte refusé (liste T0)')
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const duree = videoDurationOf(path.join(CONFIG.mediaDir, source))
  if (!duree) throw new Error('vidéo illisible')
  const images = Math.max(25, Math.min(121, Math.floor((Math.floor(duree * 24) - 1) / 8) * 8 + 1))
  // prompt shape from the model card: the scenery first, then what must no longer be there
  const prompt = `An empty clean plate of the exact same scene${d ? `: ${d},` : ''} with the same background, lighting and camera movement as the source video, `
    + `but with no ${c} anywhere in the frame. No ${c}, and no cast shadows or reflections of ${c}. Photorealistic footage, high detail. Keep everything else intact.`
  const id = `cleanplate-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'cleanplate@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'cleanplate', videoEngine: 'ltx_cleanplate',
    reshootSource: source, reshootAngle: 'clean plate', reshootCamera: { az: 0, el: 0 }, reshootImages: images,
    parentAssetId: parentAssetId ?? null,
    userPrompt: c, userDirectives: d || null, composedPositive: prompt, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(30_000 + images * 1_000),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id, images }
}

/* One-click video effects: the official LTX-2.5 IC-LoRAs from Lightricks (LTX-2.x Community license),
   on the same graph as Clean plate (the clip as sole guide, two passes). Each effect = its LoRA and its phrase. */
export const EFFETS_LTX = {
  'refine-details': { lora: 'ltx/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors', nom: 'Refine Details',
    prompt: () => 'Sharp photographic detail, crisp textures, natural grain, high resolution footage. The exact same scene, motion and framing.' },
  'day-to-night': { lora: 'ltx/ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', nom: 'Day to Night',
    prompt: t => `The exact same scene at night${t ? `: ${t}` : ''}, with the same camera movement and the same people and objects. Night lighting, realistic.` },
  'deblur': { lora: 'ltx/ltx-2.5-22b-ic-lora-deblur-0.9.safetensors', nom: 'Unblur',
    prompt: () => 'The exact same footage, sharp and in focus, with no motion blur and no defocus. Same scene, same motion.' },
  'decompression': { lora: 'ltx/ltx-2.5-22b-ic-lora-decompression-0.9.safetensors', nom: 'Remove Compression',
    prompt: () => 'The exact same footage, clean, with no compression artifacts, no blocking and no banding. Same scene, same motion.' },
  /* The next three follow their model card: a single pass at output resolution (the 2nd pass, guided
     by the source, brings back the grey or erases the water) and a prompt describing the scene,
     written by the vision model from the first frame at render time (`decrit`). */
  'restore': { lora: 'ltx/ltx-2.5-22b-ic-lora-restore-1.0.safetensors', nom: 'Restore', unePasse: true, decrit: true,
    neg: 'logos, signage, lettering, modern vehicles, graffiti, modern buildings, blurry, soft, plastic, smeared detail, oversharpened halos, warped faces',
    prompt: (t, d) => `${d || 'The same scene'}${t ? ` ${t}.` : ''} Natural colour, sharp photographic detail, crisp faces and clothing texture, natural grain, high resolution footage.` },
  'colorize': { lora: 'ltx/ltx-2.5-22b-ic-lora-colorization-0.9.safetensors', nom: 'Colorize', unePasse: true, decrit: true,
    neg: 'blur, distorted face, text, subtitles, logo, watermark, monochrome, sepia, desaturated',
    prompt: (t, d) => `Reference shows ${d ? d.replace(/\.$/, '') : 'the scene'}, in black and white. Edited shows the same scene with natural colors restored. COLORIZE the same scene in vivid natural colors${t ? `: ${t}` : ', with realistic skin tones, true-to-life clothing and surroundings'}. Subject identity, framing, and background geometry are identical to the reference; only color information differs between reference and edited.` },
  // strength 1.25: at 1 the water stays timid; the model card places distortions from 1.5
  'water': { lora: 'ltx/ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors', nom: 'Add Water', unePasse: true, decrit: true, force: 1.25,
    neg: '',
    prompt: (t, d) => `Reference shows ${d ? d.replace(/\.$/, '') : 'the scene'}. Edited shows the same scene with water added. ADD WATER ${t || 'the whole ground is flooded with ankle-deep clear water that ripples and surges, splashing up with white foam around every step and every wheel, the lights reflecting and dancing on its moving surface'}. Subject identity, clothing, framing, and background geometry are identical to the reference; only water-related elements differ between reference and edited.` },
}
/* Generated edit transitions: LTX-2.5 links one shot's last frame to the next shot's first
   (two guides at 0.7 at first and last position), with audio. Effects follow the rule "the
   effect covers the whole frame, the scene changes while it covers, it dissipates on the next
   shot". Edge frames arrive already trimmed and cropped to the edit's aspect (montage.cadresTransition). */
export const EFFETS_TRANSITION = {
  fondu: { nom: 'Morph', chemin: 'The first scene flows and morphs continuously into the second scene in one fluid movement, shapes and colours blending smoothly', camera: 'slow continuous push-in', son: 'a soft airy whoosh' },
  smoke: { nom: 'Smoke', chemin: 'Thick billowing smoke rolls in from the edges and swallows the first scene; the smoke swirls and thins, revealing the second scene as it clears', camera: 'slow push-in through the smoke', son: 'a deep whoosh of rolling smoke' },
  ink: { nom: 'Ink', chemin: 'The first scene dissolves into dense black ink that blooms and spirals through the air like ink in water, then gathers and reforms into the second scene', camera: 'static camera', son: 'a muffled underwater swirl' },
  light: { nom: 'Light burst', chemin: 'A blinding flash of white light bursts from the center of the first scene, rays and lens flares filling the frame, then fading to reveal the second scene', camera: 'static camera', son: 'a bright rising whoosh and a shimmering chime' },
  zoom: { nom: 'Zoom through', chemin: 'The camera rushes forward into the first scene, diving through the frame with streaking motion blur, and emerges inside the second scene', camera: 'fast dolly-in that slows down at the end', son: 'a rushing wind whoosh' },
  whip: { nom: 'Whip pan', chemin: 'The camera whips sideways away from the first scene in a fast blurred pan and lands precisely on the second scene, which comes into sharp focus', camera: 'fast horizontal whip pan with motion blur, settling at the end', son: 'a sharp swish' },
  vent: { nom: 'Wind vortex', chemin: 'Begin on the first scene. Wind enters from outside the frame, wrapping around the scene in a three-dimensional spiral of dense leaves and airborne dust. The vortex expands toward the lens until opaque swirling debris completely covers the entire frame. While coverage remains complete, the scene changes. The same vortex clears to reveal the second scene already fully established. No transparent overlap, dissolve, or late cut', camera: 'locked camera, fixed framing', son: 'a rising howling wind that drops to a calm breeze' },
  eau: { nom: 'Water', chemin: 'The first scene liquefies into clear rushing water that rises as a tall wave, curls through the frame and reshapes itself into the second scene as the water settles', camera: 'static camera', son: 'rushing water and a soft splash' },
  melt: { nom: 'Melt', chemin: 'The first scene softens and melts downward in thick glossy drips, the whole frame liquefying into a swirling pool of color that rises and solidifies into the second scene', camera: 'static camera', son: 'viscous dripping and a low warm hum' },
}
// at the edit's aspect, about 0.9 MP, multiples of 32
const TAILLES_TRANSITION = { '9:16': [704, 1280], '16:9': [1280, 704], '1:1': [960, 960], '4:5': [832, 1024] }
function promptTransition(effet, secondes) {
  const e = EFFETS_TRANSITION[effet]
  // beyond 5 s, the effect is held in a 3 s window in the middle, otherwise it spreads over the whole take
  const lead = (secondes - 3) / 2
  const fenetre = secondes > 5 ? ` For the first ${lead} seconds the opening scene plays on with gentle natural motion. The transition happens between ${lead} and ${lead + 3} seconds. For the last ${lead} seconds the end scene plays on with gentle natural motion and settles on the final frame.` : ''
  return `Use the provided start image as the first frame and the provided end image as the final frame anchor.${fenetre} ${e.chemin}. Camera: ${e.camera}. The sound is ${e.son}. The video ends exactly on the end image.`
}
export function enqueueTransition({ debut, fin, effet, secondes, format, personaId, parentAssetId }) {
  if (!EFFETS_TRANSITION[effet]) throw new Error('effet de transition inconnu')
  for (const f of [debut, fin]) if (!f || /[\\/]/.test(f) || f.startsWith('.') || !fs.existsSync(path.join(CONFIG.comfyInput, f))) throw new Error('image de bord introuvable')
  const s = [3, 5, 8, 10].includes(Number(secondes)) ? Number(secondes) : 5
  const [W, H] = TAILLES_TRANSITION[format] ?? TAILLES_TRANSITION['9:16']
  const id = `trans-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: `transition-${effet}@v1`, workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'transition', videoEngine: 'ltx_transition',
    transitionDebut: debut, transitionFin: fin, transitionEffet: effet, transitionSecondes: s, transitionW: W, transitionH: H,
    parentAssetId: parentAssetId ?? null,
    userPrompt: `transition ${EFFETS_TRANSITION[effet].nom}`, userDirectives: null, composedPositive: promptTransition(effet, s), composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(40_000 + s * 12_000),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}
function grapheTransition(job) {
  const W = job.transitionW, H = job.transitionH, N = job.transitionSecondes * 24 + 1
  const redim = img => ({ class_type: 'ResizeImageMaskNode', inputs: { input: [img, 0], resize_type: 'scale dimensions', 'resize_type.width': W, 'resize_type.height': H, 'resize_type.crop': 'center', scale_method: 'lanczos' } })
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', weight_dtype: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
    imgA: { class_type: 'LoadImage', inputs: { image: job.transitionDebut } },
    imgB: { class_type: 'LoadImage', inputs: { image: job.transitionFin } },
    rA: redim('imgA'), rB: redim('imgB'),
    pA: { class_type: 'LTXVPreprocess', inputs: { img_compression: 18, image: ['rA', 0] } },
    pB: { class_type: 'LTXVPreprocess', inputs: { img_compression: 18, image: ['rB', 0] } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: job.composedPositive, clip: ['clip', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['clip', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: 24 } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: W, height: H, length: N, batch_size: 1 } },
    g0: { class_type: 'LTXVAddGuide', inputs: { frame_idx: 0, strength: 0.7, positive: ['cond', 0], negative: ['cond', 1], vae: ['vae', 0], latent: ['lat', 0], image: ['pA', 0] } },
    g1: { class_type: 'LTXVAddGuide', inputs: { frame_idx: -1, strength: 0.7, positive: ['g0', 0], negative: ['g0', 1], vae: ['vae', 0], latent: ['g0', 2], image: ['pB', 0] } },
    alat: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: N, frame_rate: 24, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['g1', 2], audio_latent: ['alat', 0] } },
    bruit: { class_type: 'RandomNoise', inputs: { noise_seed: Number(job.seed) || 42 } },
    ech: { class_type: 'SamplerEulerAncestral', inputs: { eta: 0, s_noise: 1 } },
    sig: { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    // LoRA trained for transitions between two shots (bench of 11/11, kept by the operator)
    tr: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'ltx/ltx2.3-transition.safetensors', strength_model: 1 } },
    guide: { class_type: 'LTXVDualCFGGuider', inputs: { video_cfg: 1, audio_cfg: 1, model: ['tr', 0], positive: ['g1', 0], negative: ['g1', 1] } },
    k: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['bruit', 0], guider: ['guide', 0], sampler: ['ech', 0], sigmas: ['sig', 0], latent_image: ['av', 0] } },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['k', 1] } },
    rogne: { class_type: 'LTXVCropGuides', inputs: { positive: ['g1', 0], negative: ['g1', 1], latent: ['sep', 0] } },
    dec: { class_type: 'VAEDecodeTiled', inputs: { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16, samples: ['rogne', 2], vae: ['vae', 0] } },
    adec: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['sep', 1], audio_vae: ['avae', 0] } },
    film: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: 24, audio: ['adec', 0], bit_depth: 8 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['film', 0], filename_prefix: `creatoros/${job.id}/transition`, format: 'auto', codec: 'auto' } },
  }
}
async function runTransition(job, t0) {
  const g = grapheTransition(job)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`transition ${EFFETS_TRANSITION[job.transitionEffet]?.nom} : LTX-2.5 première et dernière image (guides 0,7), ${job.transitionSecondes} s ${job.transitionW}×${job.transitionH}, son généré`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- Directed long take (see planlong.js) ----------
   One job per action on a take: render window 1, approve (renders the next one), re-roll,
   rewind to a window, blend. Window previews go to media/ without entering the library;
   only the final blend becomes an asset. */
const PL_LIBELLE = { reroll: 'rendre la fenêtre', approve: 'approuver et rendre la suivante', rewind: 'revenir à la fenêtre', blend: 'fusion finale' }
export function enqueuePlanLong({ id, action, fenetre }) {
  if (!h3Disponible) throw new Error(demoPublique() ? H3_MESSAGE_DEMO : 'MiniMax H3 n’est pas installé sur ce studio : Paramètres > Modèles optionnels')
  if (!planlong.PLAN_LONG.actions.includes(action)) throw new Error('action inconnue')
  const prise = planlong.lirePrise(id)
  if (!prise) throw new Error('prise introuvable')
  if (prise.jobActif) {
    const j = store.getJob(prise.jobActif)
    if (j && !['done', 'failed', 'blocked', 'cancelled'].includes(j.status)) throw new Error('un rendu de cette prise est déjà en cours')
  }
  const n = Math.max(1, Math.min(prise.fenetres, Number(fenetre) || 1))
  const jobId = `planlong-${Date.now().toString(36)}`
  const fusion = action === 'blend'
  const row = {
    id: jobId, createdAt: Date.now(), status: 'queued', personaId: prise.personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'planlong@v1', workflowFile: planlong.PLAN_LONG.recette,
    seed: prise.graine, op: 'planlong', videoEngine: 'minimax',
    planId: prise.id, planAction: action, planFenetre: n, sourceImage: prise.image, parentAssetId: prise.sourceAssetId ?? null,
    userPrompt: `plan long : ${PL_LIBELLE[action]}${action === 'rewind' ? ` ${n}` : ''}`, userDirectives: null,
    composedPositive: prise.prompts.join('\n— fenêtre suivante —\n'), composedNegative: null,
    selections: null, loras: [], videoLoras: [],
    // measured on an RTX 5090: ~100 s per window; the blend runs over the whole clip, then decodes it all
    estimatedMs: fusion ? Math.round(60_000 + prise.fenetres * 45_000) : 105_000,
  }
  store.createJob(row)
  retenirCle(row.id)
  prise.jobActif = jobId; prise.erreur = null
  planlong.ecrirePrise(prise)
  queue.push(row)
  pump()
  return { id: jobId }
}
async function runPlanLong(job, t0) {
  const prise = planlong.lirePrise(job.planId)
  if (!prise) throw new Error('prise introuvable')
  try {
    const g = planlong.graphePlanLong(prise, { action: job.planAction, fenetre: job.planFenetre, jobId: job.id })
    const promptId = await comfy.submitPrompt(g, CLIENT_ID)
    current = { jobId: job.id, promptId }
    store.markStarted(job.id, promptId)
    const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
    const etat = await planlong.etatDirector(prise.id)
    let n = 1
    if (job.planAction === 'blend') {
      n = await harvestJob(job, promptId, history, {
        applied: [`plan long dirigé : ${prise.fenetres} fenêtres de ${planlong.PLAN_LONG.longueur} images (recouvrement ${planlong.PLAN_LONG.recouvrement}), première image réinjectée dans chaque fenêtre, un prompt par fenêtre, fusion sur les 2 derniers pas`],
        skipped: [], finalWorkflow: g,
      })
      prise.final = `a-${job.id}-0`
    } else {
      const sorties = comfy.outputsOf(history)
      if (!sorties.length) throw new Error('exécution terminée mais aucun aperçu en sortie')
      const nom = `${job.id}-apercu${path.extname(sorties[0].filename) || '.mp4'}`
      fs.writeFileSync(path.join(CONFIG.mediaDir, nom), await comfy.readImage(sorties[0]))
      void ensurePoster(nom).catch(() => {})
      const fenetre = Number(etat.pending) || 1
      // windows beyond the one just re-made no longer exist on the Director side
      for (const k of Object.keys(prise.apercus)) if (Number(k) > fenetre) {
        const vieux = path.join(CONFIG.mediaDir, path.basename(String(prise.apercus[k].uri ?? '')))
        if (prise.apercus[k].uri && fs.existsSync(vieux)) fs.rmSync(vieux, { force: true })
        delete prise.apercus[k]
      }
      const avant = prise.apercus[fenetre]
      if (avant?.uri) fs.rmSync(path.join(CONFIG.mediaDir, path.basename(avant.uri)), { force: true })
      prise.apercus[fenetre] = { uri: `/media/${nom}`, job: job.id }
      prise.final = null
    }
    prise.etat = etat
    prise.jobActif = null
    if (etat.all_made) prise.auto = false
    planlong.ecrirePrise(prise)
    store.markFinished(job.id, Date.now() - t0)
    // "run all": keep approving while windows remain to render
    if (prise.auto && !etat.all_made && job.planAction !== 'blend') {
      try { enqueuePlanLong({ id: prise.id, action: 'approve' }) } catch (e) { console.warn(`[plan long] enchaînement arrêté : ${String(e.message || e)}`) }
    }
    return n
  } catch (e) {
    const p = planlong.lirePrise(job.planId)
    if (p) { p.jobActif = null; p.auto = false; p.erreur = String(e.message || e).slice(0, 400); planlong.ecrirePrise(p) }
    throw e
  }
}

export function enqueueEffetLtx({ source, effet, texte, parentAssetId, personaId }) {
  const e = EFFETS_LTX[effet]
  if (!e) throw new Error('effet inconnu')
  const t = String(texte ?? '').trim().slice(0, 200)
  if (t0Hit(t)) throw new Error('texte refusé (liste T0)')
  if (!fs.existsSync(path.join(CONFIG.loraDir ?? path.join(CONFIG.comfyDir, 'models', 'loras'), e.lora)) && !fs.existsSync(path.join(os.homedir(), 'models', 'loras', e.lora)))
    throw new Error(`l’effet ${e.nom} n’est pas installé sur ce studio`)
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const duree = videoDurationOf(path.join(CONFIG.mediaDir, source))
  if (!duree) throw new Error('vidéo illisible')
  const images = Math.max(25, Math.min(121, Math.floor((Math.floor(duree * 24) - 1) / 8) * 8 + 1))
  const id = `effet-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: `effet-${effet}@v1`, workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'effetltx', videoEngine: 'ltx_effet', effetLtx: effet,
    reshootSource: source, reshootAngle: e.nom, reshootCamera: { az: 0, el: 0 }, reshootImages: images,
    parentAssetId: parentAssetId ?? null,
    userPrompt: t || e.nom, userDirectives: null, composedPositive: e.prompt(t), composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(30_000 + images * 1_000),
  }
  store.createJob(row)
  retenirCle(row.id)
  if (e.decrit) descriptionsEffet.set(id, decrireSource(path.join(CONFIG.mediaDir, source), id))
  queue.push(row)
  pump()
  return { id, images }
}
/* Restore, Colorize, Add Water: their prompt describes the scene. The vision model reads it from the first
   frame at enqueue time, in an Ollama block: during the job the GPU is held by the render and vision would run on CPU. */
const descriptionsEffet = new Map()
async function decrireSource(src, id) {
  const img = path.join(CONFIG.mediaDir, '.stage', `${id}_desc.jpg`)
  try {
    fs.mkdirSync(path.dirname(img), { recursive: true })
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=768:-2', img], { timeout: 30_000 })
    return await blocOllama(() => vision.describeScene(img))
  } catch { return null } finally { fs.rmSync(img, { force: true }) }
}

/* Cutout: SAM3 tracks the person, everything else becomes a flat green background, nothing is
   redrawn. MP4 output ready for a keyer; original audio kept. Modest CPU/GPU needs. */
export function enqueueDetour({ source, cible, alpha, parentAssetId, personaId }) {
  const c = String(cible ?? '').trim().slice(0, 80) || 'person'
  if (t0Hit(c)) throw new Error('texte refusé (liste T0)')
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const duree = videoDurationOf(path.join(CONFIG.mediaDir, source))
  if (!duree) throw new Error('vidéo illisible')
  const id = `detour-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'detour@v1', workflowFile: null,
    seed: 1, op: 'detour', videoEngine: 'sam3_detour', reshootSource: source, reshootImages: Math.min(240, Math.floor(duree * 24)), detourAlpha: alpha === true || undefined,
    parentAssetId: parentAssetId ?? null, userPrompt: c, userDirectives: null, composedPositive: `${alpha === true ? 'transparent background' : 'green screen'}: ${c}`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(15_000 + duree * 6_000),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
/* Sharpness: SeedVR2 upscales any clip to a 1080 short side without changing the motion.
   Apache-2.0. Wan refine remains the path for drafts. */
const SEEDVR_COTE = 1080
/** Path of a SeedVR2 source: a studio media file, or "input:<name>" for a clip uploaded by the owner. */
const sourceSeedvr = source => source.startsWith('input:') ? path.join(CONFIG.comfyInput, source.slice(6)) : path.join(CONFIG.mediaDir, source)
export function enqueueSeedvr({ source, parentAssetId, personaId, origineUri }) {
  if (!source || /[\\/]/.test(source) || source.replace(/^input:/, '').startsWith('.')) throw new Error('fichier invalide')
  const src = sourceSeedvr(source), duree = videoDurationOf(src), d = videoSize(src)
  if (!duree) throw new Error('vidéo illisible')
  if (Math.min(d.width, d.height) >= SEEDVR_COTE) throw new Error('ce clip est déjà en 1080p ou plus')
  if (duree > 12) throw new Error('12 s au plus')
  const id = `seedvr-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'seedvr@v1', workflowFile: null,
    seed: 42, op: 'seedvr', videoEngine: 'seedvr2', reshootSource: source, origineUri: origineValide(origineUri),
    parentAssetId: parentAssetId ?? null, userPrompt: null, userDirectives: null, composedPositive: `SeedVR2 ${SEEDVR_COTE}p de ${source}`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(Math.min(d.width, d.height) < 360 ? 60_000 + duree * 60_000 : 60_000 + duree * 30_000),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
/** Useful frame of a letterboxed video (detected over the first 2 seconds), or null. */
function bandesNoires(src) {
  try {
    const sortie = spawnSync('ffmpeg', ['-hide_banner', '-t', '2', '-i', src, '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 }).stderr ?? ''
    const comptes = new Map()
    for (const m of sortie.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) comptes.set(m[0], (comptes.get(m[0]) ?? 0) + 1)
    const meilleur = [...comptes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!meilleur) return null
    const [w, h, x, y] = meilleur.slice(5).split(':').map(Number), d = videoSize(src)
    const aire = (w * h) / (d.width * d.height)
    if (aire > 0.97 || aire < 0.6) return null
    return { width: w - (w % 2), height: h - (h % 2), x, y }
  } catch { return null }
}
async function runSeedvr(job, t0) {
  const src = sourceSeedvr(job.reshootSource)
  let son = false, fps = 24
  try { son = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* no audio */ }
  try {
    const [n, d] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().split('/').map(Number)
    if (n && d) fps = n / d
  } catch { /* 24 by default */ }
  // black bars removed before upscaling, otherwise they get upscaled too
  const cadre = bandesNoires(src)
  // 7B model: natural faces where the 3B makes them waxy; small sources (under 360p) in two passes,
  // since a single x6 jump reconstructs almost nothing
  const d = videoSize(src), petite = Math.min(d.width, d.height) < 360
  const modele = 'seedvr2_ema_7b_fp16.safetensors'
  const reglages = { dit: ['dit', 0], vae: ['vae', 0], seed: 42, batch_size: 33, uniform_batch_size: true, color_correction: 'lab', temporal_overlap: 3, prepend_frames: 0, input_noise_scale: 0, latent_noise_scale: 0, offload_device: 'cpu', enable_debug: false }
  const entree = cadre ? ['cadre', 0] : ['src', 0]
  const g = {
    src: { class_type: 'VHS_LoadVideoPath', inputs: { video: src, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
    ...(cadre ? { cadre: { class_type: 'ImageCrop', inputs: { image: ['src', 0], ...cadre } } } : {}),
    dit: { class_type: 'SeedVR2LoadDiTModel', inputs: { model: modele, device: 'cuda:0', offload_device: 'cpu' } },
    vae: { class_type: 'SeedVR2LoadVAEModel', inputs: { model: 'ema_vae_fp16.safetensors', device: 'cuda:0', decode_tiled: true, decode_tile_size: 1024, decode_tile_overlap: 128, offload_device: 'cpu' } },
    ...(petite
      ? { mi: { class_type: 'SeedVR2VideoUpscaler', inputs: { ...reglages, image: entree, resolution: 540, max_resolution: 960 } },
          up: { class_type: 'SeedVR2VideoUpscaler', inputs: { ...reglages, image: ['mi', 0], resolution: SEEDVR_COTE, max_resolution: 1920 } } }
      : { up: { class_type: 'SeedVR2VideoUpscaler', inputs: { ...reglages, image: entree, resolution: SEEDVR_COTE, max_resolution: 1920 } } }),
    vid: { class_type: 'CreateVideo', inputs: { images: ['up', 0], ...(son ? { audio: ['src', 2] } : {}), fps } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/seedvr`, format: 'auto', codec: 'auto' } },
  }
  await comfy.freeMemory().catch(() => { /* non-fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [petite ? `SeedVR2 7B en deux passes (540 puis ${SEEDVR_COTE})` : `SeedVR2 7B : ${SEEDVR_COTE} de petit côté`, ...(cadre ? ['bandes noires retirées'] : []), 'mouvement conservé'], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Photo HD restoration: SeedVR2 (a restoration model) upscales it, rebuilding fine detail;
   retouching (scratches, color) is done beforehand by a regular edit pass. */
export function enqueueRestaurationHd({ source, parentAssetId, personaId, cote, origineUri }) {
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('image source invalide')
  const id = `rst-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'restauration_hd@v1', workflowFile: null,
    seed: 42, op: 'restauration_hd', origineUri: origineValide(origineUri), sourceImage: source, restaurationCote: Math.min(2560, Math.max(1024, Number(cote) || 2048)),
    parentAssetId: parentAssetId ?? null, userPrompt: 'restauration HD', userDirectives: null, composedPositive: `SeedVR2 restauration de ${source}`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 45_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
async function runRestaurationHd(job, t0) {
  const g = {
    src: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    dit: { class_type: 'SeedVR2LoadDiTModel', inputs: { model: 'seedvr2_ema_3b_fp16.safetensors', device: 'cuda:0', offload_device: 'cpu' } },
    vae: { class_type: 'SeedVR2LoadVAEModel', inputs: { model: 'ema_vae_fp16.safetensors', device: 'cuda:0', decode_tiled: true, decode_tile_size: 1024, decode_tile_overlap: 128, offload_device: 'cpu' } },
    up: { class_type: 'SeedVR2VideoUpscaler', inputs: { image: ['src', 0], dit: ['dit', 0], vae: ['vae', 0], seed: 42, resolution: job.restaurationCote, max_resolution: 4096, batch_size: 1, uniform_batch_size: false, color_correction: 'lab', temporal_overlap: 0, prepend_frames: 0, input_noise_scale: 0, latent_noise_scale: 0, offload_device: 'cpu', enable_debug: false } },
    save: { class_type: 'SaveImage', inputs: { images: ['up', 0], filename_prefix: `creatoros/${job.id}/restauration` } },
  }
  await comfy.freeMemory().catch(() => { /* non-fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [`SeedVR2 3B : restauration à ${job.restaurationCote} px de petit côté`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Stage: a scene described by numbers becomes a grey mockup server-side
   (scripts/stage_clay.py), then a finished shot: LTX-2.5 Layout-to-Render IC-LoRA (Lightricks), same
   graph as Clean-Plate. No file is uploaded, so the visitor upload lock stays closed. */
const STAGE_LORA = 'ltx/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors'
const borne = (v, min, max, nom) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`scène invalide : ${nom}`)
  return n
}
const pointStage = (p, nom) => {
  if (!Array.isArray(p) || p.length !== 3) throw new Error(`scène invalide : ${nom}`)
  return [borne(p[0], -30, 30, nom), borne(p[1], 0.1, 20, nom), borne(p[2], -30, 30, nom)]
}
export function enqueueStage({ scene, prompt, format, secondes, personaId }) {
  const t = String(prompt ?? '').trim().slice(0, 1200)
  if (!t) throw new Error('décris le plan')
  if (t0Hit(t)) throw new Error('prompt refusé (liste T0)')
  if (!Array.isArray(scene?.objets) || scene.objets.length < 1 || scene.objets.length > 16) throw new Error('scène invalide : 1 à 16 objets')
  if (!Array.isArray(scene?.camera) || scene.camera.length < 2 || scene.camera.length > 4) throw new Error('scène invalide : 2 à 4 poses de caméra')
  const objets = scene.objets.map(o => {
    const base = { x: borne(o?.x, -30, 30, 'x'), z: borne(o?.z, -30, 30, 'z'), h: borne(o?.h, 0.1, 12, 'hauteur'), rot: borne(o?.rot ?? 0, -360, 360, 'rotation') }
    if (o?.type === 'modele') {
      const modele = String(o?.modele ?? '')
      const fichier = cheminModele(modele)
      if (!fichier) throw new Error('modèle 3D inconnu')
      return { type: 'modele', ...base, modele, fichier, y: borne(o?.y ?? 0, 0, 12, 'élévation') }
    }
    return o?.type === 'personne' ? { type: 'personne', ...base, h: Math.min(base.h, 2.2) }
      : { type: 'boite', ...base, l: borne(o?.l, 0.1, 30, 'largeur'), p: borne(o?.p, 0.1, 30, 'profondeur') }
  })
  const camera = scene.camera.map(c => ({ t: borne(c?.t, 0, 1, 't'), oeil: pointStage(c?.oeil, 'caméra'), cible: pointStage(c?.cible, 'cible'), fov: borne(c?.fov ?? 40, 20, 90, 'focale') }))
    .sort((a, b) => a.t - b.t)
  const images = Math.floor((Math.min(5, Math.max(2, Number(secondes) || 4)) * 24) / 8) * 8 + 1
  const [largeur, hauteur] = format === '9:16' ? [704, 1280] : format === '1:1' ? [960, 960] : [1280, 704]
  const id = `stage-${Date.now().toString(36)}`
  const dossier = path.join(CONFIG.mediaDir, '.stage')
  fs.mkdirSync(dossier, { recursive: true })
  const json = path.join(dossier, `${id}.json`), maquette = path.join('.stage', `${id}.mp4`)
  fs.writeFileSync(json, JSON.stringify({ largeur, hauteur, images, objets, camera }))
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'stage@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'stage', videoEngine: 'ltx_layout',
    reshootSource: maquette, stageScene: json, reshootAngle: 'stage', reshootCamera: { az: 0, el: 0 }, reshootImages: images,
    parentAssetId: null, userPrompt: t, userDirectives: null, composedPositive: t, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(30_000 + images * 1_100),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id, images }
}

/* 3D dance: the Mixamo dance played by the mannequin in a blocky set, filmed by a following
   camera (scripts/scene_danse.py, Blender); the first frame is repainted with the photo's character
   (Qwen Edit, two images), then LTX-2.5 + Layout-to-Render IC-LoRA turns it into a real video: the set
   moves with the camera, the dancer moves within it. */
/* Dance studios: the mockup is in scripts/scene_danse.py (same id); the phrase is used to repaint the first frame. */
export const STUDIOS_DANSE = {
  salon: { nom: 'Salon', texte: 'a bright apartment living room with white walls, a grey sofa with a low wooden coffee table in front of it, a small side table and a plant, light wooden floor' },
  ruelle: { nom: 'Ruelle hip-hop', texte: 'a narrow urban alley with colourful graffiti on brick walls, dark asphalt ground, a dumpster and wooden crates, completely deserted with nobody else anywhere' },
  opera: { nom: 'Scène d’opéra', texte: 'the stage of an empty opera house, red velvet curtains, golden balcony boxes, a polished wooden stage floor, warm spotlights' },
  toit: { nom: 'Toit au coucher du soleil', texte: 'a rooftop terrace at sunset with a low concrete parapet, a water tank and the city skyline behind, warm golden light, completely deserted with nobody else anywhere' },
  concert: { nom: 'Scène de concert', texte: 'an empty concert stage with lighting trusses, black speaker stacks, a big glowing LED screen behind and colourful stage lights' },
  tokyo: { nom: 'Rue de Tokyo', texte: 'a short dead-end Tokyo side street late at night, closed at the end by a building facade, with glowing neon signs in pink and blue, small shop fronts already closed and wet asphalt reflecting the lights, completely deserted' },
  paris: { nom: 'Rue de Paris', texte: 'a Parisian street with cream Haussmann building facades, wrought-iron balconies, a green bench and a classic street lamp, cobblestones, completely deserted with nobody else anywhere' },
  parking: { nom: 'Parking Tokyo drift', texte: 'a Tokyo-drift style underground car park at night, concrete pillars, tyre marks on the floor, purple and blue neon underglow, and a row of tuned Japanese street-racing cars parked behind her: a Honda NSX, a Toyota Supra, a BMW M3, a Nissan Skyline GT-R R34, a Nissan GT-R R35 and a Lamborghini with a Japanese-style widebody kit' },
  cabaret: { nom: 'Cabaret', texte: 'the small raised stage of an empty cabaret, with a polished warm wooden stage floor and a red velvet curtain behind her, no microphone; below the front edge of the stage, in the empty audience with nobody in it, little round tables with lamps' },
  bal: { nom: 'Salle de bal', texte: 'an empty grand ballroom with marble columns, a polished parquet floor, tall windows and a crystal chandelier' },
  loft: { nom: 'Loft industriel', texte: 'a spacious industrial loft with an exposed brick wall, tall black-framed windows, a concrete floor and a leather armchair' },
  'studio-danse': { nom: 'Studio de danse', texte: 'a bright dance studio with a light wooden floor, a ballet barre along the white back wall and large windows, no mirror' },
  sport: { nom: 'Salle de sport', texte: 'a modern gym with a rubber floor, weight benches and racks along the back wall and a wall ladder' },
  cuisine: { nom: 'Cuisine', texte: 'a warm modern kitchen with light oak wood lower cabinets, white upper cabinets, a long counter along the back wall, a tall stainless fridge, a few green plants and, behind her, in front of the back counter, one plain rectangular kitchen island with light oak wood fronts without handles and a thick white quartz top, nothing on it and no stools; nothing stands between her and the camera' },
  plage: { nom: 'Plage', texte: 'a sunny sandy beach with turquoise sea behind, a large white and grey-blue striped parasol on a wooden pole and a wooden deck chair, completely deserted with nobody else anywhere' },
  jardin: { nom: 'Jardin', texte: 'a green garden lawn with a trimmed hedge behind and two leafy trees, soft daylight, completely deserted with nobody else anywhere' },
  basket: { nom: 'Terrain de basket', texte: 'an outdoor street basketball court with a hoop behind, painted court lines and a chain-link fence, completely deserted with nobody else anywhere' },
  desert: { nom: 'Route du désert', texte: 'a straight desert road with red mesas on the horizon, dry sand on both sides and a road sign, golden light, completely deserted with nobody else anywhere' },
  metro: { nom: 'Quai de métro', texte: 'an empty metro platform with white tiled walls, the tracks behind the platform edge and benches, no train, no people' },
  hotel: { nom: 'Hall d’hôtel', texte: 'the lobby of a luxury hotel with marble columns, a reception desk, velvet armchairs and a large chandelier' },
}
export function enqueueDanse3d({ fbx, still, decor, scene: description, personaId, suivi, stageForce, secondes, debut, sansSwap }) {
  if (!fbx || !fs.existsSync(fbx)) throw new Error('danse inconnue')
  if (!still || /[\\/]/.test(still) || !fs.existsSync(path.join(CONFIG.comfyInput, still))) throw new Error('photo du personnage introuvable')
  const d = String(description ?? '').trim().slice(0, 400)
  if (t0Hit(d)) throw new Error('texte refusé (liste T0)')
  const id = `danse3d-${Date.now().toString(36)}`
  fs.mkdirSync(path.join(CONFIG.mediaDir, '.stage'), { recursive: true })
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'danse3d@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'danse3d', videoEngine: 'ltx_layout',
    reshootSource: path.join('.stage', `${id}.mp4`), danseFbx: fbx, danseStill: still, danseSuivi: suivi === true ? true : undefined, danseDecor: STUDIOS_DANSE[decor] ? decor : 'salon', stageForce: Number.isFinite(stageForce) ? stageForce : undefined,
    reshootAngle: 'danse 3d', reshootCamera: { az: 0, el: 0 },
    /* Duration (owner option): 5 s by default; LTX needs 8k+1 frames at 24 fps. "debut": the dance
       starts from its first frame instead of the arms-down frame picked by the scene (to align with a source). */
    reshootImages: Number.isFinite(secondes) ? Math.floor(Math.min(21, Math.max(5, secondes)) * 24 / 8) * 8 + 1 : 121,
    danseDebut: debut === true || undefined,
    // owner option: no chained Swap (the LTX video alone)
    danseSansSwap: sansSwap === true || undefined,
    parentAssetId: null, userPrompt: d || 'a woman dancing', userDirectives: null,
    composedPositive: `A real video of the woman dancing with energy and a big smile${d ? `, ${d}` : ''}. Real smartphone footage, natural light, the camera follows her. She is the only person in the place: nobody else appears at any moment, no passers-by, no people in the background, not even tiny figures far away.`,
    composedNegative: null, selections: null, loras: [], videoLoras: [], estimatedMs: 200_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}

const executer = promisify(execFile)
const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const pythonComfy = () => (fs.existsSync(CONFIG.comfyPython) ? CONFIG.comfyPython : 'python3')
const rendreClay = (json, sortie) => executer(pythonComfy(), [path.join(SCRIPTS, 'stage_clay.py'), json, sortie], { timeout: 180_000 })

/* Stage models: a studio 3D object (media/<job>.glb) or a .glb imported by the
   owner (media/.stage/imp_*.glb). The client only gives a name, never a path. */
export function cheminModele(nom) {
  const n = path.basename(String(nom))
  if (n !== nom || !/^[\w.-]+\.glb$/.test(n)) return null
  const f = /^imp_/.test(n) ? path.join(CONFIG.mediaDir, '.stage', n) : path.join(CONFIG.mediaDir, n)
  return fs.existsSync(f) ? f : null
}

/* 3D object: a photo becomes a GLB with TRELLIS.2 (Microsoft, MIT), ComfyUI core
   nodes. SAM3 isolates the named object (BiRefNet has no kernel for recent GPUs). The GLB stays next to the media;
   the library receives a full turntable as a grey mockup. */
export function enqueueObjet3d({ sourceFile, cible, parentAssetId, personaId }) {
  const c = String(cible ?? '').trim().slice(0, 80) || 'main object'
  if (t0Hit(c)) throw new Error('texte refusé (liste T0)')
  const id = `objet3d-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'objet3d@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffff), op: 'objet3d', videoEngine: 'trellis2', sourceImage: sourceFile,
    parentAssetId: parentAssetId ?? null, userPrompt: c, userDirectives: null, composedPositive: `objet 3D : ${c}`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 75_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
function grapheObjet3d(job) {
  const s = Number(job.seed) || 42
  const ech = (pas, cfg, ordo, model, pos, neg, latent) => ({ class_type: 'KSampler', inputs: { seed: s, steps: pas, cfg, sampler_name: 'euler', scheduler: ordo, denoise: 1, model, positive: pos, negative: neg, latent_image: latent } })
  return {
    src: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    txt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: job.userPrompt } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['src', 0], model: ['sam3', 0], detection_threshold: 0.3, max_objects: 1, detect_interval: 1, conditioning: ['txt', 0] } },
    masque: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '0' } },
    crop: { class_type: 'ImageCropToMask', inputs: { images: ['src', 0], masks: ['masque', 0], width: 1024, height: 1024, pad_factor: 1.1, grow_mask: 0, background: '#000000' } },
    cv: { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'dino_v3_vit_l.safetensors' } },
    cond: { class_type: 'Trellis2Conditioning', inputs: { clip_vision_model: ['cv', 0], image: ['crop', 0] } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'trellis_2_int8_convrot.safetensors', weight_dtype: 'default' } },
    vs: { class_type: 'VAELoader', inputs: { vae_name: 'trellis_2_shape_vae_bf16.safetensors' } },
    vt: { class_type: 'VAELoader', inputs: { vae_name: 'trellis_2_texture_vae_bf16.safetensors' } },
    o1: { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1, start_percent: 0.667, end_percent: 1 } },
    r1: { class_type: 'RescaleCFG', inputs: { model: ['o1', 0], multiplier: 0.7 } },
    ms: { class_type: 'ModelSamplingSD3', inputs: { model: ['r1', 0], shift: 5 } },
    o2: { class_type: 'CFGOverride', inputs: { model: ['unet', 0], cfg: 1, start_percent: 0.769, end_percent: 1 } },
    r2: { class_type: 'RescaleCFG', inputs: { model: ['o2', 0], multiplier: 0.5 } },
    e0: { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } },
    k0: ech(12, 7.5, 'normal', ['ms', 0], ['cond', 0], ['cond', 1], ['e0', 0]),
    vox: { class_type: 'VaeDecodeStructureTrellis2', inputs: { samples: ['k0', 0], vae: ['vs', 0], resolution: '32' } },
    sh: { class_type: 'Trellis2ShapeStage', inputs: { positive: ['cond', 0], negative: ['cond', 1], voxel: ['vox', 0] } },
    k1: ech(20, 7.5, 'normal', ['r2', 0], ['sh', 0], ['sh', 1], ['sh', 2]),
    up: { class_type: 'Trellis2UpsampleStage', inputs: { positive: ['sh', 0], negative: ['sh', 1], shape_latent: ['k1', 0], vae: ['vs', 0], target_resolution: 1024 } },
    k2: ech(12, 7.5, 'simple', ['r2', 0], ['up', 0], ['up', 1], ['up', 2]),
    dm: { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['k2', 0], vae: ['vs', 0] } },
    tx: { class_type: 'Trellis2TextureStage', inputs: { positive: ['up', 0], negative: ['up', 1], shape_latent: ['k2', 0] } },
    k3: ech(12, 1, 'normal', ['unet', 0], ['tx', 0], ['tx', 1], ['tx', 2]),
    dt: { class_type: 'VaeDecodeTextureTrellis', inputs: { samples: ['k3', 0], vae: ['vt', 0], shape_subdivides: ['dm', 1] } },
    dec: { class_type: 'DecimateMesh', inputs: { mesh: ['dm', 0], target_face_count: 200000, placement_mode: 'midpoint' } },
    sm: { class_type: 'MeshSmoothNormals', inputs: { mesh: ['dec', 0], crease_angle: 180 } },
    // real baked texture: vertex-painted colors come out blotchy
    uw: { class_type: 'UnwrapMesh', inputs: { mesh: ['sm', 0], segmenter: 'pec', resolution: 2048, padding: 1, weld_distance: 0.0002 } },
    bk: { class_type: 'BakeTextureFromVoxel', inputs: { mesh: ['uw', 0], voxel_colors: ['dt', 0], reference_mesh: ['dm', 0], texture_size: 2048 } },
    ap: { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['uw', 0], base_color: ['bk', 0], metallic: ['bk', 1], roughness: ['bk', 2] } },
    save: { class_type: 'SaveGLB', inputs: { mesh: ['ap', 0], filename_prefix: `creatoros/${job.id}/objet` } },
  }
}
/** ComfyUI's GLB embeds the graph and its paths in asset.extras: strip it before serving. */
function glbPropre(b) {
  const lj = b.readUInt32LE(12)
  const js = JSON.parse(b.subarray(20, 20 + lj).toString('utf8'))
  if (js.asset) delete js.asset.extras
  let txt = JSON.stringify(js); while (Buffer.byteLength(txt) % 4) txt += ' '
  const tete = Buffer.alloc(20), jb = Buffer.from(txt), reste = b.subarray(20 + lj)
  tete.writeUInt32LE(0x46546C67, 0); tete.writeUInt32LE(2, 4); tete.writeUInt32LE(20 + jb.length + reste.length, 8)
  tete.writeUInt32LE(jb.length, 12); tete.writeUInt32LE(0x4E4F534A, 16)
  return Buffer.concat([tete, jb, reste])
}
async function runObjet3d(job, t0) {
  const g = grapheObjet3d(job)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { timeoutMs: 20 * 60_000, onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const f = Object.values(history.outputs ?? {}).flatMap(o => o['3d'] ?? []).find(x => x.filename?.endsWith('.glb'))
  if (!f) throw new Error('modèle 3D non produit')
  const glb = path.join(CONFIG.mediaDir, `${job.id}.glb`)
  fs.writeFileSync(glb, glbPropre(fs.readFileSync(path.join(CONFIG.comfyOutput, f.subfolder ?? '', f.filename))))
  // a full turntable as a grey mockup for the library
  const dossier = path.join(CONFIG.comfyOutput, 'creatoros', job.id)
  fs.mkdirSync(dossier, { recursive: true })
  const json = path.join(dossier, 'tour.json'), mp4 = path.join(dossier, 'tour.mp4')
  const camera = Array.from({ length: 13 }, (_, i) => { const a = i / 12 * 2 * Math.PI; return { t: i / 12, oeil: [3.4 * Math.sin(a), 1.3, 3.4 * Math.cos(a)], cible: [0, 0.75, 0], fov: 32 } })
  fs.writeFileSync(json, JSON.stringify({ largeur: 720, hauteur: 720, images: 97, objets: [{ type: 'modele', fichier: glb, x: 0, z: 0, h: 1.5 }], camera, lineaire: true }))
  // textured turntable (Blender, the GLB as output, colors included); grey mockup as fallback
  let texture = true
  try { await executer(path.join(os.homedir(), 'apps', 'blender', 'blender'), ['-b', '-P', path.join(SCRIPTS, 'tour_texture.py'), '--', glb, mp4, '97', '720'], { timeout: 600_000 }) }
  catch (e) { texture = false; console.warn(`[job ${job.id}] tour texturé impossible, maquette grise — ${String(e.message || e).slice(0, 200)}`); await rendreClay(json, mp4) }
  history.outputs.tour = { images: [{ filename: 'tour.mp4', subfolder: `creatoros/${job.id}`, type: 'output' }] }
  const n = await harvestJob(job, promptId, history, { applied: [`objet 3D : SAM3 isole « ${job.userPrompt} », TRELLIS.2 construit le GLB, tour ${texture ? 'texturé (Blender EEVEE)' : 'en maquette grise'}`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Character training (see entrainement.js): FLUX.2 Klein LoRA added to the character. */
export function enqueueEntrainement({ personaId, images, declencheur, pas, essai, moteur = 'klein', legendes = null }) {
  if (!aiToolkitPret(moteur)) throw new Error(moteur === 'flux3' ? 'ai-toolkit pour FLUX 3 introuvable : installe-le dans ~/ai-toolkit-flux3, ou indique son dossier dans CREATOROS_AI_TOOLKIT_FLUX3' : 'ai-toolkit introuvable : installe-le, ou indique son dossier dans CREATOROS_AI_TOOLKIT')
  if (!moteurEntrainementPret(moteur)) throw new Error(`entraînement ${MOTEURS_ENTRAINEMENT[moteur]?.nom ?? moteur} indisponible sur ce studio`)
  if (images.length < (essai ? 1 : 8)) throw new Error('choisis au moins 8 images du personnage')
  const d = String(declencheur ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  if (d.length < 3) throw new Error('mot déclencheur : 3 à 16 lettres ou chiffres')
  const id = `train-${Date.now().toString(36)}`
  const n = Math.min(3000, Math.max(essai ? 10 : 600, Number(pas) || 1500))
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId, register: 'sfw', mode: 'photo', purpose: 'creative', recipeId: 'entrainement@v1', workflowFile: null,
    seed: 1, op: 'entrainement', sourceImage: null, entrainementImages: images.slice(0, 30), entrainementDeclencheur: d, entrainementPas: n, entrainementEssai: !!essai, entrainementMoteur: moteur, entrainementLegendes: Array.isArray(legendes) ? legendes.slice(0, 30).map(x => String(x ?? '').slice(0, 600)) : null,
    parentAssetId: null, userPrompt: `LoRA ${MOTEURS_ENTRAINEMENT[moteur].nom} · ${d} · ${n} steps · ${Math.min(30, images.length)} images`, userDirectives: null, composedPositive: null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: dureeEstimeeMs(moteur, n),
  }
  store.createJob(row); queue.push(row); pump()
  return { id }
}
/** Progress of running trainings (steps done / planned), for the character screen. */
export const avancementEntrainements = new Map()
async function runEntrainement(job, t0) {
  store.markStarted(job.id, null)
  current = { jobId: job.id, promptId: null }
  await comfy.freeMemory().catch(() => {})
  const moteur = job.entrainementMoteur ?? 'klein'
  const prep = preparerEntrainement({ id: job.id, images: job.entrainementImages, declencheur: job.entrainementDeclencheur, pas: job.entrainementPas, moteur, legendes: job.entrainementLegendes ?? null })
  let dernier = 0
  avancementEntrainements.set(job.id, { pas: 0, total: job.entrainementPas, debut: Date.now() })
  const lora = await entrainer({ ...prep, id: job.id, pas: job.entrainementPas }, n => {
    avancementEntrainements.set(job.id, { pas: n, total: job.entrainementPas, debut: avancementEntrainements.get(job.id)?.debut ?? Date.now() })
    if (n - dernier >= 25) { dernier = n; console.log(`[job ${job.id}] entraînement ${moteur} ${n}/${job.entrainementPas}`) }
  }).finally(() => avancementEntrainements.delete(job.id))
  const nom = `${String(job.personaId).replace(/[^a-z0-9_]/g, '')}_${moteur}_${job.id.slice(6)}.safetensors`
  fs.copyFileSync(lora, path.join(CONFIG.lorasDir, nom))
  if (!job.entrainementEssai) {
    const p = persona(job.personaId)
    const champ = moteur === 'krea' ? 'loras' : moteur === 'flux3' ? 'lorasFlux3' : 'lorasKlein'
    enregistrerPersona({ [champ]: [...(p[champ] ?? []).filter(l => l.name !== nom), { name: nom, strength: 1 }], ...(p.trigger ? {} : { trigger: job.entrainementDeclencheur }) }, job.personaId)
  }
  console.log(`[job ${job.id}] LoRA ${nom} prête${job.entrainementEssai ? ' (essai, non attachée)' : ', ajoutée au personnage'}`)
  store.markFinished(job.id, Date.now() - t0)
  return 0
}

/* Dubbing: InfiniteTalk (Wan 2.1, Apache-2.0), ComfyUI core nodes. The clip is re-encoded
   and partially denoised: scene and motion stay, lips follow the new voice.
   81 frames at 25 fps, i.e. 3.2 s per pass: a longer clip is dubbed over its first 3.2 seconds. */
export function enqueueDoublage({ source, audio, texte, parentAssetId, personaId }) {
  const cle = Date.now().toString(36)
  const video = `DUB_${cle}${path.extname(source) || '.mp4'}`, son = `DUB_${cle}${path.extname(audio) || '.wav'}`
  fs.copyFileSync(source, path.join(CONFIG.comfyInput, video))
  fs.copyFileSync(audio, path.join(CONFIG.comfyInput, son))
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', source], { encoding: 'utf8' }).trim().split(',').map(Number)
  const id = `dub-${cle}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'doublage@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffff), op: 'doublage', videoEngine: 'infinitetalk', sourceImage: null,
    reshootSource: video, doublageAudio: son, doublageFormat: w >= h ? [832, 480] : [480, 832],
    parentAssetId: parentAssetId ?? null, userPrompt: String(texte ?? '').slice(0, 300) || 'doublage', userDirectives: null,
    composedPositive: 'a person talking naturally, lips perfectly synchronised with the speech, same face, same scene, same light', composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 150_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
function grapheDoublage(job) {
  const [w, h] = job.doublageFormat
  return {
    src: { class_type: 'VHS_LoadVideo', inputs: { video: job.reshootSource, force_rate: 25, custom_width: w, custom_height: h, frame_load_cap: 81, skip_first_frames: 0, select_every_nth: 1 } },
    premiere: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: 0, length: 1 } },
    son: { class_type: 'LoadAudio', inputs: { audio: job.doublageAudio } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_i2v_480p_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength_model: 1 } },
    patch: { class_type: 'ModelPatchLoader', inputs: { name: 'wan2.1_infiniteTalk_single_fp16.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp16.safetensors', type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    cv: { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'clip_vision_h.safetensors' } },
    cve: { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['cv', 0], image: ['premiere', 0], crop: 'none' } },
    ae: { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: 'wav2vec2-chinese-base_fp16.safetensors' } },
    aee: { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: ['ae', 0], audio: ['son', 0] } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: job.composedPositive } },
    neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
    it: { class_type: 'WanInfiniteTalkToVideo', inputs: { mode: 'single_speaker', model: ['lora', 0], model_patch: ['patch', 0], positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0],
      width: w, height: h, length: 81, audio_encoder_output_1: ['aee', 0], motion_frame_count: 9, audio_scale: 1, clip_vision_output: ['cve', 0], start_image: ['premiere', 0] } },
    enc: { class_type: 'VAEEncode', inputs: { pixels: ['src', 0], vae: ['vae', 0] } },
    bruit: { class_type: 'RandomNoise', inputs: { noise_seed: Number(job.seed) || 42 } },
    guide: { class_type: 'CFGGuider', inputs: { model: ['it', 0], positive: ['it', 1], negative: ['it', 2], cfg: 1 } },
    ech: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sig: { class_type: 'BasicScheduler', inputs: { model: ['it', 0], scheduler: 'normal', steps: 6, denoise: 0.7 } },
    sca: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['bruit', 0], guider: ['guide', 0], sampler: ['ech', 0], sigmas: ['sig', 0], latent_image: ['enc', 0] } },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['sca', 0], vae: ['vae', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], audio: ['son', 0], fps: 25 } },
    out: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/doublage`, format: 'auto', codec: 'auto' } },
  }
}
async function runDoublage(job, t0) {
  const g = grapheDoublage(job)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { timeoutMs: 20 * 60_000, onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: ['doublage : InfiniteTalk (Wan 2.1) sur le clip réencodé, débruitage 0,7, 81 images à 25 i/s'], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Reruns a specialized render (dubbing, reframe, 3D, re-shoot...) with its original settings,
   if its input files still exist. Regular photo and video renders go through enqueue. */
export const OPS_RELANCABLES = new Set(['transition', 'effetltx', 'inpaint', 'restauration_hd', 'inpaint_video', 'cleanplate', 'detour', 'doublage', 'musique', 'objet3d', 'parole', 'reshoot', 'seedvr', 'stage', 'interpolate', 'foley', 'essayage', 'photodump', 'style_ref', 'recadrage', 'transparent', 'profondeur', 'extension'])
export function relancerSpecial(p) {
  if (!OPS_RELANCABLES.has(p.op)) throw new Error('ce rendu ne se relance pas ainsi')
  const fichiers = [p.inpaintVideo, p.inpaintMask, p.reshootSource, p.sourceImage, p.doublageAudio, p.paroleAudio, p.finitionSource, p.finitionGuide, p.recadrage?.ctrl, p.recadrage?.masque, p.refImage].filter(Boolean)
  for (const f of fichiers) {
    const ici = [path.join(CONFIG.comfyInput, f), path.join(CONFIG.mediaDir, f), path.join(CONFIG.comfyInput, path.basename(f))]
    if (!ici.some(x => fs.existsSync(x))) throw new Error(`fichier d'entrée disparu : ${path.basename(f)}`)
  }
  if (p.recadrage?.source && !fs.existsSync(p.recadrage.source)) throw new Error('clip d’origine disparu')
  const prefixe = String(p.id ?? p.op).split('-')[0].replace(/[^a-z0-9]/gi, '') || p.op
  const graine = Number.isFinite(p.seed) ? p.seed : Number.isFinite(p.seed?.value) ? p.seed.value : Math.floor(Math.random() * 0xffffffffffff)
  const row = { ...p, id: `${prefixe}-${Date.now().toString(36)}`, createdAt: Date.now(), status: 'queued', error: null, seed: graine }
  if (p.extensionGraphe) row.extensionGraphe = JSON.parse(JSON.stringify(p.extensionGraphe).replaceAll(`creatoros/${p.id}/`, `creatoros/${row.id}/`))
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id: row.id }
}

/* Extension: a ComfyUI workflow provided by an extension (see extensions.js), already filled and
   checked. Its output is an image, a video or a sound; sounds go to the audio library. */
export function enqueueExtension({ graphe, sortie, nom, extensionId, personaId, parentAssetId, prompt }) {
  const id = `ext-${Date.now().toString(36)}`
  for (const n of Object.values(graphe)) {
    if (/^Save/.test(n.class_type) && 'filename_prefix' in (n.inputs ?? {})) n.inputs.filename_prefix = `creatoros/${id}/ext`
  }
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: sortie === 'video' ? 'video' : sortie === 'audio' ? 'audio' : 'photo', purpose: 'creative', recipeId: `extension:${extensionId}`, workflowFile: null,
    seed: null, op: 'extension', videoEngine: null, extensionGraphe: graphe, extensionSortie: sortie, extensionNom: nom,
    parentAssetId: parentAssetId ?? null, userPrompt: prompt || nom, userDirectives: null, composedPositive: prompt || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: sortie === 'video' ? 4 * 60_000 : 60_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
async function runExtension(job, t0) {
  const g = job.extensionGraphe
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { timeoutMs: 30 * 60_000, onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  if (job.extensionSortie === 'audio') {
    const f = Object.values(history.outputs ?? {}).flatMap(o => o.audio ?? [])[0]
    if (!f) throw new Error('extension : aucun son en sortie')
    fs.mkdirSync(MUSIQUES_DIR, { recursive: true })
    const racine = String(job.extensionNom).normalize('NFD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'extension'
    await executer('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(CONFIG.comfyOutput, f.subfolder ?? '', f.filename), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'libmp3lame', '-q:a', '2',
      path.join(MUSIQUES_DIR, `${racine}_${job.id.slice(-6)}.mp3`)])
    store.markFinished(job.id, Date.now() - t0)
    return 1
  }
  const n = await harvestJob(job, promptId, history, { applied: [`extension « ${job.extensionNom} »`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Music and sound effects: ACE-Step 1.5 turbo (MIT), ComfyUI core nodes. The track
   goes to the music folder used by editing and reels. */
/* Explicit track settings, all optional: when empty, the studio infers them from the style
   (profilMusique) and lyrics (langueParoles). Allowlists = the choices of the
   TextEncodeAceStepAudio1.5 node. */
const NOTES_MUSIQUE = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']
const TONALITES_MUSIQUE = new Set(NOTES_MUSIQUE.flatMap(n => [`${n} major`, `${n} minor`]))
const MESURES_MUSIQUE = new Set(['2', '3', '4', '6'])
const LANGUES_MUSIQUE = new Set(['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'])
/* Singing voice type -> label added to the ACE-Step tags; "none" makes the track instrumental. */
const VOIX_CHANTEES = { female: 'female vocals', male: 'male vocals', duet: 'male and female duet vocals', choir: 'choir vocals', none: 'instrumental, no vocals' }
const BPM_MIN = 40, BPM_MAX = 220

/** Validates a track's optional settings; an empty field stays null (automatic behavior). */
function reglagesMusique({ bpm, tonalite, mesure, langue, voix, instruments }) {
  const vide = v => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === 'auto'
  const r = { bpm: null, tonalite: null, mesure: null, langue: null, voix: null, instruments: [] }
  if (!vide(bpm)) {
    const n = Math.round(Number(bpm))
    if (!Number.isFinite(n)) throw new Error('tempo invalide')
    r.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, n))
  }
  if (!vide(tonalite)) {
    // short notation accepted ("Dm", "F#", "Bbm"), so the UI avoids the word "minor", which the content filter rejects
    const court = /^([A-Ga-g][#b]?)(m?)$/.exec(String(tonalite).trim())
    const k = court ? `${court[1][0].toUpperCase()}${court[1].slice(1)} ${court[2] ? 'minor' : 'major'}`
      : String(tonalite).trim().replace(/\s+/g, ' ').replace(/^([a-g])/, c => c.toUpperCase()).replace(/ (Major|Minor)$/i, m => m.toLowerCase())
    if (!TONALITES_MUSIQUE.has(k)) throw new Error('tonalité inconnue')
    r.tonalite = k
  }
  if (!vide(mesure)) {
    const m = String(mesure).trim().replace(/\/\d+$/, '')
    if (!MESURES_MUSIQUE.has(m)) throw new Error('mesure inconnue')
    r.mesure = m
  }
  if (!vide(langue)) {
    const l = String(langue).trim().toLowerCase()
    if (!LANGUES_MUSIQUE.has(l)) throw new Error('langue inconnue')
    r.langue = l
  }
  if (!vide(voix)) {
    const v = String(voix).trim().toLowerCase()
    if (!Object.hasOwn(VOIX_CHANTEES, v)) throw new Error('type de voix inconnu')
    r.voix = v
  }
  const liste = Array.isArray(instruments) ? instruments : String(instruments ?? '').split(',')
  r.instruments = [...new Set(liste.map(x => String(x ?? '').replace(/[^\p{L}\p{N} '&+#./-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
  return r
}

export function enqueueMusique({ prompt, paroles, secondes, genre, personaId, bpm, tonalite, mesure, langue, voix, instruments }) {
  const bruit = genre === 'bruitage'
  const texte = String(prompt ?? '').trim().slice(0, 400)
  // a sound effect only has its description: no lyrics, voice or musical settings
  const reglages = bruit ? reglagesMusique({}) : reglagesMusique({ bpm, tonalite, mesure, langue, voix, instruments })
  const mots = bruit || reglages.voix === 'none' ? '' : String(paroles ?? '').trim().slice(0, 3000)
  if (!texte && !reglages.instruments.length) throw new Error(bruit ? 'décris le son' : 'décris le morceau')
  if (t0Hit(`${texte} ${reglages.instruments.join(' ')} ${mots}`)) throw new Error('prompt refusé (liste T0)')
  const duree = Math.round(Math.min(bruit ? 20 : 120, Math.max(bruit ? 2 : 5, Number(secondes) || (bruit ? 6 : 30))))
  const id = `musique-${Date.now().toString(36)}`
  const style = texte || reglages.instruments.join(', ')
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'audio', purpose: 'creative', recipeId: 'musique@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffff), op: 'musique', videoEngine: null, musiqueSecondes: duree, musiqueParoles: mots, musiqueBruitage: bruit,
    musiqueBpm: reglages.bpm, musiqueTonalite: reglages.tonalite, musiqueMesure: reglages.mesure, musiqueLangue: reglages.langue,
    musiqueVoix: reglages.voix, musiqueInstruments: reglages.instruments,
    parentAssetId: null, userPrompt: style, userDirectives: null, composedPositive: tagsMusique({ userPrompt: style, musiqueBruitage: bruit, musiqueVoix: reglages.voix, musiqueInstruments: reglages.instruments }), composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round((12_000 + duree * 500) * PRISES_MUSIQUE),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
/** ACE-Step tags: the style, then instruments, then the singing voice type. */
function tagsMusique(job) {
  if (job.musiqueBruitage) return `sound effect, foley, no music, no vocals, ${job.userPrompt}`
  const instr = (job.musiqueInstruments ?? []).filter(x => !String(job.userPrompt).toLowerCase().includes(String(x).toLowerCase()))
  return [job.userPrompt, ...instr, job.musiqueVoix ? VOIX_CHANTEES[job.musiqueVoix] : null].filter(Boolean).join(', ')
}
/* Track tempo and key from the described style: the first recognized genre gives its tempo
   and a common key for the genre; a tempo written in the prompt ("128 bpm") wins. */
const PROFILS_MUSIQUE = [
  [/drum ?(and|&|n) ?bass|\bdnb\b|jungle/, 174, 'D minor'],
  [/\btrap\b|drill/, 140, 'C minor'],
  [/dubstep/, 140, 'F minor'],
  [/techno/, 130, 'A minor'],
  [/house|\bedm\b|electro|trance|club|dance/, 124, 'F minor'],
  [/punk|metal/, 160, 'E minor'],
  [/disco|nu.?disco/, 118, 'A minor'],
  [/funk/, 108, 'E minor'],
  [/reggaeton|dembow|latin/, 95, 'A minor'],
  [/afrobeat|amapiano/, 110, 'G minor'],
  [/lo.?fi|chill.?hop|study beat/, 80, 'A minor'],
  [/hip.?hop|\brap\b|boom.?bap/, 90, 'A minor'],
  [/r ?& ?b|\brnb\b|soul|neo.?soul/, 85, 'Eb major'],
  [/jazz|swing|bossa/, 120, 'Bb major'],
  [/reggae|dub\b/, 75, 'G major'],
  [/country|folk|acoustic|guitare/, 100, 'G major'],
  [/ambient|cinematic|orchestral|piano|classique|classical|lullaby|berceuse|calme|calm/, 70, 'D major'],
  [/rock|indie|grunge/, 122, 'E minor'],
  [/pop|k.?pop|j.?pop|synthwave|retrowave/, 116, 'C major'],
]
function profilMusique(style) {
  const t = String(style ?? '').toLowerCase()
  const trouve = PROFILS_MUSIQUE.find(([re]) => re.test(t))
  const ecrit = /(\d{2,3})\s*bpm/.exec(t)
  const bpm = ecrit ? Math.min(220, Math.max(50, Number(ecrit[1]))) : trouve?.[1] ?? 110
  return { bpm, keyscale: trouve?.[2] ?? 'E minor' }
}

/* Sung language, detected from the most frequent function words in the lyrics (English by default). */
const MOTS_LANGUE = {
  fr: /\b(je|tu|nous|vous|les|des|est|une|pas|que|qui|dans|pour|avec|mon|ton|toi|moi|et)\b/g,
  es: /\b(yo|tú|que|los|las|una|por|con|para|mi|tu|es|el|la|y|corazón|amor)\b/g,
  it: /\b(io|che|non|il|lo|gli|una|per|con|sono|mio|amore|cuore|e)\b/g,
  de: /\b(ich|du|wir|und|nicht|die|der|das|ist|ein|eine|mit|mein|dein)\b/g,
  pt: /\b(eu|você|não|que|uma|com|para|meu|minha|coração|é|o|a)\b/g,
  en: /\b(i|you|the|and|is|my|your|me|we|in|on|love|it|to)\b/g,
}
function langueParoles(paroles) {
  const t = String(paroles ?? '').toLowerCase().replace(/\[[^\]]*\]/g, ' ')
  if (/[぀-ヿ]/.test(t)) return 'ja'
  if (/[가-힯]/.test(t)) return 'ko'
  if (/[一-鿿]/.test(t)) return 'zh'
  if (/[Ѐ-ӿ]/.test(t)) return 'ru'
  let meilleure = 'en', max = 0
  for (const [l, re] of Object.entries(MOTS_LANGUE)) {
    const n = (t.match(re) ?? []).length
    if (n > max) { max = n; meilleure = l }
  }
  return meilleure
}

/* Untagged lyrics are structured for ACE-Step: stanzas separated by a blank line alternate
   [Verse] / [Chorus] (the 2nd is the chorus, repeated after the 2nd verse); a single block
   is split into 4-line stanzas. Already tagged lyrics are kept as is. */
function structurerParoles(paroles) {
  const t = String(paroles ?? '').trim()
  if (!t || /^\s*\[/m.test(t)) return t || '[instrumental]'
  let strophes = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)
  if (strophes.length === 1) {
    const lignes = t.split('\n').map(x => x.trim()).filter(Boolean)
    strophes = []
    for (let i = 0; i < lignes.length; i += 4) strophes.push(lignes.slice(i, i + 4).join('\n'))
  }
  if (strophes.length === 1) return `[Verse]\n${strophes[0]}`
  const refrain = strophes[1]
  const sortie = strophes.map((x, k) => `${k % 2 ? '[Chorus]' : '[Verse]'}\n${x}`)
  if (strophes.length === 3) sortie.push(`[Chorus]\n${refrain}`)
  return sortie.join('\n\n')
}

const PRISES_MUSIQUE = 2   // two takes per request (different seeds): the operator keeps the best

async function runMusique(job, t0) {
  const d = job.musiqueSecondes, s = Number(job.seed) || 42
  const tags = tagsMusique(job)
  // an explicit setting wins; otherwise tempo and key come from the style, language from the lyrics
  const auto = profilMusique(job.userPrompt)
  const bpm = job.musiqueBpm ?? auto.bpm, keyscale = job.musiqueTonalite ?? auto.keyscale, timesignature = job.musiqueMesure ?? '4'
  const lyrics = job.musiqueBruitage || job.musiqueVoix === 'none' ? '[instrumental]' : structurerParoles(job.musiqueParoles)
  const language = lyrics === '[instrumental]' ? 'en' : job.musiqueLangue ?? langueParoles(job.musiqueParoles)
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_xl_turbo_bf16.safetensors', weight_dtype: 'default' } },
    ms: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['unet', 0], shift: 3 } },
    clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_4b_ace15.safetensors', type: 'ace', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
    lat: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: d, batch_size: 1 } },
  }
  // sound effect: Stable Audio 3 small sfx (lcm 8 steps cfg 1) on the raw description; music: ACE-Step 1.5 XL turbo
  if (job.musiqueBruitage) {
    for (const k of Object.keys(g)) delete g[k]
    Object.assign(g, {
      ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable_audio_3_small_sfx.safetensors' } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: 't5gemma_b_b_ul2.safetensors', type: 'stable_audio', device: 'default' } },
      pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: job.userPrompt } },
      neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: '' } },
      lat: { class_type: 'EmptyLatentAudio', inputs: { seconds: d, batch_size: 1 } },
    })
    for (let p = 0; p < PRISES_MUSIQUE; p++) {
      const sp = (s + p * 7919) % 0xffffffff
      g[`k${p}`] = { class_type: 'KSampler', inputs: { model: ['ckpt', 0], seed: sp, steps: 8, cfg: 1, sampler_name: 'lcm', scheduler: 'simple', positive: ['pos', 0], negative: ['neg', 0], latent_image: ['lat', 0], denoise: 1 } }
      g[`dec${p}`] = { class_type: 'VAEDecodeAudio', inputs: { samples: [`k${p}`, 0], vae: ['ckpt', 2] } }
      g[`save${p}`] = { class_type: 'SaveAudioMP3', inputs: { audio: [`dec${p}`, 0], filename_prefix: `creatoros/${job.id}/musique_p${p + 1}`, quality: 'V0' } }
    }
  }
  // one branch per take: each has its own seed, hence its own audio codes
  for (let p = 0; p < PRISES_MUSIQUE && !job.musiqueBruitage; p++) {
    const sp = (s + p * 7919) % 0xffffffff
    g[`txt${p}`] = { class_type: 'TextEncodeAceStepAudio1.5', inputs: { clip: ['clip', 0], tags, lyrics, seed: sp, bpm, duration: d, timesignature, language, keyscale, generate_audio_codes: true, cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0 } }
    g[`neg${p}`] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [`txt${p}`, 0] } }
    g[`k${p}`] = { class_type: 'KSampler', inputs: { seed: sp, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['ms', 0], positive: [`txt${p}`, 0], negative: [`neg${p}`, 0], latent_image: ['lat', 0] } }
    g[`dec${p}`] = { class_type: 'VAEDecodeAudio', inputs: { samples: [`k${p}`, 0], vae: ['vae', 0] } }
    g[`save${p}`] = { class_type: 'SaveAudioMP3', inputs: { audio: [`dec${p}`, 0], filename_prefix: `creatoros/${job.id}/musique_p${p + 1}`, quality: 'V0' } }
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const sorties = Array.from({ length: PRISES_MUSIQUE }, (_, p) => (history.outputs?.[`save${p}`]?.audio ?? [])[0]).filter(Boolean)
  if (!sorties.length) throw new Error('aucun son en sortie')
  const racine = job.userPrompt.normalize('NFD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'musique'
  fs.mkdirSync(MUSIQUES_DIR, { recursive: true })
  // ACE-Step outputs at 0 dB: level brought down to background music level, without clipping.
  // The first take keeps the name expected by reels (..._<id>.mp3), later ones get _2, _3...
  for (const [p, f] of sorties.entries()) {
    const nom = `${racine}_${job.id.slice(-6)}${p ? `_${p + 1}` : ''}.mp3`
    await executer('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(CONFIG.comfyOutput, f.subfolder ?? '', f.filename), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'libmp3lame', '-q:a', '2', path.join(MUSIQUES_DIR, nom)], { timeout: 60_000 })
  }
  store.markFinished(job.id, Date.now() - t0)
  return 1
}

/* Object painted into a clip: the painted area is tracked by SAM3, the object from the reference
   photo is cut out and pasted frame by frame, then the Wan retouch blends it into the scene. */
async function preparerObjet(job) {
  const dossier = `creatoros/${job.id}`
  const g = {
    src: { class_type: 'VHS_LoadVideo', inputs: { video: job.inpaintVideo, force_rate: 16, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 } },
    peint: { class_type: 'LoadImage', inputs: { image: job.inpaintMask } },
    zone: { class_type: 'ImageToMask', inputs: { image: ['peint', 0], channel: 'red' } },
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['src', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 1, detect_interval: 1, initial_mask: ['zone', 0] } },
    m0: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '0' } },
    mi: { class_type: 'MaskToImage', inputs: { mask: job.inpaintSuivi ? ['m0', 0] : ['zone', 0] } },
    mv: { class_type: 'VHS_VideoCombine', inputs: { images: ['mi', 0], frame_rate: 16, loop_count: 0, filename_prefix: `${dossier}/zone`, format: 'video/h264-mp4', pix_fmt: 'yuv420p', crf: 10, save_metadata: false, trim_to_audio: false, pingpong: false, save_output: true } },
    ref: { class_type: 'LoadImage', inputs: { image: job.inpaintObjet } },
    t2: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: job.inpaintObjetNom } },
    trk2: { class_type: 'SAM3_VideoTrack', inputs: { images: ['ref', 0], model: ['sam3', 0], detection_threshold: 0.3, max_objects: 1, detect_interval: 1, conditioning: ['t2', 0] } },
    m1: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk2', 0], object_indices: '0' } },
    inv: { class_type: 'InvertMask', inputs: { mask: ['m1', 0] } },
    png: { class_type: 'JoinImageWithAlpha', inputs: { image: ['ref', 0], alpha: ['inv', 0] } },
    sv: { class_type: 'SaveImage', inputs: { images: ['png', 0], filename_prefix: `${dossier}/objet` } },
  }
  if (job.inpaintLoin) Object.assign(g, {
    gt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: 'person' } },
    gtrk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['src', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 6, detect_interval: 1, conditioning: ['gt', 0] } },
    gm: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['gtrk', 0], object_indices: '' } },
    gmi: { class_type: 'MaskToImage', inputs: { mask: ['gm', 0] } },
    gmv: { class_type: 'VHS_VideoCombine', inputs: { images: ['gmi', 0], frame_rate: 16, loop_count: 0, filename_prefix: `${dossier}/personnes`, format: 'video/h264-mp4', pix_fmt: 'yuv420p', crf: 12, save_metadata: false, pingpong: false, save_output: true } },
  })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  const h = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const fichier = (cle, champ) => { const o = h.outputs?.[cle]?.[champ]?.find(x => /\.(mp4|png)$/.test(x.filename)); if (!o) throw new Error('objet : zone ou détourage non produit'); return path.join(CONFIG.comfyOutput, o.subfolder ?? '', o.filename) }
  const colle = `OBJ_${job.id}.mp4`
  await executer(pythonComfy(), [path.join(SCRIPTS, 'coller_objet.py'), path.join(CONFIG.comfyInput, job.inpaintVideo), fichier('mv', 'gifs'), fichier('sv', 'images'), path.join(CONFIG.comfyInput, colle), '16', ...(job.inpaintLoin ? [fichier('gmv', 'gifs')] : [])], { timeout: 300_000 })
  job.inpaintVideo = colle
}

const sujetDetour = v => { const x = String(v ?? '').toLowerCase().replace(/[^a-z \-]/g, '').trim().slice(0, 40); return x || 'person' }
/* Transparent background: SAM3 gives the mask of the person (or the named object), the photo is
   output as PNG with alpha, nothing is redrawn. BiRefNet has no kernel for recent GPUs ("no kernel image"). */
export function enqueueTransparent({ sourceFile, parentAssetId, personaId, sujet }) {
  const id = `transp-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'transparent@v1', workflowFile: null,
    seed: 1, op: 'transparent', sourceImage: sourceFile, parentAssetId: parentAssetId ?? null,
    // what SAM3 keeps: a person by default, or the named object ("perfume bottle")
    detourSujet: sujetDetour(sujet),
    userPrompt: 'transparent background', userDirectives: null, composedPositive: null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 8000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
/* Depth map: Depth Anything V2 on the photo, in greyscale (near = bright), at the
   photo's resolution; used for compositing, relief and ControlNet. */
export function enqueueProfondeur({ sourceFile, parentAssetId, personaId }) {
  const id = `depth-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'profondeur@v1', workflowFile: null,
    seed: 1, op: 'profondeur', sourceImage: sourceFile, parentAssetId: parentAssetId ?? null,
    userPrompt: 'depth map', userDirectives: null, composedPositive: null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 8000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
async function runProfondeur(job, t0) {
  const taille = videoSize(path.join(CONFIG.comfyInput, job.sourceImage))
  const res = Math.min(2048, Math.max(512, Math.round(Math.max(taille?.width ?? 1024, taille?.height ?? 1024) / 64) * 64))
  const g = {
    src: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    depth: { class_type: 'DepthAnythingV2Preprocessor', inputs: { image: ['src', 0], ckpt_name: 'depth_anything_v2_vitl.pth', resolution: res } },
    save: { class_type: 'SaveImage', inputs: { images: ['depth', 0], filename_prefix: `creatoros/${job.id}/depth` } },
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [`carte de profondeur : Depth Anything V2, ${res} px`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  if (!n) throw new Error('la carte de profondeur n’a rendu aucune image')
}
/* ---------- Klein with references: try-on, photodump ----------
   TRY-ON (`essayage`): the person in the photo wears the garment from a second photo
   (garment alone, flat or on a hanger). FLUX Klein receives both images as references
   (ReferenceMultiLatent); the output keeps the person photo's framing.
   PHOTODUMP (`photodump`): four everyday photos of the same person from a single photo
   (street, café, waterside, mirror selfie), in 2:3. */
const KLEIN_REF = { unet: 'flux3-image-klein-int8-convrot.safetensors', clip: 'qwen3vl_4b_int8_convrot.safetensors', vae: 'flux2-vae.safetensors' }
const PHOTODUMP_SCENES = [
  'full body, walking across a sunlit city street at golden hour, candid mid-stride, shop fronts and trees behind',
  'half body, at a small café table with a coffee, laughing naturally, soft window light',
  'seen from the side, leaning on a railing by the water at dusk, warm city lights in the background',
  'mirror selfie in a hotel room with tall windows, phone in hand, relaxed smile, warm lamp light',
]
const lettre = (texte, n = 400) => String(texte ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function enqueueEssayage({ personne, vetement, parentAssetId, personaId, consigne }) {
  const id = `essai-${Date.now().toString(36)}`
  const texte = `Dress the person from <ref_image_0> in the garment shown in <ref_image_1>. Keep the same face, hair, body, pose, framing, background and lighting. The garment keeps its exact colour, fabric, cut, buttons and details, and fits naturally.${consigne ? ` ${lettre(consigne)}` : ''}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'essayage@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'essayage', sourceImage: personne, refImage: vetement,
    parentAssetId: parentAssetId ?? null, userPrompt: consigne ?? null, userDirectives: null, kleinTexte: texte,
    composedPositive: consigne ? `essayage du vêtement : ${lettre(consigne)}` : 'essayage du vêtement', composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 25000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
export function enqueuePhotodump({ personne, parentAssetId, personaId, theme }) {
  const id = `dump-${Date.now().toString(36)}`
  const lieu = lettre(theme, 160)
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'photodump@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'photodump', sourceImage: personne,
    parentAssetId: parentAssetId ?? null, userPrompt: lieu || null, userDirectives: null,
    composedPositive: `photodump : 4 scènes${lieu ? ` (${lieu})` : ''}`, composedNegative: null, photodumpTheme: lieu || null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 60000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
async function runKleinRef(job, t0) {
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: KLEIN_REF.unet, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: KLEIN_REF.clip, type: 'flux3', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: KLEIN_REF.vae } },
    p: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
  }
  const seed = Number(job.seed) || 42
  const scene = (k, texte, latent) => {
    g[`${k}t`] = { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: texte } }
    g[`${k}z`] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [`${k}t`, 0] } }
    g[`${k}r`] = { class_type: 'ReferenceMultiLatent', inputs: { positive: [`${k}t`, 0], negative: [`${k}z`, 0], vae: ['vae', 0], resolution: 'resize',
      'resolution.megapixels': 1.0, 'images.image0': ['p', 0], ...(job.refImage ? { 'images.image1': ['v', 0] } : {}) } }
    g[`${k}k`] = { class_type: 'KSampler', inputs: { model: ['unet', 0], positive: [`${k}r`, 0], negative: [`${k}r`, 1], latent_image: latent ?? [`${k}r`, 2],
      seed: seed + Number(k.slice(1) || 0), steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }
    g[`${k}d`] = { class_type: 'VAEDecode', inputs: { samples: [`${k}k`, 0], vae: ['vae', 0] } }
    return [`${k}d`, 0]
  }
  let sortie
  if (job.op === 'essayage') {
    g.v = { class_type: 'LoadImage', inputs: { image: job.refImage } }
    sortie = scene('e0', job.kleinTexte ?? job.composedPositive)
  } else {
    g.taille = { class_type: 'EmptyFlux2LatentImage', inputs: { width: 832, height: 1248, batch_size: 1 } }
    const lieu = job.photodumpTheme ? `, ${job.photodumpTheme}` : ''
    const images = PHOTODUMP_SCENES.map((sc, i) => scene(`s${i}`, `The same person as in <ref_image_0>, ${sc}${lieu}. Same face, hair, body and outfit as in <ref_image_0>. Candid smartphone photo, natural light, realistic skin, no text.`, ['taille', 0]))
    sortie = images.reduce((a, b, i) => { g[`b${i}`] = { class_type: 'ImageBatch', inputs: { image1: a, image2: b } }; return [`b${i}`, 0] })
  }
  g.save = { class_type: 'SaveImage', inputs: { images: sortie, filename_prefix: `creatoros/${job.id}/${job.op}` } }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [job.op === 'essayage' ? `essayage FLUX Klein (2 références) : « ${job.kleinTexte ?? job.composedPositive} »` : `photodump FLUX Klein : ${PHOTODUMP_SCENES.length} scènes de la même personne`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  if (!n) throw new Error('aucune image rendue')
}

/* ---------- style reference: Krea 2 Turbo + style-reference LoRA ----------
   The chosen photo only provides the STYLE (line, palette, texture); the scene comes from the text. */
const FORMATS_STYLE_REF = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024], '4:5': [896, 1120] }
export function enqueueStyleRef({ reference, texte, format, parentAssetId, personaId }) {
  const scene = lettre(texte, 600)
  if (!scene) throw new Error('décris ce qu’il faut peindre')
  const [w, h] = FORMATS_STYLE_REF[format] ?? FORMATS_STYLE_REF['16:9']
  const id = `sref-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'style-reference@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'style_ref', sourceImage: reference, width: w, height: h,
    parentAssetId: parentAssetId ?? null, userPrompt: scene, userDirectives: null, composedPositive: scene, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 15000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
async function runStyleRef(job, t0) {
  const W = job.width, H = job.height
  const g = {
    ref: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: '_krea2/krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'krea2_style_reference.safetensors', strength_model: 1 } },
    ms: { class_type: 'ModelSamplingFlux', inputs: { model: ['lora', 0], width: W, height: H, max_shift: 1.15, base_shift: 0.5 } },
    enc: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['clip', 0], vae: ['vae', 0], image1: ['ref', 0], prompt: job.composedPositive } },
    meth: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['enc', 0], reference_latents_method: 'index_timestep_zero' } },
    zero: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['meth', 0] } },
    gd: { class_type: 'CFGGuider', inputs: { model: ['ms', 0], positive: ['meth', 0], negative: ['zero', 0], cfg: 1 } },
    smp: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    sch: { class_type: 'BasicScheduler', inputs: { model: ['ms', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
    lat: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: Number(job.seed) || 42 } },
    k: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['gd', 0], sampler: ['smp', 0], sigmas: ['sch', 0], latent_image: ['lat', 0] } },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: `creatoros/${job.id}/style-ref` } },
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [`référence de style : Krea 2 Turbo + LoRA style-reference, ${W}×${H}`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  if (!n) throw new Error('aucune image rendue')
}
async function runTransparent(job, t0) {
  const g = {
    src: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    txt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: job.detourSujet ?? 'person' } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['src', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 1, detect_interval: 1, conditioning: ['txt', 0] } },
    masque: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '0' } },
    inv: { class_type: 'InvertMask', inputs: { mask: ['masque', 0] } },
    png: { class_type: 'JoinImageWithAlpha', inputs: { image: ['src', 0], alpha: ['inv', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['png', 0], filename_prefix: `creatoros/${job.id}/transparent` } },
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: ['fond transparent : SAM3, PNG avec alpha, rien de redessiné'], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}
async function runDetour(job, t0) {
  const src = path.join(CONFIG.mediaDir, job.reshootSource), d = videoSize(src)
  const W = (d.width || 720) & ~1, H = (d.height || 1280) & ~1, N = job.reshootImages
  let son = false
  try { son = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* no audio */ }
  const g = {
    src: { class_type: 'VHS_LoadVideoPath', inputs: { video: src, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    txt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: job.userPrompt } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['src', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 1, detect_interval: 1, conditioning: ['txt', 0] } },
    m0: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '0' } },
    vert: { class_type: 'EmptyImage', inputs: { width: W, height: H, batch_size: N, color: 0x00d639 } },
    comp: { class_type: 'ImageCompositeMasked', inputs: { destination: ['vert', 0], source: ['src', 0], x: 0, y: 0, resize_source: false, mask: ['m0', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['comp', 0], ...(son ? { audio: ['src', 2] } : {}), fps: 24 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/detour`, format: 'auto', codec: 'auto' } },
  }
  /* Transparent background: same tracking, WebM VP9 output with alpha, playable in a browser and OBS. */
  if (job.detourAlpha) {
    delete g.vert; delete g.comp; delete g.vid; delete g.save
    g.inv = { class_type: 'InvertMask', inputs: { mask: ['m0', 0] } }
    g.rgba = { class_type: 'JoinImageWithAlpha', inputs: { image: ['src', 0], alpha: ['inv', 0] } }
    g.save = { class_type: 'VHS_VideoCombine', inputs: { images: ['rgba', 0], ...(son ? { audio: ['src', 2] } : {}), frame_rate: 24, loop_count: 0, filename_prefix: `creatoros/${job.id}/alpha`, format: 'video/webm', pix_fmt: 'yuva420p', crf: 24, save_metadata: false, trim_to_audio: false, pingpong: false, save_output: true } }
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  // VHS stores its videos under `gifs`; harvesting only reads `images`
  if (job.detourAlpha) for (const o of Object.values(history.outputs ?? {})) if (o.gifs) o.images = o.gifs.filter(f => /\.webm$/i.test(f.filename))
  const n = await harvestJob(job, promptId, history, { applied: [`détourage : SAM3 suit « ${job.userPrompt} », ${job.detourAlpha ? 'WebM avec alpha' : 'fond vert'}, ${N} images ${W}×${H}`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* 3D scene of a clip for the Re-shoot view: MoGe-2 on the first frame, textured mesh
   (MoGePointMapToMesh) as GLB, at the same half size as the warp, so angles set with the
   mouse land on the geometry the node will see. Cached per clip. ComfyUI's GLB embeds the
   graph (including absolute paths) in asset.extras: it is stripped before serving. */
const scenesEnCours = new Map()
/** The 3D scene graph: MoGe-2 on the first frame, textured mesh, GLB. */
export function grapheScene(src, W, H, prefixe) {
  return {
    src: { class_type: 'VHS_LoadVideoPath', inputs: { video: src, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 1, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
    img: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
    m: { class_type: 'LoadMoGeModel', inputs: { model_name: 'moge_2_vitl_normal_fp16.safetensors' } },
    geo: { class_type: 'MoGeInference', inputs: { moge_model: ['m', 0], image: ['img', 0], resolution_level: 6, fov_x_degrees: 0, batch_size: 1, force_projection: true, apply_mask: true, refine_steps: 0 } },
    mesh: { class_type: 'MoGePointMapToMesh', inputs: { moge_geometry: ['geo', 0], batch_index: 0, decimation: 1, discontinuity_threshold: 0.04, texture: true } },
    save: { class_type: 'SaveGLB', inputs: { mesh: ['mesh', 0], filename_prefix: prefixe } },
  }
}

export function sceneReshoot(source) {
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const dir = path.join(CONFIG.dataDir, 'reshoot_scenes'), dest = path.join(dir, `${source}.glb`)
  if (fs.existsSync(dest)) return Promise.resolve(dest)
  if (scenesEnCours.has(source)) return scenesEnCours.get(source)
  const p = (async () => {
    const src = path.join(CONFIG.mediaDir, source)
    const d = videoSize(src)
    let W = 352, H = 640
    if (d.width && d.height) { if (d.width > d.height * 1.15) { W = 640; H = 352 } else if (d.width * 1.15 >= d.height) { W = 480; H = 480 } }
    const g = grapheScene(src, W, H, `creatoros/scene_${source.replace(/\.[^.]+$/, '')}`)
    const promptId = await comfy.submitPrompt(g, CLIENT_ID)
    const h = await comfy.waitForPrompt(promptId, { timeoutMs: 10 * 60_000 })
    const f = Object.values(h?.outputs ?? {}).flatMap(o => o['3d'] ?? []).find(x => x.filename?.endsWith('.glb'))
    if (!f) throw new Error('scène 3D non produite')
    const brut = path.join(CONFIG.comfyOutput, f.subfolder ?? '', f.filename)
    const b = fs.readFileSync(brut)
    const lj = b.readUInt32LE(12)
    const js = JSON.parse(b.subarray(20, 20 + lj).toString('utf8'))
    if (js.asset) delete js.asset.extras
    let txt = JSON.stringify(js); while (Buffer.byteLength(txt) % 4) txt += ' '
    const jb = Buffer.from(txt), reste = b.subarray(20 + lj)
    const tete = Buffer.alloc(20)
    tete.writeUInt32LE(0x46546c67, 0); tete.writeUInt32LE(2, 4); tete.writeUInt32LE(20 + jb.length + reste.length, 8)
    tete.writeUInt32LE(jb.length, 12); tete.writeUInt32LE(0x4e4f534a, 16)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dest, Buffer.concat([tete, jb, reste]))
    fs.rmSync(brut, { force: true })
    return dest
  })()
  scenesEnCours.set(source, p)
  p.finally(() => scenesEnCours.delete(source)).catch(() => {})
  return p
}

export function grapheReshoot(job, W, H, sonSource) {
  const N = job.reshootImages, w2 = W / 2, h2 = H / 2, cam = job.reshootCamera
  const cles = cam.cles?.map(k => ({ f: k.f < 0 ? N : k.f, az: k.az, el: k.el, dist: 1.0 }))
  const S1 = '1.000000, 0.997500, 0.995000, 0.992500, 0.990000, 0.987500, 0.985000, 0.982500, 0.980000, 0.977500, 0.975000, 0.948750, 0.922500, 0.872500, 0.798750, 0.725000, 0.603750, 0.482500, 0.337500, 0.168750, 0.000000'
  const S2 = '0.850000, 0.803125, 0.756250, 0.687113, 0.573450, 0.459787, 0.316425, 0.158212, 0.000000'
  const seed = Number(job.seed) || 42
  const g = {
    src: { class_type: 'VHS_LoadVideoPath', inputs: { video: path.join(CONFIG.mediaDir, job.reshootSource), force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
    full: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
    half: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: w2, height: h2, crop: 'center' } },
    mogem: { class_type: 'LoadMoGeModel', inputs: { model_name: 'moge_2_vitl_normal_fp16.safetensors' } },
    moge: { class_type: 'MoGeInference', inputs: { moge_model: ['mogem', 0], image: ['half', 0], resolution_level: 6, fov_x_degrees: 0, batch_size: 4, force_projection: true, apply_mask: true, refine_steps: 0 } },
    warp: { class_type: 'CrossViewWarp', inputs: { frames: ['half', 0], moge_geometry: ['moge', 0], azimuth: cam.az ?? 30, elevation: cam.el ?? 0, distance: 1.0, hfov: 0,
      vertical_shift: 0, depth_ratio: 6.0, smooth_depth: false, invert_depth: false, roll_lock: false, pivot_override: false, pivot_x: 0, pivot_y: 0, pivot_z: 1.05,
      use_keyframes: !!cles, frame_count: 0, keyframes: cles ? JSON.stringify(cles) : '', interp_motion: 'ease_in_out', interpolation: 'linear', keep_source_aim: true, preview_size: 384, frame_index: 1 } },
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', weight_dtype: 'default' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: RESHOOT_LORA, strength_model: 1.3 } },
    icp: { class_type: 'GetICLoRAParameters', inputs: { iclora_model: ['lora', 0] } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: `crossview. ${job.composedPositive ?? ''}`.trim(), clip: ['clip', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: 'text, subtitles, logo, watermark, magenta, pink holes, distorted face', clip: ['clip', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: 24 } },
    lat1: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w2, height: h2, length: N, batch_size: 1 } },
    g1: { class_type: 'LTXVAddGuide', inputs: { positive: ['cond', 0], negative: ['cond', 1], vae: ['vae', 0], latent: ['lat1', 0], image: ['warp', 0], frame_idx: 0, strength: 1, iclora_parameters: ['icp', 0] } },
    g2: { class_type: 'LTXVAddGuide', inputs: { positive: ['g1', 0], negative: ['g1', 1], vae: ['vae', 0], latent: ['g1', 2], image: ['half', 0], frame_idx: 0, strength: 1, iclora_parameters: ['icp', 0] } },
    alat: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: N, frame_rate: 24, batch_size: 1, audio_vae: ['avae', 0] } },
    av1: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['g2', 2], audio_latent: ['alat', 0] } },
    gd1: { class_type: 'LTXVDualCFGGuider', inputs: { model: ['lora', 0], positive: ['g2', 0], negative: ['g2', 1], video_cfg: 1, audio_cfg: 1 } },
    smp: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sg1: { class_type: 'ManualSigmas', inputs: { sigmas: S1 } },
    n1: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    k1: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['n1', 0], guider: ['gd1', 0], sampler: ['smp', 0], sigmas: ['sg1', 0], latent_image: ['av1', 0] } },
    sep1: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['k1', 0] } },
    crop1: { class_type: 'LTXVCropGuides', inputs: { positive: ['g2', 0], negative: ['g2', 1], latent: ['sep1', 0] } },
    upm: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors' } },
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['crop1', 2], upscale_model: ['upm', 0], vae: ['vae', 0] } },
    g3: { class_type: 'LTXVAddGuide', inputs: { positive: ['crop1', 0], negative: ['crop1', 1], vae: ['vae', 0], latent: ['up', 0], image: ['full', 0], frame_idx: 0, strength: 1, iclora_parameters: ['icp', 0] } },
    av2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['g3', 2], audio_latent: ['sep1', 1] } },
    gd2: { class_type: 'LTXVDualCFGGuider', inputs: { model: ['lora', 0], positive: ['g3', 0], negative: ['g3', 1], video_cfg: 1, audio_cfg: 1 } },
    sg2: { class_type: 'ManualSigmas', inputs: { sigmas: S2 } },
    n2: { class_type: 'RandomNoise', inputs: { noise_seed: seed + 1 } },
    k2: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['n2', 0], guider: ['gd2', 0], sampler: ['smp', 0], sigmas: ['sg2', 0], latent_image: ['av2', 0] } },
    sep2: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['k2', 0] } },
    crop2: { class_type: 'LTXVCropGuides', inputs: { positive: ['g3', 0], negative: ['g3', 1], latent: ['sep2', 0] } },
    dec: { class_type: 'VAEDecodeTiled', inputs: { samples: ['crop2', 2], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    adec: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['sep2', 1], audio_vae: ['avae', 0] } },
    // same moment: the original take's audio when it has one
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], audio: sonSource ? ['src', 2] : ['adec', 0], fps: 24 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/reshoot`, format: 'auto', codec: 'auto' } },
  }
  if (job.op === 'stage' || job.op === 'danse3d') {
    // the grey mockup is the only guide: no geometry or shifted view
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    // staging IC-LoRA strength: 1 by default; higher (owner option) makes LTX follow the mannequin more closely
    Object.assign(g.lora.inputs, { lora_name: STAGE_LORA, strength_model: Number.isFinite(job.stageForce) ? Math.min(2, Math.max(0.5, job.stageForce)) : 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = 'grey clay, mannequin, blocks, untextured, text, subtitles, logo, watermark, distorted face'
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/stage`
    // the style image, set as a keyframe on both passes: the model takes its look from this first frame
    g.look = { class_type: 'LoadImage', inputs: { image: job.stageLook } }
    g.lookw2 = { class_type: 'ImageScale', inputs: { image: ['look', 0], upscale_method: 'lanczos', width: w2, height: h2, crop: 'center' } }
    g.lookw = { class_type: 'ImageScale', inputs: { image: ['look', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } }
    g.gl1 = { class_type: 'LTXVAddGuide', inputs: { positive: ['g2', 0], negative: ['g2', 1], vae: ['vae', 0], latent: ['g2', 2], image: ['lookw2', 0], frame_idx: 0, strength: 1 } }
    g.av1.inputs.video_latent = ['gl1', 2]
    Object.assign(g.gd1.inputs, { positive: ['gl1', 0], negative: ['gl1', 1] })
    Object.assign(g.crop1.inputs, { positive: ['gl1', 0], negative: ['gl1', 1] })
    g.gl2 = { class_type: 'LTXVAddGuide', inputs: { positive: ['g3', 0], negative: ['g3', 1], vae: ['vae', 0], latent: ['g3', 2], image: ['lookw', 0], frame_idx: 0, strength: 1 } }
    g.av2.inputs.video_latent = ['gl2', 2]
    Object.assign(g.gd2.inputs, { positive: ['gl2', 0], negative: ['gl2', 1] })
    Object.assign(g.crop2.inputs, { positive: ['gl2', 0], negative: ['gl2', 1] })
  }
  if (job.op === 'effetltx' && EFFETS_LTX[job.effetLtx]) {
    // an effect: the clip as sole guide, like clean plate, with the effect's LoRA
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    const e = EFFETS_LTX[job.effetLtx]
    Object.assign(g.lora.inputs, { lora_name: e.lora, strength_model: e.force ?? 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = e.neg ?? 'blur, distorted face, text, subtitles, logo, watermark'
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/effet`
    if (e.unePasse) {
      // single pass at output size: the source guides the whole denoise, nothing redraws it afterwards
      Object.assign(g.lat1.inputs, { width: W, height: H })
      g.g2.inputs.image = ['full', 0]
      g.dec.inputs.samples = ['crop1', 2]
      g.adec.inputs.samples = ['sep1', 1]
      for (const k of ['half', 'upm', 'up', 'g3', 'av2', 'gd2', 'sg2', 'n2', 'k2', 'sep2', 'crop2']) delete g[k]
    }
  }
  if (job.op === 'cleanplate') {
    // clean plate: no geometry or shifted view, the clip as sole guide (scale factor 1)
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    Object.assign(g.lora.inputs, { lora_name: CLEANPLATE_LORA, strength_model: 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = `${job.userPrompt ?? 'people'}, person, figure, silhouette, ghost, blur, text, subtitles, logo, watermark`
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/cleanplate`
  }
  return g
}

/* Stage's first frame: Qwen Edit paints the mockup, in the same place, with the same framing. */
async function peindreLook(job) {
  // the mockup is rendered here: with 3D models it takes several seconds
  await rendreClay(job.stageScene, path.join(CONFIG.mediaDir, job.reshootSource))
  const clay = `STAGE_${job.id}.png`
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(CONFIG.mediaDir, job.reshootSource), '-frames:v', '1', path.join(CONFIG.comfyInput, clay)], { timeout: 30_000 })
  const g = comfy.loadWorkflow(EDIT_WORKFLOW)
  g['10'].inputs.image = clay
  delete g['12']
  for (const n of ['30', '31']) for (const [k, v] of Object.entries(g[n].inputs)) if (Array.isArray(v) && v[0] === '12') g[n].inputs[k] = ['10', 0]
  g['32'].inputs.pixels = ['10', 0]
  g['30'].inputs.prompt = `Turn this grey 3D blocking into a finished photograph. Keep the exact camera, framing and the position and size of every shape. Each grey block becomes a real object or person of the scene, with real materials and light. Scene: ${job.composedPositive}`
  g['40'].inputs.seed = Number(job.seed) || 42
  g['90'].inputs.filename_prefix = `creatoros/${job.id}/look`
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const [img] = comfy.outputsOf(history)
  if (!img) throw new Error('image de style non produite')
  const nom = `STAGE_${job.id}_look.png`
  fs.writeFileSync(path.join(CONFIG.comfyInput, nom), await comfy.readImage(img))
  return nom
}

async function preparerDanse3d(job) {
  const brut = path.join(CONFIG.mediaDir, '.stage', `${job.id}_30.mp4`), maquette = path.join(CONFIG.mediaDir, job.reshootSource)
  // the skin tone of the person in the photo: the mannequin takes it, whatever the skin color
  let teint = '0.620,0.360,0.250'
  try { teint = (await executer(pythonComfy(), [path.join(SCRIPTS, 'teint.py'), path.join(CONFIG.comfyInput, job.danseStill), path.join(CONFIG.dataDir, 'modeles-controle')], { timeout: 60_000 })).stdout.trim().split('\n').pop() || teint } catch { /* average skin tone */ }
  const nImages = job.reshootImages || 121, secondesScene = String(Math.ceil((nImages - 1) / 24) + 0.2)
  await executer(path.join(os.homedir(), 'apps', 'blender', 'blender'), ['-b', '-P', path.join(SCRIPTS, 'scene_danse.py'), '--', job.danseFbx, brut, secondesScene, job.danseDecor, teint, 'portrait', job.danseDebut ? 'debut' : 'auto'], { timeout: 900_000 })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', brut, '-vf', 'fps=24', '-frames:v', String(nImages), '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', maquette], { timeout: 60_000 })
  const clay = `STAGE_${job.id}.png`
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', maquette, '-frames:v', '1', path.join(CONFIG.comfyInput, clay)], { timeout: 30_000 })
  /* The character is placed at the mannequin's exact position (same size, feet at the same spot);
     a two-image edit would copy the photo's framing and add a second person behind her. */
  const sam = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: 'person' } },
    3: { class_type: 'LoadImage', inputs: { image: job.danseStill } },
    4: { class_type: 'SAM3_Detect', inputs: { model: ['1', 0], image: ['3', 0], threshold: 0.4, refine_iterations: 2, individual_masks: false, conditioning: ['2', 0] } },
    5: { class_type: 'MaskToImage', inputs: { mask: ['4', 0] } },
    6: { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: `creatoros/${job.id}/masque` } },
  }
  const pm = await comfy.submitPrompt(sam, CLIENT_ID)
  current = { jobId: job.id, promptId: pm }
  const hm = await comfy.waitForPrompt(pm, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const [im] = comfy.outputsOf(hm)
  if (!im) throw new Error('personnage introuvable sur la photo')
  const masquePhoto = path.join(CONFIG.mediaDir, '.stage', `${job.id}_perso.png`)
  fs.writeFileSync(masquePhoto, await comfy.readImage(im))
  const pose = `STAGE_${job.id}_pose.png`
  await executer(pythonComfy(), [path.join(SCRIPTS, 'poser_personnage.py'), path.join(CONFIG.comfyInput, clay), brut.replace(/\.mp4$/, '_masque.png'),
    path.join(CONFIG.comfyInput, job.danseStill), masquePhoto, path.join(CONFIG.comfyInput, pose)], { timeout: 60_000 })
  const consigne = (fluxRef) => 'Turn this grey 3D blocking into a finished photograph. Keep the exact camera and framing. '
    + 'The woman keeps the same face, hair, outfit and shoes, at exactly the same place and the same size in the frame, '
    + 'but she is relit by the light of the place: the same colour, direction and intensity of light on her skin, hair and clothes as on the scene around her, with matching shadows. '
    + `The grey blocks become ${(STUDIOS_DANSE[job.danseDecor] ?? STUDIOS_DANSE.salon).texte}, with real materials and light. `
    + (fluxRef ? 'The second image shows the same woman: use it only for her face, hair and outfit, not for her size or place in the frame. ' : '')
    + 'She is the only person in the place: no other people anywhere, not even tiny figures far away in the background. Real photo.'
  let g
  if (process.env.CREATOROS_DANSE_LOOK === 'qwen') {
    g = comfy.loadWorkflow(EDIT_WORKFLOW)
    g['10'].inputs.image = pose
    g['30'].inputs.prompt = consigne(false)
    g['40'].inputs.seed = Number(job.seed) || 42
    g['90'].inputs.filename_prefix = `creatoros/${job.id}/look`
  } else {
    /* FLUX 3 Klein: the posed mockup as first reference (framing, position), the character photo as second
       (face, hair, outfit). Gives a sharper face and scenery more faithful to the mockup than Qwen-Edit.
       Same files as the FLUX 3 photo recipe (allege.js swaps them on small GPUs or ROCm). */
    const r = comfy.loadWorkflow('PROD_gen_flux3_sfw.json')
    const de = cls => Object.values(r).find(n => n.class_type === cls)?.inputs ?? {}
    g = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: de('UNETLoader').unet_name, weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: de('CLIPLoader').clip_name, type: 'flux3', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: de('VAELoader').vae_name } },
      11: { class_type: 'LoadImage', inputs: { image: pose } },
      12: { class_type: 'LoadImage', inputs: { image: job.danseStill } },
      4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: consigne(true) } },
      32: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      17: { class_type: 'ReferenceMultiLatent', inputs: { positive: ['4', 0], negative: ['32', 0], vae: ['3', 0], resolution: 'resize', 'resolution.megapixels': 1.0, 'images.image0': ['11', 0], 'images.image1': ['12', 0] } },
      7: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['17', 0], negative: ['17', 1], latent_image: ['17', 2], seed: Number(job.seed) || 42, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
      90: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: `creatoros/${job.id}/look` } },
    }
  }
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const [img] = comfy.outputsOf(history)
  if (!img) throw new Error('1re image non produite')
  const nom = `STAGE_${job.id}_look.png`
  fs.writeFileSync(path.join(CONFIG.comfyInput, nom), await comfy.readImage(img))
  return nom
}

async function runReshoot(job, t0) {
  if (job.op === 'stage') job.stageLook = await peindreLook(job)
  if (job.op === 'danse3d') job.stageLook = await preparerDanse3d(job)
  const src = path.join(CONFIG.mediaDir, job.reshootSource)
  const d = videoSize(src)
  // long side 1280, multiples of 64 (the x2 pass starts from a half size that is a multiple of 32)
  let W = 704, H = 1280
  if (d.width && d.height) {
    if (d.width > d.height * 1.15) { W = 1280; H = 704 } else if (d.width * 1.15 >= d.height) { W = 960; H = 960 }
  }
  if (job.op === 'effetltx' && EFFETS_LTX[job.effetLtx]?.decrit && descriptionsEffet.has(job.id)) {
    // the description started at enqueue (up to 4 min wait); a rerun keeps the prompt already written
    const desc = await Promise.race([descriptionsEffet.get(job.id), new Promise(r => setTimeout(() => r(null), 240_000))])
    descriptionsEffet.delete(job.id)
    if (desc) {
      const t = job.userPrompt && job.userPrompt !== EFFETS_LTX[job.effetLtx].nom ? job.userPrompt : ''
      job.composedPositive = EFFETS_LTX[job.effetLtx].prompt(t, desc.replace(/\s+/g, ' ').trim())
      store.setComposedPositive(job.id, job.composedPositive)
    }
  }
  let sonSource = false
  try { sonSource = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* no audio */ }
  const g = grapheReshoot(job, W, H, sonSource)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const cam = job.reshootCamera
  const angle = cam.cles ? cam.cles.map(k => `az ${k.az}° él ${k.el}°`).join(' → ') : `az ${cam.az}° él ${cam.el}°`
  console.log(`[job ${job.id}] RE-SHOOT ${angle}, ${job.reshootImages} images ${W}×${H} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [job.op === 'effetltx' ? `effet : LTX-2.5 + IC-LoRA ${EFFETS_LTX[job.effetLtx]?.nom} (Lightricks), ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}` : job.op === 'danse3d' ? `danse 3D : scène Blender (${job.danseDecor}) → 1re image repeinte avec le personnage (${process.env.CREATOROS_DANSE_LOOK === 'qwen' ? 'Qwen Edit' : 'FLUX 3 + photo en référence'}) → LTX-2.5 + IC-LoRA Layout-to-Render, ${job.reshootImages} images ${W}×${H}` : job.op === 'stage' ? `stage : maquette grise → LTX-2.5 + IC-LoRA Layout-to-Render (Lightricks), ${job.reshootImages} images ${W}×${H}` : job.op === 'cleanplate'
      ? `clean plate : LTX-2.5 + IC-LoRA Clean-Plate (Lightricks), « ${job.userPrompt} » retiré, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`
      : `re-shoot : MoGe-2 → CrossViewWarp → LTX-2.5 + IC-LoRA CrossView-Warp v2 (force 1,3), ${angle}, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  if (job.op === 'danse3d' && n > 0) {
    if (!job.danseSansSwap) try { enchainerSwapDanse(job) } catch (e) { console.warn(`[job ${job.id}] Swap non enchaîné — ${e.message || e}`) }
  }
  return n
}

/* 3D dance, 2nd pass: LTX produced the set, camera and dance; Swap (SCAIL-2) redraws the dancer from
   the photo (face, skin, shoes). The reference is rescaled to the dancer's size in the video, otherwise
   Swap draws her bigger and too close; 1280 px keeps hands and fabric better than 896. */
function enchainerSwapDanse(job) {
  const a = store.assetsOfJob(job.id).find(x => x.media_type === 'video')
  if (!a) throw new Error('rendu LTX introuvable')
  const driver = `crs_${job.id}_drv.mp4`
  /* The first second starts from the repainted first frame, where the dancer slides into her dance spot.
     It is cut before Swap so it does not appear in the final render (CREATOROS_DANSE_COUPE in seconds, 0 to keep it). */
  const coupe = Math.max(0, Number(process.env.CREATOROS_DANSE_COUPE ?? 1) || 0)
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename))
  if (coupe > 0) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(coupe), '-i', src, '-map', '0:v', '-map', '0:a?', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(CONFIG.comfyInput, driver)], { timeout: 120_000 })
  else fs.copyFileSync(src, path.join(CONFIG.comfyInput, driver))
  store.noterInput(driver, 'danse')
  /* Swap reference: the repainted first frame (STAGE_..._look.png). The dancer there is already at the video's
     scale and under the studio's lighting (neon, sunset...); with the original photo, Swap would paste her own
     flat lighting onto a scene with different light. Fallback: the rescaled photo. */
  let ref = job.stageLook && fs.existsSync(path.join(CONFIG.comfyInput, job.stageLook)) ? job.stageLook : null
  if (ref) store.noterInput(ref, 'genere')
  if (!ref) ref = refAEchelle(job)
  const geste = 'She dances with energy and a big smile, following the rhythm, her whole body visible.'
  enqueue({ id: `${job.id}-swap`, mode: 'video', register: 'sfw', purpose: 'creative', personaId: job.personaId,
    motionDriver: driver, motionRef: ref, motionMode: 'replace', swapLong: 1280, swapBlocs: SCAIL_BLOCS_MAX, danseSuivi: job.danseSuivi === true ? true : undefined,
    composedPositive: geste, userPrompt: geste, composedNegative: '',
    motionSceneText: `A young woman dancing alone in ${(STUDIOS_DANSE[job.danseDecor] ?? STUDIOS_DANSE.salon).texte}, lit by the light of the place, with nobody else anywhere in the place. ${geste}`, parentAssetId: a.id })
  console.log(`[job ${job.id}] Swap enchaîné : ${job.id}-swap (référence ${ref})`)
}

/* Finished 3D dance: only the redrawn version (...-swap) stays in the library. The intermediate scene video goes
   to the trash (recoverable), and its provenance (scene, first frame, LTX graph) is attached to the final result's. */
function finaliserDanse3d(job) {
  const parentId = job.id.replace(/-swap$/, '')
  const final = store.assetsOfJob(job.id).find(x => x.media_type === 'video')
  const inter = store.assetsOfJob(parentId).find(x => x.media_type === 'video')
  if (!final || !inter) return
  const pp = store.getProvenance(inter.id), pf = store.getProvenance(final.id)
  if (pp && pf) {
    let inj = {}
    try { inj = JSON.parse(pf.injections ?? '{}') ?? {} } catch { inj = {} }
    const lire = x => { try { return JSON.parse(x) } catch { return x ?? null } }
    inj.etapeScene3d = { jobId: parentId, recipeId: pp.recipe_id, seed: pp.seed, composedPositive: pp.composed_positive,
      injections: lire(pp.injections), sourceImage: pp.source_image, workflowJson: lire(pp.workflow_json) }
    store.db.prepare('UPDATE provenance SET injections = ? WHERE asset_id = ?').run(JSON.stringify(inj), final.id)
  }
  const row = store.trashAsset(inter.id)
  if (row?.filename) {
    const corbeille = path.join(CONFIG.mediaDir, '.corbeille')
    try { fs.mkdirSync(corbeille, { recursive: true }); fs.renameSync(path.join(CONFIG.mediaDir, path.basename(row.filename)), path.join(corbeille, path.basename(row.filename))) }
    catch (e) { if (e.code !== 'ENOENT') console.warn(`[job ${job.id}] corbeille ${row.filename} : ${e.message}`) }
  }
  console.log(`[job ${job.id}] danse 3D finie : scène intermédiaire ${inter.id} à la corbeille, provenance jointe`)
}

function refAEchelle(job) {
  const masqueCorps = path.join(CONFIG.mediaDir, '.stage', `${job.id}_30_masque.png`)
  const ref = `crs_${job.id}_ref.png`
  const part = execFileSync(pythonComfy(), ['-c', `from PIL import Image\nm=Image.open(${JSON.stringify(masqueCorps)}).convert('L')\nb=m.point(lambda v:255 if v>128 else 0).getbbox()\nprint(round((b[3]-b[1])/m.height,3) if b else 0.4)`], { encoding: 'utf8', timeout: 30_000 }).trim()
  execFileSync(pythonComfy(), [path.join(SCRIPTS, 'ref_a_echelle.py'), path.join(CONFIG.comfyInput, job.danseStill), path.join(CONFIG.mediaDir, '.stage', `${job.id}_perso.png`), part, path.join(CONFIG.comfyInput, ref)], { timeout: 60_000 })
  store.noterInput(ref, 'genere')
  return ref
}

async function runPhotoHd(job, t0) {
  const g = comfy.loadWorkflow(PHOTO_HD_WORKFLOW)
  g['10'].inputs.image = job.sourceImage
  g['30'].inputs.text = String(job.composedPositive ?? '')
  g['40'].inputs.denoise = job.photoHdDenoise ?? PHOTO_HD_DENOISE
  g['40'].inputs.seed = Number(job.seed) || 42
  for (const id of Object.keys(g))
    if (g[id].class_type === 'SaveImage') g[id].inputs.filename_prefix = `creatoros/${job.id}/hd`
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] PHOTO HD denoise ${g['40'].inputs.denoise} sur ${job.sourceImage} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [`photo HD 2 MP, affinage denoise ${g['40'].inputs.denoise}, visage repris de la source (masque face_yolov8m), couleurs recalées`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- finishing an existing clip: foley and smoothness ----------
   FOLEY (`foley`): a silent clip (Wan, motion) gets an ambient track generated
   by LTX-2.5 from its frames. The clip is encoded into the video latent with a
   ZERO noise mask: the model keeps it as is and only generates audio, matched to
   what it sees. Delivered frames are those of the original clip; only the audio
   track is added. No voice or music.
   SMOOTHNESS (`interpolate`): RIFE x2 on the clip (24 -> 48 fps), audio kept. */
const FOLEY_NEGATIF = 'music, singing, speech, voice, talking, narration'
const roundTo = (v, m) => Math.max(m, Math.round(v / m) * m)

export function enqueueFinition({ op, asset, prompt }) {
  if (!['foley', 'interpolate'].includes(op)) throw new Error(`finition « ${op} » inconnue`)
  if (asset.media_type !== 'video') throw new Error('finition : vidéos seulement')
  const src = path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri))
  if (!fs.existsSync(src)) throw new Error('fichier vidéo introuvable')
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,width,height',
    '-show_entries', 'format=duration', '-of', 'json', src], { encoding: 'utf8' })
  const info = JSON.parse(probe)
  const v = info.streams.find(x => x.codec_type === 'video')
  const hasAudio = info.streams.some(x => x.codec_type === 'audio')
  const [fn, fd] = String(v?.r_frame_rate ?? '24/1').split('/').map(Number)
  const fps = fd ? fn / fd : fn
  const seconds = Number(info.format?.duration) || 5
  if (op === 'foley' && seconds > 20) throw new Error('bruitage : 20 s au plus')
  if (op === 'interpolate' && fps >= 40) throw new Error(`déjà fluide : ${Math.round(fps)} i/s`)
  const id = `${op === 'foley' ? 'son' : 'rife'}-${Date.now().toString(36)}`
  const inputName = `${id}.mp4`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  let guideName = null, frames = null
  if (op === 'foley') {
    /* Working copy for LTX: 24 fps, 8n+1 frames, sides multiple of 32, ~0.25 MP;
       audio only needs to "see" the scene. */
    frames = Math.floor(seconds * 24 / 8) * 8 + 1
    const k = Math.sqrt(250000 / ((v.width || 704) * (v.height || 1248)))
    const w = roundTo((v.width || 704) * k, 32), h = roundTo((v.height || 1248) * k, 32)
    guideName = `${id}_guide.mp4`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `fps=24,scale=${w}:${h}`, '-frames:v', String(frames),
      '-an', '-c:v', 'libx264', '-crf', '18', path.join(CONFIG.comfyInput, guideName)])
  }
  const texte = typeof prompt === 'string' && prompt.trim() ? prompt.trim()
    : 'Natural ambient sound matching the scene, realistic environmental sounds and soft foley. No music, no voice.'
  const row = {
    id, createdAt: Date.now(), status: 'queued',
    personaId: store.getJob(asset.job_id)?.persona_id ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: `${op}@v1`, workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op, sourceImage: null,
    videoEngine: asset.video_engine ?? null,
    withAudio: op === 'foley' ? true : hasAudio,
    finitionSource: inputName, finitionGuide: guideName, finitionFrames: frames,
    finitionFps: fps, finitionHasAudio: hasAudio,
    videoFps: op === 'interpolate' ? Math.round(fps * 2) : fps,
    parentAssetId: asset.id, videoDraft: null,
    userPrompt: op === 'foley' ? texte : null, userDirectives: null,
    composedPositive: op === 'foley' ? texte : `fluidité RIFE ×2 (${Math.round(fps)} → ${Math.round(fps * 2)} i/s)`,
    composedNegative: op === 'foley' ? FOLEY_NEGATIF : null,
    selections: null, loras: [], videoLoras: [],
    estimatedMs: op === 'foley' ? Math.round(30000 + seconds * 4000) : Math.round(15000 + seconds * 3000),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

async function runFinition(job, t0) {
  const prefix = `creatoros/${job.id}/${job.op}`
  let g
  if (job.op === 'foley') {
    g = {
      1: { class_type: 'LoadVideo', inputs: { file: job.finitionGuide } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
      4: { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
      5: { class_type: 'UNETLoader', inputs: { unet_name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', weight_dtype: 'default' } },
      6: { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
      7: { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['3', 0] } },
      8: { class_type: 'SolidMask', inputs: { value: 0, width: 64, height: 64 } },
      9: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['7', 0], mask: ['8', 0] } },
      10: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: job.finitionFrames, frame_rate: 24, batch_size: 1, audio_vae: ['4', 0] } },
      11: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['9', 0], audio_latent: ['10', 0] } },
      12: { class_type: 'CLIPTextEncode', inputs: { text: job.composedPositive, clip: ['6', 0] } },
      13: { class_type: 'CLIPTextEncode', inputs: { text: job.composedNegative ?? FOLEY_NEGATIF, clip: ['6', 0] } },
      14: { class_type: 'LTXVConditioning', inputs: { frame_rate: 24, positive: ['12', 0], negative: ['13', 0] } },
      15: { class_type: 'LTXVDualCFGGuider', inputs: { video_cfg: 1, audio_cfg: 1, model: ['5', 0], positive: ['14', 0], negative: ['14', 1] } },
      16: { class_type: 'RandomNoise', inputs: { noise_seed: Number(job.seed) || 42 } },
      17: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
      18: { class_type: 'ManualSigmas', inputs: { sigmas: '1.000000, 0.997500, 0.995000, 0.992500, 0.990000, 0.987500, 0.985000, 0.982500, 0.980000, 0.977500, 0.975000, 0.948750, 0.922500, 0.872500, 0.798750, 0.725000, 0.603750, 0.482500, 0.337500, 0.168750, 0.000000' } },
      19: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['16', 0], guider: ['15', 0], sampler: ['17', 0], sigmas: ['18', 0], latent_image: ['11', 0] } },
      20: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['19', 0] } },
      21: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['20', 1], audio_vae: ['4', 0] } },
      // delivered frames are those of the ORIGINAL clip, at its fps
      30: { class_type: 'LoadVideo', inputs: { file: job.finitionSource } },
      31: { class_type: 'GetVideoComponents', inputs: { video: ['30', 0] } },
      32: { class_type: 'CreateVideo', inputs: { images: ['31', 0], fps: job.finitionFps, audio: ['21', 0] } },
      33: { class_type: 'SaveVideo', inputs: { video: ['32', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } },
    }
  } else {
    g = {
      1: { class_type: 'LoadVideo', inputs: { file: job.finitionSource } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: 'RIFE VFI', inputs: { ckpt_name: 'rife49.pth', frames: ['2', 0],
        clear_cache_after_n_frames: 10, multiplier: 2, fast_mode: true, ensemble: true, scale_factor: 1.0,
        batch_size: 4, torch_compile: false, dtype: 'float16' } },
      4: { class_type: 'CreateVideo', inputs: { images: ['3', 0], fps: Math.round(job.finitionFps * 2),
        ...(job.finitionHasAudio ? { audio: ['2', 1] } : {}) } },
      5: { class_type: 'SaveVideo', inputs: { video: ['4', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } },
    }
  }
  if (job.op === 'foley') await comfy.freeMemory().catch(() => { /* non-fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] ${job.op === 'foley' ? 'BRUITAGE LTX' : 'FLUIDITÉ RIFE ×2'} sur ${job.finitionSource} prompt_id=${promptId}`)
  // working copies stay in input/ (like upscale) so a rerun can reread them
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [job.op === 'foley'
        ? `bruitage LTX-2.5 (vidéo → son, images d'origine conservées) : « ${job.composedPositive} », sonie ramenée à -18 LUFS`
      : job.composedPositive],
    skipped: [], finalWorkflow: g,
  })
  /* The generated track comes out about 30 dB too quiet: normalize it to -18 LUFS,
     without re-encoding the video. */
  if (job.op === 'foley') {
    for (const a of store.assetsOfJob(job.id).filter(x => x.media_type === 'video')) {
      const f = path.join(CONFIG.mediaDir, path.basename(a.filename)), tmp = `${f}.norm.mp4`
      try {
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', f, '-map', '0', '-c:v', 'copy', '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeout: 120_000 })
        fs.renameSync(tmp, f)
      } catch (e) { fs.rmSync(tmp, { force: true }); console.warn(`[job ${job.id}] sonie non corrigée — ${e.message || e}`) }
    }
  }
  store.markFinished(job.id, Date.now() - t0)
  return n
}

async function runUpscale(job, t0) {
  const g = comfy.loadWorkflow(REFINE_RECIPE)
  g['20'].inputs.video = job.upscaleSource
  g['20'].inputs.custom_width = job.upscaleW
  g['20'].inputs.custom_height = job.upscaleH
  /* The draft's AUDIO follows the upscale, but ONLY if it exists. VHS_LoadVideo
     tries to extract the track as soon as its audio output is wired, and fails
     the whole job on a silent clip (e.g. all Wan renders, which have no audio
     stage). So the source is probed before wiring. */
  const srcPath = path.join(CONFIG.comfyInput, job.upscaleSource)
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', srcPath],
      { encoding: 'utf8' }).trim().length > 0
  } catch { /* probe failed: stay silent, the safe case */ }
  if (g['15'] && hasAudio) g['15'].inputs.audio = ['20', 2]
  else if (g['15']) delete g['15'].inputs.audio
  console.log(`[job ${job.id}] upscale : source ${hasAudio ? 'avec' : 'SANS'} piste audio`)
  /* Frame rate: output 30 fps MINIMUM (16 fps is visible).
     Source < 24 fps (Wan draft 16): refine at 15 fps then RIFE x2 -> exactly 30;
     interpolation happens AFTER the refine (half as many frames to sample).
     Source >= 24: native rate kept (24/25/30). */
  /* UNIVERSAL half rate + RIFE x2: refine half as many frames (about 2x faster)
     and RIFE restores the rate: output 30 for sources < 24, native otherwise. */
  const srcFps = job.upscaleSrcFps ?? job.videoFps ?? 16
  const half = srcFps < 24 ? 15 : srcFps / 2
  g['20'].inputs.force_rate = half
  g['99'] = { class_type: 'RIFE VFI', inputs: { ckpt_name: 'rife49.pth', frames: ['14', 0],
    clear_cache_after_n_frames: 10, multiplier: 2, fast_mode: true, ensemble: true, scale_factor: 1.0,
    batch_size: 4, torch_compile: false, dtype: 'float16' } }
  if (g['15']) { g['15'].inputs.images = ['99', 0]; g['15'].inputs.fps = Math.round(half * 2) }
  g['12'].inputs.denoise = UPSCALE_DENOISE
  g['12'].inputs.seed = Number(job.seed) || 42
  for (const id of Object.keys(g))
    if (g[id].class_type === 'SaveVideo') g[id].inputs.filename_prefix = `creatoros/${job.id}/upscale`
  // free VRAM for the Wan refine (otherwise most of the model is offloaded to RAM)
  await comfy.freeMemory().catch(() => { /* non-fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] UPSCALE refine ${job.upscaleW}x${job.upscaleH} denoise ${UPSCALE_DENOISE} sur ${job.upscaleSource} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [`upscale refine ${job.upscaleW}x${job.upscaleH}, denoise ${UPSCALE_DENOISE}, mouvement du brouillon conservé (source ${job.upscaleSource})`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/** Smoothness for motion renders: WanAnimate works and outputs at 16 fps, which
 *  is visible. RIFE x2 doubles frames AFTER rendering: the model stays at its
 *  training rate, output goes to 32 fps. No conversion to 30: dropping 1 frame in
 *  16 would create an uneven cadence (see probeDriver).
 *  Non-fatal: on failure the 16 fps render is delivered as is. */
async function fluidifier(file, jobId) {
  const inName = `rife_${jobId}.mp4`
  const inPath = path.join(CONFIG.comfyInput, inName)
  try {
    const fps = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }).trim().split('/').reduce((a, b) => Number(a) / Number(b)))
    if (!Number.isFinite(fps) || fps >= 24) return null   // already smooth: nothing to do
    fs.copyFileSync(file, inPath)
    const g = {
      1: { class_type: 'LoadVideo', inputs: { file: inName } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: 'RIFE VFI', inputs: { ckpt_name: 'rife49.pth', frames: ['2', 0],
        clear_cache_after_n_frames: 10, multiplier: 2, fast_mode: true, ensemble: true, scale_factor: 1.0,
        batch_size: 4, torch_compile: false, dtype: 'float16' } },
      4: { class_type: 'CreateVideo', inputs: { images: ['3', 0], fps: Math.round(fps * 2) } },
      5: { class_type: 'SaveVideo', inputs: { video: ['4', 0], filename_prefix: `creatoros/${jobId}/fluide`, format: 'auto', codec: 'auto' } },
    }
    const pid = await comfy.submitPrompt(g, CLIENT_ID)
    const hist = await comfy.waitForPrompt(pid)
    const vid = comfy.outputsOf(hist).find(o => /\.mp4$/i.test(o.filename))
    if (!vid) throw new Error('RIFE sans sortie vidéo')
    fs.writeFileSync(file, await comfy.readImage(vid))
    return `fluidité : RIFE ×2, ${fps.toFixed(0)} → ${Math.round(fps * 2)} i/s (prompt ${pid})`
  } catch (e) {
    console.warn(`[rife] ${path.basename(file)} livré à sa cadence d'origine — ${e.message || e}`)
    return { echec: String(e.message || e) }
  } finally {
    fs.rmSync(inPath, { force: true })
  }
}

/* ---------- conforming the delivered file ----------
   Two corrections in one ffmpeg pass, so the file is re-encoded once:

   SPEED. The rendered duration is MEASURED and brought back to the requested
   duration (MiniMax quantizes its frame count to 17 and LTX only accepts whole
   seconds, so neither renders the exact requested length). When the gap is under
   the threshold (e.g. Wan) nothing is done.

   `atempo` and not just `setpts`: speeding up video without processing audio
   would pitch it up. `atempo` accepts 0.5 to 2.0; beyond that it is chained.

   FRAME RATE. `-r` sets the file's frame rate. Above the native rate this
   DUPLICATES frames; it does not create motion. */
function conformVideo(file, targetSeconds, targetFps) {
  let actual = null, srcFps = null
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration', '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim().split('\n')
    const [num, den] = String(out[0]).split('/').map(Number)
    srcFps = den ? num / den : num
    actual = Number(out[1])
  } catch { return null }
  if (!Number.isFinite(actual) || actual <= 0) return null

  const factor = Number.isFinite(targetSeconds) && targetSeconds > 0 ? actual / targetSeconds : 1
  const fps = Number.isFinite(targetFps) ? targetFps : srcFps
  // 2% tolerance: re-encoding to fix a hundredth of a second would cost quality for nothing.
  const needSpeed = Math.abs(factor - 1) > 0.02
  const needFps = Number.isFinite(fps) && Number.isFinite(srcFps) && Math.abs(fps - srcFps) > 0.01
  if (!needSpeed && !needFps) return null

  const tmp = file.replace(/(\.\w+)$/, '.conform$1')
  try {
    const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== ''
    // atempo is limited to [0.5, 2]: chain it for larger factors.
    const tempo = []
    for (let f = factor; f > 2.0001; f /= 2) tempo.push('atempo=2.0')
    tempo.push(`atempo=${(factor / 2 ** tempo.length).toFixed(6)}`)

    const args = ['-y', '-v', 'error', '-i', file]
    if (hasAudio) {
      args.push('-filter_complex',
        `[0:v]setpts=PTS/${factor}[v];[0:a]${tempo.join(',')}[a]`, '-map', '[v]', '-map', '[a]')
    } else {
      args.push('-filter:v', `setpts=PTS/${factor}`, '-an')
    }
    args.push('-r', String(fps), tmp)
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    fs.renameSync(tmp, file)
    return `conformé : ${actual.toFixed(2)} s → ${(actual / factor).toFixed(2)} s`
      + ` (x${factor.toFixed(2)})${needFps ? ` · ${srcFps.toFixed(0)} → ${fps} fps` : ''}`
  } catch (e) {
    // A slowed clip is still a clip: deliver it and report it.
    fs.rmSync(tmp, { force: true })
    console.warn(`[conform] ${path.basename(file)} livré tel quel — ${e.message || e}`)
    return null
  }
}

/* MATTE pass: de-gloss (highlight compression via `curves`) + micro grain.
   Distilled models (MiniMax H3, WanAnimate) output glossy/plastic skin; this
   pass mattes it without darkening the image or touching identity. AUDIO KEPT:
   it is only dropped if there is none. Non-fatal. */
function matteVideo(file) {
  const tmp = file.replace(/(\.\w+)$/, '.matte$1')
  // Gentle curve: a stronger one crushes highlights and desaturates i2v renders.
  // Light de-gloss (whites -> 0.94) + saturation +10% to keep some pop, with
  // anti-plastic grain. Extensions are not matted (see harvest).
  const vf = "curves=all='0/0 0.5/0.49 0.75/0.70 0.9/0.86 1/0.94',eq=saturation=1.10,noise=alls=4:allf=t"
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== ''
  } catch { /* no detectable audio -> silent */ }
  try {
    const args = ['-y', '-v', 'error', '-i', file, '-vf', vf,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']
    args.push(...(hasAudio ? ['-c:a', 'copy'] : ['-an']))
    args.push(tmp)
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    fs.renameSync(tmp, file)
    return 'mate : dé-brillance + grain' + (hasAudio ? ' (audio conservé)' : '')
  } catch (e) {
    // Non-fatal: without the pass the render is delivered as is.
    fs.rmSync(tmp, { force: true })
    console.warn(`[matte] ${path.basename(file)} livré tel quel — ${e.message || e}`)
    return null
  }
}

/* Mean luma/saturation over a window (signalstats). Used to measure the color
   STEP at the extension seam. Null if unreadable. */
function meanYSat(file, ss, dur) {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-t', String(dur),
      '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    let y = 0, ny = 0, s = 0, ns = 0, u = 0, nu = 0, v = 0, nv = 0
    for (const m of out.matchAll(/YAVG=([\d.]+)/g)) { y += +m[1]; ny++ }
    for (const m of out.matchAll(/SATAVG=([\d.]+)/g)) { s += +m[1]; ns++ }
    for (const m of out.matchAll(/UAVG=([\d.]+)/g)) { u += +m[1]; nu++ }
    for (const m of out.matchAll(/VAVG=([\d.]+)/g)) { v += +m[1]; nv++ }
    if (!ny || !ns || !nu || !nv) return null
    return { y: y / ny, s: s / ns, u: u / nu, v: v / nv }
  } catch { return null }
}

/* Color correction of the continuation to match the source's TAIL.
   i2v re-exposes darker and less saturated than the conditioning image, leaving
   a visible step at the seam. The continuation's head is aligned to the source's
   end with a luma gain + saturation scale, clamped so an outlier measurement
   (flash/fade at the cut) does not throw off the whole shot. Empty filter chain
   if not measurable -> raw concat unchanged. */
function seamMatchFilter(srcPath, contPath, prequel = false) {
  /* Prequel: the render goes BEFORE the source, so the seam is between the
     render's TAIL and the source's HEAD. */
  const src = prequel ? meanYSat(srcPath, 0, 0.5)
    : meanYSat(srcPath, Math.max(0, videoDurationOf(srcPath) - 0.5), 0.5)
  const cont = prequel ? meanYSat(contPath, Math.max(0, videoDurationOf(contPath) - 0.5), 0.5)
    : meanYSat(contPath, 0, 0.5)
  if (!src || !cont || cont.y < 1 || cont.s < 1) return ''
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const gain = clamp(src.y / cont.y, 0.9, 1.3)
  const sat = clamp(src.s / cont.s, 0.9, 1.25)
  // Chroma (hue / white balance): i2v also shifts the U/V MEAN (cooler tones).
  // Chroma is matched with scale + offset inside lutyuv (not eq, whose mean shift
  // is opaque). Per channel: out = (val-128)*sat + 128 + offset. The offset
  // realigns the post-scale mean with the source's; clamped to +-12 to avoid drift.
  const postSat = (m) => (m - 128) * sat + 128
  const du = clamp(src.u - postSat(cont.u), -12, 12)
  const dv = clamp(src.v - postSat(cont.v), -12, 12)
  // Nothing to correct if everything is negligible (luma/sat < 2%, chroma < 1 level).
  if (Math.abs(gain - 1) < 0.02 && Math.abs(sat - 1) < 0.02
      && Math.abs(du) < 1 && Math.abs(dv) < 1) return ''
  const off = (d) => (d >= 0 ? '+' : '-') + Math.abs(d).toFixed(2)
  const s = sat.toFixed(3)
  return `,lutyuv=y=clipval*${gain.toFixed(3)}`
    + `:u=(val-128)*${s}+128${off(du)}`
    + `:v=(val-128)*${s}+128${off(dv)}`
}

function videoDurationOf(file) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()) || 0
  } catch { return 0 }
}

/* Recolors the continuation clip IN PLACE to match the source's tail (same
   computation as the concat seam, applied to the delivered `-0` asset, not just
   `-full`), so an extension's standalone clip does not look darker than the
   source. Audio kept, non-fatal: on failure the raw render stays. Once corrected
   here, the concat seam measures ~0 and is skipped (< 2% guard). */
function seamMatchInPlace(contFile, srcPath, prequel = false) {
  const suffix = seamMatchFilter(srcPath, contFile, prequel)   // ",eq=...,lutyuv=..." or ""
  if (!suffix) return null
  const vf = suffix.replace(/^,/, '')
  const tmp = contFile.replace(/(\.\w+)$/, '.seam$1')
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', contFile], { encoding: 'utf8' }).trim() !== ''
  } catch { /* no audio */ }
  try {
    const args = ['-y', '-v', 'error', '-i', contFile, '-vf', vf,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']
    args.push(...(hasAudio ? ['-c:a', 'copy'] : ['-an']), tmp)
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    fs.renameSync(tmp, contFile)
    return `continuation recolorée sur la source (${vf})`
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    console.warn(`[seam] ${path.basename(contFile)} livré brut — ${e.message || e}`)
    return null
  }
}

/* ---------- extension concat: source + continuation in one file ----------
   Re-encoding is required (different codecs and resolutions): both segments are
   normalized to the CONTINUATION's resolution, 24 fps, yuv420p. The continuation
   is recolored to match the end of the source (seamless join). Audio is
   concatenated only if BOTH have it; otherwise the file is silent. */
function concatVideos(srcPath, contPath, outPath, { seam: avecSeam = true } = {}) {
  const hasAudio = f => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim() !== ''
  const both = hasAudio(srcPath) && hasAudio(contPath)
  const seam = avecSeam ? seamMatchFilter(srcPath, contPath) : ''
  const vf = `[0:v]fps=24,format=yuv420p[v0];[1:v]fps=24,format=yuv420p${seam}[v1];[v0][v1]scale2ref=w=iw:h=ih[va][vb];[va][vb]concat=n=2:v=1:a=0[v]`
  const af = both ? `;[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];[a0][a1]concat=n=2:v=0:a=1[a]` : ''
  const args = ['-y', '-v', 'error', '-i', srcPath, '-i', contPath,
    '-filter_complex', vf + af, '-map', '[v]']
  if (both) args.push('-map', '[a]')
  args.push(outPath)
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

/** Dimensions of a video file (`pngSize` cannot read an mp4). */
function videoSize(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf8' }).trim()
    const [w, h] = out.split('x').map(Number)
    return { width: Number.isFinite(w) ? w : null, height: Number.isFinite(h) ? h : null }
  } catch { return { width: null, height: null } }
}

/* ---------- visitor's Comfy Cloud key ----------
   Set by the submit request (X-Comfy-Key header, see index.js), kept IN MEMORY
   only until the job ends: never in the database, payload or logs. A server
   restart loses it; the resumed job then falls back to the local transport, or
   fails without it. */
const depot = new AsyncLocalStorage()
const clesComfy = new Map()   // jobId -> key
/** Runs a submission (enqueue...) attaching `cle` to the jobs it creates. */
export const deposerAvecCle = (cle, fn) => depot.run(cle || null, fn)
function retenirCle(id) { const c = depot.getStore(); if (c) clesComfy.set(id, c) }

async function pump() {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = true
  enCours = { estimatedMs: job.estimatedMs, debut: Date.now() }
  /* The GPU is reserved for ComfyUI for the job's duration (see server/gpu.js). */
  /* Visitor key -> Comfy Cloud via the SDK; global SDK transport -> local proxy;
     otherwise local ComfyUI, with the GPU arbitrated against Ollama (gpu.js). */
  // TRELLIS.2 and ACE-Step run here, with local files: never on the visitor's cloud
  const cle = ['objet3d', 'musique'].includes(job.op) ? null : clesComfy.get(job.id)
  try {
    const lancer = () => profilDuJob.run(job.profilVram ?? null, () => runJob(job))
    if (cle || sdk.TRANSPORT === 'sdk') await sdk.avecSdk(cle, lancer)
    else await pourRendu(job, lancer)
  } catch (e) { console.error('[job]', job.id, String(e?.message ?? e).slice(0, 500)) }
  finally { clesComfy.delete(job.id) }
  if (job.motionPlan) await assemblerPlans(job).catch(e => console.warn(`[plans] montage non produit — ${String(e.message || e).slice(0, 300)}`))
  running = false
  enCours = null
  pump()
}

/** Driver inventory: frame count and frame rate, from the actual file.
 *  Drivers above 30 fps are first brought down to 24: motion gains nothing and
 *  cost is linear in frames. */
async function probeDriver(job) {
  let driverPath = path.join(CONFIG.comfyInput, job.motionDriver)
  if (!fs.existsSync(driverPath))
    throw new Error(`vidéo driver introuvable dans input/ : ${job.motionDriver}`)
  const fps0 = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', driverPath],
    { encoding: 'utf8' }).trim().split('/').reduce((a, b) => Number(a) / Number(b)))
  /* WAN-Animate-2 is trained at 16 fps: a 30 fps driver gives it ~2x the expected
     inter-frame motion, so it under-follows fast gestures. EVERY driver != 16 fps
     is brought to 16 fps before transfer to match the training rate. */
  /* BY INTERPOLATION, not by dropping frames. "-r 16" keeps the nearest frame,
     giving uneven steps (1, 2, 1, 2 intervals) that the model reproduces as a
     limping cadence. minterpolate creates truly intermediate, evenly spaced frames.
     Costs some CPU time, once per driver. */
  if (Number.isFinite(fps0) && Math.abs(fps0 - 16) > 0.5 && job.motionFpsNatif !== true) {
    const resampled = driverPath.replace(/(\.\w+)$/, '_16fps_mci.mp4')
    if (!fs.existsSync(resampled)) {
      // asynchronous: this can take tens of seconds and the server must keep answering the UI
      await new Promise((ok, ko) => execFile('ffmpeg', ['-y', '-v', 'error', '-i', driverPath,
        '-vf', 'minterpolate=fps=16:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1', '-an',
        '-c:v', 'libx264', '-crf', '17', resampled + '.tmp.mp4'], { timeout: 600_000 }, e => e ? ko(e) : ok()))
      fs.renameSync(resampled + '.tmp.mp4', resampled)   // never reuse a partial file on the next render
      console.log(`[job ${job.id}] driver ${fps0.toFixed(0)} fps → 16 fps (${path.basename(resampled)})`)
    }
    driverPath = resampled
    job.motionDriver = path.basename(resampled)
  }
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate',
    '-of', 'default=nw=1:nk=1', driverPath], { encoding: 'utf8' }).trim().split('\n')
  const [num, den] = String(probe[0]).split('/').map(Number)
  const fps = den ? num / den : num
  const frames = Number(probe[1])
  if (!Number.isFinite(frames) || frames < 9)
    throw new Error(`driver illisible ou trop court (${probe[1]} images)`)
  return { driverPath, frames, fps }
}

/** Motion Control reference: the operator's still as is, plus the driver inventory. */
async function buildMotionRef(job) {
  const { driverPath, frames, fps } = await probeDriver(job)
  if (!job.motionRef && job.motionMode === 'replace') return { refName: await refDuPersonnage(job, driverPath, frames, fps), frames, fps, driverPath }
  if (!job.motionRef) throw new Error('still de référence manquante')
  return { refName: job.motionRef, frames, fps, driverPath }
}

/* Mix from the video alone: the appearance reference is built here.
   No head swap on a driver frame. Instead: the sharpest frame of the first
   second, its outfit read by the VLM, and the active character rendered full
   body in that outfit by the photo recipe (with its identity LoRA). WanAnimate
   then keeps the driver's scene and motion. */
async function refDuPersonnage(job, driverPath, frames, fps) {
  const src = `mx_${job.id}_src.png`, ref = `mx_${job.id}_ref.png`
  let idx = 0
  try {
    const meta = execFileSync('ffmpeg', ['-v', 'error', '-i', driverPath, '-t', String(Math.min(1, frames / (fps || 16))),
      '-vf', 'sobel,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
    const notes = [...meta.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < notes.length; i++) if (notes[i] > notes[idx]) idx = i
  } catch { idx = 0 }
  // Multi-person Mix: read the outfit from the targeted person's strip, not the neighbor's
  const bande = job.mixTotal ? `,crop=iw/${job.mixTotal}:ih:iw*${job.mixRang ?? 0}/${job.mixTotal}:0` : ''
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', driverPath, '-vf', `select=eq(n\\,${idx})${bande}`, '-vframes', '1',
    path.join(CONFIG.comfyInput, src)], { stdio: ['ignore', 'ignore', 'pipe'] })
  store.setStatus(job.id, 'rendering')
  const tenue = await vision.describeOutfit(path.join(CONFIG.comfyInput, src))
  const p = persona(job.personaId)
  /* SFW lock for the reference: the outfit read may have only a bottom ("blue jeans") or only a
     top ("satin camisole"); the missing piece is requested and the whole outfit stays opaque. */
  const haut = /\b(shirt|t-?shirt|tee|top|blouse|sweater|jumper|hoodie|sweatshirt|pullover|jacket|coat|raincoat|parka|blazer|cardigan|vest|dress|jumpsuit|overalls|tunic|suit|bikini|swimsuit)\b/i.test(tenue ?? '')
  const bas = /\b(jeans|trousers|pants|shorts|skirt|leggings|dress|jumpsuit|overalls|suit|bikini|swimsuit)\b/i.test(tenue ?? '')
  const vetements = [tenue, !haut && 'a plain opaque top', !bas && 'plain opaque trousers'].filter(Boolean).join(', ')
  const positive = `full body photo, standing and facing the camera, arms relaxed, natural expression, `
    + `fully clothed, wearing ${vetements}, opaque fabric, soft even daylight, plain background, sharp focus, 50mm`
  const dv = videoSize(driverPath), portrait = !(dv.width > dv.height)
  const { workflow } = comfy.injectJob(comfy.loadWorkflow(RECIPES.sfw), {
    opTag: 'generate', positive, seed: job.seed, jobId: `${job.id}-ref`, identityPreamble: identityPreambleFor(job.personaId),
    width: portrait ? DEFAULT_SIZE.width : DEFAULT_SIZE.height, height: portrait ? DEFAULT_SIZE.height : DEFAULT_SIZE.width,
    loras: lorasPhoto(p, PHOTO_ENGINE),
  })
  const hist = await comfy.waitForPrompt(await comfy.submitPrompt(workflow, CLIENT_ID), { onPhase: () => store.setStatus(job.id, 'rendering') })
  const imgs = comfy.outputsOf(hist)
  if (!imgs.length) throw new Error('Mix : la référence du personnage n’a rendu aucune image')
  fs.writeFileSync(path.join(CONFIG.comfyInput, ref), await comfy.readImage(imgs[0]))
  console.log(`[job ${job.id}] Mix : référence de ${p.name || job.personaId} en pied (image ${idx} du driver, tenue : ${tenue ?? 'non lue'})`)
  return ref
}

/* Person Swap: SCAIL-2 (Wan 2.1 14B, MIT), official ComfyUI recipe
   (character replacement, 6 steps, lightx2v, DPO LoRA). SAM3 tracks the person in the clip
   and in the reference; the clip is rendered in 81-frame blocks, each later block
   color-matched to the end of the first. Beyond that, WanAnimate is used. */
export const SWAP_SCAIL_RECIPE = 'PROD_swap_scail2.json'
/* Blocks of 81 frames, not 76 (5 anchor frames): 2 blocks = 157 frames like the recipe, 6 blocks = 461 frames,
   about 29 s at 16 fps. Beyond that, RAM becomes the risk (all decoded frames stay in RAM). */
const SCAIL_BLOCS_MAX = 6
const scailBlocs = n => Math.max(2, 1 + Math.ceil(Math.max(0, n - 81) / 76))
/* Two blocks (about 10 s) for everyone, like the recipe; up to six for the chained dance (duration set
   by the server) and for the owner (swapBlocs): on the demo, a visitor must not hold the GPU for 15 minutes. */
const scailBlocsPermis = job => Math.min(SCAIL_BLOCS_MAX, Math.max(2, Number.isInteger(job.swapBlocs) ? job.swapBlocs : 2))
// is the SCAIL-2 model visible to ComfyUI (wherever it is stored)? checked once a minute
let scailVu = { quand: 0, ok: false }
async function scailDisponible() {
  if (Date.now() - scailVu.quand < 60_000) return scailVu.ok
  try {
    const d = await (await fetch(`${CONFIG.comfyUrl}/object_info/UNETLoader`, { signal: AbortSignal.timeout(10_000) })).json()
    const noms = d?.UNETLoader?.input?.required?.unet_name?.[0] ?? []
    scailVu = { quand: Date.now(), ok: noms.includes('wan2.1_14B_SCAIL_2_int8_convrot.safetensors') }
  } catch { scailVu = { quand: Date.now(), ok: false } }
  return scailVu.ok
}
function grapheSwapScail(job, motion, applied) {
  const g = comfy.loadWorkflow(SWAP_SCAIL_RECIPE)
  const req = (id, classe) => { if (g[id]?.class_type !== classe) throw new Error(`Swap : la recette « ${SWAP_SCAIL_RECIPE} » a changé (nœud ${id} ≠ ${classe})`) }
  req('30', 'LoadImage'); req('155', 'LoadVideo'); req('271', 'SaveVideo'); req('213:3', 'CLIPTextEncode'); req('262:258', 'CLIPTextEncode')
  g['30'].inputs.image = motion.refName
  g['155'].inputs.file = path.basename(motion.driverPath)
  const scene = `${(job.motionSceneText || job.composedPositive || '').trim()}, an adult woman, fully clothed, natural light`.replace(/^, /, '')
  for (const k of ['213:3', '262:258']) g[k].inputs.text = scene
  for (const k of ['213:191', '262:242']) g[k].inputs.text = 'person'
  for (const k of ['213:19', '262:227']) g[k].inputs.noise_seed = Number(job.seed) || 42
  // frame: long side 896, the other scaled, multiples of 32
  const { width: w, height: h } = videoSize(motion.driverPath)
  const paysage = !(h > w)
  // 896 by default; the owner can go up to 1280: fewer visible defects on a close shot
  const long = Number.isInteger(job.swapLong) ? Math.min(1280, Math.max(640, job.swapLong)) : 896
  const court = Math.round((long * (paysage ? (h || 9) / (w || 16) : (w || 9) / (h || 16))) / 32) * 32
  for (const [lw, lh] of [['213:178', '213:179'], ['262:236', '262:237']]) {
    g[lw].inputs.value = paysage ? long : court
    g[lh].inputs.value = paysage ? court : long
  }
  g['271'].inputs.filename_prefix = `creatoros/${job.id}/out`
  /* Long shots: the recipe stops at two blocks (157 frames). SCAIL-2 can chain: each block starts from
     the previous block's last 5 DECODED frames (previous_frames), so motion continues instead of joining two
     independent renders. The second block is cloned as many times as needed; models, encoders and reference
     tracking stay shared, and each block's color is matched to the end of the first as in the recipe. */
  const blocs = scailBlocs(motion.frames)
  const PAR_BLOC = ['235', '240', '241', '218', '220', '244', '245', '259', '227', '250', '251', '252']
  for (let k = 3; k <= blocs; k++) {
    const pre = `b${k}:`
    const renomme = v => (Array.isArray(v) && typeof v[0] === 'string' && v[0].startsWith('262:') && PAR_BLOC.includes(v[0].slice(4))
      ? [pre + v[0].slice(4), v[1]] : v)
    for (const id of PAR_BLOC) {
      const n = JSON.parse(JSON.stringify(g[`262:${id}`]))
      for (const [cle, v] of Object.entries(n.inputs)) n.inputs[cle] = renomme(v)
      g[pre + id] = n
    }
    g[`${pre}240`].inputs.value = k
    g[`${pre}259`].inputs.previous_frames = [k === 3 ? '262:250' : `b${k - 1}:250`, 0]
    g['269'].inputs[`images.image${k - 1}`] = [`${pre}252`, 0]
  }
  if (blocs > 2) applied.push(`SCAIL-2 : ${blocs} blocs enchaînés (${motion.frames} images), chacun ancré sur les 5 dernières images du précédent`)
  /* Animation mode (owner option): the still's character stays in ITS scene and takes on
     the driver's motion, instead of replacing the driver's person in the driver's scene. */
  if (job.swapAnimation === true && g['213:203'] && g['262:247']) {
    g['213:203'].inputs.value = false; g['262:247'].inputs.value = false
    applied.push('SCAIL-2 en mode animation (décor de la still)')
  }
  applied.push(`Swap : SCAIL-2 (remplacement de personnage, recette officielle ComfyUI), référence ${motion.refName}, `
    + `${paysage ? long : court}×${paysage ? court : long}, SAM3 « person »`)
  return g
}

/** Mix: the replacement recipe, injected by node ids (see MIX_RECIPE). */
async function grapheMix(job, motion, applied, skipped) {
  const mg = comfy.loadWorkflow(MIX_RECIPE)
  mg['63'].inputs.video = job.motionDriver
  /* Pose taken from another video with the same framing (e.g. the 3D scene mannequin, whose motion is exact);
     scene and mask stay the driver's. */
  if (job.motionPoseDriver && fs.existsSync(path.join(CONFIG.comfyInput, job.motionPoseDriver))) {
    mg.poseSrc = JSON.parse(JSON.stringify(mg['63']))
    mg.poseSrc.inputs.video = job.motionPoseDriver
    mg['73'].inputs.image = ['poseSrc', 0]
    applied.push(`pose lue sur ${job.motionPoseDriver} (DWPose), décor et masque du driver`)
  }
  mg['57'].inputs.image = motion.refName
  mg['65'].inputs.positive_prompt = job.motionSceneText || (job.composedPositive || '').trim()
  /* Mix SFW lock: without an outfit directive, a driver in swimwear can render an undressed
     body. Every Mix states the character stays clothed and rejects nudity. Do not remove. */
  mg['65'].inputs.positive_prompt = `${mg['65'].inputs.positive_prompt}, an adult woman, fully clothed, same outfit coverage on every frame`.replace(/^, /, '')
  mg['65'].inputs.negative_prompt = `${mg['65'].inputs.negative_prompt ?? ''}, nude, naked, nudity, topless, bottomless, bare breasts, bare crotch, genitals`.replace(/^, /, '')
    || 'a young woman, photorealistic, natural skin, cinematic'
  mg['27'].inputs.seed = job.seed
  mg['998'].inputs.filename_prefix = `creatoros/${job.id}/out`
  /* Settings: no relight, relaxed distill (0.8), 28 steps,
     ONE window covering the whole driver (several windows desync the background). */
  const wan = persona(job.personaId).videoLoras.filter(l => /wan/i.test(l.name) && !/wan.?2\.?1|wan21|ltx/i.test(l.name))
  const haut = wan.find(l => /high/i.test(l.name)), bas = wan.find(l => /low/i.test(l.name))
  // the recipe's relight LoRA degrades the render (colors and face): it stays off
  if (!job.mixRelight) mg['171'].inputs.lora_0 = 'none'
  else applied.push('relight WanAnimate : lumière du décor appliquée au personnage')
  mg['171'].inputs.strength_1 = 0.8
  if (haut && bas) {
    mg['171'].inputs.lora_2 = haut.name; mg['171'].inputs.strength_2 = 0.9
    mg['171'].inputs.lora_3 = bas.name; mg['171'].inputs.strength_3 = 0.9
    applied.push(`LoRA d'identité Wan du personnage : ${haut.name} · ${bas.name} (0.9)`)
  } else skipped.push('pas de LoRA d’identité Wan (haut + bas bruit) pour ce personnage : l’identité ne tient que par la still')
  mg['27'].inputs.steps = 28
  /* Driver face tracked (DWPose), but at half strength:
     at 1 the driver's mouth shows as a dark patch on the still's face;
     without the face branch the face comes out blurry and featureless. */
  mg['73'].inputs.detect_face = 'enable'
  mg['62'].inputs.face_strength = 0.5
  /* Length: a long driver in a single window does not fit on the GPU. The driver
     is cut to 153 frames (9.6 s); up to 81 frames one window (cleaner on a short
     clip), beyond that two windows overlapping by one frame (2w - 1 >= n). */
  const MIX_MAX_IMAGES = 153
  const n = Math.min(motion.frames, MIX_MAX_IMAGES)
  mg['63'].inputs.frame_load_cap = n
  const pas4 = k => Math.ceil((k - 1) / 4) * 4 + 1
  mg['62'].inputs.frame_window_size = n <= 81 ? pas4(n) : pas4((n + 1) / 2)
  if (n < motion.frames) skipped.push(`driver coupé à ${MIX_MAX_IMAGES} images (9,6 s) sur ${motion.frames} : limite du Mix sur la démo`)
  // validated pixel budget (~832x480), in the driver's aspect, multiple of 16
  const dv = videoSize(path.join(CONFIG.comfyInput, job.motionDriver))
  const BUDGET = 832 * 480, ar = dv.width && dv.height ? dv.width / dv.height : 480 / 832
  const mw = Math.max(16, Math.round(Math.sqrt(BUDGET * ar) / 16) * 16), mh = Math.max(16, Math.round(BUDGET / mw / 16) * 16)
  mg['150'].inputs.value = mw; mg['151'].inputs.value = mh
  // automatic mask: GroundingDINO finds the subject -> SAM2 points
  try {
    // run without blocking the server: detection can take up to 3 minutes
    const raw = (await executer(COMFY_PY, [GDINO_POINTS, path.join(CONFIG.comfyInput, job.motionDriver), String(mw), String(mh), job.mixTotal ? 'person' : 'woman', ...(job.mixTotal ? [String(job.mixRang ?? 0), String(job.mixTotal)] : [])],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, COMFY_DIR: CONFIG.comfyDir } })).stdout
    const pts = JSON.parse(raw.trim().split('\n').pop())
    Object.assign(mg['107'].inputs, { width: mw, height: mh, normalize: false,
      points_store: JSON.stringify({ positive: pts.positive, negative: [] }), coordinates: JSON.stringify(pts.positive) })
    delete mg['104'].inputs.coordinates_negative
    applied.push(`masque automatique : sujet « woman », ${pts.positive.length} points`)
  } catch (e) {
    if (job.mixTotal) throw new Error(`Mix à plusieurs : personnes non trouvées sur le clip (${String(e.stderr || e.message || e).slice(-100)})`)
    skipped.push(`masque automatique indisponible (${String(e.message || e).slice(0, 80)}) : points par défaut de la recette`)
  }
  applied.push(`Mix WanAnimate : la still « ${motion.refName} » dans le décor du driver (${n} images), ${mw}×${mh}`)
  return mg
}

/* Reference images: each goes through the latent and is added to the conditioning
   (chained ReferenceLatent), FLUX.2 style. */
/* References on Klein: a character without a Klein LoRA does not keep their face there. Their profile
   photo then becomes the first reference, and the prompt refers to it. */
function visageDuPersonnage(job, g, applied) {
  const p = persona(job.personaId)
  if (!p || p.lorasKlein?.length || job.personaId === SANS_PERSONNAGE) return []
  const id = String(job.personaId ?? '').replace(/[^a-z0-9_]/g, '')
  const photo = ['.png', '.jpg', '.webp'].map(e => path.join(CONFIG.mediaDir, '.persona', id, `avatar${e}`)).find(f => fs.existsSync(f))
  if (!photo) { applied.push(`pas de photo de profil pour ${p.name || id} : le visage n'est pas tenu sur Klein`); return [] }
  const nom = `PAV_${id}${path.extname(photo)}`
  fs.copyFileSync(photo, path.join(CONFIG.comfyInput, nom))
  let n = g[Object.values(g).find(x => x.class_type === 'KSampler')?.inputs.positive?.[0]]
  while (n && n.class_type !== 'CLIPTextEncode') n = g[Object.values(n.inputs).find(v => Array.isArray(v))?.[0]]
  if (n) n.inputs.text = `The woman in the first reference image is ${p.name?.replace(/\s*\(.*\)\s*/g, '') || 'the main character'}: keep her face exactly. ${n.inputs.text}`
  applied.push(`photo de profil de ${p.name || id} en première référence (visage)`)
  return [nom]
}

function appliquerReferences(g, noms, applied, moteur = 'klein') {
  const k = Object.values(g).find(n => n.class_type === 'KSampler')
  const vae = Object.entries(g).find(([, n]) => n.class_type === 'VAELoader')?.[0]
  if (!k || !vae) throw new Error('références : la recette n’a ni KSampler ni VAE')
  if (moteur === 'flux3') {
    // FLUX 3 Image Klein reads its references through one node, on both conditionings (each image scaled to ~1 MP)
    const entrees = { positive: k.inputs.positive, negative: k.inputs.negative, vae: [vae, 0], resolution: 'resize', 'resolution.megapixels': 1 }
    noms.forEach((image, i) => {
      g[`ref${i}`] = { class_type: 'LoadImage', inputs: { image } }
      entrees[`images.image${i}`] = [`ref${i}`, 0]
    })
    g.refs_flux3 = { class_type: 'ReferenceMultiLatent', inputs: entrees }
    k.inputs.positive = ['refs_flux3', 0]; k.inputs.negative = ['refs_flux3', 1]
    applied.push(`${noms.length} image(s) de référence sur FLUX 3 Image Klein (ReferenceMultiLatent)`)
    return
  }
  let pos = k.inputs.positive
  noms.forEach((image, i) => {
    g[`ref${i}`] = { class_type: 'LoadImage', inputs: { image } }
    g[`refs${i}`] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [`ref${i}`, 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 } }
    g[`refl${i}`] = { class_type: 'VAEEncode', inputs: { pixels: [`refs${i}`, 0], vae: [vae, 0] } }
    g[`refc${i}`] = { class_type: 'ReferenceLatent', inputs: { conditioning: pos, latent: [`refl${i}`, 0] } }
    pos = [`refc${i}`, 0]
  })
  k.inputs.positive = pos
  applied.push(`${noms.length} image(s) de référence sur FLUX.2 Klein (ReferenceLatent)`)
}

/** Multi-person Mix: the rendered clip becomes the source of the next pass, for the next person. */
function lancerMixSuivant(job, livre) {
  const [perso, ...reste] = job.mixSuite
  const nom = `MIXS_${job.id}.mp4`
  fs.copyFileSync(livre.full, path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  enqueue({ mode: 'video', register: 'sfw', purpose: 'creative', personaId: perso, motionDriver: nom, motionMode: 'replace', motionPreview: false,
    motionSceneText: job.motionSceneText || undefined, composedPositive: job.composedPositive, userPrompt: job.userPrompt,
    mixRang: job.mixRang + 1, mixTotal: job.mixTotal, mixSuite: reste })
}

async function runJob(job, isRetry = false, connRetried = false) {
  const t0 = Date.now()
  try {
    if (job.op === 'photo_hd') return await runPhotoHd(job, t0)
    if (job.op === 'inpaint') return await runInpaint(job, t0)
    // these clips are also checked, without retry: they cannot be replayed like a regular clip
    const controler = n => { void controlerJob(job, null).catch(e => console.warn(`[contrôle] ${String(e.message || e).slice(0, 200)}`)); return n }
    if (job.op === 'inpaint_video') return controler(await runInpaintVideo(job, t0))
    if (job.op === 'parole') return controler(await runParole(job, t0))
    if (job.op === 'reshoot' || job.op === 'cleanplate' || job.op === 'stage' || job.op === 'effetltx' || job.op === 'danse3d') return controler(await runReshoot(job, t0))
    if (job.op === 'detour') return await runDetour(job, t0)
    if (job.op === 'objet3d') return await runObjet3d(job, t0)
    if (job.op === 'doublage') return await runDoublage(job, t0)
    if (job.op === 'recadrage') return controler(await runRecadrage(job, t0))
    if (job.op === 'extension') return await runExtension(job, t0)
    if (job.op === 'entrainement') return await runEntrainement(job, t0)
    if (job.op === 'restauration_hd') return await runRestaurationHd(job, t0)
    if (job.op === 'musique') return await runMusique(job, t0)
    if (job.op === 'transition') return await runTransition(job, t0)
    if (job.op === 'planlong') return await runPlanLong(job, t0)
    if (job.op === 'transparent') return await runTransparent(job, t0)
    if (job.op === 'profondeur') return await runProfondeur(job, t0)
    if (job.op === 'seedvr') return await runSeedvr(job, t0)
    if (job.op === 'coloriser_video') return await runColoriserVideo(job, t0)
    if (job.op === 'foley' || job.op === 'interpolate') return await runFinition(job, t0)
    if (job.op === 'essayage' || job.op === 'photodump') return await runKleinRef(job, t0)
    if (job.op === 'style_ref') return await runStyleRef(job, t0)
    if (job.op === 'upscale' && job.upscaleH3)
      return await runUpscaleH3(job, t0)
    if (job.op === 'upscale' && typeof job.upscaleSource === 'string')
      return await runUpscale(job, t0)
    const base = comfy.loadWorkflow(job.workflowFile)
    // Retouch is an EDIT of a source image: no identity preamble (the given image is
    // modified, the subject is not regenerated), framing and LoRAs come from the
    // source, the composed instruction is the edit text.
    const isEdit = job.op === 'edit'
    /* Video is a CONTINUATION recipe: identity, body, outfit and scenery are already
       in the start image. Prefixing the identity preamble drowns the motion brief,
       and a photo LoRA's trigger word means nothing to the LTX or MiniMax encoder. */
    const isVideo = job.mode === 'video'
    // the character from the SUBMISSION, not the active one (it may have changed since)
    const p = persona(job.personaId)
    /* Exception: a persona's VIDEO identity LoRA has learned the trigger word and
       is inert without it. The word alone, no preamble. */
    /* Ambient shot (T2V): NO character, no trigger word, no identity LoRA. */
    /* Text to video WITH the character (`t2vPersonnage`): only if it has a video
       LoRA, which carries the identity since there is no image. */
    /* The character's video LoRAs FILTERED by engine family: an LTX LoRA does not
       belong on a Wan graph, nor a Wan 2.2 one on the Wan 2.1 effects graph. The
       name gives the family; with no hint, the LoRA is allowed everywhere. */
    const familleLora = n => /ltx/i.test(n) ? 'ltx' : /wan.?2\.?1|wan21/i.test(n) ? 'wan21' : /wan/i.test(n) ? 'wan' : null
    const familleMoteur = /^ltx/.test(job.videoEngine ?? '') ? 'ltx' : /^wan21/.test(job.videoEngine ?? '') ? 'wan21' : /^wan/.test(job.videoEngine ?? '') ? 'wan' : null
    const persoVideo = p.videoLoras.filter(l => { const f = familleLora(String(l.name)); return !f || !familleMoteur || f === familleMoteur })
    const texteSeul = isVideo && job.t2v === true
    const ambiance = texteSeul && !(job.t2vPersonnage === true && persoVideo.length)
    const preamble = isEdit || ambiance ? null
      /* + the character's preamble: some video LoRAs learned a whole phrase
         ("Aisha-AW, she has dark hair") that the single-token trigger field cannot hold. */
      : isVideo ? (persoVideo.length && p.trigger ? { key: 'persona-video', file: null, text: `${p.trigger}, ${p.preamble ? `${p.preamble}, ` : ''}an adult woman in her mid-twenties, ` } : null)
      : identityPreambleFor(job.personaId, job.mode === 'photo' ? (job.photoEngine ?? CONFIG.photoEngine) : undefined, `${job.userPrompt ?? ''} ${job.composedPositive ?? ''}`)

    // Trigger words of the LoRAs stacked by the JOB. Without its word in the prompt
    // a LoRA is loaded but has no effect. The server resolves the word from the
    // file; a word supplied by the job overrides it. Persona LoRAs do not need it:
    // their word already leads the preamble.
    const triggers = []
    const triggerLoras = isVideo ? (job.videoLoras ?? []) : (job.loras ?? [])
    for (const l of triggerLoras) {
      const info = comfy.loraInfo(l.name)
      const word = (l.trigger ?? info?.trigger ?? '').trim()
      if (word) {
        triggers.push(word)
        l.trigger = word
        l.triggerSource = l.trigger && !info?.trigger ? 'job' : info?.triggerSource ?? 'job'
      }
    }
    /* A trigger may be a full activation PHRASE (table): let it end with its period;
       short words are joined with commas. */
    const triggerTxt = triggers.map(t => (/[.!?]$/.test(t) ? t + ' ' : t + ', ')).join('')
    /* Wildcard draws use the job's seed: reproducible, and the drawn line is
       recorded in provenance. Then T0 is rerun on the RESOLVED text (the front end
       only saw the token). A blocked term fails the job explicitly. */
    let drawn = wildcards.resolve(triggerTxt + job.composedPositive, job.seed)
    /* FLUX 3: the scene goes through the official rewriter (full description), the character's trigger
       stays first. Falls back to the original text if the LLM fails, so the render still runs. */
    const flux3Photo = job.mode === 'photo' && !isEdit && (job.photoEngine === 'flux3' || /flux3/.test(String(job.workflowFile ?? '')))
    const personnageFlux3 = !!job.personaId && job.personaId !== SANS_PERSONNAGE && lorasPhoto(persona(job.personaId), 'flux3').length > 0
    // with reference images, the prompt names what each reference is ("the woman from the first reference image…"):
    // the rewriter would describe another person and another outfit over it, and FLUX 3 would follow the text
    if (flux3Photo && !job.flux3Brut && !job.references?.length) {
      const scene = drawn.text.startsWith(triggerTxt) ? drawn.text.slice(triggerTxt.length) : drawn.text
      if (aReecrire(scene)) {
        try {
          const t0r = Date.now()
          const riche = await reecrireFlux3(scene, { largeur: job.width, hauteur: job.height, personnage: personnageFlux3 })
          drawn = { ...drawn, text: triggerTxt + riche }
          store.noterPromptReecrit(job.id, riche)
          console.log(`[job ${job.id}] FLUX 3 : prompt réécrit (${riche.split(/\s+/).length} mots, ${Date.now() - t0r} ms)`)
        } catch (e) { console.warn(`[job ${job.id}] FLUX 3 : réécriveur indisponible, prompt d'origine (${e.message})`) }
      }
    }
    // Video with audio: the quoted line is the ONLY speech (see speechGuard).
    const speech = (isVideo && job.withAudio && job.videoEngine !== 'motion') ? speechGuard(drawn.text) : null
    // SFW photo: the recipe runs without an effective negative prompt (cfg 1), so an opaque outfit is requested explicitly
    // (without T0 filter words, which the final prompt then goes through)
    /* Adult mode (local install): only when NO face can come from a real person: no character, no LoRA
       (an imported LoRA may carry a real face), no imported photo (a source of unknown origin counts as
       imported). The minors floor always applies. */
    const entrees = [job.sourceImage, job.endImage, ...(job.references ?? []), ...(job.keyframes ?? []).map(k => k.image)].filter(x => typeof x === 'string' && x.trim())
    const adulteLibre = CONFIG.contenuAdulte && (!job.personaId || job.personaId === SANS_PERSONNAGE)
      && !(job.loras ?? []).length && !(job.videoLoras ?? []).length
      && entrees.every(n => store.origineInput(path.basename(n)) === 'genere')
    /* The outfit directive only applies if there is someone to dress: on an empty landscape,
       "fully covered" makes the model draw a draped figure. */
    const quelquun = (job.personaId && job.personaId !== SANS_PERSONNAGE) || HUMAIN.test(`${job.userPrompt ?? ''} ${job.composedPositive ?? ''}`)
    const vetuOpaque = !adulteLibre && !isVideo && !isEdit && job.register !== 'explicit' && job.mode === 'photo' && quelquun
    const texteBrut = speech?.text ?? drawn.text
    // swimwear on an adult is allowed: the directive then only asks for opaque fabric
    const maillot = /\b(bikini|swimsuit|swimwear|one-piece|swim trunks)\b/i.test(texteBrut)
    const positive = vetuOpaque ? `${texteBrut}, ${maillot ? '' : 'fully clothed, '}opaque fabric, fully covered` : texteBrut
    const wildcardNotes = [
      ...drawn.draws.map(d => `tirage wildcard ${d.token} → « ${d.value} »`),
      ...drawn.unknown.map(t => `wildcard ${t} INCONNU : aucun fichier dans ${CONFIG.wildcardsDir} — laissé tel quel`),
    ]
    const blocked = adulteLibre ? t0Mineur(positive) : t0Hit(positive)
    if (blocked)
      throw new Error(`T0 : terme bloqué « ${blocked} »`
        + (drawn.draws.length ? ' — apparu dans un tirage wildcard' : ' dans le prompt'))
    /* "Source" aspect: probe the still's ACTUAL file; front-end dims may be stale
       (e.g. after a clone). The payload is only a fallback if probing fails. */
    let videoSrcDims
    if (job.mode === 'video' && job.videoAspect === 'origine') {
      // End frame only: it defines the aspect.
      const cadre = job.sourceImage || job.endImage
      if (cadre) {
        const d = videoSize(path.join(CONFIG.comfyInput, cadre))
        if (d.width && d.height) videoSrcDims = { w: d.width, h: d.height }
      }
      if (!videoSrcDims && job.videoSrcW && job.videoSrcH)
        videoSrcDims = { w: job.videoSrcW, h: job.videoSrcH }
    }
    /* Persona LoRAs first (identity), then the job's (style). */
    const photoLoras = [...lorasPhoto(p, job.photoEngine ?? PHOTO_ENGINE), ...(job.loras ?? [])]
    const videoLorasEff = [...(ambiance ? [] : persoVideo), ...(job.videoLoras ?? [])]
    /* The motion graph cannot be injected generically (conditioning goes through
       WanAnimate2ToVideo, not a KSampler): its dedicated path writes the named
       nodes below, and generic injection does not run. */
    const { workflow, applied, skipped } = job.videoEngine === 'motion'
      ? { workflow: base, applied: [], skipped: [] }
      : comfy.injectJob(base, {
      opTag: isEdit ? 'edit' : 'generate',
      cameraPose: job.cameraPose,
      positive,
      negative: job.composedNegative,
      seed: job.seed,
      jobId: job.id,
      identityPreamble: preamble,
      // An edit recipe takes its framing from the source image: forcing dimensions
      // would crop it.
      width: (isEdit || isVideo) ? undefined : job.width,
      height: (isEdit || isVideo) ? undefined : job.height,
      // Photo: persona + job LoRAs. Video (not motion): video persona + job LoRAs,
      // stacked on the recipe's model chain. Edit: style LoRA only.
      loras: isEdit ? (STYLES_EDITION[job.editStyle] ? [{ name: STYLES_EDITION[job.editStyle], strength: 1 }] : undefined) : isVideo ? videoLorasEff : photoLoras,
      sourceImage: texteSeul ? (VIDEO_ENGINES[job.videoEngine]?.t2vNatif ? undefined : comfy.imageVideT2v()) : job.sourceImage ?? undefined,
      t2v: texteSeul && !VIDEO_ENGINES[job.videoEngine]?.t2vNatif,
      controlNet: job.controlNet ?? undefined,
      // Explicit `false` = "drop the audio stage"; `undefined` = recipe as is.
      // A photo recipe must not receive the directive.
      withAudio: job.mode === 'video' ? job.withAudio === true : undefined,
      // Duration to GENERATE, not delivered duration: on a slow-motion engine a longer
      // clip must be produced to deliver the right length after correction.
      videoSeconds: job.mode === 'video'
        ? job.videoSeconds * (job.videoSpeed ?? 1) : undefined,
      videoAspect: job.mode === 'video' ? (job.videoAspect ?? undefined) : undefined,
      videoSrcDims,
      // Draft: the ResolutionSelector area and the step count.
      videoMegapixels: job.videoDraft
        ? VIDEO_ENGINES[job.videoEngine]?.draft?.megapixels : undefined,
      /* Sampling steps: draft first, otherwise the engine's production value.
         `undefined` if the engine declares none, so the recipe keeps its own. */
      videoSteps: job.videoDraft
        ? VIDEO_ENGINES[job.videoEngine]?.draft?.steps
        : VIDEO_ENGINES[job.videoEngine]?.steps,
      endImage: job.mode === 'video' ? (job.endImage ?? undefined) : undefined,
      contexteVideo: job.mode === 'video' ? (job.contexteVideo ?? undefined) : undefined,
      keyframes: job.mode === 'video' && Array.isArray(job.keyframes) ? job.keyframes : undefined,
    })
    // Inputs declared in <recipe>.pilotage.json: applied after wiring (no file, no change).
    if (job.videoEngine !== 'motion')
      comfy.appliquerPilotage(job.workflowFile, workflow, { prompt: positive, negative: job.composedNegative, seed: job.seed,
        width: (isEdit || isVideo) ? undefined : job.width, height: (isEdit || isVideo) ? undefined : job.height,
        sourceImage: job.sourceImage ?? undefined }, applied, skipped)
    /* Generated Krea photos: direct 2 MP render (see comfy.rendre2MP).
       Not on retouches (they have their own graph); CREATOROS_PHOTO_2MP=0 reverts to 1 MP. */
    if (job.mode === 'photo' && !isEdit && /^PROD_gen_krea/.test(job.workflowFile ?? '')
        && process.env.CREATOROS_PHOTO_2MP !== '0') {
      const r = comfy.rendre2MP(workflow)
      if (r.manque) skipped.push(`2 MP non ajouté : ${r.manque}`)
      else applied.push(...r.notes)
    }
    /* FLUX 3 with the character LoRA: a small face in the frame (wide shot) comes out blurry and generic.
       FaceDetailer (Impact Pack) detects it, redraws it at 1024 px with the same LoRA and pastes it back:
       pose, light and scenery are unchanged. CREATOROS_FLUX3_VISAGE=0 disables it. */
    if (flux3Photo && personnageFlux3 && process.env.CREATOROS_FLUX3_VISAGE !== '0') {
      const ks = Object.entries(workflow).find(([, n]) => n.class_type === 'KSampler')
      const save = Object.entries(workflow).find(([, n]) => n.class_type === 'SaveImage')
      const clip = Object.entries(workflow).find(([, n]) => n.class_type === 'CLIPLoader')
      const vae = Object.entries(workflow).find(([, n]) => n.class_type === 'VAELoader')
      if (ks && save && clip && vae) {
        const [, k] = ks
        workflow.visage_txt = { class_type: 'CLIPTextEncode', inputs: { clip: [clip[0], 0], text: `${preamble?.text ?? ''}close-up photograph of her face, natural skin texture, sharp focus, same light and colour grade as the scene` } }
        workflow.visage_neg = { class_type: 'CLIPTextEncode', inputs: { clip: [clip[0], 0], text: '' } }
        workflow.visage_det = { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: 'bbox/face_yolov8m.pt' } }
        workflow.visage = { class_type: 'FaceDetailer', inputs: { image: save[1].inputs.images, model: k.inputs.model, clip: [clip[0], 0], vae: [vae[0], 0],
          guide_size: 1024, guide_size_for: true, max_size: 1024, seed: k.inputs.seed, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
          positive: ['visage_txt', 0], negative: ['visage_neg', 0], denoise: 0.6, feather: 8, noise_mask: true, force_inpaint: true,
          bbox_threshold: 0.4, bbox_dilation: 12, bbox_crop_factor: 2.4, sam_detection_hint: 'none', sam_dilation: 0, sam_threshold: 0.93,
          sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: 'False', drop_size: 10, bbox_detector: ['visage_det', 0], wildcard: '', cycle: 1 } }
        save[1].inputs.images = ['visage', 0]
        applied.push('FLUX 3 : visage redessiné à 1024 px avec la LoRA du personnage (FaceDetailer, denoise 0,6)')
      }
    }
    // Klein without a character LoRA: the profile photo holds the face, with or without references
    const kleinSansLora = job.mode === 'photo' && job.photoEngine === 'klein' && !isEdit
    if (job.references?.length || kleinSansLora) {
      // the profile photo as a face reference is a Klein mechanism; on FLUX 3 only the operator's references are sent
      const surFlux3 = job.photoEngine === 'flux3' && !isEdit
      const refs = [...(surFlux3 ? [] : visageDuPersonnage(job, workflow, applied)), ...(job.references ?? [])].slice(0, 6)
      if (refs.length) appliquerReferences(workflow, refs, applied, surFlux3 ? 'flux3' : 'klein')
      if (job.refVisage && job.personaId === SANS_PERSONNAGE) {
        let n = workflow[Object.values(workflow).find(x => x.class_type === 'KSampler')?.inputs.positive?.[0]]
        while (n && n.class_type !== 'CLIPTextEncode') n = workflow[Object.values(n.inputs).find(v => Array.isArray(v))?.[0]]
        if (n) n.inputs.text = `The person in the first reference image is the subject: keep their face, hair, skin tone and body exactly. ${n.inputs.text}`
        applied.push('sans personnage : le visage de la photo d’origine est tenu par la première référence')
      }
    }
    if (speech?.note) applied.unshift(speech.note)
    if (drawn.draws.length) applied.unshift(...wildcardNotes.filter(n => n.startsWith('tirage')))
    if (drawn.unknown.length) skipped.push(...wildcardNotes.filter(n => !n.startsWith('tirage')))
    if (triggers.length) applied.unshift(`déclencheurs LoRA préfixés au prompt : ${triggers.join(' · ')}`)
    // A LoRA without a trigger fails silently: report it loudly.
    for (const l of job.loras ?? []) {
      if (!l.trigger)
        skipped.push(`LoRA « ${l.name} » empilée SANS mot déclencheur — elle sera chargée `
          + 'mais restera probablement inerte ; saisir le mot dans l’interface')
    }
    skipped.forEach(s => console.warn(`[job ${job.id}] non injecté — ${s}`))

    /* Motion Control: the generic graph injected above does not apply (it is not
       the one executed). Start again from the recipe and write the NAMED nodes
       (see MOTION_NODES). */
    let finalWorkflow = workflow
    if (job.videoEngine === 'motion' && job.motionMode === 'replace') {
      const ref = await buildMotionRef(job)
      // one person and a short clip: SCAIL-2; several people or longer: WanAnimate
      const scail = !job.mixTotal && !job.mixWanAnimate && scailBlocs(ref.frames) <= scailBlocsPermis(job) && await scailDisponible()
      finalWorkflow = scail ? grapheSwapScail(job, ref, applied) : await grapheMix(job, ref, applied, skipped)
      /* Free the GPU before Wan-Animate: models left loaded (e.g. by the reference
         render or an interrupted render) leave too little memory for WanVideoWrapper. */
      await comfy.freeMemory().catch(() => { /* non-fatal */ })
    } else if (job.videoEngine === 'motion') {
      const motion = await buildMotionRef(job)
      const g = structuredClone(base)
      g[MOTION_NODES.ref].inputs.image = motion.refName
      g[MOTION_NODES.driver].inputs.file = job.motionDriver
      // 4k+1 <= driver frames: the latent's time step is 4 frames.
      g[MOTION_NODES.animate].inputs.length = Math.max(9, Math.floor((motion.frames - 1) / 4) * 4 + 1)
      // The prompt describes WHAT THE REFERENCE SHOWS, never a generic character
      // (that makes identity drift). The operator text only carries the MOTION;
      // without it, a neutral directive.
      const motionTxt = (job.composedPositive || '').trim()
        || 'The person moves naturally'
      /* The MAIN prompt describes character + scene + interaction: the only channel
         for CONTEXT (a held object, a changing scene), since the motion branch only
         follows the driver's main subject. The operator can provide it in full
         (motionSceneText), VERBATIM, to describe the driver's actual action. Without
         scene text, a neutral opener. */
      g[MOTION_NODES.prompt].inputs.text = job.motionSceneText
        ? job.motionSceneText.trim()
        : 'The person from the reference image. ' + motionTxt
      g[MOTION_NODES.motion].inputs.text = motionTxt
      /* Continuity between context windows: overlap raised to 12 (window = 21
         latents) for fewer visible seams on large motions, without affecting likeness
         (unlike reference_image_strength). */
      if (g[MOTION_NODES.context]?.inputs) g[MOTION_NODES.context].inputs.context_overlap = 12
      /* Without accelerator: the distillation LoRA (6 steps, cfg 1) smooths textures.
         Without it, standard Wan sampling: 20 steps, cfg 5, uni_pc (about 6x longer). */
      if (job.motionSansTurbo === true && g['261:11'] && g['261:18'] && g['261:19']) {
        for (const n of Object.values(g)) for (const [k, v] of Object.entries(n.inputs ?? {}))
          if (Array.isArray(v) && v[0] === '261:11') n.inputs[k] = ['261:239', 0]
        delete g['261:11']
        g['261:18'].inputs.steps = 20
        g['261:19'].inputs.cfg = 5
        g['261:27'].inputs.sampler_name = 'uni_pc'
        applied.push('motion sans accélérateur : 20 pas, cfg 5, uni_pc')
      } else if (job.motionDistill !== false && !Number.isFinite(job.motionTurbo) && !Number.isInteger(job.motionPas)
        && g['261:239'] && g['261:11'] && g['261:18'] && g['261:19']) {
        /* Default: the DISTILLED Wan Animate 2 model (from the official ComfyUI template). It needs no
           acceleration LoRA: 10 steps, cfg 1, lcm. Cleaner than base model + lightx2v LoRA (less smoothed
           skin and fabric) for the same time. motionDistill: false, or an accelerator setting, reverts to
           the base model (owner options). */
        g['261:239'].inputs.unet_name = 'wan_animate_2_distill_int8_convrot.safetensors'
        for (const n of Object.values(g)) for (const [k, v] of Object.entries(n.inputs ?? {}))
          if (Array.isArray(v) && v[0] === '261:11') n.inputs[k] = ['261:239', 0]
        delete g['261:11']
        g['261:18'].inputs.steps = 10; g['261:19'].inputs.cfg = 1; g['261:27'].inputs.sampler_name = 'lcm'
        applied.push('motion : Wan Animate 2 distillé, sans LoRA, 10 pas, cfg 1, lcm')
      } else if (g['261:11'] && g['261:18'] && g['261:19']) {
        /* Accelerator softened by default: at full strength (6 steps) it smooths fabric and skin; at 0.7 over
           10 steps folds come back without losing motion (about 1.5x longer). Owner-adjustable. */
        g['261:11'].inputs.strength_model = Number.isFinite(job.motionTurbo) ? job.motionTurbo : 0.7
        g['261:18'].inputs.steps = Number.isInteger(job.motionPas) ? job.motionPas : 10
        if (Number.isFinite(job.motionCfg)) g['261:19'].inputs.cfg = job.motionCfg
        applied.push(`motion : accélérateur ${g['261:11'].inputs.strength_model}, ${g['261:18'].inputs.steps} pas, cfg ${g['261:19'].inputs.cfg}`)
      }
      /* Motion branch: by default it also receives the CLIP image of the driver's first frame. A synthetic
         driver (3D mannequin) passes its CGI look on to the character that way.
         motionVisionRef: the motion branch sees the still instead; motionPoseFin: the driver's influence
         stops before the end of sampling (choreography is set early, detail then comes from the still).
         Owner test settings. */
      if (job.motionVisionRef === true && g[MOTION_NODES.animate]?.inputs?.clip_vision_output)
        g[MOTION_NODES.animate].inputs.clip_vision_output_pose = g[MOTION_NODES.animate].inputs.clip_vision_output
      if (Number.isFinite(job.motionPoseFin)) g[MOTION_NODES.animate].inputs.pose_end_percent = job.motionPoseFin
      if (job.motionVisionRef === true || Number.isFinite(job.motionPoseFin))
        applied.push(`branche mouvement : ${job.motionVisionRef ? 'vision de la still' : 'vision du driver'}, driver jusqu’à ${g[MOTION_NODES.animate].inputs.pose_end_percent}`)
      if (Number.isFinite(job.motionPoseStrength))
        g[MOTION_NODES.animate].inputs.pose_strength = job.motionPoseStrength
      if (Number.isFinite(job.motionRefStrength))
        g[MOTION_NODES.animate].inputs.reference_image_strength = job.motionRefStrength
      g[MOTION_NODES.seed].inputs.noise_seed = job.seed
      g[MOTION_NODES.save].inputs.filename_prefix = `creatoros/${job.id}/out`
      if (g[MOTION_NODES.animate].inputs.length > MOTION_CHUNK && job.motionJoin !== 'fenetres') {
        const total = g[MOTION_NODES.animate].inputs.length
        const n = chainMotionChunks(g, job.seed)
        applied.push(`clip long : ${total} images enchaînées en ${n} morceaux de ${MOTION_CHUNK} (sans fenêtres de contexte)`)
      }
      if (job.motionSceneText) applied.push('prompt scène/contexte fourni par l’opérateur')
      if (job.motionPoseStrength !== 1) applied.push(`pose_strength = ${job.motionPoseStrength}`)
      if (job.motionRefStrength !== 1) applied.push(`reference_image_strength = ${job.motionRefStrength}`)
      applied.push(`réf = still fournie telle quelle : ${motion.refName}`,
        `#${MOTION_NODES.animate} length = ${g[MOTION_NODES.animate].inputs.length} images `
        + `(driver ${motion.frames} à ${motion.fps.toFixed(1)} fps)`)
      finalWorkflow = g
    }

    /* NO VRAM unload here: POST /free unloads EVERYTHING (free_memory implies
       unload_all_models), and the cold reload that follows can hit a fragmentation
       OOM at the first sampler on heavy recipes. ComfyUI's progressive management
       works better with resident models; alternation is avoided by sorting the
       queue by recipe. */
    const promptId = await comfy.submitPrompt(finalWorkflow, CLIENT_ID)
    current = { jobId: job.id, promptId }
    store.markStarted(job.id, promptId)
    console.log(`[job ${job.id}] ComfyUI prompt_id=${promptId}`)

    const history = await comfy.waitForPrompt(promptId, {
      /* ComfyUI "queued" != CreatorOS "queued": the prompt is ALREADY submitted.
         Distinguishing them lets recoverQueue re-attach it on restart
         (orphanedRunningRows knows 'queued-comfy') instead of resubmitting it
         (queuedPayloads only picks up 'queued'). */
      onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
    })
    const n = await harvestJob(job, promptId, history,
      { applied, skipped, preamble, clause: '', finalWorkflow })
    const ms = Date.now() - t0
    store.markFinished(job.id, ms)
    console.log(`[job ${job.id}] terminé en ${(ms / 1000).toFixed(1)} s — ${n} image(s)`)
    // clip checking, off the critical path: the queue continues without waiting for it
    void controlerJob(job, p => enqueue(p)).catch(e => console.warn(`[contrôle] ${String(e.message || e).slice(0, 200)}`))
    if (/^danse3d-[a-z0-9]+-swap$/.test(job.id)) {
      try { finaliserDanse3d(job) } catch (e) { console.warn(`[job ${job.id}] finition de la danse 3D — ${e.message || e}`) }
    }
  } catch (e) {
    /* ComfyUI unreachable (restart, crash restarted by the supervisor): the job is
       not at fault. Wait for it to answer and retry ONCE, otherwise the whole queue
       would drain as "blocked" during a ComfyUI restart. */
    if (annulesEnCours.delete(job.id)) {
      store.markFailed(job.id, Date.now() - t0, 'annulé par l’utilisateur pendant le rendu')
      console.log(`[job ${job.id}] annulé pendant le rendu`)
      return
    }
    const isConn = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(e.message || e))
    if (isConn && !connRetried) {
      console.warn(`[job ${job.id}] ComfyUI injoignable — attente puis relance`)
      store.setStatus(job.id, 'retry')
      current = null
      try { await comfy.waitReady() } catch (e2) {
        store.markFailed(job.id, Date.now() - t0, e2.message || e2)
        console.error(`[job ${job.id}] ÉCHEC — ${e2.message || e2}`)
        return
      }
      return runJob(job, isRetry, true)
    }
    /* Video OOM: ONE retry after a pause. The first run can fail depending on what
       ComfyUI still holds in VRAM; the second usually succeeds (the OOM itself frees
       memory). A double failure is a real overflow. */
    const isOom = /out of memory|OutOfMemory|Allocation on device/i.test(String(e.message || e))
    if (isOom && job.mode === 'video' && !isRetry) {
      console.warn(`[job ${job.id}] OOM — retry unique dans 45 s`)
      store.setStatus(job.id, 'retry')
      await new Promise(r => setTimeout(r, 45000))
      current = null
      return runJob(job, true)
    }
    if (/^HTTP 40[13]$/.test(String(e.message))) e = new Error('clé Comfy Cloud refusée : la corriger ou l’effacer dans Paramètres → Comfy Cloud')
    store.markFailed(job.id, Date.now() - t0, e.message || e)
    console.error(`[job ${job.id}] ÉCHEC — ${e.message || e}`)
  } finally {
    current = null
  }
}

/** Writes the outputs of a FINISHED prompt: files, post-processing, assets +
 *  provenance. Separate from runJob so restart recovery can harvest an orphaned
 *  render through the SAME path. */
async function harvestJob(job, promptId, history, extras = {}) {
  const { applied = [], skipped = [], preamble = null, clause = '', finalWorkflow = null } = extras
  store.setStatus(job.id, 'post-process')

  const images = comfy.outputsOf(history)
    if (!images.length) throw new Error('exécution terminée mais aucune image en sortie')
    const resolvedText = comfy.textsOf(history)

    let deliveredFirst = null   // first delivered file (the continuation)
    for (const [i, img] of images.entries()) {
      const buf = await comfy.readImage(img)
      const ext = path.extname(img.filename) || '.png'
      const filename = `${job.id}-${i}-${crypto.randomBytes(4).toString('hex')}${ext}`
      const full = path.join(CONFIG.mediaDir, filename)
      fs.writeFileSync(full, buf)
      let { width, height } = comfy.pngSize(buf)
      if (job.mode === 'video') {
        /* Retiming only corrects a slow-motion engine (speed != 1). At speed 1 the
           generated duration IS the delivered duration, up to the engine's rounding;
           compressing it would speed up the voice. Only the frame rate is conformed. */
        const r = conformVideo(full,
          (job.videoSpeed ?? 1) !== 1 ? job.videoSeconds : null, job.videoFps)
        if (r) console.log(`[job ${job.id}] ${r}`)
        if (job.op === 'inpaint_video' || job.videoEngine === 'wan_t2v' || /^wan21/.test(job.videoEngine ?? '')) {
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) applied.push(fl)
        }
        if (job.videoEngine === 'motion') {
          // preview AND final: cost under a minute
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) { console.log(`[job ${job.id}] ${fl}`); applied.push(fl) }
        }
        // MATTE pass (de-gloss + grain) on renders that come out glossy: motion
        // (WanAnimate) AND minimax i2v (distilled H3). Not wan/ltx. Not on extensions:
        // matte flattens the continuation, and the seam color match below already
        // aligns its grade with the source.
        const isExtension = typeof job.concatWith === 'string' && job.concatWith.trim()
        const applyMatte = !isExtension
          && ((typeof job.motionDriver === 'string' && job.motionDriver.trim())
            || job.videoEngine === 'minimax')
        if (applyMatte) {
          const dg = matteVideo(full)
          if (dg) console.log(`[job ${job.id}] ${dg}`)
        }
        // "Face tracking" dance: the camera stays locked on the face (tracked crop)
        if (job.danseSuivi === true) {
          const sv = suiviVisage(full)
          if (sv.ok) applied.push(`cadrage suivi du visage (zoom ${sv.zoom})`)
          else skipped.push(`cadrage suivi du visage NON appliqué — ${sv.raison}`)
        }
        // Extension: recolor the continuation clip to the source's tail so the
        // delivered `-0` asset is not darker than the source. Done after the matte so
        // final grades are compared. The downstream concat will then measure ~0 and skip.
        if (job.concatWith && typeof job.concatWith === 'string' && job.concatWith.trim()) {
          const srcDir = job.concatFrom === 'input' ? CONFIG.comfyInput : CONFIG.mediaDir
          const srcPath = path.join(srcDir, path.basename(job.concatWith.trim()))
          if (fs.existsSync(srcPath)) {
            const sm = seamMatchInPlace(full, srcPath, job.prequel === true)
            if (sm) console.log(`[job ${job.id}] ${sm}`)
          }
        }
        const d = videoSize(full)
        width = d.width; height = d.height
        // Thumbnail for grids (iOS does not extract one from <video>).
        // Non-blocking, non-fatal: the route regenerates it on demand.
        void ensurePoster(filename).catch(() => {})
      }
      const bytes = fs.statSync(full).size
      if (deliveredFirst === null) deliveredFirst = { filename, full, width, height }
      store.createAsset(
        {
          id: `a-${job.id}-${i}`, jobId: job.id, createdAt: Date.now(),
          mediaType: job.mode, uri: `/media/${filename}`, filename,
          bytes, width, height, aspect: ratio(width, height),
          register: 'sfw',
          // Asset function: lets galleries show THEIR category (t2i / retouch / i2v / motion).
          op: job.op ?? 'generate', videoEngine: job.videoEngine ?? null,
        },
        {
          recipeId: job.recipeId, workflowFile: job.workflowFile,
          comfyPromptId: promptId, seed: job.seed,
          composedPositive: job.composedPositive, composedNegative: job.composedNegative,
          // RAW prompt + directives: needed by "Clone" to repopulate the front end's column 3.
          userPrompt: job.userPrompt, userDirectives: job.userDirectives,
          selections: job.selections, resolvedText,
          // The preamble is a production input like the prompt: needed to replay the asset.
          identityPreamble: preamble,
          registerClause: clause || null,
          // For an edit, the input image IS production data: needed to replay the asset.
          sourceImage: job.sourceImage ?? null,
          extraLoras: job.loras?.length ? job.loras : null,
          injections: { applied, skipped },
          workflowJson: finalWorkflow,
        },
      )
    }


  if (job.mixSuite?.length && deliveredFirst) lancerMixSuivant(job, deliveredFirst)

  /* Video extension, full shot: source + continuation concatenated into one
     file, delivered as the job's SECOND asset (id `a-<job>-full`). A concat
     failure does not cancel the continuation; it is logged. */
  if (job.concatWith && job.mode === 'video' && deliveredFirst) {
    const srcDir = job.concatFrom === 'input' ? CONFIG.comfyInput : CONFIG.mediaDir
    const srcPath = path.join(srcDir, path.basename(job.concatWith))
    if (!fs.existsSync(srcPath)) {
      console.warn(`[job ${job.id}] plan complet NON produit : source « ${job.concatWith} » absente`)
    } else {
      try {
        const cname = `${job.id}-full-${crypto.randomBytes(4).toString('hex')}.mp4`
        const cfull = path.join(CONFIG.mediaDir, cname)
        /* Prequel: render THEN source, and no seam on the source (the render was
           already recolored to its head above). */
        if (job.prequel === true) concatVideos(deliveredFirst.full, srcPath, cfull, { seam: false })
        else concatVideos(srcPath, deliveredFirst.full, cfull)
        void ensurePoster(cname).catch(() => {})
        const d2 = videoSize(cfull)
        store.createAsset(
          { id: `a-${job.id}-full`, jobId: job.id, createdAt: Date.now(), mediaType: 'video',
            uri: `/media/${cname}`, filename: cname, bytes: fs.statSync(cfull).size,
            width: d2.width, height: d2.height, aspect: ratio(d2.width ?? 9, d2.height ?? 16),
            register: 'sfw', op: job.op ?? 'generate', videoEngine: job.videoEngine ?? null },
          { recipeId: job.recipeId, workflowFile: job.workflowFile, comfyPromptId: promptId,
            seed: job.seed, composedPositive: job.composedPositive, composedNegative: job.composedNegative,
            userPrompt: job.userPrompt, userDirectives: job.userDirectives,
            selections: job.selections, resolvedText,
            identityPreamble: null, registerClause: null,
            sourceImage: job.sourceImage ?? null, extraLoras: null,
            injections: { applied: [job.prequel === true
              ? 'plan complet : prequel + source concaténés (24 fps, résolution de la source)'
              : 'plan complet : source + continuation concaténées (24 fps, résolution de la continuation)'], skipped: [] },
            workflowJson: null })
        console.log(`[job ${job.id}] plan complet livré : ${cname}`)
        /* A sequel delivers the joined result (original + sequel), not the sequel alone: the latter goes to the
           trash (30 days, restorable) once the join is written. If the join fails, this code is not reached
           and the sequel alone stays delivered. */
        const corbeille = path.join(CONFIG.mediaDir, '.corbeille')
        for (const a of store.listAssetsByJob(job.id)) {
          if (a.id === `a-${job.id}-full`) continue
          const row = store.trashAsset(a.id)
          if (row?.filename) {
            try { fs.mkdirSync(corbeille, { recursive: true }); fs.renameSync(path.join(CONFIG.mediaDir, path.basename(row.filename)), path.join(corbeille, path.basename(row.filename))) }
            catch (e) { if (e.code !== 'ENOENT') console.warn(`[job ${job.id}] corbeille ${row.filename} : ${e.message}`) }
          }
        }
      } catch (e) {
        console.warn(`[job ${job.id}] concat : ${String(e.message || e).slice(0, 200)}`)
      }
    }
  }

  return images.length
}

export const queueDepth = () => queue.length + (running ? 1 : 0)

/* A waiting job's place, to show the visitor: its rank (1 = next), and the wait
   before it starts, estimated from the running job's remaining time and the
   expected durations of the jobs ahead. */
let enCours = null   // { estimatedMs, debut }
const DUREE_PAR_DEFAUT = 60_000
export function placeDansFile(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i < 0) return null
  let attenteMs = enCours ? Math.max(15_000, (enCours.estimatedMs ?? DUREE_PAR_DEFAUT) - (Date.now() - enCours.debut)) : 0
  for (const j of queue.slice(0, i)) attenteMs += j.estimatedMs ?? DUREE_PAR_DEFAUT
  return { rang: i + 1, attenteMs: Math.round(attenteMs) }
}
