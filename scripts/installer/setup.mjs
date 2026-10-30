#!/usr/bin/env node
/* ============================================================
   Assistant d'installation de CreatorOS Studio — `npm run setup`.

   Ce qu'il fait, dans l'ordre : prérequis de la machine, ComfyUI (trouvé ou
   installé), packs de nœuds, modèles, Ollama, persona. Il DEMANDE avant
   chaque étape qui écrit quelque chose ; `--check` (alias `--dry-run`) ne
   fait que constater.

   La liste des nœuds et des modèles ne vient pas du README : les recettes
   workflows/PROD_*.json sont relues à chaque lancement, et tout fichier ou
   nœud qu'elles nomment sans que modeles.json le connaisse est signalé.

   Il n'écrit aucun secret. HF_TOKEN (dépôts à licence acceptée) est lu dans
   l'environnement, envoyé en en-tête Authorization vers huggingface.co
   seulement, jamais affiché.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline/promises'
import {
  vert, rouge, jaune, gris, gras, titre, ok, ko, alerte, info, octets, tilde, deplier,
  trouver, lire, executer, estComfy, pythonDeComfy, lireExtraPaths, dossiersDe, destinationDe,
  espaceLibre, sonder, tailleParApi, telecharger,
} from './outils.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'modeles.json'), 'utf8'))
const COMFY_GIT = 'https://github.com/comfyanonymous/ComfyUI'

/* ---------- arguments ---------- */

const argv = process.argv.slice(2)
const drapeau = (...n) => n.some(x => argv.includes(x))
const valeur = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith(n + '='))?.slice(n.length + 1) }

if (drapeau('-h', '--help')) {
  console.log(`CreatorOS Studio setup

  npm run setup                     interactive install (asks before every step)
  npm run setup -- --check          report what is present / missing, change nothing
  npm run setup -- --verify-urls    check every model URL of the manifest (HEAD, no download)

Options:
  --comfy <dir>     ComfyUI folder (default: $COMFY_DIR, then ~/ComfyUI)
  --groups a,b      model groups to install, skips the question (see --check for names)
  --yes             answer yes to every question (unattended)
  --vram <GB>       size the install for this card (24, 16, 12 or 8) instead of the detected one
  --keep-full       on a small card, also download the full-size models the light ones replace

Environment: COMFY_DIR, COMFY_PYTHON, COMFY_URL, OLLAMA_URL, CREATOROS_DATA, CREATOROS_VRAM,
HF_TOKEN (gated Hugging Face repos), CREATOROS_TORCH_INDEX (override the PyTorch wheel index).`)
  process.exit(0)
}

const CHECK = drapeau('--check', '--dry-run')
const OUI = drapeau('--yes', '-y')

/* La config du serveur donne les mêmes valeurs par défaut que `npm start`
   (dossier de données, modèles Ollama, URL) : une seule source. */
const { CONFIG } = await import(pathToFileURL(path.join(REPO, 'server', 'config.js')).href)

/* ---------- questions ---------- */

let rl = null
const interactif = process.stdin.isTTY && !CHECK
async function demander(q, def = '') {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const r = (await rl.question(`  ${jaune('?')} ${q}${def ? gris(` [${def}]`) : ''} `)).trim()
  return r || def
}
/** Oui/non. En --check on ne pose rien (et l'on répond non) ; avec --yes, oui. */
async function confirmer(q, def = true) {
  if (CHECK) return false
  if (OUI) { console.log(`  ${jaune('?')} ${q} ${gris('yes (--yes)')}`); return true }
  if (!interactif) return false
  const r = (await demander(`${q} ${gris(def ? '(Y/n)' : '(y/N)')}`)).toLowerCase()
  return r ? r.startsWith('y') : def
}

const bilan = { manque: [], fait: [], suite: [] }

/* ============================================================
   1. Recettes : ce qu'elles demandent vraiment
   ============================================================ */

/* Nœuds que le serveur AJOUTE aux recettes à l'exécution (server/jobs.js,
   server/comfy.js) — ils n'apparaissent dans aucun JSON. Les chemins
   MiniMax et ControlNet Z-Image sont laissés de côté : aucune recette
   livrée ne les emprunte (cf. modeles.json, `_exclus`). */
const INJECTES = ['GrowMaskWithBlur', 'GetImageSizeAndCount', 'ImageToMask', 'RepeatImageBatch', 'ImageCompositeMasked',
  'SetLatentNoiseMask', 'SolidMask', 'ImageCrop', 'RIFE VFI', 'LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo']

const EXT_MODELE = /\.(safetensors|gguf|pth|pt|ckpt|bin|onnx)$/i

function lireRecettes() {
  const dir = CONFIG.workflowsDir
  const recettes = {}
  for (const f of fs.readdirSync(dir).filter(f => /^PROD_.*\.json$/.test(f)).sort()) {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const classes = new Set(), modeles = new Set()
    for (const n of Object.values(g)) {
      if (!n?.class_type) continue
      classes.add(n.class_type)
      for (const v of Object.values(n.inputs ?? {})) if (typeof v === 'string' && EXT_MODELE.test(v)) modeles.add(v)
    }
    recettes[f] = { classes, modeles }
  }
  return recettes
}

