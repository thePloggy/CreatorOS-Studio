/* ============================================================
   LoRA installation into ComfyUI's folder: ONE path for every LoRA the
   studio writes there (trained with ai-toolkit, uploaded by the owner, any
   future import).

   Why a dedicated module: CreatorOS and ComfyUI do not always run as the
   same Unix user (a ComfyUI service account, a container with another
   UID). A plain copy keeps the source's mode: ai-toolkit writes 0600, a
   service started with umask 077 writes 0600 too. CreatorOS then still
   reads the file (it owns it), reports the LoRA as ready, and the next
   render fails in ComfyUI with a FileNotFoundError on a file that exists.

   The sequence is transactional, in the destination folder:

     copy / stream into <name>.part-<pid>-<random>
       -> explicit mode (CREATOROS_LORA_MODE, 0644 by default)
       -> optional group (CREATOROS_LORA_GROUP)
       -> structural safetensors validation (header, every tensor range)
       -> caller's extra check (expected architecture...)
       -> readability check for the folder's owner
       -> atomic rename to the final name

   A failure removes the temporary file and leaves an existing final file
   untouched; the caller attaches the LoRA to a character only after this
   returns. No user name is hard-coded: the folder's owner stands for the
   ComfyUI process.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG } from './config.js'

export const MODE_LORA_DEFAUT = 0o644

/** Explicit file mode for installed LoRAs: CREATOROS_LORA_MODE (octal, e.g. 0640),
 *  otherwise 0644. An unreadable value falls back to the default, once logged. */
let modeSignale = false
export function modeLora() {
  const brut = String(CONFIG.lorasMode ?? '').trim()
  if (!brut) return MODE_LORA_DEFAUT
  const m = /^0?o?([0-7]{3,4})$/i.exec(brut)
  if (m) return parseInt(m[1], 8) & 0o7777
  if (!modeSignale) { modeSignale = true; console.warn(`[loras] CREATOROS_LORA_MODE=${brut} illisible (attendu : octal, ex. 0644) — 0644 utilisé`) }
  return MODE_LORA_DEFAUT
}

/** Group id for installed LoRAs: CREATOROS_LORA_GROUP (name or numeric gid), or
 *  null when unset. A name is resolved through /etc/group; unknown -> null, logged once. */
let groupeSignale = false
export function groupeLora() {
  const brut = String(CONFIG.lorasGroup ?? '').trim()
  if (!brut) return null
  if (/^\d+$/.test(brut)) return Number(brut)
  try {
    for (const ligne of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
      const c = ligne.split(':')
      if (c[0] === brut && /^\d+$/.test(c[2] ?? '')) return Number(c[2])
    }
  } catch { /* no /etc/group: name cannot be resolved */ }
  if (!groupeSignale) { groupeSignale = true; console.warn(`[loras] CREATOROS_LORA_GROUP=${brut} : groupe inconnu — ignoré`) }
  return null
}

/* ---------- structural validation ---------- */

/* Bytes per element, by safetensors dtype. Unknown dtypes skip the size check. */
const TAILLE_DTYPE = { BOOL: 1, U8: 1, I8: 1, F8_E5M2: 1, F8_E4M3: 1, I16: 2, U16: 2, F16: 2, BF16: 2, I32: 4, U32: 4, F32: 4, I64: 8, U64: 8, F64: 8 }
const TETE_MAX = 64 * 1024 * 1024

/** Validates a safetensors file the way `safetensors.safe_open` does, without
 *  loading it: 8-byte header length, JSON header, and for every tensor a dtype,
 *  a shape, and a byte range that matches the shape and sits inside the file.
 *  Ranges must be contiguous and cover the whole data section. Throws with a
 *  plain-language reason; returns { octets, tenseurs, tete } otherwise. */
