/* Pack publicitaire. Le produit vient d'une photo (bibliothèque ou dépôt) ou d'une description,
   dont Krea 2 fait un packshot. Puis : mise en scène et affiche avec accroche (Qwen-Image-Edit 2511),
   le personnage qui présente le produit dans la scène voulue (FLUX.2 Klein, le produit en
   référence), et un clip où il le présente à la caméra (LTX-2.5). */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue } from './jobs.js'
import { t0Hit } from './t0.js'

const FORMATS = { '9:16': [768, 1344], '1:1': [1024, 1024], '16:9': [1344, 768], '4:5': [896, 1120] }
const suivis = new Map()

const vers = asset => {
  const src = path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri))
  const nom = `crs_still_${path.basename(src)}`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}
const edition = (source, consigne, personaId) => enqueue({ mode: 'photo', register: 'sfw', personaId, purpose: 'creative', op: 'edit', sourceImage: source,
  composedPositive: consigne, userPrompt: consigne, composedNegative: '' }).id
const premierMedia = jobId => store.assetsOfJob(jobId).find(x => !String(x.id).endsWith('-full'))

export function lancerPack({ asset, fichier, description, produit, accroche, scene, format, personaId, admis }) {
  const desc = String(description ?? '').trim().slice(0, 200)
  const nom = String(produit ?? '').trim().slice(0, 60) || desc.slice(0, 60) || 'the product'
  const slogan = String(accroche ?? '').trim().slice(0, 50)
  const decor = String(scene ?? '').trim().slice(0, 200)
  if (t0Hit(`${nom} ${desc} ${slogan} ${decor}`)) throw new Error('terme bloqué dans le produit, la scène ou l’accroche')
  const [W, H] = FORMATS[format] ?? FORMATS['9:16']
  const p = { id: `pub-${Date.now().toString(36)}`, nom, slogan, decor, format: FORMATS[format] ? format : '9:16', W, H, personaId,
    source: null, genere: false, jobs: { produit: null, packshot: null, scene: null, affiche: null, personnage: null, clip: null } }
  if (asset) p.source = vers(asset)
  else if (fichier) {
    const f = path.basename(String(fichier))
    if (!admis(f) || !fs.existsSync(path.join(CONFIG.comfyInput, f))) throw new Error('photo du produit introuvable, ou dépôt refusé sur la démo publique')
    p.source = f
  } else if (desc) {
    // le produit seul, sans personne : le packshot généré sert directement de source
    p.genere = true
    p.jobs.produit = enqueue({ mode: 'photo', register: 'sfw', personaId: 'aucun', purpose: 'creative', photoEngine: 'krea', width: 1024, height: 1024, composedNegative: '',
      composedPositive: `Professional e-commerce product photo of ${desc}, the product alone, centered on a seamless pure white background, soft even studio light, gentle contact shadow, sharp detail, no person, no people, no hands, no text`,
      userPrompt: `produit : ${desc}` }).id
  } else throw new Error('choisis une photo du produit ou décris-le')
  suivis.set(p.id, p)
  if (p.source) suite(p)
  return etatPack(p.id)
}

/* La suite, dès que la source du produit est prête. */
function suite(p) {
  const s = p.source
  if (!p.genere) p.jobs.packshot = edition(s, `Turn this into a clean e-commerce packshot of ${p.nom} only: product centred on a seamless pure white background, soft studio light, gentle contact shadow, sharp detail, no person, no text.`, p.personaId)
  p.jobs.scene = edition(s, `Place ${p.nom} ${p.decor ? `in this setting: ${p.decor}` : 'in an elegant lifestyle scene on a marble counter with soft window light'}, shallow depth of field; keep the product exactly unchanged, no text, no person.`, p.personaId)
  p.jobs.affiche = edition(s, `Turn this into a clean modern advertising poster for ${p.nom}: the product unchanged as the hero in the centre, ${p.slogan ? `a short bold headline "${p.slogan}" at the top in a clean sans-serif, ` : ''}${p.decor ? `background inspired by ${p.decor}, ` : 'minimal harmonious background, '}generous margins, no other text.`, p.personaId)
  p.jobs.personnage = enqueue({ mode: 'photo', register: 'sfw', personaId: p.personaId, purpose: 'creative', photoEngine: 'klein', references: [s], composedNegative: '', width: p.W, height: p.H,
    composedPositive: `Advertising photo of the main character holding and presenting ${p.nom} from the reference image to the camera, ${p.decor || 'in a bright, clean lifestyle setting'}. The product stays exactly unchanged and clearly visible, natural smile, soft flattering light.`,
    userPrompt: `présente ${p.nom}${p.decor ? ` : ${p.decor}` : ''}` }).id
}

export function etatPack(id) {
  const p = suivis.get(id)
  if (!p) return null
  return { id, jobs: p.jobs, etats: Object.fromEntries(Object.entries(p.jobs).map(([k, j]) => [k, j ? store.getJob(j)?.status ?? null : null])) }
}

setInterval(() => {
  for (const p of suivis.values()) {
    if (!p.source && p.jobs.produit && store.getJob(p.jobs.produit)?.status === 'done') {
      const a = premierMedia(p.jobs.produit)
      if (a) { p.source = vers(a); p.jobs.packshot = p.jobs.produit; suite(p) }
    }
    if (p.jobs.clip || !p.jobs.personnage || store.getJob(p.jobs.personnage)?.status !== 'done') continue
    const a = premierMedia(p.jobs.personnage)
    if (!a) continue
    p.jobs.clip = enqueue({ mode: 'video', register: 'sfw', personaId: p.personaId, purpose: 'creative', videoEngine: 'ltx_hq', sourceImage: vers(a), withAudio: false,
      composedPositive: `The person smiles and presents ${p.nom} to the camera, turning it slightly so the light catches it, natural real-time pace. Slow push-in. single continuous shot`,
      userPrompt: 'clip pub', composedNegative: '', videoSeconds: 5, videoFps: 24, videoAspect: p.format === '4:5' ? '9:16' : p.format, parentAssetId: a.id }).id
  }
}, 4000).unref()
