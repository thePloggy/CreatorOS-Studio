/* Directed long take: a MiniMax H3 clip of 17 s to one minute, built window by window.
   Each window is rendered, watched, then approved or re-rolled; the final blend smooths the joins.

   The render relies on two OPTIONAL ComfyUI nodes from the "Geiru Context Suite" pack
   (github.com/roycho87/geiru_context_suite, GPL-3.0) that the operator installs in custom_nodes:
   Geiru Hybrid Windows (context windows anchored on the first frame to limit drift) and
   Geiru Window Director (window-by-window render). This file holds no code from that pack: it
   only calls its nodes through the ComfyUI API.

   Director protocol: the same graph is always submitted; only the `action` field changes
   (reroll, approve, rewind, blend). A take's state is read on /geiru_window_director/status. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG } from './config.js'
import { loadWorkflow } from './comfy.js'

export const PLAN_LONG = {
  recette: 'PROD_video_minimax.json',
  longueur: 226,        // frames per window (17n + 5)
  recouvrement: 39,     // frames shared with the previous window (17n + 5)
  fenetresMin: 2,
  fenetresMax: 8,
  pasBascule: 6,        // of 8 steps: the last 2 are blended over the whole clip
  pasCapstone: 6,
  formats: { '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '1:1': '1:1 (Square)' },
  actions: ['reroll', 'approve', 'rewind', 'blend'],
}
const NOEUDS = ['H3ClownHybridWindows', 'GeiruWindowDirector']

/** Frames, then seconds, of a take of n windows (24 fps). */
export const imagesPour = n => PLAN_LONG.longueur + (n - 1) * (PLAN_LONG.longueur - PLAN_LONG.recouvrement)
export const secondesPour = n => imagesPour(n) / 24

/* ---------- is the pack installed? (re-read at most once a minute) ---------- */
let vu = { t: 0, ok: false }
export async function packInstalle() {
  if (Date.now() - vu.t < 60_000) return vu.ok
  let ok = true
  for (const n of NOEUDS) {
    try {
      const r = await fetch(`${CONFIG.comfyUrl}/object_info/${n}`)
      const d = r.ok ? await r.json() : {}
      if (!d?.[n]) ok = false
    } catch { ok = false }
  }
  vu = { t: Date.now(), ok }
  return ok
}

/* ---------- takes: one JSON file per take ---------- */
const DOSSIER = path.join(CONFIG.dataDir, 'planslongs')
const fichier = id => path.join(DOSSIER, `${id}.json`)
const idValide = id => typeof id === 'string' && /^pl-[a-z0-9]{6,20}$/.test(id)

export function creerPrise({ image, sourceAssetId, personaId, fenetres, format, prompts }) {
  fs.mkdirSync(DOSSIER, { recursive: true })
  const id = `pl-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
  const prise = {
    id, creeLe: Date.now(), image, sourceAssetId: sourceAssetId ?? null, personaId: personaId ?? null,
    fenetres, format, prompts, graine: Math.floor(Math.random() * 0xffffffffffff),
    apercus: {},        // window number -> { uri, job }
    etat: null,         // last state read from the Director
    jobActif: null, auto: false, final: null, erreur: null,
  }
  ecrirePrise(prise)
  return prise
}
export function lirePrise(id) {
  if (!idValide(id) || !fs.existsSync(fichier(id))) return null
  try { return JSON.parse(fs.readFileSync(fichier(id), 'utf8')) } catch { return null }
}
export function ecrirePrise(p) {
  fs.mkdirSync(DOSSIER, { recursive: true })
  const tmp = fichier(p.id) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1))
  fs.renameSync(tmp, fichier(p.id))
}
export function listerPrises() {
  if (!fs.existsSync(DOSSIER)) return []
  return fs.readdirSync(DOSSIER).filter(f => f.endsWith('.json')).map(f => lirePrise(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.creeLe - a.creeLe)
}
export function supprimerPrise(id) {
  const p = lirePrise(id)
  if (!p) return false
  for (const a of Object.values(p.apercus ?? {})) {
    const f = path.join(CONFIG.mediaDir, path.basename(String(a.uri ?? '')))
    if (a.uri && f.startsWith(CONFIG.mediaDir + path.sep) && fs.existsSync(f)) fs.rmSync(f, { force: true })
  }
  fs.rmSync(fichier(id), { force: true })
  return true
}

/* ---------- Director: state and reset of a take ---------- */
export async function etatDirector(id) {
  const r = await fetch(`${CONFIG.comfyUrl}/geiru_window_director/status?run=${encodeURIComponent(id)}`)
  if (!r.ok) throw new Error(`état du Director illisible (HTTP ${r.status})`)
  return r.json()
}
export async function viderDirector(id) {
  await fetch(`${CONFIG.comfyUrl}/geiru_window_director/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: id }),
  }).catch(() => {})
}

