#!/usr/bin/env node
/* ============================================================
   Ligne de commande du studio (30/10) : ce que fait l'interface, depuis un
   terminal ou un agent de code. Parle à un studio lancé (npm start).
   --json rend une ligne JSON par résultat, pour qu'un agent la lise.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { client } from './client.mjs'

const argv = process.argv.slice(2)
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const flag = n => argv.includes(`--${n}`)
// options à valeur : leur valeur n'est pas un argument positionnel
const A_VALEUR = new Set(['character', 'size', 'out', 'engine', 'seconds', 'shots', 'lang', 'n'])
const positionnels = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && A_VALEUR.has(argv[i - 1].slice(2))))
const [cmd, ...args] = positionnels
const JSON_OUT = flag('json')
const ATTENDRE = flag('wait') || !!opt('out')

const AIDE = `CreatorOS Studio command line — talks to a running studio (npm start).

  npm run studio -- photo "<prompt>" [--character id] [--engine krea|klein|moss] [--size 768x1344] [--wait] [--out dir]
  npm run studio -- video <libraryId> "<motion>" [--engine ltx_hq|wan] [--seconds 5] [--no-audio] [--wait] [--out dir]
  npm run studio -- reel "<brief>" [--shots 4] [--lang en|fr] [--wait] [--out dir]
  npm run studio -- status <jobId|reelId>
  npm run studio -- library [--n 10]
  npm run studio -- characters
  npm run studio -- machine

  --json      one JSON object per result (for scripts and agents)
  --wait      wait until the render is done (--out implies it)
  --out dir   download the finished media into dir

Environment: STUDIO_URL (default http://127.0.0.1:8787), CREATOROS_OWNER_KEY.
Same rules as the web UI: content filter, render queue, visitor limits.`

const s = client()
const dire = (texte, obj) => console.log(JSON_OUT ? JSON.stringify(obj) : texte)
const etape = x => { if (!JSON_OUT) console.error(`  … ${x.status ?? x.state}${x.queuePosition ? ` (#${x.queuePosition} in queue)` : ''}`) }

async function telecharger(medias) {
  const dir = opt('out')
  if (!dir) return []
  fs.mkdirSync(dir, { recursive: true })
  const faits = []
  for (const m of medias.filter(Boolean)) {
    const r = await fetch(m.url)
    if (!r.ok) throw new Error(`download failed: ${m.url} → HTTP ${r.status}`)
    const f = path.join(dir, path.basename(new URL(m.url).pathname))
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()))
    faits.push(f)
  }
  return faits
}

async function finirJob(jobId) {
  if (!ATTENDRE) return dire(`queued: ${jobId}  (npm run studio -- status ${jobId})`, { jobId, status: 'queued' })
  const j = await s.attendreJob(jobId, { surEtape: etape })
  const fichiers = j.status === 'done' ? await telecharger(j.media) : []
  dire(j.status === 'done'
    ? `done: ${jobId}\n${j.media.map(m => `  ${m.url}${m.check?.problemes?.length ? `  ⚠ ${m.check.problemes.map(p => p.type).join(', ')}` : ''}`).join('\n')}${fichiers.length ? `\nsaved: ${fichiers.join(', ')}` : ''}`
    : `${j.status}: ${jobId}${j.error ? ` — ${j.error}` : ''}`, { ...j, files: fichiers })
  if (j.status !== 'done') process.exitCode = 1
}

async function principal() {
  switch (cmd) {
    case 'photo': {
      const [l, h] = (opt('size') ?? '768x1344').split('x').map(Number)
      const { jobId } = await s.photo({ prompt: args.join(' '), persona: opt('character'), largeur: l, hauteur: h, moteur: opt('engine') })
      return finirJob(jobId)
    }
    case 'video': {
      const [image, ...geste] = args
      const { jobId } = await s.video({ image, geste: geste.join(' '), moteur: opt('engine'), secondes: opt('seconds') ? Number(opt('seconds')) : undefined, son: !flag('no-audio') })
      return finirJob(jobId)
    }
    case 'reel': {
      const { reelId } = await s.reel({ brief: args.join(' '), plans: Number(opt('shots') ?? 4), langue: opt('lang') ?? 'en' })
      if (!ATTENDRE) return dire(`queued: ${reelId}  (npm run studio -- status ${reelId})`, { reelId, state: 'writing' })
      const r = await s.attendreReel(reelId, { surEtape: etape })
      const fichiers = r.state === 'done' ? await telecharger([r.video]) : []
      dire(r.state === 'done' ? `done: ${reelId}\n  ${r.video?.url ?? '(video not found in library)'}${fichiers.length ? `\nsaved: ${fichiers.join(', ')}` : ''}`
        : `failed: ${reelId} — ${r.error ?? 'unknown error'}`, { ...r, files: fichiers })
      if (r.state !== 'done') process.exitCode = 1
      return
    }
    case 'status': {
      const x = args[0]
      if (!x) throw new Error('give a job or reel id')
      if (x.startsWith('reel-')) { const r = await s.etatReel(x); return dire(`${r.id}: ${r.state}${r.error ? ` — ${r.error}` : ''}${r.video ? `\n  ${r.video.url}` : ''}`, r) }
      const j = await s.job(x)
      return dire(`${j.id}: ${j.status}${j.queuePosition ? ` (#${j.queuePosition} in queue)` : ''}${j.error ? ` — ${j.error}` : ''}${j.media.map(m => `\n  ${m.url}`).join('')}`, j)
    }
    case 'library': {
      const l = await s.bibliotheque({ n: Number(opt('n') ?? 10) })
      return JSON_OUT ? l.forEach(m => dire('', m)) : console.log(l.map(m => `${m.id}  ${m.type}  ${m.width}×${m.height}  ${m.url}`).join('\n'))
    }
    case 'characters': {
      const p = await s.personas()
      return dire(p.characters.map(c => `${c.id === p.active ? '*' : ' '} ${c.id}  ${c.name}`).join('\n'), p)
    }
    case 'machine': {
      const m = await s.machine()
      return dire(`ComfyUI: ${m.comfyui} · queue: ${m.queue} · GPU: ${m.gpu ?? '?'} · VRAM profile: ${m.vramProfile ?? '?'} GB · video engines: ${m.videoEngines.join(', ')}`, m)
    }
    default:
      console.log(AIDE)
      if (cmd && cmd !== 'help') process.exitCode = 1
  }
}

principal().catch(e => {
  if (JSON_OUT) console.log(JSON.stringify({ error: String(e.message || e) }))
  else console.error(`error: ${e.message || e}`)
  process.exitCode = 1
})
