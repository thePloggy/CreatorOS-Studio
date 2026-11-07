/* ============================================================
   File d'exécution — un seul GPU, donc un seul job à la fois.
   Les jobs sont sérialisés dans l'ordre d'arrivée ; l'état vit
   en SQLite (pas en mémoire) : un redémarrage ne perd rien de
   ce qui est déjà produit.
   ============================================================ */
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
/* État H3 relu toutes les 30 s : l'enqueue reste synchrone. */
let h3Disponible = false
const relireH3 = () => etatH3().then(e => { h3Disponible = e.disponible }).catch(() => {})
relireH3(); setInterval(relireH3, 30_000).unref()
import * as comfy from './comfy.js'
import { blocOllama, pourRendu } from './gpu.js'
import * as sdk from './transport-sdk.js'
import * as store from './db.js'
import { enregistrer as enregistrerPersona, SANS_PERSONNAGE, identityPreambleFor, lorasPhoto, persona, personaDuDepot, triggerPrefix } from './persona.js'
import { ensurePoster } from './poster.js'
import { controlerJob } from './controle.js'
import * as wildcards from './wildcards.js'
import * as vision from './vision.js'
import { t0Hit, t0Mineur } from './t0.js'
import * as plans from './plans.js'
import { MUSIQUES_DIR } from './montage.js'

const CLIENT_ID = 'creatoros-' + crypto.randomUUID()

/* ---------- recette photo ----------
   Un seul registre (SFW), une recette par moteur de diffusion photo :
   Krea 2 par défaut, FLUX.2 Klein 9B en option (CREATOROS_PHOTO_ENGINE=klein).
   La LoRA de la persona n'est PAS dans la recette : le serveur l'empile au
   moment du job (cf. server/persona.js), une recette tourne donc aussi sans.

   Le champ `workflowFile` d'un job surcharge cette table. */
export const RECIPES_PAR_MOTEUR = {
  klein: { sfw: 'PROD_gen_sfw.json' },
  krea: { sfw: 'PROD_gen_krea_sfw.json' },
  // MOSS Image : Apache-2.0, sans LoRA d'identité ; demande un ComfyUI récent (type de CLIP moss_image)
  moss: { sfw: 'PROD_gen_moss_sfw.json' },
  // FLUX 3 Image Klein (distillé, int8) : FLUX Kommunity License, filtre de contenu actif ; sans LoRA d'identité
  flux3: { sfw: 'PROD_gen_flux3_sfw.json' },
}
export const PHOTO_ENGINE = CONFIG.photoEngine
export const RECIPES = RECIPES_PAR_MOTEUR[PHOTO_ENGINE] ?? RECIPES_PAR_MOTEUR.krea

/* ---------- vidéo image-to-video ----------
   Trois moteurs, choisis À LA MAIN dans la console. Aucun n'est « le
   meilleur » : ils perdent chacun sur un axe différent, et c'est l'opérateur
   qui sait lequel compte pour le plan qu'il fabrique.

   `speed` : facteur de durée à GÉNÉRER pour livrer la durée demandée.
   Pas de correction globale sur les moteurs AVEC VOIX : MiniMax et LTX
   parlent en temps réel même quand le corps traîne, et `atempo` x1,8
   ferait débiter le personnage deux fois trop vite. Aucun facteur global ne peut
   corriger le geste sans abîmer la parole : le ralenti se combat AU PROMPT
   (rythme, énergie, « real-time pace »). Wan, muet, garde sa correction
   dans la recette même — ses images valent 1/16 s, lues à 24 fps, x1,5 sans
   ré-encodage. `speed` reste dans la table (et `conformVideo` en aval) pour
   le jour où un moteur muet le justifierait. */
export const VIDEO_ENGINES = {
  wan: {
    maxSeconds: 12,
    /* Au-delà de directSeconds, la recette à FENÊTRES DE CONTEXTE prend le
       relais (fenêtres 33/8 sur les deux étages) : l'attention n'est plus
       calculée sur toute la séquence d'un coup, et 10 s passent en 720×1280
       — sondé : 241 images rendues en 30 min, sujet stable. En
       direct, 8 s est la limite VRAM ferme. */
    directSeconds: 8,
    // 12 s en contexte sondés : 289 images, 30 min, pic 28,9 Go.
    fileCtx: 'PROD_video_wan_ctx.json',
    file: 'PROD_video_wan.json',
    label: 'Wan 2.2 (I2V A14B)',
    force: 'image la plus propre — c’est lui qu’on prend quand le plan doit tenir en grand',
    audio: false,
    speed: 1,
    minutes: 9,
    /* Brouillon : dimensions littérales ramenées à 0,4 MP (480×848 en 9:16,
       la surface de la prévisu motion). Même promesse que sur MiniMax :
       juger le prompt, pas le plan. Mesuré : 5 s en 126 s.
       Le brouillon tourne en 2 + 2 pas (moitié moins de temps). Le rendu final
       reste en 4 + 4 : en 2 + 2, des yeux vitreux peuvent apparaître. */
    draft: { megapixels: 0.4, steps: 4, minutes: 2 },
  },
  ltx_hq: {
    // Sondé à 1,4 MP : 12 s en 6 min (27 Go), 16 s en 9 min
    // (30,9 Go). 20 s non sondé — probablement au ras des 32 Go.
    maxSeconds: 16,
    file: 'PROD_video_ltx_hq.json',
    label: 'LTX-2.5 (22B)',
    force: 'avec le son, rapide — 896×1600 en plusieurs passes',
    audio: true,
    /* La recette porte son propre interrupteur « Switch to Text to Video? » :
       l'image de départ est alors ignorée. Sert aux plans d'ambiance (T2V). */
    t2v: true,
    speed: 1,
    minutes: 5,
    // Brouillon : 0,7 MP au lieu de 1,4 — les passes supplémentaires restent.
    // Mesuré : 6 s en 98 s (704×1024).
    draft: { megapixels: 0.7, minutes: 2 },
  },
}

/* MiniMax H3 : moteur optionnel, poids fournis par le propriétaire d'une installation
   locale (licence, cf. h3.js). Recette sans LoRA de contenu, keyframe d'arrivée possible. */
VIDEO_ENGINES.minimax = {
  maxSeconds: 12,
  file: 'PROD_video_minimax.json',
  label: 'MiniMax H3',
  force: 'le plus fluide, tient l’identité et sait tourner autour du sujet',
  audio: true,
  speed: 1,
  minutes: 12,
  optionnel: 'h3',
  draft: { megapixels: 0.4, minutes: 4 },
}

/* Wan 2.2 T2V-A14B : texte → vidéo AVEC un
   personnage dont l'identité tient dans une paire de LoRA Wan haut / bas bruit
   (Aisha). Pas d'image du tout : WanImageToVideo sans start_image rend un latent
   vide, et toute l'injection Wan (durée, format, brouillon) reste valable.
   Recette : lightx2v T2V, 4 + 4 pas euler, shift 5. Le modèle
   anime à 16 i/s ; la fluidité RIFE ×2 suit au harvest. */
VIDEO_ENGINES.wan_t2v = {
  maxSeconds: 5,
  file: 'PROD_video_wan_t2v.json',
  label: 'Wan 2.2 T2V-A14B',
  force: 'le personnage depuis le texte seul, quand son identité est une LoRA Wan',
  audio: false,
  t2v: true,
  // pas d'interrupteur « Text to Video » ni d'image neutre : la recette part du texte
  t2vNatif: true,
  speed: 1,
  minutes: 6,
  draft: { megapixels: 0.3, minutes: 2 },
}

/* Wan 2.1 I2V 14B 480p : la base des LoRA d'effets et de caméra de
   Remade-AI et d'ostris (Apache-2.0), entraînées sur ce modèle-là. Recette
   courte : lightx2v 4 pas, 480×832, 16 i/s, RIFE ×2 au harvest. Sert la galerie
   « Caméra & effets », pas le sélecteur de moteur. */
VIDEO_ENGINES.wan21 = {
  maxSeconds: 5,
  file: 'PROD_video_wan21_effets.json',
  label: 'Wan 2.1 I2V 480p (effets)',
  force: 'les effets et mouvements de caméra à LoRA dédiée',
  audio: false,
  speed: 1,
  minutes: 2,
}
/* Variante « Remade » pour les EFFETS : sans lightx2v, 28 pas uni_pc,
   cfg 6, shift 5 — le réglage de Remade-AI. Le
   4 pas distillé n'applique pas l'effet au sujet (elle passe derrière, le ballon
   gonfle devant elle) ; à 28 pas l'effet porte sur elle. ~8 min le clip de 5 s. */
VIDEO_ENGINES.wan21_hq = {
  ...VIDEO_ENGINES.wan21,
  file: 'PROD_video_wan21_effets_hq.json',
  label: 'Wan 2.1 I2V 480p (effets, 28 pas)',
  minutes: 8,
}

/* Wan 2.2 Fun Camera : la caméra suit une trajectoire (WanCameraEmbedding) au lieu
   d'une LoRA. Sert les presets de la galerie qui nomment une pose (`camera`). */
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

/* ---------- estimation du temps de rendu ----------
   Coefficients MESURÉS sur une RTX de 32 Go, pas déduits. Une seule source,
   exposée au front par /api/health pour l'estimation avant envoi ; le job
   porte son estimation (`estimatedMs`) calculée ici à l'enqueue.
   - photo Klein 20 pas : ~7 s
   - i2v : secondes de rendu par seconde de vidéo — MiniMax 0,9 MP 8 s = 14 min
     (105 s/s), brouillon 0,4 MP 8 s = 3,5 min (27 s/s), Wan 720p 8 s = 20 min
     et 12 s ctx = 30 min (150 s/s), LTX 8 s = 72 s (9 s/s), LTX HQ 8 s =
     4,5 min (34 s/s)
   - motion (Wan-Animate-2) : par IMAGE du driver à 24 fps — 720p 121 images =
     12 min (6 s/image), 480p ≈ moitié (3 s/image). Le temps suit la longueur
     du driver une pour une : 30 s = 722 images ≈ 70 min en 720p. */
export const RENDER_RATES = {
  photoMs: 7000,
  // Passe Qwen-edit 2511 (20 pas, ~1 MP) — provisoire, à recaler sur mesure.
  qwenFixMs: 60000,
  /* Approximation assumée : la charge fixe (chargement du modèle et des VAE)
     ne dépend pas de la durée du clip, alors qu'une cadence « par seconde »
     l'étale. `measuredEstimate` reprend la main dès qu'il y a un historique. */
  videoSecPerSec: { wan: 150, ltx: 9, ltx_hq: 34, minimax: 105 },
  draftSecPerSec: { minimax: 27, wan: 75, ltx_hq: 17 },
  motionSecPerFrame: { final: 9.0, preview: 4.5 },
}

/** Durée et images d'un driver, telles que la chaîne motion les verra
 *  (ré-échantillonné à 24 fps au-delà de 30). null si illisible. */
export function driverMeta(file) {
  try {
    const p = path.join(CONFIG.comfyInput, path.basename(file))
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', p], { encoding: 'utf8' }).trim().split('\n')
    const [n, d] = String(out[0]).split('/').map(Number); const fps = d ? n / d : n
    const seconds = Number(out[1])
    if (!Number.isFinite(seconds)) return null
    // Le driver est ramené à 16 fps avant transfert (cf. probeDriver) : le
    // nombre d'images vues par le modèle — et donc le coût — suit 16 fps.
    const effFps = 16
    return { seconds, fps, frames: Math.max(1, Math.round(seconds * effFps)) }
  } catch { return null }
}

/* Moyenne des DERNIERS jobs terminés de même recette et même profil :
   l'estimation vit sur la machine réelle, pas sur une table figée. La table
   RENDER_RATES reste le REPLI (première exécution d'une recette, base vidée).
   Profil = brouillon, audio — mélanger un draft et un
   plein donnerait une moyenne qui ment aux deux. Normalisation : une vidéo
   s'estime en ms par seconde GÉNÉRÉE (les durées demandées varient), une
   photo en ms directs. Le motion garde la table : les images du driver ne
   sont pas dans le payload des jobs passés, une moyenne brute mélangerait
   des drivers de 3 s et de 30 s. */
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

/** Estimation en ms d'un job tel qu'enfilé — mesurée si l'historique du
 *  workflow le permet, table de repli sinon. */
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
   Wan-Animate-2 anime une STILL de référence (fournie par l'opérateur) sur
   toute la durée d'une vidéo « driver » : le mouvement est copié image à
   image, l'apparence vient de la still. Aucun échange de visage : la vidéo
   source ne prête que son mouvement.

   Le mouvement est copié image à image aux fps du driver : pas de slow-mo,
   pas de retiming. Fenêtres de contexte natives ou morceaux enchaînés pour
   la durée pleine ; cache Animate-2 en RAM (en VRAM il ne cohabite pas avec
   le modèle). */
/* Refine V2V (affinage vidéo à faible denoise, mouvement conservé) : sert à
   l'agrandissement d'un brouillon. La variante MASQUÉE ne re-diffuse que la
   zone d'un masque : c'est la base de la retouche vidéo au pinceau. */
export const REFINE_RECIPE = 'PROD_v2v_refine.json'
export const REFINE_MASKED_RECIPE = 'PROD_v2v_refine_masked.json'
/* Upscale de brouillon : denoise doux — plus haut, l'affinage réinvente
   l'expression (le sourire ne survivait qu'à 0,30 toutes seeds). */
const UPSCALE_DENOISE = 0.30

/* ---------- « Passer en HD » PHOTO ----------
   · agrandissement DOUX obligatoire — 4x-UltraSharp piquait les taches de
     rousseur en points noirs AVANT même l'affinage ;
   · affinage Klein : 0,20 est le meilleur compromis ; au-delà de 0,26 les
     taches foncent ;
   · le VISAGE est repris de la source via un masque détecté (face_yolov8m) :
     c'est le seul endroit où l'affinage dégrade ;
   · les couleurs sont recalées sur la source (l'affinage assombrit). */
export const PHOTO_HD_WORKFLOW = 'PROD_photo_hd.json'
const PHOTO_HD_DENOISE = 0.20
/** Moteurs dont le nœud i2v prend des keyframes (MiniMaxH3ImageToVideo). */
const H3_KEYFRAMES = ['minimax']
export const MOTION_RECIPES = {
  preview: 'PROD_motion_480.json',   // ~2x plus rapide, pour juger le geste
  final: 'PROD_motion_720.json',     // 720x1280, la qualité de livraison
}
/* Mix : WanAnimate 2.2 en remplacement (WanVideoWrapper),
   SAM2 suit le sujet du driver et le personnage de la still prend sa place dans le
   décor d'origine. L'identité tient par la LoRA vidéo Wan du personnage (haut et
   bas bruit) ; sans elle, par la still seule. */
export const MIX_RECIPE = 'PROD_wananimate_mix.json'
const COMFY_PY = path.join(CONFIG.comfyDir, 'venv', 'bin', 'python')
const GDINO_POINTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'gdino_points.py')

/** Recadrage « face tracking » en place (scripts/suivi_visage.py, Python de ComfyUI, processeur). */
function suiviVisage(full) {
  try {
    const out = execFileSync(path.join(CONFIG.comfyDir, 'venv', 'bin', 'python'),
      ['-I', path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'suivi_visage.py'),
        full, path.join(CONFIG.dataDir, 'modeles-controle')], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(out.trim().split('\n').pop())
  } catch (e) { return { ok: false, raison: String(e.message || e).slice(0, 160) } }
}

/* Identifiants des nœuds pilotés dans les recettes motion. La recette est à
   NOUS (export figé du template officiel) : les ids sont stables, et les
   nommer ici vaut mieux qu'une heuristique — ce graphe ne ressemble à aucun
   autre (le conditionnement passe par WanAnimate2ToVideo, pas par un
   KSampler, et l'injection générique ne le reconnaît pas). */
const MOTION_NODES = {
  ref: '189',          // LoadImage — la still de référence
  driver: '240',       // LoadVideo — la vidéo source
  animate: '261:247',  // WanAnimate2ToVideo — length
  prompt: '261:3',     // CLIPTextEncode — personnage + décor
  motion: '261:222',   // CLIPTextEncode — le mouvement seul
  seed: '261:19',      // SamplerCustom — noise_seed
  save: '246',         // SaveVideo
  context: '261:257',  // ContextWindowsManual — overlap (continuité entre fenêtres)
  contextSwitch: '261:258', // ComfySwitchNode — avec ou sans fenêtres de contexte
}

/* Clips longs : enchaînement par morceaux.
   Au-delà de 81 images, les fenêtres de contexte font sauter le décor à
   la fin de chaque fenêtre (vers l'image 86-114). On coupe les fenêtres et on rend des
   morceaux de 81 images : chacun repart des dernières images du précédent
   (`continue_motion`) et de sa position dans le driver (`video_frame_offset`).
   C'est l'enchaînement prévu par le nœud. L'ancienne voie reste accessible :
   `motionJoin: 'fenetres'` sur le job. */
const MOTION_CHUNK = 81
const MOTION_CHUNK_NEW = 76   // images neuves par morceau suivant (5 reprises du précédent)
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
    // on ne garde que les images neuves : le début du morceau reprend le précédent
    g[`chunk${i}:new`] = { class_type: 'ImageFromBatch', inputs: { image: [`chunk${i}:decode`, 0], batch_index: [w, 4], length: 4096 } }
    parts.push(`chunk${i}:new`)
    prev = { animate: w, decode: `chunk${i}:decode` }
  }
  g['289'] = { class_type: 'BatchImagesNode', inputs: Object.fromEntries(parts.map((n, j) => [`images.image${j}`, [n, 0]])) }
  g['chunk:cut'] = { class_type: 'ImageFromBatch', inputs: { image: ['289', 0], batch_index: 0, length: total } }
  g['245'].inputs.images = ['chunk:cut', 0]
  return parts.length
}

/* Formats proposés — ceux du nœud ResolutionSelector, plus rien d'autre : un
   format hors liste serait rejeté par ComfyUI à l'exécution, pas ici. */
export const VIDEO_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']

/* ---------- parole : la réplique, et rien d'autre ----------
   Les moteurs à audio (MiniMax H3, LTX-2.5) débruitent la voix avec l'image :
   quand le prompt raconte 6 s de gestes et place une réplique au milieu, le
   modèle remplit le temps AVANT la réplique avec de la voix inventée (« du
   yaourt »). Rien dans le
   prompt ne lui dit que le personnage se tait le reste du temps. On l'ajoute ici,
   après tirage et hors LLM, pour tout job vidéo sonore dont le texte porte
   une réplique entre guillemets : la ligne est répétée telle quelle et le
   silence autour est explicite. Sans réplique, on ne touche à rien (un brief
   d'ambiance sans parole reste libre). */
const SPEECH_QUOTE_RE = /«\s*([^»]+?)\s*»|"([^"\n]+?)"|“([^”]+?)”/g
export function speechGuard(text) {
  const lines = []
  for (const m of String(text).matchAll(SPEECH_QUOTE_RE)) lines.push((m[1] ?? m[2] ?? m[3]).trim())
  if (!lines.length) return null
  /* La réplique n'est PAS répétée ici : la citer une seconde
     fois dans la garde la ferait dire deux fois (« coucou toi ? coucou toi,
     do you want… »). On ne décrit que le silence autour. */
  const guard = lines.length === 1
    ? 'The character speaks exactly once: the quoted line, and nothing else. Before and after it the character is silent — no other words, no mumbling, no humming, no off-screen voice.'
    : `The character speaks only the ${lines.length} quoted lines, in that order, and nothing else. Otherwise the character is silent — no other words, no mumbling, no humming, no off-screen voice.`
  const base = String(text).trim().replace(/[.\s]+$/, '')
  return { text: `${base}. ${guard}`, note: `parole verrouillée sur ${lines.length === 1 ? 'la réplique' : `${lines.length} répliques`} : ${lines.map(l => `"${l}"`).join(' · ')}` }
}

/** Durée livrée, en secondes. Bornée par MOTEUR : la limite haute n'est pas
 *  une préférence mais la VRAM — 10 s sur Wan en direct, c'est 241 images en
 *  720×1280 et un OOM garanti au premier échantillonneur. Plafonds sondés moteur
 *  par moteur (voir chaque entrée de la table).
 *  Sous 2 s, rien à voir. */
