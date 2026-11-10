/* ============================================================
   "Comfy SDK" transport: renders go through the Comfy v2 API
   (@comfyorg/sdk) instead of ComfyUI's local API.

   Two targets, same code:
   - Comfy Cloud, with the VISITOR's key (X-Comfy-Key header): their
     credits, their account; nothing runs on the machine serving the app;
   - a local ComfyUI behind `comfy-api-proxy` (CREATOROS_TRANSPORT=sdk,
     COMFY_BASE_URL=http://127.0.0.1:8189), without a key.

   The key is never written: not in the database, the job payload or the
   logs. It lives in memory for the job's duration (see jobs.js).

   The rest of the server sees no difference: submitPrompt returns an id
   "sdk:<id>", waitForPrompt returns a ComfyUI-format history entry,
   readImage reads the bytes through the SDK.
   ============================================================ */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { Comfy } from '@comfyorg/sdk'
import { CONFIG } from './config.js'

/** Transport for ALL jobs: 'local' (ComfyUI API) or 'sdk' (v2 proxy). */
export const TRANSPORT = (process.env.CREATOROS_TRANSPORT || 'local').trim().toLowerCase() === 'sdk' ? 'sdk' : 'local'
const BASE_LOCALE = (process.env.COMFY_BASE_URL || 'http://127.0.0.1:8189').trim()

/* Current job context: { cle } for Comfy Cloud, {} for the local proxy. */
const contexte = new AsyncLocalStorage()
/** Runs `fn` (a job) on the SDK transport. No `cle` = local proxy. */
export const avecSdk = (cle, fn) => contexte.run({ cle: cle || null }, fn)
/** Does the current job go through the SDK? */
export const surSdk = () => Boolean(contexte.getStore()) || TRANSPORT === 'sdk'
/** … and to Comfy Cloud (visitor key)? */
export const surCloud = () => Boolean(contexte.getStore()?.cle)

function client() {
  const cle = contexte.getStore()?.cle ?? null
  /* The target is read from COMFY_BASE_URL at construction (SDK contract):
     absent = Comfy Cloud. It is set for the synchronous constructor call only. */
  const avant = process.env.COMFY_BASE_URL
  try {
    if (cle) delete process.env.COMFY_BASE_URL
    else process.env.COMFY_BASE_URL = BASE_LOCALE
    return new Comfy({ ...(cle ? { apiKey: cle } : {}), clientInfo: 'creatoros-studio' })
  } finally {
    if (avant === undefined) delete process.env.COMFY_BASE_URL
    else process.env.COMFY_BASE_URL = avant
  }
}

/* ---------- Comfy Cloud catalog differences ----------
   Same models, sometimes a different file name; and no GGUF node: the
   loader is replaced by a UNETLoader on the fp8 equivalent. */
let tableCloud = null
function catalogueCloud() {
  if (tableCloud) return tableCloud
  try { tableCloud = JSON.parse(fs.readFileSync(path.join(CONFIG.workflowsDir, 'cloud.json'), 'utf8')) }
  catch { tableCloud = { renommer: {}, gguf: {} } }
  return tableCloud
}
function adapterAuCloud(graphe) {
  const { renommer = {}, gguf = {} } = catalogueCloud()
  for (const n of Object.values(graphe)) {
    if (!n || typeof n !== 'object') continue
    if (n.class_type === 'UnetLoaderGGUF') {
      const cible = gguf[n.inputs?.unet_name]
      if (!cible) throw new Error(`modèle GGUF « ${n.inputs?.unet_name} » sans équivalent sur Comfy Cloud`)
      n.class_type = 'UNETLoader'
      n.inputs = { unet_name: cible, weight_dtype: 'default' }
      continue
    }
    for (const [k, v] of Object.entries(n.inputs ?? {}))
      if (typeof v === 'string' && renommer[v]) n.inputs[k] = renommer[v]
  }
}

/* Loader "input file name" fields: the file is in the local ComfyUI's
   input/ folder; through the SDK it is UPLOADED (deduplicated by hash, a file
   already known to the server is not resent). */
const ENTREES = { LoadImage: 'image', VHS_LoadVideo: 'video', LoadVideo: 'file', LoadImageMask: 'image' }

const jobs = new Map()   // 'sdk:<id>' → SDK Job

export async function soumettre(workflow) {
  const c = client()
  const graphe = structuredClone(workflow)
  if (surCloud()) adapterAuCloud(graphe)
  const wf = c.workflows.fromJson(graphe)
  for (const [id, n] of Object.entries(graphe)) {
    const champ = ENTREES[n?.class_type]
    const nom = champ && n.inputs?.[champ]
    if (typeof nom !== 'string' || !nom) continue
    const fichier = path.join(CONFIG.comfyInput, path.basename(nom))
    if (!fs.existsSync(fichier)) throw new Error(`entrée « ${nom} » introuvable dans input/`)
    wf.setInput(id, champ, c.assets.fromFile(fichier))
  }
  const job = await c.submit(wf)
  const pid = `sdk:${job.id}`
  jobs.set(pid, job)
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value)
  return pid
}

const attendre = ms => new Promise(r => setTimeout(r, ms))

/** Waits for the job to finish; returns a ComfyUI-format history entry. */
export async function attendreFin(pid, { onPhase, timeoutMs } = {}) {
  const job = jobs.get(pid)
  if (!job) throw new Error('job Comfy SDK inconnu (serveur redémarré pendant le rendu ?)')
  const t0 = Date.now()
  let phase = null
  for (;;) {
    await job.refresh()
    const next = job.status === 'running' ? 'rendering' : job.status === 'queued' ? 'queued' : phase
    if (next && next !== phase) { phase = next; onPhase?.(next) }
    if (['succeeded', 'failed', 'canceled', 'expired'].includes(job.status)) break
    if (timeoutMs && Date.now() - t0 > timeoutMs * 4) throw new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s) côté Comfy`)
    await attendre(job.status === 'queued' ? 3000 : 1500)
  }
  if (job.status !== 'succeeded') {
    const e = job.error
    const detail = e ? [e.code, e.message, e.class_type && `nœud ${e.class_type}${e.node_id ? ` #${e.node_id}` : ''}`].filter(Boolean).join(' — ') : job.status
    return { status: { completed: false, status_str: job.status, messages: [['execution_error', { exception_message: detail }]] }, outputs: {} }
  }
  /* Outputs grouped by node, all under `images` as ComfyUI does for
     SaveImage and SaveVideo (outputsOf only reads there). */
  const outputs = {}
  for (const o of job.outputs) {
    if (o.type === 'text' || o.type === 'latent') continue
    ;(outputs[o.nodeId] ??= { images: [] }).images.push({ filename: o.name, subfolder: '', type: 'output', __sdk: o })
  }
  return { status: { completed: true, status_str: 'success', messages: [] }, outputs }
}

export async function lireSortie(img) {
  return Buffer.from(await img.__sdk.toBytes({ timeoutMs: 10 * 60_000 }))
}

export async function annuler(pid) {
  const job = jobs.get(pid)
  if (job) await job.cancel().catch(() => {})
}
