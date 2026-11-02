/* Extensions : des fonctions ajoutées au studio sans code. Une extension est un dossier avec
   app.json (nom, description, champs du formulaire, type de sortie) et workflow.json (un workflow
   ComfyUI au format API, avec des emplacements {{champ}}). Le studio ne l'exécute que si chaque
   nœud et chaque modèle qu'elle cite existe déjà dans ComfyUI : rien n'est installé à sa place.
   - extensions/ : extensions livrées avec le studio, que tout visiteur peut lancer ;
   - <données>/extensions/ : extensions installées depuis le catalogue, réservées au propriétaire ;
   - extensions/registre.json : le catalogue (dépôts GitHub publics). */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueueExtension } from './jobs.js'
import { t0Hit } from './t0.js'

const LIVREES = path.join(import.meta.dirname, '..', 'extensions')
const INSTALLEES = path.join(CONFIG.dataDir, 'extensions')
const RETIREES = path.join(CONFIG.dataDir, 'extensions-retirees')
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/
const TYPES = new Set(['texte', 'nombre', 'choix', 'image'])
const SORTIES = new Set(['image', 'video', 'audio'])
const JETON = /\{\{([a-z0-9_]+)\}\}/g

/** Vérifie app.json et workflow.json ; renvoie l'app normalisée ou lève une erreur lisible. */
export function valider(app, graphe) {
  if (!app || typeof app !== 'object') throw new Error('app.json illisible')
  if (!ID.test(String(app.id))) throw new Error('id : lettres minuscules, chiffres et tirets, 2 à 40 caractères')
  if (!String(app.nom ?? '').trim()) throw new Error('nom manquant')
  if (!SORTIES.has(app.sortie)) throw new Error('sortie : image, video ou audio')
  const entrees = Array.isArray(app.entrees) ? app.entrees : []
  if (entrees.length > 12) throw new Error('12 champs au plus')
  for (const e of entrees) {
    if (!/^[a-z0-9_]{1,30}$/.test(String(e.id)) || e.id === 'seed') throw new Error(`champ « ${e.id} » : nom invalide`)
    if (!TYPES.has(e.type)) throw new Error(`champ « ${e.id} » : type texte, nombre, choix ou image`)
    if (e.type === 'choix' && (!Array.isArray(e.options) || !e.options.length)) throw new Error(`champ « ${e.id} » : options manquantes`)
  }
  if (!graphe || typeof graphe !== 'object' || Array.isArray(graphe) || !Object.keys(graphe).length) throw new Error('workflow.json : un workflow ComfyUI au format API est attendu')
  for (const [k, n] of Object.entries(graphe)) if (!n || typeof n.class_type !== 'string' || typeof n.inputs !== 'object') throw new Error(`workflow.json : nœud ${k} invalide`)
  const connus = new Set([...entrees.map(e => e.id), 'seed'])
  for (const m of JSON.stringify(graphe).matchAll(JETON)) if (!connus.has(m[1])) throw new Error(`workflow.json : emplacement {{${m[1]}}} sans champ`)
  if (!Object.values(graphe).some(n => /^Save/.test(n.class_type))) throw new Error('workflow.json : aucun nœud de sauvegarde (SaveImage, SaveVideo, SaveAudio…)')
  return {
    id: app.id, nom: String(app.nom).slice(0, 60), description: String(app.description ?? '').slice(0, 300), auteur: String(app.auteur ?? '').slice(0, 60),
    licence: String(app.licence ?? '').slice(0, 40), version: String(app.version ?? '1.0.0').slice(0, 20), sortie: app.sortie,
    apercu: /^(\/vitrine\/[\w.-]+|https:\/\/raw\.githubusercontent\.com\/[\w./-]+)\.(webp|png|jpg|mp4)$/.test(String(app.apercu ?? '')) ? app.apercu : null,
    entrees: entrees.map(e => ({ id: e.id, type: e.type, label: String(e.label ?? e.id).slice(0, 60), defaut: e.defaut ?? null,
      options: e.type === 'choix' ? e.options.map(String).slice(0, 30) : undefined, min: e.min, max: e.max, aide: e.aide ? String(e.aide).slice(0, 160) : undefined })),
  }
}

