/* ============================================================
   One-click presets: a gallery of camera moves and effects. A library
   photo, one click, one clip. Each preset is a staging sentence tuned for
   the engine (plus a dedicated LoRA when one exists and its license allows).
   The clip goes through the regular render queue, like a manual video.

   Gallery previews are clips rendered once and stored in
   <data>/presets/<id>.mp4 (see scripts/demo/presets.mjs).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { execFileSync } from 'node:child_process'
import { enqueue, deposerAvecCle } from './jobs.js'
import { persona } from './persona.js'
import { t0Hit } from './t0.js'

export const APERCUS_DIR = path.join(CONFIG.dataDir, 'presets')

/* `prompt` describes the camera MOVE, the subject stays the photo's;
   `{sujet}` is replaced by the operator's optional detail. Present tense,
   a single camera action, speed stated: LTX follows a single explicit
   camera instruction best. */
/* `moteur`: 'ltx_hq' (LTX-2.5, with audio), 'wan21' (Wan 2.1 I2V 480p, base of the
   effect LoRAs, 4 steps) or 'wan21_hq' (same base, Remade 28-step setting: effects).
   Effects use the Remade model card sentence pattern ("The video shows…"), with the
   subject named "the woman" throughout: a short sentence makes the effect miss her.
   `lora`: file relative to the LoRA folder, license in a comment; its trigger word
   leads the prompt.
   Licenses: LTX-2 Community (Lightricks, free commercial use under $10M revenue);
   Remade-AI and ostris: Apache-2.0. Excluded: third-party IP effects and effects
   that undress the subject. Robot face, jaw and explosion use the fast setting. */
