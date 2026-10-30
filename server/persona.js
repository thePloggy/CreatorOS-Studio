/* ============================================================
   Personnages — les sujets récurrents des rendus, CONFIGURABLES.

   Une seule source : `persona.json` dans le dossier de données
   (CONFIG.personaFile). Il tient une LISTE de personnages et l'identifiant
   de celui qui est actif :

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

   L'ancienne forme (un seul personnage à la racine du fichier) est lue comme
   une liste d'un élément, et réécrite sous la nouvelle forme au premier
   enregistrement.

   Chaque job retient l'identifiant du personnage actif AU DÉPÔT : changer de
   personnage pendant qu'un rendu attend dans la file ne change pas ce rendu.

   Variables (s'appliquent au personnage actif) : CREATOROS_PERSONA_NAME,
   CREATOROS_PERSONA_TRIGGER, CREATOROS_PERSONA_DESCRIPTION,
   CREATOROS_PERSONA_PREAMBLE, CREATOROS_PERSONA_LORAS
   (« fichier[:force],fichier[:force] »).

   Le fichier est relu quand son mtime change : modifier un personnage ne
   demande pas de redémarrage.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

let cache = { mtime: null, data: null }

/** `"a.safetensors:0.8,b.safetensors"` ou tableau → [{ name, strength }]. */
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

/** Fichier brut → { active, personas: [brut…] }, quelle que soit sa forme. */
function normaliserFichier(f) {
  if (Array.isArray(f?.personas)) {
    const personas = f.personas.filter(p => p && typeof p === 'object')
      .map(p => ({ ...p, id: slug(p.id) || slug(p.name) || 'default' }))
    return { active: slug(f.active) || personas[0]?.id || null, personas }
  }
  // ancienne forme : un personnage à la racine (ou fichier vide)
  if (!f || !Object.keys(f).length) return { active: null, personas: [] }
  const id = slug(f.id) || slug(f.name) || 'default'
  return { active: id, personas: [{ ...f, id }] }
}

function lireFichier() {
  let st = null
  try { st = fs.statSync(CONFIG.personaFile) } catch { /* pas de fichier : aucun personnage */ }
  if (!st) { cache = { mtime: null, data: { active: null, personas: [] } }; return structuredClone(cache.data) }
  if (cache.mtime === st.mtimeMs && cache.data) return structuredClone(cache.data)
  let brut = {}
  try { brut = JSON.parse(fs.readFileSync(CONFIG.personaFile, 'utf8')) ?? {} }
  catch (e) { console.warn(`[persona] ${CONFIG.personaFile} illisible : ${e.message}`) }
  cache = { mtime: st.mtimeMs, data: normaliserFichier(brut) }
  return structuredClone(cache.data)
}

/** Écriture atomique : un fichier à moitié écrit rendrait une liste vide au
 *  prochain job. */
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
    /* LoRA d'identité de la recette FLUX.2 Klein : une LoRA Krea n'agit pas
       sur Klein (autre architecture), d'où une liste à part. */
    lorasKlein: lorasDe(f?.lorasKlein),
    videoLoras: lorasDe(f?.videoLoras),
    credit: creditDe(f?.credit),
    garderobe: garderobeDe(f?.garderobe),
  }
}

/* Crédit du personnage (auteur de la LoRA, page, licence) : affiché sur sa
   carte — les licences Civitai demandent souvent de nommer l'auteur. */
function creditDe(c) {
  if (!c || typeof c !== 'object') return null
  const v = k => String(c[k] ?? '').trim().slice(0, 200)
  const url = /^https:\/\/[^\s]+$/.test(v('url')) ? v('url') : ''
  const out = { auteur: v('auteur'), url, licence: v('licence') }
  return out.auteur || out.url || out.licence ? out : null
}

/* Garde-robe : les éléments (tenues, lieux) favoris du personnage, par id de
   vocabulaire, plus des lignes libres. Elle revient en tête des Éléments. */
function garderobeDe(g) {
  const ids = xs => (Array.isArray(xs) ? xs : []).map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 200)
  const perso = (Array.isArray(g?.perso) ? g.perso : [])
    .map(x => ({ label: String(x?.label ?? '').trim().slice(0, 60), prompt: String(x?.prompt ?? '').trim().slice(0, 400) }))
    .filter(x => x.prompt).slice(0, 100)
  return { tenues: ids(g?.tenues), lieux: ids(g?.lieux), perso }
}

/** LoRA d'identité photo d'un personnage pour un moteur photo donné. */
export const lorasPhoto = (p, moteur) => (moteur === 'moss' ? [] : moteur === 'klein' ? p.lorasKlein : p.loras)

function idActif(d) {
  return d.personas.some(p => p.id === d.active) ? d.active : d.personas[0]?.id ?? null
}

/** Identifiant du personnage actif (null : aucun personnage configuré). */
export const activeId = () => idActif(lireFichier())

