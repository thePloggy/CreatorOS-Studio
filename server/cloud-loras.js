/* ============================================================
   Character LoRAs on Comfy Cloud: one-click import.

   A render sent to Comfy Cloud with the visitor's key loads identity LoRAs
   BY FILE NAME. Comfy Cloud does not have them in its catalog, so they are
   imported into the visitor's account. Comfy Cloud downloads from Civitai
   itself (POST /api/assets/download), as a background task tracked by
   GET /api/tasks/{id}: nothing goes through this server.

   Each file's source is in workflows/cloud.json (`loras`: file name ->
   Civitai version). The imported name is the one Civitai gives the file,
   the same as in the local loras/ folder, so recipes need no renaming.

   The visitor's key is used for the call and never stored or logged.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { personas } from './persona.js'

/* Comfy Cloud API host; overridden in tests (fake local server). */
const API = (process.env.COMFY_CLOUD_API || 'https://cloud.comfy.org').replace(/\/+$/, '')

function table() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG.workflowsDir, 'cloud.json'), 'utf8')) }
  catch { return {} }
}

async function appel(cle, methode, chemin, corps) {
  const r = await fetch(API + chemin, {
    method: methode,
    headers: { 'X-API-Key': cle, Accept: 'application/json', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const texte = await r.text()
  let json = null
  try { json = texte ? JSON.parse(texte) : null } catch { /* non-JSON body */ }
  if (!r.ok) {
    const msg = json?.message || json?.error?.message || json?.error || texte.slice(0, 200) || `HTTP ${r.status}`
    const e = new Error(r.status === 401 || r.status === 403
      ? 'clé Comfy Cloud refusée (ou abonnement requis)' : `Comfy Cloud : ${msg}`)
    e.statusCode = r.status === 401 || r.status === 403 ? 401 : 502
    throw e
  }
  return json
}

/** Names of LoRAs already in the visitor's account. */
async function presentes(cle) {
  const noms = new Set()
  for (let offset = 0; offset < 5000; offset += 500) {
    const d = await appel(cle, 'GET', `/api/assets?include_tags=models,loras&limit=500&offset=${offset}`)
    const liste = d?.assets ?? d?.data ?? (Array.isArray(d) ? d : [])
    for (const a of liste) if (a?.name) noms.add(path.basename(a.name))
    if (liste.length < 500 || d?.has_more === false) break
  }
  return noms
}

/** Character photo LoRAs (Krea 2 and Klein), with their source. */
function lorasDesPersonnages() {
  const { loras: src = {}, renommer = {} } = table()
  const out = []
  for (const p of personas().list) {
    for (const [moteur, liste] of [['krea', p.loras], ['klein', p.lorasKlein], ['video', p.videoLoras]])
      for (const l of liste ?? [])
        out.push({ persona: p.id, personaName: p.name, moteur, name: l.name, cloudName: renommer[l.name] ?? l.name, source: src[l.name] ?? null })
  }
  return out
}

/** Status: for each character LoRA, whether it is in the account. */
export async function etatCloud(cle) {
  const noms = await presentes(cle)
  return { loras: lorasDesPersonnages().map(l => ({ ...l, present: noms.has(l.cloudName) })) }
}

/** Starts importing missing LoRAs (all, or those of one character). */
export async function importerCloud(cle, { persona } = {}) {
  const noms = await presentes(cle)
  const cibles = lorasDesPersonnages().filter(l => !noms.has(l.cloudName) && (!persona || l.persona === persona))
  const resultats = []
  for (const l of cibles) {
    if (!l.source) { resultats.push({ name: l.name, persona: l.persona, status: 'sans-source' }); continue }
    try {
      const d = await appel(cle, 'POST', '/api/assets/download', {
        source_url: l.source, tags: ['models', 'loras'],
        user_metadata: { creatoros_persona: l.persona, filename: l.name },
      })
      resultats.push({ name: l.name, persona: l.persona, status: d?.task_id ? (d.status ?? 'created') : 'completed', task: d?.task_id ?? null })
    } catch (e) {
      if (e.statusCode === 401) throw e
      resultats.push({ name: l.name, persona: l.persona, status: 'failed', error: String(e.message).slice(0, 200) })
    }
  }
  return { lances: resultats }
}

/** Status of an import task. */
export async function tacheCloud(cle, id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(id))) { const e = new Error('identifiant de tâche invalide'); e.statusCode = 400; throw e }
  const d = await appel(cle, 'GET', `/api/tasks/${id}`)
  return { id, status: d?.status ?? 'unknown', progress: d?.progress ?? null, error: d?.error ?? d?.message ?? null }
}
