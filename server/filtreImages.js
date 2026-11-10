/* ============================================================
   Nudity filter for renders.

   Each new render (photo, or clip read at one frame per second) goes
   through scripts/filtre_images.py (NudeNet, MIT, on the CPU). A positive
   render is quarantined: the file is MOVED (never deleted) to a closed
   folder (chmod 700) outside served media, the asset leaves the library
   via the trash, a log line is added and a notification is sent.

   The filter only detects nudity. It complements the prompt filter and
   the visitor upload lock.

   Python: CREATOROS_FILTRE_PYTHON (venv with nudenet installed). Without
   it, the filter reports unavailable once at startup and blocks nothing.
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

/** Quarantines an asset (and its full-size version). */
function quarantaine(asset, verdict) {
  const dir = dossierQuarantaine()
  // all files of the same render: the edited version of a prequel or sequel contains the positive part
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

/** One pass: scans assets created since the last pass. Safe to call at any time. */
export async function filtrerNouveaux() {
  if (!filtreDisponible() || CONFIG.contenuAdulte) return
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

/** Starts the periodic pass; the first pass does not scan history. */
export function demarrerFiltre() {
  if (!filtreDisponible()) { console.warn(`[filtre] indisponible : ${PYTHON_FILTRE} absent (CREATOROS_FILTRE_PYTHON)`); return }
  if (!lireEtat()) ecrireEtat({ depuis: Date.now() })
  console.log('[filtre] nudité des rendus : actif')
  setInterval(() => { void filtrerNouveaux() }, RONDE_MS).unref()
}
