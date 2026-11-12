/* ============================================================
   Small machines: same recipe, lighter weights.

   Recipes target a 24 GB+ card. On a smaller card, just before sending to
   ComfyUI, each heavy model loader is swapped for a lighter variant of the
   same model: FLUX.2 Klein 4B instead of 9B, Wan 2.2 GGUF Q4 instead of fp8.
   The graph is otherwise unchanged: same nodes, settings and output.

   The profile comes from CREATOROS_VRAM (24, 16, 12 or 8), or is derived
   from the card ComfyUI reports (/system_stats). A variant is used only if
   its file is installed; otherwise a lighter one, otherwise the original
   model (ComfyUI then offloads in chunks, more slowly).

   Only verified variants are in the manifest.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONFIG } from './config.js'
import { budgetMac, estApple, sansCuda } from './carteGraphique.js'

/** Profiles, largest to smallest (target GB of VRAM). */
export const PROFILS = [24, 16, 12, 8]
/** Max long side of a Wan video on the 8 GB profile (480p). */
const WAN_COTE_8GO = 832

/* Variants come from the setup assistant manifest: one list for what is downloaded and
   what is used. On the original, `tient` = smallest profile it still fits (model + ~3 GB
   of activations); on the variant, `leger` = { remplace, pour: smallest profile it fits,
   chargeur: node class that loads it (GGUF: ComfyUI-GGUF pack), suit: only used with
   this file }. */
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'installer', 'modeles.json'), 'utf8'))
const VARIANTES = {}
for (const v of MANIFESTE.modeles.filter(m => m.leger)) {
  const orig = MANIFESTE.modeles.find(m => m.chemin.split('/').pop() === v.leger.remplace)
  const e = (VARIANTES[v.leger.remplace] ??= { tient: orig?.tient ?? 24, variantes: [] })
  e.variantes.push({ pour: v.leger.pour, fichier: v.chemin.split('/').pop(), chargeur: v.leger.chargeur, suit: v.leger.suit })
}

/* Input name of each loader, and its own inputs. */
/* Without CUDA (AMD on ROCm, Apple Silicon on MPS) the int8-convrot and nvfp4 files cannot be
   loaded. Each recipe file concerned has replacements in the manifest (`sansCuda`): the official
   bf16 weights, and GGUF files (Q8_0, Q4_K_M) for smaller memories. */
const SANS_CUDA = {}
for (const v of MANIFESTE.modeles.filter(m => m.sansCuda))
  (SANS_CUDA[v.sansCuda.remplace] ??= []).push({ fichier: v.chemin.split('/').pop(), taille: v.taille ?? 0, chargeur: v.sansCuda.chargeur ?? null })
// bf16 first (the most faithful), then GGUF files from largest to smallest
for (const l of Object.values(SANS_CUDA)) l.sort((a, b) => (a.chargeur ? 1 : 0) - (b.chargeur ? 1 : 0) || b.taille - a.taille)

/** Replacement to use without CUDA: the most faithful installed one that fits in ~85 % of the memory, else the smallest installed. */
export function choixSansCuda(candidats, vramOctets, installe) {
  const dispo = candidats.filter(c => installe(c))
  if (!dispo.length) return null
  const tient = vramOctets ? dispo.find(c => !c.taille || c.taille <= vramOctets * 0.85) : dispo[0]
  return tient ?? dispo[dispo.length - 1]
}

const ENTREE = { UNETLoader: 'unet_name', UnetLoaderGGUF: 'unet_name', CLIPLoader: 'clip_name', CLIPLoaderGGUF: 'clip_name' }

/** Profile of a card with `octets` of VRAM: the largest step it reaches. */
export function profilDe(octets) {
  const go = octets / 2 ** 30
  if (!go) return 24
  return go >= 22 ? 24 : go >= 14 ? 16 : go >= 10 ? 12 : 8
}

let carte = { at: 0, profil: null, vram: 0 }
let installes = { at: 0, parClasse: {} }
const comfyJson = async (p, ms = 15_000) => (await fetch(CONFIG.comfyUrl + p, { signal: AbortSignal.timeout(ms) })).json()

/** Profile forced for the current job (owner only: job.profilVram), set by jobs.js. */
export const profilDuJob = new AsyncLocalStorage()

/** Active profile: the job's if it forces one, else CREATOROS_VRAM, else the card seen by ComfyUI (re-read every 10 min). */
export async function profilActuel() {
  const duJob = profilDuJob.getStore()
  if (PROFILS.includes(duJob)) return { profil: duJob, source: 'job', vram: carte.vram }
  const force = Number(process.env.CREATOROS_VRAM)
  if (PROFILS.includes(force)) return { profil: force, source: 'CREATOROS_VRAM', vram: carte.vram }
  if (Date.now() - carte.at > 600_000) {
    try {
      const d = (await comfyJson('/system_stats', 5000))?.devices?.[0]
      // on a Mac, ComfyUI reports the whole unified memory: the studio plans for a share of it (carteGraphique.js)
      const vram = estApple() ? budgetMac(d?.vram_total || undefined) : (d?.vram_total ?? 0)
      carte = { at: Date.now(), vram, profil: profilDe(vram) }
    } catch { carte = { ...carte, at: Date.now() - 540_000 } }  // ComfyUI unreachable: retry in a minute
  }
  return { profil: carte.profil ?? 24, source: 'carte', vram: carte.vram }
}

