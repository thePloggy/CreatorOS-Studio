/* ============================================================
   CreatorOS: single server for the built front end, API, media and DB.
   One process (`npm start`). Listens on loopback only by default
   (CREATOROS_HOST to expose it).
   ============================================================ */
import { etatAllegement } from './allege.js'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import QRCode from 'qrcode'
import { installerVisites } from './visites.js'
import { CONFIG } from './config.js'
import { fetchOllama, blocOllama, etat as etatGpu } from './gpu.js'
import * as store from './db.js'
import { demarrerFiltre, filtrerNouveaux } from './filtreImages.js'
import { depotVisiteur, TYPES_DEPOT } from './depots.js'
import { analyserClip, describeOutfit, describeScene, decomposeScene, momentSuivant } from './vision.js'
import * as comfy from './comfy.js'
import * as prompts from './prompts.js'
import * as composer from './composer.js'
import * as carrousel from './carrousel.js'
import * as captions from './captions.js'
import { ensurePoster } from './poster.js'
import { T0_BLOCKLIST, t0Hit, t0Mineur } from './t0.js'
import { SANS_PERSONNAGE, persona, personas, identityPreambleFor, enregistrer as enregistrerPersona, champsFiges, creer as creerPersona, activer as activerPersona, supprimer as supprimerPersona } from './persona.js'
import { lireCreateur, ecrireCreateur } from './createur.js'
import { etatCloud, importerCloud, tacheCloud } from './cloud-loras.js'
import { cheminTemporaire, finaliserLora, etatLorasPersonas, reparerLorasPersonas } from './installationLora.js'
import { enqueuePlanLong, H3_MESSAGE_DEMO, OPS_RELANCABLES, relancerSpecial, avancementEntrainements, enqueueEntrainement, enqueueDoublage, enqueueRecadrage, enqueueObjet3d, enqueueMusique, cheminModele, enqueueParole, enqueueReshoot, enqueueCleanPlate, enqueueEffetLtx, enqueueTransition, EFFETS_TRANSITION, enqueueDanse3d, STUDIOS_DANSE, enqueueDetour, enqueueTransparent, enqueueProfondeur, enqueueSeedvr, enqueueStage, sceneReshoot, deposerAvecCle, enqueue, enqueueParPlans, enqueueInpaint, enqueueInpaintVideo, enqueueUpscale, enqueueFinition, enqueueEssayage, enqueuePhotodump, enqueueStyleRef, enqueuePhotoHd, cancelJob, promoteJob, reorderQueue, RENDER_RATES, driverMeta, recoverQueue, queueDepth, placeDansFile, RECIPES, VIDEO_ENGINES, recettesServies, DEFAULT_VIDEO_ENGINE, MOTION_RECIPES, DEPRECATED_RECIPES } from './jobs.js'
import { diagnostiquer, figerNoeuds, resumeDiagnostic } from './diagnostic.js'
import * as montage from './montage.js'
import { master } from './master.js'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import * as reel from './reel.js'
import * as reelPresets from './reelPresets.js'
import * as danses from './danses.js'
import * as presets from './presets.js'

// 256 MB: Motion Control drivers are videos, larger than photos.
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip)
import { demoPublique, etatH3, recevoirFichierH3 } from './h3.js'
import * as planlong from './planlong.js'
import { lancerCroquis, etatCroquis, choisirCroquis } from './croquis.js'
import { lancerRestauration, etatRestauration } from './restauration.js'
import { VOIX, changerVoix, cloner, cloneDisponible, dire, echantillon, synthetiser, voixAcceptee, voixDisponible } from './voix.js'
import { aiToolkitPret, moteurEntrainementPret, MOTEURS_ENTRAINEMENT } from './entrainement.js'
import { creerPersonnage, etatCreation, propositions } from './createurPersonnage.js'
import { etatPack, lancerPack } from './packPub.js'
import * as extensions from './extensions.js'
import * as workflowsComfy from './workflowsComfy.js'
import * as noeudsComfy from './noeudsComfy.js'
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 256 * 1024 * 1024 })

/* ---------- owner lock (see CONFIG.cleProprietaire) ----------
   Renders, library and editing stay open to visitors; what is locked is
   the studio description and its settings. Picking the active character
   stays open. */
const ROUTES_PROPRIETAIRE = new Set([
  'DELETE /api/montage/musiques/:nom', 'POST /api/assets/:id/retemps',
  'PUT /api/createur', 'PUT /api/persona', 'POST /api/personas', 'PUT /api/personas/:id', 'PUT /api/personas/:id/voix',
  'DELETE /api/personas/:id', 'POST /api/persona/lora', 'POST /api/loras/reparer', 'PUT /api/persona/avatar',
  'PUT /api/persona/avatar/depuis-asset', 'PUT /api/workflows/:file', 'PUT /api/prompts/:file',
  'POST /api/corbeille/vider', 'POST /api/diagnostic/figer', 'GET /api/visites',
  // Public demo: the library is shared; a visitor cannot delete renders or browse the trash.
  'DELETE /api/assets/:id', 'POST /api/assets/restore', 'GET /api/corbeille', 'GET /api/corbeille/vue/:file',
  // Queue and library are shared: a visitor cannot cancel, duplicate, reorder or
  // modify others' work (jobs, reels, edits, folders, validation, delivery).
  'DELETE /api/jobs/:id', 'POST /api/jobs/:id/promote', 'POST /api/jobs/reorder', 'POST /api/jobs/:id/batch-id',
  'DELETE /api/reels/:id', 'POST /api/reels/:id/annuler', 'POST /api/reels/livrer', 'POST /api/captions',
  'DELETE /api/montages/:id', 'DELETE /api/folders/:id', 'PATCH /api/folders/:id', 'POST /api/folders/:id/assets',
  'PATCH /api/assets/:id', 'POST /api/briefs/star',
  // Public demo: a visitor starts only from studio-generated images, never from
  // a photo of a real person; the upload list is not public.
  'POST /api/upload', 'GET /api/uploads', 'POST /api/parole/voix', 'POST /api/parole/dire', 'POST /api/montage/musiques',
  'POST /api/telephone', 'GET /api/telephone/:jeton/etat', 'POST /api/stage/glb', 'PUT /api/modeles/h3/:nom', 'POST /api/personas/:id/entrainer', 'POST /api/voix/clone', 'POST /api/voix/changer', 'POST /api/extensions/:id/installer', 'POST /api/workflows-comfy/:id/telecharger', 'POST /api/workflows-comfy/:id/lancer', 'POST /api/comfy/maj', 'POST /api/comfy/noeuds', 'POST /api/comfy/redemarrer', 'POST /api/extensions/:id/retirer', 'POST /api/personnages/propositions', 'POST /api/personnages/creer',
])
const estProprietaire = req => {
  if (!CONFIG.cleProprietaire) return true
  const v = Buffer.from(String(req.headers['x-owner-key'] ?? ''))
  const k = Buffer.from(CONFIG.cleProprietaire)
  return v.length === k.length && crypto.timingSafeEqual(v, k)
}
app.addHook('onRequest', async (req, reply) => {
  if (!ROUTES_PROPRIETAIRE.has(`${req.method} ${req.routeOptions?.url}`) || estProprietaire(req)) return
  // a photo uploaded by a visitor is allowed: the route checks it (no person, see depots.js)
  if (`${req.method} ${req.routeOptions?.url}` === 'POST /api/upload' && TYPES_DEPOT[String(req.headers['content-type'] ?? '').split(';')[0]]) return
  const envoi = /^POST \/api\/(upload|parole\/voix|montage\/musiques)$/.test(`${req.method} ${req.routeOptions?.url}`)
  reply.code(403).send({ error: envoi
    ? 'sur la démo publique, on part d’une image générée par le studio : l’envoi de fichiers est réservé au propriétaire'
    : 'réservé au propriétaire du studio' })
})
app.post('/api/proprietaire', async req => ({ verrou: !!CONFIG.cleProprietaire, proprietaire: estProprietaire(req) }))
// visitors per day, render limit for Internet visitors (see visites.js)
const { refuserContenu } = installerVisites(app, { dataDir: CONFIG.dataDir, estProprietaire, avecCle: () => !!CONFIG.cleProprietaire, profondeurFile: () => queueDepth(), lireJob: id => store.getJob(id), marquerVisiteur: id => store.marquerVisiteur(id) })

/* No JSON response shows the server's home directory (recipe and database
   paths, ffmpeg or ComfyUI error messages): it is replaced with "~". */
const MAISON = os.homedir()
app.addHook('onSend', async (req, reply, payload) =>
  typeof payload === 'string' && MAISON.length > 1 && payload.includes(MAISON) ? payload.split(MAISON).join('~') : payload)
// (declared BEFORE compression: it must read the plain text)

/* API JSON is compressed: the library weighs hundreds of KB per visit.
   Declared after installerVisites, whose onSend must read the plain text. */
app.addHook('onSend', async (req, reply, payload) => {
  const type = String(reply.getHeader('content-type') ?? '')
  if (typeof payload !== 'string' || payload.length < 2048 || !type.includes('json') || reply.getHeader('content-encoding')) return payload
  const accepte = String(req.headers['accept-encoding'] ?? '')
  reply.header('Vary', 'Accept-Encoding')
  if (accepte.includes('br')) { reply.header('Content-Encoding', 'br'); return brotli(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) }
  if (accepte.includes('gzip')) { reply.header('Content-Encoding', 'gzip'); return gzip(payload, { level: 6 }) }
  return payload
})

/* Content filter on the RAW text of every request: the rewritten prompt is not
   enough, since the language model can "soften" it and let a banned term
   through. Every text sent to the API is read, except negatives (which name
   what is excluded) and owner settings (recipes, texts, characters). */
const sansFiltreContenu = new Set([...ROUTES_PROPRIETAIRE, 'POST /api/proprietaire'])
// studio-generated ids (render, batch, submission key): never read as text, since
// digits can decode to letters. They never enter a prompt.
const CLES_IDENTIFIANTS = new Set(['id', 'jobId', 'requestId', 'batchId', 'batchIds', 'parentAssetId', 'assetId', 'assetIds'])
function texteInterdit(v, cle = '') {
  if (/negati/i.test(cle)) return null
  if (CLES_IDENTIFIANTS.has(cle) && (typeof v === 'string' ? /^[\w-]{1,80}$/.test(v) : Array.isArray(v) && v.every(x => typeof x === 'string' && /^[\w-]{1,80}$/.test(x)))) return null
  // an encoded PNG image is not text (it is decoded then reduced to its lines):
  // random letters in it can form a banned term. Only a string ENTIRELY in strict
  // base64 is skipped; any other text is read.
  if (typeof v === 'string') return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v) ? null : t0Hit(v)
  if (Array.isArray(v)) { for (const x of v) { const h = texteInterdit(x, cle); if (h) return h } return null }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const h = texteInterdit(x, k); if (h) return h } }
  return null
}
const ROUTES_ADULTES = new Set(['POST /api/jobs', 'POST /api/compose', 'POST /api/rewrite', 'POST /api/carrousel'])
function mineurDans(v, cle = '') {
  if (CLES_IDENTIFIANTS.has(cle)) return null
  if (typeof v === 'string') return /^data:image\/png;base64,/.test(v) ? null : t0Mineur(v)
  if (Array.isArray(v)) { for (const x of v) { const h = mineurDans(x, cle); if (h) return h } return null }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const h = mineurDans(x, k); if (h) return h } }
  return null
}
app.addHook('preHandler', async (req, reply) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return
  const route = `${req.method} ${req.routeOptions?.url}`
  if (!req.url.startsWith('/api/') || sansFiltreContenu.has(route) || Buffer.isBuffer(req.body)) return
  /* Adult mode (local install): for generation and prompt rewriting only the "minors" floor
     is checked here; the render then decides based on image provenance (jobs.js). */
  const adulte = CONFIG.contenuAdulte && ROUTES_ADULTES.has(route)
  const terme = adulte ? (mineurDans(req.body) ?? mineurDans(req.query)) : (texteInterdit(req.body) ?? texteInterdit(req.query))
  if (!terme) return
  refuserContenu(terme, route, req)
  return reply.code(400).send({ error: 'demande refusée : ce studio ne produit aucun contenu impliquant un mineur, ni de contenu sexuel' })
})


/* ---------- SQL projections -> front-end contract ---------- */

const parse = s => { try { return s == null ? null : JSON.parse(s) } catch { return null } }

const jobOut = r => r && (p => ({
  id: r.id, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  // Estimate computed at enqueue (server/jobs.js estimateMs), in the payload.
  estimatedMs: p?.estimatedMs ?? null,
  // Engine and draft: shown by the queue placeholder.
  videoEngine: p?.videoEngine ?? undefined,
  videoDraft: p?.videoDraft ? true : undefined,
  // A single register: the response always says "sfw", whatever the database holds.
  status: r.status, personaId: r.persona_id, register: 'sfw',
  mode: r.mode, purpose: r.purpose, recipeId: r.recipe_id, workflowFile: r.workflow_file,
  comfyPromptId: r.comfy_prompt_id, seed: r.seed, userPrompt: r.user_prompt,
  userDirectives: r.user_directives, composedPositive: r.composed_positive,
  composedNegative: r.composed_negative, selections: parse(r.selections), error: r.error,
  // added fields: the job operation and, for a track or sound effect, its settings and takes (sound studio)
  op: p?.op ?? undefined,
  audio: p?.op === 'musique' ? reglagesAudio(r, p) : undefined,
}))((() => { try { return JSON.parse(r.payload || 'null') } catch { return null } })())

/** Settings of a music / sound effect render (see enqueueMusique) and its takes still in the audio library
 *  (same naming as runMusique: <root>_<6 chars of id>.mp3, then _2, _3...). */
