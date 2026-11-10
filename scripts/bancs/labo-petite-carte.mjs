#!/usr/bin/env node
/* ============================================================
   Labo, volet petites cartes : rejoue le graphe exact d'un cas du labo
   (celui que le studio a envoyé, relu dans la provenance), avec les poids
   allégés du profil, sur un ComfyUI de test bridé à la taille de la carte :
     CARTE_GO=12 python scripts/bancs/comfy-bride.py --port 8190 --disable-dynamic-vram …
   (PyTorch ne peut pas allouer plus, et ComfyUI décharge comme sur une vraie carte).
   Réussir là, c'est tenir sur une carte de cette taille.

   COMFY_TEST=http://127.0.0.1:8190 CREATOROS_DATA=… node scripts/bancs/labo-petite-carte.mjs photo_klein9 video_wan
   Profil : LABO_PROFIL (12 par défaut) ; COMFY_TEST_PID mesure ce seul processus.
   Ajoute les lignes « *_<profil>go » à docs/lab/resultats.json (relancer labo.mjs ensuite pour LAB.md).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PROFIL = Number(process.env.LABO_PROFIL || 12)
process.env.CREATOROS_VRAM = String(PROFIL)
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
/* Avec COMFY_TEST_PID : la mémoire de ce seul processus, contexte CUDA compris ; sinon la carte entière moins le repos. */
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
  if (!remplaces.length && PROFIL >= 24) continue   // sous 24 Go, même sans variante, le graphe d'origine est mesuré sur la carte bridée
  // les sorties partent dans le dossier du ComfyUI de test, pas dans la bibliothèque
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
  // vignette depuis le dossier de sortie du ComfyUI de test (COMFY_TEST_OUT)
  if (ligne.sortie && process.env.COMFY_TEST_OUT) {
    ligne.vignette = `${ligne.id}.jpg`
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(process.env.COMFY_TEST_OUT, ligne.sortie), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(RACINE, 'docs', 'lab', ligne.vignette)])
  }
  console.log(`${ligne.id.padEnd(18)} ${ligne.statut.padEnd(7)} ${ligne.secondes} s  ${ligne.vramCreteGo} GB${ligne.erreur ? `  ${ligne.erreur}` : ''}`)
  d.cas = [...d.cas.filter(c => c.id !== ligne.id), ligne]
  fs.writeFileSync(FICHIER, JSON.stringify(d, null, 1) + '\n')
}
