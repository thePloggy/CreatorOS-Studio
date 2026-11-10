/* ============================================================
   Visits: how many visitors per day, and a render limit for those coming
   from the Internet (Tailscale Funnel).

   Nothing personal is kept: a visitor is a fingerprint
   sha256(daily salt + address + browser), truncated, used only to count
   distinct visitors of the day. The salt changes daily and is never
   written: yesterday's fingerprint links to nothing. On disk, only daily
   counters (visites.json).

   A tailnet visitor (Tailscale-User-Login header set by `tailscale serve`)
   or the owner is neither counted as an Internet visitor nor limited.
   Page loads do not carry the key: the owner is recognized at the
   POST /api/proprietaire the page sends on startup, and their fingerprint
   then leaves the day's count (visitor and pages already counted included).

   Internet visitor renders: each is tracked to completion and logged
   (journal-visiteurs.json, last 200: type, duration, failure cause). The
   owner is notified on launch, failure and refusal (see notif.js).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { notifier } from './notif.js'

/* Per Internet visitor and per hour, one render = one image or clip LAUNCHED:
   counting requests would let a carousel or reel pass as 1. */
const RENDUS_PAR_HEURE = 12
/* Minimum cost of a request whose jobs are created later (the reel schedules its
   shots after the response): 5 photos + 5 clips on average. */
const COUT_MINIMUM = { 'POST /api/reels': 10, 'POST /api/danses/scene3d': 3, 'POST /api/assets/:id/moment-suivant': 0 }   // text only: the following edit is counted
const FILE_MAX_PUBLIC = 8      // beyond this, an Internet visitor waits for the queue to empty

/** Routes that launch a GPU render. */
const ROUTES_RENDU = new Set([
  'POST /api/jobs', 'POST /api/jobs/:id/retry', 'POST /api/carrousel', 'POST /api/reels',
  'POST /api/assets/:id/photo-hd', 'POST /api/assets/:id/recadrer', 'POST /api/croquis', 'POST /api/restauration', 'POST /api/croquis/:id/choisir', 'POST /api/extensions/:id/lancer', 'POST /api/assets/:id/analyse', 'POST /api/assets/:id/pack-pub', 'POST /api/pack-pub', 'POST /api/voix', 'POST /api/assets/:id/doubler', 'POST /api/assets/:id/inpaint', 'POST /api/assets/:id/agrandir', 'POST /api/assets/:id/transparent', 'POST /api/assets/:id/moment-suivant', 'POST /api/assets/:id/seedvr', 'POST /api/stage', 'POST /api/assets/:id/edit-video',
  'POST /api/assets/:id/upscale', 'POST /api/montages/:id/export', 'POST /api/presets/:id/lancer',
  'POST /api/parole', 'POST /api/reshoot', 'POST /api/assets/:id/objet3d', 'POST /api/musique', 'POST /api/montage/transition', 'POST /api/assets/:id/master', 'POST /api/reels/:id/plans/:k/refaire',
  'POST /api/danses/scene3d', 'POST /api/assets/:id/essayage', 'POST /api/assets/:id/photodump', 'POST /api/assets/:id/style-reference',
])

const JOURNAL_MAX = 200

/** What is reported about a render: mode and recipe or engine, without the prompt. */
const typeDe = row => {
  let p = null
  try { p = JSON.parse(row.payload || 'null') } catch { /* unreadable payload */ }
  const quoi = p?.videoEngine ?? row.recipe_id?.split('@')[0] ?? row.workflow_file?.replace(/\.json$/, '') ?? ''
  return [row.mode, quoi].filter(Boolean).join(' · ')
}
/** Job ids from a render route response, whatever its shape. */
function idsDe(v, out = new Set(), cle = '') {
  if (typeof v === 'string') { if (/^(id|jobId|jobIds|ids|jobs)$/.test(cle)) out.add(v) }
  else if (Array.isArray(v)) v.forEach(x => idsDe(x, out, cle))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) idsDe(x, out, k)
  return out
}

