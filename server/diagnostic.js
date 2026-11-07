/* ============================================================
   Diagnostic de la machine de rendu.

   Né de pannes découvertes par un rendu qui échouait au lieu d'être
   annoncées : un noyau mis à jour sans son module NVIDIA (« No CUDA GPUs »),
   une mise à jour du système qui change la version de Python sous le venv de
   ComfyUI (« No module named sqlalchemy »).

   Le diagnostic ne RÉPARE rien et ne modifie rien : il lit, compare, et dit
   en une phrase ce qui ne va pas et quoi faire. Chaque contrôle est borné
   dans le temps et indépendant des autres — un contrôle qui échoue ne fait
   pas tomber les suivants.

   Deux gravités : « bloquant » (un rendu échouera) et « alerte » (ça marche,
   mais quelque chose a changé ou va gêner).
   ============================================================ */
import { estAmd, identite } from './carteGraphique.js'
import { alleger } from './allege.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { CONFIG } from './config.js'

const COMFY_DIR = CONFIG.comfyDir
const COMFY_PY = CONFIG.comfyPython
const VERROU = path.join(CONFIG.dataDir, 'comfy_noeuds_verrou.json')

const run = (cmd, args, timeout = 20_000) => new Promise(ok => {
  execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 8 << 20 },
    (e, stdout, stderr) => ok({ code: e ? (e.code ?? 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? e?.message ?? '') }))
})
const json = async (url, timeout = 15_000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/* ---------- contrôles ---------- */

async function carteGraphique(p, infos) {
  const c = await identite()
  if (!c) {
    const noyau = os.release()
    p.push(estAmd()
      ? { gravite: 'bloquant', domaine: 'carte graphique', quoi: 'le pilote AMD ne répond pas (rocm-smi en échec)',
          conseil: 'vérifier que ROCm est installé et que l’utilisateur est dans les groupes render et video, puis redémarrer' }
      : { gravite: 'bloquant', domaine: 'carte graphique', quoi: 'le pilote NVIDIA ne répond pas (nvidia-smi en échec)',
          conseil: `vérifier que le module du noyau ${noyau} est installé (paquet linux-modules-nvidia-…-${noyau}), puis « sudo modprobe nvidia » ou redémarrer` })
    return
  }
  infos.carte = `${c.nom}, ${c.pilote ?? '?'}, ${c.vramGo} GiB${c.fabricant === 'amd' ? ' (ROCm)' : ''}`
}

/** Les paquets que ComfyUI et les scripts de CreatorOS importent réellement. */
const PAQUETS = ['torch', 'torchvision', 'numpy', 'PIL', 'cv2', 'sqlalchemy', 'alembic', 'aiohttp', 'safetensors', 'av']
async function python(p, infos) {
  if (!fs.existsSync(COMFY_PY)) {
    p.push({ gravite: 'bloquant', domaine: 'python', quoi: `interpréteur du venv de ComfyUI introuvable`, conseil: `vérifier COMFY_PYTHON (${COMFY_PY}) ou COMFY_DIR` })
    return
  }
  const code = `import sys, json, importlib
r = {"version": sys.version.split()[0], "ko": {}, "cuda": None}
for m in ${JSON.stringify(PAQUETS)}:
    try: importlib.import_module(m)
    except Exception as e: r["ko"][m] = str(e)[:140]
try:
    import torch; r["cuda"] = bool(torch.cuda.is_available()); r["torch"] = torch.__version__
except Exception as e: r["cuda"] = False
print("DIAG" + json.dumps(r))`
  const r = await run(COMFY_PY, ['-I', '-c', code], 90_000)
  const m = r.out.match(/DIAG(\{.*\})/)
  if (!m) {
    p.push({ gravite: 'bloquant', domaine: 'python', quoi: 'le Python de ComfyUI ne démarre pas', conseil: (r.err || r.out).trim().split('\n').pop()?.slice(0, 200) || 'voir venv/bin/python --version' })
    return
  }
  const d = JSON.parse(m[1])
  infos.python = `${d.version} · torch ${d.torch ?? '?'}`
  /* Les paquets sont installés pour UNE version mineure (lib/pythonX.Y) : si
     l'interpréteur n'est plus celle-là, plus rien ne s'importe. */
  let libs = []
  try { libs = fs.readdirSync(path.join(path.dirname(path.dirname(COMFY_PY)), 'lib')).filter(x => /^python\d/.test(x)) } catch { /* pas un venv classique */ }
  const attendue = libs[0]?.replace('python', '')
  if (attendue && !d.version.startsWith(attendue + '.'))
    p.push({ gravite: 'bloquant', domaine: 'python', quoi: `le venv de ComfyUI tourne en Python ${d.version} mais ses paquets sont installés pour ${attendue}`,
      conseil: `repointer venv/bin/python3 vers un Python ${attendue}` })
  const ko = Object.entries(d.ko)
  if (ko.length)
    p.push({ gravite: 'bloquant', domaine: 'python', quoi: `${ko.length} paquet(s) ne s'importent pas : ${ko.map(([k]) => k).join(', ')}`,
      conseil: ko[0][1] })
  if (d.cuda === false && !ko.some(([k]) => k === 'torch'))
    p.push({ gravite: 'bloquant', domaine: 'python', quoi: 'torch ne voit pas la carte graphique', conseil: 'voir le contrôle « carte graphique » ; sinon version de torch incompatible avec le pilote' })
}

/** Options d'une entrée de type liste, dans les deux formats de /object_info. */
const optionsDe = spec => Array.isArray(spec?.[0]) ? spec[0] : (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) ? spec[1].options : null
/* Entrées remplacées à chaque rendu par le serveur : leur valeur dans la
   recette est un exemple, pas un fichier requis. */
const ENTREES_INJECTEES = new Set(['image', 'video', 'file', 'audio', 'mask', 'upload'])

async function comfy(p, infos, recettes) {
  let info
  try { info = await json(CONFIG.comfyUrl + '/object_info', 30_000) } catch (e) {
    p.push({ gravite: 'bloquant', domaine: 'comfyui', quoi: `ComfyUI ne répond pas (${e.message})`, conseil: 'le journal de ComfyUI dit pourquoi ; les contrôles « python » et « carte graphique » ci-dessus sont les causes habituelles' })
    return
  }
  infos.noeuds = Object.keys(info).length
  /* 1. Les recettes servies : chaque nœud doit exister, chaque fichier de
        modèle nommé doit être dans la liste que ComfyUI propose. */
  const manquants = new Map()   // nœud → recettes
  const fichiers = new Map()    // « valeur (entrée) » → recettes
  for (const f of recettes) {
    let wf
    // tel qu'il partira : sur une petite carte, avec ses variantes allégées (cf. allege.js)
    try { wf = (await alleger(JSON.parse(fs.readFileSync(path.join(CONFIG.workflowsDir, f), 'utf8')))).graphe } catch (e) {
      p.push({ gravite: 'bloquant', domaine: 'recettes', quoi: `recette ${f} illisible`, conseil: String(e.message).slice(0, 120) })
      continue
    }
    for (const n of Object.values(wf)) {
      const def = info[n?.class_type]
      if (!n?.class_type) continue
      if (!def) { manquants.set(n.class_type, [...(manquants.get(n.class_type) ?? []), f]); continue }
      for (const [k, v] of Object.entries(n.inputs ?? {})) {
        if (typeof v !== 'string' || ENTREES_INJECTEES.has(k)) continue
        const opts = optionsDe(def.input?.required?.[k]) ?? optionsDe(def.input?.optional?.[k])
        if (opts && opts.length && !opts.includes(v)) {
          const cle = `${v} (${n.class_type}.${k})`
          fichiers.set(cle, [...(fichiers.get(cle) ?? []), f])
        }
      }
    }
  }
  for (const [n, fs_] of manquants)
    p.push({ gravite: 'bloquant', domaine: 'recettes', quoi: `nœud « ${n} » absent de ComfyUI`, conseil: `requis par ${[...new Set(fs_)].join(', ')} — une extension ne s'est pas chargée (voir le journal de ComfyUI au démarrage)` })
  for (const [v, fs_] of fichiers)
    p.push({ gravite: 'bloquant', domaine: 'recettes', quoi: `fichier ou valeur absent : ${v}`, conseil: `requis par ${[...new Set(fs_)].join(', ')}` })
  /* 2. Les graphes construits en code (pinceau, RIFE…) : leurs nœuds sont
        relevés dans les sources du serveur. */
  const dir = import.meta.dirname
  const enCode = new Set()
  for (const f of ['jobs.js', 'comfy.js'])
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/class_type:\s*'([^']+)'/g)) enCode.add(m[1])
  for (const n of enCode)
    if (!info[n]) p.push({ gravite: 'bloquant', domaine: 'recettes', quoi: `nœud « ${n} » absent de ComfyUI`, conseil: 'utilisé par un graphe construit en code (pinceau, fluidité, agrandissement)' })
  infos.recettes = `${recettes.length} recettes servies contrôlées`
}

