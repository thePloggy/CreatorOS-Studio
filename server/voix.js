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
