#!/usr/bin/env node
/* ============================================================
   Labo, volet petites cartes : rejoue le graphe exact d'un cas du labo
   (celui que le studio a envoyé, relu dans la provenance), avec les poids
   allégés du profil 12 Go, sur un ComfyUI de test lancé avec --vram-headroom (DynamicVRAM : --reserve-vram ne bride pas)
   pour n'avoir qu'environ 12 Go de VRAM à lui. Réussir là, c'est tenir sur
   une carte de 12 Go ; la crête mesurée est celle de ce ComfyUI-là.

   COMFY_TEST=http://127.0.0.1:8190 CREATOROS_DATA=… node scripts/bancs/labo-petite-carte.mjs photo_klein9 video_wan
   Ajoute les lignes « *_12go » à docs/lab/resultats.json (relancer labo.mjs ensuite pour LAB.md).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.CREATOROS_VRAM = '12'
const TEST = process.env.COMFY_TEST || 'http://127.0.0.1:8190'
process.env.COMFY_URL = TEST                  // allege.js lit les fichiers installés sur CE ComfyUI
const { CONFIG } = await import('../../server/config.js')
CONFIG.comfyUrl = TEST
const { alleger } = await import('../../server/allege.js')

const RACINE = path.resolve(import.meta.dirname, '..', '..')
const FICHIER = path.join(RACINE, 'docs', 'lab', 'resultats.json')
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:8787'
const CLE = process.env.CREATOROS_OWNER_KEY
const sleep = ms => new Promise(r => setTimeout(r, ms))
const vramMo = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).split('\n')[0])
const TITRES = { photo_klein9: 'Photo · FLUX.2 Klein 4B (12 GB card)', video_wan: 'Image to video · Wan 2.2 A14B GGUF Q4 (12 GB card)' }

const d = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
for (const id of process.argv.slice(2)) {
  const cas = d.cas.find(c => c.id === id)
  if (!cas?.media) { console.log(`${id} : pas de rendu de référence dans resultats.json`); continue }
  const prov = await (await fetch(`${STUDIO}/api/assets/${cas.media}/provenance`, { headers: CLE ? { 'X-Owner-Key': CLE } : {} })).json()
  if (!prov.workflowJson) { console.log(`${id} : provenance sans graphe`); continue }
  const { graphe, remplaces } = await alleger(prov.workflowJson)
  console.log(`${id} : ${remplaces.map(([a, b]) => `${a} → ${b}`).join(' ; ') || 'aucune variante installée'}`)
  if (!remplaces.length) continue
  // les sorties partent dans le dossier du ComfyUI de test, pas dans la bibliothèque
  for (const n of Object.values(graphe)) if (n.inputs && 'filename_prefix' in n.inputs) n.inputs.filename_prefix = `labo12/${id}`
  await fetch(`${TEST}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
  await sleep(4000)
  const repos = vramMo()
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
  const ligne = { id: `${id}_12go`, titre: TITRES[id] ?? `${cas.titre} (12 GB card)`, type: cas.type, statut: ok ? 'done' : 'failed',
    erreur: ok ? undefined : JSON.stringify(h.status.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message ?? '').slice(0, 300),
    secondes: Math.round((Date.now() - t0) / 100) / 10, vramCreteGo: Math.round((crete - repos) / 102.4) / 10, remplaces,
    sortie: sorties[0] ? `${sorties[0].subfolder}/${sorties[0].filename}` : null }
  // vignette depuis le dossier de sortie du ComfyUI de test (COMFY_TEST_OUT)
  if (ligne.sortie && process.env.COMFY_TEST_OUT) {
    ligne.vignette = `${ligne.id}.jpg`
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(process.env.COMFY_TEST_OUT, ligne.sortie), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(RACINE, 'docs', 'lab', ligne.vignette)])
  }
  console.log(`${ligne.id.padEnd(18)} ${ligne.statut.padEnd(7)} ${ligne.secondes} s  ${ligne.vramCreteGo} GB${ligne.erreur ? `  ${ligne.erreur}` : ''}`)
  d.cas = [...d.cas.filter(c => c.id !== ligne.id), ligne]
  fs.writeFileSync(FICHIER, JSON.stringify(d, null, 1) + '\n')
}
