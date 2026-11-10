/* ============================================================
   Automatic check of rendered clips.

   After each video, scripts/controle_clip.py measures on the CPU in one
   to two seconds: black frames, frozen video, mid-shot jump, blur, and face
   similarity to the start image (OpenCV YuNet + SFace, Apache-2.0). These
   are measurements, not a judging model.

   A SEVERE defect (black, frozen, jump, long blur) triggers ONE retake with
   another seed. Both takes stay in the library; the one with fewer defects
   is kept in front, the other greyed out. Face and short blur are warnings
   only: glasses, profile or a cropped face skew the measure.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as store from './db.js'

const run = promisify(execFile)
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'controle_clip.py')
// installed by the assistant in ComfyUI's models/opencv/; data directory as fallback
const DANS_COMFY = path.join(CONFIG.comfyDir ?? '', 'models', 'opencv')
export const MODELES_CONTROLE = process.env.CREATOROS_MODELES_CONTROLE
  || (fs.existsSync(path.join(DANS_COMFY, 'face_recognition_sface_2021dec.onnx')) ? DANS_COMFY : path.join(CONFIG.dataDir, 'modeles-controle'))

/* Expected camera move per preset: checked by optical flow, as a warning.
   Chained presets (jib-down) and compound moves (orbit, arc...) are not checked. */
const MOUVEMENT_PRESET = {
  'push-in': 'avant', 'crash-zoom': 'avant', 'pull-out': 'arriere', 'crash-zoom-out': 'arriere',
  'travelling-lateral': 'lateral', panoramique: 'lateral', drone: 'vertical', 'grue-haute': 'vertical', 'fixe-vivant': 'fixe',
}

/** Checks a clip; returns the script result, or null if the check is unavailable. */
export async function controlerClip(clip, ref, mouvement) {
  const args = [SCRIPT, clip, '--modeles', MODELES_CONTROLE]
  if (ref && fs.existsSync(ref)) args.push('--ref', ref)
  if (mouvement) args.push('--mouvement', mouvement)
  try {
    // ComfyUI's Python has OpenCV; otherwise the system one (check reports unavailable without cv2)
    const py = fs.existsSync(CONFIG.comfyPython) ? CONFIG.comfyPython : 'python3'
    const { stdout } = await run(py, args, { timeout: 120_000, maxBuffer: 4 << 20 })
    const d = JSON.parse(stdout.trim().split('\n').pop())
    return d.erreur ? null : d
  } catch (e) {
    console.warn(`[contrôle] indisponible — ${String(e.message || e).slice(0, 200)}`)
    return null
  }
}

/* Loop: SSIM between the clip's last and first frame, i.e. the jump seen on each loop. */
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

/** After a finished video job: checks its clips, possible retake, choice between two takes.
 *  `relancer(payload)` enqueues a job; it is never called for a retake. */
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

    // take 2 done: keep the better of the two, grey out the other (nothing is deleted)
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
    // take 1 with a severe defect: ONE retake, another seed
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

/* The take of a clip to edit once checked: take 1 if it has no severe defect, otherwise
   the better of the two once the retake is checked. `attente` while the check or the
   retake is not finished; with no check after 2 min, take 1. */
const premiere = jobId => store.assetsOfJob(jobId).find(x => x.media_type === 'video' && !String(x.id).endsWith('-full') && !String(x.filename).includes('-montage-')) || null
export function priseRetenue(jobId) {
  const a = premiere(jobId)
  if (!a) return { etat: 'attente' }
  const c = store.lireControle(a.id)
  if (!c) {
    const fin = store.getJob(jobId)?.finished_at ?? store.getJob(jobId)?.finishedAt ?? 0
    return Date.now() - fin > 120_000 ? { etat: 'pret', assetId: a.id } : { etat: 'attente' }
  }
  if (!c.relance || c.relance === true) return { etat: 'pret', assetId: a.id }
  const r = store.getJob(c.relance)
  if (!r || ['blocked', 'failed', 'cancelled'].includes(r.status)) return { etat: 'pret', assetId: a.id }
  if (r.status !== 'done') return { etat: 'attente', relance: c.relance }
  const b = premiere(c.relance)
  const cb = b && store.lireControle(b.id)
  if (!b || !cb?.choix) return { etat: 'attente', relance: c.relance }
  return { etat: 'pret', assetId: cb.choix === 'gardée' ? b.id : a.id, relance: c.relance }
}