export function installerVisites(app, { dataDir, estProprietaire, avecCle, profondeurFile, lireJob }) {
  const fichier = path.join(dataDir, 'visites.json')
  let jours = {}
  try { jours = JSON.parse(fs.readFileSync(fichier, 'utf8')) } catch { /* first day */ }
  let sel = { jour: '', valeur: '' }, vus = new Set(), rendus = new Map()
  let pagesDe = new Map(), proprietaires = new Set()   // per fingerprint, for the day
  let bannis = new Set()   // fingerprints refused by the content filter: no more renders until midnight
  let sale = false
  const jourDe = () => new Date().toISOString().slice(0, 10)
  // rendus = Internet visitors; rendusProprietaire = owner and tailnet
  const compteurs = j => (jours[j] ??= { visiteurs: 0, pages: 0, rendus: 0, rendusProprietaire: 0, refuses: 0, tailnet: 0 })
  const empreinte = req => {
    const j = jourDe()
    if (sel.jour !== j) { sel = { jour: j, valeur: crypto.randomBytes(16).toString('hex') }; vus = new Set(); rendus = new Map(); pagesDe = new Map(); proprietaires = new Set(); bannis = new Set() }
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim()
    // address only, so switching browser does not reset quota or daily block
    return crypto.createHash('sha256').update(`${sel.valeur}|${ip}`).digest('hex').slice(0, 16)
  }
  // identity set by Tailscale for a tailnet device; an Internet request via Funnel never has it
  const duTailnet = req => !!req.headers['tailscale-user-login'] && !req.headers['tailscale-funnel-request']

  /* ---------- owner render log: their origin (device, Internet with the key, machine) ---------- */
  const fichierProprio = path.join(dataDir, 'journal-proprietaire.json')
  let journalProprio = []
  try { journalProprio = JSON.parse(fs.readFileSync(fichierProprio, 'utf8')) } catch { /* no log yet */ }
  const noterProprietaire = e => {
    journalProprio.unshift({ at: Date.now(), ...e }); journalProprio.length = Math.min(journalProprio.length, 500)
    fs.writeFile(fichierProprio, JSON.stringify(journalProprio, null, 1), () => {})
  }

  /* ---------- visitor render log ---------- */
  const fichierJournal = path.join(dataDir, 'journal-visiteurs.json')
  let journal = []
  try { journal = JSON.parse(fs.readFileSync(fichierJournal, 'utf8')) } catch { /* no log yet */ }
  const suivis = new Map()   // jobId → { depuis, route }
  const noter = e => {
    journal.unshift({ at: Date.now(), ...e }); journal.length = Math.min(journal.length, JOURNAL_MAX)
    fs.writeFile(fichierJournal, JSON.stringify(journal, null, 1), () => {})
  }
  setInterval(() => {
    for (const [id, s] of suivis) {
      const row = lireJob(id)
      if (!row) { suivis.delete(id); continue }
      if (row.status !== 'done' && row.status !== 'blocked') {
        if (Date.now() - s.depuis > 6 * 3600_000) suivis.delete(id)   // abandoned after 6 h
        continue
      }
      suivis.delete(id)
      const annule = row.status === 'blocked' && /annulé par/i.test(row.error ?? '')
      const statut = row.status === 'done' ? 'terminé' : annule ? 'annulé' : 'échec'
      const e = { job: id, type: typeDe(row), statut, dureeMs: row.duration_ms ?? (Date.now() - s.depuis), erreur: statut === 'échec' ? String(row.error ?? '').slice(0, 400) : undefined }
      noter(e)
      if (statut === 'échec') void notifier(`Rendu visiteur en échec · ${e.type}`, `#${id} — ${e.erreur || 'sans message'}`, { tags: ['warning'], priorite: 4 })
    }
  }, 10_000).unref()
  const refuser = (raison, route) => {
    noter({ type: route, statut: 'refusé', erreur: raison })
    void notifier('Rendu visiteur refusé', `${route} — ${raison}`, { tags: ['no_entry'] })
  }
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.rendusVisiteur || reply.statusCode >= 400 || typeof payload !== 'string') return payload
    let corps = null
    try { corps = JSON.parse(payload) } catch { return payload }
    const lances = [...idsDe(corps)].map(id => lireJob(id)).filter(Boolean)
    for (const row of lances) suivis.set(row.id, { depuis: Date.now(), route: req.rendusVisiteur })
    // what the request actually launched, counted against the visitor for the coming hour
    const cout = Math.max(lances.length, COUT_MINIMUM[req.rendusVisiteur] ?? 1)
    const liste = rendus.get(req.empreinteVisiteur) ?? []
    for (let i = 0; i < cout; i++) liste.push(Date.now())
    rendus.set(req.empreinteVisiteur, liste)
    compteurs(jourDe()).rendus += cout; sale = true
    if (lances.length) {
      const types = [...new Set(lances.map(typeDe))].join(', ')
      void notifier('Un visiteur lance un rendu', `${types}${lances.length > 1 ? ` (${lances.length} jobs)` : ''} · file : ${profondeurFile()}`, { tags: ['art'] })
    }
    return payload
  })
  setInterval(() => {
    if (!sale) return
    sale = false
    fs.writeFile(fichier, JSON.stringify(jours, null, 1), () => {})
  }, 30_000).unref()

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    // a page = the app document, not its files or the API
    if (req.method === 'GET' && !url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(url)) {
      // pages = Internet visitors; tailnet = owner and tailnet
      const c = compteurs(jourDe()); sale = true
      if (duTailnet(req)) { c.tailnet++; return }
      const e = empreinte(req)
      if (proprietaires.has(e)) { c.tailnet++; return }
      c.pages++; pagesDe.set(e, (pagesDe.get(e) ?? 0) + 1)
      if (!vus.has(e)) { vus.add(e); c.visiteurs++ }
      return
    }
    if (req.method === 'POST' && url === '/api/proprietaire') {
      if (!avecCle() || duTailnet(req) || !estProprietaire(req)) return
      const e = empreinte(req)
      if (proprietaires.has(e)) return
      proprietaires.add(e)
      const c = compteurs(jourDe()), n = pagesDe.get(e) ?? 0
      if (vus.has(e)) c.visiteurs = Math.max(0, c.visiteurs - 1)
      c.pages = Math.max(0, c.pages - n); c.tailnet += n; sale = true
      return
    }
    if (!ROUTES_RENDU.has(`${req.method} ${req.routeOptions?.url}`)) return
    const c = compteurs(jourDe())
    if (duTailnet(req) || estProprietaire(req)) {
      c.rendusProprietaire = (c.rendusProprietaire ?? 0) + 1; sale = true
      // where an owner render comes from: a tailnet device, Internet with the key, or the machine itself
      const viaFunnel = !!req.headers['tailscale-funnel-request'] || String(req.headers.host ?? '').endsWith(':8443')
      noterProprietaire({ route: `${req.method} ${req.url.split('?')[0]}`,
        origine: duTailnet(req) ? `tailnet ${req.headers['tailscale-user-login']}` : viaFunnel ? 'Internet (Funnel) avec la clé' : 'machine locale',
        navigateur: String(req.headers['user-agent'] ?? '').slice(0, 160) })
      return
    }
    const e = empreinte(req), maintenant = Date.now()
    if (bannis.has(e)) {
      c.refuses++; sale = true
      refuser('visiteur bloqué pour la journée (contenu interdit)', `${req.method} ${req.routeOptions?.url}`)
      reply.code(403).send({ error: 'demande refusée : ce studio ne produit aucun contenu impliquant un mineur, ni de contenu sexuel' })
      return reply
    }
    const recents = (rendus.get(e) ?? []).filter(t => maintenant - t < 3600_000)
    if (recents.length >= RENDUS_PAR_HEURE) {
      c.refuses++; sale = true
      refuser(`limite de ${RENDUS_PAR_HEURE} rendus par heure atteinte`, `${req.method} ${req.routeOptions?.url}`)
      reply.code(429).send({ error: `limite de la démo publique : ${RENDUS_PAR_HEURE} images ou clips par heure et par visiteur` })
      return reply
    }
    if (profondeurFile() >= FILE_MAX_PUBLIC) {
      c.refuses++; sale = true
      refuser(`file publique pleine (${FILE_MAX_PUBLIC})`, `${req.method} ${req.routeOptions?.url}`)
      reply.code(503).send({ error: 'le GPU de la démo est occupé : réessaie dans quelques minutes' })
      return reply
    }
    rendus.set(e, recents)   // the cost is added to the response once the number of launched renders is known
    req.empreinteVisiteur = e
    req.rendusVisiteur = `${req.method} ${req.routeOptions?.url}`
  })

  // owner only (see ROUTES_PROPRIETAIRE)
  /* What remains for the visitor this hour: shown in the header next to the
     machine indicator. The owner and tailnet have no limit. */
  app.get('/api/quota', async req => {
    if (estProprietaire(req) || duTailnet(req)) return { illimite: true, limite: RENDUS_PAR_HEURE }
    const e = empreinte(req), maintenant = Date.now()
    const recents = (rendus.get(e) ?? []).filter(t => maintenant - t < 3600_000).sort((x, y) => x - y)
    const restants = Math.max(0, RENDUS_PAR_HEURE - recents.length)
    // when the limit is reached: how long until the oldest render leaves the hour window
    const libreDansMs = restants > 0 ? 0 : Math.max(0, recents[recents.length - RENDUS_PAR_HEURE] + 3600_000 - maintenant)
    return { illimite: false, limite: RENDUS_PAR_HEURE, restants, libreDansMs, bloque: bannis.has(e) }
  })
  app.get('/api/visites', async () => ({
    jours: Object.entries(jours).sort(([a], [b]) => b.localeCompare(a)).map(([jour, c]) => ({ jour, ...c })),
    limites: { rendusParHeure: RENDUS_PAR_HEURE, fileMaxPublic: FILE_MAX_PUBLIC },
    journal: journal.slice(0, 50),
    enCours: suivis.size,
  }))
  /* Request refused by the content filter: logged and notified, whether it
     comes from a visitor or the tailnet. */
  return {
    refuserContenu: (terme, route, req) => {
      const visiteur = !estProprietaire(req) && !duTailnet(req)
      if (visiteur) bannis.add(empreinte(req))
      const qui = estProprietaire(req) ? 'propriétaire' : duTailnet(req) ? 'tailnet' : `visiteur ${empreinte(req).slice(0, 6)}, bloqué pour la journée`
      noter({ type: route, statut: 'refusé', erreur: `contenu interdit (« ${terme} ») — ${qui}` })
      void notifier('Demande refusée : contenu lié à un mineur ou sexuel', `${route} — « ${terme} » — ${qui}`, { tags: ['rotating_light'], priorite: 5 })
    },
  }
}
