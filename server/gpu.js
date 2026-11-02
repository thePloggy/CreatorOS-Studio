/* ============================================================
   Arbitrage de la carte graphique entre ComfyUI et Ollama.

   POURQUOI. Deux programmes se partagent la carte graphique sans se connaître :
   ComfyUI (Krea, Wan, LTX, MiniMax…) et Ollama (rédacteurs, VLM, trieur).
   Mesuré sur un appel de la taille du carrousel (qwen3.5:35b,
   3 690 jetons lus, ~500 écrits) :
       CPU                          53 s
       partagé (Krea resté chargé)  30 s  — carte à 31,5 Go sur 32
       carte entière                 6 s
   et le rendu Krea qui suit paie ~5 s de rechargement (12,2 s au lieu de 7,1).

   RÈGLE :
   - un seul programme occupe la carte ; deux tâches du MÊME programme
     s'enchaînent sans rien décharger (image derrière image, appel LLM
     derrière appel LLM) ;
   - on ne vide jamais par précaution : on vide l'autre seulement quand il
     faut la carte pour soi (/free pour ComfyUI, déchargement vérifié sur
     /api/ps pour Ollama) ;
   - file d'arrivée : un appel LLM qui attend passe avant le rendu suivant ;
   - un appel LLM n'attend pas un LONG rendu (vidéo de 14 min) : il part sur
     le CPU ;
   - un appel Ollama lancé DEPUIS un job de rendu (contrôle VLM du motion)
     n'est pas arbitré : le job tient déjà la carte, il s'attendrait lui-même.
   ============================================================ */
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONFIG } from './config.js'

/** Au-delà de ce reste estimé, un appel Ollama ne patiente pas derrière le
 *  rendu en cours : il part sur le CPU. */
const ATTENTE_MAX_MS = 60_000
/** Arbitrage coupé : CREATOROS_LLM_GPU=0 → tout Ollama sur le CPU. */
const ACTIF = process.env.CREATOROS_LLM_GPU !== '0'

let occupant = null      // 'comfy' | 'ollama' | null (inconnu au démarrage)
let actifs = 0           // tâches de l'occupant en cours
let bascule = false      // vidage de l'autre programme en cours
let rendu = null         // rendu ComfyUI en cours : { debut, estimeMs }
const file = []          // [{ qui, reveil }]
const dansJob = new AsyncLocalStorage()

const attendre = ms => new Promise(r => setTimeout(r, ms))

async function viderComfy() {
  try {
    await fetch(`${CONFIG.comfyUrl}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) })
    /* /free est traité par la boucle de ComfyUI, pas dans la requête : on
       attend que la mémoire soit réellement rendue. */
    for (let t = 0; t < 60; t++) {
      const s = await (await fetch(`${CONFIG.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5000) })).json()
      const d = s.devices?.[0]
      if (d && d.vram_free > d.vram_total * 0.8) return
      await attendre(500)
    }
    console.warn('[gpu] ComfyUI n’a pas rendu la mémoire en 30 s — on continue')
  } catch (e) { console.warn('[gpu] vidage ComfyUI :', e.message) }
}

async function viderOllama() {
  try {
    for (let t = 0; t < 60; t++) {
      const ps = await (await fetch(`${CONFIG.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()
      const surCarte = (ps.models ?? []).filter(m => m.size_vram > 0)
      if (!surCarte.length) return
      if (t === 0) await Promise.all(surCarte.map(m => fetch(`${CONFIG.ollamaUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(10_000) })))
      await attendre(500)
    }
    console.warn('[gpu] Ollama n’a pas rendu la mémoire en 30 s — on continue')
  } catch (e) { console.warn('[gpu] vidage Ollama :', e.message) }
}

function servir() {
  while (file.length && !bascule) {
    const t = file[0]
    if (actifs > 0 && occupant !== t.qui) return        // l'autre finit d'abord
    if (occupant !== t.qui) {
      bascule = true
      const t0 = Date.now()
      ;(t.qui === 'comfy' ? viderOllama() : viderComfy()).then(() => {
        console.log(`[gpu] carte → ${t.qui} (vidage ${Date.now() - t0} ms)`)
        occupant = t.qui; bascule = false; servir()
      })
      return
    }
    file.shift(); actifs++; t.reveil()
  }
}

function prendre(qui) { return new Promise(reveil => { file.push({ qui, reveil }); servir() }) }
function rendre() { actifs--; servir() }

/** Enveloppe un job de la file de rendu : il prend la carte pour ComfyUI, et
 *  les appels Ollama qu'il fait lui-même passent sans arbitrage. */