const RECETTES = lireRecettes()
const CLASSES_PACK = new Map(MANIFESTE.noeuds.flatMap(p => p.classes.map(c => [c, p.nom])))
const CLASSES_REQUISES = new Set([...Object.values(RECETTES).flatMap(r => [...r.classes]), ...INJECTES])
const CLASSES_COEUR = [...CLASSES_REQUISES].filter(c => !CLASSES_PACK.has(c)).sort()

/** Le manifeste suit-il les recettes ? Un fichier nommé par une recette et
    inconnu de modeles.json serait silencieusement oublié à l'installation. */
function controlerManifeste() {
  const connus = new Set(MANIFESTE.modeles.map(m => m.chemin))
  const ecarts = []
  for (const [f, r] of Object.entries(RECETTES))
    for (const m of r.modeles) if (!connus.has(m)) ecarts.push(`${f} loads ${m}, which is not in scripts/installer/modeles.json`)
  return ecarts
}

/* ============================================================
   2. Prérequis
   ============================================================ */

function versionPython(cmd, args = ['--version']) {
  const r = lire(cmd, args)
  return (r.out + r.err).match(/Python (\d+\.\d+\.\d+)/)?.[1] ?? null
}

/** Un Python 3.12 utilisable pour créer un venv : uv d'abord, sinon le PATH. */
function trouverPython312(uv) {
  if (uv) {
    const r = lire(uv, ['python', 'find', '3.12'])
    if (r.code === 0 && r.out.trim()) return { cmd: r.out.trim(), version: versionPython(r.out.trim()), via: 'uv' }
  }
  for (const c of ['python3.12', 'python3', 'python']) {
    const p = trouver(c)
    const v = p && versionPython(p)
    if (v?.startsWith('3.12.')) return { cmd: p, version: v, via: 'PATH' }
  }
  return null
}

