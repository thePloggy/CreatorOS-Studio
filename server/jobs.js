/* ============================================================
   File d'exécution — un seul GPU, donc un seul job à la fois.
   Les jobs sont sérialisés dans l'ordre d'arrivée ; l'état vit
   en SQLite (pas en mémoire) : un redémarrage ne perd rien de
   ce qui est déjà produit.
   ============================================================ */
import { PROFILS, profilDuJob } from './allege.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as comfy from './comfy.js'
import { pourRendu } from './gpu.js'
import * as sdk from './transport-sdk.js'
import * as store from './db.js'
import { identityPreambleFor, lorasPhoto, persona, personaDuDepot, triggerPrefix } from './persona.js'
import { ensurePoster } from './poster.js'
import { controlerJob } from './controle.js'
import * as wildcards from './wildcards.js'
import * as vision from './vision.js'
import { t0Hit } from './t0.js'
import * as plans from './plans.js'

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
}
export const PHOTO_ENGINE = CONFIG.photoEngine
export const RECIPES = RECIPES_PAR_MOTEUR[PHOTO_ENGINE] ?? RECIPES_PAR_MOTEUR.krea

/* ---------- vidéo image-to-video ----------
   Trois moteurs, choisis À LA MAIN dans la console. Aucun n'est « le
   meilleur » : ils perdent chacun sur un axe différent, et c'est l'opérateur
   qui sait lequel compte pour le plan qu'il fabrique.

   `speed` : facteur de durée à GÉNÉRER pour livrer la durée demandée.
   Le bench du 22-23/08 avait mesuré des gestes à ~60 % de la vitesse
   naturelle et l'on corrigeait après coup (générer x1,75 puis ramener au
   montage). Abandonné le 25/08 sur les moteurs AVEC VOIX : MiniMax et LTX
   parlent en temps réel même quand le corps traîne, et `atempo` x1,8
   faisait débiter le personnage deux fois trop vite. Aucun facteur global ne peut
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
       — sondé le 24/08 : 241 images rendues en 30 min, sujet stable. En
       direct, 8 s est la limite VRAM ferme. */
    directSeconds: 8,
    // 12 s en contexte sondés le 25/08 : 289 images, 30 min, pic 28,9 Go.
    fileCtx: 'PROD_video_wan_ctx.json',
    file: 'PROD_video_wan.json',
    label: 'Wan 2.2 (I2V A14B)',
    force: 'image la plus propre — c’est lui qu’on prend quand le plan doit tenir en grand',
    audio: false,
    speed: 1,
    minutes: 9,
    /* Brouillon : dimensions littérales ramenées à 0,4 MP (480×848 en 9:16,
       la surface de la prévisu motion). Même promesse que sur MiniMax :
       juger le prompt, pas le plan. Mesuré le 25/08 : 5 s en 126 s.
       Depuis le 12/10 le brouillon tourne en 2 + 2 pas au lieu de 4 + 4
       (moitié moins de temps). Le rendu final
       reste en 4 + 4 : en 2 + 2 l'opérateur a vu des yeux vitreux sur une image. */
    draft: { megapixels: 0.4, steps: 4, minutes: 2 },
  },
  ltx_hq: {
    // Sondé le 25/08 à 1,4 MP : 12 s en 6 min (27 Go), 16 s en 9 min
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
    // Mesuré le 25/08 : 6 s en 98 s (704×1024).
    draft: { megapixels: 0.7, minutes: 2 },
  },
}

/* Wan 2.2 T2V-A14B (20/10, accord de l'opérateur) : texte → vidéo AVEC un
   personnage dont l'identité tient dans une paire de LoRA Wan haut / bas bruit
   (Aisha). Pas d'image du tout : WanImageToVideo sans start_image rend un latent
   vide, et toute l'injection Wan (durée, format, brouillon) reste valable.
   Recette du banc du 17/10 : lightx2v T2V, 4 + 4 pas euler, shift 5. Le modèle
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

/* Wan 2.1 I2V 14B 480p (21/10) : la base des LoRA d'effets et de caméra de
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
/* Variante « Remade » (21/10) pour les EFFETS : sans lightx2v, 28 pas uni_pc,
   cfg 6, shift 5 — le réglage de Remade-AI. Banc du 21/10 (écrasé, gonfle) : le
   4 pas distillé n'applique pas l'effet au sujet (elle passe derrière, le ballon
   gonfle devant elle) ; à 28 pas l'effet porte sur elle. ~8 min le clip de 5 s. */
