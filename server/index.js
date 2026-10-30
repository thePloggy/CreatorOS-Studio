/* ============================================================
   CreatorOS — serveur unique : front compilé + API + médias + DB.
   Un seul process (`npm start`). Il n'écoute que sur la boucle locale
   par défaut (CREATOROS_HOST pour l'ouvrir).
   ============================================================ */
import { etatAllegement } from './allege.js'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import QRCode from 'qrcode'
import { installerVisites } from './visites.js'
import { CONFIG } from './config.js'
import { fetchOllama, blocOllama, etat as etatGpu } from './gpu.js'
import * as store from './db.js'
import { describeOutfit, describeScene, decomposeScene } from './vision.js'
import * as comfy from './comfy.js'
import * as prompts from './prompts.js'
import * as composer from './composer.js'
import * as carrousel from './carrousel.js'
import * as captions from './captions.js'
import { ensurePoster } from './poster.js'
import { T0_BLOCKLIST, t0Hit } from './t0.js'
import { persona, personas, identityPreambleFor, enregistrer as enregistrerPersona, champsFiges, creer as creerPersona, activer as activerPersona, supprimer as supprimerPersona } from './persona.js'
import { lireCreateur, ecrireCreateur } from './createur.js'
import { etatCloud, importerCloud, tacheCloud } from './cloud-loras.js'
import { enqueueParole, enqueueReshoot, enqueueCleanPlate, enqueueDetour, sceneReshoot, deposerAvecCle, enqueue, enqueueParPlans, enqueueInpaint, enqueueInpaintVideo, enqueueUpscale, enqueueFinition, enqueuePhotoHd, cancelJob, promoteJob, reorderQueue, RENDER_RATES, driverMeta, recoverQueue, queueDepth, placeDansFile, RECIPES, VIDEO_ENGINES, recettesServies, DEFAULT_VIDEO_ENGINE, MOTION_RECIPES, DEPRECATED_RECIPES } from './jobs.js'
import { diagnostiquer, figerNoeuds, resumeDiagnostic } from './diagnostic.js'
import * as montage from './montage.js'
import * as reel from './reel.js'
import * as presets from './presets.js'

// 256 Mo : les drivers du Motion Control sont des vidéos (8 Mo suffisaient
// pour les JPEG mais un clip mp4 les dépasse → 413 à l'upload).
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 256 * 1024 * 1024 })

/* ---------- verrou du propriétaire (cf. CONFIG.cleProprietaire) ----------
   Les rendus, la bibliothèque et le montage restent ouverts aux visiteurs ;
   ce qui est verrouillé, c'est la description du studio et ses réglages.
   Choisir le personnage actif reste libre. */
const ROUTES_PROPRIETAIRE = new Set([
  'PUT /api/createur', 'PUT /api/persona', 'POST /api/personas', 'PUT /api/personas/:id',
  'DELETE /api/personas/:id', 'POST /api/persona/lora', 'PUT /api/persona/avatar',
  'PUT /api/persona/avatar/depuis-asset', 'PUT /api/workflows/:file', 'PUT /api/prompts/:file',
  'POST /api/corbeille/vider', 'POST /api/diagnostic/figer', 'GET /api/visites',
  // Démo publique : un visiteur ne part que des images générées par le studio, jamais
  // de la photo d'une personne réelle ; la liste des envois n'est pas publique.
  'POST /api/upload', 'GET /api/uploads', 'POST /api/parole/voix', 'POST /api/montage/musiques',
  'POST /api/telephone', 'GET /api/telephone/:jeton/etat',
])
const estProprietaire = req => {
  if (!CONFIG.cleProprietaire) return true
  const v = Buffer.from(String(req.headers['x-owner-key'] ?? ''))
  const k = Buffer.from(CONFIG.cleProprietaire)
  return v.length === k.length && crypto.timingSafeEqual(v, k)
}
app.addHook('onRequest', async (req, reply) => {
  if (!ROUTES_PROPRIETAIRE.has(`${req.method} ${req.routeOptions?.url}`) || estProprietaire(req)) return
  const envoi = /^POST \/api\/(upload|parole\/voix|montage\/musiques)$/.test(`${req.method} ${req.routeOptions?.url}`)
  reply.code(403).send({ error: envoi
    ? 'sur la démo publique, on part d’une image générée par le studio : l’envoi de fichiers est réservé au propriétaire'
    : 'réservé au propriétaire du studio' })
})
app.post('/api/proprietaire', async req => ({ verrou: !!CONFIG.cleProprietaire, proprietaire: estProprietaire(req) }))
// visiteurs par jour, limite de rendus des visiteurs Internet (cf. visites.js)
const { refuserContenu } = installerVisites(app, { dataDir: CONFIG.dataDir, estProprietaire, avecCle: () => !!CONFIG.cleProprietaire, profondeurFile: () => queueDepth(), lireJob: id => store.getJob(id) })

/* Filtre de contenu sur le texte BRUT de chaque demande (23/10) : avant, le
   contrôle ne portait que sur le prompt réécrit, que le modèle de langue avait
   « adouci », et un terme interdit pouvait passer. Tout texte envoyé à l'API est lu, sauf
   les négatifs (qui nomment justement ce qu'on exclut) et les réglages du
   propriétaire (recettes, textes, personnages). */
const sansFiltreContenu = new Set([...ROUTES_PROPRIETAIRE, 'POST /api/proprietaire'])
function texteInterdit(v, cle = '') {
  if (/negati/i.test(cle)) return null
  if (typeof v === 'string') return t0Hit(v)
  if (Array.isArray(v)) { for (const x of v) { const h = texteInterdit(x, cle); if (h) return h } return null }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const h = texteInterdit(x, k); if (h) return h } }
  return null
}
app.addHook('preHandler', async (req, reply) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return
  const route = `${req.method} ${req.routeOptions?.url}`
  if (!req.url.startsWith('/api/') || sansFiltreContenu.has(route) || Buffer.isBuffer(req.body)) return
  const terme = texteInterdit(req.body) ?? texteInterdit(req.query)
  if (!terme) return
  refuserContenu(terme, route, req)
  return reply.code(400).send({ error: 'demande refusée : ce studio ne produit aucun contenu impliquant un mineur, ni de contenu sexuel' })
})

/* Aucune réponse JSON ne montre le dossier personnel du serveur (chemins des
   recettes, de la base, messages d'erreur de ffmpeg ou de ComfyUI) : il est
   remplacé par « ~ ». */
const MAISON = os.homedir()
app.addHook('onSend', async (req, reply, payload) =>
  typeof payload === 'string' && MAISON.length > 1 && payload.includes(MAISON) ? payload.split(MAISON).join('~') : payload)

/* ---------- projections SQL → contrat front ---------- */

const parse = s => { try { return s == null ? null : JSON.parse(s) } catch { return null } }

const jobOut = r => r && (p => ({
  id: r.id, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  // Estimation faite à l'enqueue (server/jobs.js estimateMs), dans le payload.
  estimatedMs: p?.estimatedMs ?? null,
  // Moteur et brouillon : le placeholder de la file les affiche.
  videoEngine: p?.videoEngine ?? undefined,
  videoDraft: p?.videoDraft ? true : undefined,
  // Un seul registre : la réponse dit toujours « sfw », quelle que soit la base.
  status: r.status, personaId: r.persona_id, register: 'sfw',
  mode: r.mode, purpose: r.purpose, recipeId: r.recipe_id, workflowFile: r.workflow_file,
  comfyPromptId: r.comfy_prompt_id, seed: r.seed, userPrompt: r.user_prompt,
  userDirectives: r.user_directives, composedPositive: r.composed_positive,
  composedNegative: r.composed_negative, selections: parse(r.selections), error: r.error,
}))((() => { try { return JSON.parse(r.payload || 'null') } catch { return null } })())

/** Ce qu'on peut chercher sur un asset en plus du prompt : recette, moteur, opération, LoRA. */
const motsDe = r => {
  const loras = []
  for (const brut of [r.job_loras, r.job_video_loras]) {
    try { for (const l of JSON.parse(brut || '[]') ?? []) if (l?.name) loras.push(String(l.name).split('/').pop().replace(/\.safetensors$/i, '')) } catch { /* champ absent ou illisible */ }
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
  // Brouillon 0,4 MP : lu du payload du job (json_extract) — pas de colonne
  // dédiée, le job est la source de vérité et le badge doit être rétroactif.
  videoDraft: r.video_draft ? true : undefined,
  batchId: r.batch_id ?? undefined,
  // agrandissement (Photo HD, upscale) : l'asset d'origine, pour le curseur avant / après
  parentAssetId: r.parent_asset_id ?? undefined,
  // appartenances multiples (origines de carrousels) — fusionnées côté front
  batchIds: r.batch_ids ? (() => { try { return JSON.parse(r.batch_ids) } catch { return undefined } })() : undefined,
  batchLocks: r.carousel_locks ? (() => { try { return JSON.parse(r.carousel_locks) } catch { return undefined } })() : undefined,
  // Durée du rendu du job (ms). 0 = inconnue (repris sans date de départ) :
  // le front n'affiche rien plutôt qu'un « 0 s » faux.
  renderMs: r.render_ms ?? undefined,
  // contrôle automatique du clip (défauts horodatés, score de visage), cf. server/controle.js
  controle: r.controle ? (() => { try { return JSON.parse(r.controle) } catch { return undefined } })() : undefined,
  /* Provenance jointe (cf. db.ASSET_SELECT) : c'est ce qui rend un asset
     rechargé depuis la base clonable côté front. Le workflow injecté n'est
     PAS ici — trop lourd ; il vit sur /api/assets/:id/provenance. */
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
  videoFps: r.video_fps ?? undefined,
  // badges des cartes : son, plan d'ambiance (texte → vidéo), recette photo, finition
  withAudio: r.with_audio ? true : undefined,
  t2v: r.t2v ? true : undefined,
  photoEngine: r.photo_engine ?? undefined,
  postOp: ['foley', 'interpolate', 'upscale', 'photo_hd'].includes(r.job_op) ? r.job_op : undefined,
  caption: r.caption ?? undefined,
  captionOptions: r.caption_options ? (() => { try { return JSON.parse(r.caption_options) } catch { return undefined } })() : undefined,
  folders: r.folder_ids ? (() => { try { const f = JSON.parse(r.folder_ids); return f.length ? f : undefined } catch { return undefined } })() : undefined,
})

/* ---------- API ---------- */