function gpu() {
  const smi = trouver('nvidia-smi')
  if (!smi) return null
  const q = lire(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  if (q.code !== 0 || !q.out.trim()) return { erreur: (q.err || q.out).trim().split('\n')[0] }
  const [nom, mem, pilote] = q.out.trim().split('\n')[0].split(',').map(s => s.trim())
  const cuda = lire(smi, []).out.match(/CUDA Version:\s*([\d.]+)/)?.[1] ?? null
  return { nom, vram: Number(mem) * 1024 * 1024, pilote, cuda }
}

/* Index de roues PyTorch selon le CUDA que le pilote sait servir : on prend
   le plus récent que le pilote couvre. CREATOROS_TORCH_INDEX l'emporte. */
function indexTorch(cuda) {
  if (process.env.CREATOROS_TORCH_INDEX) return process.env.CREATOROS_TORCH_INDEX
  const v = Number(cuda) || 0
  const tag = v >= 13.2 ? 'cu132' : v >= 13.0 ? 'cu130' : v >= 12.9 ? 'cu129' : v >= 12.6 ? 'cu126' : null
  return tag && `https://download.pytorch.org/whl/${tag}`
}

function prerequis() {
  titre('1. Prerequisites')
  const p = {}
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node ${process.versions.node}`)
  else { ko(`Node ${process.versions.node} (22.5+ required, the server uses node:sqlite)`, 'install Node 22 LTS: https://nodejs.org or `nvm install 22`'); bilan.manque.push('Node ≥ 22.5') }

  for (const [cmd, conseil] of [
    ['git', 'sudo apt install git'],
    ['ffmpeg', 'sudo apt install ffmpeg'],
  ]) {
    const chemin = trouver(cmd)
    if (chemin) ok(cmd, lire(chemin, ['-version']).out.split('\n')[0].slice(0, 60) || lire(chemin, ['--version']).out.split('\n')[0])
    else { ko(`${cmd} not found`, conseil); bilan.manque.push(cmd) }
    p[cmd] = chemin
  }

  p.uv = trouver('uv')
  p.python = trouverPython312(p.uv)
  if (p.python) ok(`Python ${p.python.version}`, `${tilde(p.python.cmd)}${p.uv ? ' (uv available)' : ''}`)
  else alerte('Python 3.12 not found (only needed to install ComfyUI)',
    p.uv ? '`uv python install 3.12`' : 'install uv (curl -LsSf https://astral.sh/uv/install.sh | sh), then `uv python install 3.12`')
  if (!p.uv) info('uv not found: pip/venv will be used (uv is faster: https://docs.astral.sh/uv/)')

  p.gpu = gpu()
  if (!p.gpu) { ko('nvidia-smi not found: no NVIDIA driver', 'install the NVIDIA driver (Ubuntu: `sudo ubuntu-drivers install`), then reboot'); bilan.manque.push('NVIDIA driver') }
  else if (p.gpu.erreur) { ko(`nvidia-smi fails: ${p.gpu.erreur}`, 'the driver does not match the running kernel: reinstall it or reboot'); bilan.manque.push('NVIDIA driver') }
  else {
    ok(`${p.gpu.nom}, ${octets(p.gpu.vram)} VRAM`, `driver ${p.gpu.pilote}, CUDA ${p.gpu.cuda ?? '?'}`)
    if (p.gpu.vram < 23e9) alerte('less than 24 GB of VRAM: video recipes are sized for a 32 GB card and may run out of memory')
  }
  return p
}

/* ============================================================
   3. ComfyUI
   ============================================================ */

async function localiserComfy() {
  /* Un dossier désigné (--comfy, COMFY_DIR) est pris au mot : s'il n'est pas
     un ComfyUI, c'est là qu'on propose d'installer, sans aller en chercher
     un autre ailleurs. */
  const designe = valeur('--comfy') ?? process.env.COMFY_DIR
  const defaut = deplier(designe ?? path.join(os.homedir(), 'ComfyUI'))
  if (estComfy(defaut)) return path.resolve(defaut)
  if (CHECK || (!interactif && !OUI)) return null
  if (designe || OUI) return path.resolve(defaut)
  const saisi = deplier(await demander('ComfyUI folder (an existing install, or where to install it):', tilde(defaut)))
  return path.resolve(saisi)
}

async function installerComfy(dir, p) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    ko(`${tilde(dir)} exists and is not a ComfyUI folder`, 'choose an empty folder or an existing ComfyUI (--comfy <dir>)')
    return false
  }
  if (!p.git) { ko('git is required to install ComfyUI'); return false }
  if (!await confirmer(`Install ComfyUI into ${tilde(dir)}? (git clone ${COMFY_GIT})`)) return false
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await executer(p.git, ['clone', '--depth', '1', COMFY_GIT, dir])
  bilan.fait.push(`ComfyUI cloned into ${tilde(dir)}`)
  return true   // venv et torch : etapeComfy enchaîne sur preparerVenv
}

/** venv de ComfyUI, PyTorch CUDA, requirements — pour une installation
    neuve, ou un ComfyUI présent sans venv. Jamais appelé sur un venv qui a
    déjà torch : on ne touche pas à un ComfyUI qui marche. */
async function preparerVenv(dir, p) {
  if (!p.python && p.uv && await confirmer('Python 3.12 is missing. Install it with uv?')) {
    await executer(p.uv, ['python', 'install', '3.12'])
    p.python = trouverPython312(p.uv)
  }
  const venv = path.join(dir, 'venv')
  let py = pythonDeComfy(dir)
  if (!py) {
    if (!p.python) { ko('no Python 3.12: stopping before the venv', 'install Python 3.12, then re-run `npm run setup`'); return }
    if (!await confirmer(`Create the virtualenv ${tilde(venv)} (Python ${p.python.version}${p.uv ? ', uv' : ''})?`)) return
    if (p.uv) await executer(p.uv, ['venv', '--python', p.python.cmd, venv])
    else await executer(p.python.cmd, ['-m', 'venv', venv])
    py = path.join(venv, 'bin', 'python')
    bilan.fait.push(`venv ${tilde(venv)}`)
  }

  const idx = indexTorch(p.gpu?.cuda)
  if (!idx) alerte('could not pick a CUDA build of PyTorch from the driver version', 'set CREATOROS_TORCH_INDEX, e.g. https://download.pytorch.org/whl/cu130')
  else if (await confirmer(`Install PyTorch (CUDA, ${idx.split('/').pop()}) into the venv? (~3-5 GB)`)) {
    await pip(py, p, ['torch', 'torchvision', 'torchaudio', '--index-url', idx])
    bilan.fait.push(`PyTorch (${idx.split('/').pop()})`)
  }
  if (await confirmer('Install ComfyUI requirements (requirements.txt)?')) {
    await pip(py, p, ['-r', path.join(dir, 'requirements.txt')])
    bilan.fait.push('ComfyUI requirements')
  }
}

/** pip dans le venv de ComfyUI — via uv s'il est là (un venv créé par uv
    n'a pas toujours pip). */
function pip(py, p, args) {
  return p.uv ? executer(p.uv, ['pip', 'install', '--python', py, ...args]) : executer(py, ['-m', 'pip', 'install', ...args])
}

/* Les nœuds cœur que les recettes emploient (WanAnimate2ToVideo, SAM3_*,
   LTXV*, ResolutionSelector…) n'existent que dans un ComfyUI récent. Sans
   ComfyUI en marche, on les cherche dans ses sources. */
function noeudsCoeurAbsents(dir) {
  let src = ''
  const lireDir = d => { try { for (const f of fs.readdirSync(d)) if (f.endsWith('.py')) src += fs.readFileSync(path.join(d, f), 'utf8') } catch { /* absent */ } }
  try { src += fs.readFileSync(path.join(dir, 'nodes.py'), 'utf8') } catch { /* absent */ }
  lireDir(path.join(dir, 'comfy_extras'))
  return CLASSES_COEUR.filter(c => !src.includes(`"${c}"`) && !src.includes(`'${c}'`) && !new RegExp(`class ${c}\\b`).test(src))
}

/** /object_info si ComfyUI tourne : la seule vérité sur les nœuds chargés.
    Encore faut-il que l'instance qui répond soit CELLE du dossier examiné
    (un ComfyUI déjà en service sur le port pendant qu'on en installe un
    second) : /internal/folder_paths dit quels dossiers elle sert. */
async function objectInfo(dir) {
  try {
    const f = await fetch(new URL('/internal/folder_paths', CONFIG.comfyUrl), { signal: AbortSignal.timeout(5000) })
    if (f.ok) {
      const racine = path.join(path.resolve(dir), 'models') + path.sep
      const sert = Object.values(await f.json()).flat().some(d => typeof d === 'string' && (d + path.sep).startsWith(racine))
      if (!sert) return { autre: true }
    }
    const r = await fetch(new URL('/object_info', CONFIG.comfyUrl), { signal: AbortSignal.timeout(8000) })
    return r.ok ? new Set(Object.keys(await r.json())) : null
  } catch { return null }
}

async function etapeComfy(p) {
  titre('2. ComfyUI')
  let dir = await localiserComfy()
  if (!dir) {
    ko('ComfyUI not found (COMFY_DIR, ~/ComfyUI)', CHECK ? 'run `npm run setup` to install it, or pass --comfy <dir>' : '')
    bilan.manque.push('ComfyUI')
    return null
  }
  if (!estComfy(dir)) {
    if (!await installerComfy(dir, p)) { bilan.manque.push('ComfyUI'); return null }
    if (!estComfy(dir)) return null
  }
  const g = lire('git', ['-C', dir, 'log', '-1', '--format=%h %cs'])
  ok(`ComfyUI ${tilde(dir)}`, g.code === 0 ? `commit ${g.out.trim()}` : '')

  let py = pythonDeComfy(dir)
  const torchAbsent = !CHECK && py && /PY \S+ None/.test(lire(py, ['-I', '-c', 'import sys\ntry:\n import torch; t=torch.__version__\nexcept Exception: t=None\nprint("PY", sys.version.split()[0], t)'], 120_000).out)
  if (!CHECK && (!py || torchAbsent)) { await preparerVenv(dir, p); py = pythonDeComfy(dir) }
  if (!py) { ko('no venv found in the ComfyUI folder (venv/ or .venv/)', 'run `npm run setup` to create it, or set COMFY_PYTHON to the Python ComfyUI runs with'); bilan.manque.push('ComfyUI venv') }
  else {
    // Lecture seule : version de Python et de torch, CUDA visible ou non.
    const r = lire(py, ['-I', '-c', 'import sys\ntry:\n import torch; t=torch.__version__; c=torch.cuda.is_available()\nexcept Exception as e: t=None; c=False\nprint("PY", sys.version.split()[0], t, c)'], 120_000)
    const m = r.out.match(/PY (\S+) (\S+) (True|False)/)
    if (!m) { ko(`the ComfyUI Python does not start (${tilde(py)})`, (r.err.trim().split('\n').pop() || '').slice(0, 160)); bilan.manque.push('ComfyUI Python') }
    else if (m[2] === 'None') { ko(`torch is not installed in ${tilde(py)}`, `install a CUDA build: ${indexTorch(p.gpu?.cuda) ?? 'https://pytorch.org/get-started/locally/'}`); bilan.manque.push('torch') }
    else if (m[3] !== 'True') { alerte(`Python ${m[1]}, torch ${m[2]}, but CUDA is not available to torch`, 'check the driver (nvidia-smi) and that torch is a CUDA build'); }
    else ok(`Python ${m[1]}, torch ${m[2]}, CUDA ok`, tilde(py))
  }

  let actifs = await objectInfo(dir)
  if (actifs?.autre) { info(`the ComfyUI answering at ${CONFIG.comfyUrl} serves another folder: checking ${tilde(dir)} from its files`); actifs = null }
  const absents = actifs ? CLASSES_COEUR.filter(c => !actifs.has(c)) : noeudsCoeurAbsents(dir)
  if (actifs) ok(`ComfyUI is running at ${CONFIG.comfyUrl}`, `${actifs.size} node types loaded`)
  if (absents.length) {
    alerte(`ComfyUI is missing core nodes the recipes use: ${absents.join(', ')}`, `update ComfyUI: git -C ${tilde(dir)} pull, then pip install -r requirements.txt`)
    bilan.manque.push(`core nodes (${absents.length})`)
  } else ok(`all ${CLASSES_COEUR.length} core node types used by the recipes are ${actifs ? 'loaded' : 'present in the source'}`)
  return { dir, py, actifs }
}

/* ============================================================
   4. Packs de nœuds
   ============================================================ */

/* Les requirements d'un pack listent parfois torch/torchvision sans version :
   les laisser passer pourrait remplacer la build CUDA du venv par une autre.
   On les retire avant pip. */
function requirementsSansTorch(fichier) {
  const lignes = fs.readFileSync(fichier, 'utf8').split('\n')
    .filter(l => !/^\s*(torch|torchvision|torchaudio)\s*([<>=!~;[]|$)/i.test(l))
  const tmp = path.join(os.tmpdir(), `creatoros-req-${process.pid}-${path.basename(path.dirname(fichier))}.txt`)
  fs.writeFileSync(tmp, lignes.join('\n'))
  return tmp
}

function packPresent(customDir, nom) {
  try { return fs.readdirSync(customDir).find(d => d.toLowerCase() === nom.toLowerCase()) ?? null } catch { return null }
}

async function etapeNoeuds(comfy, p, groupes) {
  titre('4. Custom node packs')
  info(`derived from the recipes: ${CLASSES_REQUISES.size} node types, ${CLASSES_PACK.size} of them from custom packs`)
  const custom = path.join(comfy.dir, 'custom_nodes')
  const manquants = []
  for (const pack of MANIFESTE.noeuds) {
    const vise = pack.groupes.some(g => groupes.includes(g))
    const dossier = packPresent(custom, pack.nom)
    const charges = comfy.actifs ? pack.classes.filter(c => !comfy.actifs.has(c)) : []
    const pour = gris(`(${pack.groupes.join(', ')})`)
    if (dossier && !charges.length) ok(`${pack.nom} ${pour}`)
    else if (dossier) alerte(`${pack.nom} is installed but ComfyUI does not load ${charges.join(', ')}`, 'look at the ComfyUI startup log for an import error in this pack')
    else if (vise) { ko(`${pack.nom} missing ${pour}`); manquants.push(pack) }
    else info(`${pack.nom} not installed, not needed for the selected groups`)
  }
  if (!manquants.length || CHECK) { if (manquants.length) bilan.manque.push(`node packs: ${manquants.map(x => x.nom).join(', ')}`); return }

  if (!comfy.py) { alerte('no ComfyUI venv: cannot install node requirements'); return }
  for (const pack of manquants) {
    if (!await confirmer(`Install ${pack.nom}? (git clone + pip install of its requirements into ComfyUI's venv)`)) { bilan.manque.push(pack.nom); continue }
    const cible = path.join(custom, pack.nom)
    try {
      await executer(p.git ?? 'git', ['clone', '--depth', '1', pack.depot, cible])
      const req = path.join(cible, pack.requirements ?? 'requirements.txt')
      if (fs.existsSync(req)) {
        const tmp = requirementsSansTorch(req)
        try { await pip(comfy.py, p, ['-r', tmp]) } finally { fs.rmSync(tmp, { force: true }) }
      }
      bilan.fait.push(pack.nom)
    } catch (e) { ko(`${pack.nom}: ${e.message}`); bilan.manque.push(pack.nom) }
  }
  bilan.suite.push('restart ComfyUI so it loads the new node packs')
}

/* ============================================================
   5. Modèles
   ============================================================ */

function etatModeles(comfyDir) {
  const extra = lireExtraPaths(comfyDir)
  return {
    extra,
    modeles: MANIFESTE.modeles.map(m => {
      if (m.racine === 'custom_nodes') {
        const f = path.join(comfyDir, 'custom_nodes', m.chemin)
        return { ...m, present: fs.existsSync(f) ? f : null, dest: f }
      }
      const candidats = dossiersDe(m.dossier, comfyDir, extra).map(d => path.join(d, m.chemin))
      const present = candidats.find(f => fs.existsSync(f)) ?? null
      // Un lien symbolique dont la cible a disparu : le nom est là, le fichier non.
      const casse = present ? null : candidats.find(f => { try { return fs.lstatSync(f).isSymbolicLink() } catch { return false } }) ?? null
      return { ...m, present, casse, dest: path.join(destinationDe(m.dossier, comfyDir, extra), m.chemin) }
    }),
  }
}

/* « Ta carte peut-elle le faire ? » (27/10) : estimation, pas mesure. Le plus gros modèle
   de diffusion du groupe doit tenir en VRAM, plus ~3 Go pour les activations et le VAE ;
   ComfyUI décharge les encodeurs de texte. Sous 75 % du besoin, le déchargement partiel
   devient trop lent ou finit en manque de mémoire. */
const DIFFUSION = new Set(['diffusion_models', 'unet', 'checkpoints', 'unet_gguf'])
function besoinVram(modeles, g) {
  const gros = Math.max(0, ...modeles.filter(m => m.groupes.includes(g) && DIFFUSION.has(m.dossier)).map(m => m.taille))
  return gros ? gros + 3e9 : 0
}
function verdictVram(besoin, vram) {
  if (!besoin || !vram) return ''
  const t = `≈ ${Math.ceil(besoin / 1e9)} GB VRAM`
  return vram >= besoin ? vert(`${t}, fits your card`) : vram >= 0.75 * besoin ? jaune(`${t}, tight: slow, may run out of memory`) : rouge(`${t}, likely too big for your ${Math.round(vram / 1e9)} GB card`)
}

async function choisirGroupes(modeles, vram, profil = 24) {
  const noms = Object.keys(MANIFESTE.groupes)
  // sous 16 Go, Klein (allégé) remplace Krea 2 comme moteur photo
  const defaut = g => profil < 16 && g === 'photo_klein' ? true : profil < 16 && g === 'photo' ? false : MANIFESTE.groupes[g].defaut
  const lignes = noms.map((g, i) => {
    const du = modeles.filter(m => m.groupes.includes(g))
    const manque = du.filter(m => !m.present)
    const taille = manque.reduce((s, m) => s + m.taille, 0)
    const etat = manque.length ? jaune(`${manque.length}/${du.length} missing, ${octets(taille)}`) : vert('complete')
    const v = verdictVram(besoinVram(modeles, g), vram)
    return `   ${String(i + 1).padStart(2)}. ${g.padEnd(15)} ${MANIFESTE.groupes[g].label}\n       ${etat}${v ? `  ·  ${v}` : ''}`
  })
  console.log(lignes.join('\n'))
  const imposes = valeur('--groups')
  if (imposes) return imposes.split(',').map(s => s.trim()).filter(g => noms.includes(g))
  if (CHECK) return noms
  if (OUI) return noms.filter(defaut)
  if (!interactif) return []
  const def = noms.map((g, i) => defaut(g) ? i + 1 : null).filter(Boolean).join(',')
  const r = await demander('Groups to install (numbers, comma-separated; "a" = all, "0" = none):', def)
  if (r === '0') return []
  if (r.toLowerCase() === 'a') return noms
  return [...new Set(r.split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= noms.length).map(n => noms[n - 1]))]
}

