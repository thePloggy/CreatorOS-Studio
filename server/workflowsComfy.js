/* Workflows officiels de ComfyUI (paquet comfyui_workflow_templates, livré avec ComfyUI) : la liste
   des workflows open source, les modèles qu'ils demandent (présents ou à télécharger depuis l'URL
   inscrite dans le workflow) et les nœuds absents, qui signalent un ComfyUI à mettre à jour. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'

const SITE = () => {
  const lib = path.join(CONFIG.comfyDir, 'venv', 'lib')
  try { for (const d of fs.readdirSync(lib)) { const p = path.join(lib, d, 'site-packages'); if (fs.existsSync(path.join(p, 'comfyui_workflow_templates_json'))) return p } } catch { /* pas de venv */ }
  return null
}
const MODELES_DIR = () => process.env.CREATOROS_MODELES_DIR || path.join(CONFIG.comfyDir, 'models')
const NOM = /^[\w.-]{1,120}$/
const SOURCES = /^https:\/\/(huggingface\.co|github\.com|objects\.githubusercontent\.com)\//
// nœuds propres à l'interface de ComfyUI, sans existence côté serveur
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

/** Les workflows, chacun avec ses modèles manquants et ses nœuds absents. */
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

/* Téléchargement des modèles manquants d'un workflow, un fichier après l'autre, en arrière-plan. */
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