export function validerSafetensors(fichier) {
  const st = fs.statSync(fichier)
  if (!st.isFile()) throw new Error('pas un fichier')
  if (st.size < 16) throw new Error('fichier trop court pour être un .safetensors')
  const fd = fs.openSync(fichier, 'r')
  let tete
  try {
    const len = Buffer.alloc(8)
    if (fs.readSync(fd, len, 0, 8, 0) !== 8) throw new Error('en-tête tronqué')
    const n = Number(len.readBigUInt64LE(0))
    if (!(n > 0)) throw new Error('longueur d’en-tête nulle')
    if (n > TETE_MAX) throw new Error('en-tête de plus de 64 Mo : pas un .safetensors')
    if (n > st.size - 8) throw new Error(`en-tête tronqué (${n} octets annoncés, ${st.size - 8} présents)`)
    const brut = Buffer.alloc(n)
    if (fs.readSync(fd, brut, 0, n, 8) !== n) throw new Error('en-tête tronqué')
    if (brut[0] !== 0x7b) throw new Error('en-tête JSON absent')
    try { tete = JSON.parse(brut.toString('utf8')) } catch (e) { throw new Error(`en-tête JSON illisible : ${String(e.message).slice(0, 80)}`) }
    if (!tete || typeof tete !== 'object' || Array.isArray(tete)) throw new Error('en-tête JSON : objet attendu')
    const donnees = st.size - 8 - n
    const plages = []
    for (const [cle, t] of Object.entries(tete)) {
      if (cle === '__metadata__') continue
      if (!t || typeof t !== 'object') throw new Error(`tenseur « ${cle} » : entrée invalide`)
      if (typeof t.dtype !== 'string') throw new Error(`tenseur « ${cle} » : dtype absent`)
      if (!Array.isArray(t.shape) || t.shape.some(d => !Number.isInteger(d) || d < 0)) throw new Error(`tenseur « ${cle} » : shape invalide`)
      const o = t.data_offsets
      if (!Array.isArray(o) || o.length !== 2 || o.some(x => !Number.isInteger(x) || x < 0) || o[0] > o[1]) throw new Error(`tenseur « ${cle} » : data_offsets invalides`)
      if (o[1] > donnees) throw new Error(`tenseur « ${cle} » dépasse la fin du fichier (${o[1]} > ${donnees}) : fichier incomplet`)
      const par = TAILLE_DTYPE[t.dtype]
      if (par !== undefined) {
        const attendu = t.shape.reduce((a, d) => a * d, 1) * par
        if (attendu !== o[1] - o[0]) throw new Error(`tenseur « ${cle} » : ${o[1] - o[0]} octets pour une shape de ${attendu}`)
      }
      plages.push([o[0], o[1], cle])
    }
    plages.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let pos = 0
    for (const [debut, fin, cle] of plages) {
      if (debut !== pos) throw new Error(`tenseur « ${cle} » : plage non contiguë (${debut} au lieu de ${pos})`)
      pos = fin
    }
    if (pos !== donnees) throw new Error(`données incomplètes (${pos} octets décrits, ${donnees} présents)`)
    return { octets: st.size, tenseurs: plages.length, tete }
  } finally { fs.closeSync(fd) }
}

/* ---------- readability for the ComfyUI process ---------- */

const octal = m => (m & 0o777).toString(8).padStart(4, '0')

/** Can the owner of the LoRA folder (the ComfyUI process, by proxy) read this
 *  file? Pure function on stat-like objects so it can be tested without root.
 *  Returns { ok, raison } where `raison` is a sentence for the operator. */
export function lisibleParDossier(fichier, dossier) {
  const mode = fichier.mode & 0o777
  if (mode & 0o004) return { ok: true, raison: null }
  if (dossier.uid === 0) return { ok: true, raison: null }   // root reads everything
  if (fichier.uid === dossier.uid) return { ok: true, raison: null }
  if ((mode & 0o040) && fichier.gid === dossier.gid) return { ok: true, raison: null }
  return { ok: false, raison: `mode ${octal(mode)}, propriétaire uid ${fichier.uid}, alors que le dossier des LoRA appartient à l’uid ${dossier.uid} : ComfyUI ne peut pas le lire` }
}

/** State of one installed LoRA (by file name) for the diagnostic and the repair:
 *  { nom, chemin, existe, mode, uid, gid, lisible, raison, valide, erreur }. */
export function etatLora(nom) {
  const chemin = path.join(CONFIG.lorasDir, nom)
  const e = { nom, chemin, existe: false, mode: null, uid: null, gid: null, lisible: false, raison: null, valide: false, erreur: null }
  let st
  try { st = fs.statSync(chemin) } catch { e.raison = 'fichier absent'; return e }
  e.existe = true; e.mode = octal(st.mode); e.uid = st.uid; e.gid = st.gid
  let dossier
  try { dossier = fs.statSync(CONFIG.lorasDir) } catch { dossier = st }
  const l = lisibleParDossier(st, dossier)
  e.lisible = l.ok; e.raison = l.raison
  try { validerSafetensors(chemin); e.valide = true } catch (x) { e.erreur = String(x.message || x) }
  return e
}

/** Normalizes the mode (and group, when configured) of ONE installed LoRA.
 *  Only a file this process owns can be changed; returns { ok, erreur }. */
export function normaliserLora(nom) {
  const chemin = path.join(CONFIG.lorasDir, nom)
  try {
    fs.chmodSync(chemin, modeLora())
    const gid = groupeLora()
    if (gid !== null) fs.chownSync(chemin, -1, gid)
    return { ok: true, erreur: null }
  } catch (e) {
    return { ok: false, erreur: e.code === 'EPERM' ? `pas le propriétaire du fichier : « sudo chmod ${octal(modeLora())} ${chemin} »` : String(e.message || e) }
  }
}