VIDEO_ENGINES.wan21_hq = {
  ...VIDEO_ENGINES.wan21,
  file: 'PROD_video_wan21_effets_hq.json',
  label: 'Wan 2.1 I2V 480p (effets, 28 pas)',
  minutes: 8,
}

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
  motionSecPerFrame: { final: 6.0, preview: 3.0 },
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
/* Mix (21/10, repris de la prod) : WanAnimate 2.2 en remplacement (WanVideoWrapper),
   SAM2 suit le sujet du driver et le personnage de la still prend sa place dans le
   décor d'origine. L'identité tient par la LoRA vidéo Wan du personnage (haut et
   bas bruit) ; sans elle, par la still seule. */
export const MIX_RECIPE = 'PROD_wananimate_mix.json'
const COMFY_PY = path.join(CONFIG.comfyDir, 'venv', 'bin', 'python')
const GDINO_POINTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'gdino_points.py')

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

/* Clips longs : enchaînement par morceaux (accord opérateur du 11/10).
   Au-delà de 81 images, les fenêtres de contexte faisaient sauter le décor à
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
   yaourt », constaté le 25/08 sur trois brouillons MiniMax). Rien dans le
   prompt ne lui disait que le personnage se tait le reste du temps. On l'ajoute ici,
   après tirage et hors LLM, pour tout job vidéo sonore dont le texte porte
   une réplique entre guillemets : la ligne est répétée telle quelle et le
   silence autour est explicite. Sans réplique, on ne touche à rien (un brief
   d'ambiance sans parole reste libre). */
const SPEECH_QUOTE_RE = /«\s*([^»]+?)\s*»|"([^"\n]+?)"|“([^”]+?)”/g
export function speechGuard(text) {
  const lines = []
  for (const m of String(text).matchAll(SPEECH_QUOTE_RE)) lines.push((m[1] ?? m[2] ?? m[3]).trim())
  if (!lines.length) return null
  /* La réplique n'est PAS répétée ici : testé le 25/08, la citer une seconde
     fois dans la garde la faisait dire deux fois (« coucou toi ? coucou toi,
     do you want… »). On ne décrit que le silence autour. */
  const guard = lines.length === 1
    ? 'The character speaks exactly once: the quoted line, and nothing else. Before and after it the character is silent — no other words, no mumbling, no humming, no off-screen voice.'
    : `The character speaks only the ${lines.length} quoted lines, in that order, and nothing else. Otherwise the character is silent — no other words, no mumbling, no humming, no off-screen voice.`
  const base = String(text).trim().replace(/[.\s]+$/, '')
  return { text: `${base}. ${guard}`, note: `parole verrouillée sur ${lines.length === 1 ? 'la réplique' : `${lines.length} répliques`} : ${lines.map(l => `"${l}"`).join(' · ')}` }
}

/** Durée livrée, en secondes. Bornée par MOTEUR : la limite haute n'est pas
 *  une préférence mais la VRAM — 10 s sur Wan en direct, c'est 241 images en
 *  720×1280 et un OOM garanti au premier échantillonneur (8 jobs perdus le
 *  23/08, diagnostiqué le 24 après avoir accusé à tort le dispatch, la
 *  décharge VRAM et le cache : la demande ne TENAIT pas). Plafonds relevés
 *  le 25/08 après sonde moteur par moteur (voir chaque entrée de la table).
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

/** Les recettes réellement SERVIES par cette instance (moteur photo courant,
 *  moteurs vidéo, chaînes annexes) — ce que le diagnostic doit contrôler. */
