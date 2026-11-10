/* Restore: a damaged photo or clip (old, blurry, scratched, faded) comes out clean and HD.
     photo: 1. instruction edit (Qwen-Image-Edit): scratches, dust, noise, faded areas,
               and color if requested, without touching faces or framing;
            2. SeedVR2 upscale (restoration model) rebuilding fine detail.
     clip:  SeedVR2 video, frame by frame with temporal consistency; with color, the 1st frame
            is first restored and colorized (Qwen-Image-Edit), then Wan 2.2 Fun VACE colorizes the
            whole clip from it, and SeedVR2 upscales it to HD.
   The source comes from the library, or an uploaded photo or clip (owner only on the demo). */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { spawnSync } from 'node:child_process'
import { enqueue, enqueueColorisationVideo, enqueueRestaurationHd, enqueueSeedvr } from './jobs.js'
import { SANS_PERSONNAGE } from './persona.js'

const suivis = new Map()

/** Edit instruction: what to repair, and everything that must not change. */
export function consigneRestauration({ nettoyer, couleur }) {
  const parts = []
  if (nettoyer) parts.push('Restore this old, damaged photograph: remove scratches, dust, spots, stains, tears, creases, film grain and noise, repair faded or missing areas, fix the exposure and the contrast, and make it crisp and clean.')
  if (couleur) parts.push('Colorize it with natural, realistic, true-to-life colors that fit the period and the place, with natural skin tones.')
  parts.push('Keep exactly the same people, faces, expressions, poses, clothing, objects, framing and composition; do not add or remove anything.')
  return parts.join(' ')
}

/** Stabilized clip without zoom (two-pass vid.stab): empty borders stay black, and a
 *  mask video (white = original image) tells VACE where to rebuild them. Both in input/; null on failure. */
function stabiliser(src, origine) {
  const base = path.basename(src).replace(/^crs_(stab|restv)_/, '').replace(/\.[^.]+$/, '')
  const nom = `crs_stab_${base}.mp4`, masque = `crs_stabmasque_${base}.mp4`
  const trf = path.join(CONFIG.comfyInput, `.${base}.trf`)
  const ff = args => spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args], { timeout: 300_000 }).status === 0
  const d = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0', src], { encoding: 'utf8', timeout: 120_000 }).stdout.trim().split(',')
  const [w, h, fps, n] = [d[0], d[1], d[2], d[3]]
  const transforme = `vidstabtransform=input=${trf}:smoothing=20:optzoom=0:crop=black:interpol=bicubic`
  const ok = ff(['-i', src, '-vf', `vidstabdetect=shakiness=6:accuracy=15:result=${trf}`, '-f', 'null', '-'])
    && ff(['-i', src, '-vf', transforme, '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'copy', path.join(CONFIG.comfyInput, nom)])
    && ff(['-f', 'lavfi', '-i', `color=white:s=${w}x${h}:r=${fps}`, '-frames:v', String(n), '-vf', transforme, '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', path.join(CONFIG.comfyInput, masque)])
  fs.rmSync(trf, { force: true })
  if (!ok) return null
  store.noterInput(nom, origine)
  store.noterInput(masque, origine)
  return { nom, masque }
}

/** Starts a restoration. `fichier` is a name in ComfyUI's input folder (uploaded or copied photo). */
export function lancerRestauration({ media, fichier, asset, nettoyer = true, couleur = false, hd = true, stabilite = false }) {
  const id = `rest-${Date.now().toString(36)}`
  // the original image, for the before / after comparator
  const avant = fichier ? `/api/uploads/${encodeURIComponent(fichier)}` : asset?.uri ?? null
  const base = { id, media, avant, nettoyer: !!nettoyer, couleur: !!couleur, hd: !!hd, edition: null, hdJob: null, debut: Date.now(), parentAssetId: asset?.id ?? null }
  if (media === 'video') {
    if (!asset && !fichier) throw new Error('choisis un clip')
    let masque = null
    // stabilization first: color and HD then work on a steady image
    if (stabilite) {
      const src = asset ? path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri)) : path.join(CONFIG.comfyInput, fichier)
      const st = stabiliser(src, asset ? 'genere' : (store.origineInput(fichier) ?? 'upload'))
      if (!st) throw new Error('stabilisation impossible')
      fichier = st.nom; masque = st.masque; asset = null
    }
    if (couleur) {
      // the clip in input/, then its restored and colorized 1st frame: it provides the clip colors
      let clip = fichier
      if (asset) {
        clip = `crs_restv_${path.basename(asset.filename ?? asset.uri)}`
        fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri)), path.join(CONFIG.comfyInput, clip))
        store.noterInput(clip)
      }
      const image = `crs_firstframe_${path.basename(clip).replace(/\.[^.]+$/, '')}.png`
      const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', path.join(CONFIG.comfyInput, clip), '-frames:v', '1', path.join(CONFIG.comfyInput, image)], { timeout: 60_000 })
      if (r.status !== 0) throw new Error('vidéo illisible')
      store.noterInput(image)
      const j = enqueue({ mode: 'photo', op: 'edit', register: 'sfw', personaId: SANS_PERSONNAGE, purpose: 'creative', sourceImage: image,
        composedPositive: consigneRestauration({ nettoyer: true, couleur: true }), userPrompt: 'restauration et colorisation (1re image du clip)', composedNegative: '', parentAssetId: asset?.id ?? null, origineUri: avant })
      suivis.set(id, { ...base, couleur: true, clip, masque, edition: j.id, couleurJob: null })
      return etatRestauration(id)
    }
    if (masque) {
      // stabilized without color: VACE rebuilds the empty borders, then HD
      const j = enqueueColorisationVideo({ source: fichier, masque, bordsSeuls: true, parentAssetId: base.parentAssetId, origineUri: avant })
      suivis.set(id, { ...base, bords: true, couleurJob: j.id })
      return etatRestauration(id)
    }
    const source = asset ? path.basename(asset.filename ?? asset.uri) : `input:${fichier}`
    const j = enqueueSeedvr({ source, parentAssetId: asset?.id ?? null, personaId: asset?.persona_id ?? SANS_PERSONNAGE, origineUri: avant })
    suivis.set(id, { ...base, hdJob: j.id })
    return etatRestauration(id)
  }
  if (!fichier) throw new Error('choisis une photo')
  if (!nettoyer && !couleur && !hd) throw new Error('choisis au moins une réparation')
  if (nettoyer || couleur) {
    const consigne = consigneRestauration({ nettoyer, couleur })
    const j = enqueue({ mode: 'photo', op: 'edit', register: 'sfw', personaId: SANS_PERSONNAGE, purpose: 'creative', sourceImage: fichier,
      composedPositive: consigne, userPrompt: couleur ? 'restauration et colorisation' : 'restauration', composedNegative: '', parentAssetId: asset?.id ?? null, origineUri: avant })
    suivis.set(id, { ...base, edition: j.id })
  } else {
    const j = enqueueRestaurationHd({ source: fichier, parentAssetId: asset?.id ?? null, personaId: SANS_PERSONNAGE, origineUri: avant })
    suivis.set(id, { ...base, hdJob: j.id })
  }
  return etatRestauration(id)
}