const LTX = n => ({ name: `ltx_camera/ltx-2-19b-lora-camera-control-${n}.safetensors`, strength: 0.9 })
const REMADE = (dossier, f) => ({ name: `${dossier}/wan21_i2v_remade_${f}.safetensors`, strength: 1 })
export const PRESETS = [
  // ---- camera, LTX-2.5 (with audio) ----
  { id: 'push-in', famille: 'camera', moteur: 'ltx_hq', lora: LTX('dolly-in'), nom: 'Travelling avant', nomEn: 'Push in', icone: '⇥',
    prompt: 'The camera slowly and smoothly dollies forward toward her, steady cinematic push-in, ending closer on her face. {sujet}' },
  // ---- camera, Wan 2.2 Fun Camera (trajectory, silent) ----
  { id: 'pull-out', famille: 'camera', moteur: 'wan_funcam', camera: 'Zoom Out', nom: 'Travelling arrière', nomEn: 'Pull out reveal', icone: '⇤',
    prompt: 'She stays in place facing the camera, only her hair and clothes move in the wind. The camera smoothly pulls back away from her, revealing the whole place around her by the end of the shot, cinematic. {sujet}' },
  { id: 'travelling-lateral', famille: 'camera', moteur: 'ltx_hq', lora: LTX('dolly-left'), nom: 'Travelling latéral', nomEn: 'Side tracking', icone: '⇆',
    prompt: 'The camera trucks sideways to the left on a rail, moving parallel to the scene, the background sliding past behind her, she stays centered in the frame, a clear unobstructed view. {sujet}' },
  { id: 'drone', famille: 'camera', moteur: 'ltx_hq', lora: LTX('jib-up'), nom: 'Grue ascendante', nomEn: 'Jib up', icone: '⤒',
    prompt: 'The camera rises smoothly on a jib, lifting above her and revealing the place from higher up. {sujet}' },
  /* Two renders: a rising crane from the photo, then its last frame (top
     view) is the START of a Wan 2.2 shot that ENDS on the photo (start + end
     frame). Requested directly from the photo, the descent brings a crane into
     the frame; played backwards, the subject walks backwards. */
  { id: 'jib-down', famille: 'camera', moteur: 'ltx_hq', lora: LTX('jib-up'), nom: 'Grue descendante', nomEn: 'Jib down', icone: '⤓',
    prompt: 'The camera rises smoothly straight up above her, revealing the place from higher up. {sujet}',
    suite: { moteur: 'wan', prompt: 'The camera descends smoothly from high above down to her eye level and settles on her, one continuous smooth crane move. {sujet}' } },
  { id: 'fixe-vivant', famille: 'camera', moteur: 'ltx_hq', lora: LTX('static'), nom: 'Plan fixe vivant', nomEn: 'Living still', icone: '▣',
    prompt: 'Locked-off static camera. Only subtle natural motion: her hair and clothes move slightly in the breeze, she blinks and breathes, light flickers softly. {sujet}' },
  { id: 'epaule', famille: 'camera', moteur: 'ltx_hq', nom: 'Caméra à l’épaule', nomEn: 'Handheld follow', icone: '✋',
    prompt: 'Handheld camera follows her closely with a natural slight shake as she keeps walking, her hands relaxed and empty at her sides, documentary style, intimate and spontaneous. {sujet}' },
  { id: 'panoramique', famille: 'camera', moteur: 'ltx_hq', nom: 'Panoramique', nomEn: 'Pan', icone: '↔',
    prompt: 'The camera pans slowly from left to right across the scene and settles on her, smooth tripod pan. {sujet}' },
  // ---- camera, Wan 2.1 + Remade / ostris LoRA, Remade 28-step setting ----
  { id: 'orbite', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', '360_Orbit'), nom: 'Orbite 360°', nomEn: '360° orbit', icone: '↻',
    prompt: '0rb4it 360 degree orbit. The camera orbits all the way around her while she stays in place. {sujet}' },
  { id: 'arc', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'Arc_shot'), nom: 'Arc', nomEn: 'Arc shot', icone: '◠',
    prompt: '34Ar2c arc shot. The camera moves in a short smooth arc from her front-left to her front-right, she stays facing the camera the whole time, we always see her face. {sujet}' },
  { id: 'crash-zoom', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'crash_zoom_in'), nom: 'Crash zoom', nomEn: 'Crash zoom', icone: '⊕',
    prompt: "The video begins with a wide shot of a woman standing still. Suddenly the camera performs a cr34sh crash zoom in effect, zooming in extremely fast onto the woman's face in a split second, then holding on an extreme close-up of her face. Fast whip zoom, motion blur. {sujet}" },
  { id: 'crash-zoom-out', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'crash_zoom_out'), nom: 'Crash zoom arrière', nomEn: 'Crash zoom out', icone: '⊖',
    prompt: 'The video begins with a close-up shot of a woman\'s face. The cr34sh crash zoom out effect then begins, quickly pulling back to reveal the whole place around her, the woman small in the frame. {sujet}' },
  { id: 'bullet-time', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'matrix_shot'), nom: 'Bullet time', nomEn: 'Bullet time', icone: '⧗',
    // same structure as the LoRA examples: trigger first, frozen moment, suspended elements, then the orbiting camera
    prompt: 'b4ll3t t1m3 bullet time shot A woman is captured mid-leap, her hair, her clothes and the dust around her suspended in mid-air. The scene utilizes a b4ll3t t1m3 bullet time shot effect, where the action is dramatically slowed down, freezing her in her dynamic pose. The background stays the same place, slightly blurred by the effect. The camera smoothly rotates around her, offering varying views of the frozen moment from all angles. {sujet}' },
  { id: 'grue-haute', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'crane_overhead'), nom: 'Grue au-dessus', nomEn: 'Overhead crane', icone: '⊙',
    prompt: 'cr4n3 crane over the head movement, the camera passes high above her. {sujet}' },
  { id: 'dolly-zoom', famille: 'camera', moteur: 'wan21_hq', lora: REMADE('wan_camera', 'dolly_25_epochs'), nom: 'Dolly zoom', nomEn: 'Dolly zoom', icone: '◎',
    // the effect only reads with scenery around her: medium-long shot or wider
    prompt: 'd011Ye33ect dolly effect. The video shows a woman standing in a wide place, seen from mid-thigh up. The camera slowly zooms out while moving forward, keeping her face centered and the same size, while the place behind her stretches and distorts dramatically. {sujet}' },
  // ---- effects, Wan 2.1 + Remade LoRA, Remade setting (28 steps) ----
  { id: 'squish', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'squish_18'), nom: 'Écrasé', nomEn: 'Squish', icone: '🫳',
    prompt: "In the video, a woman is presented. The woman is held in a person's hands. The person then presses on the woman, causing a sq41sh squish effect. The person keeps pressing down on the woman, further showing the sq41sh squish effect. {sujet}" },
  { id: 'inflate', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'inflate_20_epochs'), nom: 'Gonfle', nomEn: 'Inflate', icone: '🎈',
    prompt: 'The video shows a woman. The woman starts to inflate, her body expanding and getting rounder like a balloon. Then the woman infl4t3 inflates it, floating up as it inflates. {sujet}' },
  { id: 'deflate', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'deflate_20_epochs'), nom: 'Dégonfle', nomEn: 'Deflate', icone: '🫧',
    prompt: 'The video opens with a woman. The woman begins to d3d1at3 deflate it, her whole body slowly losing its air like a pool float, sagging and shrinking until she is a flat deflated shape, cartoon style. {sujet}' },
  { id: 'cakeify', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'cakeify_16_epochs'), nom: 'C’est un gâteau', nomEn: 'Cakeify', icone: '🍰',
    prompt: 'The video opens on a woman. A knife, held by a hand, is coming into frame and hovering over the woman. The knife then begins cutting into the woman to c4k3 cakeify it. As the knife slices the woman open, the inside of the woman is revealed to be cake with chocolate layers. {sujet}' },
  { id: 'crush', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'crush_20_epochs'), nom: 'Presse', nomEn: 'Crush', icone: '🗜',
    prompt: 'The video begins with a woman. A hydraulic press positioned above slowly descends towards the woman. Upon contact, the hydraulic press c5us4 crushes it, deforming and flattening the woman, causing the woman to collapse inward, cartoon style. {sujet}' },
  { id: 'rotate', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'rotate_20_epochs'), nom: 'Rotation 360°', nomEn: '360° spin', icone: '🔄',
    prompt: 'The video shows a woman performing a r0t4tion 360 degrees rotation, she turns around a full turn and faces the camera again. {sujet}' },
  { id: 'explode', famille: 'effet', moteur: 'wan21', lora: REMADE('wan_effects', 'explode_30_epochs'), nom: 'Explosion', nomEn: 'Explode', icone: '💥',
    prompt: '3xp105ion huge explosion behind her, debris and fire, she stands still. {sujet}' },
  { id: 'electrify', famille: 'effet', moteur: 'wan21_hq', lora: REMADE('wan_effects', 'electrify_50_epochs'), nom: 'Électrisée', nomEn: 'Electrify', icone: '⚡',
    prompt: "The video shows a woman. The woman is suddenly struck by e13c7r1c electricity, bolts of lightning crackling all over the woman's body, her hair standing up. {sujet}" },
  { id: 'robot', famille: 'effet', moteur: 'wan21', lora: REMADE('wan_effects', 'robot_face_reveal_35_epochs'), nom: 'Visage de robot', nomEn: 'Robot reveal', icone: '🤖',
    prompt: 'r8b8t1c robotic face reveal, her face opens to reveal robotic parts. {sujet}' },
  { id: 'jaw-drop', famille: 'effet', moteur: 'wan21', lora: REMADE('wan_effects', 'cartoon_jaw_drop_50_epochs'), nom: 'Mâchoire qui tombe', nomEn: 'Jaw drop', icone: '😮',
    prompt: 'dr0p_j88 comical jaw drop, her jaw drops in exaggerated cartoon surprise. {sujet}' },
]

