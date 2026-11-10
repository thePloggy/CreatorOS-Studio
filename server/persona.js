/* ============================================================
   Characters: the recurring, CONFIGURABLE subjects of renders.

   Single source: `persona.json` in the data folder (CONFIG.personaFile).
   It holds a LIST of characters and the id of the active one:

     {
       "active": "ava",
       "personas": [
         {
           "id": "ava",
           "name": "Ava",
           "trigger": "ava_token",
           "description": "Fictional travel and lifestyle creator.",
           "preamble": "a 30-year-old woman with short auburn hair",
           "loras": [{ "name": "ava_krea.safetensors", "strength": 1.0 }],
           "videoLoras": []
         }
       ]
     }

   The legacy form (a single character at the file root) is read as a
   one-item list and rewritten in the list form on the next save.

   Each job keeps the id of the character active WHEN QUEUED: switching
   character while a render waits in the queue does not change that render.

   Variables (apply to the active character): CREATOROS_PERSONA_NAME,
   CREATOROS_PERSONA_TRIGGER, CREATOROS_PERSONA_DESCRIPTION,
   CREATOROS_PERSONA_PREAMBLE, CREATOROS_PERSONA_LORAS
   ("file[:strength],file[:strength]").

   The file is reread when its mtime changes: editing a character needs no
   restart.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

let cache = { mtime: null, data: null }

/** `"a.safetensors:0.8,b.safetensors"` or array → [{ name, strength }]. */
function lorasDe(v) {
  const brut = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return brut.map(l => {
    if (typeof l === 'string') {
      const [name, s] = l.trim().split(':')
      return { name: name?.trim(), strength: s !== undefined && Number.isFinite(Number(s)) ? Number(s) : 1 }
    }
    return { name: l?.name, strength: Number.isFinite(Number(l?.strength)) ? Number(l.strength) : 1 }
  }).filter(l => typeof l.name === 'string' && l.name && !l.name.includes('..'))
}

const slug = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

/** Raw file → { active, personas: [raw…] }, whatever its form. */
function normaliserFichier(f) {
  if (Array.isArray(f?.personas)) {
    const personas = f.personas.filter(p => p && typeof p === 'object')
      .map(p => ({ ...p, id: slug(p.id) || slug(p.name) || 'default' }))
    return { active: slug(f.active) || personas[0]?.id || null, personas }
  }
  // legacy form: one character at the root (or empty file)
  if (!f || !Object.keys(f).length) return { active: null, personas: [] }
  const id = slug(f.id) || slug(f.name) || 'default'
  return { active: id, personas: [{ ...f, id }] }
}

function lireFichier() {
  let st = null
  try { st = fs.statSync(CONFIG.personaFile) } catch { /* no file: no character */ }
  if (!st) { cache = { mtime: null, data: { active: null, personas: [] } }; return structuredClone(cache.data) }
  if (cache.mtime === st.mtimeMs && cache.data) return structuredClone(cache.data)
  let brut = {}
  try { brut = JSON.parse(fs.readFileSync(CONFIG.personaFile, 'utf8')) ?? {} }
  catch (e) { console.warn(`[persona] ${CONFIG.personaFile} illisible : ${e.message}`) }
  cache = { mtime: st.mtimeMs, data: normaliserFichier(brut) }
  return structuredClone(cache.data)
}

/** Atomic write: a half-written file would yield an empty list for the
 *  next job. */