/** La persona telle que le front la voit : rien d'autre que la configuration
 *  (aucun chemin de fichier). `name` null si non configurée. */
const personaPublique = (id) => {
  const p = persona(id)
  const actif = id === undefined || id === personas().active
  return { id: p.id, name: p.name || null, trigger: p.trigger, description: p.description,
    preamble: p.preamble, loras: p.loras, lorasKlein: p.lorasKlein, videoLoras: p.videoLoras, credit: p.credit, garderobe: p.garderobe, figes: actif ? champsFiges() : [],
    active: actif, avatar: avatarMeta(p.id).url,
    configured: Boolean(p.name || p.trigger || p.loras.length) }
}

/* Diagnostic de la machine : GET rend le dernier (ou en lance un s'il a plus
   de 2 min) ; ?frais=1 force un contrôle complet (~4 s). Lecture seule. */
/* Journal pour un rapport de bug (27/10) : ce qu'un utilisateur colle dans une issue
   GitHub. Rien de privé : les chemins absolus sont masqués, aucune clé, aucun prompt. */
const VERSION_STUDIO = (() => {
  let v = '0'
  try { v = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8')).version } catch { /* sans package.json */ }
  try { v += '+' + execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(new URL(import.meta.url).pathname), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* hors dépôt git */ }
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
/* Bilan après un redémarrage de ComfyUI (13/10) : dès qu'il répond de nouveau, le
   diagnostic complet est refait — une extension qui ne charge plus, un nœud de
   recette disparu sont annoncés tout de suite, pas au premier rendu qui échoue. */
let bilanRetour = null
comfy.onRetourComfy(async () => {
  await comfy.waitReady().catch(() => {})
  const d = await diagnostiquer({ recettes: recettesServies(), frais: true })
  bilanRetour = { quand: Date.now(), ok: d.ok, bloquants: d.bloquants, alertes: d.alertes }
  console.log(`[comfy] revenu après ${Math.round((comfy.etatLiaison().coupureMs ?? 0) / 1000)} s — bilan : `
    + (d.bloquants || d.alertes ? `${d.bloquants} bloquant(s), ${d.alertes} alerte(s)` : 'rien à signaler'))
})
/* Fige les versions actuelles de ComfyUI et de ses extensions comme référence. */
app.post('/api/diagnostic/figer', async () => {
  const r = await figerNoeuds()
  await diagnostiquer({ recettes: recettesServies(), frais: true })
  return r
})

/* Machines modestes (30/10) : profil de VRAM et variantes allégées prêtes ou manquantes. */
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
    videoEngines: VIDEO_ENGINES, defaultVideoEngine: DEFAULT_VIDEO_ENGINE,
    composerModels: CONFIG.composerModels,
    // chemins du serveur : au propriétaire seulement (la démo publique est sur Internet)
    ...(estProprietaire(req) ? { workflowsDir: CONFIG.workflowsDir, promptsDir: CONFIG.promptsDir,
      mediaDir: CONFIG.mediaDir, db: CONFIG.dbFile } : {}),
    ollamaUnload: CONFIG.ollamaUnload,
    // Studio verrouillé par une clé de propriétaire (le front masque l'édition).
    verrou: !!CONFIG.cleProprietaire,
    // Le front lit ces listes au montage au lieu d'en porter une copie.
    t0Blocklist: T0_BLOCKLIST,
    // Les couches que le serveur préfixe au prompt, pour que la console les
    // montre (bloc « ce qui partira vraiment ») — affichage prédictif, la
    // vérité reste la provenance après rendu.
    preambles: identityPreambleFor() ? { sfw: identityPreambleFor().text } : {},
    registerClauses: {},
    // La persona active (nom null si non configurée : le front a son repli).
    persona: personaPublique(),
    // Coefficients mesurés du temps de rendu (estimation avant envoi).
    renderRates: RENDER_RATES,
    // Qui tient la carte graphique (ComfyUI ou Ollama), et qui attend.
    gpu: etatGpu(),
    // dernier diagnostic connu (sans en relancer un) : l'interface affiche un voyant
    diagnostic: resumeDiagnostic(),
  }
})

/** Inventaire des LoRA, avec leur ARCHITECTURE réelle (lue dans l'en-tête,
 *  pas devinée du nom) : le front peut ainsi n'offrir que celles qui
 *  s'appliquent au moteur Z-Image, et griser les autres au lieu de les
 *  masquer sans explication. */
/* ---------- télémétrie machine ----------
   GPU par nvidia-smi (la vérité du driver), CPU par /proc/stat (delta entre
   deux appels — le premier rend null) et k10temp (Tctl des processeurs AMD) ;
   ailleurs la température reste null. Poll léger pensé pour un
   rafraîchissement de topbar toutes les ~5 s. Linux seulement. */
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