/* ---------- graph: the studio's H3 recipe + hybrid windows + Director ---------- */
export function graphePlanLong(prise, { action, fenetre = 1, jobId }) {
  const g = loadWorkflow(PLAN_LONG.recette)
  const trouver = classe => Object.entries(g).find(([, n]) => n.class_type === classe)
  const [idImage] = trouver('LoadImage') ?? []
  const [idI2v, i2v] = trouver('MiniMaxH3ImageToVideo') ?? []
  const [idGuide, guide] = Object.entries(g).find(([, n]) => n.class_type === 'BasicGuider' && Array.isArray(n.inputs?.model)) ?? []
  const [, duree] = Object.entries(g).find(([, n]) => n.class_type === 'PrimitiveFloat' && /duration/i.test(n?._meta?.title ?? '')) ?? []
  const [, bruit] = trouver('RandomNoise') ?? []
  const [, sortie] = trouver('SaveVideo') ?? []
  if (!idImage || !idI2v || !idGuide || !duree || !bruit || !sortie) throw new Error('recette MiniMax H3 inattendue : nœuds du plan long introuvables')

  g[idImage].inputs.image = prise.image
  duree.inputs.value = secondesPour(prise.fenetres)
  bruit.inputs.noise_seed = Number(prise.graine)
  sortie.inputs.filename_prefix = `creatoros/${jobId}/planlong`
  for (const n of Object.values(g)) if (n.class_type === 'ResolutionSelector') n.inputs.aspect_ratio = PLAN_LONG.formats[prise.format] ?? PLAN_LONG.formats['9:16']

  // one prompt per window: one conditioning per window, combined in order
  i2v.inputs.prompt = prise.prompts[0]
  let cond = [idI2v, 0]
  for (let i = 1; i < prise.fenetres; i++) {
    g[`pl_c${i}`] = { class_type: 'MiniMaxH3ImageToVideo', inputs: { ...i2v.inputs, prompt: prise.prompts[i] ?? prise.prompts[0] } }
    g[`pl_k${i}`] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: cond, conditioning_2: [`pl_c${i}`, 0] } }
    cond = [`pl_k${i}`, 0]
  }
  guide.inputs.conditioning = cond

  g.pl_fenetres = { class_type: 'H3ClownHybridWindows', inputs: {
    model: guide.inputs.model, context_length: PLAN_LONG.longueur, context_overlap: PLAN_LONG.recouvrement,
    switch_step: PLAN_LONG.pasBascule, fuse_method: 'pyramid', freenoise: true, split_conds_to_windows: true,
    crash_protection: true, keystone_swap: true, keystone_step: 0, back_capstone: true, capstone_step: PLAN_LONG.pasCapstone,
    context_noise: false, context_noise_strength: 1.0, context_noise_fade: 'linear', sound_first: false, finished_handoff: true,
  } }
  g.pl_director = { class_type: 'GeiruWindowDirector', inputs: {
    model: ['pl_fenetres', 0], run_name: prise.id, rewind_to_window: Math.max(1, Number(fenetre) || 1),
    // re-roll or rewind: fresh noise, otherwise the window comes out identical
    new_seed_on_reroll: true, keep_late_steps: false, bypass_blend: false, preview: 'this window', action,
  } }
  guide.inputs.model = ['pl_director', 0]
  return g
}