export function recettesServies() {
  const video = Object.values(VIDEO_ENGINES).flatMap(e => [e.file, e.fileCtx]).filter(Boolean)
  return [...new Set([...Object.values(RECIPES), ...video, ...Object.values(MOTION_RECIPES),
    REFINE_RECIPE, REFINE_MASKED_RECIPE, PHOTO_HD_WORKFLOW, EDIT_WORKFLOW, MIX_RECIPE])]
}

/* Dimensions par défaut, surchargées par job. Le cadrage rapproché
   utilise un format moins allongé : un 832×1216 sur un visage force un
   cadrage large ou coupe le menton. */
export const DEFAULT_SIZE = { width: 768, height: 1344 } // 9:16 — défaut opérateur 15/09
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
  const picked = ids.map(id => byId.get(id)).filter(Boolean)
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
 *  sont ré-attachés à leur prompt s'il vit encore, re-soumis sinon.
 *
 *  Trois arrêts de service en une soirée ont chacun fauché la file en
 *  mémoire (bench du 23/08) : cette fonction est la correction de fond. */
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
     on attend la fin et on récolte par le chemin nominal. C'était LA cause
     des « ils repassent tous en blocked » : chaque déploiement fauchait
     les rendus en cours alors que les fichiers arrivaient quand même.

     Mais si ComfyUI LUI-MÊME a redémarré (coupure de courant du 24/08), sa
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
export function enqueue(job) {
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
       sont deux keyframes optionnelles du même nœud) — vérifié le 30/09. */
    // Wan aussi depuis le 20/10 (Prequel) : WanFirstLastFrameToVideo, cf. comfy.js
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
    photoEngine: mode === 'photo' && op !== 'edit' && RECIPES_PAR_MOTEUR[job.photoEngine] ? job.photoEngine : undefined,
    // preset de caméra ou d'effet d'origine : le contrôle des clips y lit le mouvement attendu
    presetId: typeof job.presetId === 'string' ? job.presetId.slice(0, 40) : undefined,
    // banc basse VRAM : profil forcé pour CE job (le serveur ne le laisse passer qu'au propriétaire)
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
    /* Lot (v2) : identifiant partagé par les jobs d'un même envoi — c'est lui
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
     pas en VRAM, et chaque bascule force un rechargement complet — c'est
     dans ces rechargements alternés que les OOM du 23/08 sont nés (9 jobs
     wan/minimax entrelacés, tous tombés au premier échantillonneur). Le tri
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
  /* Mix : départ choisi dans la vidéo source (30/10). Le Mix ne garde que 9,6 s : la source est
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
  /* Les plans montés passent en « refusé » (opérateur, 13/10) : ils restent en
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
    // mesuré le 22/09 : 35 à 45 s sur une source 760x1368 portée à 2 MP.
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

/* Upscale LATENT NATIF H3 (bench 17/09 : latent H3 > refine Wan) : rejoue la
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
  // denoise 0.45 : 0.5 altérait légèrement l'expression, 0.35 dédoublait (bench 17/09)
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

/* ---------- retouche au pinceau (13/10) ----------
   L'opérateur peint une zone, décrit ce qui doit s'y trouver ; seule cette zone est
   refaite, le reste de l'image est recollé AU PIXEL PRÈS. Pas de recette à part : le
   graphe part de la recette de génération (même modèle que la prod, lue telle quelle,
   jamais modifiée, LoRA de la persona empilées) — l'image vide de départ y est
   remplacée par l'image source encodée, masquée, puis le résultat est recomposé sur
   la source. */