/** Un personnage, normalisé. Sans `id` : l'actif. Un id inconnu (personnage
 *  supprimé depuis le dépôt du job) rend un personnage vide, pas l'actif : un
 *  rendu ne prend jamais l'identité d'un autre. Jamais d'exception. */
export function persona(id) {
  const d = lireFichier(), actif = idActif(d)
  const cible = id === undefined || id === null ? actif : id
  const f = d.personas.find(p => p.id === cible)
  return normaliser(f ?? { id: cible ?? 'default' }, cible === actif)
}

/** Personnage demandé par un dépôt s'il existe, sinon l'actif : un client
 *  peut lancer un rendu pour un autre personnage sans changer l'actif. */
export function personaDuDepot(id) {
  return typeof id === 'string' && lireFichier().personas.some(p => p.id === id) ? id : persona().id
}

/** Tous les personnages, normalisés, et l'actif. */
export function personas() {
  const d = lireFichier(), actif = idActif(d)
  return { active: actif, list: d.personas.map(p => normaliser(p, p.id === actif)) }
}

/** Préambule d'identité préfixé au prompt de scène : mot déclencheur puis
 *  description fixe. `null` quand le personnage n'en a pas — l'injection ne
 *  signale alors rien (cf. comfy.injectJob). La clé publiée en provenance dit
 *  d'où vient le texte. */
/* Ancre d'âge (30/10) : un prompt qui ne nomme personne (« mustard raincoat, rainy street »)
   a donné une silhouette d'enfant sur un personnage sans préambule. Tous les personnages
   du studio sont des femmes adultes : chaque rendu le dit, sauf si le préambule donne un âge. */
const ADULTE = 'an adult woman in her mid-twenties'
export function identityPreambleFor(id) {
  const p = persona(id)
  const age = /\b(adult|\d{2}[- ]?(years?|yo))\b/i.test(p.preamble ?? '') ? null : ADULTE
  const text = [p.trigger, p.preamble, p.trigger || p.preamble ? age : null].filter(Boolean).join(', ')
  return text ? { key: 'persona', file: null, text: `${text}, ` } : null
}

/** Préfixe court (mot déclencheur seul) pour les recettes qui ne prennent
 *  pas le préambule complet (retouche vidéo). Vide sans personnage. */
export const triggerPrefix = id => { const t = persona(id).trigger; return t ? `${t}, ` : '' }

/** Fichiers de LoRA de TOUS les personnages — pour les distinguer des autres
 *  dans l'inventaire. */
export const personaLoraNames = () =>
  new Set(personas().list.flatMap(p => [...p.loras, ...p.lorasKlein, ...p.videoLoras]).map(l => l.name))

/** Champs figés par une variable d'environnement (personnage actif) :
 *  l'interface les montre sans les rendre modifiables. */
export function champsFiges() {
  const e = process.env
  return ['name', 'trigger', 'description', 'preamble', 'loras']
    .filter(k => e[`CREATOROS_PERSONA_${k.toUpperCase()}`] !== undefined)
}

const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max)
const forces = v => lorasDe(v).map(l => ({ name: l.name, strength: Math.min(2, Math.max(0, l.strength)) }))

/** Écrit un personnage depuis l'éditeur. Sans `id` : l'actif (créé s'il n'en
 *  existe aucun). Un champ absent du corps garde sa valeur. */
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
    videoLoras: has('videoLoras') ? forces(corps.videoLoras) : forces(a.videoLoras),
    /* Crédit verrouillé : une fois renseigné, il ne change plus (la
       provenance d'une LoRA ne bouge pas). Un personnage sans crédit peut en
       recevoir un, une fois. */
    credit: creditDe(a.credit) ?? (has('credit') ? creditDe(corps.credit) : null),
    garderobe: has('garderobe') ? garderobeDe(corps.garderobe) : garderobeDe(a.garderobe),
  }
  ecrireFichier(d)
  return persona(d.personas[i].id)
}

/** Nouveau personnage (vide, ou copie d'un existant). Devient l'actif. */
export function creer({ name, depuis } = {}) {
  const d = lireFichier()
  const nom = texte(name, 60) || 'Nouveau personnage'
  const base = slug(nom) || 'personnage'
  let id = base
  for (let n = 2; d.personas.some(p => p.id === id); n++) id = `${base}_${n}`
  const modele = depuis ? d.personas.find(p => p.id === depuis) : null
  d.personas.push(modele
    ? { ...modele, id, name: nom }
    : { id, name: nom, trigger: '', description: '', preamble: '', loras: [], lorasKlein: [], videoLoras: [] })
  d.active = id
  ecrireFichier(d)
  return persona(id)
}

/** Rend un personnage actif. Faux si l'id est inconnu. */
export function activer(id) {
  const d = lireFichier()
  if (!d.personas.some(p => p.id === id)) return false
  d.active = id
  ecrireFichier(d)
  return true
}

/** Supprime un personnage (ses rendus restent dans la bibliothèque, ses LoRA
 *  dans le dossier de ComfyUI). Le dernier ne se supprime pas. */
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
