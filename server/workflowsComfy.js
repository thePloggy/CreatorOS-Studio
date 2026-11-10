/* Official ComfyUI workflows (comfyui_workflow_templates package, shipped with ComfyUI): the list
   of open-source workflows, the models they need (present or downloadable from the URL in the
   workflow) and missing nodes, which indicate ComfyUI needs updating. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'
import { versApi, entreesManquantes } from './comfyVersApi.js'
import { remplirEtLancer } from './extensions.js'

const SITE = () => {
  const lib = path.join(CONFIG.comfyDir, 'venv', 'lib')
  try { for (const d of fs.readdirSync(lib)) { const p = path.join(lib, d, 'site-packages'); if (fs.existsSync(path.join(p, 'comfyui_workflow_templates_json'))) return p } } catch { /* no venv */ }
  return null
}
const MODELES_DIR = () => process.env.CREATOROS_MODELES_DIR || path.join(CONFIG.comfyDir, 'models')
const NOM = /^[\w.-]{1,120}$/
const SOURCES = /^https:\/\/(huggingface\.co|github\.com|objects\.githubusercontent\.com)\//
// nodes specific to ComfyUI's UI, with no server-side existence
const INTERFACE = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'PrimitiveString', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean', 'PrimitiveStringMultiline'])

let cache = null
function index() {
  if (cache) return cache
  const site = SITE()
  if (!site) return (cache = { site: null, liste: [] })
  const dossier = path.join(site, 'comfyui_workflow_templates_json', 'templates')
  const idx = JSON.parse(fs.readFileSync(path.join(dossier, 'index.json'), 'utf8'))
  const liste = []
  for (const c of idx) for (const t of c.templates ?? []) {
    if (t.openSource === false || /^api_/.test(t.name) || !NOM.test(t.name)) continue
    let w
    try { w = JSON.parse(fs.readFileSync(path.join(dossier, `${t.name}.json`), 'utf8')) } catch { continue }
    const noeuds = [...(w.nodes ?? []), ...(w.definitions?.subgraphs ?? []).flatMap(s => s.nodes ?? [])]
    const sousGraphes = new Set((w.definitions?.subgraphs ?? []).map(s => s.id))
    const modeles = new Map()
    for (const n of noeuds) for (const m of n.properties?.models ?? []) if (m?.name && m?.directory && NOM.test(m.name)) modeles.set(`${m.directory}/${m.name}`, { nom: m.name, dossier: m.directory, url: m.url })
    liste.push({
      id: t.name, titre: t.title ?? t.name, description: t.description ?? '', categorie: c.title, type: c.type ?? t.mediaType, tags: t.tags ?? [],
      versionMin: t.minComfyUIVersion ?? null, taille: t.size ?? null, tutoriel: t.tutorialUrl ?? null,
      classes: [...new Set(noeuds.map(n => n.type).filter(x => x && !sousGraphes.has(x) && !INTERFACE.has(x)))],
      modeles: [...modeles.values()], vignette: `${t.name}-1.${t.mediaSubtype ?? 'webp'}`,
    })
  }
  return (cache = { site, liste })
}