const INPAINT_DENOISE = 0.9   // 0,75-0,8 gardait la couleur d'origine (banc du 14/10)
export function enqueueInpaint({ sourceFile, maskFile, parentAssetId, prompt, strength }) {
  if (t0Hit(String(prompt ?? ''))) throw new Error('prompt refusé (liste T0)')
  const id = `inp-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: persona().id, register: 'sfw',
    mode: 'photo', purpose: 'creative', recipeId: 'inpaint@v1', workflowFile: RECIPES.sfw,
    seed: Math.floor(Math.random() * 0xffffffffffff), op: 'inpaint',
    sourceImage: sourceFile, inpaintMask: maskFile,
    inpaintDenoise: Number.isFinite(strength) ? Math.min(1, Math.max(0.3, strength)) : INPAINT_DENOISE,
    parentAssetId: parentAssetId ?? null,
    userPrompt: String(prompt ?? '').trim() || null, userDirectives: null,
    /* Le texte de l'opérateur SEUL : le prompt d'origine décrit ce qu'on veut justement
       changer (essai du 13/10 : « pull marine » + prompt d'origine « pull crème » → pull
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

async function runInpaint(job, t0) {
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

/* ---------- retouche vidéo au pinceau (14/10) ----------
   Même geste que sur une photo : l'opérateur peint la zone sur la PREMIÈRE image du
   clip et décrit ce qu'il veut. SAM3 suit la zone d'image en image à partir de ce
   masque (`suivi`) — ou la zone reste fixe dans le cadre. La zone est redessinée par
   le refine vidéo masqué (Wan T2V bas bruit, recette lue telle quelle), puis recollée
   sur la source : hors zone, les images de la source. Cadence de travail 16 i/s,
   fluidité RIFE ensuite. Un seul bloc : clips de ~10 s au plus (au-delà la retouche
   manque de mémoire). */
const INPAINT_VIDEO_DENOISE = 0.75
const INPAINT_VIDEO_MAX_IMAGES = 161
/* Édition au prompt (20/10) : même chaîne, mais la zone n'est pas peinte — SAM3 la
   trouve d'après `cible` (« dress », « sunglasses »…) sur chaque image et la suit ;
   le prompt dit ce qui doit s'y trouver. Rien à modifier si la cible n'est pas à
   l'image : on ne fait pas apparaître un objet absent. */
export function enqueueInpaintVideo({ sourceFile, maskFile, parentAssetId, prompt, strength, suivi, cible, inverser, retirer }) {
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
    inpaintDenoise: Number.isFinite(strength) ? Math.min(1, Math.max(0.3, strength)) : INPAINT_VIDEO_DENOISE,
    parentAssetId: parentAssetId ?? null,
    userPrompt: String(prompt ?? '').trim() || null, userDirectives: null,
    composedPositive: String(prompt ?? '').trim() || null, composedNegative: null,
    selections: null, loras: [], videoLoras: [],
    estimatedMs: Math.round(60_000 + m.frames * 2500),
  }
  store.createJob(row)
  retenirCle(row.id)
  queue.push(row)
  pump()
  return { id }
}

async function runInpaintVideo(job, t0) {
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
  }
  }
  g.mg.inputs.mask = zone; g.mg.inputs.expand = 12
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
  g.inp_bord = { class_type: 'GrowMaskWithBlur', inputs: { mask: zone, expand: job.inpaintRetirer ? 40 : 14, incremental_expandrate: 0, tapered_corners: true,
    flip_input: false, blur_radius: 6, lerp_alpha: 1, decay_factor: 1, fill_holes: false } }
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

/* ---------- avatar parlant (21/10) ----------
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

/* ---------- re-shoot : le même plan, vu d'ailleurs (21/10) ----------
   Un clip de la bibliothèque + un angle → le même instant filmé par une autre
   caméra. MoGe-2 (géométrie métrique, nœud cœur) → CrossViewWarp (Cseti,
   Apache-2.0) reprojette le clip dans la nouvelle vue, trous en magenta →
   LTX-2.5 distillé + IC-LoRA CrossView-Warp v2 (Apache-2.0, entraînée sur
   LTX-2.3) remplit les trous et rend le plan ; deux guides IC à la 1re passe
   (le warp pour la géométrie, la source pour l'identité), la source seule à
   la passe ×2. Banc du 21/10 : force 1,3, pivot auto sur le sujet, caméra
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

/* Clean plate (30/10) : retirer des personnes ou des véhicules d'un clip, le décor
   reconstruit derrière. IC-LoRA officielle LTX-2.5 Clean-Plate (Lightricks, licence
   LTX-2.x Community) sur le même graphe que Re-shoot, guidé par le clip lui-même au
   lieu de sa vue déplacée. Le son de la prise d'origine est gardé. */
const CLEANPLATE_LORA = 'ltx/ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors'
/* Verrou (30/10) : « Retirer » efface ce qu'on lui nomme ; nommer un vêtement reviendrait à dévêtir
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

/* Détourer (30/10) : SAM3 suit la personne, tout le reste passe sur fond vert uni, sans rien
   redessiner. Sortie MP4 prête pour un incrustateur ; son d'origine gardé. CPU/GPU modestes. */
export function enqueueDetour({ source, cible, parentAssetId, personaId }) {
  const c = String(cible ?? '').trim().slice(0, 80) || 'person'
  if (t0Hit(c)) throw new Error('texte refusé (liste T0)')
  if (!source || /[\\/]/.test(source) || source.startsWith('.')) throw new Error('fichier invalide')
  const duree = videoDurationOf(path.join(CONFIG.mediaDir, source))
  if (!duree) throw new Error('vidéo illisible')
  const id = `detour-${Date.now().toString(36)}`
  const row = {
    id, createdAt: Date.now(), status: 'queued', personaId: personaId ?? persona().id, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'detour@v1', workflowFile: null,
    seed: 1, op: 'detour', videoEngine: 'sam3_detour', reshootSource: source, reshootImages: Math.min(240, Math.floor(duree * 24)),
    parentAssetId: parentAssetId ?? null, userPrompt: c, userDirectives: null, composedPositive: `green screen: ${c}`, composedNegative: null,
    selections: null, loras: [], videoLoras: [], estimatedMs: Math.round(15_000 + duree * 6_000),
  }
  store.createJob(row); retenirCle(row.id); queue.push(row); pump()
  return { id }
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
  const promptId = await comfy.submitPrompt(g, CLIENT_ID)
  current = { jobId: job.id, promptId }
  store.markStarted(job.id, promptId)
  const history = await comfy.waitForPrompt(promptId, { onPhase: p => store.setStatus(job.id, p === 'queued' ? 'queued-comfy' : p) })
  const n = await harvestJob(job, promptId, history, { applied: [`détourage : SAM3 suit « ${job.userPrompt} », fond vert, ${N} images ${W}×${H}`], skipped: [], finalWorkflow: g })
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
    geo: { class_type: 'MoGeInference', inputs: { moge_model: ['m', 0], image: ['img', 0], resolution_level: 6, fov_x_degrees: 0, batch_size: 1, force_projection: true, apply_mask: true } },
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
    moge: { class_type: 'MoGeInference', inputs: { moge_model: ['mogem', 0], image: ['half', 0], resolution_level: 6, fov_x_degrees: 0, batch_size: 4, force_projection: true, apply_mask: true } },
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

async function runReshoot(job, t0) {
  const src = path.join(CONFIG.mediaDir, job.reshootSource)
  const d = videoSize(src)
  // côté long 1280, multiples de 64 (la passe ×2 part d'une demi-taille multiple de 32)
  let W = 704, H = 1280
  if (d.width && d.height) {
    if (d.width > d.height * 1.15) { W = 1280; H = 704 } else if (d.width * 1.15 >= d.height) { W = 960; H = 960 }
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
    applied: [job.op === 'cleanplate'
      ? `clean plate : LTX-2.5 + IC-LoRA Clean-Plate (Lightricks), « ${job.userPrompt} » retiré, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`
      : `re-shoot : MoGe-2 → CrossViewWarp → LTX-2.5 + IC-LoRA CrossView-Warp v2 (force 1,3), ${angle}, ${job.reshootImages} images ${W}×${H}, ${sonSource ? 'son de la prise d’origine' : 'son généré'}`],
    skipped: [], finalWorkflow: g,
  })
  store.markFinished(job.id, Date.now() - t0)
  return n
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
   ne génère que l'audio, calé sur ce qu'il voit (banc du 17/10 : 45 s pour
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
        ? `bruitage LTX-2.5 (vidéo → son, images d'origine conservées) : « ${job.composedPositive} »`
      : job.composedPositive],
    skipped: [], finalWorkflow: g,
  })
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
  /* Cadence : sortie 30 fps MINIMUM (demande 17/09 — 16 fps se voit).
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

/** Fluidité des rendus motion (08/10) : WanAnimate travaille et livre à 16 i/s,
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
  // Courbe ADOUCIE (11/09) : l'ancienne (blancs→0.82, mids −17 %) rendait les
  // i2v « ternes » — highlights écrasés + désaturation (mesuré : Ymax
  // plafonné ~194, SAT −18 % vs brut). Nouvelle courbe = de-gloss léger (blancs
  // →0.94) + saturation +10 % pour garder du pop, en conservant le grain
  // anti-plastique. Les extensions, elles, ne sont plus matées du tout (voir harvest).
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
  /* Prequel (20/10) : le rendu passe DEVANT la source — la couture est entre
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
  const cle = clesComfy.get(job.id)
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
 *  doublait le rendu (513 images pour 8,5 s, constaté le 24/08). */
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
  if (Number.isFinite(fps0) && Math.abs(fps0 - 16) > 0.5) {
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
  if (!job.motionRef && job.motionMode === 'replace') return { refName: await refDuPersonnage(job, driverPath, frames, fps), frames, fps }
  if (!job.motionRef) throw new Error('still de référence manquante')
  return { refName: job.motionRef, frames, fps }
}

