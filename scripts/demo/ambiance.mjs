/* Demo ambience shots (text → video, LTX-2.5, with sound): cutaways of the
   four photo locations, without a character.

   node scripts/demo/ambiance.mjs [studio url] [brouillon]

   Renders go to the studio queue; the active character is left unchanged. */
const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const BROUILLON = process.argv[3] === 'brouillon'

const PLANS = [
  { cle: 'plage', seed: 610011, prompt: 'Golden hour on an empty sandy beach, gentle waves rolling onto the shore and sliding back, warm low sun on the water, slow lateral tracking shot along the waterline. Sound of waves and a light sea breeze.' },
  { cle: 'cafe', seed: 610012, prompt: 'A quiet Paris café terrace in the early morning, empty wicker chairs and small round tables on the cobblestones, steam rising from a cup of coffee on a table, soft daylight, slow push-in. Ambient street sounds, distant footsteps, a cup set on a saucer.' },
  { cle: 'montagne', seed: 610013, prompt: 'Aerial drone shot gliding over a green alpine valley, a winding mountain trail, snowy peaks in the distance, clouds drifting, bright clear day. Sound of wind and faraway cowbells.' },
  { cle: 'marche', seed: 610014, prompt: 'A flower market along an Amsterdam canal, buckets of colorful tulips in the foreground, canal houses and a slow boat passing in the background, soft overcast light, slow dolly sideways past the flower stalls. Ambient market chatter and water lapping.' },
]

for (const p of PLANS) {
  const job = {
    mode: 'video', purpose: 'creative', recipeId: 'sfw@v1', t2v: true,
    videoEngine: 'ltx_hq', withAudio: true, videoSeconds: 6, videoFps: 24, videoAspect: '9:16',
    videoDraft: BROUILLON,
    seed: { mode: 'lock', value: p.seed },
    userPrompt: p.prompt, userDirectives: '',
    composedPositive: `${p.prompt} single continuous shot, no cuts`, composedNegative: '',
    selections: { task: 't2v', engine: 'ltx_hq', withAudio: true }, loras: [], videoLoras: [],
    requestId: `demo-ambiance-${p.cle}-${p.seed}${BROUILLON ? '-b' : ''}`,
  }
  const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) })
  const d = await r.json().catch(() => ({}))
  console.log(`ambiance ${p.cle.padEnd(9)} → ${r.status} ${d.id ?? d.error ?? ''}`)
}
