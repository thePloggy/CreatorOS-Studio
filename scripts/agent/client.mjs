/* ============================================================
   Client du studio pour les agents — partagé par la ligne de
   commande (studio.mjs) et le serveur MCP (mcp.mjs).

   Il ne fait que parler à l'API HTTP d'un studio qui tourne déjà : mêmes
   routes que l'interface, mêmes contrôles (filtre de contenu, file, quota).
   Rien n'est rendu ici, rien n'est lu sur le disque du serveur.

   STUDIO_URL       adresse du studio (défaut http://127.0.0.1:8787)
   CREATOROS_OWNER_KEY  clé de propriétaire, si le studio en demande une
   ============================================================ */

const FINIS = new Set(['done', 'blocked', 'cancelled'])
// états d'un reel (server/reel.js), dits en anglais aux agents
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
    try { d = texte ? JSON.parse(texte) : null } catch { /* réponse non JSON */ }
    if (!r.ok) throw new Error(d?.error ?? `${method} ${chemin} → HTTP ${r.status}`)
    return d
  }

  const media = a => a && ({ id: a.id, type: a.mediaType, url: a.uri?.startsWith('http') ? a.uri : base + (a.uri ?? `/media/${a.filename}`),
    width: a.width, height: a.height, check: a.controle ?? undefined })

  /** État d'un job : statut, erreur, et ses médias une fois rendus. */
  async function job(jobId) {
    const d = await api(`/api/jobs/${encodeURIComponent(jobId)}`)
    return { id: d.job.id, status: d.job.status, mode: d.job.mode, error: d.job.error ?? undefined, queuePosition: d.job.file?.rang ?? undefined,
      progress: d.job.progress ?? undefined, media: (d.assets ?? []).map(media) }
  }

  /** Attend la fin d'un job (sondage toutes les 3 s). */
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

  /* Réglages facultatifs : moteur photo (krea | klein), graine fixe, profil de VRAM
     forcé (réservé au propriétaire : ignoré par le serveur pour un visiteur). */
  const options = ({ moteur, graine, profil }) => ({
    ...(moteur ? { photoEngine: moteur } : {}),
    ...(Number.isFinite(graine) ? { seed: { mode: 'lock', value: graine } } : {}),
    ...(profil ? { profilVram: profil } : {}),
  })

  /** Une photo, à partir d'un prompt écrit tel qu'il partira. */
  async function photo({ prompt, persona, largeur = 768, hauteur = 1344, moteur, graine, profil }) {
    if (!String(prompt ?? '').trim()) throw new Error('empty prompt')
    const p = String(prompt).trim()
    const r = await api('/api/jobs', { method: 'POST', body: {
      id: id('cli'), mode: 'photo', register: 'sfw', purpose: 'creative', personaId: await personaActive(persona),
      userPrompt: p, composedPositive: p, composedNegative: '', width: largeur, height: hauteur, ...options({ moteur, graine, profil }) } })
    return { jobId: r.id }
  }

  /** Une vidéo à partir d'une image de la bibliothèque (son id d'asset) et d'un geste. */
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

  /** Un reel complet à partir d'un brief : plans rédigés, photos, clips, montage. */
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

  /** Les derniers médias de la bibliothèque. */
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

  return { api, job, attendreJob, photo, video, reel, etatReel, attendreReel, bibliotheque, personas, machine }
}