/* Petites cartes (30/10) : le profil (24, 16, 12, 8 Go) décide quelles variantes
   allégées du manifeste (`leger`) remplacent les modèles lourds. Le serveur fait la
   même substitution à l'envoi (server/allege.js) ; ici on ne télécharge que ce qui
   servira. Mêmes marches que le serveur. */
const profilDe = o => { const go = o / 2 ** 30; return !go ? 24 : go >= 22 ? 24 : go >= 14 ? 16 : go >= 10 ? 12 : 8 }
function selonCarte(modeles, profil) {
  const nom = m => m.chemin.split('/').pop()
  const tient = r => modeles.find(m => nom(m) === r)?.tient ?? 24
  const gardees = new Set()
  for (const r of new Set(modeles.filter(m => m.leger).map(m => m.leger.remplace))) {
    if (profil >= tient(r)) continue
    const vs = modeles.filter(m => m.leger?.remplace === r)
    const passe = vs.filter(v => v.leger.pour <= profil).sort((a, b) => b.leger.pour - a.leger.pour)
    const v = passe[0] ?? [...vs].sort((a, b) => a.leger.pour - b.leger.pour)[0]
    if (v) gardees.add(nom(v))
  }
  const remplaces = new Set(modeles.filter(m => gardees.has(nom(m))).map(m => m.leger.remplace))
  return modeles.filter(m => m.leger ? gardees.has(nom(m)) : drapeau('--keep-full') || !remplaces.has(nom(m)))
}

