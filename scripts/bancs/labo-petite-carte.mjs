#!/usr/bin/env node
/* ============================================================
   Lab, small-card part: replays the exact graph of a lab case
   (the one the studio sent, read back from provenance), with the
   profile's lightweight weights, on a test ComfyUI capped to the card size:
     CARTE_GO=12 python scripts/bancs/comfy-bride.py --port 8190 --disable-dynamic-vram …
   (PyTorch cannot allocate more, and ComfyUI offloads as on a real card).
   Passing there means fitting a card of that size.

   COMFY_TEST=http://127.0.0.1:8190 CREATOROS_DATA=… node scripts/bancs/labo-petite-carte.mjs photo_klein9 video_wan
   Profile: LABO_PROFIL (default 12); COMFY_TEST_PID measures that process only.
   Appends "*_<profil>go" rows to docs/lab/resultats.json (rerun labo.mjs afterwards for LAB.md).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PROFIL = Number(process.env.LABO_PROFIL || 12)
process.env.CREATOROS_VRAM = String(PROFIL)
const TEST = process.env.COMFY_TEST || 'http://127.0.0.1:8190'
process.env.COMFY_URL = TEST                  // allege.js reads the files installed on THIS ComfyUI
const { CONFIG } = await import('../../server/config.js')
CONFIG.comfyUrl = TEST
const { alleger } = await import('../../server/allege.js')

const RACINE = path.resolve(import.meta.dirname, '..', '..')
const FICHIER = path.join(RACINE, 'docs', 'lab', 'resultats.json')
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:8787'
const CLE = process.env.CREATOROS_OWNER_KEY
const sleep = ms => new Promise(r => setTimeout(r, ms))
/* With COMFY_TEST_PID: memory of that process only, CUDA context included; otherwise the whole card minus idle. */
const PID = process.env.COMFY_TEST_PID
const vramMo = () => PID
  ? Number(execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
      .split('\n').map(l => l.split(',').map(x => x.trim())).find(([p]) => p === PID)?.[1] ?? 0)
  : Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).split('\n')[0])

const d = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
for (const id of process.argv.slice(2)) {
  const cas = d.cas.find(c => c.id === id)
  if (!cas?.media) { console.log(`${id} : pas de rendu de référence dans resultats.json`); continue }
  const prov = await (await fetch(`${STUDIO}/api/assets/${cas.media}/provenance`, { headers: CLE ? { 'X-Owner-Key': CLE } : {} })).json()
  if (!prov.workflowJson) { console.log(`${id} : provenance sans graphe`); continue }
  const { graphe, remplaces } = await alleger(prov.workflowJson)
  console.log(`${id} : ${remplaces.map(([a, b]) => `${a} → ${b}`).join(' ; ') || 'aucune variante installée'}`)
  if (!remplaces.length && PROFIL >= 24) continue   // under 24 GB, even without a variant, the original graph is measured on the capped card
  // outputs go to the test ComfyUI's folder, not the library
  for (const n of Object.values(graphe)) if (n.inputs && 'filename_prefix' in n.inputs) n.inputs.filename_prefix = `labo${PROFIL}/${id}`
  await fetch(`${TEST}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
  await sleep(4000)
  const repos = PID ? 0 : vramMo()
  const r = await (await fetch(`${TEST}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graphe }) })).json()
  if (!r.prompt_id) { console.log(`${id} : refusé — ${JSON.stringify(r).slice(0, 400)}`); continue }
  const t0 = Date.now()
  let crete = repos, h
  for (;;) {
    crete = Math.max(crete, vramMo())
    h = (await (await fetch(`${TEST}/history/${r.prompt_id}`)).json())[r.prompt_id]
    if (h?.status?.completed || h?.status?.status_str === 'error') break
    await sleep(500)
  }
  const ok = h.status.status_str === 'success'
  const sorties = Object.values(h.outputs ?? {}).flatMap(o => [...(o.images ?? []), ...(o.gifs ?? []), ...(o.videos ?? [])])
  const ligne = { id: `${id}_${PROFIL}go`, titre: `${remplaces.length ? cas.titre.replace('Klein 9B', 'Klein 4B') : cas.titre} (${PROFIL} GB card)`, type: cas.type, statut: ok ? 'done' : 'failed',
    erreur: ok ? undefined : JSON.stringify(h.status.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message ?? '').slice(0, 300),
    secondes: Math.round((Date.now() - t0) / 100) / 10, vramCreteGo: Math.round((crete - repos) / 102.4) / 10, remplaces,
    sortie: sorties[0] ? `${sorties[0].subfolder}/${sorties[0].filename}` : null }
  // thumbnail from the test ComfyUI's output folder (COMFY_TEST_OUT)
  if (ligne.sortie && process.env.COMFY_TEST_OUT) {
    ligne.vignette = `${ligne.id}.jpg`
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(process.env.COMFY_TEST_OUT, ligne.sortie), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(RACINE, 'docs', 'lab', ligne.vignette)])
  }
  console.log(`${ligne.id.padEnd(18)} ${ligne.statut.padEnd(7)} ${ligne.secondes} s  ${ligne.vramCreteGo} GB${ligne.erreur ? `  ${ligne.erreur}` : ''}`)
  d.cas = [...d.cas.filter(c => c.id !== ligne.id), ligne]
  fs.writeFileSync(FICHIER, JSON.stringify(d, null, 1) + '\n')
}