export function listerPresets() {
  return PRESETS.map(p => ({
    id: p.id, famille: p.famille, nom: p.nom, nomEn: p.nomEn, icone: p.icone, lora: p.lora?.name ?? null, moteur: p.moteur, deuxRendus: !!p.suite,
    // file date in the URL: a replaced preview is not served from the browser cache
    apercu: fs.existsSync(path.join(APERCUS_DIR, `${p.id}.mp4`)) ? `/api/presets/${p.id}/apercu?v=${Math.round(fs.statSync(path.join(APERCUS_DIR, `${p.id}.mp4`)).mtimeMs)}` : null,
  }))
}
export const cheminApercu = id => {
  const f = path.join(APERCUS_DIR, `${path.basename(String(id))}.mp4`)
  return fs.existsSync(f) ? f : null
}

/** Runs a preset on a library photo. */
export function lancer({ presetId, assetId, detail, duree }) {
  const p = PRESETS.find(x => x.id === presetId)
  if (!p) throw new Error('preset inconnu')
  const a = store.getAsset(String(assetId ?? ''))
  if (!a || a.media_type !== 'photo' || !a.filename) throw new Error('choisis une photo de la bibliothèque')
  const d = String(detail ?? '').trim().slice(0, 300)
  if (t0Hit(d)) throw new Error('détail refusé (liste T0)')
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  const texte = p.prompt.replace('{sujet}', d).trim()
  // Wan 2.1 480p and Fun Camera: 16 fps, 5 s max, a standard format at their training resolution
  const wan480 = /^(wan21|wan_funcam)/.test(p.moteur)
  const job = enqueue({
    // the PHOTO's character (its video LoRA, its trigger word), not the active one
    mode: 'video', register: 'sfw', personaId: a.persona_id ?? persona().id, purpose: 'creative',
    videoEngine: p.moteur, withAudio: p.moteur === 'ltx_hq',
    sourceImage: nom, composedPositive: `${texte}. single continuous shot, no cuts`, userPrompt: texte, composedNegative: '',
    /* LTX: the exact photo format. Wan 2.1 480p: a standard format at its training
       resolution (480×832); "origine" would push it to 1080p. */
    videoSeconds: Math.min(wan480 ? 5 : 8, Math.max(3, Number(duree) || 5)), videoFps: wan480 ? 16 : 24,
    videoAspect: wan480 ? ((a.width ?? 9) > (a.height ?? 16) * 1.15 ? '16:9' : (a.width ?? 9) * 1.15 < (a.height ?? 16) ? '9:16' : '1:1') : 'origine',
    videoSrcW: a.width ?? undefined, videoSrcH: a.height ?? undefined,
    videoLoras: p.lora ? [p.lora] : [], presetId: p.id, parentAssetId: a.id, cameraPose: p.camera,
  })
  if (p.suite) {
    store.db.prepare('INSERT INTO presets_suites (job1, preset_id, photo, asset_id, detail, duree, etat, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(job.id, p.id, nom, a.id, d, Number(duree) || 5, 'attente', Date.now())
    if (cleDe) suitesCles.set(job.id, cleDe)
  }
  return job
}

/* ---------- two-render presets (descending crane) ----------
   State is stored in the database: the sequence resumes after a restart. The
   visitor's Comfy Cloud key stays in memory only, as for reels. */
store.db.exec(`CREATE TABLE IF NOT EXISTS presets_suites (
  job1 TEXT PRIMARY KEY, preset_id TEXT NOT NULL, photo TEXT NOT NULL, asset_id TEXT, detail TEXT, duree REAL,
  etat TEXT NOT NULL, job2 TEXT, created_at INTEGER NOT NULL)`)
const suitesCles = new Map()
let cleDe = null
/** Runs a preset, keeping the visitor's key for the possible second render. */
export function lancerAvecCle(cle, args) {
  cleDe = cle
  try { return lancer(args) } finally { cleDe = null }
}

function avancerSuite(row) {
  const p = PRESETS.find(x => x.id === row.preset_id)
  const j1 = store.getJob(row.job1)
  if (!p?.suite || !j1) return store.db.prepare(`UPDATE presets_suites SET etat = 'abandon' WHERE job1 = ?`).run(row.job1)
  if (['blocked', 'cancelled'].includes(j1.status)) return store.db.prepare(`UPDATE presets_suites SET etat = 'abandon' WHERE job1 = ?`).run(row.job1)
  if (j1.status !== 'done') return
  const clip = store.assetsOfJob(row.job1).find(x => x.media_type === 'video' && x.filename)
  if (!clip) return store.db.prepare(`UPDATE presets_suites SET etat = 'abandon' WHERE job1 = ?`).run(row.job1)
  // last frame of the first render → START frame of the second
  const debut = `crs_suite_${row.job1}.png`
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.1', '-i', path.join(CONFIG.mediaDir, path.basename(clip.filename)),
    '-frames:v', '1', '-update', '1', path.join(CONFIG.comfyInput, debut)], { stdio: ['ignore', 'ignore', 'pipe'] })
  store.noterInput(debut)
  const a = store.getAsset(row.asset_id)
  const texte = p.suite.prompt.replace('{sujet}', row.detail ?? '').trim()
  const j2 = deposerAvecCle(suitesCles.get(row.job1) ?? null, () => enqueue({
    mode: 'video', register: 'sfw', personaId: a?.persona_id ?? j1.personaId ?? persona().id, purpose: 'creative',
    videoEngine: p.suite.moteur, withAudio: false,
    sourceImage: debut, endImage: row.photo, composedPositive: `${texte}. single continuous shot, no cuts`, userPrompt: texte, composedNegative: '',
    videoSeconds: Math.min(8, Math.max(3, Number(row.duree) || 5)), videoFps: 24, videoAspect: 'origine',
    videoSrcW: a?.width ?? undefined, videoSrcH: a?.height ?? undefined,
    videoLoras: [], presetId: p.id, parentAssetId: row.asset_id,
  }))
  suitesCles.delete(row.job1)
  store.db.prepare(`UPDATE presets_suites SET etat = 'lance', job2 = ? WHERE job1 = ?`).run(j2.id, row.job1)
  console.log(`[preset ${p.id}] 1er rendu ${row.job1} fini → second rendu ${j2.id} (début = sa dernière image, fin = la photo)`)
}
export function demarrerSuites() {
  setInterval(() => {
    for (const row of store.db.prepare(`SELECT * FROM presets_suites WHERE etat = 'attente'`).all()) {
      try { avancerSuite(row) } catch (e) {
        console.warn(`[preset suite ${row.job1}] ${e.message || e}`)
        store.db.prepare(`UPDATE presets_suites SET etat = 'echec' WHERE job1 = ?`).run(row.job1)
      }
    }
  }, 5000).unref()
}
