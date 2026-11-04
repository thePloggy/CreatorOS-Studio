/* ============================================================
   Dépôt d'une photo par un visiteur de la démo publique.

   Seulement des photos SANS personne humaine : objets, produits, décors,
   animaux, matières. Une photo où l'on voit une personne, un visage, un corps,
   un enfant ou une main (photographiés ou dessinés) est refusée : aucun outil
   du studio ne peut alors retoucher une personne réelle.

   Chaque dépôt :
   - image seulement (png, jpeg, webp), 12 Mio au plus, 6 par heure et par visiteur ;
   - réencodé en PNG sans métadonnées (EXIF, position GPS) et ramené à 2048 px ;
   - lu par deux contrôles, sur le processeur, l'un après l'autre :
     GroundingDINO + YuNet (scripts/depot_sans_personne.py, Python de ComfyUI)
     et NudeNet en mode « personne » (scripts/filtre_images.py --personne) ;
     sans contrôle disponible, le dépôt est refusé ;
   - accepté : rangé dans input/ avec l'origine « depot-visiteur » ;
   - refusé : DÉPLACÉ dans le dossier de quarantaine du jour (chmod 700), jamais
     servi ni réutilisé.
   Tout est noté dans depots-visiteurs.json, que la surveillance horaire relit.
   ============================================================ */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { notifier } from './notif.js'
import { dossierQuarantaine, PYTHON_FILTRE } from './filtreImages.js'

const run = promisify(execFile)
const ICI = path.dirname(new URL(import.meta.url).pathname)
const SCRIPT_PERSONNE = path.join(ICI, '..', 'scripts', 'depot_sans_personne.py')
const SCRIPT_NUDENET = path.join(ICI, '..', 'scripts', 'filtre_images.py')
const PYTHON_COMFY = path.join(CONFIG.comfyDir, 'venv', 'bin', 'python')
const MODELES_CONTROLE = path.join(CONFIG.dataDir, 'modeles-controle')
const JOURNAL = path.join(CONFIG.dataDir, 'depots-visiteurs.json')
const ATTENTE = path.join(CONFIG.comfyInput, '.depots-attente')

export const TYPES_DEPOT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
const MAX_OCTETS = 12 * 1024 * 1024
const PAR_HEURE = 6

let sel = { jour: '', valeur: '' }
const empreinte = req => {
  const j = new Date().toISOString().slice(0, 10)
  if (sel.jour !== j) sel = { jour: j, valeur: crypto.randomBytes(16).toString('hex') }
  const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim()
  return crypto.createHash('sha256').update(`${sel.valeur}|${ip}`).digest('hex').slice(0, 16)
}
const recents = new Map()   // empreinte → horodatages de l'heure écoulée

function journaliser(e) {
  let l = []
  try { l = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) } catch {}
  l.unshift({ at: Date.now(), ...e })
  fs.writeFileSync(JOURNAL, JSON.stringify(l.slice(0, 500), null, 1))
}

// un contrôle à la fois : GroundingDINO occupe plusieurs cœurs une quinzaine de secondes
let file = Promise.resolve()
const enFile = f => { const p = file.then(f, f); file = p.catch(() => {}); return p }

async function controler(png) {
  const raisons = []
  try {
    const { stdout } = await run(PYTHON_COMFY, ['-I', SCRIPT_PERSONNE, png, MODELES_CONTROLE],
      { timeout: 120_000, env: { ...process.env, COMFY_DIR: CONFIG.comfyDir }, maxBuffer: 4 << 20 })
    const r = JSON.parse(stdout.trim().split('\n').pop())
    raisons.push(...(r.raisons ?? []))
    if (r.personne && !r.raisons?.length) raisons.push('personne')
  } catch (e) { raisons.push(`erreur-controle:${String(e.message || e).slice(0, 120)}`) }
  try {
    if (!fs.existsSync(PYTHON_FILTRE)) throw new Error('NudeNet absent')
    const { stdout } = await run(PYTHON_FILTRE, ['-I', SCRIPT_NUDENET, '--personne', png], { timeout: 60_000, maxBuffer: 4 << 20 })
    const r = JSON.parse(stdout.trim().split('\n').pop())
    if (r.erreur) raisons.push(`erreur-nudenet:${r.erreur}`)
    else if (r.positif) raisons.push(`nudenet:${r.classe}:${r.score}`)
  } catch (e) { raisons.push(`erreur-nudenet:${String(e.message || e).slice(0, 120)}`) }
  return raisons
}