/* Mix depuis la vidéo seule (21/10) : la référence d'apparence est fabriquée ici.
   La prod échange la tête sur une image du driver (LoRA BFS, licence sans usage
   hébergé : exclue du studio public). Ici : l'image la plus nette de la première
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
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', driverPath, '-vf', `select=eq(n\\,${idx})`, '-vframes', '1',
    path.join(CONFIG.comfyInput, src)], { stdio: ['ignore', 'ignore', 'pipe'] })
  store.setStatus(job.id, 'rendering')
  const tenue = await vision.describeOutfit(path.join(CONFIG.comfyInput, src))
  const p = persona(job.personaId)
  const positive = `full body photo, standing and facing the camera, arms relaxed, natural expression, `
    + `${tenue ? `wearing ${tenue}, ` : ''}soft even daylight, plain background, sharp focus, 50mm`
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

/** Mix : la recette de remplacement, injectée par ids (cf. MIX_RECIPE). */
function grapheMix(job, motion, applied, skipped) {
  const mg = comfy.loadWorkflow(MIX_RECIPE)
  mg['63'].inputs.video = job.motionDriver
  mg['57'].inputs.image = motion.refName
  mg['65'].inputs.positive_prompt = job.motionSceneText || (job.composedPositive || '').trim()
  /* Verrou SFW du Mix (30/10) : sans consigne de tenue, un driver en maillot a rendu un corps
     dévêtu. Chaque Mix dit que le personnage reste habillé et refuse la nudité. Ne pas retirer. */
  mg['65'].inputs.positive_prompt = `${mg['65'].inputs.positive_prompt}, an adult woman, fully clothed, same outfit coverage on every frame`.replace(/^, /, '')
  mg['65'].inputs.negative_prompt = `${mg['65'].inputs.negative_prompt ?? ''}, nude, naked, nudity, topless, bottomless, bare breasts, bare crotch, genitals`.replace(/^, /, '')
    || 'a young woman, photorealistic, natural skin, cinematic'
  mg['27'].inputs.seed = job.seed
  mg['998'].inputs.filename_prefix = `creatoros/${job.id}/out`
  /* Réglages validés en prod : pas de relight, distill assoupli (0.8), 28 pas,
     UNE fenêtre qui couvre tout le driver (plusieurs fenêtres désynchronisent le fond). */
  const wan = persona(job.personaId).videoLoras.filter(l => /wan/i.test(l.name) && !/wan.?2\.?1|wan21|ltx/i.test(l.name))
  const haut = wan.find(l => /high/i.test(l.name)), bas = wan.find(l => /low/i.test(l.name))
  mg['171'].inputs.lora_0 = 'none'
  mg['171'].inputs.strength_1 = 0.8
  if (haut && bas) {
    mg['171'].inputs.lora_2 = haut.name; mg['171'].inputs.strength_2 = 0.9
    mg['171'].inputs.lora_3 = bas.name; mg['171'].inputs.strength_3 = 0.9
    applied.push(`LoRA d'identité Wan du personnage : ${haut.name} · ${bas.name} (0.9)`)
  } else skipped.push('pas de LoRA d’identité Wan (haut + bas bruit) pour ce personnage : l’identité ne tient que par la still')
  mg['27'].inputs.steps = 28
  /* Visage du driver suivi (DWPose), mais à mi-force (banc 21/10, même graine) :
     à 1, la bouche du driver se plaquait en tache sombre sur le visage de la still ;
     sans la branche visage, le visage sortait flou et sans traits. */
  mg['73'].inputs.detect_face = 'enable'
  mg['62'].inputs.face_strength = 0.5
  /* Longueur (21/10, #444-6mh5) : un driver de 30 s (481 images) en une seule
     fenêtre ne tient pas sur la carte, 104 s par pas puis panne de mémoire. Le
     driver est coupé à 153 images (9,6 s) ; jusqu'à 81 images une seule fenêtre,
     plus propre sur un clip court, au-delà deux fenêtres qui se recouvrent d'une
     image (2w − 1 ≥ n). Une fenêtre fixe de 77 sur 161 images en faisait trois :
     229 images rendues, le clip livré durait 14 s au lieu de 10. */
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
    const raw = execFileSync(COMFY_PY, [GDINO_POINTS, path.join(CONFIG.comfyInput, job.motionDriver), String(mw), String(mh), 'woman'],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, COMFY_DIR: CONFIG.comfyDir } })
    const pts = JSON.parse(raw.trim().split('\n').pop())
    Object.assign(mg['107'].inputs, { width: mw, height: mh, normalize: false,
      points_store: JSON.stringify({ positive: pts.positive, negative: [] }), coordinates: JSON.stringify(pts.positive) })
    delete mg['104'].inputs.coordinates_negative
    applied.push(`masque automatique : sujet « woman », ${pts.positive.length} points`)
  } catch (e) {
    skipped.push(`masque automatique indisponible (${String(e.message || e).slice(0, 80)}) : points par défaut de la recette`)
  }
  applied.push(`Mix WanAnimate : la still « ${motion.refName} » dans le décor du driver (${n} images), ${mw}×${mh}`)
  return mg
}