async function etapeGroupes(comfy, vram) {
  titre('3. Features')
  const etat = etatModeles(comfy.dir)
  if (etat.extra.length) info(`extra_model_paths.yaml: ${etat.extra.map(s => `${s.nom} → ${tilde(s.base)}${s.defaut ? ' (default)' : ''}`).join(', ')}`)
  for (const e of controlerManifeste()) alerte(e)
  const force = Number(valeur('--vram') ?? process.env.CREATOROS_VRAM)
  const profil = [24, 16, 12, 8].includes(force) ? force : profilDe(vram)
  if (force) vram = force * 1e9
  const modeles = selonCarte(etat.modeles, profil)
  const legers = modeles.filter(m => m.leger)
  if (legers.length) {
    info(`${profil} GB profile: ${legers.length} light model(s) replace the full-size ones (same recipes, quantized or smaller weights)`)
    for (const m of legers) info(`  ${m.leger.remplace} → ${m.chemin}`)
    info('the studio picks them automatically at render time; --keep-full also downloads the originals')
  }
  if (profil < 16) info('photos: Krea 2 (13 GB) is too big for this card, the studio uses FLUX.2 Klein instead (install photo_klein)')
  return { ...etat, modeles, profil, groupes: await choisirGroupes(modeles, vram, profil) }
}