app.get('/api/telemetry', async () => {
  let gpu = null
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 }).trim().split(',').map(Number)
    gpu = { util: out[0], temp: out[1], vramUsedMb: out[2], vramTotalMb: out[3] }
  } catch { /* driver occupé : la topbar garde la dernière valeur */ }
  let cpuTemp = null
  try {
    // k10temp = capteur Tctl des processeurs AMD.
    for (const d of fs.readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${d}`
      if (fs.readFileSync(`${base}/name`, 'utf8').trim() === 'k10temp') {
        cpuTemp = Math.round(Number(fs.readFileSync(`${base}/temp1_input`, 'utf8')) / 1000)
        break
      }
    }
  } catch { /* capteur absent : null affiché comme — */ }
  let ram = null
  try {
    // RAM système : utilisé = total − disponible (MemAvailable tient compte
    // du cache récupérable, contrairement à MemFree).
    const mi = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map(l => l.split(':')).filter(a => a.length === 2)
      .map(([k, v]) => [k.trim(), parseInt(v, 10)]))
    if (mi.MemTotal) ram = { usedMb: Math.round((mi.MemTotal - mi.MemAvailable) / 1024), totalMb: Math.round(mi.MemTotal / 1024) }
  } catch { /* /proc absent : — */ }
  return { gpu, cpu: { util: cpuUtil(), temp: cpuTemp }, ram }
})

app.get('/api/loras', async () => comfy.listLoras())

/** Réécriture de prompt par LLM local, sur CPU. Synchrone à dessein : le
 *  front attend le texte pour l'afficher dans « Prompt composé », où
 *  l'opérateur le relit et le corrige avant d'envoyer le job. */
/* Cache court des compositions. Le LLM tourne sur CPU (50 à 105 s mesurés
   le 25/08) et un téléphone verrouille son écran avant la réponse : le fetch
   est abandonné côté client, mais Ollama, lui, va au bout. On garde donc la
   promesse EN VOL et le résultat 10 min par (registre, prompt, directives) :
   un second tap rend la réponse déjà calculée au lieu de relancer 100 s.
   Clé sur le texte BRUT, avant tirage wildcard : le retap retrouve le même
   tirage. Un échec vide l'entrée, pour qu'on puisse réessayer. */
const composeCache = new Map()
const COMPOSE_TTL_MS = 10 * 60 * 1000
app.post('/api/compose', async (req, reply) => {
  const { userPrompt, userDirectives, mode, engine, soul, mood, anchorUri, anchorFile, previousPrompt, keepOutfit } = req.body || {}
  const register = 'sfw'
  /* Continuation (onglet Étendre) : le prompt du clip prolongé. Borné — il
     ne sert que de contexte, et un texte démesuré évincerait la consigne. */
  const prevPrompt = typeof previousPrompt === 'string' && previousPrompt.trim()
    ? previousPrompt.trim().slice(0, 6000) : null

  /* ---------- contexte visuel ----------
     Une still de départ (i2v, Move) ou une image source (retouche) est
     décrite par le VLM AVANT la réécriture, et la description est cousue dans
     le message utilisateur. Sans elle le réécriveur inventait la tenue et la
     pose : il changeait une robe, ou faisait se lever un sujet assis.
     Le VLM tourne sur CPU (num_gpu 0, comme le réécriveur) : il ne peut pas
     entrer en concurrence avec un rendu ComfyUI. */
  /* On décrit LE FICHIER QUE LE RENDU UTILISERA, pas une vignette choisie
     par ressemblance. `anchorFile` est le nom déjà déposé dans l'input de
     ComfyUI — exactement ce que le job enverra en `sourceImage` / `motionRef`.
     C'est la seule source qui ne peut pas diverger de l'image réellement
     animée, et elle couvre aussi les uploads (dont l'URI front est un
     `blob:` illisible côté serveur).
     `anchorUri` reste un repli pour les cas où le dépôt n'a pas encore eu
     lieu. basename() dans les deux cas : le nom vient du client. */
  let sceneDesc = null
  let outfitAnchor = null
  {
    const pathz = await import('node:path')
    let abs = null
    if (typeof anchorFile === 'string' && anchorFile.trim()
        && (estProprietaire(req) ? store.estInputStudio : store.estInputGenere)(pathz.basename(anchorFile)))
      abs = pathz.join(CONFIG.comfyInput, pathz.basename(anchorFile))
    else if (typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
      abs = pathz.join(CONFIG.mediaDir, pathz.basename(anchorUri))
    /* « Tenue de l'image » : en PLUS de la description complète, un appel VLM
       dédié qui ne rend que les vêtements (même fonction que l'ancre du
       carrousel, doublée du filtre code `filterOutfit`). Le texte obtenu est
       inséré TEL QUEL dans le prompt par le composeur — il ne dépend donc pas
       de l'obéissance du réécriveur, contrairement à une directive écrite.
       Les deux appels partent ensemble : ils lisent la même image. */
    if (abs) {
      const [sd, od] = await Promise.all([
        describeScene(abs),
        keepOutfit === true ? describeOutfit(abs) : Promise.resolve(null),
      ])
      sceneDesc = sd
      outfitAnchor = od
    }
  }
  // Le texte du réécriveur (relu du disque, éditable dans le Workbench) fait
  // partie de la clé : une consigne modifiée ne doit pas servir une réponse
  // calculée avec l'ancienne pendant dix minutes. `system` reflète déjà les
  // couches SOUL/MOOD si activées (défaut OFF = système inchangé), donc la clé
  // de cache les distingue automatiquement.
  let system = ''
  try { system = composer.systemFor(register, mode ?? 'photo', engine ?? null, { soul: soul ?? null, mood: mood ?? null }) } catch { /* compose() lèvera proprement */ }
  /* La description de l'image fait partie de la clé : changer de still doit
     donner une autre réécriture, pas la réponse calculée sur la précédente. */
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
    /* `sceneDesc` remonte au front : l'opérateur doit pouvoir vérifier CE QUE
       le VLM a vu quand la réécriture le surprend — une description fausse et
       une consigne mal suivie ne se corrigent pas au même endroit. */
    /* `outfitRequested` distingue « pas demandé » de « demandé mais aucune
       tenue vue » : le front le dit à l'opérateur. */
    return { ...out, cached: Boolean(fresh), sceneDesc, continuation: Boolean(prevPrompt),
             outfitAnchor, outfitRequested: keepOutfit === true }
  } catch (e) {
    // 502 et pas 500 : la panne est chez Ollama, pas dans CreatorOS. Le front
    // doit pouvoir le dire à l'opérateur au lieu d'afficher « erreur ».
    reply.code(502)
    return { error: String(e.message || e) }
  }
})

/* ---------- recettes : lecture et édition depuis le Workbench ----------
   Le Workbench édite les fichiers RÉELLEMENT SERVIS. `loadWorkflow` relit le
   disque à chaque job, donc une écriture prend effet au job suivant, sans
   redémarrage — et une recette cassée casserait la production. D'où la
   validation côté serveur, avant écriture, et pas seulement dans le navigateur. */

/** Qui utilise ce fichier. C'est ce qui distingue une recette de production
 *  d'un fichier de bench oublié dans le même dossier. */
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

/* Revue d'une recette : injection d'ESSAI (aucun rendu) pour lister ce que le
   câblage pilote réellement, lecture de la déclaration voisine, et contrôle des
   nœuds et des fichiers nommés contre ComfyUI. */
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
    // 409 et pas 400 : l'opérateur n'a rien écrit de faux, sa base a bougé.
    // Le front doit pouvoir distinguer « ton JSON est cassé » de « quelqu'un
    // d'autre — ou un script — a touché le fichier pendant que tu éditais ».
    reply.code(e.code === 'CONFLIT' ? 409 : 400)
    return { error: String(e.message || e), conflict: e.code === 'CONFLIT' || undefined,
             currentMtimeMs: e.currentMtimeMs }
  }
})

/* ---------- textes de façonnage : même mécanique que les recettes ----------
   Lus par le serveur à chaque job, donc une écriture prend effet au job
   suivant. Validation volontairement plus légère : ce sont des textes libres,
   le seul refus est le vide. */

/** Ce que le fichier pilote — sert aux badges du Workbench. */
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
    // Garde-fou anti-apparence sur les couches SOUL/MOOD : elles ne doivent
    // décrire QUE comportement/atmosphère. Non bloquant — juste un signal
    // Workbench (liste des mots d'apparence détectés).
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

/* ---------- dépôt d'image source (recettes d'édition) ----------
   Corps BRUT plutôt que multipart ou base64 : un JPEG d'iPhone dépasse
   volontiers 8 Mio, et le base64 l'enflerait encore d'un tiers. Le nom
   voulu passe en query.

   Le fichier atterrit dans le dossier `input/` de ComfyUI, seul endroit
   qu'un nœud LoadImage sait lire. */
const UPLOAD_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  // Vidéos : le driver du Motion Control. Le .mov des iPhone est du QuickTime.
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
}
app.addContentTypeParser(Object.keys(UPLOAD_TYPES), { parseAs: 'buffer' },
  (req, body, done) => done(null, body))

/** Dimensions d'une image, lues dans son en-tête — sans dépendance.
 *  Elles servent à caler le latent sur le FORMAT de la référence ControlNet :
 *  une carte de contrôle en 1:2,9 poussée dans un latent 2:3 est recadrée en
 *  silence, et on attribue ensuite le mauvais cadrage au modèle. */
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
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {         // JPEG : marqueur SOFn
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

app.post('/api/upload', async (req, reply) => enregistrerEnvoi(req, reply))

function enregistrerEnvoi(req, reply) {
  const ext = UPLOAD_TYPES[String(req.headers['content-type']).split(';')[0]]
  if (!ext) { reply.code(415); return { error: 'type non accepté (png, jpeg, webp, mp4, mov, webm)' } }
  const buf = req.body
  if (!Buffer.isBuffer(buf) || !buf.length) { reply.code(400); return { error: 'corps vide' } }
  if (buf.length > 48 * 1024 * 1024) { reply.code(413); return { error: 'fichier > 48 Mio' } }

  // Le nom de l'opérateur ne sert qu'à rester reconnaissable dans le dossier :
  // il est réduit à un jeu de caractères sûr et préfixé d'un horodatage, sinon
  // deux dépôts du même « IMG_0042.jpg » s'écraseraient en silence.
  const raw = String(req.query.name || 'source').replace(/\.[^.]*$/, '')
  const stem = raw.normalize('NFD').replace(/[^\w-]+/g, '_').slice(0, 40) || 'source'
  const filename = `crs_${Date.now().toString(36)}_${stem}${ext}`
  fs.mkdirSync(CONFIG.comfyInput, { recursive: true })
  fs.writeFileSync(path.join(CONFIG.comfyInput, filename), buf)
  store.noterInput(filename, 'upload')
  const { width, height } = imageSize(buf)
  // Vidéo (driver) : durée et images telles que la chaîne motion les verra,
  // pour l'estimation avant envoi.
  const video = ext.startsWith('.m') || ext === '.webm' ? driverMeta(filename) : null
  app.log.info(`upload → ${filename} (${(buf.length / 1e6).toFixed(1)} Mo, ${width}x${height}${video ? `, ${video.seconds.toFixed(1)} s / ${video.frames} images` : ''})`)
  return { filename, bytes: buf.length, width, height, ...(video ? { durationS: video.seconds, frames: video.frames, fps: video.fps } : {}) }
}

/* Filmer un geste au téléphone (30/10) : le propriétaire ouvre un QR code, le téléphone envoie
   la vidéo vers Motion. Le jeton remplace la clé propriétaire pour UN envoi vidéo, 10 min ; seul
   le propriétaire peut en créer. Le fichier reste un « upload » : un visiteur ne peut pas s'en servir. */
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
   GET /api/persona : la persona active (cf. server/persona.js) — nom,
   description, mot déclencheur, LoRA. PUT l'enregistre dans `persona.json`
   (éditeur de la vue Personnage) ; un champ fixé par variable d'environnement
   reste prioritaire et est signalé dans `figes`.

   Photo de profil : un seul fichier, `media/.persona/avatar.<ext>`, remplacé à
   chaque dépôt. Servi par GET avec le mtime en jeton de cache côté front (?v=).
   Rien en base : c'est un fichier de présentation, pas une donnée de rendu. */
const corpsPersonaRefuse = (c) => {
  if (!c || typeof c !== 'object') return 'corps JSON attendu'
  for (const champ of ['name', 'description', 'preamble', 'trigger']) {
    if (t0Hit(String(c[champ] ?? ''))) return `terme interdit dans « ${champ} »`
  }
  for (const x of c.garderobe?.perso ?? [])
    if (t0Hit(`${x?.label ?? ''} ${x?.prompt ?? ''}`)) return 'terme interdit dans la garde-robe'
  return null
}
/* Page Créateur : lecture libre ; écriture filtrée (T0, liens https seulement). */
app.get('/api/createur', async () => lireCreateur())
app.put('/api/createur', async (req, reply) => {
  const c = req.body ?? {}
  const tout = [c.nom, c.titre, c.titreEn, c.bio, c.bioEn, ...(c.liens ?? []).map(l => l?.label), ...(c.infos ?? []).flatMap(i => [i?.k, i?.v, i?.kEn, i?.vEn])].join(' ')
  if (t0Hit(tout)) { reply.code(400); return { error: 'terme interdit' } }
  return ecrireCreateur(c)
})
app.get('/api/persona', async () => personaPublique())
app.put('/api/persona', async (req, reply) => {
  const refus = corpsPersonaRefuse(req.body)
  if (refus) { reply.code(400); return { error: refus } }
  try { enregistrerPersona(req.body) } catch (e) { if (e.statusCode !== 409) throw e; reply.code(409); return { error: e.message } }
  return personaPublique()
})

/* Plusieurs personnages : liste, création (vide ou copie), activation,
   modification et suppression. Un rendu garde le personnage actif à son
   dépôt (job.personaId) ; en changer n'affecte que les rendus suivants. */
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
app.post('/api/personas/:id/activer', async (req, reply) => {
  if (!activerPersona(req.params.id)) { reply.code(404); return { error: 'personnage inconnu' } }
  return personaPublique()
})
app.delete('/api/personas/:id', async (req, reply) => {
  const r = supprimerPersona(req.params.id)
  if (!r.ok) { reply.code(r.error === 'personnage inconnu' ? 404 : 409); return { error: r.error } }
  return { ok: true, active: personas().active }
})

/* Dépôt d'une LoRA d'identité (.safetensors) dans le dossier des LoRA de
   ComfyUI. Corps brut en flux (application/octet-stream) : une LoRA pèse de
   50 Mo à plus d'1 Go, elle ne passe pas en mémoire. L'en-tête safetensors est
   vérifié après écriture — un fichier qui n'en est pas un est supprimé. Pas
   d'écrasement silencieux : ?remplacer=1 pour remplacer un fichier existant. */
const LORA_MAX = 2 * 1024 ** 3
app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload))
app.post('/api/persona/lora', async (req, reply) => {
  const brut = String(req.query.nom || '').replace(/\.safetensors$/i, '')
  const stem = brut.normalize('NFD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
  if (!stem) { reply.code(400); return { error: 'nom de fichier manquant' } }
  const nom = `${stem}.safetensors`, cible = path.join(CONFIG.lorasDir, nom)
  if (fs.existsSync(cible) && req.query.remplacer !== '1') { reply.code(409); return { error: `« ${nom} » existe déjà`, nom } }
  fs.mkdirSync(CONFIG.lorasDir, { recursive: true })
  const tmp = `${cible}.part`
  let octets = 0
  try {
    await new Promise((ok, ko) => {
      const out = fs.createWriteStream(tmp)
      req.body.on('data', d => { octets += d.length; if (octets > LORA_MAX) req.body.destroy(new Error('fichier > 2 Gio')) })
      req.body.on('error', ko); out.on('error', ko); out.on('finish', ok)
      req.body.pipe(out)
    })
    // safetensors : 8 octets de longueur d'en-tête (LE), puis un JSON
    const fd = fs.openSync(tmp, 'r'), tete = Buffer.alloc(9)
    fs.readSync(fd, tete, 0, 9, 0); fs.closeSync(fd)
    const n = Number(tete.readBigUInt64LE(0))
    if (octets < 16 || n <= 0 || n > octets - 8 || tete[8] !== 0x7b) throw new Error('ce fichier n’est pas un .safetensors')
    fs.renameSync(tmp, cible)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    reply.code(400); return { error: String(e.message || e) }
  }
  app.log.info(`LoRA déposée → ${nom} (${(octets / 1e6).toFixed(0)} Mo)`)
  return { nom, octets, lora: comfy.listLoras().loras.find(l => l.name === nom) ?? null }
})
/* Une photo par personnage : media/.persona/<id>/avatar.<ext>. Sans `?id=`,
   celle du personnage actif. */
const AVATAR_DIR = path.join(CONFIG.mediaDir, '.persona')
const AVATAR_EXTS = ['.png', '.jpg', '.webp']
const idAvatar = id => String(id ?? personas().active ?? 'default').replace(/[^a-z0-9_]/g, '') || 'default'
const avatarDir = id => path.join(AVATAR_DIR, idAvatar(id))
const avatarFile = id => AVATAR_EXTS.map(e => path.join(avatarDir(id), `avatar${e}`)).find(f => fs.existsSync(f)) || null
/* Ancienne forme (une seule photo à la racine) : rattachée au personnage actif. */
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

/* Photo de profil choisie parmi les rendus du personnage : recadrée en carré
   (haut de l'image, où est le visage sur un portrait) et réduite à 512 px. */
app.put('/api/persona/avatar/depuis-asset', async (req, reply) => {
  const row = store.getAsset(String(req.body?.assetId ?? ''))
  if (!row || row.media_type !== 'photo' || !row.filename) { reply.code(400); return { error: 'photo de la bibliothèque attendue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(row.filename))
  if (!fs.existsSync(src)) { reply.code(410); return { error: 'fichier absent du disque' } }
  const id = req.query?.id
  const dir = avatarDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, 'avatar.tmp.jpg')
  // carré pris en haut d'un portrait (le visage), au centre d'un paysage
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

/** Clé Comfy Cloud du visiteur (en-tête X-Comfy-Key), si présente. Jamais
 *  journalisée ni enregistrée : elle part avec le job, en mémoire. */
function cleComfy(req) {
  const v = String(req.headers['x-comfy-key'] ?? '').trim()
  return v && v.length <= 400 && /^[\x21-\x7e]+$/.test(v) ? v : null
}

/* LoRA des personnages sur Comfy Cloud (cf. cloud-loras.js). Toujours en POST :
   c'est la seule méthode à laquelle le front joint la clé du visiteur. */
function exigerCle(req) {
  const cle = cleComfy(req)
  if (!cle) { const e = new Error('clé Comfy Cloud absente : l’enregistrer dans Paramètres → Comfy Cloud'); e.statusCode = 401; throw e }
  return cle
}
app.post('/api/cloud/loras/etat', async req => etatCloud(exigerCle(req)))
app.post('/api/cloud/loras/importer', async req =>
  importerCloud(exigerCle(req), { persona: typeof req.body?.persona === 'string' ? req.body.persona : undefined }))
app.post('/api/cloud/taches/:id', async req => tacheCloud(exigerCle(req), req.params.id))

/** Dépôt d'un job. Répond tout de suite (202) : la génération est
 *  asynchrone, le front suit par /api/jobs/:id. */
/* Le dossier input de ComfyUI peut être partagé avec une autre installation :
   un job déposé par l'API ne nomme que des fichiers que ce studio y a mis
   lui-même (registre inputs_studio), sinon un visiteur pourrait animer ou
   faire décrire l'image d'un autre. */
/* Visiteur (sans la clé) : seulement ce que le studio a généré lui-même — jamais
   un upload, même ancien : jamais la photo d'une personne réelle. */
function inputEtranger(b, proprietaire) {
  const noms = [b.sourceImage, b.endImage, b.motionDriver, b.motionRef, b.concatFrom === 'input' ? b.concatWith : null]
  const admis = n => proprietaire ? store.estInputStudio(n) : store.estInputGenere(n)
  return noms.find(n => typeof n === 'string' && n.trim() && !admis(path.basename(n.trim()))) ?? null
}
app.post('/api/jobs', async (req, reply) => {
  const etranger = inputEtranger(req.body || {}, estProprietaire(req))
  if (etranger) { reply.code(400); return { error: `« ${path.basename(etranger)} » absent du dossier input/` } }
  if (req.body && !estProprietaire(req)) delete req.body.profilVram   // profil de banc : propriétaire seulement
  try {
    const r = await deposerAvecCle(cleComfy(req), () => enqueueParPlans(req.body || {}))   // une vidéo de mouvement montée part en un job par plan
    /* 200 (et non 202) quand la clé d'idempotence avait déjà été vue : le
       client sait ainsi qu'il relit un envoi antérieur au lieu d'en avoir
       déclenché un nouveau. Le corps est identique dans les deux cas — une
       reprise doit pouvoir traiter la réponse sans cas particulier. */
    reply.code(r.duplicate ? 200 : 202)
    return { ...r, status: 'queued' }
  } catch (e) {
    reply.code(400)
    return { error: String(e.message || e) }
  }
})

/** Aperçu en direct du rendu en cours (dernière image poussée par ComfyUI). */
app.get('/api/jobs/:id/apercu', async (req, reply) => {
  const job = store.getJob(req.params.id)
  const ap = job?.comfy_prompt_id ? comfy.getApercu(job.comfy_prompt_id) : null
  if (!ap) { reply.code(404); return { error: 'pas d’aperçu' } }
  reply.header('Cache-Control', 'no-store')
  reply.type(ap.mime)
  return ap.buf
})

/* Vignette d'une vidéo — voir poster.js. Cache long : le fichier d'un
   asset ne change jamais (un nouveau rendu est un nouveau nom). */
app.get('/api/poster/:file', async (req, reply) => {
  const p = await ensurePoster(req.params.file)
  if (!p) { reply.code(404); return { error: 'pas de vignette' } }
  reply.header('Cache-Control', 'public, max-age=31536000, immutable')
  reply.type('image/jpeg')
  return fs.createReadStream(p)
})

app.get('/api/jobs', async req => ({
  jobs: store.listJobs(Number(req.query.limit) || 50).map(jobOut),
}))

/** Annulation : file → retiré ; en cours → interrompu côté ComfyUI. */
/** Monte un job EN ATTENTE en tête de file (la file de CreatorOS, pas celle
 *  de ComfyUI qui ne voit qu'un job à la fois). 409 s'il n'est pas en attente. */
app.post('/api/jobs/:id/promote', async (req, reply) => {
  const r = promoteJob(req.params.id)
  if (!r) { reply.code(409); return { error: 'ce job n’est pas en attente' } }
  return r
})

/** Nouvel ordre de la file d'attente (drag & drop de la vue Jobs). */
app.post('/api/jobs/reorder', async req => reorderQueue((req.body?.ids ?? []).map(String)))

/* Briefs déjà envoyés (dédoublonnés, le plus récent d'abord) et briefs étoilés. */
app.get('/api/briefs', async () => ({ briefs: store.listBriefs() }))
app.post('/api/briefs/star', async (req, reply) => {
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.trim() : ''
  if (!texte) { reply.code(400); return { error: 'brief vide' } }
  store.starBrief(texte, req.body?.mode, req.body?.on !== false)
  return { ok: true }
})

/** Relance d'un job TERMINÉ (échec ou non) : son payload d'origine repart en
 *  file tel quel, même graine. `draft` le renvoie en brouillon (vidéo) ou en
 *  prévisualisation 480p (motion) pour vérifier vite qu'il passe ;
 *  `nouvelleGraine` le relance avec une graine tirée au hasard. */
app.post('/api/jobs/:id/retry', async (req, reply) => {
  const row = store.getJob(req.params.id)
  if (!row) { reply.code(404); return { error: 'job inconnu' } }
  if (!['done', 'blocked'].includes(row.status)) { reply.code(409); return { error: `job « ${row.status} » : encore en cours` } }
  let p
  try { p = JSON.parse(row.payload || 'null') } catch { p = null }
  if (!p) { reply.code(409); return { error: 'réglages d’origine introuvables : ce job ne peut pas être relancé' } }
  for (const f of ['id', 'createdAt', 'status', 'estimatedMs', 'requestId', 'batchIds', 'error']) delete p[f]
  /* « Encore une » : mêmes réglages, graine neuve — une variante, pas une copie. */
  if (req.body?.nouvelleGraine) p.seed = { mode: 'random' }
  else if (Number.isFinite(row.seed)) p.seed = { mode: 'lock', value: row.seed }
  if (req.body?.draft) { if (p.videoEngine === 'motion') p.motionPreview = true; else p.videoDraft = true }
  try {
    const r = deposerAvecCle(cleComfy(req), () => enqueue(p))
    reply.code(202)
    return { ...r, status: 'queued', from: row.id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

app.delete('/api/jobs/:id', async (req, reply) => {
  const r = await cancelJob(req.params.id)
  if (r) return r
  /* Ni en file ni en cours : si le job est TERMINAL (done / blocked), la
     suppression est définitive — la ligne job, et par cascade ses assets et
     leurs provenances. Les fichiers disque (médias + posters) partent aussi.
     C'est le nettoyage de la vue Jobs ; l'interface confirme en deux temps
     et affiche le nombre de rendus emportés. */
  const row = store.getJob(req.params.id)
  if (!row) { reply.code(404); return { error: 'job inconnu' } }
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
  // Rang et attente estimée d'un job en attente (affichés sur sa carte)
  if (job.status === 'queued') out.file = placeDansFile(job.id) ?? undefined
  // Progression du rendu en cours — celle que l'interface de ComfyUI affiche.
  // Approximative par construction (par nœud), et présentée comme telle.
  if (job.status === 'rendering' && job.comfy_prompt_id) {
    out.progress = comfy.getProgress(job.comfy_prompt_id)
    out.phase = comfy.getPhase(job.comfy_prompt_id) ?? undefined
    const ap = comfy.getApercu(job.comfy_prompt_id)
    if (ap) out.apercu = ap.at       // horodatage : l'interface ne recharge l'image que s'il change
  }
  return { job: out, assets: store.assetsOfJob(job.id).map(assetOut) }
})

/* ---------- v2 : listes read-only pour la nouvelle coquille ----------
   /api/uploads : fichiers image du dossier input de ComfyUI (historique des
   uploads, picker « frame de départ »). /api/wildcards : fichiers *.txt
   et leurs lignes (popup Éléments). Aucune écriture — le tirage 🎲 reste
   l'affaire du serveur au moment du compose/job. */
app.get('/api/uploads', async req => {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const dir = CONFIG.comfyInput
  let files = []
  try {
    files = fsx.readdirSync(dir)
      .filter(f => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.') && store.estInputStudio(f))   // dossier partagé : seulement nos dépôts
      .map(f => { const st = fsx.statSync(pathx.join(dir, f)); return { name: f, mtime: st.mtimeMs, bytes: st.size } })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Number(req.query.limit) || 120)
  } catch { /* dossier absent : liste vide */ }
  return { uploads: files }
})

app.get('/api/uploads/:name', async (req, reply) => {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const name = String(req.params.name || '')
  // nom nu uniquement — pas d'échappée hors du dossier input
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    reply.code(400); return { error: 'nom invalide' }
  }
  const file = pathx.join(CONFIG.comfyInput, name)
  if (!store.estInputStudio(name) || !fsx.existsSync(file)) { reply.code(404); return { error: 'introuvable' } }
  reply.type(name.match(/\.png$/i) ? 'image/png' : 'image/jpeg')
  reply.header('Cache-Control', 'public, max-age=86400')
  return fsx.createReadStream(file)
})

/* ---------- v2 : réécriture carrousel ----------
   Garde le prompt EXACT sauf les éléments listés dans `vary`, que le LLM
   réécrit librement en conservant la cohérence. 1 variante par appel — le
   front boucle (progression naturelle + jobs soumis au fil de l'eau).
   CPU (num_gpu 0) : jamais en concurrence avec ComfyUI. */
/* v2 : rattacher un job EXISTANT à un lot (carrousel : l'original n'est pas
   re-généré, son rendu rejoint la vignette-mosaïque du lot). */
app.post('/api/jobs/:id/batch-id', async (req, reply) => {
  const { batchId } = req.body || {}
  if (!batchId || typeof batchId !== 'string') { reply.code(400); return { error: 'batchId requis' } }
  const r = store.setJobBatchId(req.params.id, batchId)
  if (!r) { reply.code(404); return { error: 'job introuvable' } }
  return { ok: true }
})

/* Décomposition d'une scène en CINQ dimensions — partagée par /api/decompose
   (l'opérateur voit ce que le VLM a trouvé AVANT de poser ses cadenas) et par
   /api/rewrite (qui accepte le résultat déjà calculé pour ne pas repayer les
   35 s de VLM). */
/* Moteur de diffusion photo — même source que composer.js et jobs.js, lu ici
   pour les consignes de rendu mécanisées dans le carrousel. */
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
  /* Pas d'image (ou VLM muet) : on trie le TEXTE. Le carrousel doit marcher sur
     un prompt seul. */
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

/* L'opérateur ouvre le carrousel : on lui montre ce que le VLM a trouvé dans
   chaque dimension, pour qu'il sache ce qu'il verrouille. */
app.post('/api/decompose', async (req, reply) => {
  const { anchorUri, prompt } = req.body || {}
  const dims = await dimensionsDe({ anchorUri, texte: prompt })
  if (!dims) { reply.code(502); return { error: 'décomposition impossible' } }
  return { dims }
})

app.post('/api/rewrite', async (req, reply) => {
  /* `writerModel` : override de MESURE uniquement (comparer deux rédacteurs
     sur le même corpus). Absent du front — le routage de prod reste
     `composer.modelFor()`. */
  const { prompt, vary, n, anchorUri, anchorOutfit, shoot, writerModel } = req.body || {}
  if (!prompt || !Array.isArray(vary) || !vary.length) {
    reply.code(400); return { error: 'prompt et vary[] requis' }
  }
  const count = Math.min(Math.max(Number(n) || 8, 1), 12)
  const model = composer.modelFor()

  /* ---------- 1) contexte visuel (VLM) — le CONCEPT vient de l'image + du
     prompt. Le LLM varie librement DANS le concept. La description est une
     ENTRÉE du réécriveur, jamais un prompt de diffusion : les gardes code en
     aval s'appliquent inchangées. */
  const pathx = await import('node:path')
  const has = needle => vary.some(v => v.includes(needle))
  let sceneDesc = null
  /* En mode shooting, `decomposeScene` fait ce travail EN MIEUX (cinq
     dimensions au lieu d'une description globale) : inutile de payer le VLM
     deux fois. */
  if (!shoot && typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
    sceneDesc = await describeScene(pathx.join(CONFIG.mediaDir, pathx.basename(anchorUri)))

  /* Ancrage d'une dimension GARDÉE mais sous-spécifiée dans le prompt :
     « Tenue gardée » + prompt sans couleurs → chaque seed réinvente (gris,
     bleu, jupe…). Le VLM décrit la tenue de l'IMAGE d'origine et cette
     description précise est cousue dans toutes les variantes. */
  let outfitAnchor = null
  if (!shoot && anchorOutfit && typeof anchorUri === 'string' && anchorUri.startsWith('/media/'))
    outfitAnchor = await describeOutfit(pathx.join(CONFIG.mediaDir, pathx.basename(anchorUri)))

  /* ---------- 1bis) MODE SHOOTING ----------
     Le mode historique ne sait que RETIRER des segments et réécrire une clause
     à la même place : il produit des variantes de posture, jamais des plans.
     Ici le writer n'édite plus un texte, il ÉCRIT des plans : tronc commun figé
     (tenue, lieu, rendu verrouillés) + un bloc de plan qui change seul —
     action, pose, cadrage, angle. La calibration vit sur le disque
     (shoot_sfw.txt) : l'intensité s'enseigne par l'exemple, pas par un
     adjectif, et l'opérateur étend le corpus sans rebuild. */
  if (shoot) {
    /* `keep_alive` : le mode dimensions fait DEUX appels — le trieur puis le
       rédacteur — et sur CPU chaque rechargement de modèle coûte plus d'une
       minute. On garde donc les modèles chauds dix minutes. */
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

      /* Queue d'ancre périmée d'un carrousel précédent, cumulative d'une
         génération à l'autre : on la coupe avant tout le reste. */
      const promptNet = prompt.replace(/[,.\s]*\bwearing\s+[^.]*\.?\s*$/i, '.')
      /* ================= DIMENSIONS =================
         La scène est décomposée en cinq dimensions indépendantes — tenue,
         pose, décor, accessoires, style photo. Une dimension COCHÉE est la
         CONSTANTE du shooting : elle va dans le tronc et ne bouge plus. Les
         décochées sont la matière du rédacteur, libre de les garder ou de les
         changer. */
      const DIMS = ['outfit', 'pose', 'location', 'props', 'style']
      const LIBELLE = { outfit: 'OUTFIT', pose: 'POSE', location: 'LOCATION', props: 'PROPS AROUND HER', style: 'PHOTOGRAPHIC STYLE' }

      /* Dimensions déjà calculées par /api/decompose (l'opérateur les a vues
         avant de poser ses cadenas) : on ne repaie pas le VLM. */
      const dimsRecues = req.body && typeof req.body.dims === 'object' && req.body.dims
        && DIMS.some(k => req.body.dims[k])
      const tDims = Date.now()
      const dims = dimsRecues ? req.body.dims : await dimensionsDe({ anchorUri, texte: promptNet })
      const msDims = Date.now() - tDims
      if (!dims) throw new Error('décomposition impossible : ni image d\'ancrage exploitable, ni tri du texte')

      /* Contrat : `keep` est ce qui reste CONSTANT. On l'accepte tel quel et on
         le déduit sinon de `vary` (ancien contrat du front, où la dimension
         citée est celle qui varie). */
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
      /* DÉDUPLICATION décor / accessoires. Le décompositeur range volontiers
         les mêmes objets dans `location` ET dans `props`. Cette redondance pèse
         un tiers du prompt, et un prompt saturé fait PERDRE LE CADRAGE. On
         retire de `props` les groupes nominaux DÉJÀ présents dans `location`.
         Ce qui est verrouillé reste écrit — une seule fois. */
      const sansRedondance = (props, location) => {
        if (!props || !location) return props
        const lieu = String(location).toLowerCase()
        return String(props).split(/\s*,\s*/).filter(Boolean).filter(seg => {
          /* un segment est un doublon si son NOM DE TÊTE (le dernier nom du
             groupe, « a side table with a lamp » → « lamp ») apparaît déjà dans
             le décor. */
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

      /* ================= GRILLE TIRÉE EN CODE =================
         Une consigne textuelle ne tient pas sur un modèle CPU local : il
         respecte le cadrage mais répète la posture. On ne demande donc plus au
         modèle de RÉPARTIR — le serveur tire cadrage, angle et famille
         d'action, tous distincts, et le modèle rédige une case. */
      const melange = a => [...a].sort(() => Math.random() - 0.5)
      const CADRAGES = melange([
        'wide shot, she is small in the frame, the whole setting around her',
        'full length', 'waist-up', 'close medium shot',
        'tight portrait, her face fills the frame',
        'full length, seen at a distance', 'head and shoulders', 'medium shot',
      ])
      /* L'angle « dans un miroir » n'entre dans le tirage QUE si le décor
         verrouillé en contient un : assigné à tour de rôle, il faisait écrire
         un miroir sur une allée de gravier. */
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
      /* POSE COCHÉE = la pose EST la constante, bras compris. On empêche
         l'ACTION de replacer les mains ailleurs : la pose figée dit où sont les
         bras, une famille d'action les enverrait ailleurs, et le modèle
         d'image réconcilie en en dessinant un de trop. */
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
      /* POSITIONS DE L'OPÉRATEUR : quand la pose est libre, l'action assignée
         peut venir de ses wildcards de postures (poses_sfw.txt dans le dossier
         des textes) plutôt que des huit familles écrites à la main. Une ligne
         de wildcard est RICHE : la recopier est un bon résultat. */
      let positions = null
      if (!keep.pose) {
        try {
          const l = prompts.readPrompt('poses_sfw.txt').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'))
          if (l.length >= count) positions = l
        } catch { /* repli familles */ }
      }
      const FAMILLES = melange(keep.pose ? FAM_POSE_FIGEE : positions || FAM)
      /* Quand l'accessoire est LIBRE, il entre dans la ligne d'assignation au
         même titre que le cadrage et l'action : ce que la grille assigne, le
         rédacteur l'écrit ; ce qu'un paragraphe demande, il l'oublie. */
      const propsLibres = libres.includes('props') && String(dims.props || '').trim()
      const grille = Array.from({ length: count }, (_, i) =>
        `SHOT ${i + 1}: framing = ${CADRAGES[i % CADRAGES.length]}; camera = ${ANGLES[i % ANGLES.length]}; action = ${FAMILLES[i % FAMILLES.length]}`
        + (propsLibres
          ? `; prop = one object of the same family as « ${String(dims.props).trim().slice(0, 120)} », `
            + 'and belonging to THIS kind of place — a driveway, a deck, a cabin, a beach, a kitchen and a '
            + 'bedroom each hold different things, and a sofa does not stand on gravel or on sand — different '
            + 'from the other shots, named in the sentence and used or touched by her'
          : ''))

      /* ================= CONSIGNE ================= */
      const shSys =
        (MOTEUR_PHOTO === 'krea'
          /* Le carrousel ne passe PAS par composer.systemFor() : il bâtit son
             propre system prompt. Sans cette clause le rédacteur écrit de
             lui-même un lexique de pellicule calibré pour Klein. */
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
        /* Une consigne IMPÉRATIVE par dimension, qui nomme sa valeur. */
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
          } catch { /* repli lignes */ }
        }
        /* JSON TRONQUÉ : la sortie se coupe parfois au milieu du tableau. On
           récupère alors les chaînes complètes une par une : une entrée fermée
           par un guillemet est exploitable, même si le tableau ne l'est pas. */
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
      /* Chronométrage : un carrousel lent a deux causes possibles — la
         décomposition rejouée (dims non transmises par le front) ou la
         rédaction relancée parce que le JSON du modèle ne s'est pas lu. */
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
      /* Doublons : un shooting ne livre pas deux fois la même photo. */
      const vus = new Set()
      shots = shots.filter(s => {
        const clef = s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).slice(0, 12).join(' ')
        if (vus.has(clef)) return false
        vus.add(clef); return true
      })

      /* ================= ASSEMBLAGE ================= */
      const METAFIN = /[,;]\s*(?:interacting with|doing something with|playing with|handling|using the furniture|looking at (?:her own )?reflection|caught mid-?movement|at rest)[^.]*\.?\s*$/i
      const DITCADRE = /\b(shot|framing|framed|close[- ]?up|waist[- ]up|full length|wide|portrait|head and shoulders|overhead|from above|from below|eye level|floor level|from behind|three-quarter|in the mirror|reflection|across the)\b/i
      /* Grain d'appareil recollé en code (Klein) : la consigne « nomme
         l'appareil » est ignorée par le rédacteur, et ce sont ces mots qui
         font qu'un rendu Klein a l'air d'une photo. UN SEUL par plan, tiré au
         sort, et seulement si le style photo n'est PAS cadenassé. Sur Krea, la
         directive de rendu est suivie : une seule formule d'intention. */
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
      /* Sur Krea, une consigne de rendu écrite par le rédacteur est du
         vocabulaire de pellicule hérité des corpus Klein : on retire la clause
         fautive avant d'ajouter la bonne — seulement la clause de rendu,
         jamais la phrase d'action. */
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

  /* ---------- 2) LLM en DEUX rôles ----------
     (a) CLASSIFICATION des segments, déterministe temp 0 → indices à retirer ;
     (b) SCÈNES-CONCEPT écrites par le rédacteur, qui varie DANS le concept. */
  /* Segments MÉTA filtrés en code avant classification : un prompt source
     pollué par une paraphrase de consignes (« is described accurately »,
     « kept vague ») serait GARDÉ et propagé aux variantes. */
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
    /* Sur-drop : si la classification a mangé plus de 65 % de l'original, on
       la jette et on ne droppe QUE les segments à mots-clés de pose. */
    if (base.split(/\s+/).length < prompt.split(/\s+/).length * 0.35) {
      const POSE_KEYS = /\b(pose|posing|kneel|kneeling|stand(?:ing)?|sit(?:ting)?|lying|lies|leans?|leaning|arch(?:ed|ing)?|glanc(?:e|ing)|looking (?:back|over)|crouch|walk(?:s|ing)?)\b/i
      const drop2 = new Set(segs.map((t, i) => (has('pose') && POSE_KEYS.test(t) ? i : -1)).filter(i => i >= 0))
      base = segs.filter((_, i) => !drop2.has(i)).join(' ')
      drop.clear(); for (const i of drop2) drop.add(i)
    }
    base = base.replace(/\s*,\s*,+/g, ', ').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ')
      .replace(/^[,\s]+|[,\s]+$/g, '').replace(/,\s*\./g, '.').replace(/\(\s*\)/g, '')
    // (b) scènes-concept : varier DANS le concept
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
    /* extraction résiliente : JSON → retry avec rappel → repli lignes. */
    const parseScenes = raw => {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        try {
          const parsed = JSON.parse(m[0])
          const arr = Array.isArray(parsed.scenes) ? parsed.scenes
            : Array.isArray(parsed.clauses) ? parsed.clauses : Array.isArray(parsed) ? parsed : []
          return arr.map(x => typeof x === 'string' ? x
            : (x && typeof x === 'object') ? (Object.values(x).find(v => typeof v === 'string') ?? '') : '')
        } catch { /* repli lignes */ }
      }
      // repli : lignes numérotées / puces / guillemets
      return raw.split('\n')
        .map(l => l.replace(/^\s*(?:scene\s*\d+\s*[:.)-]|\d+\s*[:.)-]|[-*"'`])\s*/i, '').replace(/["',]+\s*$/, '').trim())
        .filter(l => l.length > 12 && l.length < 420 && !/^(json|```|\{|\})/i.test(l))
    }
    let clRaw = await askOllama(model, clSys, clUser, { temperature: 0.75, num_predict: 1400, num_ctx: 6144 })
    let clauses = parseScenes(clRaw).map(x => x.trim()).filter(Boolean).slice(0, count)
    if (!clauses.length) {
      // 2e essai avec rappel strict
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

/* Carrousel v2 — copie de travail (server/carrousel.js). Le front appelle
   toujours /api/rewrite ; cette route sert aux essais avant bascule. */
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
  } catch { /* absent : vide */ }
  return { wildcards: out }
})

/* La bibliothèque est celle du personnage ACTIF : ?persona=<id> pour un
   autre, ?persona=all pour tout. */
app.get('/api/assets', async req => {
  const q = String(req.query.persona ?? '')
  const pid = q === 'all' ? undefined : q || personas().active || undefined
  return { personaId: pid ?? null, assets: store.listAssets(Number(req.query.limit) || 200, pid).map(assetOut) }
})

/* Suppression réelle : ligne d'asset, provenance, ET fichier sur disque.
   Ne pas effacer le fichier laisserait un média orphelin que plus rien ne
   référence — invisible dans l'interface, et pourtant sur le disque. */
/* Suppression = mise à la corbeille (11/10). Le fichier part dans
   media/.corbeille/, la ligne dans la table `corbeille` ; rien n'est effacé
   avant 30 jours. `POST /api/assets/restore` annule. */
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
      // Fichier déjà absent : la base est quand même nettoyée. Toute autre cause est signalée.
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

/** Aperçu d'un élément en corbeille : l'image elle-même, ou la vignette d'une vidéo. */
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

/** Purge : ce qui est en corbeille depuis plus de 30 jours est effacé pour de
 *  bon ; `tout` vide la corbeille entière (bouton « Vider la corbeille »). */
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
/* Vider la corbeille : effacement DÉFINITIF (fichiers et vignettes), sur
   confirmation dans l'interface. */
app.post('/api/corbeille/vider', async () => ({ effaces: purgerCorbeille(true) }))
purgerCorbeille()
setInterval(purgerCorbeille, 6 * 3600_000).unref()

/* ---------- extension vidéo : dernière frame → start-frame i2v ----------
   Une vidéo (uploadée dans input/ ou clip de la galerie) est prolongée en
   extrayant sa DERNIÈRE frame comme image de départ d'un i2v standard.
   `pick` : 'last' = la toute dernière ; 'sharp' = la plus nette de la
   dernière demi-seconde (le flou de mouvement de fin conditionne tout le
   rendu). Netteté mesurée par l'énergie de contours (sobel + signalstats,
   une passe ffmpeg) — métrique relative, comparée dans la fenêtre. */
/** Une image tirée d'une vidéo hérite de son origine : un rendu de la bibliothèque
 *  donne « genere », un fichier de input/ garde celle de son dépôt. */
const origineDe = videoPath => path.dirname(path.resolve(videoPath)) === path.resolve(CONFIG.comfyInput)
  ? (store.origineInput(path.basename(videoPath)) ?? 'inconnu') : 'genere'
function extractLastFrame(videoPath, pick = 'last') {
  /* Prequel (20/10) : la PREMIÈRE frame, qui devient la frame de fin du rendu. */
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
  // Scores de netteté des frames de la fenêtre de fin.
  const meta = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, dur - win)), '-i', videoPath,
    '-vf', 'sobel,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
  const scores = [...meta.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map(m => Number(m[1]))
  if (!scores.length) throw new Error('dernière frame non extractible (aucune frame décodée en fin de vidéo)')
  const last = scores.length - 1
  let idx = last
  if (pick === 'sharp') { for (let i = 0; i < scores.length; i++) if (scores[i] > scores[idx]) idx = i }
  const maxScore = Math.max(...scores)
  const blurry = scores[last] < 0.6 * maxScore
  // Extraction de la frame choisie, comptée depuis la fin de fenêtre.
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

/** Dernière frame d'une vidéo déjà dans input/ (upload). body: { file, pick } */
app.post('/api/input/last-frame', async (req, reply) => {
  const f = String(req.body?.file || '').trim()
  if (!f || /[\\/]/.test(f) || f.startsWith('.')) { reply.code(400); return { error: 'nom de fichier nu attendu (dossier input/)' } }
  const full = path.join(CONFIG.comfyInput, f)
  if (!(estProprietaire(req) ? store.estInputStudio : store.estInputGenere)(f) || !fs.existsSync(full)) { reply.code(404); return { error: `« ${f} » absent du dossier input/` } }
  try { return extractLastFrame(full, ['sharp', 'first'].includes(req.body?.pick) ? req.body.pick : 'last') }
  catch (e) { reply.code(422); return { error: String(e.message || e) } }
})

/* Une still de la bibliothèque vit dans creatoros-data/media/ ; un nœud
   LoadImage, lui, ne lit que le dossier input/ de ComfyUI. Animer une image
   déjà produite demande donc de l'y recopier — c'est tout ce que fait cette
   route, et elle rend le NOM, seule chose que le graphe sait manipuler.

   Copie et non lien symbolique : le média peut être supprimé de la
   bibliothèque entre le choix de la still et le lancement du rendu, et un
   lien mort ferait échouer le job à l'exécution, pas à la validation. */
app.post('/api/assets/:id/to-input', async (req, reply) => {
  const row = store.getAsset(req.params.id)
  if (!row) { reply.code(404); return { error: 'asset inconnu' } }
  if (!row.filename) { reply.code(400); return { error: 'asset sans fichier sur disque' } }
  const src = path.join(CONFIG.mediaDir, path.basename(row.filename))
  if (!fs.existsSync(src)) { reply.code(410); return { error: 'fichier absent du disque' } }
  /* Un clip vidéo ne sert pas d'image de départ tel quel — mais sa DERNIÈRE
     frame, si (extension vidéo, ?frame=last|sharp). */
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

/* « Ouvrir dans ComfyUI » (30/10) : le graphe exact envoyé pour ce rendu, au format API,
   à glisser dans ComfyUI ; chemins absolus réduits au nom du fichier. Avec la liste des
   modèles qu'il charge et leur licence, lue dans le manifeste de l'assistant. */
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
    // Quel préambule d'identité a réellement été injecté : sans lui, un asset
    // n'est pas rejouable à la relecture.
    identityPreamble: parse(p.identity_preamble),
    registerClause: p.register_clause,
    extraLoras: parse(p.extra_loras) ?? null,
    sourceImage: p.source_image,
    selections: parse(p.selections), injections: parse(p.injections),
    workflowJson: parse(p.workflow_json),
  }
})

/** Les LoRA qui ont RÉELLEMENT tourné, lues dans le graphe exécuté.
 *  `extra_loras` ne contient que celles ajoutées au job : celles de la recette
 *  n'y figurent pas. Or c'est justement l'empilement complet qui explique un
 *  rendu — une LoRA de style trop forte prend la main sur l'identité, et ça
 *  ne se voit qu'en lisant la pile
 *  entière. On la reconstruit donc depuis `workflow_json`, seule source qui dit
 *  ce qui a tourné plutôt que ce qui a été demandé. */
app.get('/api/assets/:id/loras', async (req, reply) => {
  const p = store.getProvenance(req.params.id)
  if (!p) { reply.code(404); return { error: 'provenance inconnue' } }
  const wf = parse(p.workflow_json)
  if (!wf) return { loras: [] }
  /* Les ajouts du job sont identifiés par leur nom de fichier : c'est la seule
     clé commune entre `extra_loras` et les nœuds du graphe. */
  const ajoutees = new Set((parse(p.extra_loras) ?? []).map(l => String(l.name)))
  const loras = Object.entries(wf)
    .filter(([, n]) => /Lora/i.test(String(n?.class_type)))
    .map(([node, n]) => ({ node, ...n.inputs }))
    .filter(l => l.lora_name && String(l.lora_name).toLowerCase() !== 'none')
    /* Ordre du graphe = ordre d'empilement, et il porte du sens : la dernière
       appliquée est celle qui tire le plus fort. Les ids sont numériques. */
    .sort((a, b) => Number(a.node) - Number(b.node))
    .map(l => ({
      node: l.node,
      name: String(l.lora_name),
      /* nom court pour l'affichage : sans le dossier ni l'extension */
      label: String(l.lora_name).split('/').pop().replace(/\.safetensors$/i, ''),
      strength: l.strength_model ?? l.strength ?? null,
      strengthClip: l.strength_clip ?? null,
      source: ajoutees.has(String(l.lora_name)) ? 'job' : 'recette',
    }))
  return { loras }
})

/** Revue manuelle — le garde-fou humain du modèle CreatorOS. */
/* Upscale d'un brouillon vidéo : copie le mp4 vers input/ et met un job
   « upscale » (V2V refine, mouvement conservé) dans la file standard. */
/* « Passer en HD » d'une PHOTO : agrandissement doux à 2 MP + affinage,
   visage repris de la source. `?strength=` règle le renforcement (0 à 0,4). */
app.post('/api/assets/:id/photo-hd', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a) { reply.code(404); return { error: 'asset inconnu' } }
  if (a.media_type !== 'photo') { reply.code(400); return { error: 'HD photo : images seulement' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier image introuvable' } }
  const inputName = `PHD_${Date.now().toString(36)}.png`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  /* Le prompt de l'affinage est celui qui a PRODUIT l'image, préambule
     d'identité compris : un texte étranger ferait dériver la scène. */
  const prov = store.getProvenance(a.id)
  let preamble = ''
  try { preamble = JSON.parse(prov?.identity_preamble ?? 'null')?.text ?? '' } catch { /* absent */ }
  const prompt = `${preamble}${prov?.composed_positive ?? ''}`.trim()
    || 'natural skin, soft matte finish, fine natural texture, faint soft freckles, raw unretouched phone photo'
  const { id } = deposerAvecCle(cleComfy(req), () => enqueuePhotoHd({
    sourceFile: inputName, parentAssetId: a.id, prompt, strength: Number(req.query?.strength),
  }))
  return { jobId: id }
})

/** Retouche au pinceau, image ou vidéo : `mask` = PNG (data URL) blanc sur noir, aux dimensions
 *  de l'image (pour une vidéo : peint sur sa première image ; `suivi` false = zone fixe) ;
 *  `prompt` = ce qui doit se trouver dans la zone peinte. */
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
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  fs.writeFileSync(path.join(CONFIG.comfyInput, maskName), Buffer.from(m[1], 'base64'))
  try {
    if (video) {
      const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaintVideo({ sourceFile: inputName, maskFile: maskName, parentAssetId: a.id,
        prompt, strength: Number(req.body?.strength), suivi: req.body?.suivi !== false }))
      return { jobId: id }
    }
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaint({
      sourceFile: inputName, maskFile: maskName, parentAssetId: a.id, prompt, strength: Number(req.body?.strength), personaId: personaDuRendu(a),
    }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Le personnage d'un rendu : celui de son job, pas le personnage actif du moment. */
const personaDuRendu = a => { const j = a.job_id ? store.getJob(a.job_id) : null; return a.persona_id ?? j?.persona_id ?? j?.personaId ?? undefined }

/* Agrandir une photo (30/10) : le cadre s'élargit au format demandé, l'image reste au centre et le
   pinceau redessine les bords (masque blanc, 24 px de recouvrement pour fondre la couture). */
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
  const k = Math.min(1, 1600 / Math.max(W, H))          // côté long borné : au-delà la recette sature
  const iw = pair(w * k), ih = pair(h * k); W = Math.max(pair(W * k), iw); H = Math.max(pair(H * k), ih)
  const cle = Date.now().toString(36)
  const entree = `AGR_${cle}.png`, masque = `AGR_${cle}_masque.png`, x = Math.floor((W - iw) / 2), y = Math.floor((H - ih) / 2)
  const e = [24, 24, 24, 24].map((m, i) => ((i < 2 ? (i ? H > ih : W > iw) : (i === 2 ? W > iw : H > ih)) ? m : 0))
  const ff = args => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { timeout: 30_000 })
  try {
    ff(['-i', src, '-filter_complex', `color=0x808080:s=${W}x${H}[f];[0:v]scale=${iw}:${ih}[i];[f][i]overlay=${x}:${y},format=rgb24`, '-frames:v', '1', path.join(CONFIG.comfyInput, entree)])
    ff(['-f', 'lavfi', '-i', `color=white:s=${W}x${H}`, '-f', 'lavfi', '-i', `color=black:s=${iw - e[0] - e[2]}x${ih - e[1] - e[3]}`, '-filter_complex', `[0][1]overlay=${x + e[0]}:${y + e[1]},format=rgb24`, '-frames:v', '1', path.join(CONFIG.comfyInput, masque)])
    const consigne = String(req.body?.prompt ?? '').trim() || 'Outpaint: replace the flat grey margins by extending the scene seamlessly, same place, same light, same style, photorealistic. Do not add any person. Keep the center unchanged.'
    const { id } = deposerAvecCle(cleComfy(req), () => enqueueInpaint({ sourceFile: entree, maskFile: masque, parentAssetId: a.id, prompt: consigne, strength: 1, personaId: personaDuRendu(a), agrandir: true }))
    return { jobId: id, largeur: W, hauteur: H }
  } catch (err) { reply.code(400); return { error: String(err.message || err) } }
})

/** Édition vidéo au prompt : `cible` = l'élément à modifier, nommé en anglais (SAM3 le
 *  détecte et le suit sur tout le clip) ; `prompt` = ce qu'il doit devenir. */
app.post('/api/assets/:id/edit-video', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a || a.media_type !== 'video') { reply.code(404); return { error: 'vidéo inconnue' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier vidéo introuvable' } }
  /* Trois façons (27/10) : modifier un élément, le retirer, ou changer le fond autour de la personne. */
  const mode = ['retirer', 'fond', 'detourer'].includes(req.body?.mode) ? req.body.mode : 'modifier'
  let prompt = String(req.body?.prompt ?? '').trim(), cible = String(req.body?.cible ?? '').trim()
  let strength = Number(req.body?.strength)
  if (mode === 'fond') cible = cible || 'person'
  if (mode === 'detourer') {
    try {
      const r = deposerAvecCle(cleComfy(req), () => enqueueDetour({ source: path.basename(src), cible, parentAssetId: a.id, personaId: a.persona_id }))
      return { jobId: r.id }
    } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  /* Retirer (30/10) : IC-LoRA LTX-2.5 Clean-Plate — personnes, passants, véhicules ;
     le décor est reconstruit derrière, le son d'origine gardé (cf. enqueueCleanPlate). */
  if (mode === 'retirer') {
    try {
      const r = deposerAvecCle(cleComfy(req), () => enqueueCleanPlate({ source: path.basename(src), cible: cible || 'people', decor: prompt,
        parentAssetId: a.id, personaId: a.persona_id }))
      return { jobId: r.id }
    } catch (e) { reply.code(400); return { error: String(e.message || e) } }
  }
  if (!cible) { reply.code(400); return { error: 'dis quel élément modifier (ex. « dress »)' } }
  if (mode === 'retirer') {
    // l'élément disparaît : on redessine sa zone en décor, plus fort qu'une simple modification
    // ne pas nommer l'objet ici : l'encodeur de texte ignore la négation, « without a cup » attire une tasse
    // (l'objet est mis dans le prompt négatif par runInpaintVideo)
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
      prompt, cible, strength, inverser: mode === 'fond', retirer: mode === 'retirer' }))
    return { jobId: id }
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/** Finitions d'un clip : bruitage (son sur un clip muet) et fluidité (RIFE ×2). */
for (const op of ['foley', 'interpolate']) {
  app.post(`/api/assets/:id/${op}`, async (req, reply) => {
    const a = store.getAsset(req.params.id)
    if (!a) { reply.code(404); return { error: 'asset inconnu' } }
    try { const r = deposerAvecCle(cleComfy(req), () => enqueueFinition({ op, asset: a, prompt: req.body?.prompt })); reply.code(202); return r }
    catch (e) { reply.code(400); return { error: String(e.message || e) } }
  })
}

app.post('/api/assets/:id/upscale', async (req, reply) => {
  const a = store.getAsset(req.params.id)
  if (!a) { reply.code(404); return { error: 'asset inconnu' } }
  if (a.media_type !== 'video') { reply.code(400); return { error: 'upscale : vidéos seulement' } }
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!fs.existsSync(src)) { reply.code(404); return { error: 'fichier vidéo introuvable' } }
  // cible ×1.5, multiples de 16, plafond 1280 sur le grand côté
  const r16 = v => Math.max(16, Math.round(v / 16) * 16)
  let w = r16((a.width || 544) * 1.5), h = r16((a.height || 800) * 1.5)
  const cap = 1280 / Math.max(w, h)
  if (cap < 1) { w = r16(w * cap); h = r16(h * cap) }
  /* Voie LATENT NATIF H3 (qualité supérieure, bench 17/09) : parent minimax
     dont la passe 1 est REJOUABLE — workflowJson en provenance et still
     d'entrée encore dans input/. Sinon : refine Wan (fallback universel). */
  /* Voie H3 désactivée par défaut (17/09 soir) : sur les scènes à fort
     mouvement (vagues, eau), l'upscaler latent strie les hautes fréquences
     sur TOUT le clip (6 jobs gaufrés) — le bench balcon (statique) ne le
     montrait pas. Réactivable au cas par cas : POST ...?path=h3 */
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
    } catch { /* provenance illisible : fallback Wan */ }
  }
  const inputName = `UPSC_${Date.now().toString(36)}.mp4`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, inputName))
  /* Cadence RÉELLE de la source : la recette refine forçait 16 fps et
     décimait un brouillon 30 fps (saccades, ups-mu443l82). */
  let fps = 16
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src], { encoding: 'utf8' })
    const [n, d] = out.trim().split('/').map(Number)
    if (n && d) fps = Math.round(n / d)
  } catch { /* ffprobe absent : 16 par défaut */ }
  // H3 : sortie 2x fixe des dims du draft (latent 2x), sinon cible Wan x1.5
  if (h3) { w = (a.width || 544) * 2; h = (a.height || 800) * 2 }
  const { id } = deposerAvecCle(cleComfy(req), () => enqueueUpscale({
    sourceFile: inputName, width: w, height: h, fps,
    videoEngine: a.video_engine ?? null,
    parentAssetId: a.id, sourceLabel: `#${a.job_id}`, h3,
  }))
  return { jobId: id, width: w, height: h, path: h3 ? 'latent-h3' : 'refine-wan' }
})