/* Ce que ComfyUI sait faire : la liste des nœuds et, pour chaque entrée à choix, ses valeurs (modèles). */
let objetInfo = null, objetInfoAt = 0
async function infoComfy() {
  if (objetInfo && Date.now() - objetInfoAt < 5 * 60_000) return objetInfo
  const r = await fetch(`${CONFIG.comfyUrl}/object_info`, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`ComfyUI : HTTP ${r.status}`)
  objetInfo = await r.json(); objetInfoAt = Date.now()
  return objetInfo
}
/** Nœuds absents de ComfyUI et valeurs (modèles) qu'il ne propose pas. */
export async function manques(graphe) {
  const info = await infoComfy()
  const noeuds = new Set(), modeles = new Set()
  for (const n of Object.values(graphe)) {
    const def = info[n.class_type]
    if (!def) { noeuds.add(n.class_type); continue }
    const specs = { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) }
    for (const [cle, v] of Object.entries(n.inputs)) {
      const choix = specs[cle]?.[0]
      if (Array.isArray(choix) && typeof v === 'string' && !v.includes('{{') && !choix.includes(v) && /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx)$/i.test(v)) modeles.add(v)
    }
  }
  return { noeuds: [...noeuds], modeles: [...modeles] }
}

function lireDossier(dossier, source) {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(dossier, 'app.json'), 'utf8'))
    const graphe = JSON.parse(fs.readFileSync(path.join(dossier, 'workflow.json'), 'utf8'))
    return { ...valider(app, graphe), source, graphe }
  } catch (e) { console.warn(`[extensions] ${path.basename(dossier)} ignorée : ${e.message || e}`); return null }
}
function toutes() {
  const l = []
  for (const [racine, source] of [[LIVREES, 'livree'], [INSTALLEES, 'installee']]) {
    if (!fs.existsSync(racine)) continue
    for (const d of fs.readdirSync(racine, { withFileTypes: true })) if (d.isDirectory() && ID.test(d.name)) { const x = lireDossier(path.join(racine, d.name), source); if (x && x.id === d.name) l.push(x) }
  }
  return l
}

export async function lister() {
  const l = toutes()
  return Promise.all(l.map(async ({ graphe, ...x }) => ({ ...x, manque: await manques(graphe).catch(() => ({ noeuds: [], modeles: [] })) })))
}

export function catalogue() {
  let reg = []
  try { reg = JSON.parse(fs.readFileSync(path.join(LIVREES, 'registre.json'), 'utf8')).extensions ?? [] } catch { reg = [] }
  const ici = new Set(toutes().map(x => x.id))
  return reg.filter(e => ID.test(String(e.id))).map(e => ({ id: e.id, nom: String(e.nom ?? e.id), description: String(e.description ?? ''), auteur: String(e.auteur ?? ''),
    licence: String(e.licence ?? ''), source: String(e.source ?? ''), sortie: String(e.sortie ?? 'image'), installee: ici.has(e.id),
    apercu: /^https:\/\/raw\.githubusercontent\.com\/[\w./-]+\.(webp|png|jpg)$/.test(String(e.apercu ?? '')) ? e.apercu : null }))
}

