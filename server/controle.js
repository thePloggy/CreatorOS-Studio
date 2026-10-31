/* ============================================================
   Contrôle automatique des clips rendus (27/10).

   Après chaque vidéo, scripts/controle_clip.py mesure en une à deux
   secondes, sur le CPU : images noires, vidéo figée, saute au milieu du
   plan, flou, et la ressemblance du visage avec l'image de départ (YuNet +
   SFace d'OpenCV, Apache-2.0). Ce ne sont que des mesures, pas un modèle
   qui juge.

   Un défaut GRAVE (noir, figé, saute, long flou) relance UNE prise avec une
   autre seed. Les deux prises restent dans la bibliothèque ; celle qui a le
   moins de défauts est gardée en avant, l'autre est grisée. Le visage et le
   flou court ne sont que des avertissements : lunettes, profil, visage coupé
   faussent la mesure, une relance à chaque fois gaspillerait le GPU.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as store from './db.js'

const run = promisify(execFile)
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'controle_clip.py')
// installés par l'assistant dans models/opencv/ de ComfyUI ; dossier de données en repli
const DANS_COMFY = path.join(CONFIG.comfyDir ?? '', 'models', 'opencv')
export const MODELES_CONTROLE = process.env.CREATOROS_MODELES_CONTROLE
  || (fs.existsSync(path.join(DANS_COMFY, 'face_recognition_sface_2021dec.onnx')) ? DANS_COMFY : path.join(CONFIG.dataDir, 'modeles-controle'))

/* Mouvement de caméra attendu par preset (30/10) : vérifié par le flux optique, en avertissement.
   Les presets enchaînés (jib-down) et les mouvements composés (orbite, arc…) ne sont pas lus. */
const MOUVEMENT_PRESET = {
  'push-in': 'avant', 'crash-zoom': 'avant', 'pull-out': 'arriere', 'crash-zoom-out': 'arriere',
  'travelling-lateral': 'lateral', panoramique: 'lateral', drone: 'vertical', 'grue-haute': 'vertical', 'fixe-vivant': 'fixe',
}

/** Contrôle un clip ; rend le résultat du script, ou null si le contrôle est indisponible. */
export async function controlerClip(clip, ref, mouvement) {
  const args = [SCRIPT, clip, '--modeles', MODELES_CONTROLE]
  if (ref && fs.existsSync(ref)) args.push('--ref', ref)
  if (mouvement) args.push('--mouvement', mouvement)
  try {
    // le Python de ComfyUI a OpenCV ; à défaut, celui du système (le contrôle se dit alors indisponible s'il n'a pas cv2)
    const py = fs.existsSync(CONFIG.comfyPython) ? CONFIG.comfyPython : 'python3'
    const { stdout } = await run(py, args, { timeout: 120_000, maxBuffer: 4 << 20 })
    const d = JSON.parse(stdout.trim().split('\n').pop())
    return d.erreur ? null : d
  } catch (e) {
    console.warn(`[contrôle] indisponible — ${String(e.message || e).slice(0, 200)}`)
    return null
  }
}

/* Boucle (31/10) : SSIM entre la dernière image du clip et la première, c'est la saute vue à chaque tour. */
const JOINTURE_PROPRE = 0.9
async function mesurerJointure(clip) {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', clip, '-sseof', '-0.05', '-i', clip, '-lavfi',
      '[1:v]trim=end_frame=1,setpts=PTS-STARTPTS[b];[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[a];[a][b]ssim', '-f', 'null', '-'], { timeout: 30_000 })
    const m = /All:([\d.]+)/.exec(stderr)
    if (!m) return undefined
    const ssim = Number(m[1])
    return { ssim, propre: ssim >= JOINTURE_PROPRE }
  } catch { return undefined }
}

const graves = c => (c?.problemes ?? []).filter(p => p.grave)
const poids = c => graves(c).length * 10 + (c?.problemes ?? []).length

/** Après un job vidéo terminé : contrôle de ses clips, relance éventuelle, choix entre deux prises.
 *  `relancer(payload)` dépose un job (enqueue) ; il n'est jamais appelé pour une prise de relance. */
export async function controlerJob(job, relancer) {
  if (job.mode !== 'video') return
  const assets = store.assetsOfJob(job.id).filter(a => a.media_type === 'video' && !String(a.filename).includes('-montage-'))
  const ref = job.sourceImage ? path.join(CONFIG.comfyInput, path.basename(String(job.sourceImage))) : null
  for (const a of assets) {
    const c = await controlerClip(path.join(CONFIG.mediaDir, a.filename), ref, MOUVEMENT_PRESET[job.presetId])
    if (!c) continue
    const g = graves(c)
    c.prise = job.priseDe ? 2 : 1
    if (job.endImage && job.endImage === job.sourceImage) c.boucle = await mesurerJointure(path.join(CONFIG.mediaDir, a.filename))
    if (job.priseDe) c.priseDe = job.priseDe
    store.ecrireControle(a.id, job.id, c)
    console.log(`[contrôle] ${a.id} : ${c.problemes.length ? c.problemes.map(p => p.detail).join(' ; ') : 'rien à signaler'}`
      + (c.visage?.score != null ? ` · visage ${c.visage.score}` : ''))

    // prise 2 terminée : on garde la meilleure des deux, l'autre passe en grisé (rien n'est supprimé)
    if (job.priseDe) {
      const avant = store.assetsOfJob(job.priseDe).find(x => x.media_type === 'video' && !String(x.filename).includes('-montage-'))
      const cAvant = avant && store.lireControle(avant.id)
      if (avant && cAvant) {
        const garde = poids(c) <= poids(cAvant) ? a : avant
        const ecarte = garde === a ? avant : a
        if ((ecarte.review_status ?? 'pending') === 'pending') store.setReview(ecarte.id, 'rejected')
        for (const [x, cx] of [[a, c], [avant, cAvant]])
          store.ecrireControle(x.id, x.job_id, { ...cx, choix: x.id === garde.id ? 'gardée' : 'écartée' })
        console.log(`[contrôle] prise gardée : ${garde.id} (l'autre est grisée)`)
      }
      continue
    }
    // prise 1 avec un défaut grave : UNE relance, autre seed
    if (g.length && typeof relancer === 'function') {
      try {
        const p = JSON.parse(store.getJob(job.id)?.payload || 'null')
        if (!p) continue
        for (const f of ['id', 'createdAt', 'status', 'estimatedMs', 'requestId', 'batchIds', 'error']) delete p[f]
        p.seed = { mode: 'random' }
        p.priseDe = job.id
        const r = relancer(p)
        store.ecrireControle(a.id, job.id, { ...c, relance: r?.id ?? true })
        console.log(`[contrôle] ${a.id} : ${g.map(x => x.type).join(', ')} → nouvelle prise ${r?.id ?? ''}`)
      } catch (e) { console.warn(`[contrôle] relance impossible — ${String(e.message || e).slice(0, 200)}`) }
    }
  }
}