async function etapeModeles({ modeles, groupes }) {
  titre('5. Models')
  const vises = modeles.filter(m => m.groupes.some(g => groupes.includes(g)))
  const manquants = vises.filter(m => !m.present)

  if (CHECK) {
    for (const m of modeles) {
      if (m.present) ok(m.chemin, gris(tilde(m.present)))
      else ko(`${m.chemin}  ${octets(m.taille)}${m.gated ? jaune('  gated, needs HF_TOKEN') : ''}`,
        `${m.groupes.join(', ')} · ${m.licence}${m.casse ? ` · broken symlink: ${tilde(m.casse)} → ${fs.readlinkSync(m.casse)}` : ''}`)
    }
    const total = manquants.reduce((s, m) => s + m.taille, 0)
    if (manquants.length) bilan.manque.push(`${manquants.length} model file(s) (${octets(total)})`)
    return
  }

  if (!manquants.length) { ok(groupes.length ? 'every model of the selected groups is present' : 'no group selected'); return }
  const total = manquants.reduce((s, m) => s + m.taille, 0)
  console.log(`\n  ${gras(`${manquants.length} files to download, ${octets(total)}`)}`)
  for (const m of manquants) info(`${octets(m.taille).padStart(8)}  ${m.chemin}  → ${tilde(path.dirname(m.dest))}${m.gated ? jaune('  (gated)') : ''}`)

  // Espace disque, par système de fichiers de destination.
  const parFs = new Map()
  for (const m of manquants) {
    const e = espaceLibre(m.dest)
    const cle = e.dev ?? e.ancre
    const cur = parFs.get(cle) ?? { ...e, besoin: 0 }
    cur.besoin += m.taille
    parFs.set(cle, cur)
  }
  for (const e of parFs.values()) {
    if (e.libre < e.besoin * 1.05) alerte(`not enough space on ${tilde(e.ancre)}: ${octets(e.libre)} free, ${octets(e.besoin)} needed`)
    else info(`${tilde(e.ancre)}: ${octets(e.libre)} free`)
  }

  const gated = manquants.filter(m => m.gated)
  if (gated.length) {
    if (process.env.HF_TOKEN) info('HF_TOKEN is set: it will be sent to huggingface.co only')
    else alerte(`${gated.length} files come from gated repos (accept the licence on the model page first)`,
      'export HF_TOKEN=<your read token> before running setup (https://huggingface.co/settings/tokens); they are skipped otherwise')
  }
  if (!await confirmer(`Download ${manquants.length} files (${octets(total)})? Interrupted downloads resume on the next run.`)) {
    bilan.manque.push(`${manquants.length} model file(s) (${octets(total)})`)
    return
  }
  let i = 0
  for (const m of manquants) {
    i++
    console.log(`  [${i}/${manquants.length}] ${m.chemin} ${gris(octets(m.taille))}`)
    if (m.gated && !process.env.HF_TOKEN) { alerte('skipped: gated repo and no HF_TOKEN'); bilan.manque.push(m.chemin); continue }
    try {
      const r = await telecharger(m.url, m.dest, m.taille)
      ok(tilde(m.dest), r?.ecart ? jaune(`size differs from the manifest (${octets(r.taille)}): the repo republished it`) : '')
      bilan.fait.push(m.chemin)
    } catch (e) { ko(`${m.chemin}: ${e.message}`, m.url); bilan.manque.push(m.chemin) }
  }
}