const clampDuration = (v, engine) => {
  const n = Number(v)
  const cap = engine?.maxSeconds ?? 12
  if (!Number.isFinite(n)) return 5
  if (Math.round(n) > cap)
    throw new Error(`durée ${Math.round(n)} s hors capacité de ce moteur `
      + `(maximum ${cap} s en VRAM à sa résolution) — réduire la durée ou changer de moteur`)
  return Math.max(2, Math.round(n))
}

/** Cadence du FICHIER livré. Elle ne change pas la génération : les trois
 *  moteurs animent à leur cadence native, et une valeur plus haute duplique
 *  des images à l'export — elle ne fabrique pas de mouvement. */
const clampFps = v => ([24, 30].includes(Number(v)) ? Number(v) : 24)


/* Recettes retirées : conservées dans la table pour qu'un job archivé dont la
   provenance les nomme soit signalé, pas rejoué en silence. */
export const DEPRECATED_RECIPES = {}

/* Retouche par instruction (tâche photo `edit`) — Qwen-Image-Edit 2511 :
   image source (upload ou still galerie) + instruction libre composée par le
   LLM (« la robe devient rouge »). L'injection écrit la source dans l'unique
   LoadImage et l'instruction dans l'encodeur TextEncodeQwenImageEdit. */
export const EDIT_WORKFLOW = 'PROD_edit.json'
/** Styles de la retouche : une LoRA Qwen-Image-Edit chacun. Le job ne nomme que l'id,
 *  jamais un fichier : la retouche n'accepte aucune autre LoRA. */
export const STYLES_EDITION = {
  action: 'qwen-styles/QWEN_EDIT_ACTION_V1.safetensors',
  'noir-comic': 'qwen-styles/Noir-Comic-Book-Panel_20.safetensors',
  'anime-2000': 'qwen-styles/Qwen-Image-Edit-2511-Anime-2000.safetensors',
  manga: 'qwen-styles/tone001.safetensors',
}

/** Les recettes réellement SERVIES par cette instance (moteur photo courant,
 *  moteurs vidéo, chaînes annexes) — ce que le diagnostic doit contrôler. */
export function recettesServies() {
  const video = Object.values(VIDEO_ENGINES).flatMap(e => [e.file, e.fileCtx]).filter(Boolean)
  return [...new Set([...Object.values(RECIPES), ...video, ...Object.values(MOTION_RECIPES),
    REFINE_RECIPE, REFINE_MASKED_RECIPE, PHOTO_HD_WORKFLOW, EDIT_WORKFLOW, MIX_RECIPE, SWAP_SCAIL_RECIPE])]
}

/* Dimensions par défaut, surchargées par job. Le cadrage rapproché
   utilise un format moins allongé : un 832×1216 sur un visage force un
   cadrage large ou coupe le menton. */
export const DEFAULT_SIZE = { width: 768, height: 1344 } // 9:16 par défaut
export const CLOSEUP_SIZE = { width: 896, height: 1152 }

const queue = []
let running = false
/* Le job en cours et son prompt ComfyUI — c'est ce qui permet de l'INTERROMPRE.
   La file, elle, se vide par simple retrait. */
let current = null   // { jobId, promptId }

/** Annule un job : retiré de la file s'il attend, interrompu s'il tourne.
 *  Rend ce qui a été fait, ou null si le job est inconnu ici (déjà fini). */
/** Monte un job en attente en tête de la file. Ne touche pas au job en
 *  cours ; le tri par recette de `enqueue` ne s'applique plus après. */
export function promoteJob(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i < 0) return null
  const [j] = queue.splice(i, 1)
  queue.unshift(j)
  return { id, position: 0, queued: queue.length }
}

/** Réordonne la file d'attente selon `ids` (jobs en attente seulement).
 *  Les jobs absents de la liste restent derrière, dans leur ordre actuel. */
export function reorderQueue(ids) {
  const byId = new Map(queue.map(j => [j.id, j]))
  const picked = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean)
  const rest = queue.filter(j => !picked.includes(j))
  queue.length = 0
  queue.push(...picked, ...rest)
  return { order: queue.map(j => j.id) }
}

/* Jobs annulés pendant leur exécution : l'interruption remonte en erreur de
   ComfyUI, qu'il ne faut pas confondre avec un vrai échec (journal, alerte). */
const annulesEnCours = new Set()