/** Version (commit git) de ComfyUI et de chaque extension. */
async function versions() {
  const v = {}
  const lire = async (nom, d) => {
    if (!fs.existsSync(path.join(d, '.git'))) return
    const r = await run('git', ['-C', d, 'rev-parse', '--short=12', 'HEAD'], 8000)
    if (r.code === 0) v[nom] = r.out.trim()
  }
  await lire('ComfyUI', COMFY_DIR)
  const cn = path.join(COMFY_DIR, 'custom_nodes')
  for (const d of fs.existsSync(cn) ? fs.readdirSync(cn) : []) await lire(d, path.join(cn, d))
  return v
}
/** Fige les versions actuelles comme référence. À appeler quand tout marche. */
export async function figerNoeuds() {
  const v = await versions()
  fs.writeFileSync(VERROU, JSON.stringify({ figeLe: new Date().toISOString(), versions: v }, null, 1))
  return { fichier: VERROU, extensions: Object.keys(v).length }
}
async function extensions(p, infos) {
  const v = await versions()
  if (!fs.existsSync(VERROU)) {
    infos.extensions = `${Object.keys(v).length} dépôts — aucune référence figée`
    p.push({ gravite: 'alerte', domaine: 'extensions', quoi: 'aucune version de référence des extensions ComfyUI', conseil: 'figer l\'état actuel une fois que tout fonctionne (POST /api/diagnostic/figer)' })
    return
  }
  const ref = JSON.parse(fs.readFileSync(VERROU, 'utf8'))
  infos.extensions = `${Object.keys(v).length} dépôts · référence du ${String(ref.figeLe).slice(0, 10)}`
  const diff = []
  for (const [n, c] of Object.entries(v)) if (ref.versions[n] && ref.versions[n] !== c) diff.push(`${n} (${ref.versions[n]} → ${c})`)
  const nouv = Object.keys(v).filter(n => !(n in ref.versions))
  const partis = Object.keys(ref.versions).filter(n => !(n in v))
  if (diff.length) p.push({ gravite: 'alerte', domaine: 'extensions', quoi: `${diff.length} dépôt(s) ont changé de version depuis la référence : ${diff.join(' ; ')}`, conseil: 'si un rendu se met à échouer, c\'est le premier suspect ; sinon re-figer la référence' })
  if (nouv.length) p.push({ gravite: 'alerte', domaine: 'extensions', quoi: `extension(s) ajoutée(s) : ${nouv.join(', ')}`, conseil: 're-figer la référence si c\'est voulu' })
  if (partis.length) p.push({ gravite: 'alerte', domaine: 'extensions', quoi: `extension(s) disparue(s) : ${partis.join(', ')}`, conseil: 'vérifier qu\'aucune recette n\'en dépend (contrôle « recettes »)' })
}

