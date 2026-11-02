/* Pack publicitaire : une photo produit donne en un clic un packshot, une mise en scène, une
   affiche avec accroche, le personnage qui présente le produit (FLUX.2 Klein, références) et un
   clip produit de 4 s tiré du packshot (LTX-2.5). Retouches Qwen-Image-Edit 2511. */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue } from './jobs.js'
import { t0Hit } from './t0.js'

const suivis = new Map()
const edition = (source, consigne, personaId) => enqueue({ mode: 'photo', register: 'sfw', personaId, purpose: 'creative', op: 'edit', sourceImage: source,
  composedPositive: consigne, userPrompt: consigne, composedNegative: '' }).id

export function lancerPack({ asset, produit, accroche, personaId }) {
  const nom = String(produit ?? '').trim().slice(0, 60) || 'the product'
  const slogan = String(accroche ?? '').trim().slice(0, 50)
  if (t0Hit(`${nom} ${slogan}`)) throw new Error('terme bloqué dans le produit ou l’accroche')
  const src = path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri))
  const entree = `crs_still_${path.basename(src)}`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, entree))
  store.noterInput(entree)
  const jobs = {
    packshot: edition(entree, `Turn this into a clean e-commerce packshot of ${nom} only: product centred on a seamless pure white background, soft even studio light, gentle contact shadow, sharp detail, no person, no text.`, personaId),
    scene: edition(entree, `Place ${nom} in an elegant lifestyle scene on a marble counter with soft window light and shallow depth of field; keep the product exactly unchanged, no text, no person.`, personaId),
    affiche: edition(entree, `Turn this into a clean modern advertising poster for ${nom}: the product unchanged as the hero in the centre, ${slogan ? `a short bold headline "${slogan}" at the top in a clean sans-serif, ` : ''}minimal harmonious background, generous margins, no other text.`, personaId),
    personnage: enqueue({ mode: 'photo', register: 'sfw', personaId, purpose: 'creative', photoEngine: 'klein', references: [entree], composedNegative: '', width: 832, height: 1216,
      composedPositive: `Lifestyle advertising photo of the main character holding and presenting ${nom} from the reference image; the product stays exactly unchanged and clearly visible. Soft daylight, clean background.`,
      userPrompt: `présente ${nom}` }).id,
    clip: null,
  }
  const id = `pub-${Date.now().toString(36)}`
  suivis.set(id, { id, jobs, personaId, nom })
  return etatPack(id)
}

export function etatPack(id) {
  const p = suivis.get(id)
  if (!p) return null
  return { id, jobs: p.jobs, etats: Object.fromEntries(Object.entries(p.jobs).map(([k, j]) => [k, j ? store.getJob(j)?.status ?? null : null])) }
}

setInterval(() => {
  for (const p of suivis.values()) {
    if (p.jobs.clip || store.getJob(p.jobs.packshot)?.status !== 'done') continue
    const a = store.assetsOfJob(p.jobs.packshot).find(x => !String(x.id).endsWith('-full'))
    if (!a) continue
    const nom = `crs_still_${path.basename(a.filename)}`
    fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
    store.noterInput(nom)
    p.jobs.clip = enqueue({ mode: 'video', register: 'sfw', personaId: p.personaId, purpose: 'creative', videoEngine: 'ltx_hq', sourceImage: nom, withAudio: false,
      composedPositive: `A slow cinematic orbit around ${p.nom} on a clean white studio set, soft light reflections glide across it. single continuous shot`, userPrompt: 'clip produit', composedNegative: '',
      videoSeconds: 4, videoFps: 24, videoAspect: '1:1', parentAssetId: a.id }).id
  }
}, 4000).unref()
