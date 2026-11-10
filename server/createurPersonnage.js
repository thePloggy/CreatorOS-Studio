/* Create a character from scratch: traits (adult, 21+) produce 4 portraits; the chosen one
   becomes the profile photo of a new character, then the studio renders a reference sheet
   and 12 varied images on FLUX.2 Klein (face held by the profile photo) and, if requested,
   trains its Klein LoRA on them. Owner only. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue, enqueueEntrainement } from './jobs.js'
import { activer, creer as creerPersona, enregistrer as enregistrerPersona, persona as personaActif, SANS_PERSONNAGE } from './persona.js'
import { t0Hit } from './t0.js'

const nettoie = (v, n = 80) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n)

function lireTraits(t = {}) {
  const age = Math.round(Number(t.age))
  if (!Number.isFinite(age) || age < 21 || age > 80) throw new Error('âge : un adulte de 21 à 80 ans')
  const genre = ['woman', 'man'].includes(t.genre) ? t.genre : 'person'
  const x = { age, genre, origine: nettoie(t.origine, 40), cheveux: nettoie(t.cheveux, 50), yeux: nettoie(t.yeux, 30), style: nettoie(t.style, 80), signes: nettoie(t.signes, 120) }
  if (t0Hit(Object.values(x).join(' '))) throw new Error('un trait contient un terme bloqué')
  return x
}
const description = x => [`a ${x.age}-year-old adult ${x.genre}`, x.origine, x.cheveux && `${x.cheveux} hair`, x.yeux && `${x.yeux} eyes`, x.signes].filter(Boolean).join(', ')

export function propositions(traits) {
  const x = lireTraits(traits)
  const texte = `Photorealistic head-and-shoulders studio portrait of ${description(x)}, wearing ${x.style || 'simple casual clothes'}, neutral light grey background, soft even light, sharp focus on the face, natural skin texture, looking at the camera`
  return Array.from({ length: 4 }, () => enqueue({ mode: 'photo', register: 'sfw', personaId: SANS_PERSONNAGE, purpose: 'creative', photoEngine: 'krea',
    composedPositive: texte, userPrompt: texte, composedNegative: '', width: 1024, height: 1024 }).id)
}

const SCENES = [
  'full body standing in a city street, casual outfit, daylight', 'close-up portrait, smiling, golden hour light', 'sitting at a café table, warm window light',
  'profile view outdoors, overcast light', 'three-quarter view, studio light, plain backdrop', 'walking on a beach at sunset, full body',
  'laughing indoors, warm lamp light', 'looking over the shoulder in a park', 'black and white portrait, dramatic side light',
  'wearing a coat in the rain at night, neon reflections', 'working at a desk with a laptop, soft daylight', 'full body in sportswear in a park, morning light',
]
/* In-progress creations are persisted to disk so a service restart neither loses their
   progress nor prevents training from starting once the images are done. */
const FICHIER_SUIVIS = path.join(CONFIG.dataDir, 'creations-personnages.json')
const suivis = new Map()
try {
  for (const c of JSON.parse(fs.readFileSync(FICHIER_SUIVIS, 'utf8')))
    if (c?.id && Date.now() - (c.debut ?? 0) < 7 * 86400_000) suivis.set(c.id, c)
} catch { /* no saved tracking */ }
const garder = () => { try { fs.writeFileSync(FICHIER_SUIVIS, JSON.stringify([...suivis.values()])) } catch (e) { console.warn(`[création] suivi non enregistré : ${e.message || e}`) } }

export function creerPersonnage({ assetId, nom, traits, entrainer, moteurs }) {
  // engines to train: the checked list, or the legacy boolean (Klein only)
  const aEntrainer = Array.isArray(moteurs) ? moteurs.map(String).filter(m => m === 'klein' || m === 'krea').filter((m, i, l) => l.indexOf(m) === i) : entrainer ? ['klein'] : []
  const x = lireTraits(traits)
  const n = nettoie(nom, 40)
  if (n.length < 2 || t0Hit(n)) throw new Error('donne un nom au personnage')
  const a = store.getAsset(String(assetId ?? ''))
  if (!a || a.media_type !== 'photo') throw new Error('choisis l’un des portraits proposés')
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  // the studio's active character is unchanged: the new one is picked from the menu
  const avant = personaActif().id
  const p = creerPersona({ name: n })
  if (avant) activer(avant)
  enregistrerPersona({ preamble: description(x), description: `${n} : ${description(x)}, ${x.style}`, credit: { auteur: 'CreatorOS Studio', url: '', licence: 'personnage fictif créé dans le studio, libre' } }, p.id)
  const dossier = path.join(CONFIG.mediaDir, '.persona', p.id.replace(/[^a-z0-9_]/g, ''))
  fs.mkdirSync(dossier, { recursive: true })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=512:512', '-q:v', '3', path.join(dossier, 'avatar.jpg')])
  const planche = enqueue({ mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: 'klein', composedNegative: '', width: 1344, height: 768,
    composedPositive: `Character reference sheet of the same person: front view, three-quarter view, profile and back view, full body, same outfit (${x.style || 'casual clothes'}), plain light grey background, even studio light`,
    userPrompt: 'planche de référence' }).id
  const images = SCENES.map(s => enqueue({ mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: 'klein', composedNegative: '', width: 832, height: 1216,
    composedPositive: `${s}, photorealistic`, userPrompt: s }).id)
  const id = `perso-${Date.now().toString(36)}`
  suivis.set(id, { id, personaId: p.id, nom: n, planche, images, entrainer: aEntrainer.length > 0, moteurs: aEntrainer, entrainements: [], debut: Date.now(), declencheur: `${n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}x` })
  garder()
  return etatCreation(id)
}

export function etatCreation(id) {
  const c = suivis.get(id)
  if (!c) return null
  const fait = c.images.filter(j => store.getJob(j)?.status === 'done').length
  return { id, personaId: c.personaId, nom: c.nom, planche: store.getJob(c.planche)?.status ?? null, images: `${fait}/${c.images.length}`, entrainements: (c.entrainements ?? (c.entrainement ? [{ moteur: 'klein', job: c.entrainement }] : [])).map(e => ({ ...e, statut: store.getJob(e.job)?.status ?? null })),
    entrainementEtat: (() => { const l = (c.entrainements ?? []).map(e => store.getJob(e.job)?.status); return !l.length ? null : l.every(x => x === 'done') ? 'done' : l.some(x => x === 'rendering') ? 'rendering' : l.some(x => x === 'queued') ? 'queued' : l.at(-1) ?? null })() }
}

setInterval(() => {
  for (const c of suivis.values()) {
    if (!c.entrainer || c.entrainement || c.entrainements?.length) continue
    const etats = c.images.map(j => store.getJob(j)?.status)
    if (etats.some(s => s !== 'done' && s !== 'blocked')) continue
    const fichiers = c.images.flatMap(j => store.assetsOfJob(j).filter(a => !String(a.id).endsWith('-full')).map(a => path.join(CONFIG.mediaDir, path.basename(a.filename))))
    try { c.entrainements = (c.moteurs?.length ? c.moteurs : ['klein']).map(moteur => ({ moteur, job: enqueueEntrainement({ personaId: c.personaId, images: fichiers, declencheur: c.declencheur, pas: 1200, moteur }).id })) }
    catch (e) { c.entrainer = false; console.warn(`[création ${c.id}] entraînement : ${e.message || e}`) }
    garder()
  }
}, 5000).unref()