function reglagesAudio(r, p) {
  const racine = String(p.userPrompt ?? '').normalize('NFD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'musique'
  const prises = r.status === 'done'
    ? [0, 1, 2, 3].map(k => `${racine}_${String(r.id).slice(-6)}${k ? `_${k + 1}` : ''}.mp3`).filter(n => fs.existsSync(path.join(montage.MUSIQUES_DIR, n)))
    : []
  return {
    genre: p.musiqueBruitage ? 'bruitage' : 'musique', style: p.userPrompt ?? '', secondes: p.musiqueSecondes ?? null,
    paroles: p.musiqueParoles ?? '', bpm: p.musiqueBpm ?? null, tonalite: p.musiqueTonalite ?? null, mesure: p.musiqueMesure ?? null,
    langue: p.musiqueLangue ?? null, voix: p.musiqueVoix ?? null, instruments: p.musiqueInstruments ?? [], prises,
  }
}

/** Searchable fields of an asset besides the prompt: recipe, engine, operation, LoRA. */
const motsDe = r => {
  const loras = []
  for (const brut of [r.job_loras, r.job_video_loras]) {
    try { for (const l of JSON.parse(brut || '[]') ?? []) if (l?.name) loras.push(String(l.name).split('/').pop().replace(/\.safetensors$/i, '')) } catch { /* missing or unreadable field */ }
  }
  return [r.recipe_id, r.workflow_file, r.video_engine, r.op, r.id, ...loras].filter(Boolean).join(' ').toLowerCase()
}

const assetOut = r => r && ({
  id: r.id, jobId: r.job_id, createdAt: r.created_at, mediaType: r.media_type,
  personaId: r.persona_id ?? null,
  uri: r.uri, filename: r.filename, bytes: r.bytes, width: r.width, height: r.height,
  aspect: r.aspect, register: 'sfw', reviewStatus: r.review_status,
  exportReady: !!r.export_ready,
  op: r.op ?? 'generate', videoEngine: r.video_engine ?? undefined,
  // 3D object: the GLB next to its turntable preview
  modele3d: r.job_op === 'objet3d' ? `/media/${r.job_id}.glb` : undefined,
  // 0.4 MP draft: read from the job payload (json_extract), no dedicated column;
  // the job is the source of truth and the badge applies retroactively.
  videoDraft: r.video_draft ? true : undefined,
  batchId: r.batch_id ?? undefined,
  // upscale (Photo HD, upscale): the source asset, for the before/after slider
  parentAssetId: r.parent_asset_id ?? undefined,
  origineUri: r.origine_uri ?? undefined,
  // multiple memberships (carousel sources), merged on the front end
  batchIds: r.batch_ids ? (() => { try { return JSON.parse(r.batch_ids) } catch { return undefined } })() : undefined,
  batchLocks: r.carousel_locks ? (() => { try { return JSON.parse(r.carousel_locks) } catch { return undefined } })() : undefined,
  // Job render duration (ms). 0 = unknown (resumed without start time):
  // the front end shows nothing rather than a wrong "0 s".
  renderMs: r.render_ms ?? undefined,
  // automatic clip check (timestamped defects, face score), see server/controle.js
  controle: r.controle ? (() => { try { return JSON.parse(r.controle) } catch { return undefined } })() : undefined,
  /* Joined provenance (see db.ASSET_SELECT): makes an asset reloaded from the
     database clonable on the front end. The injected workflow is NOT here (too
     heavy); it is served by /api/assets/:id/provenance. */
  recipeId: r.recipe_id ?? undefined,
  search: motsDe(r),
  seed: r.seed == null ? undefined : { mode: 'lock', value: r.seed },
  selections: parse(r.selections) ?? undefined,
  composedPositive: r.composed_positive ?? undefined,
  composedNegative: r.composed_negative ?? undefined,
  userPrompt: r.user_prompt ?? undefined,
  userDirectives: r.user_directives ?? undefined,
  initialBrief: r.initial_brief ?? undefined,
  promptVision: r.prompt_vision ?? undefined,
  promptReecrit: r.prompt_reecrit ?? undefined,
  videoFps: r.video_fps ?? undefined,
  // card badges: sound, ambient shot (text -> video), photo recipe, finish
  withAudio: r.with_audio ? true : undefined,
  t2v: r.t2v ? true : undefined,
  photoEngine: r.photo_engine ?? undefined,
  postOp: ['foley', 'interpolate', 'upscale', 'photo_hd'].includes(r.job_op) ? r.job_op : undefined,
  caption: r.caption ?? undefined,
  captionOptions: r.caption_options ? (() => { try { return JSON.parse(r.caption_options) } catch { return undefined } })() : undefined,
  folders: r.folder_ids ? (() => { try { const f = JSON.parse(r.folder_ids); return f.length ? f : undefined } catch { return undefined } })() : undefined,
})

/* ---------- API ---------- */

/** The persona as the front end sees it: configuration only (no file path).
 *  `name` null if not configured. */
const personaPublique = (id) => {
  const p = persona(id)
  const actif = id === undefined || id === personas().active
  return { id: p.id, name: p.name || null, trigger: p.trigger, description: p.description,
    preamble: p.preamble, loras: p.loras, lorasKlein: p.lorasKlein, lorasFlux3: p.lorasFlux3 ?? [], videoLoras: p.videoLoras, credit: p.credit, garderobe: p.garderobe, voix: p.voix ?? null, figes: actif ? champsFiges() : [],
    active: actif, avatar: avatarMeta(p.id).url,
    configured: Boolean(p.name || p.trigger || p.loras.length) }
}

/* Machine diagnostic: GET returns the last one (or runs one if older than
   2 min); ?frais=1 forces a full check (~4 s). Read-only. */
/* Log for a bug report, to paste into a GitHub issue. Nothing private:
   absolute paths are masked, no key, no prompt. */
const VERSION_STUDIO = (() => {
  let v = '0'
  try { v = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8')).version } catch { /* no package.json */ }
  try { v += '+' + execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(new URL(import.meta.url).pathname), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* not a git repo */ }
  return v
})()
const sansChemins = x => String(x ?? '').replace(/(?:\/[\w.@+-]+){2,}\/?/g, '<chemin>').replace(/[A-Z]:\\[^\s"']+/g, '<chemin>').slice(0, 300)
app.get('/api/journal-bug', async () => {
  const d = await diagnostiquer({ recettes: recettesServies(), frais: false }).catch(() => null)
  const echecs = store.listJobs(80).filter(j => j.status === 'blocked' && !/annulé par/i.test(j.error ?? '')).slice(0, 10)
  return {
    studio: VERSION_STUDIO, node: process.version, systeme: `${os.platform()} ${os.release()}`, file: queueDepth(),
    comfyui: comfy.etatLiaison()?.etat ?? 'inconnu',
    diagnostic: d ? { bloquants: d.bloquants, alertes: d.alertes, problemes: d.problemes.map(p => `${p.gravite} · ${p.domaine} — ${sansChemins(p.quoi)}`) } : null,
    echecsRecents: echecs.map(j => ({ job: j.id, quand: new Date(j.created_at).toISOString(), mode: j.mode, recette: j.recipe_id, erreur: sansChemins(j.error) })),
  }
})
app.get('/api/diagnostic', async (req) => ({
  ...await diagnostiquer({ recettes: recettesServies(), frais: req.query?.frais === '1' }),
  liaison: { ...comfy.etatLiaison(), bilan: bilanRetour },
}))
/* After a ComfyUI restart: once it responds again, the full diagnostic is
   rerun so a broken extension or missing recipe node is reported right
   away, not at the first failing render. */
let bilanRetour = null
comfy.onRetourComfy(async () => {
  await comfy.waitReady().catch(() => {})
  const d = await diagnostiquer({ recettes: recettesServies(), frais: true })
  bilanRetour = { quand: Date.now(), ok: d.ok, bloquants: d.bloquants, alertes: d.alertes }
  console.log(`[comfy] revenu après ${Math.round((comfy.etatLiaison().coupureMs ?? 0) / 1000)} s — bilan : `
    + (d.bloquants || d.alertes ? `${d.bloquants} bloquant(s), ${d.alertes} alerte(s)` : 'rien à signaler'))
})
/* Freezes current versions of ComfyUI and its extensions as the baseline. */
app.post('/api/diagnostic/figer', async () => {
  const r = await figerNoeuds()
  await diagnostiquer({ recettes: recettesServies(), frais: true })
  return r
})

/* Small machines: VRAM profile and lighter variants ready or missing. */
app.get('/api/machine/allegement', async () => etatAllegement())

app.get('/api/health', async req => {
  let comfyState = 'inatteignable'; let vram = null
  try {
    const s = await comfy.ping()
    comfyState = 'ok'
    const d = s.devices?.[0]
    if (d) vram = { name: d.name, freeMb: Math.round(d.vram_free / 1048576), totalMb: Math.round(d.vram_total / 1048576) }
  } catch (e) { comfyState = String(e.message || e).slice(0, 300) }
  return {
    ok: comfyState === 'ok', comfy: comfyState, vram, liaison: comfy.etatLiaison(),
    queue: queueDepth(), recipes: RECIPES, swapWorkflow: null,
    videoEngines: VIDEO_ENGINES, defaultVideoEngine: DEFAULT_VIDEO_ENGINE, h3: await etatH3().catch(() => null),
    composerModels: CONFIG.composerModels,
    // server paths: owner only (the public demo is on the Internet)
    ...(estProprietaire(req) ? { workflowsDir: CONFIG.workflowsDir, promptsDir: CONFIG.promptsDir,
      mediaDir: CONFIG.mediaDir, db: CONFIG.dbFile } : {}),
    ollamaUnload: CONFIG.ollamaUnload,
    // Studio locked by an owner key (the front end hides editing).
    verrou: !!CONFIG.cleProprietaire,
    // The front end reads these lists on mount instead of keeping a copy.
    t0Blocklist: T0_BLOCKLIST,
    // Layers the server prefixes to the prompt, so the console can show them
    // ("what will actually be sent" block). Predictive display; provenance
    // after render is authoritative.
    preambles: identityPreambleFor() ? { sfw: identityPreambleFor().text } : {},
    registerClauses: {},
    // The active persona (name null if not configured: the front end has its fallback).
    persona: personaPublique(),
    // Measured render time coefficients (estimate before submission).
    renderRates: RENDER_RATES,
    // Who holds the GPU (ComfyUI or Ollama), and who is waiting.
    gpu: etatGpu(),
    // last known diagnostic (without rerunning it): the UI shows an indicator
    diagnostic: resumeDiagnostic(),
  }
})

/** LoRA inventory with their real ARCHITECTURE (read from the header, not
 *  guessed from the name): the front end can offer only those that apply to
 *  the Z-Image engine and grey out the others with an explanation. */
/* ---------- machine telemetry ----------
   GPU via nvidia-smi, CPU via /proc/stat (delta between two calls; the
   first returns null) and k10temp (Tctl of AMD CPUs); elsewhere temperature
   stays null. Lightweight poll for a topbar refresh every ~5 s. Linux only. */
let cpuPrev = null
function cpuUtil() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
  const idle = line[3] + line[4]
  const total = line.reduce((a, b) => a + b, 0)
  const prev = cpuPrev
  cpuPrev = { idle, total }
  if (!prev || total === prev.total) return null
  return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100)
}

/* A single measurement shared by all clients, refreshed at most every 4 s and read without
   blocking the server, so open tabs do not each spawn nvidia-smi and the shared CPU delta
   stays correct. */
let telemetrie = { quand: 0, valeur: null, enCours: null }
const execFileAsync = promisify(execFile)
app.get('/api/telemetry', async () => {
  if (telemetrie.valeur && Date.now() - telemetrie.quand < 4000) return telemetrie.valeur
  telemetrie.enCours ??= mesurerTelemetrie().then(v => { telemetrie = { quand: Date.now(), valeur: v, enCours: null }; return v }, e => { telemetrie.enCours = null; throw e })
  return telemetrie.enCours
})
async function mesurerTelemetrie() {
  let gpu = null
  try {
    const out = (await execFileAsync('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
      '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 })).stdout.trim().split(',').map(x => x.trim())
    gpu = { util: Number(out[0]), temp: Number(out[1]), vramUsedMb: Number(out[2]), vramTotalMb: Number(out[3]), nom: String(out[4] ?? '').replace(/^NVIDIA\s+(GeForce\s+)?/, '') }
  } catch { /* driver busy: the topbar keeps the last value */ }
  let cpuTemp = null
  try {
    // k10temp = Tctl sensor of AMD CPUs.
    for (const d of fs.readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${d}`
      if (fs.readFileSync(`${base}/name`, 'utf8').trim() === 'k10temp') {
        cpuTemp = Math.round(Number(fs.readFileSync(`${base}/temp1_input`, 'utf8')) / 1000)
        break
      }
    }
  } catch { /* no sensor: null shown as — */ }
  let ram = null
  try {
    // System RAM: used = total - available (MemAvailable accounts for
    // reclaimable cache, unlike MemFree).
    const mi = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map(l => l.split(':')).filter(a => a.length === 2)
      .map(([k, v]) => [k.trim(), parseInt(v, 10)]))
    if (mi.MemTotal) ram = { usedMb: Math.round((mi.MemTotal - mi.MemAvailable) / 1024), totalMb: Math.round(mi.MemTotal / 1024) }
  } catch { /* no /proc: — */ }
  return { gpu, cpu: { util: cpuUtil(), temp: cpuTemp }, ram }
}

app.get('/api/loras', async () => comfy.listLoras())

/** Prompt rewriting by local LLM, on CPU. Synchronous on purpose: the front
 *  end waits for the text to show it in "Prompt composé", where the operator
 *  reviews and edits it before submitting the job. */
/* Short cache of compositions. The LLM runs on CPU (about a minute or more) and
   a phone may lock its screen before the response: the client fetch is
   aborted but Ollama completes. So the IN-FLIGHT promise and the result are
   kept 10 min per (register, prompt, directives): a second tap returns the
   computed response instead of rerunning. Keyed on the RAW text, before the
   wildcard draw, so a retap gets the same draw. A failure clears the entry
   so it can be retried. */
const composeCache = new Map()
const COMPOSE_TTL_MS = 10 * 60 * 1000
app.post('/api/compose', async (req, reply) => {
  const { userPrompt, userDirectives, mode, engine, soul, mood, anchorUri, anchorFile, previousPrompt, keepOutfit } = req.body || {}
  const register = 'sfw'
  /* Continuation (Extend tab): the prompt of the extended clip. Bounded: it is
     context only, and an oversized text would crowd out the instruction. */
  const prevPrompt = typeof previousPrompt === 'string' && previousPrompt.trim()
    ? previousPrompt.trim().slice(0, 6000) : null

  /* ---------- visual context ----------
     A start still (i2v, Move) or a source image (edit) is described by the VLM
     BEFORE rewriting, and the description is stitched into the user message.
     Without it the rewriter invents outfit and pose.
     The VLM runs on CPU (num_gpu 0, like the rewriter): it cannot compete with
     a ComfyUI render. */
  /* Describe THE FILE THE RENDER WILL USE, not a thumbnail picked by
     similarity. `anchorFile` is the name already placed in ComfyUI's input,
     exactly what the job sends as `sourceImage` / `motionRef`. It cannot
     diverge from the image actually animated, and it also covers uploads
     (whose front-end URI is a `blob:` unreadable on the server).
     `anchorUri` is a fallback when the upload has not happened yet.
     basename() in both cases: the name comes from the client. */
  let sceneDesc = null
  let outfitAnchor = null
  {
    const pathz = await import('node:path')
    let abs = null
    if (typeof anchorFile === 'string' && anchorFile.trim()
        && (estProprietaire(req) ? store.estInputStudio : store.estInputVisiteur)(pathz.basename(anchorFile)))
      abs = pathz.join(CONFIG.comfyInput, pathz.basename(anchorFile))
    else if (typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
      abs = pathz.join(CONFIG.mediaDir, pathz.basename(anchorUri))
    /* "Tenue de l'image": in ADDITION to the full description, a dedicated VLM
       call returning only the clothes (same function as the carousel anchor, plus
       the `filterOutfit` code filter). The composer inserts that text AS IS into
       the prompt, so it does not depend on the rewriter obeying. Both calls run
       together: they read the same image. */
    if (abs) {
      const [sd, od] = await Promise.all([
        describeScene(abs),
        keepOutfit === true ? describeOutfit(abs) : Promise.resolve(null),
      ])
      sceneDesc = sd
      outfitAnchor = od
    }
  }
  // The rewriter text (read from disk, editable in the Workbench) is part of
  // the key so an edited instruction does not serve a response computed with
  // the old one. `system` already reflects SOUL/MOOD layers when enabled
  // (default OFF = unchanged system), so the cache key distinguishes them.
  let system = ''
  try { system = composer.systemFor(register, mode ?? 'photo', engine ?? null, { soul: soul ?? null, mood: mood ?? null }) } catch { /* compose() will throw cleanly */ }
  /* The image description is part of the key: changing the still must give a
     different rewrite. */
  const key = JSON.stringify([register, mode ?? 'photo', system, userPrompt ?? '', userDirectives ?? '', sceneDesc ?? '', prevPrompt ?? '', outfitAnchor ?? ''])
  const hit = composeCache.get(key)
  const fresh = hit && Date.now() - hit.at < COMPOSE_TTL_MS
  const entry = fresh ? hit : { at: Date.now(), promise: composer.compose({ register, userPrompt, userDirectives, mode, engine, soul: soul ?? null, mood: mood ?? null, sceneDesc, previousPrompt: prevPrompt, outfitAnchor }) }
  if (!fresh) {
    composeCache.set(key, entry)
    entry.promise.catch(() => composeCache.delete(key))
    for (const [k, v] of composeCache) if (Date.now() - v.at > COMPOSE_TTL_MS) composeCache.delete(k)
  }
  try {
    const out = await entry.promise
    app.log.info(`compose ${out.model} (${out.device}) ${out.ms} ms, ${out.tokens} tok`
      + `${sceneDesc ? ' [+image]' : ''}${prevPrompt ? ' [+plan précédent]' : ''}${fresh ? ' [cache]' : ''}`)
    /* `sceneDesc` is returned to the front end so the operator can check WHAT the
       VLM saw: a wrong description and an ignored instruction are fixed in
       different places. */
    /* `outfitRequested` distinguishes "not requested" from "requested but no
       outfit seen": the front end tells the operator. */
    return { ...out, cached: Boolean(fresh), sceneDesc, continuation: Boolean(prevPrompt),
             outfitAnchor, outfitRequested: keepOutfit === true }
  } catch (e) {
    // 502, not 500: the failure is in Ollama, not CreatorOS. The front end
    // can say so to the operator instead of showing "error".
    reply.code(502)
    return { error: String(e.message || e) }
  }
})

/* ---------- recipes: read and edit from the Workbench ----------
   The Workbench edits the files ACTUALLY SERVED. `loadWorkflow` re-reads the
   disk on each job, so a write takes effect on the next job without restart,
   and a broken recipe would break production. Hence server-side validation
   before writing, not only in the browser. */

/** Who uses this file. Distinguishes a production recipe from a leftover
 *  test file in the same folder. */
function workflowUsage(file) {
  const uses = []
  for (const [reg, f] of Object.entries(RECIPES))
    if (f === file) uses.push({ kind: 'generate', register: reg })
  for (const [key, e] of Object.entries(VIDEO_ENGINES))
    if (e.file === file) uses.push({ kind: `video_${key}`, register: 'tous' })
  if (file === MOTION_RECIPES.preview) uses.push({ kind: 'motion_preview', register: 'tous' })
  if (file === MOTION_RECIPES.final) uses.push({ kind: 'motion', register: 'tous' })
  return { uses, deprecated: DEPRECATED_RECIPES[file] ?? null }
}

app.get('/api/workflows', async () => ({
  dir: CONFIG.workflowsDir,
  recipes: RECIPES,
  swapWorkflow: null,
  swapWorkflowExact: null,
  files: comfy.listWorkflows().map(file => {
    let st = null
    try { st = fs.statSync(comfy.workflowPath(file)) } catch { /* concurrent */ }
    return { file, bytes: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null,
             ...workflowUsage(file), summary: comfy.summarize(file) }
  }),
}))

app.get('/api/workflows/:file', async (req, reply) => {
  try {
    const raw = comfy.readWorkflowRaw(req.params.file)
    return { ...raw, ...workflowUsage(req.params.file) }
  } catch (e) {
    reply.code(e.code === 'ENOENT' ? 404 : 400)
    return { error: String(e.message || e) }
  }
})

/* Recipe review: TEST injection (no render) to list what the wiring actually
   drives, reading of the sibling declaration, and check of named nodes and
   files against ComfyUI. */
app.get('/api/workflows/:file/revue', async (req, reply) => {
  let wf
  try { wf = comfy.loadWorkflow(req.params.file) } catch (e) { reply.code(e.code === 'ENOENT' ? 404 : 400); return { error: String(e.message || e) } }
  const court = v => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 46 ? t.slice(0, 44) + '…' : t }
  const out = { noeuds: Object.keys(wf).length, pilotes: [], declares: [], declaration: null, nonInjecte: [], noeudsAbsents: [], valeursAbsentes: [],
    exemple: JSON.stringify({ prompt: ['6', 'text'], negative: ['7', 'text'], seed: ['3', 'seed'], width: ['5', 'width'], height: ['5', 'height'] }, null, 1) }
  try {
    const r = comfy.injectJob(wf, { positive: '‹PROMPT›', negative: '‹NÉGATIF›', seed: 424242, jobId: 'revue', width: 1024, height: 1536 })
    out.nonInjecte = r.skipped ?? []
    for (const [id, n] of Object.entries(r.workflow)) {
      if (!wf[id]) { out.pilotes.push({ noeud: id, classe: n.class_type, entree: '(nœud ajouté)' }); continue }
      for (const [k, v] of Object.entries(n.inputs ?? {}))
        if (JSON.stringify(v) !== JSON.stringify(wf[id].inputs?.[k]))
          out.pilotes.push({ noeud: id, classe: n.class_type, entree: k, avant: court(wf[id].inputs?.[k] ?? '∅'), apres: court(v) })
    }
  } catch (e) { out.erreur = String(e.message || e).slice(0, 300) }
  const d = comfy.readPilotage(req.params.file)
  if (d) {
    out.declaration = d.fichier
    if (d.erreur) out.declares.push({ noeud: '?', classe: '', entree: '', ok: false, pourquoi: d.erreur })
    for (const [cle, cible] of Object.entries(d.slots ?? {})) {
      const [noeud, entree] = Array.isArray(cible) ? cible : []
      const n = wf[noeud]
      const connue = comfy.CLES_PILOTAGE.includes(cle)
      out.declares.push({ cle, noeud: String(noeud), classe: n?.class_type ?? '?', entree: String(entree), ok: !!n && connue && entree in (n.inputs ?? {}),
        pourquoi: !connue ? 'clé inconnue (prompt, negative, seed, width, height, sourceImage)' : !n ? 'nœud absent du graphe' : !(entree in (n.inputs ?? {})) ? 'entrée absente de ce nœud' : undefined })
    }
  }
  try {
    const info = await (await fetch(CONFIG.comfyUrl + '/object_info', { signal: AbortSignal.timeout(30_000) })).json()
    const optionsDe = spec => Array.isArray(spec?.[0]) ? spec[0] : (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) ? spec[1].options : null
    const injectees = new Set(['image', 'video', 'file', 'audio', 'mask', 'upload'])
    const absents = new Set()
    for (const [id, n] of Object.entries(wf)) {
      const def = info[n.class_type]
      if (!def) { absents.add(n.class_type); continue }
      const specs = { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) }
      for (const [k, v] of Object.entries(n.inputs ?? {})) {
        const opts = optionsDe(specs[k])
        if (opts && typeof v === 'string' && !injectees.has(k) && !opts.includes(v))
          out.valeursAbsentes.push({ noeud: id, classe: n.class_type, entree: k, pourquoi: `« ${court(v)} » introuvable sur la machine` })
      }
    }
    out.noeudsAbsents = [...absents]
  } catch (e) { out.valeursAbsentes.push({ noeud: '—', classe: 'ComfyUI', entree: 'injoignable', pourquoi: String(e.message || e).slice(0, 120) }) }
  return out
})

app.put('/api/workflows/:file', async (req, reply) => {
  const { text, baseMtimeMs } = req.body || {}
  if (typeof text !== 'string') { reply.code(400); return { error: 'corps attendu : { text, baseMtimeMs }' } }
  try {
    return comfy.writeWorkflow(req.params.file, text, Number(baseMtimeMs))
  } catch (e) {
    // 409, not 400: the operator wrote nothing wrong, the base changed.
    // The front end can tell "your JSON is broken" from "someone else, or a
    // script, touched the file while you were editing".
    reply.code(e.code === 'CONFLIT' ? 409 : 400)
    return { error: String(e.message || e), conflict: e.code === 'CONFLIT' || undefined,
             currentMtimeMs: e.currentMtimeMs }
  }
})

/* ---------- shaping texts: same mechanism as recipes ----------
   Read by the server on each job, so a write takes effect on the next job.
   Lighter validation: they are free texts, only empty is refused. */

/** What the file drives: used for Workbench badges. */
function promptUsage(file) {
  const m = prompts.PROMPT_META[file]
  return m ? { kind: m.kind, label: m.label, registers: m.registers } : { kind: 'autre', label: 'Texte', registers: [] }
}

app.get('/api/prompts', async () => ({
  dir: CONFIG.promptsDir,
  files: prompts.listPrompts().map(file => {
    let st = null
    try { st = fs.statSync(prompts.promptPath(file)) } catch { /* concurrent */ }
    return { file, bytes: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null, ...promptUsage(file) }
  }),
}))

app.get('/api/prompts/:file', async (req, reply) => {
  try {
    const raw = prompts.readPromptRaw(req.params.file)
    // Appearance guard on SOUL/MOOD layers: they must describe ONLY
    // behaviour/atmosphere. Non-blocking: just a Workbench signal (list of
    // appearance words detected).
    const appearanceWarnings = /^(soul_|mood_)/.test(req.params.file)
      ? composer.lintAppearance(raw.text) : []
    return { ...raw, ...promptUsage(req.params.file), appearanceWarnings }
  } catch (e) {
    reply.code(e.code === 'ENOENT' ? 404 : 400)
    return { error: String(e.message || e) }
  }
})

app.put('/api/prompts/:file', async (req, reply) => {
  const { text, baseMtimeMs } = req.body || {}
  if (typeof text !== 'string') { reply.code(400); return { error: 'corps attendu : { text, baseMtimeMs }' } }
  try {
    return prompts.writePrompt(req.params.file, text, Number(baseMtimeMs))
  } catch (e) {
    reply.code(e.code === 'CONFLIT' ? 409 : 400)
    return { error: String(e.message || e), conflict: e.code === 'CONFLIT' || undefined,
             currentMtimeMs: e.currentMtimeMs }
  }
})

/* ---------- source image upload (edit recipes) ----------
   RAW body rather than multipart or base64: a phone JPEG easily exceeds
   8 MiB, and base64 would add a third. The desired name goes in the query.

   The file lands in ComfyUI's `input/` folder, the only place a LoadImage
   node can read. */
const UPLOAD_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  // Videos: the Motion Control driver. iPhone .mov is QuickTime.
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
}
app.addContentTypeParser(Object.keys(UPLOAD_TYPES), { parseAs: 'buffer' },
  (req, body, done) => done(null, body))

/** Image dimensions, read from its header, no dependency. Used to fit the
 *  latent to the ControlNet reference ASPECT: a control map pushed into a
 *  latent of another ratio is silently cropped. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47)          // PNG
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length > 30 && buf.toString('ascii', 8, 12) === 'WEBP') {   // WebP (VP8X/VP8L/VP8)
    const t = buf.toString('ascii', 12, 16)
    if (t === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
                               height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 }
    if (t === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff,
                               height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {         // JPEG: SOFn marker
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return { width: null, height: null }
}

app.post('/api/upload', async (req, reply) => estProprietaire(req) ? enregistrerEnvoi(req, reply) : depotVisiteur(req, reply))

function enregistrerEnvoi(req, reply) {
  const ext = UPLOAD_TYPES[String(req.headers['content-type']).split(';')[0]]
  if (!ext) { reply.code(415); return { error: 'type non accepté (png, jpeg, webp, mp4, mov, webm)' } }
  const buf = req.body
  if (!Buffer.isBuffer(buf) || !buf.length) { reply.code(400); return { error: 'corps vide' } }
  if (buf.length > 48 * 1024 * 1024) { reply.code(413); return { error: 'fichier > 48 Mio' } }

  // The operator's name only keeps the file recognizable in the folder: it is
  // reduced to a safe charset and prefixed with a timestamp, otherwise two
  // uploads of the same "IMG_0042.jpg" would silently overwrite each other.
  const raw = String(req.query.name || 'source').replace(/\.[^.]*$/, '')
  const stem = raw.normalize('NFD').replace(/[^\w-]+/g, '_').slice(0, 40) || 'source'
  const filename = `crs_${Date.now().toString(36)}_${stem}${ext}`
  fs.mkdirSync(CONFIG.comfyInput, { recursive: true })
  fs.writeFileSync(path.join(CONFIG.comfyInput, filename), buf)
  store.noterInput(filename, 'upload')
  const { width, height } = imageSize(buf)
  // Video (driver): duration and frames as the motion chain will see them,
  // for the estimate before submission.
  const video = ext.startsWith('.m') || ext === '.webm' ? driverMeta(filename) : null
  app.log.info(`upload → ${filename} (${(buf.length / 1e6).toFixed(1)} Mo, ${width}x${height}${video ? `, ${video.seconds.toFixed(1)} s / ${video.frames} images` : ''})`)
  return { filename, bytes: buf.length, width, height, ...(video ? { durationS: video.seconds, frames: video.frames, fps: video.fps } : {}) }
}

/* Filming a gesture with a phone: the owner opens a QR code, the phone uploads the video to
   Motion. The token replaces the owner key for ONE video upload, 10 min; only the owner can
   create one. The file stays an "upload": a visitor cannot use it. */
const jetonsTelephone = new Map()
const JETON_MS = 10 * 60 * 1000
const jetonValide = j => { const e = jetonsTelephone.get(String(j)); return e && e.fin > Date.now() ? e : null }

app.post('/api/telephone', async req => {
  for (const [j, e] of jetonsTelephone) if (e.fin <= Date.now()) jetonsTelephone.delete(j)
  const jeton = crypto.randomBytes(24).toString('base64url')
  jetonsTelephone.set(jeton, { fin: Date.now() + JETON_MS, envoi: null })
  const hote = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim()
  const url = `${proto}://${hote}/telephone/${jeton}`
  return { jeton, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1 }), local: /^(localhost|127\.|\[::1\])/.test(hote) }
})
app.get('/api/telephone/:jeton/etat', async (req, reply) => {
  const e = jetonsTelephone.get(req.params.jeton)
  if (!e) { reply.code(404); return { error: 'lien expiré' } }
  return { envoi: e.envoi, expire: e.fin <= Date.now() }
})
app.post('/api/telephone/:jeton', async (req, reply) => {
  const e = jetonValide(req.params.jeton)
  if (!e || e.envoi) { reply.code(403); return { error: 'lien expiré ou déjà utilisé' } }
  if (!String(req.headers['content-type']).startsWith('video/')) { reply.code(415); return { error: 'vidéo seulement' } }
  const r = enregistrerEnvoi(req, reply)
  if (r?.filename) e.envoi = r
  return r
})
app.get('/telephone/:jeton', async (req, reply) => {
  reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
  if (!jetonValide(req.params.jeton)) { reply.code(403); return '<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:24px">Link expired. Open a new QR code in the studio.' }
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Send a move</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#08090b;color:#f2f1ed;font:17px system-ui;padding:24px;box-sizing:border-box;text-align:center}label{background:linear-gradient(120deg,#ff655b,#f24d8a);color:#fff;font-weight:700;padding:18px 30px;border-radius:14px}input{display:none}p{color:#a9abb2;margin:0}</style>
<h2 style=margin:0>CreatorOS Studio</h2><label>Film a move<input id=f type=file accept=video/* capture=environment></label><p id=m>3 to 30 s, 48 MB at most.</p>
<script>const m=document.getElementById('m');document.getElementById('f').onchange=async e=>{const v=e.target.files[0];if(!v)return;if(v.size>48*1024*1024){m.textContent='Video over 48 MB: film a shorter one.';return}
m.textContent='Sending…';try{const r=await fetch(location.pathname.replace('/telephone/','/api/telephone/'),{method:'POST',headers:{'Content-Type':v.type||'video/mp4'},body:v});const d=await r.json();m.textContent=r.ok?'Sent. It is in the studio.':d.error||'Failed.'}catch{m.textContent='Connection lost, try again.'}}</script></html>`
})

/* ---------- persona ----------
   GET /api/persona: the active persona (see server/persona.js): name,
   description, trigger word, LoRA. PUT saves it to `persona.json`
   (Character view editor); a field set by environment variable takes
   priority and is flagged in `figes`.

   Profile photo: a single file, `media/.persona/avatar.<ext>`, replaced on
   each upload. Served by GET with the mtime as front-end cache token (?v=).
   Nothing in the database: it is a presentation file, not render data. */
const corpsPersonaRefuse = (c) => {
  if (!c || typeof c !== 'object') return 'corps JSON attendu'
  for (const champ of ['name', 'description', 'preamble', 'trigger']) {
    if (t0Hit(String(c[champ] ?? ''))) return `terme interdit dans « ${champ} »`
  }
  for (const x of c.garderobe?.perso ?? [])
    if (t0Hit(`${x?.label ?? ''} ${x?.prompt ?? ''}`)) return 'terme interdit dans la garde-robe'
  return null
}
/* Creator page: open read; filtered write (T0, https links only). */
app.get('/api/createur', async () => lireCreateur())
app.put('/api/createur', async (req, reply) => {
  const c = req.body ?? {}
  const tout = [c.nom, c.titre, c.titreEn, c.bio, c.bioEn, ...(c.liens ?? []).map(l => l?.label), ...(c.infos ?? []).flatMap(i => [i?.k, i?.v, i?.kEn, i?.vEn])].join(' ')
  if (t0Hit(tout)) { reply.code(400); return { error: 'terme interdit' } }
  return ecrireCreateur(c)
})
app.get('/api/persona', async req => {
  const id = String(req.query?.id ?? '')
  return personaPublique(id && (id === SANS_PERSONNAGE || personas().list.some(p => p.id === id)) ? id : undefined)
})
app.put('/api/persona', async (req, reply) => {
  const refus = corpsPersonaRefuse(req.body)
  if (refus) { reply.code(400); return { error: refus } }
  try { enregistrerPersona(req.body) } catch (e) { if (e.statusCode !== 409) throw e; reply.code(409); return { error: e.message } }
  return personaPublique()
})

/* Multiple characters: list, create (empty or copy), activate, edit and
   delete. A render keeps the character active at submission (job.personaId);
   switching only affects later renders. */
app.get('/api/personas', async () => {
  const { active, list } = personas()
  return { active, personas: list.map(p => personaPublique(p.id)) }
})
app.post('/api/personas', async (req, reply) => {
  const c = req.body ?? {}
  if (t0Hit(String(c.name ?? ''))) { reply.code(400); return { error: 'terme interdit dans « name »' } }
  const p = creerPersona({ name: c.name, depuis: typeof c.depuis === 'string' ? c.depuis : undefined })
  return personaPublique(p.id)
})
app.put('/api/personas/:id', async (req, reply) => {
  const refus = corpsPersonaRefuse(req.body)
  if (refus) { reply.code(400); return { error: refus } }
  let ok
  try { ok = enregistrerPersona(req.body, req.params.id) } catch (e) { if (e.statusCode !== 409) throw e; reply.code(409); return { error: e.message } }
  if (!ok) { reply.code(404); return { error: 'personnage inconnu' } }
  return personaPublique(req.params.id)
})
/* Voice attached to a character (voix field): a studio voice, a cloned library voice,
   or null to detach. Owner only (ROUTES_PROPRIETAIRE). */
app.put('/api/personas/:id/voix', async (req, reply) => {
  const brut = req.body?.voix
  const voix = brut === null || brut === '' ? null : voixAcceptee(brut, true)
  if (brut !== null && brut !== '' && !voix) { reply.code(400); return { error: 'voix inconnue' } }
  if (!personas().list.some(p => p.id === req.params.id)) { reply.code(404); return { error: 'personnage inconnu' } }
  enregistrerPersona({ voix }, req.params.id)
  return personaPublique(req.params.id)
})
app.post('/api/personas/:id/activer', async (req, reply) => {
  if (!activerPersona(req.params.id)) { reply.code(404); return { error: 'personnage inconnu' } }
  return personaPublique()
})
app.delete('/api/personas/:id', async (req, reply) => {
  const r = supprimerPersona(req.params.id)
  if (!r.ok) { reply.code(r.error === 'personnage inconnu' ? 404 : 409); return { error: r.error } }
  return { ok: true, active: personas().active }
})

/* Upload of an identity LoRA (.safetensors) into ComfyUI's LoRA folder. Raw
   streamed body (application/octet-stream): a LoRA weighs 50 MB to over 1 GB
   and does not fit in memory. The stream lands in a temporary file next to
   the destination; installationLora.js then gives it an explicit mode (the
   process umask would otherwise decide whether ComfyUI can read it), checks
   every tensor range, and renames it atomically. A bad file is deleted. No
   silent overwrite: ?remplacer=1 replaces an existing file. */
const LORA_MAX = 2 * 1024 ** 3
app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload))
app.post('/api/persona/lora', async (req, reply) => {
  const brut = String(req.query.nom || '').replace(/\.safetensors$/i, '')
  const stem = brut.normalize('NFD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
  if (!stem) { reply.code(400); return { error: 'nom de fichier manquant' } }
  const nom = `${stem}.safetensors`, cible = path.join(CONFIG.lorasDir, nom)
  const remplacer = req.query.remplacer === '1'
  if (fs.existsSync(cible) && !remplacer) { reply.code(409); return { error: `« ${nom} » existe déjà`, nom } }
  fs.mkdirSync(CONFIG.lorasDir, { recursive: true })
  const tmp = cheminTemporaire(cible)
  let octets = 0, inst
  try {
    await new Promise((ok, ko) => {
      const out = fs.createWriteStream(tmp)
      req.body.on('data', d => { octets += d.length; if (octets > LORA_MAX) req.body.destroy(new Error('fichier > 2 Gio')) })
      req.body.on('error', ko); out.on('error', ko); out.on('finish', ok)
      req.body.pipe(out)
    })
    inst = finaliserLora(tmp, nom, { remplacer })
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    reply.code(e.statusCode === 409 ? 409 : 400); return { error: String(e.message || e), nom }
  }
  app.log.info(`LoRA déposée → ${nom} (${(octets / 1e6).toFixed(0)} Mo, ${inst.tenseurs} tenseurs, mode ${inst.mode})`)
  return { nom, octets, mode: inst.mode, lora: comfy.listLoras().loras.find(l => l.name === nom) ?? null }
})
/* Characters' LoRAs as ComfyUI sees them (mode, owner, readable, valid), and the
   repair the diagnostic recommends: mode and group normalized on the characters'
   files only (never a third-party LoRA), optionally restricted to `noms`. */
app.get('/api/loras/etat', async () => ({ dossier: CONFIG.lorasDir, loras: etatLorasPersonas(personas().list) }))
app.post('/api/loras/reparer', async req => {
  const noms = Array.isArray(req.body?.noms) ? req.body.noms.filter(n => typeof n === 'string') : null
  const r = reparerLorasPersonas(personas().list, { noms })
  for (const x of r.repares) app.log.info(`LoRA réparée → ${x.nom} (mode ${x.mode})`)
  return { ...r, loras: etatLorasPersonas(personas().list) }
})
/* One photo per character: media/.persona/<id>/avatar.<ext>. Without `?id=`,
   the active character's. */
const AVATAR_DIR = path.join(CONFIG.mediaDir, '.persona')
const AVATAR_EXTS = ['.png', '.jpg', '.webp']
const idAvatar = id => String(id ?? personas().active ?? 'default').replace(/[^a-z0-9_]/g, '') || 'default'
const avatarDir = id => path.join(AVATAR_DIR, idAvatar(id))
const avatarFile = id => AVATAR_EXTS.map(e => path.join(avatarDir(id), `avatar${e}`)).find(f => fs.existsSync(f)) || null
/* Legacy layout (a single photo at the root): attached to the active character. */
{
  const ancien = AVATAR_EXTS.map(e => path.join(AVATAR_DIR, `avatar${e}`)).find(f => fs.existsSync(f))
  if (ancien && personas().active && !avatarFile()) {
    fs.mkdirSync(avatarDir(), { recursive: true })
    fs.renameSync(ancien, path.join(avatarDir(), path.basename(ancien)))
  }
}
function avatarMeta(id) {
  const f = avatarFile(id)
  return f ? { url: `/api/persona/avatar?id=${idAvatar(id)}&v=${Math.round(fs.statSync(f).mtimeMs)}` } : { url: null }
}
app.get('/api/persona/avatar/meta', async (req) => avatarMeta(req.query?.id))
app.get('/api/persona/avatar', async (req, reply) => {
  const f = avatarFile(req.query?.id)
  if (!f) { reply.code(404); return { error: 'aucune photo de profil' } }
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(f)]
  reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(type)
  return fs.createReadStream(f)
})
app.put('/api/persona/avatar', async (req, reply) => {
  const ext = UPLOAD_TYPES[String(req.headers['content-type']).split(';')[0]]
  if (!ext || !AVATAR_EXTS.includes(ext === '.jpeg' ? '.jpg' : ext)) { reply.code(415); return { error: 'image attendue (png, jpeg, webp)' } }
  const buf = req.body
  if (!Buffer.isBuffer(buf) || !buf.length) { reply.code(400); return { error: 'corps vide' } }
  if (buf.length > 8 * 1024 * 1024) { reply.code(413); return { error: 'image > 8 Mio' } }
  const id = req.query?.id
  const dir = avatarDir(id)
  fs.mkdirSync(dir, { recursive: true })
  for (const e of AVATAR_EXTS) fs.rmSync(path.join(dir, `avatar${e}`), { force: true })
  fs.writeFileSync(path.join(dir, `avatar${ext === '.jpeg' ? '.jpg' : ext}`), buf)
  app.log.info(`photo de profil ${idAvatar(id)} → ${(buf.length / 1e6).toFixed(1)} Mo`)
  return avatarMeta(id)
})

/* Profile photo picked among the character's renders: cropped square (top of
   the image, where the face is on a portrait) and scaled to 512 px. */
app.put('/api/persona/avatar/depuis-asset', async (req, reply) => {
  const row = store.getAsset(String(req.body?.assetId ?? ''))
  if (!row || row.media_type !== 'photo' || !row.filename) { reply.code(400); return { error: 'photo de la bibliothèque attendue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(row.filename))
  if (!fs.existsSync(src)) { reply.code(410); return { error: 'fichier absent du disque' } }
  const id = req.query?.id
  const dir = avatarDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, 'avatar.tmp.jpg')
  // square taken from the top of a portrait (the face), centered on a landscape
  const w = Number(row.width) || 0, h = Number(row.height) || 0
  const cote = Math.min(w, h)
  const crop = cote ? `crop=${cote}:${cote}:${Math.round((w - cote) / 2)}:${h > w ? Math.round(h * 0.06) : 0}` : 'crop=min(iw\\,ih):min(iw\\,ih)'
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `${crop},scale=512:512`,
      '-q:v', '3', tmp])
  } catch (e) { fs.rmSync(tmp, { force: true }); reply.code(422); return { error: `recadrage impossible : ${e.message}` } }
  for (const e of AVATAR_EXTS) fs.rmSync(path.join(dir, `avatar${e}`), { force: true })
  fs.renameSync(tmp, path.join(dir, 'avatar.jpg'))
  return avatarMeta(id)
})

/** Visitor's Comfy Cloud key (X-Comfy-Key header), if present. Never logged
 *  or stored: it travels with the job, in memory. */
function cleComfy(req) {
  const v = String(req.headers['x-comfy-key'] ?? '').trim()
  return v && v.length <= 400 && /^[\x21-\x7e]+$/.test(v) ? v : null
}

/* Character LoRAs on Comfy Cloud (see cloud-loras.js). Always POST: the only
   method the front end attaches the visitor key to. */
function exigerCle(req) {
  const cle = cleComfy(req)
  if (!cle) { const e = new Error('clé Comfy Cloud absente : l’enregistrer dans Paramètres → Comfy Cloud'); e.statusCode = 401; throw e }
  return cle
}
app.post('/api/cloud/loras/etat', async req => etatCloud(exigerCle(req)))
app.post('/api/cloud/loras/importer', async req =>
  importerCloud(exigerCle(req), { persona: typeof req.body?.persona === 'string' ? req.body.persona : undefined }))
app.post('/api/cloud/taches/:id', async req => tacheCloud(exigerCle(req), req.params.id))

/** Job submission. Replies immediately (202): generation is asynchronous,
 *  the front end follows via /api/jobs/:id. */
/* ComfyUI's input folder may be shared with another install: a job submitted
   through the API may only name files this studio put there itself
   (inputs_studio registry), otherwise a visitor could animate or describe
   someone else's image. */
/* Visitor (no key): only what the studio generated itself and photos a visitor
   uploaded after checks (no person, see depots.js); never an owner upload,
   never a photo of a real person. */
function inputEtranger(b, proprietaire) {
  const noms = [b.sourceImage, b.endImage, b.contexteVideo, ...(Array.isArray(b.keyframes) ? b.keyframes.map(k => k?.image) : []), b.motionDriver, b.motionRef, b.concatFrom === 'input' ? b.concatWith : null, ...(Array.isArray(b.references) ? b.references : [])]
  const admis = n => proprietaire ? store.estInputStudio(n) : store.estInputVisiteur(n)
  return noms.find(n => typeof n === 'string' && n.trim() && !admis(path.basename(n.trim()))) ?? null
}
app.post('/api/jobs', async (req, reply) => {
  const etranger = inputEtranger(req.body || {}, estProprietaire(req))
  if (etranger) { reply.code(400); return { error: `« ${path.basename(etranger)} » absent du dossier input/` } }
  if (req.body && !estProprietaire(req)) delete req.body.profilVram   // forced profile: owner only
  if (req.body && !estProprietaire(req)) for (const k of ['motionSansTurbo', 'motionTurbo', 'motionPas', 'motionCfg', 'motionVisionRef', 'motionPoseFin', 'swapAnimation', 'motionDistill', 'swapLong', 'mixWanAnimate', 'motionPoseDriver', 'motionFpsNatif', 'swapBlocs']) delete req.body[k]   // bench settings: owner only
  // a video starting from a library photo plays that photo's character, whatever the current choice
  const depart = req.body?.mode === 'video' && req.body?.selections?.task !== 't2v' && req.body?.selections?.startAssetId ? store.getAsset(String(req.body.selections.startAssetId)) : null
  if (depart?.persona_id) req.body.personaId = depart.persona_id
  if (personnageInterdit(req, req.body?.personaId)) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  try {
    const r = await deposerAvecCle(cleComfy(req), () => enqueueParPlans(req.body || {}))   // an edited motion video is submitted as one job per shot
    /* 200 (not 202) when the idempotency key was already seen: the client knows
       it is reading an earlier submission rather than triggering a new one. The
       body is identical in both cases so a retry needs no special handling. */
    reply.code(r.duplicate ? 200 : 202)
    return { ...r, status: 'queued' }
  } catch (e) {
    reply.code(400)
    return { error: String(e.message || e) }
  }
})

/** Live preview of the running render (last image pushed by ComfyUI). */
app.get('/api/jobs/:id/apercu', async (req, reply) => {
  const job = store.getJob(req.params.id)
  const ap = job?.comfy_prompt_id ? comfy.getApercu(job.comfy_prompt_id) : null
  if (!ap) { reply.code(404); return { error: 'pas d’aperçu' } }
  reply.header('Cache-Control', 'no-store')
  reply.type(ap.mime)
  return ap.buf
})

/* Video thumbnail, see poster.js. Long cache: an asset's file never changes
   (a new render gets a new name). */
app.get('/api/poster/:file', async (req, reply) => {
  const p = await ensurePoster(req.params.file)
  if (!p) { reply.code(404); return { error: 'pas de vignette' } }
  reply.header('Cache-Control', 'public, max-age=31536000, immutable')
  reply.type('image/jpeg')
  return fs.createReadStream(p)
})

app.get('/api/jobs', async req => ({
  // ?op=musique: only jobs of that operation (sound studio history); without op, the full list
  jobs: (req.query.op ? store.listJobsOp(String(req.query.op), Math.min(500, Number(req.query.limit) || 50)) : store.listJobs(Number(req.query.limit) || 50)).map(jobOut),
}))

/** Cancel: queued -> removed; running -> interrupted in ComfyUI. */
/** Moves a QUEUED job to the head of the queue (the CreatorOS queue, not
 *  ComfyUI's, which sees one job at a time). 409 if not queued. */
app.post('/api/jobs/:id/promote', async (req, reply) => {
  const r = promoteJob(req.params.id)
  if (!r) { reply.code(409); return { error: 'ce job n’est pas en attente' } }
  return r
})

/** New queue order (drag & drop in the Jobs view). */
app.post('/api/jobs/reorder', async req => reorderQueue((req.body?.ids ?? []).map(String)))

/* Briefs already sent (deduplicated, most recent first) and starred briefs. */
app.get('/api/briefs', async () => ({ briefs: store.listBriefs() }))
app.post('/api/briefs/star', async (req, reply) => {
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.trim() : ''
  if (!texte) { reply.code(400); return { error: 'brief vide' } }
  store.starBrief(texte, req.body?.mode, req.body?.on !== false)
  return { ok: true }
})

/** Reruns a FINISHED job (failed or not): its original payload is re-queued
 *  as is, same seed. `draft` reruns it as a draft (video) or 480p preview
 *  (motion) for a quick check; `nouvelleGraine` reruns it with a random seed. */
app.post('/api/jobs/:id/retry', async (req, reply) => {
  const row = store.getJob(req.params.id)
  if (!row) { reply.code(404); return { error: 'job inconnu' } }
  if (!['done', 'blocked'].includes(row.status)) { reply.code(409); return { error: `job « ${row.status} » : encore en cours` } }
  let p
  try { p = JSON.parse(row.payload || 'null') } catch { p = null }
  if (!p) { reply.code(409); return { error: 'réglages d’origine introuvables : ce job ne peut pas être relancé' } }
  if (p.op === 'planlong') { reply.code(409); return { error: 'un plan long se relance depuis sa page : Plan long' } }
  for (const f of ['id', 'createdAt', 'status', 'estimatedMs', 'requestId', 'batchIds', 'error']) delete p[f]
  /* "One more": same settings, new seed; a variant, not a copy. */
  if (req.body?.nouvelleGraine) p.seed = { mode: 'random' }
  else if (Number.isFinite(row.seed)) p.seed = { mode: 'lock', value: row.seed }
  if (req.body?.draft) { if (p.videoEngine === 'motion') p.motionPreview = true; else p.videoDraft = true }
  try {
    const r = deposerAvecCle(cleComfy(req), () => (OPS_RELANCABLES.has(p.op) ? relancerSpecial({ ...p, id: row.id }) : enqueue(p)))
    reply.code(202)
    return { ...r, status: 'queued', from: row.id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

app.delete('/api/jobs/:id', async (req, reply) => {
  const r = await cancelJob(req.params.id)
  if (r) return r
  /* Neither queued nor running: if the job is TERMINAL (done / blocked), deletion
     is permanent: the job row and, by cascade, its assets and provenance. Disk
     files (media + posters) go too. Jobs view cleanup; the UI confirms in two
     steps and shows the number of renders removed. */
  const row = store.getJob(req.params.id)
  if (!row) { reply.code(404); return { error: 'job inconnu' } }
  if (!estProprietaire(req)) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  if (!['done', 'blocked'].includes(row.status)) { reply.code(409); return { error: `job « ${row.status} » : ni annulable ni supprimable` } }
  const files = store.jobAssetFiles(req.params.id)
  for (const f of files) {
    for (const p of [path.join(CONFIG.mediaDir, path.basename(f)), path.join(CONFIG.mediaDir, '.posters', `${path.basename(f)}.jpg`)])
      try { fs.unlinkSync(p) } catch (e) { if (e.code !== 'ENOENT') app.log.warn(`suppression ${p} : ${e.message}`) }
  }
  const d = store.deleteJobDeep(req.params.id)
  return { id: req.params.id, deleted: d.removed, assetsRemoved: d.assetsRemoved }
})

app.get('/api/jobs/:id', async (req, reply) => {
  const job = store.getJob(req.params.id)
  if (!job) { reply.code(404); return { error: 'job inconnu' } }
  const out = jobOut(job)
  // Rank and estimated wait of a queued job (shown on its card)
  if (job.status === 'queued') out.file = placeDansFile(job.id) ?? undefined
  // Progress of the running render, as ComfyUI's UI shows it.
  // Approximate by construction (per node), and presented as such.
  if (job.status === 'rendering' && job.comfy_prompt_id) {
    out.progress = comfy.getProgress(job.comfy_prompt_id)
    out.phase = comfy.getPhase(job.comfy_prompt_id) ?? undefined
    const ap = comfy.getApercu(job.comfy_prompt_id)
    if (ap) out.apercu = ap.at       // timestamp: the UI reloads the image only when it changes
  }
  return { job: out, assets: store.assetsOfJob(job.id).map(assetOut) }
})

/* ---------- read-only lists for the UI ----------
   /api/uploads: image files in ComfyUI's input folder (upload history,
   "start frame" picker). /api/wildcards: *.txt files and their lines
   (Elements popup). No writes: the 🎲 draw is done by the server at
   compose/job time. */
app.get('/api/uploads', async req => {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const dir = CONFIG.comfyInput
  let files = []
  try {
    files = fsx.readdirSync(dir)
      .filter(f => (req.query.type === 'video' ? /\.(mp4|mov|webm)$/i : /\.(png|jpe?g|webp)$/i).test(f) && !f.startsWith('.') && store.estInputStudio(f))   // shared folder: only our uploads
      .map(f => { const st = fsx.statSync(pathx.join(dir, f)); return { name: f, mtime: st.mtimeMs, bytes: st.size } })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Number(req.query.limit) || 120)
  } catch { /* missing folder: empty list */ }
  return { uploads: files }
})

app.get('/api/uploads/:name', async (req, reply) => {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const name = String(req.params.name || '')
  // bare name only: no escape outside the input folder
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    reply.code(400); return { error: 'nom invalide' }
  }
  const file = pathx.join(CONFIG.comfyInput, name)
  if (!store.estInputStudio(name) || !fsx.existsSync(file)) { reply.code(404); return { error: 'introuvable' } }
  // an owner upload stays private; a visitor only reads studio copies, sketches and a restoration's source
  if (!estProprietaire(req) && !['genere', 'croquis', 'depot-visiteur'].includes(store.origineInput(name)) && !store.estOrigineRestauree(name)) { reply.code(403); return { error: 'réservé au propriétaire' } }
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase()
  reply.type({ png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] ?? 'image/jpeg')
  reply.header('Cache-Control', 'public, max-age=86400')
  return fsx.createReadStream(file)
})

/* ---------- carousel rewrite ----------
   Keeps the EXACT prompt except the elements listed in `vary`, which the LLM
   rewrites freely while keeping coherence. 1 variant per call; the front end
   loops (natural progress + jobs submitted as they come).
   CPU (num_gpu 0): never competes with ComfyUI. */
/* Attaches an EXISTING job to a batch (carousel: the original is not
   regenerated, its render joins the batch mosaic thumbnail). */
app.post('/api/jobs/:id/batch-id', async (req, reply) => {
  const { batchId } = req.body || {}
  if (!batchId || typeof batchId !== 'string') { reply.code(400); return { error: 'batchId requis' } }
  const r = store.setJobBatchId(req.params.id, batchId)
  if (!r) { reply.code(404); return { error: 'job introuvable' } }
  return { ok: true }
})

/* Scene decomposition into FIVE dimensions, shared by /api/decompose (the
   operator sees what the VLM found BEFORE setting locks) and /api/rewrite
   (which accepts the precomputed result to avoid paying for the VLM again). */
/* Photo diffusion engine: same source as composer.js and jobs.js, read here
   for the mechanized render instructions in the carousel. */
const MOTEUR_PHOTO = CONFIG.photoEngine

const DIM_TRI_SYS = 'You sort an image prompt into five fields. Output STRICT JSON '
  + '{"outfit":"","pose":"","location":"","props":"","style":""} and nothing else.\n'
  + 'outfit = every garment and accessory she wears.\n'
  + 'pose = her body position and what she is doing, the GESTURE only, with the furniture and the '
  + 'place stripped out of it ("leaning back against a waist-high surface", not "against the counter").\n'
  + 'location = where she is, the background.\n'
  + 'props = objects, furniture or vehicles around her she could touch or use.\n'
  + 'style = the photographic treatment: light, mood, colour, grain, lens feel.\n'
  + 'Copy the wording of the prompt; never invent what it does not say. Empty string if nothing to say.'

async function dimensionsDe({ anchorUri, texte }) {
  const pathx = await import('node:path')
  if (typeof anchorUri === 'string' && anchorUri.startsWith('/media/')) {
    const d = await decomposeScene(pathx.join(CONFIG.mediaDir, pathx.basename(anchorUri)))
    if (d) return d
  }
  /* No image (or silent VLM): sort the TEXT. The carousel must work from a
     prompt alone. */
  try {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 420000)),
      body: JSON.stringify({ model: CONFIG.composerModels.sfw, system: DIM_TRI_SYS, prompt: String(texte || ''),
        stream: false, keep_alive: '10m', think: false,
        options: { num_gpu: 0, num_ctx: 8192, num_predict: 400, temperature: 0 } }),
    })
    if (!res.ok) return null
    const m = String((await res.json()).response || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0])
    const net = x => (typeof x === 'string' ? x.trim() : '')
    return { outfit: net(o.outfit), pose: net(o.pose), location: net(o.location), props: net(o.props),
      style: net(o.style) }
  } catch { return null }
}

