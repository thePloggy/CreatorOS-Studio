/* Restaurer : une photo ou un clip abîmé (vieux, flou, rayé, délavé) ressort propre et en HD.
     photo : 1. retouche par instruction (Qwen-Image-Edit) — rayures, poussière, bruit, zones passées,
                et la couleur si on la demande — sans toucher aux visages ni au cadrage ;
             2. agrandissement SeedVR2 (modèle de restauration) qui reconstruit le détail fin.
     clip  : SeedVR2 vidéo, image par image avec cohérence temporelle.
   La source vient de la bibliothèque, ou d'un fichier envoyé (réservé au propriétaire sur la démo). */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue, enqueueRestaurationHd, enqueueSeedvr } from './jobs.js'
import { SANS_PERSONNAGE } from './persona.js'

const suivis = new Map()

/** Consigne de retouche : ce qu'on répare, et tout ce qui ne doit pas changer. */
export function consigneRestauration({ nettoyer, couleur }) {
  const parts = []
  if (nettoyer) parts.push('Restore this old, damaged photograph: remove scratches, dust, spots, stains, tears, creases, film grain and noise, repair faded or missing areas, fix the exposure and the contrast, and make it crisp and clean.')
  if (couleur) parts.push('Colorize it with natural, realistic, true-to-life colors that fit the period and the place, with natural skin tones.')
  parts.push('Keep exactly the same people, faces, expressions, poses, clothing, objects, framing and composition; do not add or remove anything.')
  return parts.join(' ')
}

/** Lance une restauration. `fichier` est un nom du dossier d'entrée de ComfyUI (photo déposée ou copiée). */
export function lancerRestauration({ media, fichier, asset, nettoyer = true, couleur = false, hd = true }) {
  const id = `rest-${Date.now().toString(36)}`
  const base = { id, media, nettoyer: !!nettoyer, couleur: !!couleur, hd: !!hd, edition: null, hdJob: null, debut: Date.now(), parentAssetId: asset?.id ?? null }
  if (media === 'video') {
    if (!asset) throw new Error('choisis un clip de la bibliothèque')
    const j = enqueueSeedvr({ source: path.basename(asset.filename ?? asset.uri), parentAssetId: asset.id, personaId: asset.persona_id ?? SANS_PERSONNAGE })
    suivis.set(id, { ...base, hdJob: j.id })
    return etatRestauration(id)
  }
  if (!fichier) throw new Error('choisis une photo')
  if (!nettoyer && !couleur && !hd) throw new Error('choisis au moins une réparation')
  if (nettoyer || couleur) {
    const consigne = consigneRestauration({ nettoyer, couleur })
    const j = enqueue({ mode: 'photo', op: 'edit', register: 'sfw', personaId: SANS_PERSONNAGE, purpose: 'creative', sourceImage: fichier,
      composedPositive: consigne, userPrompt: couleur ? 'restauration et colorisation' : 'restauration', composedNegative: '', parentAssetId: asset?.id ?? null })
    suivis.set(id, { ...base, edition: j.id })
  } else {
    const j = enqueueRestaurationHd({ source: fichier, parentAssetId: asset?.id ?? null, personaId: SANS_PERSONNAGE })
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
    ...(r.edition ? [{ etape: r.couleur ? 'retouche et couleur' : 'retouche', job: r.edition, statut: statut(r.edition), uri: premierAsset(r.edition)?.uri ?? null }] : []),
    ...(r.hd || r.media === 'video' ? [{ etape: 'HD', job: r.hdJob, statut: statut(r.hdJob) ?? 'en attente', uri: premierAsset(r.hdJob)?.uri ?? null }] : []),
  ]
  const echec = etapes.some(e => e.statut === 'blocked' || e.statut === 'failed')
  return { id, media: r.media, etapes, fini: !!fin, uri: fin?.uri ?? null, assetId: fin?.id ?? null, echec }
}

// la retouche finie, l'agrandissement repart de son résultat
setInterval(() => {
  for (const r of suivis.values()) {
    if (Date.now() - r.debut > 86400_000) { suivis.delete(r.id); continue }
    if (!r.hd || r.hdJob || !r.edition || statut(r.edition) !== 'done') continue
    const a = premierAsset(r.edition)
    if (!a) continue
    try {
      const nom = `crs_still_${path.basename(a.filename)}`
      fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
      store.noterInput(nom)
      r.hdJob = enqueueRestaurationHd({ source: nom, parentAssetId: a.id, personaId: SANS_PERSONNAGE }).id
    } catch (e) { console.warn(`[restauration ${r.id}] ${e.message || e}`); r.hd = false }
  }
}, 3000).unref()
