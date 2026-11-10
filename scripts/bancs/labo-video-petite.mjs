#!/usr/bin/env node
/* ============================================================
   Lab, small-card video part: replays the lab's Wan 2.2 graph
   (read back from the provenance of the video_wan reference render) on a
   test ComfyUI capped to the card size (scripts/bancs/comfy-bride.py), with:
     - both Wan 2.2 A14B experts in GGUF Q4_K_S instead of fp8 (or fp8 with --fp8),
     - optionally a capped resolution (--cote 832: 480p at 9:16).
   The measured peak is that of the test ComfyUI process (COMFY_TEST_PID), CUDA context included.

   COMFY_TEST=http://127.0.0.1:8190 COMFY_TEST_OUT=… node scripts/bancs/labo-video-petite.mjs 16 [--cote 832] [--fp8]
   Appends a "video_wan_<profil>go[_480p][_fp8]" row to docs/lab/resultats.json.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const profil = Number(args[0])
const cote = args.includes('--cote') ? Number(args[args.indexOf('--cote') + 1]) : 0
const fp8 = args.includes('--fp8')
const TEST = process.env.COMFY_TEST || 'http://127.0.0.1:8190'
const RACINE = path.resolve(import.meta.dirname, '..', '..')
const FICHIER = path.join(RACINE, 'docs', 'lab', 'resultats.json')
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:8787'
const CLE = process.env.CREATOROS_OWNER_KEY
const sleep = ms => new Promise(r => setTimeout(r, ms))
/* Memory of the test ComfyUI only (COMFY_TEST_PID), CUDA context included: what a real card needs.
   Without a PID, the whole card minus idle (wrong if another ComfyUI keeps models loaded). */
const PID = process.env.COMFY_TEST_PID
const vramMo = () => PID
  ? Number(execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
      .split('\n').map(l => l.split(',').map(x => x.trim())).find(([p]) => p === PID)?.[1] ?? 0)
  : Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).split('\n')[0])
const Q4 = { 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors': 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf',
             'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors': 'Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf' }

const d = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
const cas = d.cas.find(c => c.id === 'video_wan')
const prov = await (await fetch(`${STUDIO}/api/assets/${cas.media}/provenance`, { headers: CLE ? { 'X-Owner-Key': CLE } : {} })).json()
const g = structuredClone(prov.workflowJson)
const remplaces = []
for (const n of Object.values(g)) {
  if (n.class_type === 'UNETLoader' && Q4[n.inputs.unet_name] && !fp8) {
    remplaces.push([n.inputs.unet_name, Q4[n.inputs.unet_name]])
    n.class_type = 'UnetLoaderGGUF'; n.inputs = { unet_name: Q4[n.inputs.unet_name] }
  }
  if (n.class_type === 'WanImageToVideo' && cote) {
    const { width: w, height: h } = n.inputs, k = cote / Math.max(w, h)
    if (k < 1) { n.inputs.width = Math.round(w * k / 16) * 16; n.inputs.height = Math.round(h * k / 16) * 16 }
  }
  if (n.inputs && 'filename_prefix' in n.inputs) n.inputs.filename_prefix = `labo-video/${profil}`
}
const res = Object.values(g).find(n => n.class_type === 'WanImageToVideo').inputs
const id = `video_wan_${profil}go${cote ? `_${Math.min(res.width, res.height)}p` : ''}${fp8 ? '_fp8' : ''}`
console.log(`${id} : ${res.width}x${res.height}x${res.length} ; ${remplaces.map(([a, b]) => `${a} → ${b}`).join(' ; ') || 'poids fp8 d’origine'}`)

await fetch(`${TEST}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
await sleep(4000)
const repos = PID ? 0 : vramMo()
const r = await (await fetch(`${TEST}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: g }) })).json()
if (!r.prompt_id) { console.log(`${id} : refusé — ${JSON.stringify(r).slice(0, 400)}`); process.exit(1) }
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
const ligne = { id, titre: `Image to video · Wan 2.2 A14B ${fp8 ? 'fp8' : 'GGUF Q4'}${cote ? ` ${Math.min(res.width, res.height)}p` : ''} (${profil} GB card)`, type: 'video',
  statut: ok ? 'done' : 'failed',
  erreur: ok ? undefined : JSON.stringify(h.status.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message ?? '').slice(0, 300),
  secondes: Math.round((Date.now() - t0) / 100) / 10, vramCreteGo: Math.round((crete - repos) / 102.4) / 10, remplaces,
  resolution: `${res.width}x${res.height}`, sortie: sorties[0] ? `${sorties[0].subfolder}/${sorties[0].filename}` : null }
if (ligne.sortie && process.env.COMFY_TEST_OUT) {
  ligne.vignette = `${id}.jpg`
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', path.join(process.env.COMFY_TEST_OUT, ligne.sortie), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(RACINE, 'docs', 'lab', ligne.vignette)])
}
console.log(`${id.padEnd(24)} ${ligne.statut.padEnd(7)} ${ligne.secondes} s  ${ligne.vramCreteGo} GB${ligne.erreur ? `  ${ligne.erreur}` : ''}`)
d.cas = [...d.cas.filter(c => c.id !== id), ligne]
fs.writeFileSync(FICHIER, JSON.stringify(d, null, 1) + '\n')
