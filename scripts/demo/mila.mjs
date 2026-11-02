/* Essai de Mila (personnage vidéo, LoRA LTX-2.3 sur LTX-2.5) : plans texte → vidéo
   AVEC le personnage, plus deux photos Krea 2 (sa LoRA photo) pour l'I2V.

   node scripts/demo/mila.mjs [url du studio] */
const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const post = async (job, nom) => {
  const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) })
  const d = await r.json().catch(() => ({}))
  console.log(`${nom.padEnd(16)} → ${r.status} ${d.id ?? d.error ?? ''}`)
}
const PLANS = [
  { cle: 'cafe', seed: 620011, prompt: 'mila sits at a small round table on a sunny Paris café terrace, wearing a cream knit sweater, she lifts a cup of coffee, smiles and looks toward the camera, soft morning light, slow push-in. Ambient street sounds, a cup set on a saucer.' },
  { cle: 'plage', seed: 620012, prompt: 'mila walks barefoot along the shoreline at golden hour in a light white summer dress, her hair moving in the breeze, she turns her head and smiles, slow lateral tracking shot. Sound of waves and sea breeze.' },
  { cle: 'marche', seed: 620013, prompt: 'mila browses a flower market along an Amsterdam canal in a beige trench coat, she picks up a bouquet of tulips and smells them, soft overcast light, medium shot, slow dolly. Ambient market chatter.' },
]
for (const p of PLANS) await post({
  mode: 'video', purpose: 'creative', recipeId: 'sfw@v1', t2v: true, t2vPersonnage: true, personaId: 'mila',
  videoEngine: 'ltx_hq', withAudio: true, videoSeconds: 6, videoFps: 24, videoAspect: '9:16', videoDraft: false,
  seed: { mode: 'lock', value: p.seed }, userPrompt: p.prompt, userDirectives: '',
  composedPositive: `${p.prompt} single continuous shot, no cuts`, composedNegative: '',
  selections: { task: 't2v', engine: 'ltx_hq', withAudio: true, t2vPersonnage: true }, loras: [], videoLoras: [],
  requestId: `banc-mila-t2v-${p.cle}-${p.seed}`,
}, `t2v ${p.cle}`)
for (const [cle, seed, prompt] of [
  ['cafe', 620021, 'a woman sitting at a small round table on a sunny Paris café terrace, cream knit sweater, holding a cup of coffee, smiling at the camera, soft morning light, photo'],
  ['plage', 620022, 'a woman walking barefoot on the shoreline at golden hour, light white summer dress, hair in the breeze, smiling, photo'],
]) await post({
  mode: 'photo', purpose: 'creative', op: 'generate', recipeId: 'sfw@v1', photoEngine: 'krea', personaId: 'mila',
  seed: { mode: 'lock', value: seed }, width: 768, height: 1344,
  userPrompt: prompt, userDirectives: '', composedPositive: prompt, composedNegative: '',
  selections: { task: 'generate' }, loras: [], videoLoras: [], requestId: `banc-mila-photo-${cle}-${seed}`,
}, `photo ${cle}`)