/* ============================================================
   6. Ollama
   ============================================================ */

async function etapeOllama() {
  titre('6. Ollama')
  const voulus = [...new Set([CONFIG.composerModels.sfw, CONFIG.visionDescribeModel])]
  const cli = trouver('ollama')
  let tags = null
  try {
    const r = await fetch(new URL('/api/tags', CONFIG.ollamaUrl), { signal: AbortSignal.timeout(5000) })
    if (r.ok) tags = (await r.json()).models?.map(m => m.name) ?? []
  } catch { /* injoignable */ }
  if (!cli && !tags) {
    ko('Ollama not found', 'install it: curl -fsSL https://ollama.com/install.sh | sh  (https://ollama.com/download)')
    bilan.manque.push('Ollama')
    return
  }
  if (!tags) {
    ko(`Ollama is installed but not reachable at ${CONFIG.ollamaUrl}`, 'start it: `ollama serve` (or `sudo systemctl start ollama`)')
    bilan.manque.push('Ollama service')
    return
  }
  ok(`Ollama at ${CONFIG.ollamaUrl}`, `${tags.length} models`)
  // « mistral-small » et « mistral-small:latest » désignent le même modèle.
  const aLe = n => tags.some(t => t === n || t === `${n}:latest` || `${t}:latest` === n)
  for (const m of voulus) {
    const role = m === CONFIG.visionDescribeModel ? 'vision (CREATOROS_VLM_DESCRIBE)' : 'prompt rewriter (CREATOROS_LLM)'
    if (aLe(m)) { ok(m, role); continue }
    ko(`${m} missing`, role)
    if (CHECK) { bilan.manque.push(`ollama ${m}`); continue }
    if (!await confirmer(`Pull ${m}?`)) { bilan.manque.push(`ollama ${m}`); continue }
    try {
      if (cli) await executer(cli, ['pull', m])
      else await tirerParApi(m)
      bilan.fait.push(`ollama ${m}`)
    } catch (e) { ko(`${m}: ${e.message}`); bilan.manque.push(`ollama ${m}`) }
  }
}