function ecrireFichier(data) {
  fs.mkdirSync(path.dirname(CONFIG.personaFile), { recursive: true })
  const tmp = `${CONFIG.personaFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, CONFIG.personaFile)
  cache = { mtime: null, data: null }
}

function normaliser(f, actif) {
  const env = actif ? process.env : {}
  const txt = (e, v) => String(env[e] ?? v ?? '').trim()
  return {
    id: f?.id ?? 'default',
    name: txt('CREATOROS_PERSONA_NAME', f?.name),
    trigger: txt('CREATOROS_PERSONA_TRIGGER', f?.trigger),
    description: txt('CREATOROS_PERSONA_DESCRIPTION', f?.description),
    preamble: txt('CREATOROS_PERSONA_PREAMBLE', f?.preamble),
    loras: lorasDe(env.CREATOROS_PERSONA_LORAS ?? f?.loras),
    /* Identity LoRAs for the FLUX.2 Klein recipe: a Krea LoRA does not work
       on Klein (different architecture), hence a separate list. */
    lorasKlein: lorasDe(f?.lorasKlein),
    /* Identity LoRAs for the FLUX 3 Image Klein recipe (trained on Klein Base with ai-toolkit, arch flux3) */
    lorasFlux3: lorasDe(f?.lorasFlux3),
    videoLoras: lorasDe(f?.videoLoras),
    credit: creditDe(f?.credit),
    garderobe: garderobeDe(f?.garderobe),
    voix: voixDe(f?.voix),
  }
}

/* Character voice: a studio voice (Kokoro, e.g. "af_heart") or "clone:<clip>", a clip from the
   audio library for the owner's cloned voice. Used by reels and talking avatars. */
export function voixDe(v) {
  const x = String(v ?? '').trim()
  return /^[a-z]{2}_[a-z]+$/.test(x) || /^clone:[\w.-]{1,120}$/.test(x) ? x : null
}

/* Character credit (LoRA author, page, license): shown on its card,
   since Civitai licenses often require naming the author. */
function creditDe(c) {
  if (!c || typeof c !== 'object') return null
  const v = k => String(c[k] ?? '').trim().slice(0, 200)
  const url = /^https:\/\/[^\s]+$/.test(v('url')) ? v('url') : ''
  const out = { auteur: v('auteur'), url, licence: v('licence') }
  return out.auteur || out.url || out.licence ? out : null
}

/* Wardrobe: the character's favorite elements (outfits, places), by
   vocabulary id, plus free lines. Shown at the top of Elements. */
function garderobeDe(g) {
  const ids = xs => (Array.isArray(xs) ? xs : []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 200)
  const perso = (Array.isArray(g?.perso) ? g.perso : [])
    .map(x => ({ label: String(x?.label ?? '').trim().slice(0, 60), prompt: String(x?.prompt ?? '').trim().slice(0, 400) }))
    .filter(x => x.prompt).slice(0, 100)
  return { tenues: ids(g?.tenues), lieux: ids(g?.lieux), perso }
}

/** A character's photo identity LoRAs for a given photo engine. */
export const lorasPhoto = (p, moteur) => (moteur === 'moss' ? [] : moteur === 'flux3' ? (p.lorasFlux3 ?? []) : moteur === 'klein' ? p.lorasKlein : p.loras)

function idActif(d) {
  return d.personas.some(p => p.id === d.active) ? d.active : d.personas[0]?.id ?? null
}

/** Active character id (null: no character configured). */
export const activeId = () => idActif(lireFichier())

/** A normalized character. Without `id`: the active one. An unknown id
 *  (character deleted after the job was queued) yields an empty character, not
 *  the active one: a render never takes another identity. Never throws. */
export function persona(id) {
  const d = lireFichier(), actif = idActif(d)
  const cible = id === undefined || id === null ? actif : id
  const f = d.personas.find(p => p.id === cible)
  return normaliser(f ?? { id: cible ?? 'default' }, cible === actif)
}

/** Render with no imposed identity: no LoRA, no trigger word, no preamble. */
export const SANS_PERSONNAGE = 'aucun'

/** Character requested by a submission if it exists, else the active one:
 *  a client can render for another character without changing the active one. */
export function personaDuDepot(id) {
  if (id === SANS_PERSONNAGE) return id
  return typeof id === 'string' && lireFichier().personas.some(p => p.id === id) ? id : persona().id
}

/** All characters, normalized, and the active one. */
export function personas() {
  const d = lireFichier(), actif = idActif(d)
  return { active: actif, list: d.personas.map(p => normaliser(p, p.id === actif)) }
}

/** Identity preamble prefixed to the scene prompt: trigger word then fixed
 *  description. `null` when the character has none; injection then reports
 *  nothing (see comfy.injectJob). The provenance key says where the text comes from. */
/* Age anchor: all studio characters are adult women, so every render states
   it unless the preamble gives an age (a prompt naming no one can otherwise yield a child figure). */
const ADULTE = 'an adult woman in her mid-twenties'
/* The trigger word only makes sense for an engine with a LoRA of this character; elsewhere
   it is an unknown word that skews the output. `moteur` absent: trigger kept. */
const aLoraPour = (p, moteur) => moteur === 'klein' ? p.lorasKlein.length > 0 : moteur === 'flux3' ? (p.lorasFlux3?.length ?? 0) > 0 : moteur === 'moss' ? false : moteur === 'krea' ? p.loras.length > 0 : true
/* A prompt that mentions someone (woman, man, child, crowd, portrait, he/she…). */
export const HUMAIN = /\b(wom[ae]n|m[ae]n|girls?|boys?|persons?|people|she|he|her|him|his|lad(y|ies)|guys?|child(ren)?|kids?|crowds?|someone|models?|dancers?|riders?|characters?|portraits?|faces?|bod(y|ies)|couples?|famil(y|ies)|femmes?|hommes?|filles?|garçons?|personnes?|gens|elle|il|enfants?|foule)\b/i
export function identityPreambleFor(id, moteur, texte) {
  /* No character: no imposed face. The adult-age mention stays when the prompt mentions someone (public
     demo included); with nobody in the prompt it would make people appear. */
  if (id === SANS_PERSONNAGE) return typeof texte === 'string' && !HUMAIN.test(texte) ? null : { key: 'persona', file: null, text: 'every person shown is an adult, ' }
  const p = persona(id)
  const age = /\b(adult|\d{2}[- ]?(years?|yo))\b/i.test(p.preamble ?? '') ? null : ADULTE
  const trigger = aLoraPour(p, moteur) ? p.trigger : null
  // the adult-age mention stays as soon as the character has a trigger word or description, even if the word is removed
  const text = [trigger, p.preamble, p.trigger || p.preamble ? age : null].filter(Boolean).join(', ')
  return text ? { key: 'persona', file: null, text: `${text}, ` } : null
}

/** Short prefix (trigger word only) for recipes that do not take the full
 *  preamble (video edit). Empty without a character. */
export const triggerPrefix = id => { const t = persona(id).trigger; return t ? `${t}, ` : '' }

/** LoRA files of ALL characters, to tell them apart from others in the
 *  inventory. */
export const personaLoraNames = () =>
  new Set(personas().list.flatMap(p => [...p.loras, ...p.lorasKlein, ...(p.lorasFlux3 ?? []), ...p.videoLoras]).map(l => l.name))

/** Fields locked by an environment variable (active character): the UI
 *  shows them read-only. */
export function champsFiges() {
  const e = process.env
  return ['name', 'trigger', 'description', 'preamble', 'loras']
    .filter(k => e[`CREATOROS_PERSONA_${k.toUpperCase()}`] !== undefined)
}

const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max)
const forces = v => lorasDe(v).map(l => ({ name: l.name, strength: Math.min(2, Math.max(0, l.strength)) }))

/** Writes a character from the editor. Without `id`: the active one (created
 *  if none exists). A field absent from the body keeps its value. */
export function enregistrer(corps, id) {
  const d = lireFichier()
  const cible = id ?? idActif(d)
  let i = d.personas.findIndex(p => p.id === cible)
  if (i < 0) {
    if (id) return null
    const nouvelId = slug(corps?.name) || 'default'
    d.personas.push({ id: nouvelId }); i = d.personas.length - 1
    d.active = nouvelId
  }
  const a = d.personas[i], has = k => corps && Object.hasOwn(corps, k)
  if (has('credit') && creditDe(a.credit) && JSON.stringify(creditDe(corps.credit)) !== JSON.stringify(creditDe(a.credit))) {
    const e = new Error('crédit verrouillé : il ne se modifie plus une fois renseigné'); e.statusCode = 409; throw e
  }
  d.personas[i] = {
    ...a,
    name: has('name') ? texte(corps.name, 60) : a.name ?? '',
    trigger: has('trigger') ? texte(corps.trigger, 60).replace(/[,\s]+/g, '_') : a.trigger ?? '',
    description: has('description') ? texte(corps.description, 400) : a.description ?? '',
    preamble: has('preamble') ? texte(corps.preamble, 600) : a.preamble ?? '',
    loras: has('loras') ? forces(corps.loras) : forces(a.loras),
    lorasKlein: has('lorasKlein') ? forces(corps.lorasKlein) : forces(a.lorasKlein),
    lorasFlux3: has('lorasFlux3') ? forces(corps.lorasFlux3) : forces(a.lorasFlux3 ?? []),
    videoLoras: has('videoLoras') ? forces(corps.videoLoras) : forces(a.videoLoras),
    /* Locked credit: once set, it does not change (a LoRA's provenance is
       fixed). A character without credit can receive one, once. */
    credit: creditDe(a.credit) ?? (has('credit') ? creditDe(corps.credit) : null),
    garderobe: has('garderobe') ? garderobeDe(corps.garderobe) : garderobeDe(a.garderobe),
    voix: has('voix') ? voixDe(corps.voix) : voixDe(a.voix),
  }
  ecrireFichier(d)
  return persona(d.personas[i].id)
}

/** New character (empty, or a copy of an existing one). Becomes active. */
export function creer({ name, depuis } = {}) {
  const d = lireFichier()
  const nom = texte(name, 60) || 'Nouveau personnage'
  const base = slug(nom) || 'personnage'
  let id = base
  for (let n = 2; d.personas.some(p => p.id === id); n++) id = `${base}_${n}`
  const modele = depuis ? d.personas.find(p => p.id === depuis) : null
  d.personas.push(modele
    ? { ...modele, id, name: nom }
    : { id, name: nom, trigger: '', description: '', preamble: '', loras: [], lorasKlein: [], lorasFlux3: [], videoLoras: [] })
  d.active = id
  ecrireFichier(d)
  return persona(id)
}

/** Makes a character active. False if the id is unknown. */
export function activer(id) {
  const d = lireFichier()
  if (!d.personas.some(p => p.id === id)) return false
  d.active = id
  ecrireFichier(d)
  return true
}

/** Deletes a character (its renders stay in the library, its LoRAs in
 *  the ComfyUI folder). The last one cannot be deleted. */
export function supprimer(id) {
  const d = lireFichier()
  if (d.personas.length <= 1) return { ok: false, error: 'le dernier personnage ne se supprime pas' }
  const i = d.personas.findIndex(p => p.id === id)
  if (i < 0) return { ok: false, error: 'personnage inconnu' }
  d.personas.splice(i, 1)
  if (d.active === id) d.active = d.personas[0].id
  ecrireFichier(d)
  return { ok: true }
}
