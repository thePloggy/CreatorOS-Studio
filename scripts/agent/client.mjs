/* ============================================================
   Studio client for agents, shared by the command line
   (studio.mjs) and the MCP server (mcp.mjs).

   Talks only to the HTTP API of a running studio: same routes as
   the UI, same checks (content filter, queue, quota).
   Nothing is rendered here, nothing is read from the server's disk.

   STUDIO_URL       studio address (default http://127.0.0.1:8787)
   CREATOROS_OWNER_KEY  owner key, if the studio requires one
   ============================================================ */

const FINIS = new Set(['done', 'blocked', 'cancelled'])
// reel states (server/reel.js), reported in English to agents
const ETATS = { redaction: 'writing', photos: 'photos', clips: 'clips', export: 'export', fini: 'done', echec: 'failed' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const id = prefixe => `${prefixe}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function client({ url = process.env.STUDIO_URL || 'http://127.0.0.1:8787', cle = process.env.CREATOROS_OWNER_KEY } = {}) {
  const base = url.replace(/\/+$/, '')

  async function api(chemin, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (cle) headers['X-Owner-Key'] = cle
    let r
    try { r = await fetch(base + chemin, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) }) }
    catch (e) { throw new Error(`studio unreachable at ${base} (${e.cause?.code ?? e.message}) — is it running? (npm start)`) }
    const texte = await r.text()
    let d = null
    try { d = texte ? JSON.parse(texte) : null } catch { /* non-JSON response */ }
    if (!r.ok) throw new Error(d?.error ?? `${method} ${chemin} → HTTP ${r.status}`)
    return d
  }

  const media = a => a && ({ id: a.id, type: a.mediaType, url: a.uri?.startsWith('http') ? a.uri : base + (a.uri ?? `/media/${a.filename}`),
    width: a.width, height: a.height, check: a.controle ?? undefined })

  /** Job state: status, error, and its media once rendered. */
  async function job(jobId) {
    const d = await api(`/api/jobs/${encodeURIComponent(jobId)}`)
    return { id: d.job.id, status: d.job.status, mode: d.job.mode, error: d.job.error ?? undefined, queuePosition: d.job.file?.rang ?? undefined,
      progress: d.job.progress ?? undefined, media: (d.assets ?? []).map(media) }
  }

  /** Waits for a job to finish (polls every 3 s). */
  async function attendreJob(jobId, { maxMs = 30 * 60_000, surEtape } = {}) {
    const fin = Date.now() + maxMs
    let dernier = ''
    for (;;) {
      const j = await job(jobId)
      if (surEtape && j.status !== dernier) surEtape(j)
      dernier = j.status
      if (FINIS.has(j.status)) return j
      if (Date.now() > fin) throw new Error(`job ${jobId} still "${j.status}" after ${Math.round(maxMs / 60_000)} min`)
      await sleep(3000)
    }
  }

  async function personaActive(persona) {
    if (persona) return persona
    return (await api('/api/personas')).active ?? undefined
  }

  /* Optional settings: photo engine (krea | klein), fixed seed, forced VRAM
     profile (owner only: ignored by the server for a visitor). */
  const options = ({ moteur, graine, profil }) => ({
    ...(moteur ? { photoEngine: moteur } : {}),
    ...(Number.isFinite(graine) ? { seed: { mode: 'lock', value: graine } } : {}),
    ...(profil ? { profilVram: profil } : {}),
  })

  /** A photo from a prompt sent as written. */
  async function photo({ prompt, persona, largeur = 768, hauteur = 1344, moteur, graine, profil }) {
    if (!String(prompt ?? '').trim()) throw new Error('empty prompt')
    const p = String(prompt).trim()
    const r = await api('/api/jobs', { method: 'POST', body: {
      id: id('cli'), mode: 'photo', register: 'sfw', purpose: 'creative', personaId: await personaActive(persona),
      userPrompt: p, composedPositive: p, composedNegative: '', width: largeur, height: hauteur, ...options({ moteur, graine, profil }) } })
    return { jobId: r.id }
  }

  /** A video from a library image (its asset id) and a motion. */
  async function video({ image, geste, moteur = 'ltx_hq', secondes, son = true, persona, graine, profil }) {
    if (!image) throw new Error('missing start image (the id of a library item)')
    if (!String(geste ?? '').trim()) throw new Error('describe the motion')
    const { filename } = await api(`/api/assets/${encodeURIComponent(image)}/to-input`, { method: 'POST', body: {} })
    const g = String(geste).trim()
    const r = await api('/api/jobs', { method: 'POST', body: {
      id: id('cli'), mode: 'video', register: 'sfw', purpose: 'creative', personaId: await personaActive(persona),
      videoEngine: moteur, withAudio: !!son, sourceImage: filename, videoSeconds: secondes ?? null,
      userPrompt: g, composedPositive: `${g}. single continuous shot, no cuts`, composedNegative: '', ...options({ graine, profil }) } })
    return { jobId: r.id }
  }

  /** A full reel from a brief: written shots, photos, clips, edit. */
  async function reel({ brief, plans = 4, duree = 4, langue = 'en' }) {
    const r = await api('/api/reels', { method: 'POST', body: { brief, n: plans, duree, langue } })
    return { reelId: r.id, state: ETATS[r.etat] ?? r.etat }
  }

  async function etatReel(reelId) {
    const r = await api(`/api/reels/${encodeURIComponent(reelId)}`)
    const asset = r.reelAsset ? (await api('/api/assets?persona=all&limit=200')).assets.find(a => a.id === r.reelAsset) : null
    return { id: r.id, state: ETATS[r.etat] ?? r.etat, error: r.erreur ?? undefined, shots: (r.plans ?? []).length, video: media(asset) ?? undefined }
  }

  async function attendreReel(reelId, { maxMs = 60 * 60_000, surEtape } = {}) {
    const fin = Date.now() + maxMs
    let dernier = ''
    for (;;) {
      const r = await etatReel(reelId)
      if (surEtape && r.state !== dernier) surEtape(r)
      dernier = r.state
      if (r.state === 'done' || r.state === 'failed') return r
      if (Date.now() > fin) throw new Error(`reel ${reelId} still "${r.state}" after ${Math.round(maxMs / 60_000)} min`)
      await sleep(5000)
    }
  }

  /** The latest library media. */
  async function bibliotheque({ n = 10, persona } = {}) {
    const d = await api(`/api/assets?limit=${Math.min(200, n)}${persona ? `&persona=${encodeURIComponent(persona)}` : ''}`)
    return d.assets.slice(0, n).map(media)
  }

  async function personas() {
    const d = await api('/api/personas')
    return { active: d.active, characters: d.personas.map(p => ({ id: p.id, name: p.name ?? p.nom ?? p.id })) }
  }

  async function machine() {
    const [h, a] = await Promise.all([api('/api/health'), api('/api/machine/allegement').catch(() => null)])
    return { comfyui: h.comfy, queue: h.queue, gpu: h.vram ? `${h.vram.name}, ${Math.round(h.vram.totalMb / 1024)} GB` : null,
      videoEngines: Object.keys(h.videoEngines ?? {}), vramProfile: a?.profil ?? null }
  }

  /** The catalogue of dances and the 3D studios to perform them in. */
  async function danses() {
    const d = await api('/api/danses')
    return { dances: d.danses.map(x => ({ slug: x.slug, title: x.titre, seconds: Math.round(x.secondes * 10) / 10 })), studios: d.studios.map(x => ({ id: x.id, name: x.nom })) }
  }

  /** A catalogue dance performed by the character of a photo, in a 3D studio. The final render is
      job "<id>-swap" (3D scene, then Swap applying the photo's identity and outfit). */
  async function danse({ photo, danse: slug, studio, description, suivi = false }) {
    if (!photo) throw new Error('missing photo (the id of a library photo of the character)')
    const r = await api('/api/danses/scene3d', { method: 'POST', body: { assetId: photo, slug, decor: studio, scene: description ?? '', suivi: !!suivi } })
    return { jobId: r.id, finalJobId: `${r.id}-swap` }
  }

  /** A music track (ACE-Step, two takes) or a sound effect; the file joins the edit's music list. */
  async function musique({ style, paroles = '', secondes = 30, bruitage = false }) {
    const r = await api('/api/musique', { method: 'POST', body: { prompt: style, paroles, secondes, genre: bruitage ? 'bruitage' : 'musique' } })
    return { jobId: r.jobId }
  }

  async function musiques() {
    return (await api('/api/montage/musiques')).musiques.map(m => ({ file: m.nom, seconds: m.duree, bytes: m.bytes }))
  }

  async function voix() {
    const d = await api('/api/voix')
    return { available: d.disponible, voices: d.voix, cloning: d.clone }
  }

  /** A sentence spoken by a synthetic voice; returns the audio file, reusable for a talking clip. */
  async function dire({ texte, voix: v }) {
    const r = await api('/api/parole/dire', { method: 'POST', body: { texte, voix: v } })
    return { audioFile: r.fichier, seconds: r.duree }
  }

  /** A talking photo: the photo and an uploaded audio file (from speak or the UI). */
  async function parole({ photo, audio, texte }) {
    const r = await api('/api/parole', { method: 'POST', body: { assetId: photo, voix: audio, texte } })
    return { jobId: r.id }
  }

  /** Clip edit: a one-click effect (refine-details, day-to-night, deblur, decompression) or a
      prompt edit (modify / remove an element tracked by SAM3, change the background). */
  async function editionVideo({ clip, mode, effet, cible, prompt }) {
    const r = await api(`/api/assets/${encodeURIComponent(clip)}/edit-video`, { method: 'POST', body: { mode, effet, cible, prompt } })
    return { jobId: r.jobId ?? r.id }
  }

  return { api, job, attendreJob, photo, video, reel, etatReel, attendreReel, bibliotheque, personas, machine, danses, danse, musique, musiques, voix, dire, parole, editionVideo }
}