export async function cancelJob(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i >= 0) {
    queue.splice(i, 1)
    store.markFailed(id, 0, 'annulé par l’utilisateur (jamais lancé)')
    return { id, cancelled: 'queued' }
  }
  if (current?.jobId === id) {
    // Deux gestes : retirer le prompt s'il attend encore côté ComfyUI, et
    // interrompre s'il est déjà en exécution. Les deux sont sans effet quand
    // ils ne s'appliquent pas — on envoie donc les deux.
    annulesEnCours.add(id)
    if (arreterEntrainement(id)) return { id, cancelled: 'running' }
    await comfy.deleteQueued(current.promptId).catch(() => {})
    await comfy.interrupt(current.promptId).catch(() => {})
    // runJob verra l'exécution interrompue et la notera comme une annulation.
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

/** Reconstruit la file après un redémarrage. Les jobs encore « queued » en
 *  base repartent tels quels (payload complet) ; ceux morts en plein rendu
 *  sont ré-attachés à leur prompt s'il vit encore, re-soumis sinon. */
export async function recoverQueue() {
  const orphans = store.orphanedRunningRows()
  const rows = store.queuedPayloads()
  if (!orphans.length && !rows.length) return 0

  /* Rien ne se décide avant que ComfyUI réponde : un « fetch failed » ici
     n'est pas un échec de job, c'est un serveur qui n'écoute pas encore. */
  const waited = await comfy.waitReady()
  if (waited > 1500) console.log(`[reprise] ComfyUI joignable après ${(waited / 1000).toFixed(1)} s`)

  /* RÉ-ATTACHEMENT : un job en vol au moment d'un redémarrage de CreatorOS
     n'est pas mort — son prompt vit dans ComfyUI. On retrouve son prompt_id,
     on attend la fin et on récolte par le chemin nominal. Sans ça, chaque
     déploiement faucherait les rendus en cours alors que les fichiers arrivent
     quand même.

     Mais si ComfyUI LUI-MÊME a redémarré, sa
     file en mémoire est partie avec lui : le prompt est inconnu, le rendu
     réellement perdu. Là, on re-soumet depuis le payload — il n'y a rien à
     doubler, le GPU n'a plus ce travail. */
  for (const row of orphans) {
    const job = row.payload
    if (!job) {
      store.markFailed(row.id, 0, 'interrompu par un redémarrage du service — relancer')
      console.warn(`[reprise] job ${row.id} sans payload, marqué en échec`)
      continue
    }
    // export de montage : ffmpeg tournait dans l'ancien processus, rien à raccrocher
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
        // Durée réelle depuis le départ enregistré en base : un job ré-attaché
        // a bien rendu, sa durée n'a aucune raison d'être 0 (elle s'affiche
        // sur l'asset en bibliothèque).
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

/** Enregistre le job et le met en file. Retourne immédiatement :
 *  le front suit l'avancement par /api/jobs/:id. */
/** Source d'une restauration, pour l'avant / après : seulement un chemin du studio. */
const origineValide = u => (typeof u === 'string' && /^\/(api\/uploads|media)\/[\w.%-]+$/.test(u) ? u : undefined)
export function enqueue(job) {
  if (job.mode === 'photo' && Array.isArray(job.references) && job.references.length) job = { ...job, photoEngine: 'klein', workflowFile: undefined }   // seule la recette Klein prend des références
  /* Idempotence d'envoi : si la clé du client a DÉJÀ produit un job, on rend
     celui-là au lieu d'en créer un second. Le client mobile la génère avant
     son premier POST et la réutilise sur toute reprise de transport (réponse
     perdue, app suspendue par l'OS, reprise réseau) — sans elle, un doublon
     vidéo coûte jusqu'à 15 min de GPU et bloque la file. L'unicité est
     garantie par l'index unique en base, pas par ce test : celui-ci évite
     seulement de lever une erreur SQL dans le cas normal. */
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
  /* Fonctions retirées de l'édition publique (échange de visage ou de tête,
     remplacement de personnage dans une vidéo, passes de l'ancienne chaîne) :
     refusées en le disant, jamais reroutées en silence vers autre chose. */
  if (job.op === 'swap' || job.videoSwap)
    throw new Error('l’échange de visage ou de sujet n’existe pas dans cette édition')
  if (job.anatomyFix || job.bfsAfter)
    throw new Error('la passe de correction chaînée n’existe plus : utiliser la retouche (op « edit ») ou le pinceau')
  if (job.register && job.register !== 'sfw')
    throw new Error(`registre « ${job.register} » inconnu : seul le registre « sfw » existe`)
  // `op` distingue une GÉNÉRATION d'une ÉDITION. Le média produit reste une
  // photo dans les deux cas : `mode` ne peut pas porter cette distinction.
  const op = job.op === 'edit' ? 'edit' : 'generate'
  const mode = job.mode ?? 'photo'
  /* Le moteur vidéo est un CHOIX de l'opérateur, plus une conséquence de la
     case « son ». Un nom inconnu est refusé plutôt que replié en silence :
     livrer du Wan à qui a demandé du MiniMax, c'est livrer autre chose. */
  // Motion Control : chaîne dédiée, pas un moteur i2v de plus. `motionDriver`
  // est le NOM du fichier vidéo déposé par /api/upload.
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
  // Wan n'a pas d'étage audio : demander du son sur lui n'est pas une erreur
  // de l'opérateur (l'interface grise la case), mais l'API est ouverte.
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
    // Retouche par instruction : les DEUX sont obligatoires — une image à
    // éditer, et l'instruction qui dit quoi changer. Un chemin échapperait du
    // dossier input de ComfyUI ; on n'accepte qu'un nom de fichier nu.
    if (!sourceImage)
      throw new Error('retouche sans image source : rien à éditer '
        + '(sourceImage = nom de fichier dans le dossier input de ComfyUI)')
    if (sourceImage.includes('/') || sourceImage.includes('\\') || sourceImage.startsWith('.'))
      throw new Error(`image source « ${sourceImage} » invalide : nom de fichier nu attendu`)
    if (!positive)
      throw new Error('retouche sans instruction : décrire la modification '
        + '(« la robe devient rouge »)')
  } else if (isMotion) {
    // Le driver est LA donnée du Motion Control : sans lui, rien à transférer.
    const d = job.motionDriver.trim()
    if (d.includes('/') || d.includes('\\') || d.startsWith('.'))
      throw new Error(`vidéo driver « ${d} » invalide : nom de fichier nu attendu`)
    // La still est la référence d'apparence : les deux fichiers sont
    // obligatoires — l'un sans l'autre n'a pas de sens.
    // Mix : sans still, le serveur fabrique la référence du personnage (cf. refDuPersonnage).
    const r = String(job.motionRef ?? '').trim()
    if (!r && job.motionMode !== 'replace') throw new Error('still de référence manquante : le motion control '
      + 'anime UNE IMAGE — déposer la still en plus de la vidéo source')
    if (r.includes('/') || r.includes('\\') || r.startsWith('.'))
      throw new Error(`still « ${r} » invalide : nom de fichier nu attendu`)
  } else if (mode === 'video' && job.t2v === true) {
    /* Plan d'ambiance (T2V) : pas d'image de départ, pas de personnage —
       paysage, rue, plan de coupe. Seul un moteur dont la recette sait
       partir du texte l'accepte ; refusé plutôt que rendu en i2v sur rien. */
    if (!engine.t2v)
      throw new Error(`plan d'ambiance (texte → vidéo) indisponible sur « ${engineKey} » : `
        + Object.entries(VIDEO_ENGINES).filter(([, e]) => e.t2v).map(([k]) => k).join(', '))
    if (!positive) throw new Error('plan d’ambiance sans description : décrire le lieu et le mouvement de caméra')
  } else if (mode === 'video') {
    /* Une recette i2v part d'une image. Exception : MiniMax H3 sait ARRIVER
       sur une frame de fin sans frame de départ (first_frame et last_frame
       sont deux keyframes optionnelles du même nœud). */
    // Wan aussi (Prequel) : WanFirstLastFrameToVideo, cf. comfy.js
    const finOk = H3_KEYFRAMES.includes(engineKey) || engineKey === 'wan'
    const finSeule = finOk && typeof job.endImage === 'string' && job.endImage.trim()
    if (!sourceImage && !finSeule)
      throw new Error('vidéo sans image de départ : choisir une still dans la bibliothèque'
        + (finOk ? ' (ou une frame de fin seule)' : ''))
    if (sourceImage && sourceImage.includes('/') || sourceImage.includes('\\') || sourceImage.startsWith('.'))
      throw new Error(`image de départ « ${sourceImage} » invalide : nom de fichier nu attendu`)
    if (!positive) throw new Error('brief de mouvement vide : rien à animer')
    // Concat de l'extension vidéo : livrer AUSSI source + continuation en un
    // fichier. `concatWith` = nom nu ; `concatFrom` dit où vit la source.
    if (typeof job.concatWith === 'string' && job.concatWith.trim()) {
      const c = job.concatWith.trim()
      if (c.includes('/') || c.includes('\\') || c.startsWith('.'))
        throw new Error(`vidéo à concaténer « ${c} » invalide : nom de fichier nu attendu`)
    }
    // Image de fin optionnelle : même règle de nom nu que la still de départ.
    if (typeof job.endImage === 'string' && job.endImage.trim()) {
      const e = job.endImage.trim()
      if (e.includes('/') || e.includes('\\') || e.startsWith('.'))
        throw new Error(`image de fin « ${e} » invalide : nom de fichier nu attendu`)
    }
  } else if (!positive) {
    throw new Error('prompt vide : rien à générer')
  }

  // Le son n'a pas de recette : il produirait une image en se faisant passer
  // pour autre chose. On refuse franchement plutôt que de livrer un asset faux.
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
    // Keyframe d'arrivée (nom de fichier dans input/). Portée par MiniMax
    // seulement ; les autres moteurs la signalent « non injectée ».
    endImage: (mode === 'video' && !isMotion && typeof job.endImage === 'string' && job.endImage.trim())
      ? job.endImage.trim() : null,
    concatWith: (mode === 'video' && !isMotion && typeof job.concatWith === 'string' && job.concatWith.trim())
      ? job.concatWith.trim() : null,
    concatFrom: job.concatFrom === 'input' ? 'input' : 'media',
    // Prequel : le rendu ARRIVE sur la 1re frame de la source (endImage) et passe devant
    prequel: mode === 'video' && !isMotion && job.prequel === true,
    // recette photo demandée (Krea 2 / FLUX.2 Klein) : décide aussi des LoRA d'identité empilées
    photoEngine: mode === 'photo' && op !== 'edit' && Array.isArray(job.references) && job.references.length ? 'klein'
      : mode === 'photo' && op !== 'edit' && RECIPES_PAR_MOTEUR[job.photoEngine] ? job.photoEngine : undefined,
    // jusqu'à 6 images de référence (FLUX.2 Klein), noms nus du dossier input
    references: mode === 'photo' && op !== 'edit' && Array.isArray(job.references) ? job.references.filter(n => typeof n === 'string' && n && !/[\\/]/.test(n) && !n.startsWith('.')).slice(0, 6) : undefined,
    // sans personnage, la personne de la première référence est le sujet (carrousel d'après une photo)
    refVisage: mode === 'photo' && op !== 'edit' && job.refVisage === true && Array.isArray(job.references) && job.references.length > 0,
    // Mix à plusieurs : rang de la personne (de gauche à droite), nombre de personnes, personnages restants
    mixRang: isMotion && Number.isInteger(job.mixRang) ? job.mixRang : undefined,
    mixTotal: isMotion && Number.isInteger(job.mixTotal) ? job.mixTotal : undefined,
    mixSuite: isMotion && Array.isArray(job.mixSuite) ? job.mixSuite.map(String).slice(0, 2) : undefined,
    // preset de caméra ou d'effet d'origine : le contrôle des clips y lit le mouvement attendu
    presetId: typeof job.presetId === 'string' ? job.presetId.slice(0, 40) : undefined,
    cameraPose: POSES_CAMERA.includes(job.cameraPose) ? job.cameraPose : undefined,
    // basse VRAM : profil forcé pour CE job (le serveur ne le laisse passer qu'au propriétaire)
    profilVram: PROFILS.includes(Number(job.profilVram)) ? Number(job.profilVram) : undefined,
    motionDriver: isMotion ? job.motionDriver.trim() : null,
    motionPreview: isMotion ? Boolean(job.motionPreview) : null,
    // Move (animate) : la still fournie rejoue le geste du driver.
    // Mix (replace) : le personnage de la still prend la place de celui du driver, dans son décor.
    motionMode: isMotion ? (job.motionMode === 'replace' ? 'replace' : 'animate') : null,
    motionRef: isMotion ? String(job.motionRef ?? '').trim() || null : null,
    // Leviers du motion control pur : bornés ici, l'API est ouverte.
    motionSceneText: isMotion && typeof job.motionSceneText === 'string'
      ? job.motionSceneText.trim() || null : null,
    motionSansTurbo: isMotion && job.motionSansTurbo === true ? true : undefined,
    motionTurbo: isMotion && Number.isFinite(job.motionTurbo) ? Math.min(1, Math.max(0, job.motionTurbo)) : undefined,
    motionPas: isMotion && Number.isInteger(job.motionPas) ? Math.min(30, Math.max(4, job.motionPas)) : undefined,
    motionCfg: isMotion && Number.isFinite(job.motionCfg) ? Math.min(6, Math.max(1, job.motionCfg)) : undefined,
    motionVisionRef: isMotion && job.motionVisionRef === true ? true : undefined,
    swapAnimation: isMotion && job.swapAnimation === true ? true : undefined,
    swapLong: isMotion && Number.isInteger(job.swapLong) ? job.swapLong : undefined,
    // bancs du propriétaire : forcer Wan Animate, prendre la pose d'une autre vidéo (ex. le mannequin 3D), garder la cadence du driver
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
    // Clips > 81 images : 'morceaux' (défaut) ou 'fenetres' (ancienne voie).
    motionJoin: isMotion ? (job.motionJoin === 'fenetres' ? 'fenetres' : 'morceaux') : null,
    /* Plan d'une source montée (cf. enqueueParPlans) : groupe, rang, durée exacte
       du plan dans la source. Sert au recollage quand le dernier plan est livré. */
    motionPlan: isMotion && job.motionPlan?.group
      ? { group: String(job.motionPlan.group), index: Number(job.motionPlan.index), count: Number(job.motionPlan.count),
        seconds: Number(job.motionPlan.seconds), source: String(job.motionPlan.source ?? '') }
      : null,
    /* Durée DEMANDÉE (celle du fichier livré) et durée à GÉNÉRER : les deux
       diffèrent sur les moteurs qui animent au ralenti. */
    // En motion, durée/format/cadence viennent du DRIVER — aucun réglage.
    videoSeconds: mode === 'video' && !isMotion ? clampDuration(job.videoSeconds, engine) : null,
    videoFps: mode === 'video' && !isMotion ? clampFps(job.videoFps) : null,
    // « origine » : ratio EXACT de la still — le snap sur un ratio du
    // ResolutionSelector étirait la still. Les dims du front ne sont qu'un
    // repli : le fichier réel est sondé au dispatch (dims périmées d'une still
    // précédente sur le chemin clone).
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
    // Brouillon : refusé plutôt qu'ignoré sur un moteur qui ne le porte pas —
    // l'opérateur attend un rendu court, il aurait le plein sans le savoir.
    videoDraft: mode === 'video' && !isMotion && Boolean(job.videoDraft)
      ? (engine.draft ? true
        : (() => { throw new Error(`mode brouillon indisponible sur « ${engineKey} » : `
          + Object.entries(VIDEO_ENGINES).filter(([, e]) => e.draft).map(([k]) => k).join(', ')) })())
      : null,
    // ControlNet (tâche Génération) : image de référence déposée dans input/,
    // modalité = préprocesseur, force = `strength` du nœud.
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
    /* Brief d'origine écrasé à l'écran par « Remplacer » de l'Enhancer —
       stocké seulement s'il diffère du prompt envoyé. */
    initialBrief: (typeof job.initialBrief === 'string' && job.initialBrief.trim()
      && job.initialBrief.trim() !== String(positive ?? '').trim())
      ? job.initialBrief.trim() : null,
    /* Description VLM de la still, telle qu'elle a été donnée au réécriveur.
       Sans elle, relire un prompt composé ne dit pas POURQUOI il décrit cette
       tenue ou cette pose : l'écart vient soit de l'image mal lue, soit de la
       consigne mal suivie, et ça ne se corrige pas au même endroit. */
    promptVision: (typeof job.promptVision === 'string' && job.promptVision.trim())
      ? job.promptVision.trim() : null,
    composedPositive: positive, composedNegative: job.composedNegative ?? null,
    selections: job.selections ?? null,
    // LoRA additionnelles (style), empilées après celles de la persona. Normalisées ici
    // pour qu'un front qui envoie des chaînes marche comme un front qui envoie
    // des objets — le contrat reste { name, strength }.
    editStyle: op === 'edit' && Object.hasOwn(STYLES_EDITION, job.editStyle) ? job.editStyle : undefined,
    loras: (Array.isArray(job.loras) ? job.loras : [])
      .map(l => (typeof l === 'string' ? { name: l, strength: 1 } : l))
      .filter(l => l && typeof l.name === 'string' && l.name)
      .map(l => ({
        name: l.name,
        strength: Number.isFinite(Number(l.strength)) ? Number(l.strength) : 1,
        // Conserver la surcharge de déclencheur : c'est le seul recours pour
        // les LoRA dont le fichier ne porte aucune métadonnée exploitable.
        ...(typeof l.trigger === 'string' && l.trigger.trim() ? { trigger: l.trigger.trim() } : {}),
      })),
    // LoRAs vidéo (turbo, style…) — même forme que `loras`,
    // empilées sur la chaîne modèle de la recette vidéo (hors motion).
    videoLoras: (Array.isArray(job.videoLoras) ? job.videoLoras : [])
      .map(l => (typeof l === 'string' ? { name: l, strength: 1 } : l))
      .filter(l => l && typeof l.name === 'string' && l.name)
      .map(l => ({
        name: l.name,
        strength: Number.isFinite(Number(l.strength)) ? Number(l.strength) : 1,
        // La plupart des LoRA H3 agissent sur simple présence, mais certaines
        // portent un mot (realism → r34l1sm) : on le conserve pour le préfixer.
        ...(typeof l.trigger === 'string' && l.trigger.trim() ? { trigger: l.trigger.trim() } : {}),
      })),
    // Dimensions : explicites, sinon le format du cadrage, sinon le défaut.
    // Non persistées en colonne — la valeur réelle est dans workflowJson.
    width: Number(job.width) || (job.framing === 'closeup' ? CLOSEUP_SIZE.width : DEFAULT_SIZE.width),
    height: Number(job.height) || (job.framing === 'closeup' ? CLOSEUP_SIZE.height : DEFAULT_SIZE.height),
    /* Lot : identifiant partagé par les jobs d'un même envoi — c'est lui
       qui regroupe les rendus en une vignette-mosaïque. Perdu ici = perdu
       partout (le row EST le payload persisté). */
    batchId: typeof job.batchId === 'string' && job.batchId ? job.batchId : null,
    carouselLocks: (job.carouselLocks && typeof job.carouselLocks === 'object') ? job.carouselLocks : null,
    /* Prompt de l'opérateur à l'origine de la lignée : un carrousel lancé
       depuis un plan de carrousel doit repartir de lui, pas de la
       paraphrase VLM du plan (cf. server/carrousel.js). */
    promptRacine: typeof job.promptRacine === 'string' && job.promptRacine.trim() ? job.promptRacine.trim() : null,
    // nouvelle prise lancée par le contrôle automatique (server/controle.js) : jamais relancée à son tour
    priseDe: typeof job.priseDe === 'string' && job.priseDe ? job.priseDe : null,
  }
  // Estimation de durée, calculée ici et portée par le job (payload) : la
  // barre « écoulé / estimé » des interfaces s'en sert.
  row.estimatedMs = estimateMs(row)
  row.requestId = requestId
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  /* Regroupe les jobs de MÊME recette : deux modèles lourds ne cohabitent
     pas en VRAM, et chaque bascule force un rechargement complet — et
     ces rechargements alternés finissent en OOM au premier échantillonneur. Le tri
     est STABLE : l'ordre d'arrivée est conservé à recette égale, et le job
     en tête n'est jamais déplacé (il peut déjà être parti). */
  if (queue.length > 2) {
    const head = queue.shift()
    queue.sort((a, b) => a.workflowFile === b.workflowFile ? 0
      : a.workflowFile < b.workflowFile ? -1 : 1)
    queue.unshift(head)
  }
  pump()
  return { id, seed, workflowFile, queued: queue.length }
}

/* ---------- motion par plans (voir server/plans.js) ----------
   Une vidéo de mouvement MONTÉE part en autant de jobs qu'elle a de plans : chaque
   plan est animé à part sur la même still de référence, ce qui évite qu'une coupe
   du montage tombe au milieu d'une fenêtre de contexte. Les jobs partagent un lot
   (une seule vignette dans la galerie) et une graine ; le premier garde
   l'identifiant de l'envoi, que l'interface suit déjà. `motionPlans: false` sur le
   job garde le rendu d'un bloc. */
export async function enqueueParPlans(job) {
  /* Mix : départ choisi dans la vidéo source. Le Mix ne garde que 9,6 s : la source est
     recoupée à ce départ avant le dépôt, le reste du chemin (plans, masque, tenue) ne change pas. */
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
  if (rid && store.jobsByRequestId(rid).length) return enqueue(job)      // reprise d'un envoi déjà vu
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

/** Dernier plan d'un groupe terminé : les plans livrés sont recollés en un seul
 *  fichier, livré comme asset du job qui clôt le groupe. Un plan en échec
 *  manque au montage, et la provenance le dit. */
async function assemblerPlans(job) {
  const g = job.motionPlan?.group
  if (!g) return
  const freres = store.jobsByPlanGroup(g)
  if (freres.some(f => !['done', 'blocked'].includes(f.status))) return     // d'autres plans arrivent
  const livres = freres
    .map(f => ({ ...f, plan: (() => { try { return JSON.parse(f.payload).motionPlan } catch { return null } })() }))
    .filter(f => f.plan && f.status === 'done')
    .map(f => ({ id: f.id, index: f.plan.index, seconds: f.plan.seconds,
      fichier: store.jobAssetFiles(f.id).map(n => path.join(CONFIG.mediaDir, n)).find(n => n.endsWith('.mp4') && !n.includes('-montage-') && fs.existsSync(n)) }))
    .filter(f => f.fichier)
    // un plan relancé remplace sa première tentative : on garde le dernier rendu de chaque rang
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
  /* Les plans montés passent en « refusé » : ils restent en
     galerie, grisés, derrière le montage. Un plan déjà validé à la main n'est pas touché. */
  for (const f of livres)
    for (const a of store.assetsOfJob(f.id))
      if (!String(a.id).endsWith('-montage') && (a.review_status ?? 'pending') === 'pending') store.setReview(a.id, 'rejected')
  console.log(`[plans] montage livré : ${nom} (${livres.length} plans sur ${rangs.size})`)
}

/* ---------- upscale d'un brouillon vidéo ----------
   Le rendu brouillon validé repart en V2V refine (mouvement conservé,
   détails réaffinés) à la résolution cible. File standard : un seul
   GPU, l'upscale attend son tour comme tout le monde. */
/** « Passer en HD » d'une PHOTO : agrandit à 2 MP et renforce le détail.
 *  `strength` = débruitage de l'affinage (0 = agrandissement seul). */
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
    // mesuré : 35 à 45 s sur une source 760x1368 portée à 2 MP.
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
    // cadence SOURCE (pilote le graphe) et cadence de SORTIE (affichage) :
    // les sources < 24 fps sont interpolées RIFE x2 vers 30 ; H3 natif = 24.
    upscaleSrcFps: Number(fps) || 16,
    videoFps: h3 === true ? 24 : (Number(fps) || 16) < 24 ? 30 : Number(fps),
    parentAssetId: parentAssetId ?? null,
    videoDraft: null,
    userPrompt: null, userDirectives: null,
    composedPositive: `upscale refine ${width}x${height} (denoise ${UPSCALE_DENOISE}) de ${sourceLabel ?? sourceFile}`,
    composedNegative: null, selections: null, loras: [], videoLoras: [],
    /* mesuré : 81 frames (16 fps) ≈ 160 s ; 150 frames (30 fps) ≈ 430 s —
       le coût par frame monte avec la longueur (offload VRAM). */
    // H3 : pass1 replay (~60 s) + pass2 (~220 s) ; Wan : mi-cadence
    estimatedMs: h3 === true ? 290000
      : Math.round(160000 * Math.pow(((Number(fps) || 16) < 24 ? 15 : (Number(fps) || 16) / 2) / 15, 1.2)),
  }
  /* Pas de clé d'idempotence ici : l'upscale est déclenché par un bouton
     sur un asset précis, pas par un envoi de formulaire susceptible d'être
     rejoué après une réponse perdue. */
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* Upscale LATENT NATIF H3 (meilleur qu'un refine Wan) : rejoue la
   passe 1 exacte du draft (workflowJson de provenance, même seed ⇒ même clip)
   et enchaîne 2× learned → blur .5 → contrast .90 → pass2 4 steps → TRIM 2
   frames (le token d'ancrage du VAE causal sort gaufré sur les frames 0-1). */
async function runUpscaleH3(job, t0) {
  const prov = store.getProvenance(job.parentAssetId)
  const g = JSON.parse(prov.workflow_json)
  // liens génériques depuis le graphe pass1 (recette minimax)
  const guiderId = Object.keys(g).find(k => g[k].class_type === 'BasicGuider')
  const samplerId = Object.keys(g).find(k => g[k].class_type === 'SamplerCustomAdvanced')
  const decodeId = Object.keys(g).find(k => g[k].class_type === 'VAEDecode')
  const audioDecId = Object.keys(g).find(k => g[k].class_type === 'VAEDecodeAudio')
  const selectId = Object.keys(g).find(k => g[k].class_type === 'KSamplerSelect')
  if (!guiderId || !samplerId || !decodeId || !audioDecId) throw new Error('graphe pass1 minimax incomplet en provenance')
  const modelLink = g[guiderId].inputs.model
  const condLink = g[guiderId].inputs.conditioning
  // la passe 1 ne décode plus (son SaveVideo saute) : seul le latent compte
  for (const k of Object.keys(g)) if (g[k].class_type === 'SaveVideo') delete g[k]
  // denoise 0.45 : 0.5 altère légèrement l'expression, 0.35 dédouble
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
  await comfy.freeMemory().catch(() => { /* non fatal */ })
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

/* ---------- retouche au pinceau ----------
   L'opérateur peint une zone, décrit ce qui doit s'y trouver ; seule cette zone est
   refaite, le reste de l'image est recollé AU PIXEL PRÈS. Pas de recette à part : le
   graphe part de la recette de génération (même modèle, lue telle quelle,
   jamais modifiée, LoRA de la persona empilées) — l'image vide de départ y est
   remplacée par l'image source encodée, masquée, puis le résultat est recomposé sur
   la source. */
const INPAINT_DENOISE = 0.9   // 0,75-0,8 garde la couleur d'origine
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
    /* Le texte de l'opérateur SEUL : le prompt d'origine décrit ce qu'on veut justement
       changer (« pull marine » + prompt d'origine « pull crème » → pull
       resté crème). Le reste de l'image donne le contexte par lui-même. */
    composedPositive: String(prompt ?? '').trim() || null,
    composedNegative: null, selections: null, loras: [], videoLoras: [], estimatedMs: 25000,
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* Agrandir : Qwen Edit voit toute l'image élargie et ne redessine que les marges grises ;
   la photo d'origine est recollée telle quelle. Sans LoRA ni préambule : le personnage est déjà dans l'image. */
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
  // LoRA de la persona, empilées comme sur le chemin de génération
  const pl = comfy.empilerLoras(g, lorasPhoto(persona(job.personaId), PHOTO_ENGINE)).applied
  g.inp_src = { class_type: 'LoadImage', inputs: { image: job.sourceImage } }
  g.inp_peint = { class_type: 'LoadImage', inputs: { image: job.inpaintMask } }
  g.inp_masque = { class_type: 'ImageToMask', inputs: { image: ['inp_peint', 0], channel: 'red' } }
  // zone refaite un peu plus large que le trait, bord fondu : pas de couture visible au recollage
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

/* ---------- retouche vidéo au pinceau ----------
   Même geste que sur une photo : l'opérateur peint la zone sur la PREMIÈRE image du
   clip et décrit ce qu'il veut. SAM3 suit la zone d'image en image à partir de ce
   masque (`suivi`) — ou la zone reste fixe dans le cadre. La zone est redessinée par
   le refine vidéo masqué (Wan T2V bas bruit, recette lue telle quelle), puis recollée
   sur la source : hors zone, les images de la source. Cadence de travail 16 i/s,
   fluidité RIFE ensuite. Un seul bloc : clips de ~10 s au plus (au-delà la retouche
   manque de mémoire). */
const INPAINT_VIDEO_DENOISE = 0.75
const INPAINT_VIDEO_MAX_IMAGES = 161
/* Édition au prompt : même chaîne, mais la zone n'est pas peinte — SAM3 la
   trouve d'après `cible` (« dress », « sunglasses »…) sur chaque image et la suit ;
   le prompt dit ce qui doit s'y trouver. Rien à modifier si la cible n'est pas à
   l'image : on ne fait pas apparaître un objet absent. */
/* Recadrage vidéo : le clip est posé au centre d'un cadre au nouveau format, les bords
   (pré-remplis des seules couleurs du clip, sans formes qui deviendraient des fantômes) sont redessinés par la retouche Wan, zone fixe. */
const FORMATS_RECADRAGE = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5 }
/* Recadrage : Wan 2.2 Fun VACE voit le clip posé au centre d'une toile grise et génère les
   bords image par image, en continuité du décor, de la perspective et du mouvement. Le clip
   d'origine est ensuite recollé au centre (sa cadence, son son), jointure fondue. */
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
  // toile finale : le clip garde sa taille, côté long plafonné à 1280 px ; toile de génération : côté long 1024
  const pair = v => Math.max(16, Math.round(v / 16) * 16)
  let W = w / h < ar ? h * ar : w, H = w / h < ar ? h : w / ar
  const k = Math.min(1, 1280 / Math.max(W, H)); W = pair(W * k); H = pair(H * k)
  const cw = Math.min(W, Math.round(w * k / 2) * 2), ch = Math.min(H, Math.round(h * k / 2) * 2)
  const kg = 1024 / Math.max(W, H), Wg = pair(W * kg), Hg = pair(H * kg)
  const cwg = Math.round(cw * Wg / W / 2) * 2, chg = Math.round(ch * Hg / H / 2) * 2
  // 81 images couvrent tout le clip : au-delà de 5 s la cadence de génération baisse
  const fpsGen = Math.min(16, (VACE_IMAGES - 1) / duree)
  const cle = Date.now().toString(36), ctrl = `RCD_${cle}.mp4`, masque = `RCD_${cle}_masque.png`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-f', 'lavfi', '-i', `color=0x808080:s=${Wg}x${Hg}:r=${fpsGen}`, '-filter_complex',
    `[0:v]fps=${fpsGen},scale=${cwg}:${chg},setsar=1[c];[1:v][c]overlay=(W-w)/2:(H-h)/2:shortest=1,tpad=stop_mode=clone:stop=${VACE_IMAGES}[v]`,
    '-map', '[v]', '-frames:v', String(VACE_IMAGES), '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', path.join(CONFIG.comfyInput, ctrl)])
  // masque : blanc = à générer ; le clip garde 6 px de recouvrement pour que les bords le prolongent
  const m = 6
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=white:s=${Wg}x${Hg}`, '-vf',
    `drawbox=x=${(Wg - cwg) / 2 + m}:y=${(Hg - chg) / 2 + m}:w=${Math.max(2, cwg - 2 * m)}:h=${Math.max(2, chg - 2 * m)}:color=black:t=fill`, '-frames:v', '1', path.join(CONFIG.comfyInput, masque)])
  const texte = String(prompt ?? '').trim() || 'the same place continues naturally on every side, same light, coherent perspective'
  if (t0Hit(texte)) throw new Error('prompt refusé (liste T0)')
  const id = `rcd-${cle}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'recadrage@v2', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'recadrage', videoEngine: null,
    recadrage: { source, ctrl, masque, W, H, cw, ch, Wg, Hg, fpsGen, duree, fpsOrig },
    parentAssetId: parentAssetId ?? null, userPrompt: texte, userDirectives: null, composedPositive: texte, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 9 * 60_000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
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
  const g = grapheRecadrage(job)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { timeoutMs: 30 * 60_000, onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const sortie = Object.values(history.outputs ?? {}).flatMap(o => [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]).find(f => /\.mp4$/.test(f.filename))
  if (!sortie) throw new Error('recadrage : aucune vidéo en sortie')
  const bords = path.join(CONFIG.comfyOutput, sortie.subfolder ?? '', sortie.filename)
  // le clip d'origine recollé au centre, à sa cadence, jointure fondue sur 12 px ; les bords suivent sa durée
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

export function enqueueInpaintVideo({ sourceFile, maskFile, parentAssetId, prompt, strength, suivi, cible, inverser, retirer, objet, objetNom, loin }) {
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
    // « changer le fond » : on suit la personne et on redessine tout SAUF elle (masque inversé)
    inpaintInverser: !!inverser && !!zoneTexte,
    // « retirer » : la zone est d'abord brouillée avec les couleurs voisines, sinon le modèle redessine l'objet
    inpaintRetirer: !!retirer && !!zoneTexte && !inverser,
    // objet à poser : photo de référence (input) et nom pour SAM3 ; le collage se fond à force modérée
    inpaintObjet: objet ?? null, inpaintObjetNom: objet ? String(objetNom ?? '').trim().slice(0, 80) || 'main object' : null,
    // au loin : l'objet reste derrière les personnes, suit la caméra, prend le flou de la distance
    inpaintLoin: !!objet && !!loin,
    inpaintDenoise: Number.isFinite(strength) ? Math.min(1, Math.max(0.3, strength)) : INPAINT_VIDEO_DENOISE,
    parentAssetId: parentAssetId ?? null,
    userPrompt: String(prompt ?? '').trim() || null, userDirectives: null,
    composedPositive: String(prompt ?? '').trim() || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [],
    estimatedMs: Math.round((objet ? 90_000 : 60_000) + m.frames * 2500),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

/* ---------- nouveau fond d'un clip (Wan 2.2 Fun VACE) ----------
   1) Qwen-Image-Edit 2511 refait le décor de la 1re image en gardant la personne :
      c'est l'image de référence du nouveau décor.
   2) SAM3 suit la ou les personnes et BiRefNet les détoure dans cette zone (les jours
      entre bras et corps en sortent) ; tout le reste devient gris dans la vidéo de
      contrôle, et le masque (personne resserrée d'une douzaine de pixels, inversé) dit
      à VACE quoi redessiner : les fentes entre bras et corps deviennent assez larges pour
      qu'il y peigne le décor. VACE refait le décor sur tout le clip, guidé par la référence.
   3) Les personnes de la source sont recollées par-dessus, à la définition de la
      source (petit côté jusqu'à 720) : le détourage vient de BiRefNet (mèches de
      cheveux, bords doux), limité à la zone que SAM3 suit pour ne garder que les personnes. */
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
  // définition du collage : celle de la source, petit côté plafonné à 720
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
    // 1) référence : la 1re image, décor refait par Qwen-Image-Edit
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
    // 2) suivi des personnes, vidéo de contrôle au décor gris
    sam3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    txt: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam3', 1], text: cible } },
    trk: { class_type: 'SAM3_VideoTrack', inputs: { images: ['v', 0], model: ['sam3', 0], detection_threshold: 0.35, max_objects: 4, detect_interval: 1, conditioning: ['txt', 0] } },
    m: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['trk', 0], object_indices: '' } },
    // la personne = détourage BiRefNet dans la zone suivie par SAM3 : les jours entre les bras et le corps,
    // que le masque SAM3 englobe, en sortent et VACE les redessine aussi
    bir: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: 'birefnet.safetensors' } },
    detw: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bir', 0], image: ['v', 0] } },
    zonew: { class_type: 'GrowMask', inputs: { mask: ['m', 0], expand: 4, tapered_corners: true } },
    pw: { class_type: 'MaskComposite', inputs: { destination: ['detw', 0], source: ['zonew', 0], x: 0, y: 0, operation: 'multiply' } },
    pb: { class_type: 'ThresholdMask', inputs: { mask: ['pw', 0], value: 0.5 } },
    // VACE redessine aussi une bande autour de la personne : une fente de quelques pixels resterait grise ;
    // la vraie personne est recollée par-dessus avec le détourage BiRefNet
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
    // 3) les personnes de la source recollées à sa définition : détourage BiRefNet dans la zone suivie par SAM3
    vh: { class_type: 'VHS_LoadVideo', inputs: { video: job.inpaintVideo, force_rate: 16, custom_width: W2, custom_height: H2, frame_load_cap: N, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    det: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['bir', 0], image: ['vh', 0] } },
    mh2: { class_type: 'ResizeMask', inputs: { mask: ['pb', 0], width: W2, height: H2, keep_proportions: false, upscale_method: 'bilinear', crop: 'disabled' } },
    // zone serrée : élargie de quelques pixels seulement, sinon le jour entre le bras et le corps y entre et l'ancien sol revient
    zone: { class_type: 'GrowMaskWithBlur', inputs: { mask: ['mh2', 0], expand: Math.max(3, Math.round(W2 / 320)), incremental_expandrate: 0, tapered_corners: true, flip_input: false, blur_radius: 2, lerp_alpha: 1, decay_factor: 1 } },
    alpha: { class_type: 'MaskComposite', inputs: { destination: ['det', 0], source: ['zone', 0], x: 0, y: 0, operation: 'multiply' } },
    fond: { class_type: 'ImageScale', inputs: { image: ['dec', 0], upscale_method: 'lanczos', width: W2, height: H2, crop: 'disabled' } },
    colle: { class_type: 'ImageCompositeMasked', inputs: { destination: ['fond', 0], source: ['vh', 0], x: 0, y: 0, resize_source: false, mask: ['alpha', 0] } },
    vid: { class_type: 'CreateVideo', inputs: { images: ['colle', 0], fps: 16 } },
    out: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/fond`, format: 'mp4', codec: 'h264' } },
  }
  return { g, W, H, N }
}

/* ---------- colorisation d'un clip (Wan 2.2 Fun VACE) ----------
   Le clip noir et blanc sert de guide (structure et mouvement), une image de référence
   déjà colorisée (sa 1re image restaurée par Qwen-Image-Edit) donne les couleurs, et un
   masque plein demande à VACE de repeindre toute l'image. Le mouvement et le cadrage
   restent ceux du clip ; la HD vient ensuite (SeedVR2). */
const COLORISER_MAX_IMAGES = 161
export function enqueueColorisationVideo({ source, reference, masque, bordsSeuls = false, parentAssetId, origineUri }) {
  // bordsSeuls : pas de couleur, VACE ne reconstruit que les bords laissés vides par la stabilisation (masque obligatoire)
  for (const n of [source, ...(bordsSeuls ? [] : [reference]), ...(masque || bordsSeuls ? [masque] : [])]) if (!n || /[\\/]/.test(n) || n.startsWith('.')) throw new Error('fichier invalide')
  const src = path.join(CONFIG.comfyInput, source)
  if (!fs.existsSync(src)) throw new Error('clip introuvable')
  const duree = videoDurationOf(src)
  if (!duree) throw new Error('vidéo illisible')
  if (duree > 10) throw new Error('10 s au plus pour la colorisation')
  const id = `couleur-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: SANS_PERSONNAGE, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'coloriser_video@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'coloriser_video', videoEngine: null,
    colSource: source, colReference: bordsSeuls ? null : reference, colMasque: masque ?? null, colBordsSeuls: bordsSeuls || undefined, origineUri: origineValide(origineUri),
    parentAssetId: parentAssetId ?? null, userPrompt: bordsSeuls ? 'bords reconstruits' : 'colorisation', userDirectives: null,
    composedPositive: bordsSeuls ? `bords de ${source} reconstruits` : `colorisation de ${source} (référence ${reference})`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(60_000 + duree * 75_000),
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
    // bords vides laissés par la stabilisation (blanc = image d'origine) : gris dans le guide, à inventer par VACE
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
  const { g, W, H, N } = grapheColoriser(job)
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