export async function pourRendu(job, travail) {
  if (!ACTIF) return travail()
  await prendre('comfy')
  rendu = { debut: Date.now(), estimeMs: Number(job?.estimatedMs) || null }
  try { return await dansJob.run(true, travail) } finally { rendu = null; rendre() }
}

/** Plusieurs appels Ollama qui se suivent (VLM, fiche, rédaction d'un
 *  carrousel) prennent la carte UNE fois pour tout le bloc. Sans ça, un
 *  rendu en file s'intercale entre deux appels et chaque alternance recharge
 *  un programme — mesuré : 56 s au lieu de 17 pour le même
 *  carrousel. Derrière un long rendu, tout le bloc part sur le CPU. */
export async function blocOllama(travail, { attendreCarte = false } = {}) {
  if (!ACTIF || dansJob.getStore()) return travail()
  /* `attendreCarte` : un long lot (les captions d'un mois de reels) attend la
     fin du rendu en cours plutôt que de se traîner une heure sur le CPU. */
  if (!attendreCarte && renduLong()) return dansJob.run('cpu', travail)
  await prendre('ollama')
  try { return await dansJob.run('ollama', travail) } finally { rendre() }
}

/** Le rendu en cours va-t-il encore durer longtemps ? Estimation absente =
 *  on ne sait pas = on ne fait pas attendre l'opérateur. */
function renduLong() {
  if (!rendu) return false
  if (!rendu.estimeMs) return true
  return rendu.estimeMs - (Date.now() - rendu.debut) > ATTENTE_MAX_MS
}

/** Remplace `fetch(`${ollamaUrl}/api/generate`, init)`. Choisit la carte ou le
 *  CPU, prend la carte si besoin, et retombe sur le CPU si le chargement sur
 *  la carte échoue. */
/* Sans flux, Node abandonne une réponse dont les en-têtes tardent plus de 5 min (modèle sur
   processeur, machine chargée). On demande donc le flux et on le réassemble : l'appelant reçoit
   la même réponse JSON qu'en mode non continu. */
async function fetchLong(url, init) {
  const corps = JSON.parse(init.body)
  if (corps.stream !== false) return fetch(url, init)
  const res = await fetch(url, { ...init, body: JSON.stringify({ ...corps, stream: true }) })
  if (!res.ok || !res.body) return res
  const dec = new TextDecoder()
  let reste = '', texte = '', contenu = '', dernier = {}
  for await (const bout of res.body) {
    reste += dec.decode(bout, { stream: true })
    let i
    while ((i = reste.indexOf('\n')) >= 0) {
      const ligne = reste.slice(0, i).trim(); reste = reste.slice(i + 1)
      if (!ligne) continue
      const o = JSON.parse(ligne)
      if (o.error) return new Response(JSON.stringify({ error: o.error }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      if (o.response) texte += o.response
      if (o.message?.content) contenu += o.message.content
      dernier = o
    }
  }
  const out = { ...dernier, response: texte, ...(url.endsWith('/api/chat') ? { message: { ...(dernier.message ?? {}), role: 'assistant', content: contenu } } : {}) }
  return new Response(JSON.stringify(out), { status: res.status, headers: { 'Content-Type': 'application/json' } })
}

export async function fetchOllama(url, init) {
  const bloc = dansJob.getStore()
  if (!ACTIF || bloc === true) return fetchLong(url, init)
  const corps = JSON.parse(init.body)
  const surCpu = () => fetchLong(url, { ...init, body: JSON.stringify({ ...corps, options: { ...corps.options, num_gpu: 0 } }) })
  if (bloc === 'cpu' || (!bloc && renduLong())) return surCpu()
  const options = { ...corps.options }; delete options.num_gpu
  /* Il reste chargé : c'est le prochain rendu qui le videra, s'il arrive. */
  const surCarte = () => fetchLong(url, { ...init, body: JSON.stringify({ ...corps, options, keep_alive: '30m' }) })
  let res
  if (bloc === 'ollama') res = await surCarte()          // la carte est déjà tenue par le bloc
  else {
    await prendre('ollama')
    try { res = await surCarte() } finally { rendre() }
  }
  if (!res.ok) {
    console.warn(`[gpu] ${corps.model} sur la carte : HTTP ${res.status} — repli CPU`)
    return surCpu()
  }
  return res
}

/** État, pour /api/health et les tests de bascule. */
export function etat() {
  return { actif: ACTIF, occupant, actifs, bascule, enAttente: file.map(t => t.qui),
    rendu: rendu && { ecouleMs: Date.now() - rendu.debut, estimeMs: rendu.estimeMs } }
}
