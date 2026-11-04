/* ============================================================
   Filtre de nudité des rendus.

   Chaque nouveau rendu (photo, ou clip lu à une image par seconde) passe par
   scripts/filtre_images.py (NudeNet, MIT, sur le CPU). Un rendu positif est
   mis en quarantaine : le fichier est DÉPLACÉ (jamais effacé) dans un dossier
   fermé (chmod 700) hors des médias servis, l'asset quitte la bibliothèque
   par la corbeille, une ligne est ajoutée au journal et une notification part.

   Le filtre ne voit que la nudité. Il ne remplace ni le filtre de prompts ni
   le verrou de dépôt des visiteurs : il attrape ce qui serait passé entre eux.

   Python : CREATOROS_FILTRE_PYTHON (venv où nudenet est installé). Sans lui,
   le filtre se dit indisponible une fois au démarrage et ne bloque rien.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { notifier } from './notif.js'

const run = promisify(execFile)
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'filtre_images.py')
export const PYTHON_FILTRE = process.env.CREATOROS_FILTRE_PYTHON || path.join(os.homedir(), 'venvs', 'filtre-images', 'bin', 'python')
const PARENT_QUARANTAINE = process.env.CREATOROS_QUARANTAINE || os.homedir()
const ETAT = path.join(CONFIG.dataDir, 'filtre-images.json')
const JOURNAL = path.join(CONFIG.dataDir, 'filtre-images-journal.json')
const RONDE_MS = 30_000
const LOT = 12

export const filtreDisponible = () => fs.existsSync(PYTHON_FILTRE)

const lireEtat = () => { try { return JSON.parse(fs.readFileSync(ETAT, 'utf8')) } catch { return null } }
const ecrireEtat = e => fs.writeFileSync(ETAT, JSON.stringify(e))

export function dossierQuarantaine() {
  const d = new Date()
  const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = path.join(PARENT_QUARANTAINE, `quarantaine-studio-${jour}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  return dir
}

function journaliser(entree) {
  let l = []
  try { l = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) } catch {}
  l.push(entree)
  fs.writeFileSync(JOURNAL, JSON.stringify(l.slice(-500), null, 1))
}

/** Met un asset (et sa version pleine taille) en quarantaine. */
function quarantaine(asset, verdict) {
  const dir = dossierQuarantaine()
  // tous les fichiers du même rendu : la version montée d'un prequel ou d'une suite contient le passage positif
  const ids = [...new Set([asset.id, `${asset.id}-full`, ...store.db.prepare('SELECT id FROM assets WHERE job_id = ?').all(asset.job_id).map(r => r.id)])]
  const deplaces = []
  for (const id of ids) {
    const row = store.trashAsset(id)
    if (!row?.filename) continue
    const nom = path.basename(row.filename)
    try {
      fs.renameSync(path.join(CONFIG.mediaDir, nom), path.join(dir, nom))
      fs.chmodSync(path.join(dir, nom), 0o600)
      deplaces.push(nom)
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`[filtre] déplacement ${nom} : ${e.message}`) }
  }
  const job = store.db.prepare('SELECT id, persona_id FROM jobs WHERE id = ?').get(asset.job_id)
  journaliser({ quand: Date.now(), asset: asset.id, job: asset.job_id, classe: verdict.classe, score: verdict.score, fichiers: deplaces, dossier: dir })
  console.warn(`[filtre] quarantaine ${asset.id} (job ${asset.job_id}) — ${verdict.classe} ${verdict.score}`)
  void notifier('Rendu mis en quarantaine', `#${job?.id ?? asset.job_id} — nudité détectée (${verdict.classe}, ${verdict.score})`, { tags: ['no_entry'], priorite: 4 })
}

let enCours = false
let relancer = false

/** Une ronde : analyse les assets créés depuis la dernière ronde. Sûr à appeler à tout moment. */
export async function filtrerNouveaux() {
  if (!filtreDisponible()) return
  if (enCours) { relancer = true; return }
  enCours = true
  try {
    do {
      relancer = false
      const etat = lireEtat() ?? { depuis: Date.now() }
      const lot = store.db.prepare(`SELECT id, job_id, created_at, filename, media_type FROM assets
        WHERE created_at > ? AND id NOT LIKE '%-full' AND filename IS NOT NULL ORDER BY created_at LIMIT ?`).all(etat.depuis, LOT)
      if (!lot.length) { ecrireEtat(etat); break }
      const fichiers = lot.map(a => path.join(CONFIG.mediaDir, path.basename(a.filename))).filter(f => fs.existsSync(f))
      if (fichiers.length) {
        const { stdout } = await run(PYTHON_FILTRE, ['-I', SCRIPT, ...fichiers], { timeout: 600_000, maxBuffer: 8 << 20 })
        const verdicts = new Map(stdout.trim().split('\n').filter(Boolean).map(l => { const v = JSON.parse(l); return [v.fichier, v] }))
        for (const a of lot) {
          const v = verdicts.get(path.join(CONFIG.mediaDir, path.basename(a.filename)))
          if (v?.positif) quarantaine(a, v)
        }
      }
      ecrireEtat({ depuis: lot[lot.length - 1].created_at })
      if (lot.length === LOT) relancer = true
    } while (relancer)
  } catch (e) {
    console.warn(`[filtre] ronde en échec — ${String(e.message || e).slice(0, 200)}`)
  } finally { enCours = false }
}

/** Démarre la ronde périodique ; la première ronde ne reprend pas l'historique. */
export function demarrerFiltre() {
  if (!filtreDisponible()) { console.warn(`[filtre] indisponible : ${PYTHON_FILTRE} absent (CREATOROS_FILTRE_PYTHON)`); return }
  if (!lireEtat()) ecrireEtat({ depuis: Date.now() })
  console.log('[filtre] nudité des rendus : actif')
  setInterval(() => { void filtrerNouveaux() }, RONDE_MS).unref()
}