/* ---------- dossiers ---------- */
/* Comme la bibliothèque : les dossiers du personnage ACTIF (?persona=<id> pour un autre). */
const personaDe = req => String(req.query?.persona ?? '') || personas().active || null
app.get('/api/folders', async req => ({ folders: store.listFolders(personaDe(req)).map(f => ({ id: f.id, name: f.name, createdAt: f.created_at, count: f.count })) }))
app.post('/api/folders', async (req, reply) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) { reply.code(400); return { error: 'nom requis' } }
  const f = store.createFolder(name, personaDe(req))
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
/* ---------- montage (mini-éditeur de reel, cf. montage.js) ---------- */
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
/* ---------- presets en un clic : caméra et effets (cf. presets.js) ---------- */
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

/* ---------- avatar parlant (cf. jobs.js enqueueParole) ----------
   La voix est déposée dans input/ (LoadAudio n'y lit que là) et inscrite au
   registre des dépôts du studio, comme une photo. */
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
  try { duree = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(CONFIG.comfyInput, nom)], { encoding: 'utf8' }).trim()) || 0 } catch { /* illisible */ }
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
  try { return deposerAvecCle(cleComfy(req), () => enqueueParole({ image, audio: voix, texte: req.body?.texte, parentAssetId: a.id, personaId: a.persona_id })) }
  catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* ---------- re-shoot : le même plan, vu d'un autre angle (cf. jobs.js) ---------- */