let info = null, infoAt = 0
async function etatComfy() {
  if (info && Date.now() - infoAt < 60_000) return info
  const [objets, stats] = await Promise.all([
    fetch(`${CONFIG.comfyUrl}/object_info`, { signal: AbortSignal.timeout(20_000) }).then(r => r.json()),
    fetch(`${CONFIG.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => ({})),
  ])
  const dossiers = new Map()
  info = { classes: new Set(Object.keys(objets)), version: stats?.system?.comfyui_version ?? null, dossiers }
  infoAt = Date.now()
  return info
}
async function fichiersDe(dossier) {
  const i = await etatComfy()
  if (!i.dossiers.has(dossier)) {
    const l = await fetch(`${CONFIG.comfyUrl}/models/${encodeURIComponent(dossier)}`, { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : [])).catch(() => [])
    i.dossiers.set(dossier, new Set(l.map(x => path.basename(String(x)))))
  }
  return i.dossiers.get(dossier)
}
const versionInf = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let k = 0; k < 3; k++) { if ((x[k] || 0) !== (y[k] || 0)) return (x[k] || 0) < (y[k] || 0) } return false }

/** The workflows, each with its missing models and missing nodes. */
export async function lister() {
  const { liste } = index()
  const i = await etatComfy()
  return Promise.all(liste.map(async w => {
    const manquants = []
    for (const m of w.modeles) if (!(await fichiersDe(m.dossier)).has(m.nom)) manquants.push({ nom: m.nom, dossier: m.dossier })
    const noeuds = w.classes.filter(c => !i.classes.has(c))
    return { id: w.id, titre: w.titre, description: w.description, categorie: w.categorie, type: w.type, tags: w.tags, taille: w.taille, tutoriel: w.tutoriel,
      modeles: w.modeles.length, manquants, noeuds, majComfy: !!(w.versionMin && i.version && versionInf(i.version, w.versionMin)) || noeuds.length > 0,
      versionMin: w.versionMin, telechargement: telechargements.get(w.id) ?? null }
  }))
}

export function vignette(nom) {
  const { site } = index()
  if (!site || !/^[\w.-]+\.(webp|png|jpg|mp4|webm|mp3)$/.test(nom)) return null
  for (const d of fs.readdirSync(site)) {
    if (!d.startsWith('comfyui_workflow_templates_media_') || d.endsWith('.dist-info')) continue
    const f = path.join(site, d, 'templates', nom)
    if (fs.existsSync(f)) return f
  }
  return null
}

/* Downloads a workflow's missing models, one file after another, in the background. */
const telechargements = new Map()
export async function telecharger(id) {
  const w = index().liste.find(x => x.id === id)
  if (!w) throw new Error('workflow inconnu')
  if (telechargements.get(id)?.etat === 'en cours') throw new Error('téléchargement déjà en cours')
  const a = []
  for (const m of w.modeles) if (!(await fichiersDe(m.dossier)).has(m.nom)) a.push(m)
  if (!a.length) throw new Error('rien à télécharger : tous les modèles sont là')
  for (const m of a) {
    if (!SOURCES.test(String(m.url ?? ''))) throw new Error(`${m.nom} : source non officielle, téléchargement refusé`)
    if (!/^[a-z_]+$/.test(m.dossier)) throw new Error(`${m.nom} : dossier invalide`)
  }
  const libre = fs.statfsSync(fs.existsSync(MODELES_DIR()) ? MODELES_DIR() : CONFIG.comfyDir)
  if (libre.bavail * libre.bsize < 60e9) throw new Error('moins de 60 Go libres sur le disque des modèles')
  const suivi = { etat: 'en cours', fait: 0, total: a.length, fichier: null, erreur: null }
  telechargements.set(id, suivi)
  void (async () => {
    for (const m of a) {
      suivi.fichier = m.nom
      const dossier = path.join(MODELES_DIR(), m.dossier)
      fs.mkdirSync(dossier, { recursive: true })
      const part = path.join(dossier, `${m.nom}.part`)
      const code = await new Promise(ok => {
        const p = spawn('curl', ['-sL', '--fail', '-C', '-', '-o', part, m.url], { stdio: 'ignore' })
        p.on('close', ok); p.on('error', () => ok(1))
      })
      if (code !== 0) { suivi.etat = 'échec'; suivi.erreur = `${m.nom} : curl ${code}`; return }
      fs.renameSync(part, path.join(dossier, m.nom))
      suivi.fait++
      info?.dossiers.delete(m.dossier)
    }
    suivi.etat = 'fini'; suivi.fichier = null
  })()
  return suivi
}

/* ---------- open a catalog workflow in the studio ----------
   The workflow (editor format) is converted to API format (comfyVersApi.js), then its useful
   settings become a form: the main prompt, one photo per LoadImage, the seed.
   Everything else keeps the official workflow's values. */

const SORTIE = [[/^Save(Image|AnimatedWEBP|AnimatedPNG)/, 'image'], [/^(SaveVideo|SaveWEBM|VHS_VideoCombine)/, 'video'], [/^SaveAudio/, 'audio']]
const CHAMPS_TEXTE = /^(text|prompt|value|positive)$/
const CLASSES_TEXTE = /^(CLIPTextEncode|TextEncode|PrimitiveString|PrimitiveStringMultiline)/

async function objetInfo() {
  const r = await fetch(`${CONFIG.comfyUrl}/object_info`, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`ComfyUI : HTTP ${r.status}`)
  return r.json()
}

/** The catalog workflow as an "app": name, output, fields, slotted graph. */
export async function application(id) {
  const t = index().liste.find(x => x.id === id)
  if (!t) throw new Error('workflow inconnu')
  const w = JSON.parse(fs.readFileSync(path.join(index().site, 'comfyui_workflow_templates_json', 'templates', `${id}.json`), 'utf8'))
  const oi = await objetInfo()
  const { graphe, ignores } = versApi(w, oi)
  if (ignores.length) throw new Error(`nœuds absents de ComfyUI : ${ignores.join(', ')} — mets ComfyUI à jour`)
  const manquantes = entreesManquantes(graphe, oi)
  if (manquantes.length) throw new Error(`ce workflow ne se convertit pas encore (${manquantes.slice(0, 3).join(', ')}) : ouvre-le dans ComfyUI`)

  let sortie = null
  for (const n of Object.values(graphe)) for (const [re, s] of SORTIE) if (!sortie && re.test(n.class_type)) sortie = s
  if (!sortie) throw new Error('ce workflow ne produit ni image, ni vidéo, ni son : ouvre-le dans ComfyUI')
  if (Object.values(graphe).some(n => /^(LoadVideo|VHS_LoadVideo|LoadAudio)/.test(n.class_type)))
    throw new Error('ce workflow part d’une vidéo ou d’un son : ouvre-le dans ComfyUI')

  // nodes feeding a "negative": their text is not the prompt
  const negatifs = new Set(Object.values(graphe).flatMap(n => Object.entries(n.inputs).filter(([k, v]) => /negative/.test(k) && Array.isArray(v)).map(([, v]) => v[0])))
  const textes = []
  for (const [nid, n] of Object.entries(graphe)) {
    if (!CLASSES_TEXTE.test(n.class_type) || negatifs.has(nid)) continue
    for (const [k, v] of Object.entries(n.inputs))
      if (CHAMPS_TEXTE.test(k) && typeof v === 'string' && v.trim() && !/^you are\b/i.test(v.trim())) textes.push({ nid, k, v })
  }
  textes.sort((a, b) => b.v.length - a.v.length)
  const entrees = []
  if (textes[0]) {
    const { nid, k, v } = textes[0]
    graphe[nid].inputs[k] = '{{prompt}}'
    entrees.push({ id: 'prompt', type: 'texte', label: 'Prompt', defaut: v.slice(0, 600) })
  }
  let ni = 0
  for (const n of Object.values(graphe)) {
    if (n.class_type !== 'LoadImage') continue
    ni++
    n.inputs.image = `{{image${ni}}}`
    if ('upload' in n.inputs) delete n.inputs.upload
    entrees.push({ id: `image${ni}`, type: 'image', label: ni === 1 ? 'Image' : `Image ${ni}` })
  }
  for (const n of Object.values(graphe))
    for (const k of ['seed', 'noise_seed']) if (typeof n.inputs[k] === 'number') n.inputs[k] = '{{seed}}'
  return { id: `catalogue-${id}`.slice(0, 40), nom: t.titre, description: t.description, sortie, entrees, graphe, modeleId: id }
}

/** What the page shows: the form and what is missing, without the graph. */
export async function formulaire(id) {
  const a = await application(id)
  return { id, nom: a.nom, description: a.description, sortie: a.sortie, entrees: a.entrees }
}

export async function lancer(id, { valeurs, personaId }) {
  const a = await application(id)
  return remplirEtLancer({ ...a, id: `catalogue:${id}` }, { valeurs, personaId })
}