/** Files ComfyUI sees for a loader (re-read every 2 min). */
async function fichiersDe(classe) {
  if (Date.now() - installes.at > 120_000) installes = { at: Date.now(), parClasse: {} }
  if (!installes.parClasse[classe]) {
    try {
      const info = (await comfyJson(`/object_info/${classe}`))?.[classe]
      const opt = info?.input?.required?.[ENTREE[classe]]?.[0]
      // two formats: ['a', 'b'] or 'COMBO' + { options: [...] }
      installes.parClasse[classe] = new Set(Array.isArray(opt) ? opt : info?.input?.required?.[ENTREE[classe]]?.[1]?.options ?? [])
    } catch { installes.parClasse[classe] = new Set() }
  }
  return installes.parClasse[classe]
}

/** Variant to use for `nom` at profile `profil`, among installed ones; null = keep the original. */
async function choisir(nom, profil, dejaChoisis) {
  const e = VARIANTES[String(nom).split('/').pop()]
  if (!e || profil >= e.tient) return null
  // most faithful variant that fits the profile, then lighter ones; failing that, the lightest of all
  const passe = e.variantes.filter(v => v.pour <= profil).sort((a, b) => b.pour - a.pour)
  const ordre = passe.length ? passe : [...e.variantes].sort((a, b) => a.pour - b.pour)
  for (const v of ordre) {
    if (v.suit && !dejaChoisis.has(v.suit)) continue   // the 4B encoder is only used with the 4B model
    if ((await fichiersDe(v.chargeur)).has(v.fichier)) return v
  }
  return null
}

/** Replaces heavy loaders in an API-format graph. Returns { graphe, remplaces: [[from, to]] }. */
export async function alleger(graphe) {
  const { profil } = await profilActuel()
  if (!graphe || typeof graphe !== 'object') return { graphe, remplaces: [] }
  const horsCuda = sansCuda()
  if (profil >= 24 && !horsCuda) return { graphe, remplaces: [] }
  const out = structuredClone(graphe)
  const remplaces = []
  /* Without CUDA first: the bf16 or GGUF replacement, if installed (otherwise the original file
     stays and ComfyUI reports that it cannot load it). */
  if (horsCuda) {
    const { vram } = await profilActuel()
    for (const n of Object.values(out)) {
      if (!(n?.class_type in ENTREE)) continue
      const nom = n.inputs?.[ENTREE[n.class_type]]
      const cands = typeof nom === 'string' ? SANS_CUDA[nom.split('/').pop()] : null
      if (!cands) continue
      const installes = new Map()
      for (const c of cands) installes.set(c.fichier, (await fichiersDe(c.chargeur ?? n.class_type)).has(c.fichier))
      const v = choixSansCuda(cands, vram, c => installes.get(c.fichier))
      if (!v) continue
      remplaces.push([nom, v.fichier])
      if (v.chargeur === 'UnetLoaderGGUF') { n.class_type = 'UnetLoaderGGUF'; n.inputs = { unet_name: v.fichier } }
      else n.inputs[ENTREE[n.class_type]] = v.fichier
    }
    if (profil >= 24) return { graphe: out, remplaces }
  }
  const choisis = new Set()
  // diffusion models first: the encoder choice depends on them
  const noeuds = Object.values(out).filter(n => n?.class_type in ENTREE)
    .sort((a, b) => (a.class_type.startsWith('CLIP') ? 1 : 0) - (b.class_type.startsWith('CLIP') ? 1 : 0))
  for (const n of noeuds) {
    const nom = n.inputs?.[ENTREE[n.class_type]]
    if (typeof nom !== 'string') continue
    const v = await choisir(nom, profil, choisis)
    if (!v) continue
    choisis.add(v.fichier)
    remplaces.push([nom, v.fichier])
    if (v.chargeur === n.class_type) n.inputs[ENTREE[n.class_type]] = v.fichier
    else if (v.chargeur === 'UnetLoaderGGUF') { n.class_type = v.chargeur; n.inputs = { unet_name: v.fichier } }
    else if (v.chargeur === 'CLIPLoaderGGUF') { n.class_type = v.chargeur; n.inputs = { clip_name: v.fichier, type: n.inputs.type } }
  }
  // Wan on 8 GB: Q4 weights fit but not 720p activations, so the video drops to 480p
  // (long side 832), same framing. 720p fits at 12 GB.
  if (profil <= 8 && remplaces.some(([, f]) => /^Wan2\.2-.*\.gguf$/.test(f))) {
    for (const n of Object.values(out)) {
      if (!/^Wan.*ToVideo$/.test(n?.class_type ?? '')) continue
      const { width: w, height: h } = n.inputs ?? {}
      if (typeof w !== 'number' || typeof h !== 'number') continue
      const k = WAN_COTE_8GO / Math.max(w, h)
      if (k >= 1) continue
      n.inputs.width = Math.round(w * k / 16) * 16; n.inputs.height = Math.round(h * k / 16) * 16
      remplaces.push([`${w}x${h}`, `${n.inputs.width}x${n.inputs.height}`])
    }
  }
  return { graphe: out, remplaces }
}

/** What the studio reports about the machine: profile, source, ready or missing variants. */
export async function etatAllegement() {
  const { profil, source, vram } = await profilActuel()
  const variantes = []
  for (const [de, e] of Object.entries(VARIANTES))
    for (const v of e.variantes)
      variantes.push({ de, vers: v.fichier, pour: v.pour, utile: profil < e.tient, installee: (await fichiersDe(v.chargeur)).has(v.fichier) })
  return { profil, source, vramGo: vram ? Math.round(vram / 2 ** 30) : null, variantes }
}