const premierAsset = id => (id && store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full'))) || null
const statut = id => (id ? store.getJob(id)?.status ?? 'absent' : null)

export function etatRestauration(id) {
  const r = suivis.get(id)
  if (!r) return null
  const fin = r.hd || r.media === 'video' ? premierAsset(r.hdJob) : premierAsset(r.edition)
  const etapes = [
    ...(r.edition ? [{ etape: r.couleur ? (r.media === 'video' ? 'couleur de la 1re image' : 'retouche et couleur') : 'retouche', job: r.edition, statut: statut(r.edition), uri: premierAsset(r.edition)?.uri ?? null }] : []),
    ...(r.media === 'video' && (r.couleur || r.bords) ? [{ etape: r.couleur ? 'couleur du clip' : 'bords reconstruits', job: r.couleurJob, statut: statut(r.couleurJob) ?? 'en attente', uri: premierAsset(r.couleurJob)?.uri ?? null }] : []),
    ...(r.hd || r.media === 'video' ? [{ etape: 'HD', job: r.hdJob, statut: statut(r.hdJob) ?? 'en attente', uri: premierAsset(r.hdJob)?.uri ?? null }] : []),
  ]
  const echec = etapes.some(e => e.statut === 'blocked' || e.statut === 'failed')
  return { id, media: r.media, avant: r.avant, etapes, fini: !!fin, uri: fin?.uri ?? null, assetId: fin?.id ?? null, echec }
}

// once the edit is done, the upscale starts from its result
setInterval(() => {
  for (const r of suivis.values()) {
    if (Date.now() - r.debut > 86400_000) { suivis.delete(r.id); continue }
    if (r.media === 'video' && (r.couleur || r.bords)) {
      try {
        // colorized 1st frame → clip colorization
        if (!r.couleurJob && statut(r.edition) === 'done') {
          const a = premierAsset(r.edition)
          if (!a) continue
          const ref = `crs_still_${path.basename(a.filename)}`
          fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, ref))
          store.noterInput(ref)
          r.couleurJob = enqueueColorisationVideo({ source: r.clip, reference: ref, masque: r.masque, parentAssetId: r.parentAssetId, origineUri: r.avant }).id
        }
        // colorized clip → HD
        if (r.couleurJob && !r.hdJob && statut(r.couleurJob) === 'done') {
          const a = premierAsset(r.couleurJob)
          if (a) r.hdJob = enqueueSeedvr({ source: path.basename(a.filename), parentAssetId: a.id, personaId: SANS_PERSONNAGE, origineUri: r.avant }).id
        }
      } catch (e) { console.warn(`[restauration ${r.id}] ${e.message || e}`); suivis.delete(r.id) }
      continue
    }
    if (!r.hd || r.hdJob || !r.edition || statut(r.edition) !== 'done') continue
    const a = premierAsset(r.edition)
    if (!a) continue
    try {
      const nom = `crs_still_${path.basename(a.filename)}`
      fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
      store.noterInput(nom)
      r.hdJob = enqueueRestaurationHd({ source: nom, parentAssetId: a.id, personaId: SANS_PERSONNAGE, origineUri: r.avant }).id
    } catch (e) { console.warn(`[restauration ${r.id}] ${e.message || e}`); r.hd = false }
  }
}, 3000).unref()
