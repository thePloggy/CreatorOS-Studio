/* ============================================================
   GPU arbitration between ComfyUI and Ollama.

   Rules:
   - one program holds the GPU at a time; consecutive tasks of the SAME
     program run without unloading anything;
   - the other program is unloaded only when the GPU is needed (/free for
     ComfyUI, unload verified via /api/ps for Ollama);
   - FIFO: a waiting LLM call goes before the next render;
   - an LLM call does not wait behind a LONG render: it runs on the CPU;
   - an Ollama call made FROM a render job is not arbitrated: the job
     already holds the GPU and would wait on itself.
   ============================================================ */
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONFIG } from './config.js'

/** Above this estimated remaining render time, an Ollama call runs on the CPU
 *  instead of waiting. */
const ATTENTE_MAX_MS = 60_000
/** CREATOROS_LLM_GPU: `0` → all Ollama on CPU; `libre` → GPU only when ComfyUI has no render
 *  from ANOTHER client (shared ComfyUI: never unload it mid-job); unset → full arbitration. */
const MODE = process.env.CREATOROS_LLM_GPU === '0' ? 'cpu' : process.env.CREATOROS_LLM_GPU === 'libre' ? 'libre' : 'auto'
const ACTIF = MODE !== 'cpu'
/** In `libre` mode, Ollama releases the GPU quickly so another client finds it free. */
const GARDE_CARTE = MODE === 'libre' ? '2m' : '30m'
let clientStudio = null
/** The studio's ComfyUI client id: only its own renders are arbitrated here. */
export function definirClientStudio(id) { clientStudio = id }
/** Is ComfyUI working for another client? Returns true when unsure. */
async function comfyPrisAilleurs() {
  if (MODE !== 'libre') return false
  try {
    const q = await (await fetch(`${CONFIG.comfyUrl}/queue`, { signal: AbortSignal.timeout(3000) })).json()
    return [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some(e => e?.[3]?.client_id !== clientStudio)
  } catch { return true }
}

let occupant = null      // 'comfy' | 'ollama' | null (unknown at startup)
let actifs = 0           // running tasks of the occupant
let bascule = false      // unloading of the other program in progress
let rendu = null         // current ComfyUI render: { debut, estimeMs }
const file = []
const dansJob = new AsyncLocalStorage()

const attendre = ms => new Promise(r => setTimeout(r, ms))

async function viderComfy() {
  try {
    await fetch(`${CONFIG.comfyUrl}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) })
    /* /free is handled by the ComfyUI loop, not in the request: wait until the
       memory is actually released. */
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
    if (actifs > 0 && occupant !== t.qui) return        // the other one finishes first
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

/** Wraps a render-queue job: it takes the GPU for ComfyUI, and Ollama calls
 *  it makes itself bypass arbitration. */
export async function pourRendu(job, travail) {
  if (!ACTIF) return travail()
  await prendre('comfy')
  rendu = { debut: Date.now(), estimeMs: Number(job?.estimatedMs) || null }
  try { return await dansJob.run(true, travail) } finally { rendu = null; rendre() }
}

/** Consecutive Ollama calls (VLM, sheet, carousel writing) take the GPU ONCE
 *  for the whole block, so no queued render interleaves and forces reloads.
 *  Behind a long render, the whole block runs on the CPU. */
export async function blocOllama(travail, { attendreCarte = false } = {}) {
  if (!ACTIF || dansJob.getStore()) return travail()
  /* `attendreCarte`: a long batch waits for the current render to finish
     instead of running on the CPU. */
  if ((!attendreCarte && renduLong()) || await comfyPrisAilleurs()) return dansJob.run('cpu', travail)
  await prendre('ollama')
  try { return await dansJob.run('ollama', travail) } finally { rendre() }
}

/** Will the current render last long? No estimate = unknown = the operator
 *  is not made to wait. */
function renduLong() {
  if (!rendu) return false
  if (!rendu.estimeMs) return true
  return rendu.estimeMs - (Date.now() - rendu.debut) > ATTENTE_MAX_MS
}

/** Replaces `fetch(`${ollamaUrl}/api/generate`, init)`. Chooses GPU or CPU,
 *  takes the GPU if needed, and falls back to CPU if loading on GPU fails. */
/* Without streaming, Node drops a response whose headers take over 5 min. So the
   stream is requested and reassembled: the caller gets the same JSON as non-streaming. */
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
  if (bloc === 'cpu' || (!bloc && (renduLong() || await comfyPrisAilleurs()))) return surCpu()
  const options = { ...corps.options }; delete options.num_gpu
  /* The model stays loaded; the next render unloads it if needed. */
  const surCarte = () => fetchLong(url, { ...init, body: JSON.stringify({ ...corps, options, keep_alive: GARDE_CARTE }) })
  let res
  if (bloc === 'ollama') res = await surCarte()          // the block already holds the GPU
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

/** State, for /api/health and switch tests. */
export function etat() {
  return { actif: ACTIF, occupant, actifs, bascule, enAttente: file.map(t => t.qui),
    rendu: rendu && { ecouleMs: Date.now() - rendu.debut, estimeMs: rendu.estimeMs } }
}