/* Installation depuis le catalogue seulement, fichiers lus sur raw.githubusercontent.com. */
export async function installer(id) {
  let reg = []
  try { reg = JSON.parse(fs.readFileSync(path.join(LIVREES, 'registre.json'), 'utf8')).extensions ?? [] } catch { reg = [] }
  const e = reg.find(x => x.id === id)
  if (!e) throw new Error('extension absente du catalogue')
  const base = String(e.source ?? '').replace(/\/?$/, '/')
  if (!/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[\w./-]+\/$/.test(base)) throw new Error('source refusée : un dossier de dépôt GitHub public est attendu')
  const lire = async nom => {
    const r = await fetch(base + nom, { signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!r.ok) throw new Error(`${nom} : HTTP ${r.status}`)
    const t = await r.text()
    if (t.length > 512 * 1024) throw new Error(`${nom} : fichier trop gros`)
    return JSON.parse(t)
  }
  const app = await lire('app.json'), graphe = await lire('workflow.json')
  const v = valider(app, graphe)
  if (v.id !== id) throw new Error('l’id de app.json ne correspond pas au catalogue')
  if (fs.existsSync(path.join(LIVREES, id))) throw new Error('déjà livrée avec le studio')
  const m = await manques(graphe)
  const dossier = path.join(INSTALLEES, id)
  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(path.join(dossier, 'app.json'), JSON.stringify(app, null, 1))
  fs.writeFileSync(path.join(dossier, 'workflow.json'), JSON.stringify(graphe, null, 1))
  return { ...v, source: 'installee', manque: m }
}

/** Retire une extension installée : le dossier est mis de côté, jamais effacé. */
export function retirer(id) {
  const d = path.join(INSTALLEES, String(id))
  if (!ID.test(String(id)) || !fs.existsSync(d)) throw new Error('extension installée inconnue')
  fs.mkdirSync(RETIREES, { recursive: true })
  fs.renameSync(d, path.join(RETIREES, `${id}-${Date.now().toString(36)}`))
  return { ok: true }
}

/** Remplit le workflow avec les valeurs du formulaire et le met en file. */
export async function lancer({ id, valeurs, proprietaire, personaId }) {
  const x = toutes().find(e => e.id === id)
  if (!x) throw new Error('extension inconnue')
  if (x.source === 'installee' && !proprietaire) throw new Error('réservé au propriétaire du studio')
  const m = await manques(x.graphe)
  if (m.noeuds.length || m.modeles.length) throw new Error(`il manque à ComfyUI : ${[...m.noeuds, ...m.modeles].join(', ')}`)
  const v = valeurs && typeof valeurs === 'object' ? valeurs : {}
  const remplis = { seed: Math.floor(Math.random() * 2 ** 48) }
  let parent = null, textes = []
  for (const e of x.entrees) {
    let val = v[e.id] ?? e.defaut
    if (e.type === 'texte') {
      val = String(val ?? '').trim().slice(0, 600)
      if (!val) throw new Error(`« ${e.label} » est vide`)
      if (t0Hit(val)) throw new Error('texte refusé (liste T0)')
      textes.push(val)
    } else if (e.type === 'nombre') {
      val = Number(val); if (!Number.isFinite(val)) throw new Error(`« ${e.label} » : nombre attendu`)
      if (Number.isFinite(e.min)) val = Math.max(e.min, val)
      if (Number.isFinite(e.max)) val = Math.min(e.max, val)
    } else if (e.type === 'choix') {
      if (!e.options.includes(String(val))) throw new Error(`« ${e.label} » : choix inconnu`)
      val = String(val)
    } else if (e.type === 'image') {
      const a = store.getAsset(String(val ?? ''))
      if (!a || a.media_type !== 'photo') throw new Error(`« ${e.label} » : choisis une photo de la bibliothèque`)
      const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
      const nom = `crs_still_${path.basename(src)}`
      fs.copyFileSync(src, path.join(CONFIG.comfyInput, nom))
      store.noterInput(nom)
      parent = a.id; val = nom
    }
    remplis[e.id] = val
  }
  // un emplacement seul garde le type de la valeur (nombre) ; dans un texte, il est remplacé tel quel
  const remplir = n => {
    if (typeof n === 'string') { const seul = /^\{\{([a-z0-9_]+)\}\}$/.exec(n); return seul ? remplis[seul[1]] : n.replace(JETON, (_, k) => String(remplis[k])) }
    if (Array.isArray(n)) return n.map(remplir)
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, y]) => [k, remplir(y)]))
    return n
  }
  const graphe = remplir(x.graphe)
  // le texte final passe aussi par le filtre (une extension pourrait cacher un texte dans son workflow)
  if (t0Hit(Object.values(graphe).flatMap(n => Object.values(n.inputs).filter(y => typeof y === 'string')).join(' '))) throw new Error('workflow refusé (liste T0)')
  return enqueueExtension({ graphe, sortie: x.sortie, nom: x.nom, extensionId: x.id, personaId, parentAssetId: parent, prompt: textes.join(' · ') })
}