/* ---------- installation ---------- */

/** Temporary name next to the final file: same filesystem, so the rename is atomic. */
export const cheminTemporaire = cible => `${cible}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`

function erreurInstallation(e, tmp, cible) {
  let detail = ''
  try { const st = fs.statSync(tmp); detail = ` (${tmp} : mode ${octal(st.mode)}, uid ${st.uid}, gid ${st.gid})` } catch { /* no temporary file */ }
  const err = new Error(`installation de ${path.basename(cible)} impossible : ${String(e.message || e)}${detail}`)
  err.code = e.code; err.statusCode = e.statusCode
  return err
}

/** Finishes an installation from a temporary file ALREADY in the LoRA folder
 *  (an upload streams there directly): mode, group, validation, the caller's
 *  `verifier(tmp)`, readability, atomic rename. The temporary file is removed
 *  on failure. Returns { nom, chemin, octets, tenseurs, mode }. */
export function finaliserLora(tmp, nom, { remplacer = false, verifier = null } = {}) {
  const cible = path.join(CONFIG.lorasDir, nom)
  try {
    if (!remplacer && fs.existsSync(cible)) { const e = new Error(`« ${nom} » existe déjà`); e.statusCode = 409; e.code = 'EEXIST'; throw e }
    fs.chmodSync(tmp, modeLora())
    const gid = groupeLora()
    if (gid !== null) fs.chownSync(tmp, -1, gid)
    const v = validerSafetensors(tmp)
    if (verifier) verifier(tmp, v)
    let dossier = null
    try { dossier = fs.statSync(CONFIG.lorasDir) } catch { /* unreadable folder: checked by the rename */ }
    if (dossier) {
      const l = lisibleParDossier(fs.statSync(tmp), dossier)
      if (!l.ok) throw new Error(`${l.raison} — régler CREATOROS_LORA_MODE (0644) ou CREATOROS_LORA_GROUP`)
    }
    fs.renameSync(tmp, cible)
    return { nom, chemin: cible, octets: v.octets, tenseurs: v.tenseurs, mode: octal(modeLora()) }
  } catch (e) {
    const err = erreurInstallation(e, tmp, cible)
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Installs `source` (a file anywhere, e.g. ai-toolkit's output) as `nom` in the
 *  LoRA folder. See finaliserLora for the options and the result. */
export function installerLora(source, nom, options = {}) {
  if (typeof nom !== 'string' || !nom.endsWith('.safetensors') || path.basename(nom) !== nom) throw new Error(`nom de LoRA invalide : ${nom}`)
  fs.mkdirSync(CONFIG.lorasDir, { recursive: true })
  const cible = path.join(CONFIG.lorasDir, nom)
  const tmp = cheminTemporaire(cible)
  try { fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL) } catch (e) { throw erreurInstallation(e, tmp, cible) }
  return finaliserLora(tmp, nom, options)
}

/** LoRAs referenced by the characters, with their state: what the diagnostic
 *  reports and what the repair is allowed to touch (never third-party files). */
export function etatLorasPersonas(listePersonas) {
  const vus = new Map()
  for (const p of listePersonas) {
    for (const l of [...(p.loras ?? []), ...(p.lorasKlein ?? []), ...(p.lorasFlux3 ?? []), ...(p.videoLoras ?? [])]) {
      if (typeof l?.name !== 'string' || !l.name || l.name.includes('..')) continue
      const e = vus.get(l.name) ?? { ...etatLora(l.name), personnages: [] }
      if (!e.personnages.includes(p.name || p.id)) e.personnages.push(p.name || p.id)
      vus.set(l.name, e)
    }
  }
  return [...vus.values()]
}

/** Repairs the characters' LoRAs that ComfyUI cannot read: mode (and group) only,
 *  only files this process can change. Returns what was done and what remains. */
export function reparerLorasPersonas(listePersonas, { noms = null } = {}) {
  const repares = [], restants = []
  for (const e of etatLorasPersonas(listePersonas)) {
    if (!e.existe || !e.valide) { restants.push({ nom: e.nom, erreur: e.raison ?? e.erreur }); continue }
    if (e.lisible && !(noms && noms.includes(e.nom))) continue
    if (noms && !noms.includes(e.nom)) continue
    const r = normaliserLora(e.nom)
    if (r.ok) repares.push({ nom: e.nom, mode: etatLora(e.nom).mode }); else restants.push({ nom: e.nom, erreur: r.erreur })
  }
  return { repares, restants }
}