/** POST /api/upload sans la clé du propriétaire. */
export async function depotVisiteur(req, reply) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]
  if (!TYPES_DEPOT[type]) { reply.code(415); return { error: 'sur la démo publique, seules les photos (png, jpeg, webp) se déposent' } }
  const buf = req.body
  if (!Buffer.isBuffer(buf) || !buf.length) { reply.code(400); return { error: 'corps vide' } }
  if (buf.length > MAX_OCTETS) { reply.code(413); return { error: 'photo > 12 Mio' } }
  const qui = empreinte(req)
  const maintenant = Date.now()
  const l = (recents.get(qui) ?? []).filter(t => maintenant - t < 3600_000)
  if (l.length >= PAR_HEURE) { reply.code(429); return { error: `${PAR_HEURE} photos par heure au plus sur la démo publique` } }
  l.push(maintenant); recents.set(qui, l)

  fs.mkdirSync(ATTENTE, { recursive: true, mode: 0o700 })
  const base = `dv_${maintenant.toString(36)}_${crypto.randomBytes(4).toString('hex')}`
  const brut = path.join(ATTENTE, `${base}_brut${TYPES_DEPOT[type]}`)
  const png = path.join(ATTENTE, `${base}.png`)
  fs.writeFileSync(brut, buf, { mode: 0o600 })
  try {
    // PNG sans métadonnées, 2048 px au plus : la position GPS d'un téléphone ne reste pas sur le serveur
    await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', brut, '-map_metadata', '-1', '-frames:v', '1',
      '-vf', "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", png], { timeout: 60_000 })
  } catch (e) {
    console.warn(`[dépôt] réencodage impossible ${path.basename(brut)} : ${String(e.stderr || e.message || e).slice(0, 200)}`)
    fs.rmSync(brut, { force: true })
    reply.code(415); return { error: 'image illisible' }
  }
  const raisons = await enFile(() => controler(png))
  if (raisons.length) {
    const dir = dossierQuarantaine()
    for (const f of [brut, png]) {
      try { fs.renameSync(f, path.join(dir, path.basename(f))); fs.chmodSync(path.join(dir, path.basename(f)), 0o600) } catch {}
    }
    journaliser({ empreinte: qui, statut: 'refusé', fichier: path.basename(brut), raisons, dossier: dir })
    console.warn(`[dépôt] refusé ${path.basename(brut)} — ${raisons.join(', ')}`)
    void notifier('Dépôt visiteur refusé', `${raisons.slice(0, 3).join(', ')}`, { tags: ['no_entry'], priorite: 3 })
    reply.code(422)
    return { error: raisons.some(r => r.startsWith('erreur'))
      ? 'contrôle de la photo indisponible : réessaie plus tard'
      : 'photo refusée : on y voit une personne. Sur la démo publique, seulement des objets, produits, décors ou animaux.' }
  }
  const nom = `crs_${base}.png`
  fs.renameSync(png, path.join(CONFIG.comfyInput, nom))
  fs.rmSync(brut, { force: true })
  store.noterInput(nom, 'depot-visiteur')
  const { width, height } = await dims(path.join(CONFIG.comfyInput, nom))
  journaliser({ empreinte: qui, statut: 'accepté', fichier: nom })
  console.log(`[dépôt] accepté ${nom} (${width}x${height})`)
  return { filename: nom, bytes: fs.statSync(path.join(CONFIG.comfyInput, nom)).size, width, height }
}

async function dims(f) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f])
    const [w, h] = stdout.trim().split(',').map(Number)
    return { width: w || null, height: h || null }
  } catch { return { width: null, height: null } }
}

