#!/usr/bin/env node
/* ============================================================
   Lab: each recipe runs once, fixed seed, on the machine serving the
   studio; records its real render time and peak VRAM, with full
   weights. Lightweight (12 GB) weights go through
   labo-petite-carte.mjs, on a ComfyUI capped at 12 GB.

   Before each case ComfyUI unloads everything (/free), so the measured peak
   is the case alone. On a large card ComfyUI keeps everything in VRAM, so the
   peak is an upper bound: under 12 GB, the recipe fits a 12 GB card.

   node scripts/bancs/labo.mjs [cas…]      (studio running, local ComfyUI)
   node scripts/bancs/labo.mjs --table     (only rewrites docs/LAB.md)
   Writes docs/lab/resultats.json, thumbnails docs/lab/*.jpg and docs/LAB.md.
   CREATOROS_OWNER_KEY: owner key (forced profiles are owner-only).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { client } from '../agent/client.mjs'

const RACINE = path.resolve(import.meta.dirname, '..', '..')
const DOSSIER = path.join(RACINE, 'docs', 'lab')
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const s = client()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PHOTO = 'A woman in a mustard raincoat crossing a rainy city street at dusk, neon reflections on wet asphalt, candid street photo, 35mm'
const GESTE = 'she walks forward under the rain and glances to the side, slow tracking shot'
const GRAINE = 20261030

/* Cases: `depuis` = the case whose photo is used as the start image. */
const CAS = [
  { id: 'photo_krea', titre: 'Photo · Krea 2', type: 'photo', moteur: 'krea' },
  { id: 'photo_klein9', titre: 'Photo · FLUX.2 Klein 9B', type: 'photo', moteur: 'klein' },
  { id: 'video_wan', titre: 'Image to video · Wan 2.2 A14B fp8', type: 'video', moteur: 'wan', depuis: 'photo_krea' },
  { id: 'video_ltx', titre: 'Image to video + sound · LTX-2.5 22B', type: 'video', moteur: 'ltx_hq', depuis: 'photo_krea' },
]

const vramMo = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).split('\n')[0])
const carte = () => execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8' }).split('\n')[0].trim()

async function liberer() {
  await fetch(`${COMFY}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
  await sleep(4000)
}

/** Runs a case and tracks it: render time (from "rendering" to "done") and peak VRAM above idle. */
async function jouer(c, sources) {
  await liberer()
  const repos = vramMo()
  const { jobId } = c.type === 'photo'
    ? await s.photo({ prompt: PHOTO, moteur: c.moteur, graine: GRAINE, profil: c.profil })
    : await s.video({ image: sources[c.depuis], geste: GESTE, moteur: c.moteur, secondes: 4, graine: GRAINE, profil: c.profil })
  let crete = repos, debut = null, j
  for (;;) {
    crete = Math.max(crete, vramMo())
    j = await s.job(jobId)
    if (j.status === 'rendering' && !debut) debut = Date.now()
    if (['done', 'blocked', 'cancelled'].includes(j.status)) break
    await sleep(500)
  }
  const r = { ...c, jobId, statut: j.status, erreur: j.error, secondes: debut ? Math.round((Date.now() - debut) / 100) / 10 : null,
    vramCreteGo: Math.round((crete - repos) / 102.4) / 10, media: j.media?.[0]?.id ?? null, url: j.media?.[0]?.url ?? null }
  console.log(`${c.id.padEnd(14)} ${j.status.padEnd(8)} ${String(r.secondes ?? '-').padStart(6)} s  ${String(r.vramCreteGo).padStart(5)} GB${j.error ? `  ${j.error.slice(0, 120)}` : ''}`)
  return r
}

/** 480 px wide JPEG thumbnail (first frame of a video). */
function vignette(r) {
  if (!r.url) return null
  const f = path.join(DOSSIER, `${r.id}.jpg`)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', r.url, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', f])
  return path.basename(f)
}

const TABLE = process.argv.includes('--table')
const choisis = process.argv.slice(2).filter(a => !a.startsWith('--'))
const cas = TABLE ? [] : choisis.length ? CAS.filter(c => choisis.includes(c.id)) : CAS
fs.mkdirSync(DOSSIER, { recursive: true })
const fichier = path.join(DOSSIER, 'resultats.json')
const avant = fs.existsSync(fichier) ? JSON.parse(fs.readFileSync(fichier, 'utf8')) : { cas: [] }
const sources = Object.fromEntries(avant.cas.filter(r => r.media).map(r => [r.id, r.media]))
const resultats = Object.fromEntries(avant.cas.map(r => [r.id, r]))

console.log(`labo sur ${carte()}`)
for (const c of cas) {
  if (c.depuis && !sources[c.depuis]) { console.log(`${c.id}: sauté, il faut d'abord ${c.depuis}`); continue }
  const r = await jouer(c, sources)
  r.vignette = vignette(r)
  resultats[c.id] = r
  if (r.media) sources[c.id] = r.media
  // small-card rows (labo-petite-carte.mjs) are kept after these
  const autres = Object.values(resultats).filter(x => !CAS.some(c => c.id === x.id))
  fs.writeFileSync(fichier, JSON.stringify({ carte: carte(), le: new Date().toISOString().slice(0, 10), cas: [...CAS.map(x => resultats[x.id]).filter(Boolean), ...autres] }, null, 1) + '\n')
}

/* docs/LAB.md: the table, regenerated on every run. */
const d = JSON.parse(fs.readFileSync(fichier, 'utf8'))
const lignes = d.cas.map(r => `| ${r.titre} | ${r.statut === 'done' ? `${r.secondes} s` : r.statut} | ${r.vramCreteGo} GB | ${r.vignette ? `<img src="lab/${r.vignette}" width="160">` : ''} |`)
fs.writeFileSync(path.join(RACINE, 'docs', 'LAB.md'), `# Lab: real render times and peak VRAM

Every recipe rendered once with the same prompt and seed (${d.le}, ${d.carte}). Before each run ComfyUI unloads every model, so the peak is the recipe alone. On a large card ComfyUI keeps the text encoder and the model resident together, so these peaks are higher than what the recipe strictly needs.

The "16 / 12 / 8 GB card" rows replay the exact same graph with the light weights on a second ComfyUI that is held to the size of that card (\`scripts/bancs/comfy-bride.py\`): PyTorch may not allocate more than the card holds, and ComfyUI is told only that much is free, so it offloads exactly as it would on the real card. Their peak is that ComfyUI process alone, CUDA context included. Finishing there means the recipe runs on a card of that size. On an 8 GB card the studio renders Wan video at 480p (long side 832): the Q4 weights fit, the 720p activations do not. Scripts: \`scripts/bancs/labo-petite-carte.mjs\` (photo) and \`scripts/bancs/labo-video-petite.mjs\` (video).

Prompt: *${PHOTO}*. Videos start from the Krea 2 photo, 4 s: *${GESTE}*.

| Recipe | Render time | Peak VRAM | Result |
|---|---|---|---|
${lignes.join('\n')}

Reproduce: \`node scripts/bancs/labo.mjs\` with the studio running. The small-card rows use the light weights the setup wizard installs for small cards (\`npm run setup -- --vram 8\`), which the studio swaps in automatically on a small card.
`)
console.log('docs/LAB.md écrit')
