/* Demo videos from the photos.mjs outputs, same brief and seed per character.

   node scripts/demo/videos.mjs [studio url] [character,character…]

   Per character: the beach animated by Wan 2.2 (5 s, no sound) and the café
   by LTX-2.5 (5 s, ambient sound). The source photo is the character's most
   recent render of that scene. */
import { SCENES } from './scenes.mjs'

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const QUI = process.argv[3]?.split(',')

const PLANS = [
  { scene: 'plage', engine: 'wan', file: 'PROD_video_wan.json', audio: false, seed: 520031,
    brief: 'she walks slowly along the shoreline toward the camera, the white dress and her hair move in the wind, small waves roll in behind her, slow tracking shot' },
  { scene: 'cafe', engine: 'ltx_hq', file: 'PROD_video_ltx_hq.json', audio: true, seed: 520032,
    brief: 'she lifts the cup, takes a sip of coffee, puts it down and smiles at the camera, people pass in the background, ambient street café sounds, static camera' },
]

const json = async (url, init) => {
  const r = await fetch(url, init)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${url} → ${r.status} ${d.error ?? ''}`)
  return d
}

const { personas } = await json(`${BASE}/api/personas`)
for (const p of personas.filter(p => !QUI || QUI.includes(p.id))) {
  const { assets } = await json(`${BASE}/api/assets?limit=1500&persona=${p.id}`)
  for (const v of PLANS) {
    const prompt = SCENES.find(s => s.cle === v.scene).prompt
    const still = assets.find(a => a.mediaType === 'photo' && a.userPrompt === prompt)
    if (!still) { console.log(`${p.name.padEnd(12)} ${v.scene}: pas de photo — lancer photos.mjs d'abord`); continue }
    const src = await json(`${BASE}/api/assets/${still.id}/to-input`, { method: 'POST' })
    const job = {
      mode: 'video', purpose: 'creative', op: 'generate', recipeId: 'sfw@v1',
      workflowFile: v.file, videoEngine: v.engine, withAudio: v.audio, personaId: p.id,
      seed: v.seed, sourceImage: src.filename,
      videoSeconds: 5, videoFps: 24, videoAspect: 'origine', videoSrcW: src.width, videoSrcH: src.height, videoSpeed: 1,
      userPrompt: v.brief, userDirectives: '', composedPositive: `${v.brief}. single continuous shot, no cuts`, composedNegative: '',
      selections: { task: 'i2v', engine: v.engine, withAudio: v.audio, startFrameFile: src.filename, startAssetId: still.id,
        startFrameW: src.width, startFrameH: src.height },
      loras: [], videoLoras: [],
      requestId: `demo-${p.id}-${v.scene}-${v.engine}-${v.seed}`,
    }
    const d = await json(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) })
    console.log(`${p.name.padEnd(12)} ${v.scene.padEnd(6)} ${v.engine.padEnd(4)} → ${d.id}`)
  }
}
