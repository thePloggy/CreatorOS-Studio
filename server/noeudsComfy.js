/* Mise à niveau de ComfyUI depuis le studio :
   - ComfyUI lui-même (git pull de son dépôt officiel, puis ses requirements) ;
   - nœuds tiers manquants à un workflow : le dépôt GitHub qui les fournit est trouvé dans la carte
     nœud → dépôt de ComfyUI-Manager, cloné dans custom_nodes, ses requirements installés sans toucher
     à torch. Ses scripts d'installation ne sont jamais exécutés.
   La démo publique refuse tout code tiers ; une installation locale du studio l'accepte. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'

export const estDemo = () => fs.existsSync(path.join(CONFIG.dataDir, 'demo-publique'))
export const MESSAGE_DEMO = 'la démo publique n’installe aucun code tiers : installe le studio chez toi (github.com/thePloggy/CreatorOS-Studio) pour ajouter des nœuds en un clic'
const DEPOT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/
const CARTE_URL = 'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json'

const lancer = (cmd, args, opts = {}) => new Promise(ok => {
  let sortie = ''
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', b => { sortie = (sortie + b).slice(-4000) }); p.stderr.on('data', b => { sortie = (sortie + b).slice(-4000) })
  p.on('close', code => ok({ code, sortie })); p.on('error', e => ok({ code: 1, sortie: String(e) }))
})
const pythonComfy = () => (fs.existsSync(CONFIG.comfyPython) ? CONFIG.comfyPython : 'python3')
/* torch, torchvision et torchaudio restent ceux de l'installation (build CUDA choisi pour la carte) */
function requirementsSansTorch(fichier) {
  const lignes = fs.readFileSync(fichier, 'utf8').split('\n').filter(l => !/^\s*(torch|torchvision|torchaudio)\s*([<>=!~;[]|$)/i.test(l))
  const tmp = path.join(os.tmpdir(), `req-${Date.now().toString(36)}.txt`)
  fs.writeFileSync(tmp, lignes.join('\n'))
  return tmp
}

let carte = null
async function lireCarte() {
  if (carte) return carte
  const local = path.join(CONFIG.comfyDir, 'custom_nodes', 'comfyui-manager', 'extension-node-map.json')
  const copie = path.join(CONFIG.dataDir, 'extension-node-map.json')
  try {
    if (fs.existsSync(local)) carte = JSON.parse(fs.readFileSync(local, 'utf8'))
    else {
      if (!fs.existsSync(copie) || Date.now() - fs.statSync(copie).mtimeMs > 86400_000) {
        const r = await fetch(CARTE_URL, { signal: AbortSignal.timeout(30_000) })
        if (r.ok) fs.writeFileSync(copie, await r.text())
      }
      carte = JSON.parse(fs.readFileSync(copie, 'utf8'))
    }
  } catch { carte = {} }
  return carte
}

/** Pour des classes de nœuds absentes : les dépôts GitHub qui les fournissent. */
export async function depotsPour(classes) {
  const c = await lireCarte()
  const parDepot = new Map()
  for (const cl of classes) for (const [url, v] of Object.entries(c)) {
    if (!DEPOT.test(url) || !Array.isArray(v?.[0]) || !v[0].includes(cl)) continue
    const d = parDepot.get(url) ?? { depot: url.replace(/(\.git)?\/?$/, ''), titre: v[1]?.title_aux ?? path.basename(url), classes: [] }
    d.classes.push(cl); parDepot.set(url, d)
  }
  const trouves = [...parDepot.values()]
  return { depots: trouves, inconnus: classes.filter(cl => !trouves.some(d => d.classes.includes(cl))) }
}

const travaux = new Map()   // clé : 'comfyui' ou l'URL du dépôt
export const etat = () => Object.fromEntries(travaux)

export async function installerDepot(depot) {
  if (estDemo()) throw new Error(MESSAGE_DEMO)
  const url = String(depot ?? '').replace(/(\.git)?\/?$/, '')
  if (!DEPOT.test(url)) throw new Error('dépôt GitHub attendu (https://github.com/auteur/projet)')
  const c = await lireCarte()
  if (!Object.keys(c).some(k => k.replace(/(\.git)?\/?$/, '') === url)) throw new Error('dépôt absent de la carte des nœuds de ComfyUI-Manager')
  const nom = path.basename(url)
  const cible = path.join(CONFIG.comfyDir, 'custom_nodes', nom)
  if (fs.existsSync(cible)) throw new Error(`${nom} est déjà dans custom_nodes`)
  if (travaux.get(url)?.etat === 'en cours') throw new Error('installation déjà en cours')
  const suivi = { etat: 'en cours', etape: 'clonage', erreur: null, redemarrage: false }
  travaux.set(url, suivi)
  void (async () => {
    let r = await lancer('git', ['clone', '--depth', '1', `${url}.git`, cible], { timeout: 300_000 })
    if (r.code !== 0) { Object.assign(suivi, { etat: 'échec', erreur: r.sortie.slice(-300) }); return }
    const req = path.join(cible, 'requirements.txt')
    if (fs.existsSync(req)) {
      suivi.etape = 'dépendances'
      const tmp = requirementsSansTorch(req)
      r = await lancer(pythonComfy(), ['-m', 'pip', 'install', '-r', tmp], { timeout: 900_000 })
      fs.rmSync(tmp, { force: true })
      if (r.code !== 0) { Object.assign(suivi, { etat: 'échec', erreur: r.sortie.slice(-300) }); return }
    }
    Object.assign(suivi, { etat: 'fini', etape: null, redemarrage: true, note: fs.existsSync(path.join(cible, 'install.py')) ? 'ce pack a un install.py, que le studio n’exécute pas : lis son README' : null })
  })()
  return suivi
}

/** ComfyUI à jour depuis son dépôt officiel (jamais de fusion forcée), puis ses requirements. */
export async function mettreAJourComfy() {
  if (travaux.get('comfyui')?.etat === 'en cours') throw new Error('mise à jour déjà en cours')
  if (!fs.existsSync(path.join(CONFIG.comfyDir, '.git'))) throw new Error('ComfyUI n’est pas un dépôt git : mets-le à jour à la main')
  const suivi = { etat: 'en cours', etape: 'git', erreur: null, redemarrage: false, avant: null, apres: null }
  travaux.set('comfyui', suivi)
  void (async () => {
    suivi.avant = (await lancer('git', ['-C', CONFIG.comfyDir, 'rev-parse', '--short', 'HEAD'])).sortie.trim()
    const git = args => lancer('git', ['-C', CONFIG.comfyDir, ...args], { timeout: 300_000 })
    // sur une branche : on la tire ; figé sur un commit de master : on avance au dernier commit de master ;
    // figé ailleurs (une version publiée) : on passe à la dernière version publiée
    let r = await git(['fetch', '--tags', 'origin'])
    if (r.code !== 0) { Object.assign(suivi, { etat: 'échec', erreur: r.sortie.slice(-300) }); return }
    if ((await git(['symbolic-ref', '-q', 'HEAD'])).code === 0) r = await git(['pull', '--ff-only'])
    else if ((await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/master'])).code === 0) r = await git(['checkout', '--detach', 'origin/master'])
    else {
      const tag = (await git(['tag', '-l', 'v*', '--sort=-v:refname'])).sortie.split('\n')[0]?.trim()
      r = tag ? await git(['checkout', '--detach', tag]) : { code: 1, sortie: 'aucune version publiée trouvée' }
    }
    if (r.code !== 0) { Object.assign(suivi, { etat: 'échec', erreur: r.sortie.slice(-300) }); return }
    suivi.etape = 'dépendances'
    const tmp = requirementsSansTorch(path.join(CONFIG.comfyDir, 'requirements.txt'))
    r = await lancer(pythonComfy(), ['-m', 'pip', 'install', '-r', tmp], { timeout: 900_000 })
    fs.rmSync(tmp, { force: true })
    if (r.code !== 0) { Object.assign(suivi, { etat: 'échec', erreur: r.sortie.slice(-300) }); return }
    suivi.apres = (await lancer('git', ['-C', CONFIG.comfyDir, 'rev-parse', '--short', 'HEAD'])).sortie.trim()
    Object.assign(suivi, { etat: 'fini', etape: null, redemarrage: suivi.avant !== suivi.apres })
  })()
  return suivi
}

/** Redémarre ComfyUI s'il tourne comme service utilisateur (CREATOROS_COMFY_SERVICE). */
export async function redemarrerComfy(fileVide) {
  if (!fileVide) throw new Error('des rendus sont en cours : redémarre quand la file est vide')
  const service = process.env.CREATOROS_COMFY_SERVICE || 'comfyui.service'
  const existe = await lancer('systemctl', ['--user', 'cat', service])
  if (existe.code !== 0) throw new Error('ComfyUI ne tourne pas comme service : redémarre-le à la main')
  const r = await lancer('systemctl', ['--user', 'restart', service], { timeout: 60_000 })
  if (r.code !== 0) throw new Error(`redémarrage : ${r.sortie.slice(-200)}`)
  for (const v of travaux.values()) v.redemarrage = false
  return { ok: true }
}