async function runInpaintVideo(job, t0) {
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
    // édition au prompt : SAM3 détecte et suit l'élément nommé, image par image
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
    // la zone peinte sur la 1re image amorce le suivi ; plus de texte de détection
    Object.assign(g.trk.inputs, { initial_mask: ['inp_masque', 0], max_objects: 1 })
    delete g.trk.inputs.conditioning
    delete g.cface
    zone = ['m0', 0]
  } else {
    // zone fixe dans le cadre : le masque peint, répété sur toutes les images
    for (const k of ['trk', 'm0', 'cface', 'sam3']) delete g[k]
    g.inp_compte = { class_type: 'GetImageSizeAndCount', inputs: { image: ['20', 0] } }
    g.inp_rep = { class_type: 'RepeatImageBatch', inputs: { image: ['inp_peint', 0], amount: ['inp_compte', 3] } }
    g.inp_masque.inputs.image = ['inp_rep', 0]
    zone = ['inp_masque', 0]
    if (job.inpaintLoin) {
      // au loin : la retouche épargne les personnes, l'objet reste derrière elles
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
  // nouveau fond : la zone refaite ne mord presque pas sur la personne, et le collage final se fond
  // sur une bande large et douce, sans liseré de l'ancien décor ni contour redessiné
  if (job.inpaintInverser) g.mg.inputs.expand = 4
  if (job.inpaintRetirer) {
    /* Pré-remplissage : l'image réduite à 24 px puis agrandie et floutée ne garde que les
       couleurs du décor ; collée dans la zone (élargie), elle efface l'objet avant l'encodage.
       Le modèle redessine alors du décor au lieu de retrouver l'objet dans le latent. */
    g.mg.inputs.expand = 40     // avale aussi ce qui « appelle » l'objet (une soucoupe redessine une tasse)
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
  g.inp_colle = { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: ['14', 0], x: 0, y: 0, resize_source: false, mask: ['inp_bord', 0] } }
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

/* ---------- avatar parlant ----------
   Une photo + un audio de voix → le personnage dit le texte, lèvres calées.
   InfiniteTalk (MeiGen-AI, Apache-2.0) sur Wan 2.1 I2V 14B 480p, nœuds cœur de
   ComfyUI. Un bloc rend 81 images à 25 i/s (3,24 s) ; le suivant reçoit toute la
   vidéo déjà rendue, reprend l'audio là où elle s'arrête, et ses 9 premières
   images doublonnent la fin du précédent : on les coupe avant de recoller. Le
   graphe est construit ici, bloc par bloc, à la durée de l'audio. */
const PAROLE_MAX_S = 20
const PAROLE_BLOC = 81, PAROLE_RECOUVRE = 9
export function enqueueParole({ image, audio, texte, parentAssetId, personaId }) {
  const t = String(texte ?? '').trim().slice(0, 400)
  if (t0Hit(t)) throw new Error('texte refusé (liste T0)')
  for (const f of [image, audio]) if (!f || /[\\/]/.test(f) || f.startsWith('.')) throw new Error('fichier invalide : nom nu attendu (dossier input/)')
  const duree = videoDurationOf(path.join(CONFIG.comfyInput, audio))
  if (!duree) throw new Error('audio illisible')
  if (duree > PAROLE_MAX_S) throw new Error(`audio trop long (${duree.toFixed(1)} s) : ${PAROLE_MAX_S} s au plus`)
  const images = Math.ceil(duree * 25) + 2
  const blocs = Math.max(1, 1 + Math.ceil(Math.max(0, images - PAROLE_BLOC) / (PAROLE_BLOC - PAROLE_RECOUVRE)))
  const id = `parole-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'parole@v1', workflowFile: null,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'parole', videoEngine: 'infinitetalk',
    sourceImage: image, paroleAudio: audio, paroleBlocs: blocs, paroleDuree: duree, parentAssetId: parentAssetId ?? null,
    userPrompt: t || null, userDirectives: null, composedPositive: t || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(40_000 + blocs * 75_000),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id, blocs, duree }
}

export function grapheParole(job, w, h) {
  const texte = `She is talking to the camera with natural facial expressions and small head movements, her lips moving in sync with her words. ${job.composedPositive ?? ''}`.trim()
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_i2v_480p_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    lx: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength_model: 1 } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: texte, clip: ['clip', 0] } },
    neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    patch: { class_type: 'ModelPatchLoader', inputs: { name: 'wan2.1_infiniteTalk_single_fp16.safetensors' } },
    aenc: { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: 'wav2vec2-chinese-base_fp16.safetensors' } },
    aud: { class_type: 'LoadAudio', inputs: { audio: job.paroleAudio } },
    aout: { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: ['aenc', 0], audio: ['aud', 0] } },
    img: { class_type: 'LoadImage', inputs: { image: job.sourceImage } },
    smp: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
  }
  let acc = null
  for (let k = 1; k <= job.paroleBlocs; k++) {
    g[`it${k}`] = { class_type: 'WanInfiniteTalkToVideo', inputs: {
      mode: 'single_speaker', model: ['lx', 0], model_patch: ['patch', 0], positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0],
      width: w, height: h, length: PAROLE_BLOC, audio_encoder_output_1: ['aout', 0], motion_frame_count: PAROLE_RECOUVRE, audio_scale: 1,
      start_image: ['img', 0], ...(acc ? { previous_frames: acc } : {}) } }
    g[`sch${k}`] = { class_type: 'BasicScheduler', inputs: { model: [`it${k}`, 0], scheduler: 'normal', steps: 6, denoise: 1 } }
    g[`gd${k}`] = { class_type: 'CFGGuider', inputs: { model: [`it${k}`, 0], positive: [`it${k}`, 1], negative: [`it${k}`, 2], cfg: 1 } }
    g[`nz${k}`] = { class_type: 'RandomNoise', inputs: { noise_seed: (Number(job.seed) || 42) + k } }
    g[`sa${k}`] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: [`nz${k}`, 0], guider: [`gd${k}`, 0], sampler: ['smp', 0], sigmas: [`sch${k}`, 0], latent_image: [`it${k}`, 3] } }
    g[`dec${k}`] = { class_type: 'VAEDecode', inputs: { samples: [`sa${k}`, 0], vae: ['vae', 0] } }
    if (!acc) acc = [`dec${k}`, 0]
    else {
      g[`trim${k}`] = { class_type: 'ImageFromBatch', inputs: { image: [`dec${k}`, 0], batch_index: PAROLE_RECOUVRE, length: 4096 } }
      g[`acc${k}`] = { class_type: 'ImageBatch', inputs: { image1: acc, image2: [`trim${k}`, 0] } }
      acc = [`acc${k}`, 0]
    }
  }
  // le dernier bloc est entier : on coupe la vidéo à la durée de la voix
  g.coupe = { class_type: 'ImageFromBatch', inputs: { image: acc, batch_index: 0, length: Math.max(1, Math.ceil(job.paroleDuree * 25)) } }
  g.vid = { class_type: 'CreateVideo', inputs: { images: ['coupe', 0], fps: 25, audio: ['aud', 0] } }
  g.save = { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/parole`, format: 'auto', codec: 'auto' } }
  return g
}