app.post('/api/reshoot', async (req, reply) => {
  const a = store.getAsset(String(req.body?.assetId ?? ''))
  if (!a || a.media_type !== 'video' || !a.filename) { reply.code(400); return { error: 'choisis un clip de la bibliothèque' } }
  try {
    return deposerAvecCle(cleComfy(req), () => enqueueReshoot({ source: path.basename(a.filename), angle: String(req.body?.angle ?? ''),
      azimut: req.body?.azimut, elevation: req.body?.elevation, cles: req.body?.cles, texte: req.body?.texte, parentAssetId: a.id, personaId: a.persona_id }))
  } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})

/* scène 3D du clip (vue Re-shoot) : calculée une fois, puis servie depuis le cache */
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

/* ---------- reel en un clic (cf. reel.js) ---------- */
const reelOut = r => r && {
  ...r,
  plans: (r.plans ?? []).map(p => {
    const photo = p.photoAsset ? store.getAsset(p.photoAsset) : null, clip = p.clipAsset ? store.getAsset(p.clipAsset) : null
    const etat = j => j ? store.getJob(j)?.status ?? 'absent' : null
    /* clip rendu puis supprimé de la bibliothèque : le plan est écarté, on ne
       retombe pas sur sa photo (l'opérateur l'a jeté) */
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
app.delete('/api/reels/:id', async (req, reply) => reel.supprimerReel(req.params.id) ? { ok: true } : (reply.code(404), { error: 'reel inconnu' }))
app.post('/api/reels', async (req, reply) => {
  try { return reelOut(reel.realiser({ ...(req.body ?? {}), cle: cleComfy(req) })) } catch (e) { reply.code(400); return { error: String(e.message || e) } }
})
app.get('/api/montage/musiques', async () => ({ musiques: montage.listerMusiques() }))
app.post('/api/montage/musiques', async (req, reply) => {
  if (Buffer.isBuffer(req.body) && req.body.length > 40 * 1024 * 1024) { reply.code(413); return { error: 'fichier > 40 Mio' } }
  try { return montage.deposerMusique(req.headers['content-type'], req.query.name, req.body) }
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
  // Un seul registre : « sfw » est accepté (sans effet), tout autre est refusé.
  if (register && register !== 'sfw') {
    reply.code(400); return { error: 'registre invalide : seul « sfw » existe' }
  }
  if (reviewStatus) store.setReview(req.params.id, reviewStatus)
  if (exportReady !== undefined) store.setExportReady(req.params.id, exportReady)
  /* Caption modifiée à la main : on garde le texte tel quel (ponctuation,
     majuscules) — c'est l'opérateur qui a le dernier mot. */
  if (typeof caption === 'string') store.setCaption(req.params.id, caption.trim().slice(0, 120))
  return { ok: true }
})

/* ---------- captions des reels (cf. server/captions.js) ---------- */
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

/* ---------- fichiers ---------- */

await app.register(fastifyStatic, {
  root: CONFIG.mediaDir, prefix: '/media/', decorateReply: false,
  cacheControl: true, maxAge: '365d', immutable: true,
})

const hasDist = fs.existsSync(path.join(CONFIG.distDir, 'index.html'))
if (hasDist) {
  // preCompressed : .br/.gz écrits au build (scripts/precompresser.mjs), servis selon Accept-Encoding
  await app.register(fastifyStatic, { root: CONFIG.distDir, prefix: '/', decorateReply: true, preCompressed: true })
  // SPA : toute route inconnue hors /api rend l'index (routage côté client).
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api/') || req.raw.url.startsWith('/media/')) {
      reply.code(404).send({ error: 'introuvable' }); return
    }
    reply.sendFile('index.html')
  })
} else {
  app.log.warn(`front non compilé (${CONFIG.distDir} absent) — lancer « npm run build »`)
}