/** Sans CLI (Ollama distant) : /api/pull, en flux de lignes JSON. */
async function tirerParApi(nom) {
  const r = await fetch(new URL('/api/pull', CONFIG.ollamaUrl), { method: 'POST', body: JSON.stringify({ name: nom }) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  let reste = ''
  for await (const bout of r.body) {
    reste += Buffer.from(bout).toString()
    const lignes = reste.split('\n'); reste = lignes.pop()
    for (const l of lignes) {
      if (!l.trim()) continue
      const j = JSON.parse(l)
      if (j.error) throw new Error(j.error)
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K      ${j.status}${j.total ? ` ${(100 * (j.completed ?? 0) / j.total).toFixed(0)}%` : ''}`)
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K')
}

/* ============================================================
   7. Persona
   ============================================================ */

async function etapePersona() {
  titre('7. Character (persona.json)')
  const f = CONFIG.personaFile
  if (fs.existsSync(f)) { ok(tilde(f)); return }
  alerte(`no ${tilde(f)}: the app will run on the base models, without a trigger word`)
  if (await confirmer(`Create it from persona.example.json? (edit it afterwards)`, true)) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.copyFileSync(path.join(REPO, 'persona.example.json'), f, fs.constants.COPYFILE_EXCL)
    ok(`created ${tilde(f)}`)
    bilan.fait.push('persona.json')
    bilan.suite.push(`edit ${tilde(f)} (name, trigger, LoRA files) — use a character you own`)
  }
}

/* ============================================================
   Vérification des URL du manifeste
   ============================================================ */

async function verifierUrls() {
  titre('Manifest URLs (HEAD, no download, no token)')
  let ecarts = 0
  for (const m of MANIFESTE.modeles) {
    try {
      const s = await sonder(m.url)
      let taille = s.taille
      // Dépôt à licence acceptée : HEAD répond 401, l'API liste encore la taille.
      if (s.statut === 401 && s.erreur === 'GatedRepo') taille = await tailleParApi(m.url)
      const joignable = s.statut < 400 || s.erreur === 'GatedRepo'
      if (!joignable) { ko(`${m.chemin}  HTTP ${s.statut}`, m.url); ecarts++ }
      else if (taille !== m.taille) { alerte(`${m.chemin}  size ${octets(taille)} ≠ manifest ${octets(m.taille)}`, m.url); ecarts++ }
      else ok(m.chemin, `${octets(taille)}${s.erreur === 'GatedRepo' ? ' · gated' : ''}${m.verifie === false ? ' · marked unverified' : ''}`)
    } catch (e) { ko(`${m.chemin}: ${e.message}`, m.url); ecarts++ }
  }
  for (const e of controlerManifeste()) { alerte(e); ecarts++ }
  console.log(ecarts ? `\n  ${rouge(`${ecarts} issue(s)`)}` : `\n  ${vert('all URLs answer with the expected size')}`)
  process.exitCode = ecarts ? 1 : 0
}

/* ============================================================
   Déroulé
   ============================================================ */

async function principal() {
  console.log(gras(`CreatorOS Studio setup${CHECK ? '  (check only, nothing will be changed)' : ''}`))
  if (!CHECK && !interactif && !OUI) {
    alerte('stdin is not a terminal: running as --check (use --yes for an unattended install)')
  }
  const p = prerequis()
  const comfy = await etapeComfy(p)
  let groupes = null
  if (comfy) {
    // Le choix des fonctions vient d'abord : il décide des packs ET des modèles.
    const etat = await etapeGroupes(comfy, p.gpu?.vram)
    groupes = etat.groupes
    await etapeNoeuds(comfy, p, groupes)
    await etapeModeles(etat)
  } else {
    for (const t of ['3. Features', '4. Custom node packs', '5. Models']) { titre(t); info('skipped: no ComfyUI') }
  }
  await etapeOllama()
  await etapePersona()

  titre('Summary')
  if (bilan.fait.length) for (const f of bilan.fait) ok(f)
  if (bilan.manque.length) for (const m of bilan.manque) ko(m)
  if (!bilan.fait.length && !bilan.manque.length) ok('nothing to do')
  if (groupes?.length && !CHECK) info(`model groups: ${groupes.join(', ')}`)

  titre('Next')
  const etapes = [...bilan.suite]
  if (!fs.existsSync(path.join(REPO, 'node_modules'))) etapes.push('npm ci')
  etapes.push('npm run build', 'npm start            # http://127.0.0.1:8787')
  if (comfy && path.resolve(comfy.dir) !== path.resolve(CONFIG.comfyDir)) etapes.unshift(`export COMFY_DIR=${tilde(comfy.dir)}   # before npm start`)
  for (const e of etapes) console.log(`    ${e}`)
  if (CHECK && bilan.manque.length) process.exitCode = 1
}

try {
  if (drapeau('--verify-urls')) await verifierUrls()
  else await principal()
} catch (e) {
  console.error(`\n${rouge('setup failed:')} ${e.message}`)
  process.exitCode = 1
} finally {
  rl?.close()
}