async function ollama(p, infos) {
  let tags
  try { tags = await json(CONFIG.ollamaUrl + '/api/tags', 8000) } catch (e) {
    p.push({ gravite: 'bloquant', domaine: 'ollama', quoi: `Ollama ne répond pas (${e.message})`, conseil: 'l\'Enhancer, le carrousel et les captions ne fonctionneront pas — vérifier qu\'Ollama tourne (OLLAMA_URL)' })
    return
  }
  const dispo = new Set((tags.models ?? []).map(m => m.name))
  infos.ollama = `${dispo.size} modèles`
  const requis = new Map()
  for (const [k, m] of Object.entries(CONFIG.composerModels ?? {})) if (m) requis.set(m, [...(requis.get(m) ?? []), `rédacteur ${k}`])
  for (const [k, m] of [['description d\'image', CONFIG.visionDescribeModel]]) if (m) requis.set(m, [...(requis.get(m) ?? []), k])
  for (const [m, roles] of requis) {
    const ok = dispo.has(m) || dispo.has(m + ':latest') || [...dispo].some(d => d.split(':')[0] === m)
    if (!ok) p.push({ gravite: 'bloquant', domaine: 'ollama', quoi: `modèle « ${m} » absent d'Ollama`, conseil: `utilisé comme ${roles.join(', ')} — « ollama pull ${m} » ou corriger la variable d'environnement` })
  }
}