/* ---------- démarrage ---------- */

/* L'ancien faucheur reapOrphans() marquait ici TOUS les « queued » en
   bloqué — il datait d'avant la persistance de file et fauchait précisément
   ce que recoverQueue() sait maintenant relancer (constaté le 24/08 : un
   job en attente perdu à chaque redémarrage). recoverQueue() fait les deux
   gestes dans le bon ordre : les morts en plein rendu sont marqués, les
   « queued » repartent. */

/* Textes de façonnage : on écrit ceux qui MANQUENT, jamais ceux qui existent.
   Une installation neuve marche sans copie manuelle ; une modification de
   l'opérateur survit à tous les redémarrages. */
const seeded = prompts.seedPrompts()
if (seeded.length) app.log.info(`textes de façonnage créés : ${seeded.join(', ')}`)

/* La file survit aux redémarrages : ce qui était « queued » repart, ce qui
   était en plein rendu est ré-attaché (ComfyUI vivant) ou re-soumis
   (ComfyUI redémarré). Attend ComfyUI avant de trancher. Non bloquant pour
   l'écoute HTTP : l'attente peut durer le temps d'un boot complet. */
void recoverQueue().catch(e => console.error('[reprise]', e.message || e))
reel.demarrerSuivi()
presets.demarrerSuites()

/* Diagnostic au démarrage, puis toutes les 30 min : une panne d'environnement
   (pilote, Python, extension, fichier de modèle) est annoncée dans le journal
   et par le voyant de l'interface, au lieu d'être découverte par un rendu raté. */
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