/* The operator opens the carousel: show what the VLM found in each
   dimension, so they know what they are locking. */
app.post('/api/decompose', async (req, reply) => {
  const { anchorUri, prompt } = req.body || {}
  const dims = await dimensionsDe({ anchorUri, texte: prompt })
  if (!dims) { reply.code(502); return { error: 'décomposition impossible' } }
  return { dims }
})

app.post('/api/rewrite', async (req, reply) => {
  /* `writerModel`: MEASUREMENT override only (comparing two writers on the same
     corpus). Not in the front end; normal routing stays `composer.modelFor()`. */
  const { prompt, vary, n, anchorUri, anchorOutfit, shoot, writerModel } = req.body || {}
  if (!prompt || !Array.isArray(vary) || !vary.length) {
    reply.code(400); return { error: 'prompt et vary[] requis' }
  }
  const count = Math.min(Math.max(Number(n) || 8, 1), 12)
  const model = composer.modelFor()

  /* ---------- 1) visual context (VLM): the CONCEPT comes from the image + the
     prompt. The LLM varies freely WITHIN the concept. The description is an
     INPUT to the rewriter, never a diffusion prompt: downstream code guards
     apply unchanged. */
  const pathx = await import('node:path')
  const has = needle => vary.some(v => v.includes(needle))
  let sceneDesc = null
  /* In shooting mode, `decomposeScene` does this job better (five dimensions
     instead of a global description): no need to pay for the VLM twice. */
  if (!shoot && typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
    sceneDesc = await describeScene(pathx.join(CONFIG.mediaDir, pathx.basename(anchorUri)))

  /* Anchoring a KEPT dimension that is under-specified in the prompt: "outfit
     kept" + a prompt without colors -> each seed reinvents it. The VLM describes
     the outfit of the source IMAGE and that description is stitched into all
     variants. */
  let outfitAnchor = null
  if (!shoot && anchorOutfit && typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
    outfitAnchor = await describeOutfit(pathx.join(CONFIG.mediaDir, pathx.basename(anchorUri)))

  /* ---------- 1bis) SHOOTING MODE ----------
     The legacy mode can only REMOVE segments and rewrite a clause in place: it
     produces posture variants, never shots. Here the writer WRITES shots: a fixed
     shared trunk (locked outfit, place, look) + a shot block that alone changes
     (action, pose, framing, angle). Calibration lives on disk (shoot_sfw.txt):
     intensity is taught by example, not by an adjective, and the operator
     extends the corpus without a rebuild. */
  if (shoot) {
    /* `keep_alive`: dimensions mode makes TWO calls (sorter then writer), and on
       CPU each model reload costs over a minute, so models stay warm ten minutes. */
    const askShoot = async (mdl, system, user, temperature, predire = 2600) => {
      const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 420000)),
        body: JSON.stringify({ model: mdl, system, prompt: user, stream: false, keep_alive: '10m', think: false,
          options: { num_gpu: 0, num_ctx: 8192, num_predict: predire, temperature } }),
      })
      if (!res.ok) throw new Error(`Ollama ${res.status}`)
      return String((await res.json()).response || '').trim()
    }
    try {
      const corpus = prompts.readPrompt('shoot_sfw.txt')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      if (!corpus.length) throw new Error('corpus de plans vide : shoot_sfw.txt')

      /* Stale anchor tail from a previous carousel, cumulative across generations:
         cut before anything else. */
      const promptNet = prompt.replace(/[,.\s]*\bwearing\s+[^.]*\.?\s*$/i, '.')
      /* ================= DIMENSIONS =================
         The scene is decomposed into five independent dimensions: outfit, pose,
         set, accessories, photo style. A CHECKED dimension is the shoot's
         CONSTANT: it goes into the trunk and does not move. Unchecked ones are
         the writer's material, free to keep or change. */
      const DIMS = ['outfit', 'pose', 'location', 'props', 'style']
      const LIBELLE = { outfit: 'OUTFIT', pose: 'POSE', location: 'LOCATION', props: 'PROPS AROUND HER', style: 'PHOTOGRAPHIC STYLE' }

      /* Dimensions already computed by /api/decompose (the operator saw them before
         setting locks): the VLM is not paid for again. */
      const dimsRecues = req.body && typeof req.body.dims === 'object' && req.body.dims
        && DIMS.some(k => req.body.dims[k])
      const tDims = Date.now()
      const dims = dimsRecues ? req.body.dims : await dimensionsDe({ anchorUri, texte: promptNet })
      const msDims = Date.now() - tDims
      if (!dims) throw new Error('décomposition impossible : ni image d\'ancrage exploitable, ni tri du texte')

      /* Contract: `keep` is what stays CONSTANT. Accepted as is, otherwise derived
         from `vary` (legacy front-end contract, where the named dimension varies). */
      const brutKeep = (req.body && typeof req.body.keep === 'object' && req.body.keep) || null
      const varieDit = motif => vary.some(v => String(v).toLowerCase().includes(motif))
      const keep = {
        outfit: brutKeep ? !!brutKeep.outfit : !varieDit('outfit'),
        pose: brutKeep ? !!brutKeep.pose : !varieDit('pose'),
        location: brutKeep ? !!brutKeep.location : !varieDit('setting'),
        props: brutKeep ? !!brutKeep.props : !varieDit('prop'),
        style: brutKeep ? !!brutKeep.style : !varieDit('style'),
      }
      const dansTronc = DIMS.filter(k => keep[k] && dims[k])
      const libres = DIMS.filter(k => !keep[k])
      /* Set / accessories DEDUPLICATION. The decomposer often puts the same objects
         in both `location` and `props`. That redundancy weighs a third of the
         prompt, and a saturated prompt LOSES THE FRAMING. Noun phrases ALREADY in
         `location` are removed from `props`. What is locked stays written, once. */
      const sansRedondance = (props, location) => {
        if (!props || !location) return props
        const lieu = String(location).toLowerCase()
        return String(props).split(/\s*,\s*/).filter(Boolean).filter(seg => {
          /* a segment is a duplicate if its HEAD NOUN (last noun of the phrase,
             "a side table with a lamp" -> "lamp") already appears in the set. */
          const mots = seg.toLowerCase().match(/[a-z]+/g) || []
          const tete = mots.filter(m => !['a', 'an', 'the', 'with', 'and', 'in', 'on', 'of', 'partially', 'visible', 'large', 'small'].includes(m)).pop()
          return !(tete && lieu.includes(tete))
        }).join(', ')
      }
      let propsDedupe = null
      if (dims.props && dims.location) {
        const avant = String(dims.props)
        const apres = sansRedondance(avant, dims.location)
        if (apres !== avant) { dims.props = apres; propsDedupe = { avant, apres } }
      }
      const tronc = dansTronc
        .map(k => String(dims[k] ?? '').replace(/[,.\s]+$/, ''))
        .filter(Boolean)
        .join('. ').trim()

      /* ================= GRID DRAWN IN CODE =================
         A text instruction does not hold on a local CPU model: it respects
         framing but repeats the posture. So the model is not asked to DISTRIBUTE:
         the server draws framing, angle and action family, all distinct, and the
         model writes one cell. */
      const melange = a => [...a].sort(() => Math.random() - 0.5)
      const CADRAGES = melange([
        'wide shot, she is small in the frame, the whole setting around her',
        'full length', 'waist-up', 'close medium shot',
        'tight portrait, her face fills the frame',
        'full length, seen at a distance', 'head and shoulders', 'medium shot',
      ])
      /* The "in a mirror" angle enters the draw ONLY if the locked set contains a
         mirror; otherwise the model would write a mirror on a gravel path. */
      const decorTexte = [dims.location, dims.props].filter(Boolean).join(' ').toLowerCase()
      const ANGLES = melange([
        'eye level, straight on', 'from behind, three-quarter rear view',
        'from floor level, looking up', 'from high above, looking straight down',
        'from just below her chin, looking up',
        ...(/\bmirror\b|\bmirrored\b/.test(decorTexte)
          ? ['in a mirror, shot over her shoulder into the glass'] : []),
        'three-quarter view from her side', 'from across the space',
      ])
      const FAM = [
        'she is handling an object that belongs to this place',
        'she is touching or resting against something in the setting',
        'she is moving through the space: walking, arriving, stepping, turning',
        'she is attending to her own appearance — her hair, a sleeve, a hem, a strap',
        'she is absorbed in something outside the frame',
        'she is caught mid-gesture: reaching, adjusting, gathering, stretching',
        'she is settled somewhere — seated, perched, or leaning, at ease',
        'she is at rest, doing nothing but holding the lens',
      ]
      /* CHECKED POSE = the pose IS the constant, arms included. The ACTION is kept
         from moving the hands elsewhere: the frozen pose says where the arms are,
         an action family would send them elsewhere, and the image model reconciles
         by drawing an extra one. */
      const FAM_POSE_FIGEE = [
        'she holds the pose exactly as described, her expression softening',
        'she holds the pose, her gaze moving to the lens',
        'she holds the pose, her weight settling, the fabric falling into place',
        'she holds the pose, caught a breath later, her hair moved',
        'she holds the pose, her chin lifting slightly',
        'she holds the pose, her eyes closing for a moment',
        'she holds the pose, turned a few degrees on the spot',
        'she holds the pose, entirely still',
      ]
      const tires = [...corpus].sort(() => Math.random() - 0.5).slice(0, 10)
      /* OPERATOR POSITIONS: when the pose is free, the assigned action can come from
         their posture wildcards (poses_sfw.txt in the texts folder) rather than the
         eight hand-written families. A wildcard line is RICH: copying it is a good
         result. */
      let positions = null
      if (!keep.pose) {
        try {
          const l = prompts.readPrompt('poses_sfw.txt').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'))
          if (l.length >= count) positions = l
        } catch { /* family fallback */ }
      }
      const FAMILLES = melange(keep.pose ? FAM_POSE_FIGEE : positions || FAM)
      /* When the accessory is FREE, it enters the assignment line like framing and
         action: what the grid assigns, the writer writes; what a paragraph asks,
         it forgets. */
      const propsLibres = libres.includes('props') && String(dims.props || '').trim()
      const grille = Array.from({ length: count }, (_, i) =>
        `SHOT ${i + 1}: framing = ${CADRAGES[i % CADRAGES.length]}; camera = ${ANGLES[i % ANGLES.length]}; action = ${FAMILLES[i % FAMILLES.length]}`
        + (propsLibres
          ? `; prop = one object of the same family as « ${String(dims.props).trim().slice(0, 120)} », `
            + 'and belonging to THIS kind of place — a driveway, a deck, a cabin, a beach, a kitchen and a '
            + 'bedroom each hold different things, and a sofa does not stand on gravel or on sand — different '
            + 'from the other shots, named in the sentence and used or touched by her'
          : ''))

      /* ================= INSTRUCTIONS ================= */
      const shSys =
        (MOTEUR_PHOTO === 'krea'
          /* The carousel does NOT go through composer.systemFor(): it builds its own
             system prompt. Without this clause the writer adds a film-stock lexicon
             tuned for Klein. */
          ? 'RENDER STYLE: never describe film grain, on-camera flash, motion blur, '
            + 'chromatic aberration or an amateur/analog snapshot look. The render style is '
            + 'appended by the system.\n'
            + 'Do not spend words on exposure, contrast, vignetting or depth of field: '
            + 'one short clause about the light is enough, and only when it changes from '
            + 'one shot to the next. Everything else goes to WHAT SHE IS DOING.\n'
          : '')
        + 'You are a photographer planning a fashion and lifestyle shoot. Write ' + count + ' DIFFERENT SHOTS of it. '
        + 'Output STRICT JSON {"shots":[...]} and nothing else — ' + count + ' plain strings, '
        + '1-3 sentences each, 55 words max, English.\n'
        + 'Each shot is ASSIGNED its framing, its camera angle and its action — respect the assignment exactly '
        + 'and restate the framing and the angle in your sentence. FIRST vary WHAT SHE IS DOING, then the framing.\n'
        + 'THE ASSIGNED ACTION OFTEN NAMES FURNITURE THAT IS NOT IN THIS SCENE. That furniture is NOT part of the '
        + 'brief. Keep what her BODY does and put it on what this setting actually has. Transpose, never import.\n'
        + 'THE ACTION LINE IS A BRIEF, NOT A SENTENCE: never copy its wording into your shot. It tells you WHAT '
        + 'to show; you write what it LOOKS LIKE — where her hands are, what she is resting or braced on, what '
        + 'her body does.\n'
        /* One IMPERATIVE instruction per dimension, naming its value. */
        + DIMS.filter(k => dims[k]).map(k => {
          const v = String(dims[k]).trim().slice(0, 180)
          const fixe = dansTronc.includes(k)
          if (k === 'outfit') return fixe
            ? `OUTFIT — LOCKED. She wears « ${v} » in every shot, and nothing else. Do not restate it: it is already written above.\n`
            : 'OUTFIT — FREE. You may change what she wears from shot to shot; she is always fully and opaquely dressed.\n'
          if (k === 'location') return fixe
            ? `LOCATION — LOCKED. Every shot happens in « ${v} ». Never move her elsewhere, and do not restate the place: it is already written above.\n`
            : 'LOCATION — FREE. You may move her to another place, the same one in all shots or a different one each time.\n'
          if (k === 'props') return fixe
            ? `PROPS — LOCKED. « ${v} » is present in every shot AND she interacts with it — she touches it, leans on it, sits on it, uses it.\n`
            : `PROPS — FREE, BUT NEVER ABSENT. Each shot has an object she uses or touches: « ${v} », or another one that belongs to this setting.\n`
          if (k === 'pose') return fixe
            ? `POSE — LOCKED. Her body stays as « ${v} ». Only framing and expression change.\n`
            : 'POSE — FREE, AND IT IS WHAT MUST VARY MOST. A different thing done with the body in every shot.\n'
          if (k === 'style') return fixe
            ? `PHOTOGRAPHIC STYLE — LOCKED: « ${v} ».\n`
            : 'PHOTOGRAPHIC STYLE — FREE.\n'
          return ''
        }).join('')
        + 'WHATEVER HER BODY USES MUST BE NAMED, AND TAKEN FROM THE SETTING. If she sits, leans, rests or braces, '
          + 'say what she is on or against, taken from what THIS setting holds. Never import what this setting '
          + 'does not have.\n'
        + (keep.pose
          ? 'THE POSE IS FIXED, LIMBS INCLUDED. Never move her arms, her hands or her legs from where the pose '
            + 'puts them. What varies from shot to shot is the place, the clothing, the framing and her expression.\n'
          : '')
        + 'ABSOLUTE RULE: she is ALONE in every shot. Never a second person in the foreground, never another hand. '
          + 'Never describe a second face.\n'
        + 'EVERYTHING STAYS SAFE FOR WORK: she is always fully and opaquely dressed, no lingerie, no suggestive pose.\n'
        + (MOTEUR_PHOTO === 'krea'
          ? 'WRITE LIKE A PHOTOGRAPH, NOT LIKE A RENDER — name the BODY, not the camera: where her weight is, what '
            + 'her hands hold or press against, what the fabric does, where her eyes go. Skin stays natural with '
            + 'visible pores.\n'
          : 'WRITE LIKE A PHOTOGRAPH, NOT LIKE A RENDER. The wordings that come back looking real are the ones '
            + 'that name the camera and its defects: candid, smartphone snapshot, uneven framing, slight motion '
            + 'blur, visible pores, film grain, shallow depth of field. Use one or two per shot where they fit — '
            + 'never a list.\n')
        + 'A reflection only ever happens in a MIRROR or in still water she faces directly — never in the glass '
        + 'of a vehicle, which comes back with a stranger sitting inside.\n'
        + (keep.outfit ? 'The outfit is fixed and written elsewhere: she wears it.\n' : '')
        + 'The shots below are the calibration — match their tone exactly. They are a measure, NOT a menu: never '
        + 'reuse one of them, never paraphrase one — invent different actions at that same level:\n'
        + tires.map(x => '- ' + x).join('\n')

      const shUser = DIMS.map(k => {
        if (!dims[k]) return null
        if (keep[k] && dansTronc.includes(k)) return `${LIBELLE[k]} — FIXED, do not restate:\n${dims[k]}`
        return `${LIBELLE[k]} — free to change, current value:\n${dims[k]}`
      }).filter(Boolean).join('\n\n')
        + `\n\nWrite exactly one shot for each line below, in the same order:\n${grille.join('\n')}`

      const parseShots = raw => {
        const m = raw.match(/\{[\s\S]*\}/)
        if (m) {
          try {
            const pj = JSON.parse(m[0])
            const arr = Array.isArray(pj.shots) ? pj.shots : Array.isArray(pj) ? pj : []
            return arr.map(x => typeof x === 'string' ? x
              : (x && typeof x === 'object') ? (Object.values(x).find(v => typeof v === 'string') ?? '') : '')
          } catch { /* line fallback */ }
        }
        /* TRUNCATED JSON: output sometimes stops mid-array. Complete strings are then
           recovered one by one: an entry closed by a quote is usable even if the
           array is not. */
        const sauvetage = raw.match(/"((?:[^"\\]|\\.){20,400})"/g)
        if (sauvetage && sauvetage.length >= 2) {
          const arr = sauvetage.map(s => { try { return JSON.parse(s) } catch { return '' } })
            .filter(x => x && !/^shots?$/i.test(x))
          if (arr.length >= 2) return arr
        }
        return raw.split('\n')
          .map(l => l.replace(/^\s*(?:shot\s*\d+\s*[:.)-]|\d+\s*[:.)-]|[-*"'`])\s*/i, '').replace(/["',]+\s*$/, '').trim())
          .filter(l => l.length > 12 && l.length < 420 && !/^(json|```|\{|\})/i.test(l))
      }
      const mdl = typeof writerModel === 'string' && writerModel ? writerModel : model
      /* Timing: a slow carousel has two possible causes: decomposition rerun (dims
         not sent by the front end) or writing retried because the model's JSON
         did not parse. */
      const tEcr = Date.now()
      let raw = await askShoot(mdl, shSys, shUser, 0.9)
      let shots = parseShots(raw).map(x => x.trim()).filter(Boolean).slice(0, count)
      let relance = false
      if (!shots.length) {
        relance = true
        raw = await askShoot(mdl, shSys + ' REMINDER: output ONLY the JSON object, nothing before or after.', shUser, 0.6)
        shots = parseShots(raw).map(x => x.trim()).filter(Boolean).slice(0, count)
      }
      const msEcr = Date.now() - tEcr
      app.log.info(`[carrousel] n=${count} · dims ${dimsRecues ? 'reçues' : 'RECALCULÉES (' + msDims + ' ms)'}`
        + ` · rédaction ${msEcr} ms${relance ? ' AVEC RELANCE (JSON illisible au 1er essai)' : ''}`)
      if (!shots.length) throw new Error('aucun plan produit — sortie modèle : « ' + raw.slice(0, 140) + ' »')
      /* Duplicates: a shoot does not deliver the same photo twice. */
      const vus = new Set()
      shots = shots.filter(s => {
        const clef = s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).slice(0, 12).join(' ')
        if (vus.has(clef)) return false
        vus.add(clef); return true
      })

      /* ================= ASSEMBLY ================= */
      const METAFIN = /[,;]\s*(?:interacting with|doing something with|playing with|handling|using the furniture|looking at (?:her own )?reflection|caught mid-?movement|at rest)[^.]*\.?\s*$/i
      const DITCADRE = /\b(shot|framing|framed|close[- ]?up|waist[- ]up|full length|wide|portrait|head and shoulders|overhead|from above|from below|eye level|floor level|from behind|three-quarter|in the mirror|reflection|across the)\b/i
      /* Camera grain re-attached in code (Klein): the writer ignores the "name the
         camera" instruction, and those words make a Klein render look like a photo.
         ONE per shot, drawn at random, and only if the photo style is NOT locked.
         On Krea the render directive is followed: a single intent formula. */
      const AMATEUR = [
        'Candid phone photo, slight motion blur.',
        'Smartphone snapshot, uneven framing, accidental crop.',
        'Visible pores and natural skin texture, soft daylight.',
        'Shot one-handed, shallow depth of field, film grain.',
        'Available light only, subsurface scattering on the skin.',
        'Unposed, caught mid-motion, natural skin texture.',
      ]
      const IPHONE = 'Shot on a recent smartphone, clean HD photo, natural daylight, sharp focus,'
        + ' true-to-life colours, no grain, no filter, no retouching. Natural skin with visible pores.'
      const DEJARENDU = /candid|amateur|smartphone snapshot|phone photo|film grain|visible grain|on-camera flash|chromatic aberration|shot one-handed|raw phone|smartphone/i
      /* On Krea, a render instruction written by the writer is film-stock vocabulary
         from the Klein corpora: the faulty clause is removed before adding the
         right one; only the render clause, never the action sentence. */
      const PHRASE_RENDU = /[,.]\s*(?:a\s+)?(?:candid|amateur|raw phone capture|shot one-handed|unposed,)[^.]*\.?\s*$/i
      const GROUPE_RENDU = /(?:,\s*)?\b(?:with|and)\s+(?:harsh on-camera flash|shallow depth of field|visible grain|film grain|slight motion blur|uneven framing|chromatic aberration)\b/gi
      const variants = shots.map((s, i) => {
        let plan = s.replace(/^[,\s]+/, '').replace(METAFIN, '.').replace(/^[\s,:;–—-]+/, '')
          .replace(/\s{2,}/g, ' ').replace(/;\s*,/g, ',').trim()
        if (MOTEUR_PHOTO === 'krea') plan = plan.replace(PHRASE_RENDU, '').replace(GROUPE_RENDU, '').replace(/\s+([,.])/g, '$1').replace(/[\s,]+$/, '').trim()
        const grain = (keep.style || DEJARENDU.test(plan)) ? ''
          : MOTEUR_PHOTO === 'krea'
            ? ` ${IPHONE}`
            : ` ${AMATEUR[(i + Math.floor(Math.random() * AMATEUR.length)) % AMATEUR.length]}`
        const cadre = DITCADRE.test(plan) ? '' : ` ${CADRAGES[i % CADRAGES.length]}, ${ANGLES[i % ANGLES.length]}.`
        return `${tronc ? tronc.replace(/[,.\s]+$/, '') + '. ' : ''}${plan.replace(/[.\s]+$/, '')}.${cadre}${grain}`.trim()
      })
      return { variants, model: mdl, shoot: true, corpus: corpus.length,
        dims, keep, tronc, dansTronc, libres, tenueImposee: false, sceneDesc: null, outfitAnchor: null, dropped: [],
        propsDedupe }
    } catch (e) {
      reply.code(502); return { error: String(e.message || e) }
    }
  }

  /* ---------- 2) LLM in TWO roles ----------
     (a) segment CLASSIFICATION, deterministic temp 0 -> indices to remove;
     (b) CONCEPT SCENES written by the writer, varying WITHIN the concept. */
  /* META segments filtered in code before classification: a source prompt
     polluted by paraphrased instructions ("is described accurately",
     "kept vague") would be KEPT and propagated to variants. */
  const METAREG = /described accurately|kept vague|resorting to|clich[ée]d terms|these instructions|"gorgeous"|"stunning"|realistic depiction|capturing the raw emotion/i
  const segs = prompt.split(/(?<=[.;])\s+/).map(x => x.trim()).filter(Boolean).filter(x => !METAREG.test(x))
  const numbered = segs.map((t, i) => `[${i}] ${t}`).join('\n')
  const topics = []
  if (has('pose')) topics.push('her body position, pose, limbs, or what she is physically doing')
  if (has('setting')) topics.push('the setting, location or background')
  if (has('style')) topics.push('the photographic style or lighting mood')
  if (outfitAnchor) topics.push('the outfit or clothing')
  const keepTopics = ['identity', ...(outfitAnchor ? [] : ['clothing']),
    ...(has('setting') ? [] : ['setting']), ...(has('style') ? [] : ['lighting']), 'image quality']
  const askOllama = async (mdl, system, user, opts) => {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CONFIG.composerTimeoutMs),
      body: JSON.stringify({ model: mdl, system, prompt: user, stream: false, keep_alive: 0, think: false,
        options: { num_gpu: 0, num_ctx: 4096, ...opts } }),
    })
    if (!res.ok) throw new Error(`Ollama ${res.status}`)
    return String((await res.json()).response || '').trim()
  }
  try {
    // (a) classification, temp 0
    const clsRaw = await askOllama(model,
      'You classify numbered segments of an image prompt. Output STRICT JSON {"drop":[...]} and nothing else.\n'
      + 'drop: the indices (integers) of segments whose MAIN topic is ' + topics.join(', or ') + '. '
      + 'Do NOT drop segments about ' + keepTopics.join(', ') + '.',
      'SEGMENTS:\n' + numbered, { temperature: 0, num_predict: 120 })
    const clsM = clsRaw.match(/\{[\s\S]*\}/)
    const drop = new Set(clsM ? (JSON.parse(clsM[0]).drop ?? []) : [])
    let base = segs.filter((_, i) => !drop.has(i)).join(' ')
    /* Over-drop: if classification removed more than 65% of the original, discard
       it and drop ONLY segments with pose keywords. */
    if (base.split(/\s+/).length < prompt.split(/\s+/).length * 0.35) {
      const POSE_KEYS = /\b(pose|posing|kneel|kneeling|stand(?:ing)?|sit(?:ting)?|lying|lies|leans?|leaning|arch(?:ed|ing)?|glanc(?:e|ing)|looking (?:back|over)|crouch|walk(?:s|ing)?)\b/i
      const drop2 = new Set(segs.map((t, i) => (has('pose') && POSE_KEYS.test(t) ? i : -1)).filter(i => i >= 0))
      base = segs.filter((_, i) => !drop2.has(i)).join(' ')
      drop.clear(); for (const i of drop2) drop.add(i)
    }
    base = base.replace(/\s*,\s*,+/g, ', ').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ')
      .replace(/^[,\s]+|[,\s]+$/g, '').replace(/,\s*\./g, '.').replace(/\(\s*\)/g, '')
    // (b) concept scenes: vary WITHIN the concept
    const freeTopics = []
    if (has('pose')) freeTopics.push('the pose / what she is doing')
    if (has('setting')) freeTopics.push('the location / background')
    if (has('style')) freeTopics.push('the lighting / photographic mood')
    if (!outfitAnchor && has('outfit')) freeTopics.push('the outfit')
    const clSys = 'You expand an image prompt into ' + count + ' distinct scene variations of the SAME concept. '
      + 'Output STRICT JSON {"scenes":[...]} and nothing else — ' + count + ' plain strings. '
      + 'Each scene: 1-3 sentences, max 55 words, same language and same tone as the ORIGINAL, '
      + 'describing only: ' + freeTopics.join('; ') + '. '
      + 'The concept NEVER changes — vary WITHIN it. '
      + 'ABSOLUTE RULE: never add a person who is not in the ORIGINAL; vary only her pose, angle, attitude or '
      + 'the moment. Everything stays safe for work: always fully and opaquely dressed, no suggestive pose. '
      + 'If the ORIGINAL is an everyday scene, each scene is a different moment or place of the SAME activity '
      + '(carrying shopping bags: crossing the street, in front of another shop window, sitting in a bus...). '
      + 'All ' + count + ' scenes clearly different from each other — never two similar poses or places. '
      + 'Each scene KEEPS the ORIGINAL’s camera framing '
      + 'and its location' + (has('setting') ? ' only if coherent' : ' (restate it briefly)') + '. '
      + 'Never contradict the BASE and NEVER repeat what the BASE already says (lighting, quality, style lines). '
      + 'If the BASE dropped a kept element of the ORIGINAL (outfit, identity details), restate it briefly'
      + (outfitAnchor ? ' — except clothing, never mention clothing' : '') + '. '
      + 'Write complete sentences naming the subject. Never write the words « the original » '
      + 'or any reference to these instructions — only what is visible in the frame. '
      + 'Any background people are distant and out of focus — never describe a second face.'
    const clUser = 'ORIGINAL PROMPT (concept reference):\n' + prompt
      + (sceneDesc ? '\n\nSOURCE IMAGE SHOWS: ' + sceneDesc : '')
      + '\n\nBASE (kept as-is, your scenes complete it):\n' + base
      + '\n\nWrite the ' + count + ' scenes.'
    /* resilient extraction: JSON -> retry with reminder -> line fallback. */
    const parseScenes = raw => {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        try {
          const parsed = JSON.parse(m[0])
          const arr = Array.isArray(parsed.scenes) ? parsed.scenes
            : Array.isArray(parsed.clauses) ? parsed.clauses : Array.isArray(parsed) ? parsed : []
          return arr.map(x => typeof x === 'string' ? x
            : (x && typeof x === 'object') ? (Object.values(x).find(v => typeof v === 'string') ?? '') : '')
        } catch { /* line fallback */ }
      }
      // fallback: numbered lines / bullets / quotes
      return raw.split('\n')
        .map(l => l.replace(/^\s*(?:scene\s*\d+\s*[:.)-]|\d+\s*[:.)-]|[-*"'`])\s*/i, '').replace(/["',]+\s*$/, '').trim())
        .filter(l => l.length > 12 && l.length < 420 && !/^(json|```|\{|\})/i.test(l))
    }
    let clRaw = await askOllama(model, clSys, clUser, { temperature: 0.75, num_predict: 1400, num_ctx: 6144 })
    let clauses = parseScenes(clRaw).map(x => x.trim()).filter(Boolean).slice(0, count)
    if (!clauses.length) {
      // second attempt with strict reminder
      clRaw = await askOllama(model, clSys + ' REMINDER: output ONLY the JSON object, nothing before or after.',
        clUser, { temperature: 0.5, num_predict: 1400, num_ctx: 6144 })
      clauses = parseScenes(clRaw).map(x => x.trim()).filter(Boolean).slice(0, count)
    }
    if (!clauses.length) throw new Error('aucune scène produite — sortie modèle : « ' + clRaw.slice(0, 140) + ' »')
    const anchorTail = outfitAnchor ? `, wearing ${outfitAnchor.replace(/^wearing\s+/i, '').replace(/[,.\s]+$/, '')}` : ''
    const variants = clauses.map(c => {
      const scene = c.trim().replace(/^[,\s]+/, '').replace(anchorTail ? /[,.\s]+$/ : /^\b$/, '')
      return (base.trim() ? `${base.replace(/[,.\s]+$/, '')}. ` : '') + scene + (anchorTail ? anchorTail + '.' : '')
    })
    return { variants, model, sceneDesc, outfitAnchor, dropped: [...drop] }
  } catch (e) {
    reply.code(502); return { error: String(e.message || e) }
  }
})

/* Carousel v2 (server/carrousel.js). The front end still calls /api/rewrite;
   this route is for trials. */
app.post('/api/carrousel/fiche', async (req, reply) => {
  try { return await blocOllama(() => carrousel.preparer(req.body)) }
  catch (e) { reply.code(502); return { error: String(e.message || e) } }
})
app.post('/api/carrousel', async (req, reply) => {
  try { return await blocOllama(() => carrousel.ecrire(req.body)) }
  catch (e) { reply.code(502); return { error: String(e.message || e) } }
})

app.get('/api/wildcards', async () => {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  let out = []
  try {
    out = fsx.readdirSync(CONFIG.wildcardsDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        const name = f.slice(0, -4)
        const lines = fsx.readFileSync(pathx.join(CONFIG.wildcardsDir, f), 'utf8')
          .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        return { name, count: lines.length, lines: lines.slice(0, 200) }
      })
  } catch { /* missing: empty */ }
  return { wildcards: out }
})

/* The library: ?persona=<id> for one character, ?persona=all for everything. */
app.get('/api/assets', async req => {
  const q = String(req.query.persona ?? '')
  const pid = q === 'all' ? undefined : q || personas().active || undefined
  return { personaId: pid ?? null, assets: store.listAssets(Number(req.query.limit) || 200, pid).map(assetOut) }
})

/* Real deletion: asset row, provenance, AND file on disk, so no orphan media
   is left on disk. */
/* Deletion = move to trash. The file goes to media/.corbeille/, the row to the
   `corbeille` table; nothing is erased before 30 days. `POST /api/assets/restore`
   undoes it. */
const CORBEILLE = path.join(CONFIG.mediaDir, '.corbeille')
const CORBEILLE_JOURS = 30
app.delete('/api/assets/:id', async (req, reply) => {
  const row = store.trashAsset(req.params.id)
  if (!row) { reply.code(404); return { error: 'asset inconnu' } }
  let fileMoved = false
  if (row.filename) {
    const nom = path.basename(row.filename)
    try {
      fs.mkdirSync(CORBEILLE, { recursive: true })
      fs.renameSync(path.join(CONFIG.mediaDir, nom), path.join(CORBEILLE, nom)); fileMoved = true
    } catch (e) {
      // File already missing: the database is cleaned anyway. Any other cause is reported.
      if (e.code !== 'ENOENT') app.log.warn(`corbeille ${row.filename} : ${e.message}`)
    }
  }
  return { id: req.params.id, removed: true, fileRemoved: fileMoved, restorableDays: CORBEILLE_JOURS }
})

app.post('/api/assets/restore', async req => {
  const restored = [], failed = []
  for (const id of (req.body?.ids ?? []).map(String)) {
    try {
      const r = store.restoreAsset(id)
      if (r.error) { failed.push({ id, error: r.error }); continue }
      if (r.filename) {
        const nom = path.basename(r.filename)
        try { fs.renameSync(path.join(CORBEILLE, nom), path.join(CONFIG.mediaDir, nom)) }
        catch (e) { if (e.code !== 'ENOENT') app.log.warn(`restauration ${nom} : ${e.message}`) }
      }
      restored.push(id)
    } catch (e) { failed.push({ id, error: String(e.message || e) }) }
  }
  return { restored, failed }
})

/** Preview of a trashed item: the image itself, or a video's thumbnail. */
app.get('/api/corbeille/vue/:file', async (req, reply) => {
  const nom = path.basename(req.params.file)
  const estVideo = /\.(mp4|webm|mov)$/i.test(nom)
  const p = estVideo ? path.join(CONFIG.mediaDir, '.posters', `${nom}.jpg`) : path.join(CORBEILLE, nom)
  if (!fs.existsSync(p)) { reply.code(404); return { error: 'pas d’aperçu' } }
  reply.header('Cache-Control', 'private, max-age=3600')
  reply.type(estVideo ? 'image/jpeg' : ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(nom).toLowerCase()] ?? 'application/octet-stream'))
  return fs.createReadStream(p)
})

app.get('/api/corbeille', async () => {
  const l = store.trashList()
  return { count: l.length, days: CORBEILLE_JOURS, items: l.map(r => ({ id: r.asset_id, deletedAt: r.deleted_at, filename: r.filename })) }
})

/** Purge: items trashed more than 30 days ago are erased for good; `tout`
 *  empties the whole trash ("Vider la corbeille" button). */
function purgerCorbeille(tout = false) {
  const limite = tout ? Infinity : Date.now() - CORBEILLE_JOURS * 86400_000
  let n = 0
  for (const r of store.trashList()) {
    if (r.deleted_at > limite) continue
    if (r.filename) for (const p of [path.join(CORBEILLE, path.basename(r.filename)), path.join(CONFIG.mediaDir, '.posters', `${path.basename(r.filename)}.jpg`)])
      try { fs.unlinkSync(p) } catch (e) { if (e.code !== 'ENOENT') app.log.warn(`purge ${p} : ${e.message}`) }
    store.trashForget(r.asset_id); n++
  }
  if (n) app.log.info(tout ? `corbeille vidée : ${n} élément(s) effacé(s)` : `corbeille : ${n} élément(s) de plus de ${CORBEILLE_JOURS} jours effacé(s)`)
  return n
}
/* Empty trash: PERMANENT erasure (files and thumbnails), after confirmation
   in the UI. */
app.post('/api/corbeille/vider', async () => ({ effaces: purgerCorbeille(true) }))
purgerCorbeille()
setInterval(purgerCorbeille, 6 * 3600_000).unref()

/* ---------- purge of visitor renders ----------
   On a shared studio (owner key set), what Internet visitors rendered is erased for good after
   CREATOROS_PURGE_VISITEURS_JOURS days (2 by default, 0 = never): job rows, their assets,
   files and thumbnails. A render counts as a visitor's when the visitor launched it
   (origines_visiteur), when it is a shot of a reel the visitor launched, or when it is the
   montage that such a reel assembles from its own shots.
   The owner's renders are never touched: what cannot be traced to a visitor stays, and so does
   a visitor render the owner approved, flagged for export or filed in a folder of their own. */
const PURGE_VISITEURS_JOURS = Number(process.env.CREATOROS_PURGE_VISITEURS_JOURS ?? 2)
function rendusVisiteurs() {
  const marques = store.idsVisiteur()
  const reels = [...marques].filter(i => /^reel-/.test(i))
  const jobs = store.jobsTermines().map(r => { let p = null; try { p = JSON.parse(r.payload || 'null') } catch { /* unreadable payload */ } return { id: r.id, at: r.created_at, p } })
  const visiteur = new Set(jobs.filter(j => marques.has(j.id) || reels.some(r => j.id.startsWith(`${r}-`))).map(j => j.id))
  const deVisiteur = assetId => { const j = assetId ? store.jobDeAsset(assetId) : null; return !!j && visiteur.has(j) }
  for (let change = true; change;) {
    change = false
    for (const j of jobs) {
      if (visiteur.has(j.id) || !j.p) continue
      // the montage a reel assembles on its own at the end: every clip is a shot of a visitor reel
      if (j.p.op !== 'montage' || !j.p.montageId) continue
      let clips = null
      try { clips = JSON.parse(store.db.prepare('SELECT data FROM montages WHERE id = ?').get(j.p.montageId)?.data || 'null')?.clips ?? null } catch { clips = null }
      if (clips?.length && clips.every(c => /^a-reel-/.test(String(c.assetId ?? '')) && deVisiteur(c.assetId))) { visiteur.add(j.id); change = true }
    }
  }
  return { jobs: jobs.filter(j => visiteur.has(j.id)), reels }
}
function purgerVisiteurs() {
  if (!CONFIG.cleProprietaire || !(PURGE_VISITEURS_JOURS > 0)) return 0
  const limite = Date.now() - PURGE_VISITEURS_JOURS * 86400_000
  const { jobs, reels } = rendusVisiteurs()
  let n = 0, fichiers = 0
  // kept: a visitor render the owner approved, flagged for export, or filed in a folder of their own
  // (the "visitor" folder is only the sorting bin of those renders)
  const garde = store.db.prepare(`SELECT 1 FROM assets a WHERE a.job_id = ? AND (a.review_status = 'approved' OR a.export_ready = 1
    OR EXISTS (SELECT 1 FROM folder_assets fa JOIN folders f ON f.id = fa.folder_id WHERE fa.asset_id = a.id AND f.name NOT LIKE '%visit%')) LIMIT 1`)
  for (const j of jobs) {
    if (j.at > limite || garde.get(j.id)) continue
    for (const f of store.jobAssetFiles(j.id)) {
      for (const p of [path.join(CONFIG.mediaDir, path.basename(f)), path.join(CONFIG.mediaDir, '.posters', `${path.basename(f)}.jpg`)])
        try { fs.unlinkSync(p); fichiers++ } catch (e) { if (e.code !== 'ENOENT') app.log.warn(`purge visiteurs ${p} : ${e.message}`) }
    }
    if (j.p?.op === 'montage' && j.p.montageId) store.db.prepare('DELETE FROM montages WHERE id = ?').run(j.p.montageId)
    if (store.deleteJobDeep(j.id).removed) n++
    store.oublierVisiteur(j.id)
  }
  // a visitor reel goes once it is old enough and none of its shots is left
  for (const r of reels) {
    const row = store.db.prepare('SELECT created_at FROM reels WHERE id = ?').get(r)
    if (row && row.created_at > limite) continue
    if (store.db.prepare(`SELECT 1 FROM jobs WHERE id LIKE ? LIMIT 1`).get(`${r}-%`)) continue
    store.db.prepare('DELETE FROM reels WHERE id = ?').run(r)
    store.oublierVisiteur(r)
  }
  if (n) app.log.info(`rendus des visiteurs : ${n} job(s) de plus de ${PURGE_VISITEURS_JOURS} jours effacé(s), ${fichiers} fichier(s)`)
  return n
}
setTimeout(purgerVisiteurs, 60_000).unref()
setInterval(purgerVisiteurs, 6 * 3600_000).unref()

/* ---------- video extension: last frame -> i2v start frame ----------
   A video (uploaded to input/ or a gallery clip) is extended by extracting its
   LAST frame as the start image of a standard i2v.
   `pick`: 'last' = the very last; 'sharp' = the sharpest of the last half
   second (end motion blur conditions the whole render). Sharpness measured by
   edge energy (sobel + signalstats, one ffmpeg pass): a relative metric,
   compared within the window. */
/** A frame taken from a video inherits its origin: a library render gives
 *  "genere", a file from input/ keeps its upload's origin. */
const origineDe = videoPath => path.dirname(path.resolve(videoPath)) === path.resolve(CONFIG.comfyInput)
  ? (store.origineInput(path.basename(videoPath)) ?? 'inconnu') : 'genere'
function extractLastFrame(videoPath, pick = 'last') {
  /* Prequel: the FIRST frame, which becomes the render's end frame. */
  if (pick === 'first') {
    const stem = path.basename(videoPath).replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 40)
    const filename = `crs_firstframe_${Date.now().toString(36)}_${stem}.png`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vframes', '1', path.join(CONFIG.comfyInput, filename)])
    store.noterInput(filename, origineDe(videoPath))
    const { width, height } = imageSize(fs.readFileSync(path.join(CONFIG.comfyInput, filename)))
    return { filename, width, height, warn: null }
  }
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', videoPath], { encoding: 'utf8' }).trim())
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('durée de la vidéo illisible')
  const win = Math.min(0.6, dur)
  // Sharpness scores of the frames in the end window.
  const meta = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, dur - win)), '-i', videoPath,
    '-vf', 'sobel,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
  const scores = [...meta.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map(m => Number(m[1]))
  if (!scores.length) throw new Error('dernière frame non extractible (aucune frame décodée en fin de vidéo)')
  const last = scores.length - 1
  let idx = last
  if (pick === 'sharp') { for (let i = 0; i < scores.length; i++) if (scores[i] > scores[idx]) idx = i }
  const maxScore = Math.max(...scores)
  const blurry = scores[last] < 0.6 * maxScore
  // Extract the chosen frame, counted from the end of the window.
  const stem = path.basename(videoPath).replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 40)
  const filename = `crs_lastframe_${Date.now().toString(36)}_${stem}.png`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, dur - win)), '-i', videoPath,
    '-vf', `select=eq(n\\,${idx})`, '-vframes', '1', path.join(CONFIG.comfyInput, filename)])
  store.noterInput(filename, origineDe(videoPath))
  const buf = fs.readFileSync(path.join(CONFIG.comfyInput, filename))
  const { width, height } = imageSize(buf)
  return { filename, width, height, framesFromEnd: last - idx, lastScore: scores[last], maxScore,
    warn: blurry && pick === 'last'
      ? 'dernière frame nettement plus floue que la fenêtre de fin — la netteté de la frame de départ conditionne le rendu : « dernière nette » recommandé'
      : null }
}

/** Last frame of a video already in input/ (upload). body: { file, pick } */
app.post('/api/input/last-frame', async (req, reply) => {
  const f = String(req.body?.file || '').trim()
  if (!f || /[\\/]/.test(f) || f.startsWith('.')) { reply.code(400); return { error: 'nom de fichier nu attendu (dossier input/)' } }
  const full = path.join(CONFIG.comfyInput, f)
  if (!(estProprietaire(req) ? store.estInputStudio : store.estInputVisiteur)(f) || !fs.existsSync(full)) { reply.code(404); return { error: `« ${f} » absent du dossier input/` } }
  try { return extractLastFrame(full, ['sharp', 'first'].includes(req.body?.pick) ? req.body.pick : 'last') }
  catch (e) { reply.code(422); return { error: String(e.message || e) } }
})

/* A library still lives in creatoros-data/media/; a LoadImage node only reads
   ComfyUI's input/ folder. Animating an existing image therefore requires
   copying it there: this route does just that and returns the NAME, the only
   thing the graph can handle.

   Copy, not symlink: the media can be deleted from the library between
   picking the still and starting the render, and a dead link would fail the
   job at execution rather than at validation. */
app.post('/api/assets/:id/to-input', async (req, reply) => {
  const row = store.getAsset(req.params.id)
  if (!row) { reply.code(404); return { error: 'asset inconnu' } }
  if (!row.filename) { reply.code(400); return { error: 'asset sans fichier sur disque' } }
  const src = path.join(CONFIG.mediaDir, path.basename(row.filename))
  if (!fs.existsSync(src)) { reply.code(410); return { error: 'fichier absent du disque' } }
  /* A video clip is not used as a start image as is, but its LAST frame is
     (video extension, ?frame=last|sharp). */
  if (row.media_type === 'video') {
    const pick = req.query.frame
    if (pick !== 'last' && pick !== 'sharp' && pick !== 'first') { reply.code(400); return { error: 'une vidéo ne peut pas servir d’image de départ — utiliser ?frame=last|sharp pour prolonger le clip depuis sa dernière frame (first : sa 1re frame, pour un prequel)' } }
    try { return extractLastFrame(src, pick) }
    catch (e) { reply.code(422); return { error: String(e.message || e) } }
  }
  const filename = `crs_still_${path.basename(row.filename)}`
  fs.mkdirSync(CONFIG.comfyInput, { recursive: true })
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, filename))
  store.noterInput(filename)
  return { filename, width: row.width, height: row.height }
})

/* Inspirations (video): a card's start photo. Files ship with the studio (public/inspirations),
   so they are studio renders: they are placed in input/ like a render, which a visitor can
   animate. Only names from the shipped list are accepted. */
const DOSSIER_INSPIRATIONS = path.join(import.meta.dirname, '..', 'public', 'inspirations')
app.post('/api/inspirations/:id/depart', async (req, reply) => {
  const id = String(req.params.id)
  const src = path.join(DOSSIER_INSPIRATIONS, `${id}-depart.jpg`)
  if (!/^[a-z0-9-]{1,80}$/.test(id) || !fs.existsSync(src)) { reply.code(404); return { error: 'inspiration inconnue' } }
  const filename = `crs_insp_${id}.jpg`
  fs.mkdirSync(CONFIG.comfyInput, { recursive: true })
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, filename))
  store.noterInput(filename, 'genere')
  const [width, height] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src],
    { encoding: 'utf8' }).trim().split(',').map(Number)
  return { filename, width, height }
})

/* "Open in ComfyUI": the exact API-format graph sent for this render, to drop into
   ComfyUI; absolute paths reduced to the file name. With the list of models it loads
   and their license, read from the assistant manifest. */
const MANIFESTE_MODELES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'installer', 'modeles.json'), 'utf8')).modeles
app.get('/api/assets/:id/workflow', async (req, reply) => {
  const p = store.getProvenance(req.params.id)
  const wf = p && parse(p.workflow_json)
  if (!wf || typeof wf !== 'object') { reply.code(404); return { error: 'pas de graphe enregistré pour ce rendu' } }
  const modeles = new Map()
  const nettoyer = v => typeof v === 'string' && /^(\/|[A-Za-z]:\\)/.test(v) ? path.basename(v) : v
  for (const n of Object.values(wf)) {
    if (!n?.inputs) continue
    for (const [k, v] of Object.entries(n.inputs)) {
      n.inputs[k] = nettoyer(v)
      if (typeof v === 'string' && /\.(safetensors|gguf|pth|onnx|pt)$/.test(v)) {
        const m = MANIFESTE_MODELES.find(x => x.chemin.split('/').pop() === v.split('/').pop())
        modeles.set(v.split('/').pop(), m?.licence ?? null)
      }
    }
  }
  return { assetId: p.asset_id, recette: p.recipe_id, workflow: wf, modeles: [...modeles].map(([fichier, licence]) => ({ fichier, licence })) }
})

app.get('/api/assets/:id/provenance', async (req, reply) => {
  const p = store.getProvenance(req.params.id)
  if (!p) { reply.code(404); return { error: 'provenance inconnue' } }
  return {
    assetId: p.asset_id, jobId: p.job_id, createdAt: p.created_at, recipeId: p.recipe_id,
    workflowFile: p.workflow_file, comfyPromptId: p.comfy_prompt_id, seed: p.seed,
    composedPositive: p.composed_positive, composedNegative: p.composed_negative,
    userPrompt: p.user_prompt, userDirectives: p.user_directives,
    resolvedText: parse(p.resolved_text),
    // Which identity preamble was actually injected: without it, an asset
    // cannot be replayed.
    identityPreamble: parse(p.identity_preamble),
    registerClause: p.register_clause,
    extraLoras: parse(p.extra_loras) ?? null,
    sourceImage: p.source_image,
    selections: parse(p.selections), injections: parse(p.injections),
    workflowJson: parse(p.workflow_json),
    // what the job actually received: a clone replays it even without selections (API-launched jobs)
    ...((j => j ? { videoEngine: j.videoEngine ?? null, endImage: j.endImage ?? null, videoSeconds: j.videoSeconds ?? null, withAudio: j.withAudio ?? null,
      /* Keyframes of an edit-table shot, found in the library (crs_still_<file>); an image
         uploaded from the computer stays an upload (up:<name>). Used to reopen the shot in Movie Studio. */
      keyframes: Array.isArray(j.keyframes) ? j.keyframes.map(k => {
        const nom = String(k.image ?? ''), a = nom.startsWith('crs_still_') ? store.assetParFichier(nom.slice(10)) : null
        return a ? { assetId: a.id, uri: a.uri, t: Number(k.t) } : { assetId: `up:${nom}`, uri: `/api/uploads/${encodeURIComponent(nom)}`, t: Number(k.t) }
      }) : null } : {})(
      (() => { try { return JSON.parse(store.getJob(p.job_id)?.payload ?? 'null') } catch { return null } })())),
  }
})

/** The LoRAs that ACTUALLY ran, read from the executed graph.
 *  `extra_loras` only contains those added to the job, not the recipe's. The
 *  full stack is what explains a render (a strong style LoRA can override
 *  identity), so it is rebuilt from `workflow_json`, the only source of what
 *  ran rather than what was requested. */
app.get('/api/assets/:id/loras', async (req, reply) => {
  const p = store.getProvenance(req.params.id)
  if (!p) { reply.code(404); return { error: 'provenance inconnue' } }
  const wf = parse(p.workflow_json)
  if (!wf) return { loras: [] }
  /* Job additions are identified by file name: the only key shared between
     `extra_loras` and the graph nodes. */
  const ajoutees = new Set((parse(p.extra_loras) ?? []).map(l => String(l.name)))
  const loras = Object.entries(wf)
    .filter(([, n]) => /Lora/i.test(String(n?.class_type)))
    .map(([node, n]) => ({ node, ...n.inputs }))
    .filter(l => l.lora_name && String(l.lora_name).toLowerCase() !== 'none')
    /* Graph order = stacking order, and it matters: the last applied one pulls
       the hardest. Ids are numeric. */
    .sort((a, b) => Number(a.node) - Number(b.node))
    .map(l => ({
      node: l.node,
      name: String(l.lora_name),
      /* short display name: without folder or extension */
      label: String(l.lora_name).split('/').pop().replace(/\.safetensors$/i, ''),
      strength: l.strength_model ?? l.strength ?? null,
      strengthClip: l.strength_clip ?? null,
      source: ajoutees.has(String(l.lora_name)) ? 'job' : 'recette',
    }))
  return { loras }
})

/** Manual review: the human safeguard of the CreatorOS model. */
/* Upscale of a video draft: copies the mp4 to input/ and queues an
   "upscale" job (V2V refine, motion preserved) in the standard queue. */
/* "Go HD" for a PHOTO: gentle upscale to 2 MP + refine, face taken from the
   source. `?strength=` sets the enhancement (0 to 0.4). */
app.post('/api/assets/:id/photo-hd', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a) { reply.code(404); return { error: 'asset inconnu' } }
  if (a.media_type !== 'photo') { reply.code(400); return { error: 'HD photo : images seulement' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  const inputName = `PHD_${Date.now().toString(36)}.png`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  /* The refine prompt is the one that PRODUCED the image, identity preamble
     included: a foreign text would make the scene drift. */
  const prov = store.getProvenance(a.id)
  let preamble = ''
  try { preamble = JSON.parse(prov?.identity_preamble ?? 'null')?.text ?? '' } catch { /* missing */ }
  const prompt = `${preamble}${prov?.composed_positive ?? ''}`.trim()
    || 'natural skin, soft matte finish, fine natural texture, faint soft freckles, raw unretouched phone photo'
  const { id } = deposerAvecCle(cleComfy(req), () => enqueuePhotoHd({
    sourceFile: inputName, parentAssetId: a.id, prompt, strength: Number(req.query?.strength),
  }))
  return { jobId: id }
})

/** Brush edit, image or video: `mask` = PNG (data URL) white on black, at the image's
 *  dimensions (for a video: painted on its first frame; `suivi` false = fixed area);
 *  `prompt` = what should be in the painted area. */
app.post('/api/assets/:id/inpaint', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a) { reply.code(404); return { error: 'asset inconnu' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.mask ?? ''))
  if (!m) { reply.code(400); return { error: 'masque absent ou illisible' } }
  const prompt = String(req.body?.prompt ?? '').trim()
  if (!prompt) { reply.code(400); return { error: 'décris ce qui doit apparaître dans la zone peinte' } }
  const video = a.media_type === 'video'
  const cle = Date.now().toString(36)
  const inputName = `INP_${cle}${path.extname(src) || '.png'}`, maskName = `INP_${cle}_masque.png`
  /* Object painted into a clip: the reference photo comes from the library. */
  let objet = null
  if (video && req.body?.objetAsset) {
    const o = store.getAsset(String(req.body.objetAsset))
    if (!o || o.media_type !== 'photo') { reply.code(400); return { error: 'choisis une photo de l’objet dans la bibliothèque' } }
    objet = `INP_${cle}_objet${path.extname(o.filename) || '.png'}`
    fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(o.filename)), path.join(CONFIG.comfyInput, objet))
  }
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  fs.writeFileSync(path.join(CONFIG.comfyInput, maskName), Buffer.from(m[1], 'base64'))
  try {
    if (video) {
      const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaintVideo({ sourceFile: inputName, maskFile: maskName, parentAssetId: a.id,
        prompt, strength: objet && !Number.isFinite(Number(req.body?.strength)) ? 0.5 : Number(req.body?.strength), suivi: req.body?.suivi !== false, objet, objetNom: req.body?.objetNom, loin: req.body?.loin === true }))
      return { jobId: id }
    }
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaint({
      sourceFile: inputName, maskFile: maskName, parentAssetId: a.id, prompt, strength: Number(req.body?.strength), personaId: personaDuRendu(a),
    }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** A render's character: its job's, not the currently active character. */
const personaDuRendu = a => { const j = a.job_id ? store.getJob(a.job_id) : null; return a.persona_id ?? j?.persona_id ?? j?.personaId ?? undefined }

/* Expand a photo: the frame widens to the requested aspect, the image stays centered and
   the brush redraws the edges (white mask, 24 px overlap to blend the seam). */
const FORMATS_AGRANDIR = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '+30%': null }
app.post('/api/assets/:id/agrandir', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type === 'video') { reply.code(404); return { error: 'photo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  const format = String(req.body?.format ?? '')
  if (!(format in FORMATS_AGRANDIR)) { reply.code(400); return { error: 'format inconnu' } }
  const { width: w, height: h } = imageSize(fs.readFileSync(src))
  if (!w || !h) { reply.code(400); return { error: 'image illisible' } }
  const r = FORMATS_AGRANDIR[format]
  const pair = n => Math.round(n / 16) * 16
  let W = r === null ? w * 1.3 : Math.max(w, h * r), H = r === null ? h * 1.3 : Math.max(h, w / r)
  if (r !== null && (W - w < 32 && H - h < 32)) { reply.code(400); return { error: 'la photo est déjà à ce format' } }
  const k = Math.min(1, 1600 / Math.max(W, H))          // long side capped: beyond it the recipe saturates
  const iw = pair(w * k), ih = pair(h * k); W = Math.max(pair(W * k), iw); H = Math.max(pair(H * k), ih)
  const cle = Date.now().toString(36)
  const entree = `AGR_${cle}.png`, masque = `AGR_${cle}_masque.png`, x = Math.floor((W - iw) / 2), y = Math.floor((H - ih) / 2)
  const e = [24, 24, 24, 24].map((m, i) => ((i < 2 ? (i ? H > ih : W > iw) : (i === 2 ? W > iw : H > ih)) ? m : 0))
  const ff = args => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { timeout: 30_000 })
  try {
    // margins pre-filled with a blurred extension of the photo: flat grey bands read as
    // bands to remove (the model crops or leaves them grey); a blur reads as a scene to refine
    ff(['-i', src, '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=saturation=0.85[f];[0:v]scale=${iw}:${ih}[i];[f][i]overlay=${x}:${y},format=rgb24`, '-frames:v', '1', path.join(CONFIG.comfyInput, entree)])
    ff(['-f', 'lavfi', '-i', `color=white:s=${W}x${H}`, '-f', 'lavfi', '-i', `color=black:s=${iw - e[0] - e[2]}x${ih - e[1] - e[3]}`, '-filter_complex', `[0][1]overlay=${x + e[0]}:${y + e[1]},format=rgb24`, '-frames:v', '1', path.join(CONFIG.comfyInput, masque)])
    const consigne = String(req.body?.prompt ?? '').trim() || 'Outpaint: the blurred margins around the photo are an unfinished extension of the scene. Redraw them as a sharp, detailed, natural continuation of the same place, at the same scale, with the same light, perspective and style, photorealistic. Keep the whole image at this exact framing: do not zoom, crop or reframe. Do not add any person. Keep the center unchanged.'
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaint({ sourceFile: entree, maskFile: masque, parentAssetId: a.id, prompt: consigne, strength: 1, personaId: personaDuRendu(a), agrandir: true }))
    return { jobId: id, largeur: W, hauteur: H }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Stage: a scene in numbers becomes a finished shot (see enqueueStage). */
app.post('/api/stage', async (req, reply) => {
  try {
    const b = req.body ?? {}
    const r = deposerAvecCle(cleComfy(req), () => enqueueStage({ scene: b.scene, prompt: b.prompt, format: b.format, secondes: b.secondes, personaId: personaDe(req) }))
    return { jobId: r.id }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Reopen a shot in Stage: the numeric scene and the job text. */
app.get('/api/stage/:id/scene', async (req, reply) => {
  const job = store.getJob(req.params.id)
  const f = path.join(CONFIG.mediaDir, '.stage', `${path.basename(req.params.id)}.json`)
  if (!job || !/^stage-/.test(job.id) || !fs.existsSync(f)) { reply.code(404); return { error: 'scène inconnue' } }
  const { objets, camera } = JSON.parse(fs.readFileSync(f, 'utf8'))
  return { objets, camera, prompt: job.user_prompt }
})

/* 3D Stage: usable models, studio objects and imported .glb files. */
app.get('/api/stage/modeles', async () => {
  const objets = fs.readdirSync(CONFIG.mediaDir).filter(f => /^objet3d-[a-z0-9]+\.glb$/.test(f)).reverse().slice(0, 60)
    .map(f => ({ nom: f, titre: store.getJob(f.replace(/\.glb$/, ''))?.user_prompt ?? f, url: `/media/${f}` }))
  const d = path.join(CONFIG.mediaDir, '.stage')
  const importes = fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^imp_.*\.glb$/.test(f)).map(f => ({ nom: f, titre: f.replace(/^imp_[a-z0-9]+_/, ''), url: `/api/stage/modeles/${f}` })) : []
  return { modeles: [...importes, ...objets].filter(m => cheminModele(m.nom)) }
})
app.get('/api/stage/modeles/:nom', async (req, reply) => {
  const f = cheminModele(req.params.nom)
  if (!f) { reply.code(404); return { error: 'modèle inconnu' } }
  reply.type('model/gltf-binary')
  return fs.createReadStream(f)
})
/** .glb import: owner only, like any file upload. */
app.addContentTypeParser('model/gltf-binary', { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 }, (req, corps, done) => done(null, corps))
/* Optional MiniMax H3: status, then weights upload by the owner (see h3.js). */
app.get('/api/modeles/h3', async () => etatH3())
app.put('/api/modeles/h3/:nom', { bodyLimit: 64 * 1024 ** 3 }, async (req, reply) => {
  if (demoPublique()) { reply.code(403); return { error: H3_MESSAGE_DEMO } }
  if (req.headers['x-licence-h3'] !== 'acceptee') { reply.code(400); return { error: 'accepte d’abord la licence MiniMax H3' } }
  try { return await recevoirFichierH3(req.params.nom, req.body) } catch (e) { reply.code(e.statusCode ?? 500); return { error: String(e.message || e) } }
})

/** Create a character from scratch (see createurPersonnage.js), owner only. */
app.post('/api/personnages/propositions', async (req, reply) => {
  try { return { jobs: propositions(req.body?.traits) } } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/personnages/creer', async (req, reply) => {
  try { return creerPersonnage({ assetId: req.body?.assetId, nom: req.body?.nom, traits: req.body?.traits, entrainer: req.body?.entrainer === true, moteurs: Array.isArray(req.body?.moteurs) ? req.body.moteurs : undefined }) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/personnages/creer/:id', async (req, reply) => etatCreation(req.params.id) ?? (reply.code(404), { error: 'création inconnue' }))

/** Character training on library images (owner only). */
/** LoRA trainings of the last 14 days: status, steps done, estimated remaining time, produced LoRA. */
app.get('/api/entrainement', async () => {
  const lignes = store.db.prepare(`SELECT id, persona_id, status, created_at, started_at, finished_at, error, payload FROM jobs
    WHERE recipe_id = 'entrainement@v1' AND created_at > ? ORDER BY created_at DESC LIMIT 20`).all(Date.now() - 14 * 86400_000)
  const travaux = lignes.map(r => {
    let p = {}; try { p = JSON.parse(r.payload ?? '{}') } catch { /* unreadable payload */ }
    const av = avancementEntrainements.get(r.id)
    const total = av?.total ?? p.entrainementPas ?? null
    const ecoule = r.started_at ? Date.now() - r.started_at : 0
    const resteMs = r.status === 'done' ? 0 : av?.pas > 20 ? Math.round((Date.now() - av.debut) / av.pas * (av.total - av.pas))
      : Math.max(0, (p.estimatedMs ?? 0) - ecoule)
    return { id: r.id, personaId: r.persona_id, statut: r.status, moteur: p.entrainementMoteur ?? 'klein', declencheur: p.entrainementDeclencheur ?? null, images: p.entrainementImages?.length ?? null,
      pas: av?.pas ?? (r.status === 'done' ? total : null), total, debut: r.started_at, fin: r.finished_at, resteMs, erreur: r.error ? String(r.error).slice(0, 200) : null,
      lora: r.status === 'done' && !p.entrainementEssai ? `${String(r.persona_id).replace(/[^a-z0-9_]/g, '')}_${p.entrainementMoteur ?? 'klein'}_${r.id.slice(6)}.safetensors` : null }
  })
  const moteurs = Object.entries(MOTEURS_ENTRAINEMENT).map(([id, m]) => ({ id, nom: m.nom, pret: moteurEntrainementPret(id), secParPas: m.secParPas, preparationS: m.preparationS }))
  return { pret: aiToolkitPret(), moteurs, travaux }
})
app.post('/api/personas/:id/entrainer', async (req, reply) => {
  const ids = Array.isArray(req.body?.assets) ? req.body.assets.slice(0, 30) : []
  const images = ids.map(i => store.getAsset(String(i))).filter(a => a && a.media_type === 'photo').map(a => path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))).filter(f => fs.existsSync(f))
  // one or more engines: one training per engine, queued one after another
  const moteurs = (Array.isArray(req.body?.moteurs) ? req.body.moteurs : [req.body?.moteur ?? 'klein']).map(String).filter((m, i, l) => l.indexOf(m) === i).slice(0, 3)
  try {
    const jobIds = moteurs.map(moteur => enqueueEntrainement({ personaId: req.params.id, images, declencheur: req.body?.declencheur, pas: req.body?.pas, essai: req.body?.essai === true, moteur, legendes: Array.isArray(req.body?.legendes) ? req.body.legendes : null }).id)
    return { jobId: jobIds[0], jobIds }
  }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Dubbing a clip with a voice from the audio library (see enqueueDoublage). */
app.post('/api/assets/:id/doubler', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'clip inconnu' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  const audio = montage.cheminMusique(String(req.body?.audio ?? ''))
  if (!fs.existsSync(src) || !audio) { reply.code(400); return { error: 'choisis un clip et une voix de la bibliothèque audio' } }
  try {
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueDoublage({ source: src, audio, texte: req.body?.audio, parentAssetId: a.id, personaId: a.persona_id }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Voice-over (see voix.js). */
app.get('/api/voix', async req => ({ disponible: voixDisponible(), voix: VOIX, clone: cloneDisponible(),
  // possible cloned voices: audio library excerpts (owner only), excluding reel tracks
  clones: estProprietaire(req) && cloneDisponible() ? montage.listerMusiques().filter(m => !/^reel_/.test(m.nom) && m.duree >= 4 && m.duree <= 25).map(m => ({ id: `clone:${m.nom}`, nom: m.nom })) : [] }))
/* Talking avatar: the sentence spoken by a voice (character's, studio's or cloned), placed as
   the InfiniteTalk voice; the lips then follow that file. */
app.post('/api/parole/dire', async (req, reply) => {
  const proprio = estProprietaire(req)
  let v = String(req.body?.voix ?? '')
  if (v === 'perso') v = persona(personaDe(req)).voix ?? ''
  const voix = voixAcceptee(v, proprio)
  if (!voix) { reply.code(400); return { error: 'choisis une voix' } }
  try {
    const { nom } = await dire({ texte: req.body?.texte, voix, proprietaire: proprio })
    const fichier = `crs_voix_${Date.now().toString(36)}.wav`
    fs.copyFileSync(path.join(montage.MUSIQUES_DIR, nom), path.join(CONFIG.comfyInput, fichier))
    store.noterInput(fichier, 'voix')
    let duree = 0
    try { duree = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(CONFIG.comfyInput, fichier)], { encoding: 'utf8' }).trim()) || 0 } catch { /* unreadable */ }
    return { fichier, duree, nom }
  } catch (e) { reply.code(400); return { error: String(e.stderr || e.message || e).slice(-300) } }
})
app.post('/api/voix/clone', async (req, reply) => {
  try { return await cloner({ texte: req.body?.texte, reference: req.body?.reference, accord: req.body?.accord === true }) }
  catch (e) { reply.code(400); return { error: String(e.stderr || e.message || e).slice(-300) } }
})
/** Retiming of an edit-table shot: moved keyframes change speed segment by segment.
    points = [{ src, dst }] (s): the keyframe's time in the rendered clip, and the desired one. Image and
    sound follow (setpts, atempo); the result is a new clip in the library. */
app.post('/api/assets/:id/retemps', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'clip inconnu' } }
  const video = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  try {
    const duree = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim())
    let pts = (Array.isArray(req.body?.points) ? req.body.points : []).map(p => ({ src: Number(p.src), dst: Number(p.dst) }))
      .filter(p => Number.isFinite(p.src) && Number.isFinite(p.dst) && p.src >= 0 && p.dst >= 0)
    pts = [{ src: 0, dst: 0 }, ...pts.filter(p => p.src > 0.05 && p.src < duree - 0.05), { src: duree, dst: pts.find(p => p.src >= duree - 0.05)?.dst ?? null }]
    if (pts[pts.length - 1].dst == null) pts[pts.length - 1].dst = pts[pts.length - 2].dst + (duree - pts[pts.length - 2].src)
    pts.sort((x, y) => x.src - y.src)
    for (let i = 1; i < pts.length; i++) if (!(pts[i].dst > pts[i - 1].dst + 0.1)) throw new Error('les images clés doivent rester dans l’ordre, à 0,1 s au moins l’une de l’autre')
    const son = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', video]).toString().trim().length > 0
    const atempo = r => { const f = []; while (r < 0.5) { f.push('atempo=0.5'); r /= 0.5 } while (r > 2) { f.push('atempo=2'); r /= 2 } f.push(`atempo=${r.toFixed(5)}`); return f.join(',') }
    const parts = [], cat = []
    for (let i = 1; i < pts.length; i++) {
      const s0 = pts[i - 1].src, s1 = pts[i].src, k = (pts[i].dst - pts[i - 1].dst) / (s1 - s0)
      parts.push(`[0:v]trim=start=${s0.toFixed(4)}:end=${s1.toFixed(4)},setpts=(PTS-STARTPTS)*${k.toFixed(5)}[v${i}]`)
      if (son) parts.push(`[0:a]atrim=start=${s0.toFixed(4)}:end=${s1.toFixed(4)},asetpts=PTS-STARTPTS,${atempo(1 / k)}[a${i}]`)
      cat.push(`[v${i}]${son ? `[a${i}]` : ''}`)
    }
    const graphe = `${parts.join(';')};${cat.join('')}concat=n=${pts.length - 1}:v=1:a=${son ? 1 : 0}[v]${son ? '[a]' : ''},[v]fps=24[vo]`.replace(',[v]fps=24[vo]', ';[v]fps=24[vo]')
    const jobId = `retemps-${Date.now().toString(36)}`, sortie = `${jobId}-0.mp4`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-filter_complex', graphe, '-map', '[vo]', ...(son ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(CONFIG.mediaDir, sortie)], { timeout: 300_000 })
    const resume = pts.slice(1, -1).map(p => `${p.src.toFixed(1)} → ${p.dst.toFixed(1)} s`).join(', ')
    store.createJob({ id: jobId, createdAt: Date.now(), status: 'rendering', personaId: a.persona_id ?? null, register: 'sfw', mode: 'video', purpose: 'creative',
      recipeId: 'retemps@v1', workflowFile: null, seed: null, op: 'retemps', videoEngine: null, userPrompt: `vitesse retouchée (${resume})`, composedPositive: null, parentAssetId: a.id, estimatedMs: 20_000 })
    store.markStarted(jobId, null)
    store.createAsset(
      { id: `a-${jobId}-0`, jobId, createdAt: Date.now(), mediaType: 'video', uri: `/media/${sortie}`, filename: sortie, bytes: fs.statSync(path.join(CONFIG.mediaDir, sortie)).size,
        width: a.width ?? null, height: a.height ?? null, aspect: a.aspect ?? null, register: 'sfw', op: 'retemps', videoEngine: null },
      { recipeId: 'retemps@v1', workflowFile: null, comfyPromptId: null, seed: null, composedPositive: null, composedNegative: null, userPrompt: `vitesse retouchée (${resume})`, userDirectives: null,
        selections: null, resolvedText: null, identityPreamble: null, registerClause: null, sourceImage: null, extraLoras: null,
        injections: { applied: [`vitesse retouchée par segments (ffmpeg setpts/atempo) depuis ${a.id} : ${resume}`], skipped: [] }, workflowJson: null })
    store.markFinished(jobId, 0)
    return { jobId, assetId: `a-${jobId}-0` }
  } catch (e) { reply.code(400); return { error: String(e.stderr || e.message || e).slice(-300) } }
})

/** Voice changer (see voix.changerVoix): a library audio, or a clip's track, which becomes a
    new clip with the changed voice. Owner only. */
app.post('/api/voix/changer', async (req, reply) => {
  const b = req.body ?? {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voix-'))
  try {
    const opts = { voix: b.voix, reference: b.reference, accord: b.accord === true }
    if (!b.assetId) {
      const source = path.join(montage.MUSIQUES_DIR, path.basename(String(b.audio ?? '')))
      const { nom } = await changerVoix({ source, ...opts })
      return { nom }
    }
    const a = store.getAsset(String(b.assetId))
    if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'clip inconnu' } }
    const video = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
    const piste = path.join(tmp, 'piste.wav')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '24000', piste])
    const { nom, chemin } = await changerVoix({ source: piste, ...opts })
    const jobId = `voix-${Date.now().toString(36)}`, sortie = `${jobId}-0.mp4`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', chemin, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', path.join(CONFIG.mediaDir, sortie)])
    store.createJob({ id: jobId, createdAt: Date.now(), status: 'rendering', personaId: a.persona_id ?? null, register: 'sfw', mode: 'video', purpose: 'creative',
      recipeId: 'voix@v1', workflowFile: null, seed: null, op: 'voix', videoEngine: null, userPrompt: 'voix changée', composedPositive: null, parentAssetId: a.id, estimatedMs: 30_000 })
    store.markStarted(jobId, null)
    store.createAsset(
      { id: `a-${jobId}-0`, jobId, createdAt: Date.now(), mediaType: 'video', uri: `/media/${sortie}`, filename: sortie, bytes: fs.statSync(path.join(CONFIG.mediaDir, sortie)).size,
        width: a.width ?? null, height: a.height ?? null, aspect: a.aspect ?? null, register: 'sfw', op: 'voix', videoEngine: null },
      { recipeId: 'voix@v1', workflowFile: null, comfyPromptId: null, seed: null, composedPositive: null, composedNegative: null, userPrompt: 'voix changée', userDirectives: null,
        selections: null, resolvedText: null, identityPreamble: null, registerClause: null, sourceImage: null, extraLoras: null,
        injections: { applied: [`voix changée par Chatterbox VC (${b.reference ? 'extrait déclaré consenti' : `voix du studio ${b.voix}`}), image du clip ${a.id} copiée sans réencodage`], skipped: [] }, workflowJson: null })
    store.markFinished(jobId, 0)
    fs.rmSync(chemin, { force: true })
    return { jobId, assetId: `a-${jobId}-0`, nom }
  } catch (e) { reply.code(400); return { error: String(e.stderr || e.message || e).slice(-300) } }
  finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

app.get('/api/voix/:id/echantillon', async (req, reply) => {
  try {
    const f = await echantillon(req.params.id)
    reply.header('Cache-Control', 'public, max-age=86400').type('audio/wav')
    return fs.createReadStream(f)
  } catch (e) { reply.code(404); return { error: String(e.message || e).slice(-200) } }
})
app.post('/api/voix', async (req, reply) => {
  try { return await synthetiser({ texte: req.body?.texte, voix: req.body?.voix, vitesse: req.body?.vitesse }) }
  catch (e) { reply.code(400); return { error: String(e.stderr || e.message || e).slice(-300) } }
})

/** Extensions (see extensions.js): shipped ones can be run by anyone; installing and
    installed extensions are owner only. */
/** ComfyUI and third-party node upgrades (see noeudsComfy.js): owner only;
    the public demo refuses any third-party code. */
app.get('/api/comfy/maj', async () => ({ demo: noeudsComfy.estDemo(), messageDemo: noeudsComfy.MESSAGE_DEMO, travaux: noeudsComfy.etat() }))
app.post('/api/comfy/maj', async (req, reply) => {
  try { return await noeudsComfy.mettreAJourComfy() } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/comfy/noeuds/chercher', async req => noeudsComfy.depotsPour((Array.isArray(req.body?.classes) ? req.body.classes : []).map(String).slice(0, 40)))
app.post('/api/comfy/noeuds', async (req, reply) => {
  try { return await noeudsComfy.installerDepot(req.body?.depot) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/comfy/redemarrer', async (req, reply) => {
  try { return await noeudsComfy.redemarrerComfy(queueDepth() === 0) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Official ComfyUI workflows (see workflowsComfy.js): list and thumbnails for everyone,
    model download for the owner. */
app.get('/api/workflows-comfy', async (req, reply) => {
  try { return { workflows: await workflowsComfy.lister() } } catch (e) { reply.code(502); return { error: String(e.message || e) } }
})
app.get('/api/workflows-comfy/vignette/:nom', async (req, reply) => {
  const f = workflowsComfy.vignette(String(req.params.nom))
  if (!f) { reply.code(404); return { error: 'miniature introuvable' } }
  const types = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg' }
  reply.header('Cache-Control', 'public, max-age=86400')
  return reply.type(types[path.extname(f).slice(1)] ?? 'application/octet-stream').send(fs.createReadStream(f))
})
app.post('/api/workflows-comfy/:id/telecharger', async (req, reply) => {
  try { return await workflowsComfy.telecharger(String(req.params.id)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
/* Open a catalog workflow in the studio: its form (everyone), its launch (owner). */
app.get('/api/workflows-comfy/:id/formulaire', async (req, reply) => {
  try { return await workflowsComfy.formulaire(String(req.params.id)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/workflows-comfy/:id/lancer', async (req, reply) => {
  try { return await workflowsComfy.lancer(String(req.params.id), { valeurs: req.body?.valeurs, personaId: personaDe(req) }) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

app.get('/api/extensions', async () => ({ extensions: await extensions.lister(), catalogue: extensions.catalogue() }))
app.post('/api/extensions/:id/installer', async (req, reply) => {
  try { return await extensions.installer(String(req.params.id)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/extensions/:id/retirer', async (req, reply) => {
  try { return extensions.retirer(String(req.params.id)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/extensions/:id/lancer', async (req, reply) => {
  try {
    return await deposerAvecCle(cleComfy(req), () => extensions.lancer({ id: String(req.params.id), valeurs: req.body?.valeurs, proprietaire: estProprietaire(req), personaId: personaDe(req) }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Clip analysis for social networks (see vision.analyserClip): an estimate, not a prediction. */
app.post('/api/assets/:id/analyse', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'clip inconnu' } }
  try { return await analyserClip(path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri)), req.body?.langue === 'en' ? 'en' : 'fr') }
  catch (e) { reply.code(502); return { error: String(e.message || e) } }
})

/** Ad pack (see packPub.js): a library photo, an upload (owner on the demo) or a plain
    product description, then the desired staging with the character. */
const lancerPackDepuis = (req, reply, asset) => {
  if (personnageInterdit(req, personaDe(req))) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  const b = req.body ?? {}
  const admis = n => (estProprietaire(req) ? store.estInputStudio(n) : store.estInputVisiteur(n))
  try {
    return deposerAvecCle(cleComfy(req), () => lancerPack({ asset, fichier: asset ? null : b.fichier, description: asset ? null : b.description, produit: b.produit,
      accroche: b.accroche, scene: b.scene, format: b.format, personaId: personaDe(req), admis }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
}
app.post('/api/assets/:id/pack-pub', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'photo') { reply.code(404); return { error: 'photo inconnue' } }
  return lancerPackDepuis(req, reply, a)
})
app.post('/api/pack-pub', async (req, reply) => {
  const id = req.body?.assetId
  const a = id ? store.getAsset(String(id)) : null
  if (id && (!a || a.media_type !== 'photo')) { reply.code(404); return { error: 'photo inconnue' } }
  return lancerPackDepuis(req, reply, a)
})
app.get('/api/pack-pub/:id', async (req, reply) => etatPack(req.params.id) ?? (reply.code(404), { error: 'pack inconnu' }))

/** Sketch to video (see croquis.js). */
app.post('/api/croquis', async (req, reply) => {
  const b = req.body ?? {}
  if (personnageInterdit(req, personaDe(req))) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  try { return deposerAvecCle(cleComfy(req), () => lancerCroquis({ image: b.image, scene: b.scene, mouvement: b.mouvement, format: b.format, secondes: b.secondes, personaId: personaDe(req) })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
/** Restore (see restauration.js): a photo or clip, from the library or uploaded by the owner. */
app.post('/api/restauration', async (req, reply) => {
  const b = req.body ?? {}
  try {
    const media = b.media === 'video' ? 'video' : 'photo'
    let asset = null, fichier = null
    if (b.assetId) {
      asset = store.getAsset(String(b.assetId))
      if (!asset || (media === 'video') !== (asset.media_type === 'video')) { reply.code(404); return { error: media === 'video' ? 'clip inconnu' : 'photo inconnue' } }
      if (media === 'photo') {
        fichier = `crs_still_${path.basename(asset.filename ?? asset.uri)}`
        fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri)), path.join(CONFIG.comfyInput, fichier))
        store.noterInput(fichier)
      }
    } else if (b.fichier) {
      // an uploaded file: only studio ones or, for the owner, their uploads; an uploaded clip, owner only
      const nom = path.basename(String(b.fichier))
      if (media === 'video' ? !/\.(mp4|mov|webm)$/i.test(nom) : !/\.(png|jpe?g|webp)$/i.test(nom)) { reply.code(400); return { error: 'type de fichier inattendu' } }
      if (!estProprietaire(req) && (media === 'video' || !store.estInputVisiteur(nom))) { reply.code(403); return { error: 'sur la démo publique, on part d’un média de la bibliothèque' } }
      if (!fs.existsSync(path.join(CONFIG.comfyInput, nom))) { reply.code(404); return { error: 'fichier introuvable' } }
      fichier = nom
    } else { reply.code(400); return { error: media === 'video' ? 'choisis un clip de la bibliothèque' : 'choisis une photo' } }
    return deposerAvecCle(cleComfy(req), () => lancerRestauration({ media, fichier, asset, nettoyer: b.nettoyer !== false, couleur: b.couleur === true, hd: b.hd !== false, stabilite: b.stabilite === true }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/restauration/:id', async (req, reply) => etatRestauration(req.params.id) ?? (reply.code(404), { error: 'restauration inconnue' }))
app.get('/api/croquis/:id', async (req, reply) => etatCroquis(req.params.id) ?? (reply.code(404), { error: 'croquis inconnu' }))
app.post('/api/croquis/:id/choisir', async (req, reply) => {
  try { return choisirCroquis(req.params.id, req.body?.assetId) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Video reframe to another aspect, invented edges (see enqueueRecadrage). */
app.post('/api/assets/:id/recadrer', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'clip inconnu' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier vidéo introuvable' } }
  try {
    // without instruction: the source clip's setting, extended to the sides
    const prov = store.getProvenance(a.id)
    const orig = String(prov?.user_prompt || prov?.composed_positive || '').trim().slice(0, 300)
    const prompt = String(req.body?.prompt ?? '').trim() || (orig ? `${orig}, wide view, the same place continues naturally on every side, same light, coherent perspective, no frame, no border` : undefined)
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueRecadrage({ source: src, format: String(req.body?.format ?? ''), prompt, parentAssetId: a.id, personaId: a.persona_id }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

app.post('/api/stage/glb', async (req, reply) => {
  const b = req.body
  if (!Buffer.isBuffer(b) || b.subarray(0, 4).toString('latin1') !== 'glTF') { reply.code(415); return { error: 'fichier .glb attendu' } }
  const racine = String(req.query?.name ?? 'modele').replace(/\.[^.]*$/, '').normalize('NFD').replace(/[^\w-]+/g, '_').slice(0, 40) || 'modele'
  const d = path.join(CONFIG.mediaDir, '.stage'), nom = `imp_${Date.now().toString(36)}_${racine}.glb`
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, nom), b)
  return { nom }
})

/** 3D object: a photo becomes a GLB (see enqueueObjet3d). */
app.post('/api/assets/:id/objet3d', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type === 'video') { reply.code(404); return { error: 'photo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  try {
    const entree = `OBJ3D_${Date.now().toString(36)}${path.extname(src) || '.png'}`
    fs.copyFileSync(src, path.join(CONFIG.comfyInput, entree))
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueObjet3d({ sourceFile: entree, cible: req.body?.cible, parentAssetId: a.id, personaId: a.persona_id }))
    return { jobId: id }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Generated music or sound effect: joins the edit's music (see enqueueMusique). */
app.post('/api/musique', async (req, reply) => {
  try {
    const b = req.body ?? {}
    // optional settings (tempo, key, time signature, language, sung voice, instruments): validated by enqueueMusique
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueMusique({ prompt: b.prompt, paroles: b.paroles, secondes: b.secondes, genre: b.genre,
      bpm: b.bpm, tonalite: b.tonalite, mesure: b.mesure, langue: b.langue, voix: b.voix, instruments: b.instruments }))
    return { jobId: id }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Clip master: POST starts it, GET gives its state, ?dl=1 downloads it (see master.js). */
const fichierClip = a => path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
app.post('/api/assets/:id/master', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'vidéo inconnue' } }
  try { const { etat, erreur } = master(a.id, fichierClip(a), String(req.body?.format ?? '')); return { etat, erreur } }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/assets/:id/master/:format', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'vidéo inconnue' } }
  try {
    const r = master(a.id, fichierClip(a), req.params.format, false)
    if (req.query.dl !== '1') return { etat: r.etat, erreur: r.erreur }
    if (r.etat !== 'pret') { reply.code(409); return { error: 'master pas encore prêt' } }
    reply.header('Content-Disposition', `attachment; filename="${path.basename(r.fichier)}"`)
    reply.type('application/octet-stream')
    return fs.createReadStream(r.fichier)
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Depth map of the photo (see enqueueProfondeur). */
app.post('/api/assets/:id/profondeur', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type === 'video') { reply.code(404); return { error: 'photo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  try {
    const entree = `DEPTH_${Date.now().toString(36)}${path.extname(src) || '.png'}`
    fs.copyFileSync(src, path.join(CONFIG.comfyInput, entree))
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueProfondeur({ sourceFile: entree, parentAssetId: a.id, personaId: a.persona_id }))
    return { jobId: id }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})
/** Transparent background: the photo comes out as PNG with alpha (see enqueueTransparent). */
app.post('/api/assets/:id/transparent', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type === 'video') { reply.code(404); return { error: 'photo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  try {
    const entree = `TRANSP_${Date.now().toString(36)}${path.extname(src) || '.png'}`
    fs.copyFileSync(src, path.join(CONFIG.comfyInput, entree))
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueTransparent({ sourceFile: entree, parentAssetId: a.id, personaId: a.persona_id, sujet: req.body?.sujet }))
    return { jobId: id }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Prompt-based video edit: `cible` = the element to modify, named in English (SAM3
 *  detects and tracks it over the whole clip); `prompt` = what it should become. */
app.post('/api/assets/:id/edit-video', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'vidéo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier vidéo introuvable' } }
  /* Three ways: modify an element, remove it, or change the background around the person. */
  const mode = ['retirer', 'fond', 'detourer', 'effet'].includes(req.body?.mode) ? req.body.mode : 'modifier'
  let prompt = String(req.body?.prompt ?? '').trim(), cible = String(req.body?.cible ?? '').trim()
  let strength = Number(req.body?.strength)
  if (mode === 'fond') cible = cible || 'person'
  if (mode === 'detourer') {
    try {
      const r = deposerAvecCle(cleComfy(req), () => enqueueDetour({ source: path.basename(src), cible, alpha: req.body?.alpha === true, parentAssetId: a.id, personaId: a.persona_id }))
      return { jobId: r.id }
    } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  /* One-click effects: Lightricks LTX-2.5 IC-LoRA (Refine Details, Day to Night, Unblur, Remove Compression). */
  if (mode === 'effet') {
    try {
      const r = deposerAvecCle(cleComfy(req), () => enqueueEffetLtx({ source: path.basename(src), effet: String(req.body?.effet ?? ''), texte: prompt,
        parentAssetId: a.id, personaId: a.persona_id }))
      return { jobId: r.id }
    } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  /* Remove: LTX-2.5 Clean-Plate IC-LoRA (people, passers-by, vehicles); the set
     is rebuilt behind, original sound kept (see enqueueCleanPlate). */
  if (mode === 'retirer') {
    try {
      const r = deposerAvecCle(cleComfy(req), () => enqueueCleanPlate({ source: path.basename(src), cible: cible || 'people', decor: prompt,
        parentAssetId: a.id, personaId: a.persona_id }))
      return { jobId: r.id }
    } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  if (!cible) { reply.code(400); return { error: 'dis quel élément modifier (ex. « dress »)' } }
  if (mode === 'retirer') {
    // the element disappears: its area is redrawn as set, stronger than a simple edit.
    // The object is not named here: the text encoder ignores negation ("without a cup"
    // attracts a cup); runInpaintVideo puts the object in the negative prompt.
    prompt = `empty surface, the background continues naturally, nothing there, same lighting and colours${prompt ? `, ${prompt}` : ''}`
    if (!Number.isFinite(strength)) strength = 1
  } else if (mode === 'fond') {
    if (!prompt) { reply.code(400); return { error: 'décris le nouveau décor' } }
    prompt = `${prompt}, natural lighting consistent with the person in the foreground`
    if (!Number.isFinite(strength)) strength = 0.9
  } else if (!prompt) { reply.code(400); return { error: 'décris ce que cet élément doit devenir' } }
  const inputName = `EDV_${Date.now().toString(36)}${path.extname(src) || '.mp4'}`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  try {
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaintVideo({ sourceFile: inputName, maskFile: null, parentAssetId: a.id,
      prompt, cible, strength, inverser: mode === 'fond', retirer: mode === 'retirer', epargner: req.body?.epargner }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Clip finishes: sound effect (sound on a silent clip) and smoothness (RIFE x2). */
for (const op of ['foley', 'interpolate']) {
  app.post(`/api/assets/:id/${op}`, async (req, reply) => {
    const a = store.getAsset(req.params.id)
    if (!a) { reply.code(404); return { error: 'asset inconnu' } }
    try { const r = deposerAvecCle(cleComfy(req), () => enqueueFinition({ op, asset: a, prompt: req.body?.prompt })); reply.code(202); return r }
    catch (e) { reply.code(400); return { error: String(e.message || e) } }
  })
}

/** SeedVR2 sharpness: any clip goes up to 1080 on the short side (see enqueueSeedvr). */
app.post('/api/assets/:id/seedvr', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'vidéo inconnue' } }
  try { const r = deposerAvecCle(cleComfy(req), () => enqueueSeedvr({ source: path.basename(a.filename ?? a.uri), parentAssetId: a.id, personaId: a.persona_id })); return { jobId: r.id } }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
/** Next beat: the text of the next moment; the edit then goes through /api/jobs, with its filters. */
app.post('/api/assets/:id/moment-suivant', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type === 'video') { reply.code(404); return { error: 'photo inconnue' } }
  try {
    const texte = await momentSuivant(path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri)))
    if (!texte || t0Hit(texte)) { reply.code(422); return { error: 'pas de suite proposée pour cette image' } }
    return { texte }
  } catch (e) { reply.code(502); return { error: String(e.message || e) } }
})

app.post('/api/assets/:id/upscale', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a) { reply.code(404); return { error: 'asset inconnu' } }
  if (a.media_type !== 'video') { reply.code(400); return { error: 'upscale : vidéos seulement' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier vidéo introuvable' } }
  // target x1.5, multiples of 16, capped at 1280 on the long side
  const r16 = v => Math.max(16, Math.round(v / 16) * 16)
  let w = r16((a.width || 544) * 1.5), h = r16((a.height || 800) * 1.5)
  const cap = 1280 / Math.max(w, h)
  if (cap < 1) { w = r16(w * cap); h = r16(h * cap) }
  /* Native LATENT H3 path (higher quality): minimax parent whose pass 1 is
     REPLAYABLE (workflowJson in provenance and input still still in input/).
     Otherwise: Wan refine (universal fallback). */
  /* H3 path disabled by default: on high-motion scenes (waves, water), the
     latent upscaler streaks high frequencies over the WHOLE clip. Can be
     enabled case by case: POST ...?path=h3 */
  let h3 = false
  if (req.query?.path === 'h3' && /^minimax/.test(a.video_engine ?? '')) {
    try {
      const prov = store.getProvenance(a.id)
      const gj = prov?.workflow_json ? JSON.parse(prov.workflow_json) : null
      if (gj && Object.values(gj).some(n => n.class_type === 'SamplerCustomAdvanced')) {
        const loadImg = Object.values(gj).find(n => n.class_type === 'LoadImage')
        const stillOk = !loadImg || fs.existsSync(path.join(CONFIG.comfyInput, String(loadImg.inputs.image)))
        h3 = stillOk
      }
    } catch { /* unreadable provenance: Wan fallback */ }
  }
  const inputName = `UPSC_${Date.now().toString(36)}.mp4`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  /* ACTUAL source frame rate, so a 30 fps draft is not decimated. */
  let fps = 16
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src], { encoding: 'utf8' })
    const [n, d] = out.trim().split('/').map(Number)
    if (n && d) fps = Math.round(n / d)
  } catch { /* no ffprobe: 16 by default */ }
  // H3: fixed 2x output of the draft dims (2x latent), otherwise Wan target x1.5
  if (h3) { w = (a.width || 544) * 2; h = (a.height || 800) * 2 }
  const { id } = deposerAvecCle(cleComfy(req), () => enqueueUpscale({
    sourceFile: inputName, width: w, height: h, fps,
    videoEngine: a.video_engine ?? null,
    parentAssetId: a.id, sourceLabel: `#${a.job_id}`, h3,
  }))
  return { jobId: id, width: w, height: h, path: h3 ? 'latent-h3' : 'refine-wan' }
})

/* ---------- folders ---------- */
/* Like the library: folders of the ACTIVE character (?persona=<id> for another). */
const personaDe = req => String(req.query?.persona ?? '') || decodeURIComponent(String(req.headers['x-personnage'] ?? '')) || personas().active || null
/** Without a character, the preamble keeps the adult-age mention (persona.js): open to all, visitors included. */
const personnageInterdit = () => false
// the owner sees all folders, shared across characters; a visitor, those of their character
app.get('/api/folders', async req => ({ folders: store.listFolders(estProprietaire(req) ? undefined : personaDe(req))
  .map(f => ({ id: f.id, name: f.name, createdAt: f.created_at, count: f.count, personaId: f.persona_id ?? null })) }))
app.post('/api/folders', async (req, reply) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) { reply.code(400); return { error: 'nom requis' } }
  // owner folders are shared across all characters
  const f = store.createFolder(name, estProprietaire(req) ? null : personaDe(req))
  return { id: f.id, name: f.name }
})
app.patch('/api/folders/:id', async (req, reply) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) { reply.code(400); return { error: 'nom requis' } }
  if (!store.renameFolder(req.params.id, name)) { reply.code(404); return { error: 'dossier inconnu' } }
  return { ok: true }
})
app.delete('/api/folders/:id', async (req, reply) => {
  if (!store.deleteFolder(req.params.id)) { reply.code(404); return { error: 'dossier inconnu' } }
  return { ok: true }
})
/* ---------- edit (mini reel editor, see montage.js) ---------- */
app.addContentTypeParser(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/flac', 'audio/webm'],
  { parseAs: 'buffer' }, (req, body, done) => done(null, body))
app.get('/api/montages', async req => ({ montages: montage.listerProjets(personaDe(req)), formats: Object.keys(montage.FORMATS) }))
app.post('/api/montages', async req => montage.creerProjet(req.body?.nom, personaDe(req)))
app.get('/api/montages/:id', async (req, reply) => montage.lireProjet(req.params.id) ?? (reply.code(404), { error: 'montage inconnu' }))
app.put('/api/montages/:id', async (req, reply) => {
  const p = montage.ecrireProjet(req.params.id, { nom: req.body?.nom, data: req.body?.data })
  if (!p) { reply.code(404); return { error: 'montage inconnu' } }
  return p
})
app.delete('/api/montages/:id', async (req, reply) => montage.supprimerProjet(req.params.id) ? { ok: true } : (reply.code(404), { error: 'montage inconnu' }))
app.post('/api/montages/:id/export', async (req, reply) => {
  const p = montage.lireProjet(req.params.id)
  if (!p) { reply.code(404); return { error: 'montage inconnu' } }
  try { return montage.exporter(p) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/montages/rendu/:jobId', async req => ({ progression: montage.progressionDe(req.params.jobId) ?? null }))
/* ---------- one-click presets: camera and effects (see presets.js) ---------- */
app.get('/api/presets', async () => ({ presets: presets.listerPresets() }))
app.get('/api/presets/:id/apercu', async (req, reply) => {
  const f = presets.cheminApercu(req.params.id)
  if (!f) { reply.code(404); return { error: 'pas d’aperçu' } }
  reply.type('video/mp4').header('Cache-Control', 'public, max-age=3600')
  return fs.createReadStream(f)
})
app.post('/api/presets/:id/lancer', async (req, reply) => {
  try { const { id } = deposerAvecCle(cleComfy(req), () => presets.lancerAvecCle(cleComfy(req), { ...(req.body ?? {}), presetId: req.params.id })); return { jobId: id } }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* ---------- talking avatar (see jobs.js enqueueParole) ----------
   The voice is placed in input/ (LoadAudio only reads there) and registered
   in the studio upload registry, like a photo. */
const TYPES_VOIX = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/flac': '.flac' }
app.post('/api/parole/voix', async (req, reply) => {
  const ext = TYPES_VOIX[String(req.headers['content-type']).split(';')[0]]
  if (!ext) { reply.code(415); return { error: 'type non accepté (mp3, m4a, wav, ogg, webm, flac)' } }
  if (!Buffer.isBuffer(req.body) || !req.body.length) { reply.code(400); return { error: 'corps vide' } }
  if (req.body.length > 30 * 1024 * 1024) { reply.code(413); return { error: 'fichier > 30 Mio' } }
  const nom = `crs_voix_${Date.now().toString(36)}${ext}`
  fs.writeFileSync(path.join(CONFIG.comfyInput, nom), req.body)
  store.noterInput(nom, 'voix')
  let duree = 0
  try { duree = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(CONFIG.comfyInput, nom)], { encoding: 'utf8' }).trim()) || 0 } catch { /* unreadable */ }
  if (!duree) { fs.rmSync(path.join(CONFIG.comfyInput, nom), { force: true }); reply.code(422); return { error: 'audio illisible' } }
  return { fichier: nom, duree }
})
app.post('/api/parole', async (req, reply) => {
  const a = store.getAsset(String(req.body?.assetId ?? ''))
  if (!a || a.media_type !== 'photo' || !a.filename) { reply.code(400); return { error: 'choisis une photo de la bibliothèque' } }
  const voix = String(req.body?.voix ?? '')
  if (!store.estInputStudio(voix)) { reply.code(400); return { error: 'dépose d’abord une voix' } }
  const image = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, image))
  store.noterInput(image)
  try { return deposerAvecCle(cleComfy(req), () => enqueueParole({ image, audio: voix, texte: req.body?.texte, parentAssetId: a.id, personaId: a.persona_id, moteur: req.body?.moteur === 'h3' ? 'h3' : 'ltx' })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* ---------- try-on and photodump (see jobs.js) ----------
   Library photos are copied into input/ (LoadImage only reads there). */
const versInput = (a, prefixe) => {
  const nom = `${prefixe}_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}
const photoDe = id => { const a = store.getAsset(String(id ?? '')); return a && a.media_type === 'photo' && a.filename ? a : null }
app.post('/api/assets/:id/essayage', async (req, reply) => {
  const a = photoDe(req.params.id), v = photoDe(req.body?.vetementId)
  if (!a) { reply.code(400); return { error: 'choisis la photo de la personne' } }
  if (!v) { reply.code(400); return { error: 'choisis la photo du vêtement' } }
  try { return deposerAvecCle(cleComfy(req), () => enqueueEssayage({ personne: versInput(a, 'crs_still'), vetement: versInput(v, 'crs_vetement'),
    parentAssetId: a.id, personaId: a.persona_id, consigne: typeof req.body?.consigne === 'string' ? req.body.consigne : undefined })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/assets/:id/photodump', async (req, reply) => {
  const a = photoDe(req.params.id)
  if (!a) { reply.code(400); return { error: 'choisis une photo de la bibliothèque' } }
  try { return deposerAvecCle(cleComfy(req), () => enqueuePhotodump({ personne: versInput(a, 'crs_still'), parentAssetId: a.id, personaId: a.persona_id,
    theme: typeof req.body?.theme === 'string' ? req.body.theme : undefined })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

app.post('/api/assets/:id/style-reference', async (req, reply) => {
  const a = photoDe(req.params.id)
  if (!a) { reply.code(400); return { error: 'choisis l’image dont il faut prendre le style' } }
  try { return deposerAvecCle(cleComfy(req), () => enqueueStyleRef({ reference: versInput(a, 'crs_style'), texte: req.body?.texte,
    format: String(req.body?.format ?? '16:9'), parentAssetId: a.id, personaId: a.persona_id })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* ---------- re-shoot: the same shot, from another angle (see jobs.js) ---------- */
app.post('/api/reshoot', async (req, reply) => {
  const a = store.getAsset(String(req.body?.assetId ?? ''))
  if (!a || a.media_type !== 'video' || !a.filename) { reply.code(400); return { error: 'choisis un clip de la bibliothèque' } }
  try {
    return deposerAvecCle(cleComfy(req), () => enqueueReshoot({ source: path.basename(a.filename), angle: String(req.body?.angle ?? ''),
      azimut: req.body?.azimut, elevation: req.body?.elevation, cles: req.body?.cles, texte: req.body?.texte, parentAssetId: a.id, personaId: a.persona_id }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* 3D scene of the clip (Re-shoot view): computed once, then served from cache */
app.post('/api/reshoot/scene', async (req, reply) => {
  const a = store.getAsset(String(req.body?.assetId ?? ''))
  if (!a || a.media_type !== 'video' || !a.filename) { reply.code(400); return { error: 'choisis un clip de la bibliothèque' } }
  try { await sceneReshoot(path.basename(a.filename)); return { url: `/api/reshoot/scene/${encodeURIComponent(a.id)}.glb` } }
  catch (e) { reply.code(500); return { error: String(e.message || e) } }
})
app.get('/api/reshoot/scene/:fichier', async (req, reply) => {
  const a = store.getAsset(String(req.params.fichier).replace(/\.glb$/, ''))
  const f = a?.filename && path.join(CONFIG.dataDir, 'reshoot_scenes', `${path.basename(a.filename)}.glb`)
  if (!f || !fs.existsSync(f)) { reply.code(404); return { error: 'scène inconnue' } }
  reply.header('Content-Type', 'model/gltf-binary').header('Cache-Control', 'private, max-age=86400')
  return fs.readFileSync(f)
})

/* ---------- one-click reel (see reel.js) ---------- */
const reelOut = r => r && {
  ...r,
  plans: (r.plans ?? []).map(p => {
    const photo = p.photoAsset ? store.getAsset(p.photoAsset) : null, clip = p.clipAsset ? store.getAsset(p.clipAsset) : null
    const etat = j => j ? store.getJob(j)?.status ?? 'absent' : null
    /* clip rendered then deleted from the library: the shot is dropped, its
       photo is not reused (the operator discarded it) */
    return { ...p, photoUri: photo?.uri ?? null, clipUri: clip?.uri ?? null, photoEtat: etat(p.photoJob), clipEtat: etat(p.clipJob),
      supprime: !!p.clipAsset && !clip }
  }),
  reelUri: r.reelAsset ? store.getAsset(r.reelAsset)?.uri ?? null : null,
}
app.get('/api/reels', async req => ({ reels: reel.listerReels(personaDe(req)).map(reelOut) }))
app.get('/api/reels/:id', async (req, reply) => reelOut(reel.lireReel(req.params.id)) ?? (reply.code(404), { error: 'reel inconnu' }))
app.post('/api/reels/:id/plans/:k/refaire', async (req, reply) => {
  try { return reelOut(reel.refairePlan(req.params.id, req.params.k, req.body?.motion)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.delete('/api/reels/:id', async (req, reply) => (await reel.supprimerReel(req.params.id)) ? { ok: true } : (reply.code(404), { error: 'reel inconnu' }))
app.post('/api/reels/:id/annuler', async (req, reply) => reelOut(await reel.annulerReel(req.params.id)) ?? (reply.code(404), { error: 'reel inconnu' }))
app.get('/api/reels/presets', async () => ({ presets: reelPresets.listePresets() }))
// dance catalog: motion videos of a mannequin, chosen by the visitor
app.get('/api/danses', async () => ({ danses: danses.listeDanses(), studios: Object.entries(STUDIOS_DANSE).map(([id, s]) => ({ id, nom: s.nom, v: danses.versionStudio(id) })) }))
/* 3D-staged dance: the dance in a studio with a following camera (LTX Layout-to-Render), then Swap redraws the dancer from the photo. */
app.post('/api/danses/scene3d', async (req, reply) => {
  if (personnageInterdit(req, personaDe(req))) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  const a = store.getAsset(String(req.body?.assetId ?? ''))
  if (!a || a.media_type !== 'photo') { reply.code(400); return { error: 'photo inconnue' } }
  const fbx = danses.fbxDe(String(req.body?.slug ?? ''))
  if (!fbx) { reply.code(400); return { error: 'danse inconnue' } }
  try {
    const still = `crs_still_${path.basename(a.filename)}`
    fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, still))
    store.noterInput(still)
    return enqueueDanse3d({ fbx, still, decor: req.body?.decor, scene: req.body?.scene, personaId: a.persona_id, suivi: req.body?.suivi === true,
      stageForce: estProprietaire(req) && Number.isFinite(Number(req.body?.stageForce)) ? Number(req.body.stageForce) : undefined,
      secondes: estProprietaire(req) && Number.isFinite(Number(req.body?.secondes)) ? Number(req.body.secondes) : undefined,
      debut: estProprietaire(req) && req.body?.debut === true,
      sansSwap: estProprietaire(req) && req.body?.sansSwap === true })
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
// the reviewed and corrected storyboard goes to shooting
app.post('/api/reels/:id/tourner', async (req, reply) => {
  try { return reelOut(reelPresets.tournerStoryboard(req.params.id, req.body?.cases)) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/reels', async (req, reply) => {
  if (personnageInterdit(req, personaDe(req))) { reply.code(403); return { error: 'réservé au propriétaire du studio' } }
  // a preset (outfit jump...): the structure is held by the code, the LLM fills the cells
  if (req.body?.preset && reelPresets.PRESETS_LIBRES[req.body.preset]) {
    const corps = { brief: req.body.brief || reelPresets.PRESETS_LIBRES[req.body.preset].exemple, n: 5, duree: 4, langue: req.body.langue, ecriture: 2, format: req.body.preset }
    try { return reelOut(reel.realiser({ ...corps, personaId: personaDe(req), cle: cleComfy(req), proprietaire: estProprietaire(req) })) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  if (req.body?.preset) {
    try { return reelOut(reelPresets.lancerPreset({ presetId: String(req.body.preset), brief: req.body.brief, langue: req.body.langue, personaId: personaDe(req), cle: cleComfy(req), relire: req.body.relire === true })) }
    catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  // "perso": the voice saved on the character sheet
  const corps = { ...(req.body ?? {}) }
  if (corps.voix === 'perso') corps.voix = persona(personaDe(req)).voix ?? null
  try { return reelOut(reel.realiser({ ...corps, personaId: personaDe(req), cle: cleComfy(req), proprietaire: estProprietaire(req) })) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/montage/musiques', async () => ({ musiques: montage.listerMusiques() }))
/* Generated transition between two edit shots (LTX-2.5, first and last frame, with sound): the edge
   frames respect the shots' cut and reframing and the edit's aspect. Effect list: GET. */
app.get('/api/montage/transition', async () => ({ effets: Object.entries(EFFETS_TRANSITION).map(([id, e]) => ({ id, nom: e.nom })), secondes: [3, 5, 8, 10] }))
app.post('/api/montage/transition', async (req, reply) => {
  const b = req.body ?? {}
  try {
    const { debut, fin, format } = montage.cadresTransition({ format: b.format, a: b.a, b: b.b })
    const a = store.getAsset(String(b.a?.assetId ?? ''))
    return deposerAvecCle(cleComfy(req), () => enqueueTransition({ debut, fin, effet: String(b.effet ?? 'fondu'), secondes: b.secondes, format, personaId: a?.persona_id, parentAssetId: a?.id }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
/* ---------- Directed long take (planlong.js, jobs.js) ----------
   A take = a photo, a number of windows, one prompt per window. Each action queues a render;
   the page re-reads the take to follow progress. */
const vuePrise = async p => {
  const j = p.jobActif ? store.getJob(p.jobActif) : null
  let charge = null
  try { charge = JSON.parse(j?.payload || 'null') } catch { /* unreadable payload */ }
  const actif = j && !['done', 'failed', 'blocked', 'cancelled'].includes(j.status)
    ? { id: j.id, statut: j.status, action: charge?.planAction ?? null, fenetre: charge?.planFenetre ?? null } : null
  let etat = p.etat
  if (!actif) { try { etat = await planlong.etatDirector(p.id) } catch { /* ComfyUI unreachable: last known state */ } }
  return { ...p, jobActif: actif, etat, secondes: planlong.secondesPour(p.fenetres), source: p.sourceAssetId ? (store.getAsset(p.sourceAssetId)?.uri ?? null) : null }
}
app.get('/api/planlong', async () => {
  const h3 = await etatH3().catch(() => ({ disponible: false }))
  const pack = h3.disponible ? await planlong.packInstalle() : false
  return {
    disponible: !!h3.disponible && pack,
    raison: demoPublique() ? H3_MESSAGE_DEMO : !h3.disponible ? 'MiniMax H3 n’est pas installé sur ce studio : Paramètres > Modèles optionnels'
      : !pack ? 'Le pack de nœuds « Geiru Context Suite » n’est pas installé dans ComfyUI (custom_nodes).' : null,
    depotPack: 'https://github.com/roycho87/geiru_context_suite',
    formats: Object.keys(planlong.PLAN_LONG.formats),
    durees: Array.from({ length: planlong.PLAN_LONG.fenetresMax - planlong.PLAN_LONG.fenetresMin + 1 }, (_, i) => {
      const n = planlong.PLAN_LONG.fenetresMin + i
      return { fenetres: n, secondes: Math.round(planlong.secondesPour(n) * 10) / 10 }
    }),
    prises: await Promise.all(planlong.listerPrises().slice(0, 30).map(vuePrise)),
  }
})
const promptsPlan = (bruts, n) => {
  const liste = (Array.isArray(bruts) ? bruts : []).map(x => String(x ?? '').trim().slice(0, 4000))
  if (!liste[0]) throw new Error('écris au moins le prompt de la première fenêtre')
  const pleins = Array.from({ length: n }, (_, i) => liste[i] || liste.slice(0, i).reverse().find(Boolean) || liste[0])
  for (const t of pleins) if (t0Hit(t)) throw new Error('prompt refusé (liste T0)')
  return pleins
}
app.post('/api/planlong', async (req, reply) => {
  const b = req.body ?? {}
  const a = store.getAsset(String(b.assetId ?? ''))
  if (!a || a.media_type !== 'photo' || !a.filename) { reply.code(400); return { error: 'choisis une photo de la bibliothèque' } }
  const n = Math.round(Number(b.fenetres))
  if (!(n >= planlong.PLAN_LONG.fenetresMin && n <= planlong.PLAN_LONG.fenetresMax)) { reply.code(400); return { error: 'nombre de fenêtres hors limites' } }
  const format = planlong.PLAN_LONG.formats[b.format] ? b.format : '9:16'
  try {
    const prompts = promptsPlan(b.prompts, n)
    const prise = planlong.creerPrise({ image: versInput(a, 'crs_still'), sourceAssetId: a.id, personaId: a.persona_id, fenetres: n, format, prompts })
    prise.auto = b.auto === true
    planlong.ecrirePrise(prise)
    try {
      const job = deposerAvecCle(cleComfy(req), () => enqueuePlanLong({ id: prise.id, action: 'reroll' }))
      return { id: prise.id, job: job.id }
    } catch (e) { planlong.supprimerPrise(prise.id); throw e }   // no orphan take if the render is refused
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/planlong/:id', async (req, reply) => {
  const p = planlong.lirePrise(req.params.id)
  if (!p) { reply.code(404); return { error: 'prise introuvable' } }
  return vuePrise(p)
})
app.post('/api/planlong/:id/action', async (req, reply) => {
  const p = planlong.lirePrise(req.params.id)
  if (!p) { reply.code(404); return { error: 'prise introuvable' } }
  const b = req.body ?? {}
  try {
    // a window's prompt may change before it is re-rolled
    if (Array.isArray(b.prompts)) p.prompts = promptsPlan(b.prompts, p.fenetres)
    if (typeof b.auto === 'boolean') p.auto = b.auto
    planlong.ecrirePrise(p)
    const job = deposerAvecCle(cleComfy(req), () => enqueuePlanLong({ id: p.id, action: String(b.action ?? ''), fenetre: b.fenetre }))
    return { job: job.id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.post('/api/planlong/:id/arret', async (req, reply) => {
  const p = planlong.lirePrise(req.params.id)
  if (!p) { reply.code(404); return { error: 'prise introuvable' } }
  p.auto = false
  planlong.ecrirePrise(p)
  return { ok: true }
})
app.delete('/api/planlong/:id', async (req, reply) => {
  const p = planlong.lirePrise(req.params.id)
  if (!p) { reply.code(404); return { error: 'prise introuvable' } }
  const j = p.jobActif ? store.getJob(p.jobActif) : null
  if (j && !['done', 'failed', 'blocked', 'cancelled'].includes(j.status)) { reply.code(409); return { error: 'un rendu de cette prise est en cours : annule-le d’abord' } }
  await planlong.viderDirector(p.id)
  planlong.supprimerPrise(p.id)
  return { ok: true }
})
app.post('/api/montage/musiques', async (req, reply) => {
  if (Buffer.isBuffer(req.body) && req.body.length > 40 * 1024 * 1024) { reply.code(413); return { error: 'fichier > 40 Mio' } }
  try { return montage.deposerMusique(req.headers['content-type'], req.query.name, req.body) }
  catch (e) { reply.code(e.statusCode ?? 400); return { error: String(e.message || e) } }
})
/* Delete a sound (voice, music, sound effect): owner only. A sound used by an edit or reel
   is removed only after confirmation (?confirme=1): their export would lose it. */
app.delete('/api/montage/musiques/:nom', async (req, reply) => {
  const nom = path.basename(String(req.params.nom || ''))
  const usages = store.usagesSon(nom)
  if (usages.length && req.query.confirme !== '1') { reply.code(409); return { error: 'son employé par un montage ou un reel', usages } }
  try { return montage.retirerMusique(nom) }
  catch (e) { reply.code(e.statusCode ?? 400); return { error: String(e.message || e) } }
})
app.get('/api/montage/musiques/:nom', async (req, reply) => {
  const f = montage.cheminMusique(String(req.params.nom || ''))
  if (!f) { reply.code(404); return { error: 'musique inconnue' } }
  reply.type({ '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[path.extname(f)] ?? 'application/octet-stream')
  return fs.createReadStream(f)
})

app.post('/api/folders/:id/assets', async req => {
  const add = Array.isArray(req.body?.add) ? req.body.add : []
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : []
  return store.folderToggle(req.params.id, add, remove)
})

app.patch('/api/assets/:id', async (req, reply) => {
  const { reviewStatus, exportReady, register, caption } = req.body || {}
  if (reviewStatus && !['pending', 'approved', 'rejected'].includes(reviewStatus)) {
    reply.code(400); return { error: 'reviewStatus invalide' }
  }
  // A single register: "sfw" is accepted (no effect), anything else is refused.
  if (register && register !== 'sfw') {
    reply.code(400); return { error: 'registre invalide : seul « sfw » existe' }
  }
  if (reviewStatus) store.setReview(req.params.id, reviewStatus)
  if (exportReady !== undefined) store.setExportReady(req.params.id, exportReady)
  /* Hand-edited caption: the text is kept as is (punctuation, capitals); the
     operator has the last word. */
  if (typeof caption === 'string') store.setCaption(req.params.id, caption.trim().slice(0, 120))
  return { ok: true }
})

/* ---------- reel captions (see server/captions.js) ---------- */
const idsDe = b => (Array.isArray(b?.ids) ? b.ids : []).filter(x => typeof x === 'string')
app.post('/api/captions', async (req, reply) => {
  try { return captions.lancerEcriture(idsDe(req.body), { tout: req.body?.tout === true }) }
  catch (e) { reply.code(409); return { error: String(e.message || e) } }
})
app.get('/api/captions/etat', async () => ({ tache: captions.etat(), prochain: captions.prochainReel() }))
app.post('/api/reels/livrer', async (req, reply) => {
  try {
    const dossier = typeof req.body?.folderId === 'string' ? store.getFolder(req.body.folderId)?.name : null
    return captions.lancerLivraison(idsDe(req.body), { debut: req.body?.debut, dossier: dossier || req.body?.dossier })
  } catch (e) { reply.code(409); return { error: String(e.message || e) } }
})

/* ---------- files ---------- */

fs.mkdirSync(path.join(danses.DOSSIER, 'apercus'), { recursive: true })
await app.register(fastifyStatic, { root: path.join(danses.DOSSIER, 'apercus'), prefix: '/danses/', decorateReply: false, cacheControl: true, maxAge: '1d' })
await app.register(fastifyStatic, {
  root: CONFIG.mediaDir, prefix: '/media/', decorateReply: false,
  cacheControl: true, maxAge: '365d', immutable: true,
})

const hasDist = fs.existsSync(path.join(CONFIG.distDir, 'index.html'))
if (hasDist) {
  // preCompressed: .br/.gz written at build (scripts/precompresser.mjs), served per Accept-Encoding
  /* Browser cache: build files are fingerprinted (immutable for a year); showcase previews
     rarely change (a day); index.html and the rest are revalidated so an update arrives at once. */
  await app.register(fastifyStatic, { root: CONFIG.distDir, prefix: '/', decorateReply: true, preCompressed: true, cacheControl: false,
    setHeaders: (res, chemin) => {
      const rel = path.relative(CONFIG.distDir, chemin).split(path.sep).join('/')
      res.header('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable'
        : rel.startsWith('vitrine/') || rel.startsWith('fonts/') ? 'public, max-age=86400, stale-while-revalidate=604800'
        : 'no-cache')
    } })
  // SPA: any unknown route outside /api returns the index (client-side routing).
  app.setNotFoundHandler((req, reply) => {
    // a missing build file (tab opened before an update): 404, the client reloads the page
    if (req.raw.url.startsWith('/api/') || req.raw.url.startsWith('/media/') || req.raw.url.startsWith('/assets/')) {
      reply.code(404).send({ error: 'introuvable' }); return
    }
    // the index is never cached: it points to the current build's files
    reply.header('Cache-Control', 'no-cache').sendFile('index.html')
  })
} else {
  app.log.warn(`front non compilé (${CONFIG.distDir} absent) — lancer « npm run build »`)
}

/* ---------- startup ---------- */

/* recoverQueue() does both steps in the right order: jobs that died mid-render are marked,
   "queued" ones restart. */

/* Shaping texts: write the MISSING ones, never existing ones. A fresh install
   works without manual copy; an operator edit survives restarts. */
const seeded = prompts.seedPrompts()
if (seeded.length) app.log.info(`textes de façonnage créés : ${seeded.join(', ')}`)

/* The queue survives restarts: "queued" jobs restart, jobs mid-render are
   re-attached (ComfyUI alive) or resubmitted (ComfyUI restarted). Waits for
   ComfyUI before deciding. Does not block HTTP listening: the wait can last
   a full boot. */
void recoverQueue().catch(e => console.error('[reprise]', e.message || e))
// nudity filter: one pass at each job end, and a periodic catch-up pass
demarrerFiltre()
store.surFinJob(() => { void filtrerNouveaux() })
reel.demarrerSuivi(); reelPresets.demarrerSuiviPresets()
setTimeout(() => { try { danses.preparerDanses() } catch (e) { console.warn(`[danses] ${e.message || e}`) } }, 3000)
presets.demarrerSuites()

/* Startup diagnostic, then every 30 min: an environment failure (driver,
   Python, extension, model file) is reported in the log and by the UI
   indicator before a render fails. */
const lancerDiagnostic = (frais = true) => diagnostiquer({ recettes: recettesServies(), frais }).then(d => {
  if (d.problemes.length)
    console.warn(`[diagnostic] ${d.bloquants} bloquant(s), ${d.alertes} alerte(s) : `
      + d.problemes.map(x => `[${x.gravite}] ${x.domaine} — ${x.quoi}`).join(' | '))
  else console.log(`[diagnostic] machine saine (${d.dureeMs} ms)`)
  return d
}).catch(e => console.error('[diagnostic]', e.message || e))
setTimeout(() => void lancerDiagnostic(), 20_000)
setInterval(() => void lancerDiagnostic(), 30 * 60_000).unref()

app.listen({ port: CONFIG.port, host: CONFIG.host })
app.log.info(`front: ${hasDist ? CONFIG.distDir : 'ABSENT'} · médias: ${CONFIG.mediaDir} · db: ${CONFIG.dbFile}`)
app.log.info(`recettes: ${CONFIG.workflowsDir} · textes: ${CONFIG.promptsDir}`)