async function outils(p) {
  for (const o of ['ffmpeg', 'ffprobe']) {
    const r = await run(o, ['-version'], 8000)
    if (r.code !== 0) p.push({ gravite: 'bloquant', domaine: 'outils', quoi: `${o} introuvable`, conseil: 'montage, vignettes et encodage en dépendent — « sudo apt install ffmpeg »' })
  }
}

async function disque(p, infos) {
  const vus = new Set()
  for (const [nom, d] of [['médias', CONFIG.mediaDir], ['sorties ComfyUI', CONFIG.comfyOutput]]) {
    try {
      const s = fs.statfsSync(d); const libre = Number(s.bavail) * Number(s.bsize) / 1e9
      const cle = `${s.type}:${s.blocks}`
      if (!vus.has(cle)) infos.disque = `${Math.round(libre)} Go libres`
      vus.add(cle)
      if (libre < 20) p.push({ gravite: libre < 5 ? 'bloquant' : 'alerte', domaine: 'disque', quoi: `${libre.toFixed(0)} Go libres sur le volume des ${nom}`, conseil: 'vider les sorties de bancs ou les brouillons refusés' })
    } catch { p.push({ gravite: 'bloquant', domaine: 'disque', quoi: `dossier des ${nom} inaccessible`, conseil: d }) }
  }
}

/* ---------- orchestration ---------- */

let dernier = null
let enCours = null
/** @param {{recettes?: string[], frais?: boolean}} o — `recettes` : fichiers servis en production. */
export async function diagnostiquer({ recettes = [], frais = false } = {}) {
  if (!frais && dernier && Date.now() - dernier.quand < 120_000) return dernier
  if (enCours) return enCours
  enCours = (async () => {
    const t0 = Date.now(); const p = []; const infos = {}
    const garde = (nom, fn) => fn().catch(e => { p.push({ gravite: 'alerte', domaine: nom, quoi: 'contrôle interrompu', conseil: String(e.message || e).slice(0, 160) }) })
    await Promise.all([
      garde('carte graphique', () => carteGraphique(p, infos)),
      garde('python', () => python(p, infos)),
      garde('comfyui', () => comfy(p, infos, recettes)),
      garde('extensions', () => extensions(p, infos)),
      garde('ollama', () => ollama(p, infos)),
      garde('outils', () => outils(p)),
      garde('disque', () => disque(p, infos)),
    ])
    const ordre = { bloquant: 0, alerte: 1 }
    p.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || a.domaine.localeCompare(b.domaine))
    dernier = { quand: Date.now(), dureeMs: Date.now() - t0, ok: !p.some(x => x.gravite === 'bloquant'),
      bloquants: p.filter(x => x.gravite === 'bloquant').length, alertes: p.filter(x => x.gravite === 'alerte').length,
      problemes: p, infos }
    return dernier
  })().finally(() => { enCours = null })
  return enCours
}
/** Résumé pour /api/health : le dernier diagnostic connu, sans en lancer un. */
export const resumeDiagnostic = () => dernier
  ? { quand: dernier.quand, ok: dernier.ok, bloquants: dernier.bloquants, alertes: dernier.alertes }
  : null
