/* Voix off : Kokoro-82M (Apache-2.0) dans un environnement Python à part. Le fichier rejoint
   les musiques du montage : il sert au montage, à l'avatar parlant et au doublage. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import { MUSIQUES_DIR } from './montage.js'

const lancer = promisify(execFile)
export const VOIX = [
  { id: 'af_heart', nom: 'Heart (US, femme)' }, { id: 'af_bella', nom: 'Bella (US, femme)' }, { id: 'af_nicole', nom: 'Nicole (US, femme, douce)' },
  { id: 'am_michael', nom: 'Michael (US, homme)' }, { id: 'am_fenrir', nom: 'Fenrir (US, homme)' },
  { id: 'bf_emma', nom: 'Emma (UK, femme)' }, { id: 'bm_george', nom: 'George (UK, homme)' },
]
const python = () => process.env.CREATOROS_VOIX_PYTHON || path.join(CONFIG.dataDir, 'voix-venv', 'bin', 'python')
export const voixDisponible = () => fs.existsSync(python())

export async function synthetiser({ texte, voix, vitesse }) {
  const t = String(texte ?? '').trim().slice(0, 1200)
  if (!t) throw new Error('écris le texte à dire, en anglais')
  const v = VOIX.find(x => x.id === voix)?.id ?? VOIX[0].id
  if (!voixDisponible()) throw new Error('voix non installée sur ce studio (installeur : étape voix)')
  fs.mkdirSync(MUSIQUES_DIR, { recursive: true })
  const racine = t.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').slice(0, 30).replace(/_+$/, '') || 'voix'
  const nom = `voix_${racine}_${Date.now().toString(36).slice(-6)}.wav`
  await lancer(python(), [path.join(import.meta.dirname, '..', 'scripts', 'voix.py'), t, v, String(Math.min(1.4, Math.max(0.7, Number(vitesse) || 1))), path.join(MUSIQUES_DIR, nom)], { timeout: 180_000 })
  return { nom }
}

/* Voix clonée (Chatterbox, MIT) : réservée au propriétaire, sur un extrait de la bibliothèque audio
   dont il déclare avoir le droit (sa voix, ou l'accord de la personne). */
const pythonClone = () => process.env.CREATOROS_CLONE_PYTHON || path.join(CONFIG.dataDir, 'clone-venv', 'bin', 'python')
export const cloneDisponible = () => fs.existsSync(pythonClone())
export async function cloner({ texte, reference, accord }) {
  if (accord !== true) throw new Error('confirme que cette voix est la tienne ou que la personne a donné son accord')
  const t = String(texte ?? '').trim().slice(0, 800)
  if (!t) throw new Error('écris le texte à dire, en anglais')
  const ref = path.join(MUSIQUES_DIR, path.basename(String(reference ?? '')))
  if (!reference || !fs.existsSync(ref)) throw new Error('choisis l’extrait de voix dans la bibliothèque audio')
  if (!cloneDisponible()) throw new Error('clonage de voix non installé sur ce studio')
  const racine = t.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').slice(0, 26).replace(/_+$/, '') || 'voix'
  const nom = `voixclone_${racine}_${Date.now().toString(36).slice(-6)}.wav`
  await lancer(pythonClone(), [path.join(import.meta.dirname, '..', 'scripts', 'clone_voix.py'), t, ref, path.join(MUSIQUES_DIR, nom)], { timeout: 300_000 })
  return { nom }
}

/* Changeur de voix (Chatterbox VC) : la cible est une voix du studio (Kokoro, synthétique) ou un
   extrait dont le propriétaire déclare avoir le droit. Les mots et le rythme de la source restent. */
const CIBLES = path.join(CONFIG.dataDir, 'voix-cibles')
async function cibleStudio(id) {
  const f = path.join(CIBLES, `${id}.wav`)
  if (fs.existsSync(f)) return f
  const { nom } = await synthetiser({ texte: 'Hello, this is a short sample of my voice. I speak calmly and clearly, with a natural rhythm, so you can hear its timbre.', voix: id })
  fs.mkdirSync(CIBLES, { recursive: true })
  fs.renameSync(path.join(MUSIQUES_DIR, nom), f)
  return f
}
export async function changerVoix({ source, voix, reference, accord }) {
  if (!cloneDisponible()) throw new Error('changeur de voix non installé sur ce studio (Chatterbox)')
  if (!fs.existsSync(source)) throw new Error('enregistrement source introuvable')
  let cible
  if (reference) {
    if (accord !== true) throw new Error('confirme que cette voix est la tienne ou que la personne a donné son accord')
    cible = path.join(MUSIQUES_DIR, path.basename(String(reference)))
    if (!fs.existsSync(cible)) throw new Error('choisis l’extrait de voix dans la bibliothèque audio')
  } else {
    const v = VOIX.find(x => x.id === voix)
    if (!v) throw new Error('choisis la voix cible')
    cible = await cibleStudio(v.id)
  }
  fs.mkdirSync(MUSIQUES_DIR, { recursive: true })
  const racine = path.basename(source).replace(/\.[^.]+$/, '').normalize('NFD').replace(/[^\w]+/g, '_').slice(0, 24).replace(/_+$/, '') || 'voix'
  const nom = `voixchangee_${racine}_${Date.now().toString(36).slice(-6)}.wav`
  await lancer(pythonClone(), [path.join(import.meta.dirname, '..', 'scripts', 'changer_voix.py'), source, cible, path.join(MUSIQUES_DIR, nom)], { timeout: 600_000 })
  return { nom, chemin: path.join(MUSIQUES_DIR, nom) }
}

/** Échantillon d'écoute d'une voix du studio : phrase fixe, synthétisée une fois puis gardée. */
const ECHANTILLONS = path.join(CONFIG.dataDir, 'voix-echantillons')
const enCours = new Map()
export async function echantillon(voix) {
  const v = VOIX.find(x => x.id === voix)?.id
  if (!v) throw new Error('voix inconnue')
  const f = path.join(ECHANTILLONS, `${v}.wav`)
  if (fs.existsSync(f)) return f
  if (!voixDisponible()) throw new Error('voix non installée sur ce studio')
  if (!enCours.has(v)) {
    fs.mkdirSync(ECHANTILLONS, { recursive: true })
    const tmp = `${f}.${process.pid}.tmp.wav`
    enCours.set(v, lancer(python(), [path.join(import.meta.dirname, '..', 'scripts', 'voix.py'), "Hi, this is my voice. Here's how your reel will sound.", v, '1', tmp], { timeout: 180_000 })
      .then(() => fs.renameSync(tmp, f)).finally(() => enCours.delete(v)))
  }
  await enCours.get(v)
  return f
}