async function runParole(job, t0) {
  // 480p : la surface d'entraînement d'InfiniteTalk ; portrait, paysage ou carré selon la photo
  let w = 480, h = 832
  try {
    const d = videoSize(path.join(CONFIG.comfyInput, job.sourceImage))
    if (d.width && d.height) {
      if (d.width > d.height * 1.15) { w = 832; h = 480 } else if (d.width * 1.15 >= d.height) { w = 640; h = 640 }
    }
  } catch { /* format portrait par défaut */ }
  const g = grapheParole(job, w, h)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] AVATAR PARLANT ${job.paroleBlocs} bloc(s), ${job.paroleDuree.toFixed(1)} s d'audio, ${w}×${h} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [`avatar parlant : InfiniteTalk (Wan 2.1 I2V 480p), ${job.paroleBlocs} bloc(s) de 81 images, ${w}×${h}, audio « ${job.paroleAudio} » (${job.paroleDuree.toFixed(1)} s)`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* ---------- re-shoot : le même plan, vu d'ailleurs ----------
   Un clip de la bibliothèque + un angle → le même instant filmé par une autre
   caméra. MoGe-2 (géométrie métrique, nœud cœur) → CrossViewWarp (Cseti,
   Apache-2.0) reprojette le clip dans la nouvelle vue, trous en magenta →
   LTX-2.5 distillé + IC-LoRA CrossView-Warp v2 (Apache-2.0, entraînée sur
   LTX-2.3) remplit les trous et rend le plan ; deux guides IC à la 1re passe
   (le warp pour la géométrie, la source pour l'identité), la source seule à
   la passe ×2. Force 1,3, pivot auto sur le sujet, caméra
   qui garde la visée de la source ; ~2 min 15 pour 4 s. La variante MiniMax
   H3 de la LoRA est écartée : sa licence exclut l'UE, le Royaume-Uni et les
   États-Unis. */
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
  // 8n+1 images à 24 i/s, 5 s au plus : la longueur que les guides IC acceptent
  const images = Math.max(25, Math.min(121, Math.floor((Math.floor(duree * 24) - 1) / 8) * 8 + 1))
  const borne = (az, el) => ({ az: Math.max(-90, Math.min(90, az)), el: Math.max(-35, Math.min(45, el)) })
  let a = RESHOOT_ANGLES[angle]
  if (!a && Array.isArray(cles) && cles.length >= 2) {
    // mouvement posé dans la vue 3D : 2 à 4 poses, t de 0 (début du clip) à 1 (fin)
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

/* Clean plate : retirer des personnes ou des véhicules d'un clip, le décor
   reconstruit derrière. IC-LoRA officielle LTX-2.5 Clean-Plate (Lightricks, licence
   LTX-2.x Community) sur le même graphe que Re-shoot, guidé par le clip lui-même au
   lieu de sa vue déplacée. Le son de la prise d'origine est gardé. */
const CLEANPLATE_LORA = 'ltx/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors'
/* Verrou : « Retirer » efface ce qu'on lui nomme ; nommer un vêtement reviendrait à dévêtir
   quelqu'un. Un vêtement, un sous-vêtement ou une partie du corps est refusé, pour tout le monde. */
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
  // la forme des prompts de la fiche du modèle : le décor d'abord, puis ce qui ne doit plus y être
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

/* Effets vidéo en un clic : les IC-LoRA officielles LTX-2.5 de Lightricks (licence LTX-2.x Community),
   sur le même graphe que Clean plate (le clip guide seul, deux passes). Chaque effet = sa LoRA et sa phrase. */
export const EFFETS_LTX = {
  'refine-details': { lora: 'ltx/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors', nom: 'Refine Details',
    prompt: () => 'Sharp photographic detail, crisp textures, natural grain, high resolution footage. The exact same scene, motion and framing.' },
  'day-to-night': { lora: 'ltx/ltx-2.5-22b-ic-lora-day-to-night-0.9.safetensors', nom: 'Day to Night',
    prompt: t => `The exact same scene at night${t ? `: ${t}` : ''}, with the same camera movement and the same people and objects. Night lighting, realistic.` },
  'deblur': { lora: 'ltx/ltx-2.5-22b-ic-lora-deblur-0.9.safetensors', nom: 'Unblur',
    prompt: () => 'The exact same footage, sharp and in focus, with no motion blur and no defocus. Same scene, same motion.' },
  'decompression': { lora: 'ltx/ltx-2.5-22b-ic-lora-decompression-0.9.safetensors', nom: 'Remove Compression',
    prompt: () => 'The exact same footage, clean, with no compression artifacts, no blocking and no banding. Same scene, same motion.' },
  /* Les trois suivantes suivent leur fiche : une seule passe à la résolution de sortie (la 2e passe, guidée
     par la source, ramène le gris ou efface l'eau) et un prompt qui décrit la scène : la description est
     écrite par le modèle de vision sur la 1re image, au moment du rendu (`decrit`). */
  'restore': { lora: 'ltx/ltx-2.5-22b-ic-lora-restore-1.0.safetensors', nom: 'Restore', unePasse: true, decrit: true,
    neg: 'logos, signage, lettering, modern vehicles, graffiti, modern buildings, blurry, soft, plastic, smeared detail, oversharpened halos, warped faces',
    prompt: (t, d) => `${d || 'The same scene'}${t ? ` ${t}.` : ''} Natural colour, sharp photographic detail, crisp faces and clothing texture, natural grain, high resolution footage.` },
  'colorize': { lora: 'ltx/ltx-2.5-22b-ic-lora-colorization-0.9.safetensors', nom: 'Colorize', unePasse: true, decrit: true,
    neg: 'blur, distorted face, text, subtitles, logo, watermark, monochrome, sepia, desaturated',
    prompt: (t, d) => `Reference shows ${d ? d.replace(/\.$/, '') : 'the scene'}, in black and white. Edited shows the same scene with natural colors restored. COLORIZE the same scene in vivid natural colors${t ? `: ${t}` : ', with realistic skin tones, true-to-life clothing and surroundings'}. Subject identity, framing, and background geometry are identical to the reference; only color information differs between reference and edited.` },
  // force 1,25 : à 1 l'eau reste timide (quelques éclaboussures) ; la fiche situe les déformations à partir de 1,5
  'water': { lora: 'ltx/ltx-2.5-22b-ic-lora-water-simulation-0.9.safetensors', nom: 'Add Water', unePasse: true, decrit: true, force: 1.25,
    neg: '',
    prompt: (t, d) => `Reference shows ${d ? d.replace(/\.$/, '') : 'the scene'}. Edited shows the same scene with water added. ADD WATER ${t || 'the whole ground is flooded with ankle-deep clear water that ripples and surges, splashing up with white foam around every step and every wheel, the lights reflecting and dancing on its moving surface'}. Subject identity, clothing, framing, and background geometry are identical to the reference; only water-related elements differ between reference and edited.` },
}
/* Transitions générées du montage : LTX-2.5 relie la dernière image d'un plan à la première du suivant
   (deux guides à 0,7 en 1re et dernière position), avec le son. Les effets sont écrits selon la règle « l'effet
   couvre tout le cadre, la scène change pendant qu'il couvre, il se dissipe sur le plan suivant ». Les images de
   bord arrivent déjà coupées et recadrées au format du montage (montage.cadresTransition). */
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
// au format du montage, environ 0,9 Mpx, multiples de 32
const TAILLES_TRANSITION = { '9:16': [704, 1280], '16:9': [1280, 704], '1:1': [960, 960], '4:5': [832, 1024] }
function promptTransition(effet, secondes) {
  const e = EFFETS_TRANSITION[effet]
  // au-delà de 5 s, l'effet est tenu dans une fenêtre de 3 s au milieu : sans ça il s'étale sur toute la prise
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
    guide: { class_type: 'LTXVDualCFGGuider', inputs: { video_cfg: 1, audio_cfg: 1, model: ['unet', 0], positive: ['g1', 0], negative: ['g1', 1] } },
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
/* Restore, Colorize, Add Water : leur prompt décrit la scène. Le modèle de vision la lit sur la 1re image dès la
   mise en file, dans un bloc Ollama : dans le job, la carte est tenue par le rendu et la vision passerait sur CPU. */
const descriptionsEffet = new Map()
async function decrireSource(src, id) {
  const img = path.join(CONFIG.mediaDir, '.stage', `${id}_desc.jpg`)
  try {
    fs.mkdirSync(path.dirname(img), { recursive: true })
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=768:-2', img], { timeout: 30_000 })
    return await blocOllama(() => vision.describeScene(img))
  } catch { return null } finally { fs.rmSync(img, { force: true }) }
}

/* Détourer : SAM3 suit la personne, tout le reste passe sur fond vert uni, sans rien
   redessiner. Sortie MP4 prête pour un incrustateur ; son d'origine gardé. CPU/GPU modestes. */
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
/* Netteté : SeedVR2 3B agrandit n'importe quel clip à 1080 de petit côté, sans changer
   le mouvement. Apache-2.0. Le refine Wan reste la voie des brouillons. */
const SEEDVR_COTE = 1080
/** Chemin d'une source SeedVR2 : un média du studio, ou « input:<nom> » pour un clip envoyé par le propriétaire. */
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
/** Cadre utile d'une vidéo à bandes noires (détection sur les 2 premières secondes), ou null. */
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
  try { son = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* muet */ }
  try {
    const [n, d] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().split('/').map(Number)
    if (n && d) fps = n / d
  } catch { /* 24 par défaut */ }
  // bandes noires retirées avant l'agrandissement : sinon elles sont agrandies avec le reste
  const cadre = bandesNoires(src)
  // modèle 7B : visages naturels là où le 3B les rend cireux ; petite source (moins de 360p) en deux passes,
  // un saut x6 d'un coup ne reconstruit presque rien
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
  await comfy.freeMemory().catch(() => { /* non fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [petite ? `SeedVR2 7B en deux passes (540 puis ${SEEDVR_COTE})` : `SeedVR2 7B : ${SEEDVR_COTE} de petit côté`, ...(cadre ? ['bandes noires retirées'] : []), 'mouvement conservé'], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Restauration HD d'une photo : SeedVR2 (modèle de restauration) l'agrandit en reconstruisant le
   détail fin ; la retouche (rayures, couleur) se fait avant, par une passe d'édition ordinaire. */
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
  await comfy.freeMemory().catch(() => { /* non fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [`SeedVR2 3B : restauration à ${job.restaurationCote} px de petit côté`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Stage : une scène décrite par des nombres devient une maquette grise côté serveur
   (scripts/stage_clay.py), puis un plan fini : IC-LoRA LTX-2.5 Layout-to-Render (Lightricks), même
   graphe que Clean-Plate. Aucun fichier n'entre, le verrou d'envoi des visiteurs reste fermé. */
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

/* Danse en scène 3D : la danse Mixamo jouée par le mannequin dans un décor en volumes, filmée par une caméra
   qui l'accompagne (scripts/scene_danse.py, Blender) ; la 1re image est repeinte avec le personnage de la photo
   (Qwen Edit, deux images), puis LTX-2.5 + IC-LoRA Layout-to-Render en fait une vraie vidéo : le décor bouge
   avec la caméra, la danseuse se déplace dedans. */
/* Les studios de danse : la maquette est dans scripts/scene_danse.py (même identifiant), la phrase sert à repeindre la 1re image. */
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
export function enqueueDanse3d({ fbx, still, decor, scene: description, personaId, suivi, stageForce }) {
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
    reshootAngle: 'danse 3d', reshootCamera: { az: 0, el: 0 }, reshootImages: 121,
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

/* Modèles de Stage : un objet 3D du studio (media/<job>.glb) ou un .glb importé par le
   propriétaire (media/.stage/imp_*.glb). Le client ne donne qu'un nom, jamais un chemin. */
export function cheminModele(nom) {
  const n = path.basename(String(nom))
  if (n !== nom || !/^[\w.-]+\.glb$/.test(n)) return null
  const f = /^imp_/.test(n) ? path.join(CONFIG.mediaDir, '.stage', n) : path.join(CONFIG.mediaDir, n)
  return fs.existsSync(f) ? f : null
}

/* Objet 3D : une photo devient un GLB avec TRELLIS.2 (Microsoft, MIT), nœuds du cœur de
   ComfyUI. SAM3 isole l'objet nommé (BiRefNet n'a pas de noyau pour les cartes récentes). Le GLB reste à côté du média ;
   la bibliothèque reçoit un tour complet en maquette grise. */
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
    // vraie texture cuite : peintes sur les sommets, les couleurs sortent tachées
    uw: { class_type: 'UnwrapMesh', inputs: { mesh: ['sm', 0], segmenter: 'pec', resolution: 2048, padding: 1, weld_distance: 0.0002 } },
    bk: { class_type: 'BakeTextureFromVoxel', inputs: { mesh: ['uw', 0], voxel_colors: ['dt', 0], reference_mesh: ['dm', 0], texture_size: 2048 } },
    ap: { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['uw', 0], base_color: ['bk', 0], metallic: ['bk', 1], roughness: ['bk', 2] } },
    save: { class_type: 'SaveGLB', inputs: { mesh: ['ap', 0], filename_prefix: `creatoros/${job.id}/objet` } },
  }
}
/** Le GLB de ComfyUI embarque le graphe et ses chemins dans asset.extras : on le retire avant de le servir. */
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
  // un tour complet en maquette grise pour la bibliothèque
  const dossier = path.join(CONFIG.comfyOutput, 'creatoros', job.id)
  fs.mkdirSync(dossier, { recursive: true })
  const json = path.join(dossier, 'tour.json'), mp4 = path.join(dossier, 'tour.mp4')
  const camera = Array.from({ length: 13 }, (_, i) => { const a = i / 12 * 2 * Math.PI; return { t: i / 12, oeil: [3.4 * Math.sin(a), 1.3, 3.4 * Math.cos(a)], cible: [0, 0.75, 0], fov: 32 } })
  fs.writeFileSync(json, JSON.stringify({ largeur: 720, hauteur: 720, images: 97, objets: [{ type: 'modele', fichier: glb, x: 0, z: 0, h: 1.5 }], camera, lineaire: true }))
  // le tour texturé (Blender, le GLB tel qu'il sort, couleurs comprises) ; la maquette grise en repli
  let texture = true
  try { await executer(path.join(os.homedir(), 'apps', 'blender', 'blender'), ['-b', '-P', path.join(SCRIPTS, 'tour_texture.py'), '--', glb, mp4, '97', '720'], { timeout: 600_000 }) }
  catch (e) { texture = false; console.warn(`[job ${job.id}] tour texturé impossible, maquette grise — ${String(e.message || e).slice(0, 200)}`); await rendreClay(json, mp4) }
  history.outputs.tour = { images: [{ filename: 'tour.mp4', subfolder: `creatoros/${job.id}`, type: 'output' }] }
  const n = await harvestJob(job, promptId, history, { applied: [`objet 3D : SAM3 isole « ${job.userPrompt} », TRELLIS.2 construit le GLB, tour ${texture ? 'texturé (Blender EEVEE)' : 'en maquette grise'}`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Entraînement d'un personnage (cf. entrainement.js) : LoRA FLUX.2 Klein ajoutée au personnage. */
export function enqueueEntrainement({ personaId, images, declencheur, pas, essai, moteur = 'klein' }) {
  if (!aiToolkitPret()) throw new Error('ai-toolkit introuvable : installe-le, ou indique son dossier dans CREATOROS_AI_TOOLKIT')
  if (!moteurEntrainementPret(moteur)) throw new Error(`entraînement ${MOTEURS_ENTRAINEMENT[moteur]?.nom ?? moteur} indisponible sur ce studio`)
  if (images.length < (essai ? 1 : 8)) throw new Error('choisis au moins 8 images du personnage')
  const d = String(declencheur ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  if (d.length < 3) throw new Error('mot déclencheur : 3 à 16 lettres ou chiffres')
  const id = `train-${Date.now().toString(36)}`
  const n = Math.min(3000, Math.max(essai ? 10 : 600, Number(pas) || 1500))
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId, register: 'sfw', mode: 'photo', purpose: 'creative', recipeId: 'entrainement@v1', workflowFile: null,
    seed: 1, op: 'entrainement', sourceImage: null, entrainementImages: images.slice(0, 30), entrainementDeclencheur: d, entrainementPas: n, entrainementEssai: !!essai, entrainementMoteur: moteur,
    parentAssetId: null, userPrompt: `LoRA ${MOTEURS_ENTRAINEMENT[moteur].nom} · ${d} · ${n} steps · ${Math.min(30, images.length)} images`, userDirectives: null, composedPositive: null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: dureeEstimeeMs(moteur, n),
  }
  store.createJob(row); queue.push(row); pump()
  return { id }
}
/** Avancement des entraînements en cours (pas faits / pas prévus), pour l'écran du personnage. */
export const avancementEntrainements = new Map()
async function runEntrainement(job, t0) {
  store.markStarted(job.id, null)
  current = { jobId: job.id, promptId: null }
  await comfy.freeMemory().catch(() => {})
  const moteur = job.entrainementMoteur ?? 'klein'
  const prep = preparerEntrainement({ id: job.id, images: job.entrainementImages, declencheur: job.entrainementDeclencheur, pas: job.entrainementPas, moteur })
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
    const champ = moteur === 'krea' ? 'loras' : 'lorasKlein'
    enregistrerPersona({ [champ]: [...p[champ].filter(l => l.name !== nom), { name: nom, strength: 1 }], ...(p.trigger ? {} : { trigger: job.entrainementDeclencheur }) }, job.personaId)
  }
  console.log(`[job ${job.id}] LoRA ${nom} prête${job.entrainementEssai ? ' (essai, non attachée)' : ', ajoutée au personnage'}`)
  store.markFinished(job.id, Date.now() - t0)
  return 0
}

/* Doublage : InfiniteTalk (Wan 2.1, Apache-2.0), nœuds du cœur de ComfyUI. Le clip est réencodé
   et débruité en partie : la scène et le geste restent, les lèvres suivent la nouvelle voix.
   81 images à 25 i/s, soit 3,2 s par passe : un clip plus long est doublé sur ses 3,2 premières secondes. */
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

/* Relance d'un rendu spécialisé (doublage, recadrage, 3D, re-shoot…) avec ses réglages d'origine,
   si ses fichiers d'entrée sont encore là. Les rendus photo et vidéo ordinaires passent par enqueue. */
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

/* Extension : un workflow ComfyUI fourni par une extension (cf. extensions.js), déjà rempli et
   vérifié. Sa sortie est une image, une vidéo ou un son ; les sons rejoignent la bibliothèque audio. */
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

/* Musique et bruitages : ACE-Step 1.5 turbo (MIT), nœuds du cœur de ComfyUI. Le morceau
   rejoint le dossier des musiques du montage et du reel. */
/* Réglages explicites d'un morceau, tous facultatifs : vides, le studio les déduit du style
   (profilMusique) et des paroles (langueParoles). Listes blanches = les choix du nœud
   TextEncodeAceStepAudio1.5. */
const NOTES_MUSIQUE = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']
const TONALITES_MUSIQUE = new Set(NOTES_MUSIQUE.flatMap(n => [`${n} major`, `${n} minor`]))
const MESURES_MUSIQUE = new Set(['2', '3', '4', '6'])
const LANGUES_MUSIQUE = new Set(['ar', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'ht', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'la', 'lt', 'ms', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sa', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'yue', 'zh', 'unknown'])
/* Type de voix chantée → étiquette ajoutée aux tags ACE-Step ; « none » rend le morceau instrumental. */
const VOIX_CHANTEES = { female: 'female vocals', male: 'male vocals', duet: 'male and female duet vocals', choir: 'choir vocals', none: 'instrumental, no vocals' }
const BPM_MIN = 40, BPM_MAX = 220

/** Valide les réglages facultatifs d'un morceau ; un champ vide reste null (comportement automatique). */
function reglagesMusique({ bpm, tonalite, mesure, langue, voix, instruments }) {
  const vide = v => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === 'auto'
  const r = { bpm: null, tonalite: null, mesure: null, langue: null, voix: null, instruments: [] }
  if (!vide(bpm)) {
    const n = Math.round(Number(bpm))
    if (!Number.isFinite(n)) throw new Error('tempo invalide')
    r.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, n))
  }
  if (!vide(tonalite)) {
    // notation courte acceptée (« Dm », « F# », « Bbm ») : l'interface évite ainsi le mot « minor », refusé par le filtre de contenu
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
  // un bruitage n'a que sa description : ni paroles, ni voix, ni réglages musicaux
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
/** Tags ACE-Step : le style, puis les instruments, puis le type de voix chantée. */
function tagsMusique(job) {
  if (job.musiqueBruitage) return `sound effect, foley, no music, no vocals, ${job.userPrompt}`
  const instr = (job.musiqueInstruments ?? []).filter(x => !String(job.userPrompt).toLowerCase().includes(String(x).toLowerCase()))
  return [job.userPrompt, ...instr, job.musiqueVoix ? VOIX_CHANTEES[job.musiqueVoix] : null].filter(Boolean).join(', ')
}
/* Tempo et tonalité du morceau d'après le style décrit : le premier genre reconnu donne son tempo
   et une tonalité courante du genre ; un tempo écrit dans la consigne (« 128 bpm ») l'emporte. */
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

/* La langue chantée, reconnue aux mots-outils les plus fréquents des paroles (anglais par défaut). */
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

/* Des paroles sans balises sont structurées pour ACE-Step : les strophes séparées par une ligne vide
   alternent [Verse] / [Chorus] (la 2e est le refrain, reprise après le 2e couplet) ; un bloc d'un seul
   tenant est coupé en strophes de 4 lignes. Des paroles déjà balisées restent telles quelles. */
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

const PRISES_MUSIQUE = 2   // deux prises par demande (graines différentes) : l'opérateur garde la meilleure

async function runMusique(job, t0) {
  const d = job.musiqueSecondes, s = Number(job.seed) || 42
  const tags = tagsMusique(job)
  // un réglage explicite l'emporte ; sinon tempo et tonalité viennent du style, la langue des paroles
  const auto = profilMusique(job.userPrompt)
  const bpm = job.musiqueBpm ?? auto.bpm, keyscale = job.musiqueTonalite ?? auto.keyscale, timesignature = job.musiqueMesure ?? '4'
  const lyrics = job.musiqueBruitage || job.musiqueVoix === 'none' ? '[instrumental]' : structurerParoles(job.musiqueParoles)
  const language = lyrics === '[instrumental]' ? 'en' : job.musiqueLangue ?? langueParoles(job.musiqueParoles)
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_turbo.safetensors', weight_dtype: 'default' } },
    ms: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['unet', 0], shift: 3 } },
    clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_4b_ace15.safetensors', type: 'ace', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
    lat: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: d, batch_size: 1 } },
  }
  // une branche par prise : chacune a sa graine, donc ses propres codes audio
  for (let p = 0; p < PRISES_MUSIQUE; p++) {
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
  // ACE-Step sort à 0 dB : niveau ramené à celui d'une musique de fond, sans saturation.
  // La 1re prise garde le nom attendu par les reels (…_<id>.mp3), les suivantes prennent _2, _3…
  for (const [p, f] of sorties.entries()) {
    const nom = `${racine}_${job.id.slice(-6)}${p ? `_${p + 1}` : ''}.mp3`
    await executer('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(CONFIG.comfyOutput, f.subfolder ?? '', f.filename), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'libmp3lame', '-q:a', '2', path.join(MUSIQUES_DIR, nom)], { timeout: 60_000 })
  }
  store.markFinished(job.id, Date.now() - t0)
  return 1
}

/* Objet peint dans un clip : la zone peinte est suivie par SAM3, l'objet de la photo de
   référence y est détouré et collé image par image, puis la retouche Wan le fond dans la scène. */
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
/* Fond transparent : SAM3 donne le masque de la personne (ou de l'objet nommé), la photo sort en PNG avec alpha,
   rien n'est redessiné. BiRefNet n'a pas de noyau pour les cartes récentes (« no kernel image »). */
export function enqueueTransparent({ sourceFile, parentAssetId, personaId, sujet }) {
  const id = `transp-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'transparent@v1', workflowFile: null,
    seed: 1, op: 'transparent', sourceImage: sourceFile, parentAssetId: parentAssetId ?? null,
    // ce que SAM3 garde : une personne par défaut, ou l'objet nommé (« perfume bottle »)
    detourSujet: sujetDetour(sujet),
    userPrompt: 'transparent background', userDirectives: null, composedPositive: null, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: 8000,
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
}
/* Carte de profondeur : Depth Anything V2 sur la photo, en niveaux de gris (proche = clair),
   à la résolution de la photo ; sert au compositing, au relief et aux ControlNet. */
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
/* ---------- Klein par références : essayage, photodump ----------
   ESSAYAGE (`essayage`) : la personne de la photo porte le vêtement d'une seconde photo
   (vêtement seul, à plat ou sur cintre). FLUX Klein reçoit les deux images en références
   (ReferenceMultiLatent) ; la sortie garde le cadre de la photo de la personne.
   PHOTODUMP (`photodump`) : quatre photos du quotidien de la même personne, d'après une
   seule photo (rue, café, bord de l'eau, selfie miroir), en 2:3. */
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

/* ---------- référence de style : Krea 2 Turbo + LoRA style-reference ----------
   La photo choisie ne donne que le STYLE (trait, palette, matière) ; la scène vient du texte. */
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
  try { son = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* muet */ }
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
  /* Fond transparent : même suivi, sortie WebM VP9 avec alpha, lisible dans un navigateur et OBS. */
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
  // VHS range ses vidéos sous `gifs`, le ramassage ne lit que `images`
  if (job.detourAlpha) for (const o of Object.values(history.outputs ?? {})) if (o.gifs) o.images = o.gifs.filter(f => /\.webm$/i.test(f.filename))
  const n = await harvestJob(job, promptId, history, { applied: [`détourage : SAM3 suit « ${job.userPrompt} », ${job.detourAlpha ? 'WebM avec alpha' : 'fond vert'}, ${N} images ${W}×${H}`], skipped: [], finalWorkflow: g })
  store.markFinished(job.id, Date.now() - t0)
  return n
}

/* Scène 3D d'un clip pour la vue Re-shoot : MoGe-2 sur la 1re image, maillage
   texturé (MoGePointMapToMesh) en GLB, à la même demi-taille que le warp — les
   angles posés à la souris tombent donc sur la géométrie que verra le nœud.
   Mise en cache par clip. Le GLB de ComfyUI embarque le graphe (chemins
   absolus compris) dans asset.extras : on le retire avant de le servir. */
const scenesEnCours = new Map()
/** Le graphe de la scène 3D : MoGe-2 sur la 1re image, maillage texturé, GLB. */
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
    // le même instant : le son de la prise d'origine quand elle en a un
    vid: { class_type: 'CreateVideo', inputs: { images: ['dec', 0], audio: sonSource ? ['src', 2] : ['adec', 0], fps: 24 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: `creatoros/${job.id}/reshoot`, format: 'auto', codec: 'auto' } },
  }
  if (job.op === 'stage' || job.op === 'danse3d') {
    // la maquette grise guide seule : pas de géométrie ni de vue déplacée
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    // force de l'IC-LoRA de mise en scène : 1 par défaut ; plus haut (banc du propriétaire), LTX colle davantage au mannequin
    Object.assign(g.lora.inputs, { lora_name: STAGE_LORA, strength_model: Number.isFinite(job.stageForce) ? Math.min(2, Math.max(0.5, job.stageForce)) : 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = 'grey clay, mannequin, blocks, untextured, text, subtitles, logo, watermark, distorted face'
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/stage`
    // l'image de style, posée en images-clés aux deux passes : le modèle prend son aspect de cette 1re image
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
    // un effet : le clip guide seul, comme clean plate, avec la LoRA de l'effet
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    const e = EFFETS_LTX[job.effetLtx]
    Object.assign(g.lora.inputs, { lora_name: e.lora, strength_model: e.force ?? 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = e.neg ?? 'blur, distorted face, text, subtitles, logo, watermark'
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/effet`
    if (e.unePasse) {
      // une seule passe, à la taille de sortie : la source guide tout le débruitage, rien ne la redessine ensuite
      Object.assign(g.lat1.inputs, { width: W, height: H })
      g.g2.inputs.image = ['full', 0]
      g.dec.inputs.samples = ['crop1', 2]
      g.adec.inputs.samples = ['sep1', 1]
      for (const k of ['half', 'upm', 'up', 'g3', 'av2', 'gd2', 'sg2', 'n2', 'k2', 'sep2', 'crop2']) delete g[k]
    }
  }
  if (job.op === 'cleanplate') {
    // clean plate : pas de géométrie ni de vue déplacée, le clip guide seul (facteur de réduction 1)
    for (const k of ['mogem', 'moge', 'warp', 'g1']) delete g[k]
    Object.assign(g.lora.inputs, { lora_name: CLEANPLATE_LORA, strength_model: 1 })
    g.pos.inputs.text = String(job.composedPositive ?? '')
    g.neg.inputs.text = `${job.userPrompt ?? 'people'}, person, figure, silhouette, ghost, blur, text, subtitles, logo, watermark`
    g.g2.inputs.positive = ['cond', 0]; g.g2.inputs.negative = ['cond', 1]; g.g2.inputs.latent = ['lat1', 0]
    g.save.inputs.filename_prefix = `creatoros/${job.id}/cleanplate`
  }
  return g
}

/* La 1re image de Stage : Qwen Edit peint la maquette, à la même place, avec le même cadre. */
async function peindreLook(job) {
  // la maquette se dessine ici : avec des modèles 3D elle prend plusieurs secondes
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
  // le teint de la personne de la photo : le mannequin le prend, quelle que soit sa couleur de peau
  let teint = '0.620,0.360,0.250'
  try { teint = (await executer(pythonComfy(), [path.join(SCRIPTS, 'teint.py'), path.join(CONFIG.comfyInput, job.danseStill), path.join(CONFIG.dataDir, 'modeles-controle')], { timeout: 60_000 })).stdout.trim().split('\n').pop() || teint } catch { /* teint moyen */ }
  await executer(path.join(os.homedir(), 'apps', 'blender', 'blender'), ['-b', '-P', path.join(SCRIPTS, 'scene_danse.py'), '--', job.danseFbx, brut, '5', job.danseDecor, teint], { timeout: 300_000 })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', brut, '-vf', 'fps=24', '-frames:v', '121', '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', maquette], { timeout: 60_000 })
  const clay = `STAGE_${job.id}.png`
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', maquette, '-frames:v', '1', path.join(CONFIG.comfyInput, clay)], { timeout: 30_000 })
  /* Le personnage est posé à la place exacte du mannequin (même taille, pieds au même endroit) : une retouche
     à deux images recopiait le cadrage de la photo et donnait une 2e personne, le vrai danseur, derrière elle. */
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
  const g = comfy.loadWorkflow(EDIT_WORKFLOW)
  g['10'].inputs.image = pose
  g['30'].inputs.prompt = 'Turn this grey 3D blocking into a finished photograph. Keep the exact camera and framing. '
    + 'The woman keeps the same face, hair, outfit and shoes, at exactly the same place and the same size in the frame, '
    + 'but she is relit by the light of the place: the same colour, direction and intensity of light on her skin, hair and clothes as on the scene around her, with matching shadows. '
    + `The grey blocks become ${(STUDIOS_DANSE[job.danseDecor] ?? STUDIOS_DANSE.salon).texte}, with real materials and light. `
    + 'She is the only person in the place: no other people anywhere, not even tiny figures far away in the background. Real photo.'
  g['40'].inputs.seed = Number(job.seed) || 42
  g['90'].inputs.filename_prefix = `creatoros/${job.id}/look`
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
  // côté long 1280, multiples de 64 (la passe ×2 part d'une demi-taille multiple de 32)
  let W = 704, H = 1280
  if (d.width && d.height) {
    if (d.width > d.height * 1.15) { W = 1280; H = 704 } else if (d.width * 1.15 >= d.height) { W = 960; H = 960 }
  }
  if (job.op === 'effetltx' && EFFETS_LTX[job.effetLtx]?.decrit && descriptionsEffet.has(job.id)) {
    // la description lancée à la mise en file (au plus 4 min d'attente) ; une relance garde le prompt déjà écrit
    const desc = await Promise.race([descriptionsEffet.get(job.id), new Promise(r => setTimeout(() => r(null), 240_000))])
    descriptionsEffet.delete(job.id)
    if (desc) {
      const t = job.userPrompt && job.userPrompt !== EFFETS_LTX[job.effetLtx].nom ? job.userPrompt : ''
      job.composedPositive = EFFETS_LTX[job.effetLtx].prompt(t, desc.replace(/\s+/g, ' ').trim())
      store.setComposedPositive(job.id, job.composedPositive)
    }
  }
  let sonSource = false
  try { sonSource = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim().length > 0 } catch { /* pas de son */ }
  const g = grapheReshoot(job, W, H, sonSource)
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const cam = job.reshootCamera
  const angle = cam.cles ? cam.cles.map(k => `az ${k.az}° él ${k.el}°`).join(' → ') : `az ${cam.az}° él ${cam.el}°`
  console.log(`[job ${job.id}] RE-SHOOT ${angle}, ${job.reshootImages} images ${W}×${H} prompt_id=${promptId}`)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, {
    applied: [job.op === 'effetltx' ? `effet : LTX-2.5 + IC-LoRA ${EFFETS_LTX[job.effetLtx]?.nom} (Lightricks), ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}` : job.op === 'danse3d' ? `danse 3D : scène Blender (${job.danseDecor}) → 1re image repeinte avec le personnage (Qwen Edit) → LTX-2.5 + IC-LoRA Layout-to-Render, ${job.reshootImages} images ${W}×${H}` : job.op === 'stage' ? `stage : maquette grise → LTX-2.5 + IC-LoRA Layout-to-Render (Lightricks), ${job.reshootImages} images ${W}×${H}` : job.op === 'cleanplate'
      ? `clean plate : LTX-2.5 + IC-LoRA Clean-Plate (Lightricks), « ${job.userPrompt} » retiré, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`
      : `re-shoot : MoGe-2 → CrossViewWarp → LTX-2.5 + IC-LoRA CrossView-Warp v2 (force 1,3), ${angle}, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  if (job.op === 'danse3d' && n > 0) {
    try { enchainerSwapDanse(job) } catch (e) { console.warn(`[job ${job.id}] Swap non enchaîné — ${e.message || e}`) }
  }
  return n
}

/* Danse 3D, 2e passe : LTX a fait le décor, la caméra et la danse ; le Swap (SCAIL-2) redessine la danseuse d'après
   la photo (visage, peau, chaussures). La référence est remise à l'échelle de la danseuse de la vidéo, sinon le Swap la
   dessine plus grande, trop près ; 1280 px : les mains et le tissu tiennent mieux qu'en 896. */
function enchainerSwapDanse(job) {
  const a = store.assetsOfJob(job.id).find(x => x.media_type === 'video')
  if (!a) throw new Error('rendu LTX introuvable')
  const driver = `crs_${job.id}_drv.mp4`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, driver))
  store.noterInput(driver, 'danse')
  /* La référence du Swap : la 1re image repeinte (STAGE_…_look.png). La danseuse y est déjà à l'échelle de la vidéo et
     sous la lumière du studio (néons, coucher de soleil…) ; avec la photo d'origine, le Swap recollait sa lumière à elle,
     plate, sur une scène qui n'a pas la même. Repli : la photo remise à l'échelle. */
  let ref = job.stageLook && fs.existsSync(path.join(CONFIG.comfyInput, job.stageLook)) ? job.stageLook : null
  if (ref) store.noterInput(ref, 'genere')
  if (!ref) ref = refAEchelle(job)
  const geste = 'She dances with energy and a big smile, following the rhythm, her whole body visible.'
  enqueue({ id: `${job.id}-swap`, mode: 'video', register: 'sfw', purpose: 'creative', personaId: job.personaId,
    motionDriver: driver, motionRef: ref, motionMode: 'replace', swapLong: 1280, danseSuivi: job.danseSuivi === true ? true : undefined,
    composedPositive: geste, userPrompt: geste, composedNegative: '',
    motionSceneText: `A young woman dancing alone in ${(STUDIOS_DANSE[job.danseDecor] ?? STUDIOS_DANSE.salon).texte}, lit by the light of the place, with nobody else anywhere in the place. ${geste}`, parentAssetId: a.id })
  console.log(`[job ${job.id}] Swap enchaîné : ${job.id}-swap (référence ${ref})`)
}

/* Danse 3D finie : seule la version redessinée (…-swap) reste en bibliothèque. La vidéo intermédiaire de la scène part
   à la corbeille (récupérable), et sa provenance (scène, 1re image, graphe LTX) est jointe à celle du résultat final. */
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

/* ---------- finitions d'un clip existant : bruitage et fluidité ----------
   BRUITAGE (`foley`) : un clip muet (Wan, motion) reçoit une piste d'ambiance
   générée par LTX-2.5 à partir de ses images. Le clip est encodé dans le
   latent vidéo avec un masque de bruit NUL : le modèle le garde tel quel et
   ne génère que l'audio, calé sur ce qu'il voit (45 s pour
   5 s, images restituées à 31 dB). Les images livrées sont celles du clip
   d'origine — seule la piste son est ajoutée. Pas de voix ni de musique.
   FLUIDITÉ (`interpolate`) : RIFE ×2 sur le clip (24 → 48 i/s), son conservé. */
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
    /* Copie de travail pour LTX : 24 i/s, 8n+1 images, côtés multiples de 32,
       ~0,25 MP — l'audio n'a besoin que de « voir » la scène. */
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
      // les images livrées sont celles du clip d'ORIGINE, à sa cadence
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
  if (job.op === 'foley') await comfy.freeMemory().catch(() => { /* non fatal */ })
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  console.log(`[job ${job.id}] ${job.op === 'foley' ? 'BRUITAGE LTX' : 'FLUIDITÉ RIFE ×2'} sur ${job.finitionSource} prompt_id=${promptId}`)
  // copies de travail laissées dans input/ (comme l'upscale) : une relance les relit
  const history = await comfy.waitForPrompt(promptId, {
    onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
  })
  const n = await harvestJob(job, promptId, history, {
    applied: [job.op === 'foley'
        ? `bruitage LTX-2.5 (vidéo → son, images d'origine conservées) : « ${job.composedPositive} », sonie ramenée à -18 LUFS`
      : job.composedPositive],
    skipped: [], finalWorkflow: g,
  })
  /* La piste générée sort environ 30 dB trop bas (-53 dB de moyenne, mesuré le 07/11) : on la ramène à -18 LUFS,
     l'image n'est pas réencodée. */
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
  /* L'AUDIO du brouillon suit l'upscale — mais SEULEMENT s'il existe.
     VHS_LoadVideo tente d'extraire la piste dès qu'on branche sa sortie
     audio, et échoue tout le job sur un clip muet (« VHS failed to extract
     audio ») : c'est le cas de tous les rendus Wan, qui n'ont pas d'étage
     audio. On sonde la source avant de câbler. */
  const srcPath = path.join(CONFIG.comfyInput, job.upscaleSource)
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', srcPath],
      { encoding: 'utf8' }).trim().length > 0
  } catch { /* sonde impossible : on reste muet, c'est le cas sûr */ }
  if (g['15'] && hasAudio) g['15'].inputs.audio = ['20', 2]
  else if (g['15']) delete g['15'].inputs.audio
  console.log(`[job ${job.id}] upscale : source ${hasAudio ? 'avec' : 'SANS'} piste audio`)
  /* Cadence : sortie 30 fps MINIMUM (16 fps se voit).
     Source < 24 fps (Wan draft 16) : refine à 15 fps puis RIFE x2 → 30 exact,
     l'interpolation se fait APRÈS le refine (2x moins de frames à échantillonner).
     Source >= 24 : cadence native conservée (24/25/30). */
  /* Mi-cadence UNIVERSELLE + RIFE x2 : on refine moitié moins de frames
     (150→75 sur une source 30 fps ≈ 2x plus vite) et RIFE reconstitue la
     cadence — sortie 30 pour les sources < 24, cadence native sinon. */
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
  // VRAM libre pour le refine Wan (sinon 87 % du modèle offloadé en RAM)
  await comfy.freeMemory().catch(() => { /* non fatal */ })
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

/** Fluidité des rendus motion : WanAnimate travaille et livre à 16 i/s,
 *  ce qui se voit. RIFE ×2 double les images APRÈS le rendu : le modèle reste à
 *  sa cadence d'entraînement, la sortie passe à 32 i/s. Pas de retour à 30 :
 *  jeter 1 image sur 16 recréerait une cadence boiteuse (cf. probeDriver).
 *  Non fatal — en cas d'échec le rendu à 16 i/s est livré tel quel. */
async function fluidifier(file, jobId) {
  const inName = `rife_${jobId}.mp4`
  const inPath = path.join(CONFIG.comfyInput, inName)
  try {
    const fps = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }).trim().split('/').reduce((a, b) => Number(a) / Number(b)))
    if (!Number.isFinite(fps) || fps >= 24) return null   // déjà fluide : rien à faire
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

/* ---------- mise en conformité du fichier livré ----------
   Deux corrections, dans la même passe ffmpeg pour ne ré-encoder qu'une fois :

   VITESSE. Les modèles animent à ~60 % de la vitesse naturelle. Plutôt que
   d'appliquer un facteur théorique, on MESURE la durée rendue et on ramène à
   la durée demandée. C'est ce qui rend le réglage honnête : MiniMax quantifie
   son nombre d'images sur 17 et LTX n'accepte qu'un entier de secondes, donc
   aucun des deux ne rend exactement la longueur qu'on lui demande. Wan, lui,
   génère déjà la bonne durée — l'écart tombe sous le seuil et rien n'est fait.

   `atempo` et pas seulement `setpts` : accélérer la vidéo sans traiter le son
   le transposerait vers l'aigu, et la voix générée doit rester la même voix.
   `atempo` accepte 0,5 à 2,0 ; au-delà il faut l'enchaîner.

   CADENCE. `-r` fixe la cadence du fichier. Au-dessus de la cadence native
   cela DUPLIQUE des images — ça n'invente pas de mouvement, et l'interface le
   dit plutôt que de laisser croire à une fluidité gagnée. */
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
  // 2 % de tolérance : un ré-encodage pour corriger un centième de seconde
  // coûterait de la qualité sans rien apporter.
  const needSpeed = Math.abs(factor - 1) > 0.02
  const needFps = Number.isFinite(fps) && Number.isFinite(srcFps) && Math.abs(fps - srcFps) > 0.01
  if (!needSpeed && !needFps) return null

  const tmp = file.replace(/(\.\w+)$/, '.conform$1')
  try {
    const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== ''
    // atempo est borné à [0,5 ; 2] : on l'enchaîne pour les facteurs plus grands.
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
    // Un clip au ralenti reste un clip : on le livre, en le disant. Le perdre
    // pour un ffmpeg absent serait pire.
    fs.rmSync(tmp, { force: true })
    console.warn(`[conform] ${path.basename(file)} livré tel quel — ${e.message || e}`)
    return null
  }
}

/* Passe MATE : dé-brillance (compression des hautes lumières via `curves`) +
   micro-grain. Les modèles distillés (MiniMax H3, WanAnimate) sortent une peau
   glossy/plastique ; cette passe la mate sans assombrir l'image ni toucher
   l'identité. C'est SIMULÉ (pas de texture native regagnée) mais ça sort le
   rendu du plastique sans toucher au sampler. AUDIO PRÉSERVÉ : MiniMax H3 a
   du son natif — on ne le coupe que s'il n'y en a pas. Non fatal. */
function matteVideo(file) {
  const tmp = file.replace(/(\.\w+)$/, '.matte$1')
  // Courbe ADOUCIE : plus forte (blancs→0.82, mids −17 %), elle rend les
  // i2v « ternes » — highlights écrasés + désaturation (mesuré : Ymax
  // plafonné ~194, SAT −18 % vs brut). De-gloss léger (blancs
  // →0.94) + saturation +10 % pour garder du pop, en conservant le grain
  // anti-plastique. Les extensions ne sont pas matées (voir harvest).
  const vf = "curves=all='0/0 0.5/0.49 0.75/0.70 0.9/0.86 1/0.94',eq=saturation=1.10,noise=alls=4:allf=t"
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== ''
  } catch { /* pas d'audio détectable → muet */ }
  try {
    const args = ['-y', '-v', 'error', '-i', file, '-vf', vf,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']
    args.push(...(hasAudio ? ['-c:a', 'copy'] : ['-an']))
    args.push(tmp)
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    fs.renameSync(tmp, file)
    return 'mate : dé-brillance + grain' + (hasAudio ? ' (audio conservé)' : '')
  } catch (e) {
    // Réversible et non fatal : sans la passe on livre le rendu tel quel.
    fs.rmSync(tmp, { force: true })
    console.warn(`[matte] ${path.basename(file)} livré tel quel — ${e.message || e}`)
    return null
  }
}

/* Luma/saturation moyennes d'une fenêtre (signalstats). Sert à mesurer la
   MARCHE de couleur à la couture d'extension. Null si illisible. */
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

/* Correction couleur de la continuation pour matcher la QUEUE de la source.
   L'i2v ré-expose plus sombre + désature que l'image
   de conditionnement (mesuré : ~−13 luma, ~−3 sat dès la 1re frame), d'où une
   marche visible à la couture. On aligne la tête de continuation sur la fin de
   source par un gain luma + échelle de saturation, bornés pour qu'une mesure
   aberrante (flash/fondu au raccord) ne dérègle pas tout le plan. Chaîne de
   filtre vide si non mesurable → concat brut inchangé. */
function seamMatchFilter(srcPath, contPath, prequel = false) {
  /* Prequel : le rendu passe DEVANT la source — la couture est entre
     la QUEUE du rendu et la TÊTE de la source. */
  const src = prequel ? meanYSat(srcPath, 0, 0.5)
    : meanYSat(srcPath, Math.max(0, videoDurationOf(srcPath) - 0.5), 0.5)
  const cont = prequel ? meanYSat(contPath, Math.max(0, videoDurationOf(contPath) - 0.5), 0.5)
    : meanYSat(contPath, 0, 0.5)
  if (!src || !cont || cont.y < 1 || cont.s < 1) return ''
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const gain = clamp(src.y / cont.y, 0.9, 1.3)
  const sat = clamp(src.s / cont.s, 0.9, 1.25)
  // Chroma (teinte / balance des blancs) : l'i2v ne shifte pas que la luma, il
  // décale aussi la MOYENNE U/V (mesuré : hue 135→118, V 140→135) → tons plus
  // froids. eq=saturation scale la chroma autour de 128, ce qui déplace déjà la
  // moyenne ; on calcule l'offset résiduel APRÈS ce scale pour recaler la
  // moyenne U/V post-sat sur celle de la source. Offsets bornés ±12 pour qu'un
  // raccord atypique ne vire pas la colorimétrie.
  // Chroma matchée en scale+offset DANS lutyuv (pas via eq : le déplacement de
  // moyenne d'eq=saturation est opaque et cassait la calibration de l'offset).
  // Pour chaque canal : out = (val-128)*sat + 128 + offset. L'offset recale la
  // moyenne post-scale sur celle de la source ; bornes ±12 anti-dérive.
  const postSat = (m) => (m - 128) * sat + 128
  const du = clamp(src.u - postSat(cont.u), -12, 12)
  const dv = clamp(src.v - postSat(cont.v), -12, 12)
  // Rien à corriger si tout est négligeable (luma/sat < 2 %, chroma < 1 niveau).
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

/* Recolore EN PLACE le clip de continuation pour matcher la queue de la source
   (même calcul que le seam du concat, mais appliqué à l'asset livré `-0`, pas
   seulement au `-full`). Ainsi le clip standalone d'une extension n'apparaît
   plus plus sombre/terne que la source en galerie. Audio préservé, non fatal :
   un échec laisse le rendu brut. Une fois corrigé ici, le seam du concat mesure
   ~0 et se saute (garde < 2 %), pas de double correction. */
function seamMatchInPlace(contFile, srcPath, prequel = false) {
  const suffix = seamMatchFilter(srcPath, contFile, prequel)   // ",eq=...,lutyuv=..." ou ""
  if (!suffix) return null
  const vf = suffix.replace(/^,/, '')
  const tmp = contFile.replace(/(\.\w+)$/, '.seam$1')
  let hasAudio = false
  try {
    hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', contFile], { encoding: 'utf8' }).trim() !== ''
  } catch { /* muet */ }
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

/* ---------- concat extension : source + continuation en un fichier ----------
   Ré-encodage obligatoire (codecs et résolutions différents) : les deux
   segments sont normalisés à la RÉSOLUTION DE LA CONTINUATION (le rendu
   neuf), 24 fps, yuv420p. La continuation est recolorée pour matcher la fin de
   la source (couture seamless). L'audio n'est concaténé que si LES DEUX en ont
   — sinon le fichier est muet plutôt que d'inventer un silence désynchronisé. */
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

/** Dimensions d'un média vidéo. `pngSize` ne sait pas les lire dans un mp4 et
 *  rendrait null : la galerie n'aurait plus de format d'affichage. */
function videoSize(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf8' }).trim()
    const [w, h] = out.split('x').map(Number)
    return { width: Number.isFinite(w) ? w : null, height: Number.isFinite(h) ? h : null }
  } catch { return { width: null, height: null } }
}

/* ---------- clé Comfy Cloud du visiteur ----------
   Posée par la requête de dépôt (en-tête X-Comfy-Key, cf. index.js), gardée
   EN MÉMOIRE seulement, jusqu'à la fin du job : jamais en base, jamais dans
   le payload, jamais dans un journal. Un redémarrage du serveur la perd — le
   job repris repart alors sur le transport local, ou échoue sans lui. */
const depot = new AsyncLocalStorage()
const clesComfy = new Map()   // jobId → clé
/** Exécute un dépôt (enqueue…) en rattachant `cle` aux jobs qu'il crée. */
export const deposerAvecCle = (cle, fn) => depot.run(cle || null, fn)
function retenirCle(id) { const c = depot.getStore(); if (c) clesComfy.set(id, c) }

async function pump() {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = true
  enCours = { estimatedMs: job.estimatedMs, debut: Date.now() }
  /* La carte est prise pour ComfyUI le temps du job (cf. server/gpu.js). */
  /* Clé de visiteur → Comfy Cloud par le SDK ; transport SDK global → proxy
     local ; sinon ComfyUI local, la carte arbitrée avec Ollama (gpu.js). */
  // TRELLIS.2 et ACE-Step tournent ici, avec des fichiers d'ici : jamais sur le cloud du visiteur
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

/** Inventaire du driver : nombre d'images et cadence, par lecture réelle.
 *  Les drivers au-dessus de 30 fps sont d'abord RAMENÉS à 24 : le mouvement
 *  n'y gagne rien et le coût est linéaire en images — un iPhone à 60 fps
 *  doublerait le rendu (513 images pour 8,5 s). */
async function probeDriver(job) {
  let driverPath = path.join(CONFIG.comfyInput, job.motionDriver)
  if (!fs.existsSync(driverPath))
    throw new Error(`vidéo driver introuvable dans input/ : ${job.motionDriver}`)
  const fps0 = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', driverPath],
    { encoding: 'utf8' }).trim().split('/').reduce((a, b) => Number(a) / Number(b)))
  /* WAN-Animate-2 est entraîné à 16 fps : un driver à 30 fps lui donne ~2×
     le mouvement inter-image attendu, il sous-suit les gestes rapides et
     l'action « n'arrive pas au bout » dans chaque fenêtre. On ramène TOUT driver ≠ 16 fps à 16 fps avant
     transfert — recadre le mouvement sur la cadence d'entraînement. */
  /* PAR INTERPOLATION, pas en jetant des images.
     « -r 16 » garde l'image la plus proche : sur une source à 24 i/s les images
     retenues sont espacées de 1, 2, 1, 2 intervalles, le mouvement avance à pas
     inégaux et le modèle reproduit cette cadence boiteuse (mesuré : images par
     paires dans la sortie brute, rapport 3,6 ; 1,1 à 1,4 sur les sources à
     30 i/s, où le pas court ne revient qu'une fois sur 8). minterpolate fabrique
     des images réellement intermédiaires, régulièrement espacées. Coût : 12 à
     27 s sur le processeur, une fois par driver. */
  if (Number.isFinite(fps0) && Math.abs(fps0 - 16) > 0.5 && job.motionFpsNatif !== true) {
    const resampled = driverPath.replace(/(\.\w+)$/, '_16fps_mci.mp4')
    if (!fs.existsSync(resampled)) {
      // asynchrone : jusqu'à 27 s de calcul, le serveur doit continuer de répondre aux interfaces
      await new Promise((ok, ko) => execFile('ffmpeg', ['-y', '-v', 'error', '-i', driverPath,
        '-vf', 'minterpolate=fps=16:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1', '-an',
        '-c:v', 'libx264', '-crf', '17', resampled + '.tmp.mp4'], { timeout: 600_000 }, e => e ? ko(e) : ok()))
      fs.renameSync(resampled + '.tmp.mp4', resampled)   // jamais de fichier partiel réutilisé au rendu suivant
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

/** Référence du Motion Control : la still déposée par l'opérateur, telle
 *  quelle, et l'inventaire du driver. */
async function buildMotionRef(job) {
  const { driverPath, frames, fps } = await probeDriver(job)
  if (!job.motionRef && job.motionMode === 'replace') return { refName: await refDuPersonnage(job, driverPath, frames, fps), frames, fps, driverPath }
  if (!job.motionRef) throw new Error('still de référence manquante')
  return { refName: job.motionRef, frames, fps, driverPath }
}

/* Mix depuis la vidéo seule : la référence d'apparence est fabriquée ici.
   Pas d'échange de tête sur une image du driver (LoRA BFS, licence sans usage
   hébergé). Ici : l'image la plus nette de la première
   seconde, sa tenue lue par le VLM, et le personnage actif rendu en pied dans
   cette tenue par la recette photo (sa LoRA d'identité). WanAnimate garde ensuite
   le décor et le geste du driver. */
async function refDuPersonnage(job, driverPath, frames, fps) {
  const src = `mx_${job.id}_src.png`, ref = `mx_${job.id}_ref.png`
  let idx = 0
  try {
    const meta = execFileSync('ffmpeg', ['-v', 'error', '-i', driverPath, '-t', String(Math.min(1, frames / (fps || 16))),
      '-vf', 'sobel,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
    const notes = [...meta.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < notes.length; i++) if (notes[i] > notes[idx]) idx = i
  } catch { idx = 0 }
  // Mix à plusieurs : la tenue se lit sur la bande de la personne visée, pas sur celle de sa voisine
  const bande = job.mixTotal ? `,crop=iw/${job.mixTotal}:ih:iw*${job.mixRang ?? 0}/${job.mixTotal}:0` : ''
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', driverPath, '-vf', `select=eq(n\\,${idx})${bande}`, '-vframes', '1',
    path.join(CONFIG.comfyInput, src)], { stdio: ['ignore', 'ignore', 'pipe'] })
  store.setStatus(job.id, 'rendering')
  const tenue = await vision.describeOutfit(path.join(CONFIG.comfyInput, src))
  const p = persona(job.personaId)
  /* Verrou SFW de la référence : la tenue lue peut n'avoir qu'un bas (« blue jeans ») ou qu'un
     haut (« satin camisole ») ; la pièce manquante est demandée et la tenue entière reste opaque. */
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

/* Swap d'une personne : SCAIL-2 (Wan 2.1 14B, MIT), recette officielle de ComfyUI
   (remplacement de personnage, 6 pas, lightx2v, LoRA DPO). SAM3 suit la personne du clip
   et celle de la référence ; le clip est rendu par blocs de 81 images (deux au plus),
   le second recoloré sur la fin du premier. Au-delà, WanAnimate garde la main. */
export const SWAP_SCAIL_RECIPE = 'PROD_swap_scail2.json'
const SCAIL_MAX_IMAGES = 157
// le modèle SCAIL-2 est-il vu par ComfyUI (où qu'il soit rangé) ? lu une fois par minute
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
  // cadre : le côté long à 896, l'autre à l'échelle, multiples de 32
  const { width: w, height: h } = videoSize(motion.driverPath)
  const paysage = !(h > w)
  // 896 par défaut ; le propriétaire peut monter à 1280 (banc) : moins de défauts visibles sur un plan proche
  const long = Number.isInteger(job.swapLong) ? Math.min(1280, Math.max(640, job.swapLong)) : 896
  const court = Math.round((long * (paysage ? (h || 9) / (w || 16) : (w || 9) / (h || 16))) / 32) * 32
  for (const [lw, lh] of [['213:178', '213:179'], ['262:236', '262:237']]) {
    g[lw].inputs.value = paysage ? long : court
    g[lh].inputs.value = paysage ? court : long
  }
  g['271'].inputs.filename_prefix = `creatoros/${job.id}/out`
  /* Mode animation (banc du propriétaire) : le personnage de la still reste dans SON décor et reprend
     les gestes du driver, au lieu de remplacer la personne du driver dans le décor du driver. */
  if (job.swapAnimation === true && g['213:203'] && g['262:247']) {
    g['213:203'].inputs.value = false; g['262:247'].inputs.value = false
    applied.push('SCAIL-2 en mode animation (décor de la still)')
  }
  applied.push(`Swap : SCAIL-2 (remplacement de personnage, recette officielle ComfyUI), référence ${motion.refName}, `
    + `${paysage ? long : court}×${paysage ? court : long}, SAM3 « person »`)
  return g
}

/** Mix : la recette de remplacement, injectée par ids (cf. MIX_RECIPE). */
async function grapheMix(job, motion, applied, skipped) {
  const mg = comfy.loadWorkflow(MIX_RECIPE)
  mg['63'].inputs.video = job.motionDriver
  /* Pose prise sur une autre vidéo cadrée pareil (banc : le mannequin de la scène 3D, dont le mouvement est exact) ;
     le décor et le masque restent ceux du driver. */
  if (job.motionPoseDriver && fs.existsSync(path.join(CONFIG.comfyInput, job.motionPoseDriver))) {
    mg.poseSrc = JSON.parse(JSON.stringify(mg['63']))
    mg.poseSrc.inputs.video = job.motionPoseDriver
    mg['73'].inputs.image = ['poseSrc', 0]
    applied.push(`pose lue sur ${job.motionPoseDriver} (DWPose), décor et masque du driver`)
  }
  mg['57'].inputs.image = motion.refName
  mg['65'].inputs.positive_prompt = job.motionSceneText || (job.composedPositive || '').trim()
  /* Verrou SFW du Mix : sans consigne de tenue, un driver en maillot peut rendre un corps
     dévêtu. Chaque Mix dit que le personnage reste habillé et refuse la nudité. Ne pas retirer. */
  mg['65'].inputs.positive_prompt = `${mg['65'].inputs.positive_prompt}, an adult woman, fully clothed, same outfit coverage on every frame`.replace(/^, /, '')
  mg['65'].inputs.negative_prompt = `${mg['65'].inputs.negative_prompt ?? ''}, nude, naked, nudity, topless, bottomless, bare breasts, bare crotch, genitals`.replace(/^, /, '')
    || 'a young woman, photorealistic, natural skin, cinematic'
  mg['27'].inputs.seed = job.seed
  mg['998'].inputs.filename_prefix = `creatoros/${job.id}/out`
  /* Réglages : pas de relight, distill assoupli (0.8), 28 pas,
     UNE fenêtre qui couvre tout le driver (plusieurs fenêtres désynchronisent le fond). */
  const wan = persona(job.personaId).videoLoras.filter(l => /wan/i.test(l.name) && !/wan.?2\.?1|wan21|ltx/i.test(l.name))
  const haut = wan.find(l => /high/i.test(l.name)), bas = wan.find(l => /low/i.test(l.name))
  // la LoRA de relight de la recette dégrade le rendu (couleurs et visage) : elle reste coupée
  if (!job.mixRelight) mg['171'].inputs.lora_0 = 'none'
  else applied.push('relight WanAnimate : lumière du décor appliquée au personnage')
  mg['171'].inputs.strength_1 = 0.8
  if (haut && bas) {
    mg['171'].inputs.lora_2 = haut.name; mg['171'].inputs.strength_2 = 0.9
    mg['171'].inputs.lora_3 = bas.name; mg['171'].inputs.strength_3 = 0.9
    applied.push(`LoRA d'identité Wan du personnage : ${haut.name} · ${bas.name} (0.9)`)
  } else skipped.push('pas de LoRA d’identité Wan (haut + bas bruit) pour ce personnage : l’identité ne tient que par la still')
  mg['27'].inputs.steps = 28
  /* Visage du driver suivi (DWPose), mais à mi-force :
     à 1, la bouche du driver se plaque en tache sombre sur le visage de la still ;
     sans la branche visage, le visage sort flou et sans traits. */
  mg['73'].inputs.detect_face = 'enable'
  mg['62'].inputs.face_strength = 0.5
  /* Longueur : un driver de 30 s (481 images) en une seule
     fenêtre ne tient pas sur la carte, 104 s par pas puis panne de mémoire. Le
     driver est coupé à 153 images (9,6 s) ; jusqu'à 81 images une seule fenêtre,
     plus propre sur un clip court, au-delà deux fenêtres qui se recouvrent d'une
     image (2w − 1 ≥ n). Une fenêtre fixe de 77 sur 161 images en ferait trois,
     et le clip livré durerait 14 s au lieu de 10. */
  const MIX_MAX_IMAGES = 153
  const n = Math.min(motion.frames, MIX_MAX_IMAGES)
  mg['63'].inputs.frame_load_cap = n
  const pas4 = k => Math.ceil((k - 1) / 4) * 4 + 1
  mg['62'].inputs.frame_window_size = n <= 81 ? pas4(n) : pas4((n + 1) / 2)
  if (n < motion.frames) skipped.push(`driver coupé à ${MIX_MAX_IMAGES} images (9,6 s) sur ${motion.frames} : limite du Mix sur la démo`)
  // budget de pixels validé (~832×480), dans l'aspect du driver, multiple de 16
  const dv = videoSize(path.join(CONFIG.comfyInput, job.motionDriver))
  const BUDGET = 832 * 480, ar = dv.width && dv.height ? dv.width / dv.height : 480 / 832
  const mw = Math.max(16, Math.round(Math.sqrt(BUDGET * ar) / 16) * 16), mh = Math.max(16, Math.round(BUDGET / mw / 16) * 16)
  mg['150'].inputs.value = mw; mg['151'].inputs.value = mh
  // masque automatique : GroundingDINO trouve le sujet → points SAM2
  try {
    // lancé sans bloquer le serveur : la détection peut durer jusqu'à 3 minutes
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

/* Images de référence : chacune passe dans le latent et s'ajoute au conditionnement
   (ReferenceLatent en chaîne), à la manière d'un plateau de FLUX.2. */
/* Références sur Klein : un personnage sans LoRA Klein n'y garde pas son visage. Sa photo de
   profil passe alors en première référence, et le prompt la désigne. */
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

function appliquerReferences(g, noms, applied) {
  const k = Object.values(g).find(n => n.class_type === 'KSampler')
  const vae = Object.entries(g).find(([, n]) => n.class_type === 'VAELoader')?.[0]
  if (!k || !vae) throw new Error('références : la recette n’a ni KSampler ni VAE')
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

/** Mix à plusieurs : le clip rendu devient la source de la passe suivante, pour la personne d'à côté. */
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
    // ces clips sont contrôlés aussi, sans relance : ils ne se rejouent pas comme un clip ordinaire
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
    // La retouche est une ÉDITION d'image source : pas de préambule d'identité
    // (on modifie l'image donnée, on ne régénère pas le sujet), cadrage et
    // LoRA hérités de la source, l'instruction composée est le texte d'édition.
    const isEdit = job.op === 'edit'
    /* La vidéo est une recette de PROLONGATION : identité, morphologie, tenue
       et décor sont déjà dans l'image de départ. Lui préfixer le préambule
       d'identité noie le brief de mouvement sous une description que le
       moteur n'a aucune raison de suivre, et le mot déclencheur d'une LoRA
       photo ne veut rien dire pour l'encodeur de LTX ou de MiniMax. */
    const isVideo = job.mode === 'video'
    // le personnage du DÉPÔT, pas l'actif : on a pu en changer depuis
    const p = persona(job.personaId)
    /* Exception : une LoRA d'identité VIDÉO de la persona a appris le mot
       déclencheur — sans lui elle reste inerte. Le mot seul, sans préambule. */
    /* Plan d'ambiance (T2V) : AUCUN personnage — ni mot déclencheur, ni LoRA
       d'identité. C'est un plan de coupe, pas un plan d'elle. */
    /* Texte → vidéo AVEC le personnage (`t2vPersonnage`) : seulement s'il a une
       LoRA vidéo — c'est elle qui porte l'identité, il n'y a pas d'image. */
    /* LoRA vidéo du personnage FILTRÉES par famille de moteur : une LoRA
       LTX (« mila_ltx23… ») n'a rien à faire sur un graphe Wan, ni une Wan 2.2
       sur le Wan 2.1 des effets. Le nom dit la famille ; sans indice, la LoRA
       passe partout. */
    const familleLora = n => /ltx/i.test(n) ? 'ltx' : /wan.?2\.?1|wan21/i.test(n) ? 'wan21' : /wan/i.test(n) ? 'wan' : null
    const familleMoteur = /^ltx/.test(job.videoEngine ?? '') ? 'ltx' : /^wan21/.test(job.videoEngine ?? '') ? 'wan21' : /^wan/.test(job.videoEngine ?? '') ? 'wan' : null
    const persoVideo = p.videoLoras.filter(l => { const f = familleLora(String(l.name)); return !f || !familleMoteur || f === familleMoteur })
    const texteSeul = isVideo && job.t2v === true
    const ambiance = texteSeul && !(job.t2vPersonnage === true && persoVideo.length)
    const preamble = isEdit || ambiance ? null
      /* + le préambule du personnage : certaines LoRA vidéo ont appris une
         phrase entière (« Aisha-AW, she has dark hair »), que le champ mot
         déclencheur, réduit à un jeton, ne peut pas porter. */
      : isVideo ? (persoVideo.length && p.trigger ? { key: 'persona-video', file: null, text: `${p.trigger}, ${p.preamble ? `${p.preamble}, ` : ''}an adult woman in her mid-twenties, ` } : null)
      : identityPreambleFor(job.personaId, job.mode === 'photo' ? (job.photoEngine ?? CONFIG.photoEngine) : undefined)

    // Mots déclencheurs des LoRA empilées par le JOB. C'est LE point qui décide
    // si une LoRA agit : sans son mot dans le prompt, elle est chargée, occupe
    // de la VRAM et ne fait rien — l'image sort plausible et on croit la LoRA
    // faible. Le serveur résout le mot depuis le fichier ; un mot fourni par le
    // job le surcharge (l'opérateur a pu le corriger). Les LoRA de la persona
    // n'en ont pas besoin : leur mot est déjà en tête du préambule.
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
    /* Un trigger peut être une PHRASE d'activation complète (table) : on la
       laisse finir en point ; les mots courts restent joints par virgule. */
    const triggerTxt = triggers.map(t => (/[.!?]$/.test(t) ? t + ' ' : t + ', ')).join('')
    /* Tirage des items « 🎲 au hasard » avec la seed du job : reproductible,
       et la ligne tirée finit en provenance. Puis T0 rejoué sur le texte
       RÉSOLU — le front n'a vu que le token. Un terme bloqué fait échouer
       le job en le disant, plutôt que de rendre une image qu'on ne peut
       pas livrer. */
    const drawn = wildcards.resolve(triggerTxt + job.composedPositive, job.seed)
    // Vidéo avec son : la réplique est la SEULE parole (voir speechGuard).
    const speech = (isVideo && job.withAudio && job.videoEngine !== 'motion') ? speechGuard(drawn.text) : null
    // photo SFW : la recette tourne sans prompt négatif efficace (cfg 1), la tenue opaque est donc demandée en clair
    // (sans les mots du filtre T0, que le prompt final traverse ensuite)
    /* Mode adulte (installation locale) : seulement quand AUCUN visage ne peut venir d'une vraie personne — pas
       de personnage, aucune LoRA (une LoRA importée peut porter un visage réel), aucune photo importée (une
       source d'origine inconnue compte comme importée). Le plancher « mineurs » reste toujours. */
    const entrees = [job.sourceImage, job.endImage, ...(job.references ?? [])].filter(x => typeof x === 'string' && x.trim())
    const adulteLibre = CONFIG.contenuAdulte && (!job.personaId || job.personaId === SANS_PERSONNAGE)
      && !(job.loras ?? []).length && !(job.videoLoras ?? []).length
      && entrees.every(n => store.origineInput(path.basename(n)) === 'genere')
    const vetuOpaque = !adulteLibre && !isVideo && !isEdit && job.register !== 'explicit' && job.mode === 'photo'
    const texteBrut = speech?.text ?? drawn.text
    // un maillot sur une adulte reste permis : la consigne ne demande alors que des tissus opaques
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
    /* Format « origine » : sonder le fichier RÉEL de la still — les dims du
       front peuvent être périmées (still annoncée 768×1344 après un clone, en
       réalité 832×1216 : écrasement de 16 %). Le payload ne sert que de repli
       si la sonde échoue. */
    let videoSrcDims
    if (job.mode === 'video' && job.videoAspect === 'origine') {
      // Frame de fin seule : c'est elle qui donne le format.
      const cadre = job.sourceImage || job.endImage
      if (cadre) {
        const d = videoSize(path.join(CONFIG.comfyInput, cadre))
        if (d.width && d.height) videoSrcDims = { w: d.width, h: d.height }
      }
      if (!videoSrcDims && job.videoSrcW && job.videoSrcH)
        videoSrcDims = { w: job.videoSrcW, h: job.videoSrcH }
    }
    /* LoRA de la persona d'abord (identité), puis celles du job (style). */
    const photoLoras = [...lorasPhoto(p, job.photoEngine ?? PHOTO_ENGINE), ...(job.loras ?? [])]
    const videoLorasEff = [...(ambiance ? [] : persoVideo), ...(job.videoLoras ?? [])]
    /* Le graphe motion n'est pas injectable génériquement (le conditionnement
       passe par WanAnimate2ToVideo, pas par un KSampler) : son chemin dédié
       écrit les nœuds nommés plus bas, l'injection générique ne tourne pas. */
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
      // Une recette d'édition tient son cadrage de l'image source : lui
      // imposer des dimensions la recadrerait.
      width: (isEdit || isVideo) ? undefined : job.width,
      height: (isEdit || isVideo) ? undefined : job.height,
      // Photo : persona + LoRA du job. Vidéo (hors motion) : persona vidéo +
      // LoRA du job, empilées sur la chaîne modèle de la recette. Édition : aucune.
      loras: isEdit ? (STYLES_EDITION[job.editStyle] ? [{ name: STYLES_EDITION[job.editStyle], strength: 1 }] : undefined) : isVideo ? videoLorasEff : photoLoras,
      sourceImage: texteSeul ? (VIDEO_ENGINES[job.videoEngine]?.t2vNatif ? undefined : comfy.imageVideT2v()) : job.sourceImage ?? undefined,
      t2v: texteSeul && !VIDEO_ENGINES[job.videoEngine]?.t2vNatif,
      controlNet: job.controlNet ?? undefined,
      // `false` explicite = « coupe l'étage audio » ; `undefined` = recette
      // telle quelle. Une recette photo ne doit pas recevoir la consigne.
      withAudio: job.mode === 'video' ? job.withAudio === true : undefined,
      // Durée à GÉNÉRER, pas durée livrée : sur un moteur au ralenti il faut
      // produire plus long pour livrer la bonne longueur après correction.
      videoSeconds: job.mode === 'video'
        ? job.videoSeconds * (job.videoSpeed ?? 1) : undefined,
      videoAspect: job.mode === 'video' ? (job.videoAspect ?? undefined) : undefined,
      videoSrcDims,
      // Brouillon : la surface du ResolutionSelector, et le nombre de pas.
      videoMegapixels: job.videoDraft
        ? VIDEO_ENGINES[job.videoEngine]?.draft?.megapixels : undefined,
      /* Pas d'échantillonnage : brouillon d'abord, sinon la valeur de
         production du moteur. `undefined` si le moteur n'en déclare pas —
         la recette garde alors la sienne. */
      videoSteps: job.videoDraft
        ? VIDEO_ENGINES[job.videoEngine]?.draft?.steps
        : VIDEO_ENGINES[job.videoEngine]?.steps,
      endImage: job.mode === 'video' ? (job.endImage ?? undefined) : undefined,
    })
    // Entrées déclarées dans <recette>.pilotage.json : appliquées après le câblage (sans fichier, rien ne change).
    if (job.videoEngine !== 'motion')
      comfy.appliquerPilotage(job.workflowFile, workflow, { prompt: positive, negative: job.composedNegative, seed: job.seed,
        width: (isEdit || isVideo) ? undefined : job.width, height: (isEdit || isVideo) ? undefined : job.height,
        sourceImage: job.sourceImage ?? undefined }, applied, skipped)
    /* Photos Krea générées : rendu direct en 2 MP (voir comfy.rendre2MP).
       Pas sur les retouches (elles ont leur propre graphe) ;
       CREATOROS_PHOTO_2MP=0 revient au 1 MP. */
    if (job.mode === 'photo' && !isEdit && /^PROD_gen_krea/.test(job.workflowFile ?? '')
        && process.env.CREATOROS_PHOTO_2MP !== '0') {
      const r = comfy.rendre2MP(workflow)
      if (r.manque) skipped.push(`2 MP non ajouté : ${r.manque}`)
      else applied.push(...r.notes)
    }
    // Klein sans LoRA du personnage : sa photo de profil tient le visage, références ou non
    const kleinSansLora = job.mode === 'photo' && job.photoEngine === 'klein' && !isEdit
    if (job.references?.length || kleinSansLora) {
      const refs = [...visageDuPersonnage(job, workflow, applied), ...(job.references ?? [])].slice(0, 6)
      if (refs.length) appliquerReferences(workflow, refs, applied)
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
    // Une LoRA sans déclencheur est le cas qui échoue en silence : on le crie.
    for (const l of job.loras ?? []) {
      if (!l.trigger)
        skipped.push(`LoRA « ${l.name} » empilée SANS mot déclencheur — elle sera chargée `
          + 'mais restera probablement inerte ; saisir le mot dans l’interface')
    }
    skipped.forEach(s => console.warn(`[job ${job.id}] non injecté — ${s}`))

    /* Motion Control : le graphe générique injecté ci-dessus ne convient
       pas — ce n'est même pas lui qu'on exécute. On repart de la recette et
       on écrit les nœuds NOMMÉS (cf. MOTION_NODES). */
    let finalWorkflow = workflow
    if (job.videoEngine === 'motion' && job.motionMode === 'replace') {
      const ref = await buildMotionRef(job)
      // une personne et un clip court : SCAIL-2 ; à plusieurs ou plus long : WanAnimate
      const scail = !job.mixTotal && !job.mixWanAnimate && ref.frames <= SCAIL_MAX_IMAGES && await scailDisponible()
      finalWorkflow = scail ? grapheSwapScail(job, ref, applied) : await grapheMix(job, ref, applied, skipped)
      /* Carte vidée avant Wan-Animate : derrière le rendu Krea
         de la référence, ou un rendu interrompu, les modèles restés chargés ne
         laissent que des miettes au WanVideoWrapper — 104 s par pas puis panne
         de mémoire au 10e pas. */
      await comfy.freeMemory().catch(() => { /* non fatal */ })
    } else if (job.videoEngine === 'motion') {
      const motion = await buildMotionRef(job)
      const g = structuredClone(base)
      g[MOTION_NODES.ref].inputs.image = motion.refName
      g[MOTION_NODES.driver].inputs.file = job.motionDriver
      // 4k+1 ≤ images du driver : le pas temporel du latent est de 4 images.
      g[MOTION_NODES.animate].inputs.length = Math.max(9, Math.floor((motion.frames - 1) / 4) * 4 + 1)
      // Le prompt décrit CE QUE LA RÉF MONTRE — jamais un personnage
      // générique, c'est ce qui fait muter l'identité. Le texte opérateur
      // ne porte que le MOUVEMENT ; sans lui, une consigne neutre.
      const motionTxt = (job.composedPositive || '').trim()
        || 'The person moves naturally'
      /* Le prompt PRINCIPAL décrit personnage + décor + interaction — c'est
         le seul canal qui parle du CONTEXTE (un objet tenu, un décor qui
         change) : la branche geste ne suit que le sujet principal du driver.
         L'opérateur peut le fournir en entier (motionSceneText), VERBATIM :
         c'est là qu'il décrit l'action réelle du driver (« she takes off her
         jacket », « she walks away »). Sans texte scène, une amorce neutre. */
      g[MOTION_NODES.prompt].inputs.text = job.motionSceneText
        ? job.motionSceneText.trim()
        : 'The person from the reference image. ' + motionTxt
      g[MOTION_NODES.motion].inputs.text = motionTxt
      /* Continuité entre fenêtres de contexte : l'overlap natif (8) laissait
         des « cut » visibles tous les ~1,7 s sur les mouvements amples. On le
         relève à 12 (fenêtre = 21 latents) — moins de coutures, sans toucher
         à la ressemblance (contrairement à reference_image_strength). */
      if (g[MOTION_NODES.context]?.inputs) g[MOTION_NODES.context].inputs.context_overlap = 12
      /* Sans accélérateur : la LoRA de distillation (6 pas, cfg 1) lisse les textures.
         Sans elle, échantillonnage standard de Wan : 20 pas, cfg 5, uni_pc (≈ 6× plus long). */
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
        /* Par défaut : le modèle Wan Animate 2 DISTILLÉ (celui du gabarit officiel de ComfyUI). Il se suffit,
           sans LoRA d'accélération : 10 pas, cfg 1, lcm. Plus propre que le modèle de base + LoRA lightx2v
           (peau et tissus moins lissés, aucun effet « images de synthèse »), pour le même temps.
           motionDistill: false, ou un réglage d'accélérateur, revient au modèle de base (bancs du propriétaire). */
        g['261:239'].inputs.unet_name = 'wan_animate_2_distill_int8_convrot.safetensors'
        for (const n of Object.values(g)) for (const [k, v] of Object.entries(n.inputs ?? {}))
          if (Array.isArray(v) && v[0] === '261:11') n.inputs[k] = ['261:239', 0]
        delete g['261:11']
        g['261:18'].inputs.steps = 10; g['261:19'].inputs.cfg = 1; g['261:27'].inputs.sampler_name = 'lcm'
        applied.push('motion : Wan Animate 2 distillé, sans LoRA, 10 pas, cfg 1, lcm')
      } else if (g['261:11'] && g['261:18'] && g['261:19']) {
        /* Accélérateur adouci par défaut : à pleine force (6 pas) il lisse tissus et peau ; à 0,7 sur 10 pas
           les plis reviennent sans perdre le mouvement (≈ 1,5× plus long). Réglable par le propriétaire. */
        g['261:11'].inputs.strength_model = Number.isFinite(job.motionTurbo) ? job.motionTurbo : 0.7
        g['261:18'].inputs.steps = Number.isInteger(job.motionPas) ? job.motionPas : 10
        if (Number.isFinite(job.motionCfg)) g['261:19'].inputs.cfg = job.motionCfg
        applied.push(`motion : accélérateur ${g['261:11'].inputs.strength_model}, ${g['261:18'].inputs.steps} pas, cfg ${g['261:19'].inputs.cfg}`)
      }
      /* Branche « mouvement » : par défaut elle reçoit aussi l'image CLIP de la 1re image du driver.
         Un driver de synthèse (mannequin 3D) y transmet son rendu « images de synthèse » au personnage.
         motionVisionRef : la branche mouvement voit la still à la place ; motionPoseFin : l'influence
         du driver s'arrête avant la fin de l'échantillonnage (la chorégraphie est posée tôt, le détail
         vient alors de la still). Réglages de banc du propriétaire. */
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

    /* PAS de décharge VRAM ici : POST /free décharge TOUT (free_memory
       implique unload_all_models), et le rechargement à froid qui suit fait
       un OOM de fragmentation au premier échantillonneur sur les recettes
       lourdes. La gestion progressive de ComfyUI fait mieux quand les
       modèles restent résidents ; la protection contre l'alternance est le
       tri de file par recette. */
    const promptId = await comfy.submitPrompt(finalWorkflow, CLIENT_ID)
    current = { jobId: job.id, promptId }
    store.markStarted(job.id, promptId)
    console.log(`[job ${job.id}] ComfyUI prompt_id=${promptId}`)

    const history = await comfy.waitForPrompt(promptId, {
      /* « queued » côté ComfyUI ≠ « queued » côté CreatorOS : le prompt est
         DÉJÀ soumis. Le distinguer évite qu'au redémarrage recoverQueue le
         re-soumette (queuedPayloads ne ramasse que 'queued') au lieu de le
         ré-attacher (orphanedRunningRows connaît 'queued-comfy'). */
      onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p),
    })
    const n = await harvestJob(job, promptId, history,
      { applied, skipped, preamble, clause: '', finalWorkflow })
    const ms = Date.now() - t0
    store.markFinished(job.id, ms)
    console.log(`[job ${job.id}] terminé en ${(ms / 1000).toFixed(1)} s — ${n} image(s)`)
    // contrôle du clip, hors du chemin critique : la file repart sans l'attendre
    void controlerJob(job, p => enqueue(p)).catch(e => console.warn(`[contrôle] ${String(e.message || e).slice(0, 200)}`))
    if (/^danse3d-[a-z0-9]+-swap$/.test(job.id)) {
      try { finaliserDanse3d(job) } catch (e) { console.warn(`[job ${job.id}] finition de la danse 3D — ${e.message || e}`) }
    }
  } catch (e) {
    /* ComfyUI injoignable (redémarrage, crash relancé par le superviseur) :
       ce n'est pas le job qui est en cause. On attend qu'il réponde et on
       rejoue UNE fois — sans quoi toute la file se vide en « blocked » le
       temps d'un redémarrage de ComfyUI. */
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
    /* OOM vidéo : UN retry après une pause. Le premier passage peut tomber
       selon ce que ComfyUI a encore en VRAM, le second passe en général
       (l'OOM lui-même libère). Un double échec est un vrai dépassement. */
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

/** Écrit les sorties d'un prompt TERMINÉ : fichiers, post-traitements,
 *  assets + provenance. Extraite de runJob pour que la reprise au démarrage
 *  puisse récolter un rendu orphelin par le MÊME chemin que le nominal. */
async function harvestJob(job, promptId, history, extras = {}) {
  const { applied = [], skipped = [], preamble = null, clause = '', finalWorkflow = null } = extras
  store.setStatus(job.id, 'post-process')

  const images = comfy.outputsOf(history)
    if (!images.length) throw new Error('exécution terminée mais aucune image en sortie')
    const resolvedText = comfy.textsOf(history)

    let deliveredFirst = null   // premier fichier livré (la continuation)
    for (const [i, img] of images.entries()) {
      const buf = await comfy.readImage(img)
      const ext = path.extname(img.filename) || '.png'
      const filename = `${job.id}-${i}-${crypto.randomBytes(4).toString('hex')}${ext}`
      const full = path.join(CONFIG.mediaDir, filename)
      fs.writeFileSync(full, buf)
      let { width, height } = comfy.pngSize(buf)
      if (job.mode === 'video') {
        /* Le retiming ne sert qu'à corriger un moteur au ralenti (speed ≠ 1).
           À speed 1, la durée générée EST la durée livrée, à l'arrondi du
           moteur près : MiniMax quantifie 6 s en 158 images (6,58 s), et
           recompresser à 6,00 accélérerait encore la voix de 10 %. Seule la cadence reste conformée. */
        const r = conformVideo(full,
          (job.videoSpeed ?? 1) !== 1 ? job.videoSeconds : null, job.videoFps)
        if (r) console.log(`[job ${job.id}] ${r}`)
        if (job.op === 'inpaint_video' || job.videoEngine === 'wan_t2v' || /^wan21/.test(job.videoEngine ?? '')) {
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) applied.push(fl)
        }
        if (job.videoEngine === 'motion') {
          // prévisu ET final : coût mesuré sous la minute
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) { console.log(`[job ${job.id}] ${fl}`); applied.push(fl) }
        }
        // Passe MATE (dé-brillance + grain) sur les rendus qui sortent glossy :
        // motion (WanAnimate) ET i2v minimax (distill H3). Pas wan/ltx.
        // Extensions : PAS de matte. Le matte aplatit la
        // continuation, et le seam color-match ci-dessous aligne déjà son grade
        // sur la source — double traitement inutile qui ternit le plan.
        const isExtension = typeof job.concatWith === 'string' && job.concatWith.trim()
        const applyMatte = !isExtension
          && ((typeof job.motionDriver === 'string' && job.motionDriver.trim())
            || job.videoEngine === 'minimax')
        if (applyMatte) {
          const dg = matteVideo(full)
          if (dg) console.log(`[job ${job.id}] ${dg}`)
        }
        // Danse en « face tracking » : la caméra reste verrouillée sur le visage (recadrage suivi)
        if (job.danseSuivi === true) {
          const sv = suiviVisage(full)
          if (sv.ok) applied.push(`cadrage suivi du visage (zoom ${sv.zoom})`)
          else skipped.push(`cadrage suivi du visage NON appliqué — ${sv.raison}`)
        }
        // Extension : recoloration du clip de continuation sur la queue de la
        // source, pour que l'asset `-0` livré ne soit pas plus sombre que la
        // source (l'i2v ré-expose plus bas). Après le matte pour comparer des
        // grades finaux comparables. Le concat aval mesurera ~0 → se sautera.
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
        // Vignette pour les grilles (iOS n'en tire aucune du <video>).
        // Non bloquant, non fatal : la route la régénère à la demande.
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
          // Fonction de l'asset : c'est ce qui permet aux galeries de montrer
          // LEUR catégorie (t2i / retouche / i2v / motion).
          op: job.op ?? 'generate', videoEngine: job.videoEngine ?? null,
        },
        {
          recipeId: job.recipeId, workflowFile: job.workflowFile,
          comfyPromptId: promptId, seed: job.seed,
          composedPositive: job.composedPositive, composedNegative: job.composedNegative,
          // Prompt BRUT + directives : sans eux « Cloner » ne peut pas
          // repeupler la colonne 3 du front.
          userPrompt: job.userPrompt, userDirectives: job.userDirectives,
          selections: job.selections, resolvedText,
          // Le préambule est une entrée de production au même titre que le
          // prompt : sans lui en provenance, un asset n'est pas rejouable.
          identityPreamble: preamble,
          registerClause: clause || null,
          // Pour une édition, l'image d'entrée EST une donnée de production :
          // sans elle en provenance, l'asset n'est pas rejouable.
          sourceImage: job.sourceImage ?? null,
          extraLoras: job.loras?.length ? job.loras : null,
          injections: { applied, skipped },
          workflowJson: finalWorkflow,
        },
      )
    }


  if (job.mixSuite?.length && deliveredFirst) lancerMixSuivant(job, deliveredFirst)

  /* Extension vidéo, plan complet : source + continuation concaténées en un
     fichier, livré comme SECOND asset du job (id `a-<job>-full`). Un échec de
     concat n'annule pas la continuation — il est journalisé en provenance
     du job suivant et en console. */
  if (job.concatWith && job.mode === 'video' && deliveredFirst) {
    const srcDir = job.concatFrom === 'input' ? CONFIG.comfyInput : CONFIG.mediaDir
    const srcPath = path.join(srcDir, path.basename(job.concatWith))
    if (!fs.existsSync(srcPath)) {
      console.warn(`[job ${job.id}] plan complet NON produit : source « ${job.concatWith} » absente`)
    } else {
      try {
        const cname = `${job.id}-full-${crypto.randomBytes(4).toString('hex')}.mp4`
        const cfull = path.join(CONFIG.mediaDir, cname)
        /* Prequel : rendu PUIS source, et pas de seam sur la source (le rendu
           a déjà été recoloré sur sa tête, ci-dessus). */
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
      } catch (e) {
        console.warn(`[job ${job.id}] concat : ${String(e.message || e).slice(0, 200)}`)
      }
    }
  }

  return images.length
}

export const queueDepth = () => queue.length + (running ? 1 : 0)

/* Place d'un job en attente, pour l'afficher au visiteur : son rang
   (1 = le prochain), et l'attente avant son départ estimée par les durées
   prévues du job en cours (ce qu'il lui reste) et de ceux qui le précèdent. */
let enCours = null   // { estimatedMs, debut }
const DUREE_PAR_DEFAUT = 60_000
export function placeDansFile(id) {
  const i = queue.findIndex(j => j.id === id)
  if (i < 0) return null
  let attenteMs = enCours ? Math.max(15_000, (enCours.estimatedMs ?? DUREE_PAR_DEFAUT) - (Date.now() - enCours.debut)) : 0
  for (const j of queue.slice(0, i)) attenteMs += j.estimatedMs ?? DUREE_PAR_DEFAUT
  return { rang: i + 1, attenteMs: Math.round(attenteMs) }
}