async function runJob(job, isRetry = false, connRetried = false) {
  const t0 = Date.now()
  try {
    if (job.op === 'photo_hd') return await runPhotoHd(job, t0)
    if (job.op === 'inpaint') return await runInpaint(job, t0)
    // ces clips sont contrôlés aussi (30/10), sans relance : ils ne se rejouent pas comme un clip ordinaire
    const controler = n => { void controlerJob(job, null).catch(e => console.warn(`[contrôle] ${String(e.message || e).slice(0, 200)}`)); return n }
    if (job.op === 'inpaint_video') return controler(await runInpaintVideo(job, t0))
    if (job.op === 'parole') return controler(await runParole(job, t0))
    if (job.op === 'reshoot' || job.op === 'cleanplate') return controler(await runReshoot(job, t0))
    if (job.op === 'detour') return await runDetour(job, t0)
    if (job.op === 'foley' || job.op === 'interpolate') return await runFinition(job, t0)
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
    /* LoRA vidéo du personnage FILTRÉES par famille de moteur (21/10) : une LoRA
       LTX (« mila_ltx23… ») n'a rien à faire sur un graphe Wan, ni une Wan 2.2
       sur le Wan 2.1 des effets. Le nom dit la famille ; sans indice, la LoRA
       passe partout, comme avant. */
    const familleLora = n => /ltx/i.test(n) ? 'ltx' : /wan.?2\.?1|wan21/i.test(n) ? 'wan21' : /wan/i.test(n) ? 'wan' : null
    const familleMoteur = /^ltx/.test(job.videoEngine ?? '') ? 'ltx' : /^wan21/.test(job.videoEngine ?? '') ? 'wan21' : /^wan/.test(job.videoEngine ?? '') ? 'wan' : null
    const persoVideo = p.videoLoras.filter(l => { const f = familleLora(String(l.name)); return !f || !familleMoteur || f === familleMoteur })
    const texteSeul = isVideo && job.t2v === true
    const ambiance = texteSeul && !(job.t2vPersonnage === true && persoVideo.length)
    const preamble = isEdit || ambiance ? null
      /* + le préambule du personnage (20/10) : certaines LoRA vidéo ont appris une
         phrase entière (« Aisha-AW, she has dark hair »), que le champ mot
         déclencheur, réduit à un jeton, ne peut pas porter. */
      : isVideo ? (persoVideo.length && p.trigger ? { key: 'persona-video', file: null, text: `${p.trigger}, ${p.preamble ? `${p.preamble}, ` : ''}an adult woman in her mid-twenties, ` } : null)
      : identityPreambleFor(job.personaId)

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
    const positive = speech?.text ?? drawn.text
    const wildcardNotes = [
      ...drawn.draws.map(d => `tirage wildcard ${d.token} → « ${d.value} »`),
      ...drawn.unknown.map(t => `wildcard ${t} INCONNU : aucun fichier dans ${CONFIG.wildcardsDir} — laissé tel quel`),
    ]
    const blocked = t0Hit(positive)
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
      loras: isEdit ? undefined : isVideo ? videoLorasEff : photoLoras,
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
      finalWorkflow = grapheMix(job, await buildMotionRef(job), applied, skipped)
      /* Carte vidée avant Wan-Animate (21/10, #444-6mh5) : derrière le rendu Krea
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
      // générique, c'est ce qui mutait l'identité au bench. Le texte opérateur
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
       lourdes (reproduit, puis contre-testé : le même job passe sans décharge
       préalable). La gestion progressive de ComfyUI fait mieux quand les
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
           recompresser à 6,00 accélérait encore la voix de 10 % (constaté
           le 25/08 sur DRAFT-minimax-1). Seule la cadence reste conformée. */
        const r = conformVideo(full,
          (job.videoSpeed ?? 1) !== 1 ? job.videoSeconds : null, job.videoFps)
        if (r) console.log(`[job ${job.id}] ${r}`)
        if (job.op === 'inpaint_video' || job.videoEngine === 'wan_t2v' || /^wan21/.test(job.videoEngine ?? '')) {
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) applied.push(fl)
        }
        if (job.videoEngine === 'motion') {
          // prévisu ET final (opérateur, 08/10) : coût mesuré sous la minute
          const fl = await fluidifier(full, job.id)
          if (fl?.echec) skipped.push(`fluidité (RIFE) NON appliquée, rendu livré à 16 i/s — ${fl.echec}`)
          else if (fl) { console.log(`[job ${job.id}] ${fl}`); applied.push(fl) }
        }
        // Passe MATE (dé-brillance + grain) sur les rendus qui sortent glossy :
        // motion (WanAnimate) ET i2v minimax (distill H3). Pas wan/ltx.
        // Extensions : PAS de matte (décision 11/09). Le matte aplatissait la
        // continuation, et le seam color-match ci-dessous aligne déjà son grade
        // sur la source — double traitement inutile qui ternissait le plan.
        const isExtension = typeof job.concatWith === 'string' && job.concatWith.trim()
        const applyMatte = !isExtension
          && ((typeof job.motionDriver === 'string' && job.motionDriver.trim())
            || job.videoEngine === 'minimax')
        if (applyMatte) {
          const dg = matteVideo(full)
          if (dg) console.log(`[job ${job.id}] ${dg}`)
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

/* Place d'un job en attente, pour l'afficher au visiteur (22/10) : son rang
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
