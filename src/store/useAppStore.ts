/* ============================================================
   Global store (zustand) — console state + jobs + assets.
   One store, split by domain. Components read slices; all
   submission logic goes through here.
   ============================================================ */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { CONTROLNET_AVAILABLE } from '../core/capabilities'
import type {
  MediaMode, Register, Job, Asset,
  PhotoSelections, VideoSelections, SonSelections } from '../types'
import { buildPhotoPrompt, buildVideoPrompt } from '../core/promptBuilder'
import type { Garderobe, LoraInfo, LoraPick, PersonaCredit, PhotoEngine } from '../types'
import { GARDEROBE_VIDE } from '../types'
import { composer } from '../core/composer'
import type { FolderSort } from '../lib/folders'
import { validateT0 } from '../core/validator'
import { SANS_PERSONNAGE, personnageChoisi, retenirPersonnage } from '../lib/personnage'
import { worker, fetchAssets, pushReview, deleteAsset as apiDeleteAsset, cancelJob as apiCancelJob } from '../worker/apiWorker'
import { OUTFITS, ENVIRONMENTS, STYLES, MUSIC_LIBRARY, firstId } from '../data/vocabularies'
import { allTextPoses, allStyles } from './useVocabStore'
import { setEngineCatalog } from '../features/console/video/engines'
import { setT0Blocklist } from '../core/validator'
import { audioEffective, engineInfo, moteurT2v, VIDEO_ENGINES } from '../features/console/video/engines'
import type { RenderRates } from '../lib/progress'
import { t, tServeur } from '../i18n'

/** Composition tab: mode + task (photo:generate, video:i2v, video:motion_pure…). */
const ongletDe = (s: { mode: string; photo: { task: string }; video: { task: string } }) =>
  s.mode === 'video' ? `video:${s.video.task}` : `photo:${s.photo.task}`

/* ---------- State ---------- */

export interface StageScene { objets: { type: 'personne' | 'boite' | 'modele'; x: number; z: number; h: number; l?: number; p?: number; rot?: number; modele?: string }[]; camera: { oeil: number[] }[]; prompt: string }

interface AppState {
  /* Navigation */
  mode: MediaMode
  /** Character display name, configured on the server (/api/health). */
  personaName: string
  /** Active character (server id): the library shows only its renders. */
  personaId: string | null
  /** Does the active character have a FLUX.2 Klein identity LoRA? Otherwise the Klein recipe is disabled. */
  personaKlein: boolean
  /** the character has a Krea LoRA: without it, Krea does not hold its face */
  personaKrea: boolean
  personaFlux3: boolean
  /** Does the active character have a video LoRA? Text → video can then show it. */
  personaVideo: boolean
  /** The character's video LoRA is a Wan LoRA (text → video on Wan T2V). */
  personaVideoWan: boolean
  /** Active character's LoRA credit (author, page, license). */
  personaCredit: PersonaCredit | null
  /** Active character's wardrobe: favorite items (outfits, locations) and free lines. */
  personaGarderobe: Garderobe
  /** character voice (Kokoro id or "clone:<sample>"), for the reel voice-over and the talking avatar */
  personaVoix: string | null
  setGarderobe: (g: Garderobe) => Promise<string | null>
  /** Persona profile photo URL (with ?v= token), null = neutral circle. */
  personaAvatar: string | null
  uploadPersonaAvatar: (file: File) => Promise<void>
  /** Reloads the active character (name, photo) — after a character change. */
  refreshPersona: () => Promise<void>
  /** Character for upcoming renders, specific to this browser. */
  /** Character of the current page (same effect as choisirPersonnagePage). */
  choisirPersonnage: (id: string) => Promise<void>
  /** Character of the current page only (page selector, carousel); other pages keep theirs. */
  choisirPersonnagePage: (id: string) => Promise<void>
  /** Entering a page: its own character, else the studio default. */
  entrerPage: (page: string) => Promise<void>
  pageCourante: string
  /** Asset to open in large view (⌘K palette → gallery). Consumed then reset to null. */
  focusAssetId: string | null
  setFocusAsset: (id: string | null) => void
  /** What the server prepends to the prompt, read from /api/health (4-layer block). */
  serverInfo: { preambles: Record<string, string>; composerModels: Record<string, string>; renderRates: RenderRates | null } | null
  promoteJob: (id: string) => Promise<void>
  /** PERMANENT deletion of a finished/blocked job: the row, its renders and
   *  their files (server cascade). Returns the number of renders removed. */
  deleteJob: (id: string) => Promise<number>
  uploadExtendVideo: (file: File) => Promise<void>
  pickExtendClip: (assetId: string) => Promise<void>
  setExtendPick: (pick: 'last' | 'sharp') => Promise<void>
  setExtendPrequel: (on: boolean) => Promise<void>
  extractExtendFrame: () => Promise<void>
  /** New queue order (ids of waiting jobs, in the desired order). */
  reorderJobs: (ids: string[]) => Promise<void>

  /* Per-mode selections */
  photo: PhotoSelections
  video: VideoSelections
  son: SonSelections

  /* Prompt (column 3) */
  userPrompt: string          // auto from selectors, editable
  promptTouched: boolean      // true once the user edits by hand
  userDirectives: string
  composedPositive: string
  composedNegative: string
  /** Auto prompt as it was AT composition time. Used to tell whether the
   *  composed prompt was left behind by a selector change: the composed
   *  prompt is what is sent, so a stale one would silently win over newer
   *  selections. */
  composedFrom: string
  /** Tab where the composed prompt was written (mode + task): it is only sent from there. */
  composedFor: string
  composing: boolean
  t0Error: string | null
  /** SOUL/MOOD rewriter layers (default null = OFF). Passed to the
   *  composer; null → composed prompt identical to having no layer. */
  soulLayer: string | null
  moodLayer: string | null
  seedMode: 'lock' | 'random'
  seedValue: number
  /** Seed ACTUALLY drawn by the server for the last job. In random mode
   *  this is the only way to reproduce a render just seen. */
  lastSeed: number | null

  /* Additional LoRAs stacked on the identity (pose/style).
     The OFFERED list comes from the backend — never hard-coded here: it
     depends on what is actually present in ~/models/loras. */
  loraCatalog: LoraInfo[]
  loraPicks: LoraPick[]

  /* Jobs & assets */
  jobs: Job[]
  assets: Asset[]

  /* Gallery */
  galleryColumns: number
  /** Library density. SEPARATE from `galleryColumns`: column 4 is 300 px
   *  wide while the Library fills the screen, so a shared value would give
   *  tiny thumbnails on one side or a single column on the other. */
  libraryColumns: number
  /** Folder order — one setting for ALL folder lists (sidebar, "Move to…"
   *  menu, detail sheet, mobile sheet). */
  folderSort: FolderSort
  setFolderSort: (v: FolderSort) => void

  /* Number of renders started by "Envoyer" — 1 to 5, same prompt. */
  batchCount: number
  /** Photo batch variation axis (seed by default). */
  /** Carousel: the batch keeps outfit and location, changes pose, framing and
   *  focal length on each image (same seed). Unchecked: N images of the same
   *  prompt, different seeds. Independent of the render count. */
  carousel: boolean

  /* Carousel — PER-LINE recipe LOCKS: closed (true) = fixed value for the
   *  whole batch; open (false) = varies per image (drawn client-side).
   *  All closed by default. The carousel is active as soon as one lock is open. */
  locks: Record<'env' | 'outfit' | 'pose' | 'style', boolean>
  toggleLock: (k: 'env' | 'outfit' | 'pose' | 'style') => void

  /* Expert mode: hides explanatory help texts (input note, inferred chain)
   *  and shows the compact chain. Display preference. */
  expert: boolean
  toggleExpert: () => void

  /** "LE TEXTE" panel (bottom strip of the workbench) collapsed. Display preference. */
  textCollapsed: boolean
  toggleTextCollapsed: () => void

  /* Library: review actions (the manual safeguard lives here) */
  reviewAsset: (id: string, status: Asset['reviewStatus']) => void
  toggleExportReady: (id: string) => void
  /** Burned-in reel caption, typed by hand or picked from suggestions. */
  setCaption: (id: string, caption: string) => void
  /** Idempotency key of the submission IN PROGRESS. Set on the first attempt,
   *  kept until it succeeds (a retry reuses the same key and the server
   *  returns the job already created), cleared after success: the next
   *  submission is a new intent, hence a new key. */
  requestId: string | null
  /** Permanent deletion: row, provenance and file on disk. */
  removeAsset: (id: string) => Promise<void>
  /** Batch deletion, tolerant of partial failures. Returns what was actually
   *  deleted so the view can report it. */
  removeAssets: (ids: string[]) => Promise<{ removed: number; failed: string[] }>
  /** Latest deletions (server-side trash): used to offer "undo". */
  lastDeleted: { ids: string[]; at: number } | null
  dismissDeleted: () => void
  undoDelete: () => Promise<string | null>
  setBatchCount: (n: number) => void
  setCarousel: (on: boolean) => void
  /** Clears outfit, location, pose and style: the auto text becomes empty, the operator drives via the prompt. */
  clearComposition: () => void
  /** "Animer" from a photo: switches to video i2v with this still. */
  animateFrom: (asset: Asset) => Promise<void>
  boucleFrom: (asset: Asset) => Promise<void>
  stageOuvert: boolean
  /** the library opens on its music */
  ongletMusiques: boolean
  /** audio page tab: music studio, voice studio, sound effects */
  ongletAudio: 'musique' | 'voix' | 'bruitage'
  /** Optional MiniMax H3: installed, and allowed on this instance. */
  h3: { demo: boolean; installe: boolean; disponible: boolean } | null
  /** configuration tab requested by another screen */
  ongletConfig: 'cloud' | 'vocab' | 'workbench' | 'modeles' | null
  /** family opened in the gallery (Camera Moves or Effects), requested by the menu */
  famillePresets: 'camera' | 'effet' | null
  /** tab opened in Extensions, requested by the menu */
  ongletExtensions: 'tout' | 'comfy' | 'lora' | null
  /** initial setting requested by the menu for the opened page (Restore HD only, Voice clone…) */
  demandeOutil: 'hd' | 'cloner' | 'changer' | null
  /** the tool opened in the dedicated page ("tool" section) */
  outilDedie: import('../v2/OutilsDedies').IdOutil
  stageRepris: StageScene | null
  ouvrirStage: (scene?: StageScene | null) => void
  /** "Retoucher" from a photo: switches to photo/edit, source image. */
  retouchFrom: (asset: Asset) => Promise<void>
  /** "Prolonger" from a video: switches to video/extend, this clip as source. */
  extendFrom: (asset: Asset) => Promise<void>

  /* Actions */
  /** Loads the persisted library (SQLite → gallery) at startup. */
  hydrate: () => Promise<void>
  /** Reloads an asset into the console (columns 2 & 3), in ONE atomic set. */
  cloneFrom: (asset: Asset) => void
  /** Tracks a job created on the server (brush retouch, etc.): it appears in the UI queue. */
  adoptServerJob: (id: string) => Promise<void>
  /** Navigation request set by clone: the console lives in the Image/Video
   *  sections, but cloning also happens from Assets (or another section),
   *  so the settings must not land in an invisible console. The nonce forces
   *  handling even if the target does not change. Consumed by the shell (V2App). */
  navRequest: { section: 'image' | 'video' | 'presets' | 'parole' | 'reshoot' | 'config' | 'nouveau-personnage' | 'outil' | 'son' | 'cinema'; nonce: number } | null
  /** "Utiliser dans…": the media the target section picks up when it opens,
   *  then clears. Sections keep their source in local state; this field is the only bridge. */
  passerelle: { cible: 'presets' | 'parole' | 'reshoot'; assetId: string } | null
  utiliserDans: (cible: 'presets' | 'parole' | 'reshoot', asset: Asset) => void
  /** opens Movie Studio (the editing timeline is already filled) */
  allerCinema: () => void
  /** Reference images for the next photo (FLUX.2 Klein), at most 6. */
  references: { file: string; uri: string }[]
  /** what a click just brought (Animer, Retoucher, frame pick…): when, and which slots */
  chargementImage: { t: number; champs: string[] }
  /** on arrival at Image / Video without an image brought by a click: empty slots */
  viderImagesSiArriveeLibre: () => void
  ajouterReference: (asset: Asset) => Promise<void>
  /** a photo from the computer as reference (on the demo: checked, no person) */
  deposerReference: (f: File) => Promise<void>
  retirerReference: (file: string) => void
  prendrePasserelle: (cible: 'presets' | 'parole' | 'reshoot') => Asset | null
  setMode: (m: MediaMode) => void
  /** prompts separated per mode: each section gets its own text back. */
  promptStash: Partial<Record<MediaMode, { text: string; touched: boolean }>>
  /** original brief overwritten by the Enhancer's "Remplacer" (provenance). */
  initialBrief: string | null
  /* VLM description of the still, kept when the Enhancer is applied. It is
     sent with the job so it can be read in the detail view: a surprising
     composed prompt comes either from a misread image or from an ignored
     instruction, and this is needed to tell which. */
  promptVision: string | null
  updatePhoto: (patch: Partial<PhotoSelections>) => void
  updateVideo: (patch: Partial<VideoSelections>) => void
  /** Named LoRA stacks, per engine family ('photo', 'h3', 'wan', 'ltx'). */
  loraStacks: Record<string, { name: string; items: LoraPick[] }[]>
  /** Last video LoRAs used per family: restored when returning to the engine. */
  lastVideoLoras: Record<string, LoraPick[]>
  saveLoraStack: (cle: string, name: string, items: LoraPick[]) => void
  deleteLoraStack: (cle: string, name: string) => void
  updateSon: (patch: Partial<SonSelections>) => void
  setUserPrompt: (v: string) => void
  /** Cancels manual editing and resyncs the auto prompt with the selectors.
   *  Without it, `promptTouched` is one-way: a single keystroke would freeze
   *  the prompt for the whole session. */
  resetPrompt: () => void
  setUserDirectives: (v: string) => void
  setSoulLayer: (v: string | null) => void
  setMoodLayer: (v: string | null) => void
  /** Loads the actual LoRA inventory from the backend. */
  loadLoras: () => Promise<void>
  toggleLora: (name: string) => void
  setLoraStrength: (name: string, strength: number) => void
  toggleVideoLora: (name: string) => void
  setVideoLoraStrength: (name: string, strength: number) => void
  setVideoLoraTrigger: (name: string, trigger: string) => void
  clearVideoLoras: () => void
  setLoraTrigger: (name: string, trigger: string) => void
  clearLoras: () => void
  setComposed: (pos: string, neg: string) => void
  setGalleryColumns: (n: number) => void
  setLibraryColumns: (n: number) => void
  toggleSeedMode: () => void
  /** Direct seed input in lock mode. */
  setSeedValue: (v: number) => void
  /** batchId forced on the next submitJob (carousel) — consumed then reset to null. */
  carouselBatchId: string | null
  setCarouselBatchId: (v: string | null) => void
  carouselLocks: Record<string, boolean> | null
  setCarouselLocks: (v: Record<string, boolean> | null) => void
  /** Operator prompt at the origin of the lineage, carried by a carousel's jobs:
   *  a carousel restarted from one of its shots starts from it. */
  carouselPromptRacine: string | null
  setCarouselPromptRacine: (v: string | null) => void
  /** Photo size (v2): dimensions sent with the job. null = recipe default. */
  photoSize: { w: number; h: number; label: string } | null
  photoEngine: PhotoEngine
  setPhotoEngine: (e: PhotoEngine) => void
  setPhotoSize: (v: { w: number; h: number; label: string } | null) => void
  composeNow: () => Promise<void>
  /** Instruction-based edit: source image from disk… */
  uploadEditSource: (file: File) => Promise<void>
  /** …or from the gallery (copied into input/ via /api/assets/:id/to-input). */
  pickEditSource: (assetId: string) => Promise<void>
  /** Same upload as above, for the ControlNet reference image. */
  uploadCnRef: (file: File) => Promise<void>
  /** Picks a library still as the video start image. The server copies it
   *  into ComfyUI's input/ folder and returns the NAME: the only thing a
   *  LoadImage node can read. */
  pickStartFrame: (assetId: string) => Promise<void>
  /** End frame (arrival keyframe, MiniMax H3 engines): copied into
   *  ComfyUI's input like the start frame. */
  pickEndFrame: (assetId: string) => Promise<void>
  /** Upload of a start image from disk (outside the library). */
  uploadStartFrame: (file: File) => Promise<void>
  /** Inspirations: the starter photo shipped with the studio, placed by the server like a render. */
  poserDepartInspiration: (id: string) => Promise<void>
  /** Upload of the Motion Control driver video. */
  uploadMotionDriver: (file: File) => Promise<void>
  /** Upload of the Motion Control still (direct reference). */
  uploadMotionStill: (file: File) => Promise<void>
  /** Motion Control still picked from the library. */
  pickMotionStill: (assetId: string) => Promise<void>
  /** Cancels a queued or running job. Returns the failure message, if any. */
  /** Reruns a finished job with its original settings; returns the error message, or null. */
  retryJob: (id: string, draft?: boolean, nouvelleGraine?: boolean) => Promise<string | null>
  /** "Encore une": reruns a render's job with its settings and a new seed. */
  encoreUne: (asset: Asset) => Promise<string | null>
  cancelJob: (id: string) => Promise<string | null>
  submitJob: () => Promise<void>

  /** Mobile submit: submits and reports whether it went through (banner otherwise). */
  submitJobMobile: () => Promise<boolean>
  /** Jobs tab "↻ seed": same recipe, re-drawn seed, without reopening the
   *  composition. Relies on what the job list exposes. */
  relaunchJob: (jobId: string) => Promise<void>
}

/* ---------- Defaults ---------- */

/* Defaults = first items of each vocabulary. */
const defaultPhoto: PhotoSelections = {
  task: 'generate',
  outfitId: firstId(OUTFITS),
  outfitOverrides: {},
  textPoseId: null,
  environmentId: firstId(ENVIRONMENTS),
  styleId: firstId(STYLES),
  cnRefUri: '',
  cnRefName: '',
  cnRefFile: '',
  cnUploadState: 'idle',
  cnUploadError: '',
  cnType: 'depth',
  cnStrength: 0.7,
  cnRefW: 0,
  cnRefH: 0,
  editSourceUri: '',
  editSourceName: '',
  editSourceFile: '',
  editStyle: null,
  editSourceAssetId: null,
  editUploadState: 'idle',
  editUploadError: '',
}

/** A click just brought an image into a slot: it is kept on arrival at Image / Video (4 s). */
function marquerChargement(set: (p: { chargementImage: { t: number; champs: string[] } }) => void, get: () => { chargementImage: { t: number; champs: string[] } }, champ: string) {
  const c = get().chargementImage, t = Date.now()
  set({ chargementImage: { t, champs: t - c.t < 4000 ? [...c.champs, champ] : [champ] } })
}
/** Browsers keep the old hidden motion default: cleared on reload. */
const ANCIEN_MOUVEMENT = 'gentle breathing, hair moving slightly, a soft smile toward the camera'
function sansAncienDefaut<T extends { motionText: string; cameraText: string }>(v: T): T {
  if (v.motionText !== ANCIEN_MOUVEMENT) return v
  return { ...v, motionText: '', cameraText: v.cameraText === 'slow push-in' ? '' : v.cameraText }
}
const defaultVideo: VideoSelections = {
  task: 'i2v',
  // Wan by default: silent, but it renders the cleanest image,
  // and a clean silent shot can be fixed in editing while a dirty one cannot.
  engine: 'wan',
  withAudio: false,
  audioText: '',
  startFrameFile: '', startFrameUri: '', startFrameError: '',
  startFrameW: 0, startFrameH: 0,
  startAssetId: null, middleAssetId: null, endAssetId: null, endFrameFile: '', endFrameError: '',
  motionRefUri: '', motionRefName: '',
  motionDriverFile: '', motionDriverError: '', motionPreview: false, motionDriverSeconds: 0, motionDriverFrames: 0,
  extendSource: 'upload', extendVideoFile: '', extendAssetId: null, extendVideoUri: '', extendError: '', extendPick: 'last', extendWarn: '', extendConcat: false,
  motionStillFile: '', motionStillUri: '', motionStillError: '', motionStillAssetId: null,
  motionSceneText: '', motionPoseStrength: 1, mixDebut: 0, mixPersonnes: [], motionRefStrength: 1, motionMode: 'animate',
  multiShot: false, draft: false, videoLoras: [],
  motionOutFps: 'origine', motionOutRes: 'origine',
  /* Empty: these two fields have no screen; any default here would be sent
     as the prompt whenever nothing is typed. */
  motionText: '',
  cameraText: '',
  motionStrength: 0.3,
  durationS: 5, fps: 24, aspect: 'origine',
}

const defaultSon: SonSelections = {
  layer: 'voix',
  emotion: 'posé, joueur', pace: 'naturel',
  script: '', prosodyDirective: '',
  ambianceText: '', musicTrackId: MUSIC_LIBRARY[0].id,
  projectId: 'proj-12',
}

/* Job ids are the SQLite primary key: two browser sessions must not
   produce the same one. The counter stays readable (#443); a session
   suffix makes it unique over time. */
let jobCounter = 442
/** Keyframe engines (MiniMaxH3ImageToVideo: first_frame / last_frame). */
const H3: string[] = ['minimax']
/** Engines that can end on an end frame: H3 (last_frame), Wan (FirstLastFrame), LTX (guide on last frame). */
const FIN_OK: string[] = [...H3, 'wan', 'ltx', 'ltx_hq']
/** A video LoRA named "…wan…" (high/low noise pair): identity carried by Wan. */
const estLoraWan = (l: unknown[] | undefined) => (l ?? []).some(x => /wan/i.test(String((x as { name?: string })?.name ?? '')))
/** A batch submission is in progress (POSTs go out one by one). */
let envoiEnCours = false
const SESSION_TAG = Math.random().toString(36).slice(2, 6)

/** Conditioning references derived from the selections
 *  (source image, frames, motion reference video…). */
function buildConditioningRefs(
  mode: MediaMode,
  sel: PhotoSelections | VideoSelections | SonSelections,
): Job['conditioningRefs'] {
  const refs: Job['conditioningRefs'] = []
  if (mode === 'photo') {
    const p = sel as PhotoSelections
    if (p.task === 'edit' && p.editSourceUri) refs.push({ type: 'edit_source', uri: p.editSourceUri })
  }
  if (mode === 'video') {
    const v = sel as VideoSelections
    if (v.startAssetId) refs.push({ type: 'frame_start', uri: v.startAssetId })
    if (v.middleAssetId) refs.push({ type: 'frame_middle', uri: v.middleAssetId })
    if (v.endAssetId) refs.push({ type: 'frame_end', uri: v.endAssetId })
    if (v.task === 'motion_pure' && v.motionRefUri)
      refs.push({ type: 'motion_ref_video', uri: v.motionRefUri, weight: v.motionStrength })
  }
  return refs
}

/** Latent dimensions at a reference's ASPECT, ~1 Mpx, multiples of 16.
 *  Returns {} if the reference has no known size: the recipe then keeps
 *  its default instead of receiving made-up dimensions. */
function latentFor(w: number, h: number): { width?: number; height?: number } {
  if (!w || !h) return {}
  const k = Math.sqrt(1_000_000 / (w * h))
  const r = (v: number) => Math.max(256, Math.round((v * k) / 16) * 16)
  return { width: r(w), height: r(h) }
}

/** Removes the shot markers added at video SUBMISSION. Otherwise a clone
 *  starts from a prompt that already carries them and submission appends
 *  them again, stacking on each clone. */
function stripShotMarkers(p: string): string {
  return p
    .replace(/^multi-shot sequence with cinematic cuts\.\s*/i, '')
    .replace(/[.\s]*\bsingle continuous shot, no cuts\b[.\s]*$/i, '')
}

/* ---------- Store ---------- */

/** A job as returned by the API → the store Job (resume after reload, rerun). */
function jobFromApi(j: Record<string, unknown>): Job {
  return {
            id: j.id as string, createdAt: j.createdAt as number,
            personaId: (j.personaId as string) ?? 'default',
            register: 'sfw',
            mode: (j.mode as Job['mode']) ?? 'photo',
            purpose: 'creative' as const,
            recipeId: (j.recipeId as string) ?? '',
            selections: (j.selections as Job['selections']) ?? ({} as Job['selections']),
            seed: Number.isFinite(j.seed as number)
              ? { mode: 'lock' as const, value: j.seed as number }
              : { mode: 'random' as const },
            userPrompt: (j.userPrompt as string) ?? '',
            userDirectives: (j.userDirectives as string) ?? '',
            composedPositive: (j.composedPositive as string) ?? '',
            composedNegative: (j.composedNegative as string) ?? '',
            conditioningRefs: [], loras: [],
            status: j.status as Job['status'],
            startedAt: (j.startedAt as number | null) ?? null,
            durationMs: (j.durationMs as number | null) ?? null,
            estimatedMs: (j.estimatedMs as number | null) ?? null,
            videoEngine: (j.videoEngine as Job['videoEngine']) ?? undefined,
            videoDraft: j.videoDraft ? true : undefined,
            error: (j.error as string | null) ?? null,
  }
}

/* Persistence: display preferences ONLY.
   `partialize` is required for correctness: without it, `jobs` and
   `assets` would go to localStorage and the gallery would reload a stale
   snapshot, racing `hydrate()` which reads the database. Server data must
   come from the server. */
let suiviFileLance = false
/* The character chosen WITHIN a page, per page, for the tab (sessionStorage). */
const CLE_PAGES = 'creatoros.personnagesPages'
function lirePersonnagesPages(): Record<string, string> { try { return JSON.parse(sessionStorage.getItem(CLE_PAGES) || '{}') } catch { return {} } }
function ecrirePersonnagesPages(v: Record<string, string>) { try { sessionStorage.setItem(CLE_PAGES, JSON.stringify(v)) } catch { /* storage unavailable */ } }

export const useAppStore = create<AppState>()(persist((set, get) => {
  // Single subscription to worker updates (mock or real).
  worker.onUpdate((job, asset) => {
    // a submission rejected by the server (safeguard, missing file…): the reason is shown under the prompt
    if ((job as Job & { refusEnvoi?: boolean }).refusEnvoi && job.error) set({ t0Error: tServeur(job.error) ?? job.error })
    set(s => ({
      jobs: s.jobs.map(j => (j.id === job.id ? job : j)),
      // a render of another character (started before a switch) does not enter the grid
      assets: asset ? [asset, ...s.assets] : s.assets,
      // In random mode the seed is drawn server-side: without this,
      // the operator sees an image they cannot reproduce.
      lastSeed: Number.isFinite(job.seed?.value) ? (job.seed!.value as number) : s.lastSeed,
    }))
  })

  return {
    mode: 'photo',
    personaName: 'Personnage',
    personaId: null,
    personaKlein: false,
    personaKrea: true,
    personaFlux3: false,
    personaVideo: false,
    personaVideoWan: false,
    personaCredit: null,
    personaGarderobe: GARDEROBE_VIDE,
    personaVoix: null,
    setGarderobe: async g => {
      const id = get().personaId
      if (!id) return t('aucun personnage actif')
      const prev = get().personaGarderobe
      set({ personaGarderobe: g })
      const r = await fetch(`/api/personas/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ garderobe: g }) })
      if (!r.ok) { set({ personaGarderobe: prev }); return tServeur(((await r.json().catch(() => ({}))) as { error?: string }).error) ?? `HTTP ${r.status}` }
      return null
    },
    personaAvatar: null,
    focusAssetId: null,
    setFocusAsset: id => set({ focusAssetId: id }),
    serverInfo: null,
    promoteJob: async id => { await fetch(`/api/jobs/${id}/promote`, { method: 'POST' }) },
    deleteJob: async id => {
      const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(tServeur((body as { error?: string }).error) ?? `HTTP ${res.status}`)
      set(s => ({ jobs: s.jobs.filter(j => j.id !== id), assets: s.assets.filter(a => a.jobId !== id) }))
      return (body as { assetsRemoved?: number }).assetsRemoved ?? 0
    },
    reorderJobs: async ids => {
      await fetch('/api/jobs/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      // Reflect the order locally: waiting jobs in the requested order,
      // the others unchanged in place.
      set(s => {
        const queued = s.jobs.filter(j => j.status === 'queued')
        const byId = new Map(queued.map(j => [j.id, j]))
        const ordered = ids.map(id => byId.get(id)).filter((j): j is Job => !!j)
        const rest = queued.filter(j => !ids.includes(j.id))
        let k = 0
        const seq = [...ordered, ...rest]
        return { jobs: s.jobs.map(j => (j.status === 'queued' ? seq[k++] : j)) }
      })
    },
    loraCatalog: [],
    loraPicks: [],
    photo: defaultPhoto,
    video: defaultVideo,
    son: defaultSon,

    userPrompt: buildPhotoPrompt(defaultPhoto),
    promptTouched: false,
    promptStash: {},
    initialBrief: null,
    promptVision: null,
    navRequest: null,
    passerelle: null,
    requestId: null,
    userDirectives: '',
    composedPositive: '',
    composedNegative: '',
    composedFrom: '',
    composedFor: '',
    composing: false,
    t0Error: null,
    soulLayer: null,
    moodLayer: null,
    /* RANDOM by default: a fixed seed would make renders look alike for no
       visible reason. Locking stays one click away, as a deliberate action. */
    seedMode: 'random',
    seedValue: Math.floor(Math.random() * 0xffffffffffff),
    lastSeed: null,

    jobs: [],
    assets: [],
    galleryColumns: 4,
    libraryColumns: 6,
    folderSort: 'recent',
    batchCount: 1,
    carousel: false,
    locks: { env: true, outfit: true, pose: true, style: true },
    toggleLock: k => set(s => ({ locks: { ...s.locks, [k]: !s.locks[k] } })),
    expert: false,
    toggleExpert: () => set(s => ({ expert: !s.expert })),
    textCollapsed: false,
    toggleTextCollapsed: () => set(s => ({ textCollapsed: !s.textCollapsed })),

    // Clamped here rather than at render time: a component sending 50 jobs
    // would saturate the queue for a quarter of an hour.
    setBatchCount: n => set({ batchCount: Math.max(1, Math.min(10, Math.round(n))) }),
    setCarousel: carousel => set({ carousel }),
    clearComposition: () => get().updatePhoto({ outfitId: null, environmentId: null, styleId: null, textPoseId: null, outfitOverrides: {}, weatherOverride: undefined }),
    /* These three take the operator ELSEWHERE, so they set the same navigation
       request as clone. The desktop passes its own callbacks (goVideo/goImage)
       and ignores the field; mobile only has this channel. */
    references: [],
    chargementImage: { t: 0, champs: [] },
    viderImagesSiArriveeLibre: () => {
      /* Arriving on Image or Video: only the slots a click just filled (under 4 s: Animer → start,
         "Frame fin" → end, Retoucher → source…) keep their image; everything else is cleared,
         so no stale frame from an earlier setting carries over. */
      const c = get().chargementImage
      const garde = new Set(Date.now() - c.t < 4000 ? c.champs : [])
      if (garde.has('tout')) return
      set(st => ({
        ...(garde.has('refs') ? {} : { references: [] }),
        photo: { ...st.photo,
          ...(garde.has('edit') ? {} : { editSourceUri: '', editSourceName: '', editSourceFile: '', editSourceAssetId: null, editUploadState: 'idle' as const, editUploadError: '' }),
          ...(garde.has('cn') ? {} : { cnRefUri: '', cnRefName: '', cnRefFile: '', cnUploadState: 'idle' as const, cnUploadError: '', cnRefW: 0, cnRefH: 0 }) },
        video: { ...st.video,
          ...(garde.has('start') ? {} : { startAssetId: null, startFrameFile: '', startFrameUri: '', startFrameError: '', startFrameW: 0, startFrameH: 0 }),
          ...(garde.has('end') ? {} : { endAssetId: null, endFrameFile: '', endFrameError: '' }),
          middleAssetId: null,
          ...(garde.has('extend') ? {} : { extendVideoFile: '', extendAssetId: null, extendVideoUri: '', extendError: '', extendWarn: '', extendEndFile: '' }),
          ...(garde.has('still') ? {} : { motionStillFile: '', motionStillUri: '', motionStillError: '', motionStillAssetId: null }),
          ...(garde.has('driver') ? {} : { motionDriverFile: '', motionDriverError: '', motionDriverSeconds: 0, motionDriverFrames: 0, motionRefUri: '', motionRefName: '' }) },
      }))
    },

    ajouterReference: async asset => {
      marquerChargement(set, get, 'refs')
      if (get().references.length >= 6) return
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/to-input`, { method: 'POST' })
      const d = await r.json().catch(() => ({})) as { filename?: string }
      if (d.filename && !get().references.some(x => x.file === d.filename)) set({ references: [...get().references, { file: d.filename, uri: asset.uri ?? '' }], mode: 'photo' })
    },
    deposerReference: async f => {
      marquerChargement(set, get, 'refs')
      if (get().references.length >= 6) return
      const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f })
      const d = await r.json().catch(() => ({})) as { filename?: string; error?: string }
      if (!r.ok || !d.filename) { set({ t0Error: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
      if (!get().references.some(x => x.file === d.filename)) set({ references: [...get().references, { file: d.filename, uri: URL.createObjectURL(f) }], mode: 'photo' })
    },
    retirerReference: file => set({ references: get().references.filter(x => x.file !== file) }),
    utiliserDans: (cible, asset) =>
      set(st => ({ passerelle: { cible, assetId: asset.id }, navRequest: { section: cible, nonce: (st.navRequest?.nonce ?? 0) + 1 } })),
    allerCinema: () => set(st => ({ navRequest: { section: 'cinema', nonce: (st.navRequest?.nonce ?? 0) + 1 } })),
    prendrePasserelle: cible => {
      const p = get().passerelle
      if (p?.cible !== cible) return null
      set({ passerelle: null })
      return get().assets.find(a => a.id === p.assetId) ?? null
    },

    animateFrom: async asset => {
      marquerChargement(set, get, 'start')
      if (asset.mediaType !== 'photo') return
      get().setMode('video')
      /* "Animer" starts from a blank shot: an end (or middle) frame left from a previous setting
         would force the engine to end on another image. */
      get().updateVideo({ task: 'i2v', endAssetId: null, endFrameFile: '', endFrameError: '', middleAssetId: null })
      set(st => ({ navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      await get().pickStartFrame(asset.id)
    },

    stageOuvert: false,
    ongletMusiques: false,
    ongletAudio: 'musique',
    h3: null,
    ongletConfig: null,
    famillePresets: null,
    ongletExtensions: null,
    demandeOutil: null,
    outilDedie: 'inpaint',
    stageRepris: null,
    ouvrirStage: (scene = null) => set(st => ({ stageOuvert: true, stageRepris: scene, navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } })),

    /* Loop: the same photo as start and end, on Wan (the only engine that takes both). */
    boucleFrom: async asset => {
      await get().animateFrom(asset)
      get().updateVideo({ engine: 'wan' })
      await get().pickEndFrame(asset.id)
    },

    retouchFrom: async asset => {
      marquerChargement(set, get, 'edit')
      if (asset.mediaType !== 'photo') return
      get().setMode('photo')
      get().updatePhoto({ task: 'edit' })
      set(st => ({ navRequest: { section: 'image', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      await get().pickEditSource(asset.id)
    },

    extendFrom: async asset => {
      marquerChargement(set, get, 'extend')
      if (asset.mediaType !== 'video') return
      set(st => ({ navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      get().setMode('video')
      get().updateVideo({ task: 'extend' })
      await get().pickExtendClip(asset.id)
    },

    /** Permanent deletion. Waits for the server before removing the thumbnail,
     *  so it never disappears and then reappears on reload after a failed delete. */
    removeAsset: async id => {
      await apiDeleteAsset(id)
      set(s => ({ assets: s.assets.filter(a => a.id !== id) }))
    },

    /** Sequential and tolerant: a failing asset must neither stop the next ones
     *  nor disappear from the list while it is still in the database.
     *  Only what the server confirmed is removed. */
    removeAssets: async ids => {
      const ok: string[] = []
      const failed: string[] = []
      for (const id of ids) {
        try { await apiDeleteAsset(id); ok.push(id) }
        catch (e) { failed.push(id); console.error('[suppression]', id, e) }
      }
      if (ok.length) {
        const gone = new Set(ok)
        /* Deletions in quick succession: a single notice, a single undo. */
        set(s => {
          const prec = s.lastDeleted && Date.now() - s.lastDeleted.at < 10_000 ? s.lastDeleted.ids : []
          return { assets: s.assets.filter(a => !gone.has(a.id)), lastDeleted: { ids: [...prec, ...ok], at: Date.now() } }
        })
      }
      return { removed: ok.length, failed }
    },
    lastDeleted: null,
    dismissDeleted: () => set({ lastDeleted: null }),
    undoDelete: async () => {
      const d = get().lastDeleted
      if (!d) return null
      const res = await fetch('/api/assets/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: d.ids }) })
      const body = await res.json().catch(() => ({})) as { restored?: string[]; failed?: { id: string; error: string }[] }
      set({ lastDeleted: null })
      try { set({ assets: await fetchAssets() }) } catch (e) { console.error('[corbeille] bibliothèque non rechargée :', e) }
      return body.failed?.length ? t('{n} non restauré(s) : {e}', { n: body.failed.length, e: tServeur(body.failed[0].error) }) : null
    },

    reviewAsset: (id, status) => {
      void pushReview(id, { reviewStatus: status }).catch(e => console.error('[revue]', e))
      set(s => ({
        assets: s.assets.map(a =>
          a.id === id ? { ...a, reviewStatus: status, exportReady: status === 'approved' ? a.exportReady : false } : a),
      }))
    },
    toggleExportReady: id => {
      const next = !get().assets.find(a => a.id === id)?.exportReady
      void pushReview(id, { exportReady: next }).catch(e => console.error('[export]', e))
      set(s => ({
        assets: s.assets.map(a => (a.id === id ? { ...a, exportReady: next } : a)),
      }))
    },

    setCaption: (id, caption) => {
      void pushReview(id, { caption }).catch(e => console.error('[caption]', e))
      set(s => ({ assets: s.assets.map(a => (a.id === id ? { ...a, caption: caption.trim() || undefined } : a)) }))
    },

    uploadPersonaAvatar: async file => {
      const res = await fetch('/api/persona/avatar', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(tServeur((body as { error?: string }).error) ?? `HTTP ${res.status}`)
      set({ personaAvatar: (body as { url: string | null }).url })
    },
    refreshPersona: async () => {
      try {
        const choisi = personnageChoisi()
        const p = await (await fetch(`/api/persona${choisi ? `?id=${encodeURIComponent(choisi)}` : ''}`)).json() as { id?: string; name?: string | null; avatar?: string | null; lorasKlein?: unknown[]; lorasFlux3?: unknown[]; loras?: unknown[]
          videoLoras?: unknown[]; credit?: PersonaCredit | null; garderobe?: Garderobe; voix?: string | null }
        set({ personaVideo: Boolean(p.videoLoras?.length), personaVideoWan: estLoraWan(p.videoLoras), personaCredit: p.credit ?? null, personaGarderobe: p.garderobe ?? GARDEROBE_VIDE, personaVoix: p.voix ?? null })
        const change = (p.id ?? null) !== get().personaId
        const klein = Boolean(p.lorasKlein?.length)
        // Krea-only character: the Klein recipe has nothing to hold its face
        set({ personaKlein: klein, personaKrea: Boolean(p.loras?.length) || p.id === SANS_PERSONNAGE, personaFlux3: Boolean(p.lorasFlux3?.length) })
        set({ personaName: p.id === SANS_PERSONNAGE ? t('Sans personnage') : p.name?.trim() || t('Personnage'), personaAvatar: p.id === SANS_PERSONNAGE ? null : p.avatar ?? null, personaId: p.id ?? null })
        if (change) set({ assets: await fetchAssets() })
      } catch { /* offline: keep the current display */ }
    },
    // the header and the Characters page also choose for the current page only
    choisirPersonnage: async id => get().choisirPersonnagePage(id),
    pageCourante: 'accueil',
    choisirPersonnagePage: async id => {
      const pages = lirePersonnagesPages(); pages[get().pageCourante] = id; ecrirePersonnagesPages(pages)
      retenirPersonnage(id, false)
      await get().refreshPersona()
    },
    /* No default character, for anyone (visitors included): a page shows everything and forces
       no face, unless a character was chosen on it. */
    entrerPage: async page => {
      set({ pageCourante: page })
      const id = lirePersonnagesPages()[page] ?? SANS_PERSONNAGE
      if (id && id !== personnageChoisi()) { retenirPersonnage(id, false); await get().refreshPersona() }
    },

    hydrate: async () => {
      // Profile photo: a file, not data — loaded separately, without blocking.
      void fetch('/api/persona/avatar/meta').then(r => r.json()).then((m: { url: string | null }) => set({ personaAvatar: m.url })).catch(() => {})
      // "son" mode has no pipeline: a persisted state on it falls back to photo.
      if (get().mode === 'son') get().setMode('photo')
      // video engine not in this edition (MiniMax H3, fast LTX) but still stored in the browser
      if (!VIDEO_ENGINES.some(e => e.key === get().video.engine)) get().updateVideo({ engine: get().video.engine === 'ltx' ? 'ltx_hq' : 'wan' })
      /* Caps, minutes, drafts and T0 list: the server is the source, the
         front end only keeps an offline fallback. */
      try {
        const h = await (await fetch('/api/health')).json()
        setEngineCatalog(h.videoEngines)
        set({ h3: (h.h3 as AppState['h3']) ?? null })
        setT0Blocklist(h.t0Blocklist)
        // Character name: configured on the server, "Personnage" otherwise.
        const nom = (h.persona?.name ?? h.personaName) as string | undefined
        set({ serverInfo: { preambles: h.preambles ?? {}, composerModels: h.composerModels ?? {}, renderRates: h.renderRates ?? null },
          personaId: (h.persona?.id as string | undefined) ?? null,
          personaKlein: Boolean((h.persona?.lorasKlein as unknown[] | undefined)?.length),
          personaKrea: Boolean((h.persona?.loras as unknown[] | undefined)?.length),
          personaVideo: Boolean((h.persona?.videoLoras as unknown[] | undefined)?.length),
          personaVideoWan: estLoraWan(h.persona?.videoLoras as unknown[] | undefined),
          personaCredit: (h.persona?.credit as PersonaCredit | undefined) ?? null,
          personaGarderobe: (h.persona?.garderobe as Garderobe | undefined) ?? GARDEROBE_VIDE,
          ...(nom?.trim() ? { personaName: nom.trim() } : {}) })
      } catch (e) { console.warn('[store] catalogue moteurs non chargé :', e) }
      if (personnageChoisi()) await get().refreshPersona()
      // the library loads when the browser is idle: the home screen shows without waiting for it
      const chargerBibliotheque = () => void fetchAssets().then(assets => set({ assets })).catch(e => console.error('[store] bibliothèque non chargée :', e))
      if (typeof requestIdleCallback === 'function') requestIdleCallback(chargerBibliotheque, { timeout: 1500 })
      else setTimeout(chargerBibliotheque, 300)
      /* Jobs too — ALL of them, including in-flight ones: the database is the
         source of truth, and each device SUBSCRIBES to running jobs (adopt =
         same polling loop as submit, without resubmitting). This keeps the
         queue visible after a reload, on desktop and phone, with progress and
         the asset on arrival. */
      try {
        const r = await fetch('/api/jobs?limit=30')
        const { jobs } = await r.json() as { jobs: Array<Record<string, unknown>> }
        const known = new Set(get().jobs.map(j => j.id))
        const restored = jobs
          .filter(j => !known.has(j.id as string))
          .map(jobFromApi)
        if (restored.length) set(st => ({ jobs: [...st.jobs, ...restored] }))
        for (const j of restored)
          if (j.status !== 'done' && j.status !== 'blocked') worker.adopt(j)
        /* Jobs ALREADY known and still "running" on screen are re-tracked: if
           their tracking was lost, this catches up with the real state (the
           worker never opens two trackers for the same job). */
        for (const j of get().jobs)
          if (known.has(j.id) && j.status !== 'done' && j.status !== 'blocked') worker.adopt(j)
      } catch (e) { console.error('[store] jobs non rechargés :', e) }
      /* Renders started elsewhere after the page opened (another tab, the phone, the API):
         every 8 s, those still running and unknown to this tab are adopted and their card shown. */
      if (!suiviFileLance) {
        suiviFileLance = true
        window.setInterval(async () => {
          if (document.hidden) return
          try {
            const { jobs } = await (await fetch('/api/jobs?limit=60')).json() as { jobs: Array<Record<string, unknown>> }
            const known = new Set(get().jobs.map(j => j.id))
            const neufs = jobs.filter(j => !known.has(j.id as string) && j.status !== 'done' && j.status !== 'blocked' && j.status !== 'failed').map(jobFromApi)
            if (!neufs.length) return
            set(st => ({ jobs: [...st.jobs, ...neufs] }))
            for (const j of neufs) worker.adopt(j)
          } catch { /* server unreachable: retry on the next tick */ }
        }, 8000)
      }
    },

    /** Clone: reinjects an asset's full lineage into the console.
     *
     *  A SINGLE `set`: going through updatePhoto + setComposed does not work.
     *  updatePhoto only regenerates `userPrompt` when `promptTouched` is false,
     *  so once the user has edited the prompt by hand the field would stay on
     *  the old text. `userPrompt` is written explicitly here and
     *  `promptTouched: true` is set so no automatic rebuild overwrites the
     *  cloned value right after.
     *
     *  Fallback: assets without `userPrompt` in their provenance fall back
     *  to the composed prompt. */
    cloneFrom: asset => {
      marquerChargement(set, get, 'tout')   // a clone replays its full setting
      const p = asset.provenance
      const isVideo = asset.mediaType === 'video'
      set(s => ({
        mode: asset.mediaType,
        photo: isVideo ? s.photo : { ...s.photo, ...(p.selections as Partial<PhotoSelections>) },
        video: isVideo ? { ...s.video, ...(p.selections as Partial<VideoSelections>) } : s.video,
        /* The REAL prompt (composed, the one that rendered) — not the short coded
           brief typed by the operator. */
        userPrompt: stripShotMarkers(p.composedPositive || p.userPrompt || ''),
        promptTouched: true,
        userDirectives: p.userDirectives ?? '',
        composedPositive: stripShotMarkers(p.composedPositive ?? ''),
        composedNegative: p.composedNegative ?? '',
        seedMode: p.seed?.mode ?? 'random',
        seedValue: p.seed?.value ?? s.seedValue,
        t0Error: null,
        navRequest: { section: isVideo ? 'video' as const : 'image' as const,
                      nonce: (s.navRequest?.nonce ?? 0) + 1 },
      }))
      /* Video: re-prepare the cloned job's STILL. Thumbnails' INLINE provenance
         is trimmed (selections often missing): the FULL provenance is fetched
         when needed, and `sourceImage` (the job's input file, always stored
         for i2v) is the universal fallback. */
      if (isVideo) {
        void (async () => {
          let sel = p.selections as Partial<VideoSelections> | undefined
          let source = (p as { sourceImage?: string }).sourceImage
          type Reel = { videoEngine?: string | null; endImage?: string | null; videoSeconds?: number | null; withAudio?: boolean | null }
          let reel: Reel = {}
          /* Thumbnails' INLINE provenance does NOT include selections (too heavy
             for the list): without this fetch, `task` would never be restored
             and cloning a "Créer" render would leave the sidebar on the current
             tab. */
          /* Always the full provenance: it also carries what the job received (engine,
             end frame, duration), the only reference for a render started without selections. */
          try {
            const full = await (await fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`)).json()
            sel = (full.selections as Partial<VideoSelections> | null) ?? sel
            source = full.sourceImage ?? source
            reel = full as Reel
          } catch { /* unreachable: keep the inline one */ }
          // Tab + settings of the cloned job (the first set only had
          // the inline data, often empty). The current mode must not persist.
          if (sel && Object.keys(sel).length)
            get().updateVideo(sel as Partial<VideoSelections>)
          /* Engine, duration and end frame of the cloned job: without them, the console would keep the
             engine and end frame of the previous setting. */
          const moteur = (reel.videoEngine ?? asset.videoEngine) as string | undefined
          const patch: Partial<VideoSelections> = {}
          if (moteur && moteur !== 'motion' && !sel?.engine) patch.engine = moteur as VideoSelections['engine']
          if (!sel?.durationS && reel.videoSeconds) patch.durationS = reel.videoSeconds
          if (typeof reel.withAudio === 'boolean' && sel?.withAudio === undefined) patch.withAudio = reel.withAudio
          const finSel = sel?.endAssetId && get().assets.some(a => a.id === sel!.endAssetId) ? sel.endAssetId : null
          if (finSel) void get().pickEndFrame(finSel)
          else Object.assign(patch, { endAssetId: null, endFrameFile: reel.endImage ?? sel?.endFrameFile ?? '', endFrameError: '' })
          get().updateVideo(patch)
          const startId = sel?.startAssetId
          if (startId && get().assets.some(a => a.id === startId)) { void get().pickStartFrame(startId); return }
          const file = sel?.startFrameFile || source
          // Dims reset to zero: those of the PREVIOUS still would remain and
          // distort the "origine" aspect.
          // The server probes the actual file at dispatch anyway.
          if (file) get().updateVideo({ startAssetId: null, startFrameFile: file,
            startFrameW: (sel?.startFrameW as number | undefined) ?? 0,
            startFrameH: (sel?.startFrameH as number | undefined) ?? 0,
            startFrameUri: `/api/uploads/${encodeURIComponent(file)}`, startFrameError: '' })
        })()
      }
    },

    setMode: mode =>
      set(s => {
        if (mode === s.mode) return {}
        /* Prompts SEPARATED per mode: the text of the mode being left is stored,
           the text of the mode being entered is restored if it was edited by
           hand — otherwise the mode's auto prompt. */
        const promptStash = { ...s.promptStash, [s.mode]: { text: s.userPrompt, touched: s.promptTouched } }
        const saved = promptStash[mode]
        return {
          mode, promptStash,
          userPrompt: saved?.touched ? saved.text
            : mode === 'video' ? buildVideoPrompt(s.video)
            : mode === 'photo' ? buildPhotoPrompt(s.photo)
            : s.userPrompt,
          promptTouched: saved?.touched ?? false,
        }
      }),
    /** Patches photo selections + regenerates the auto prompt
     *  (unless the user has taken over the field). */
    updatePhoto: patch =>
      set(s => {
        const photo = { ...s.photo, ...patch }
        // Changing task changes the NATURE of the text field: scene prompt
        // in generation, instruction in edit. Carrying one into the other
        // would send a full scene description as an instruction.
        // So it restarts from the auto prompt, even if the operator had taken
        // over the previous field.
        const taskChanged = patch.task !== undefined && patch.task !== s.photo.task
        return {
          photo,
          promptTouched: taskChanged ? false : s.promptTouched,
          userPrompt: s.promptTouched && !taskChanged ? s.userPrompt : buildPhotoPrompt(photo),
        }
      }),

    loraStacks: {},
    lastVideoLoras: {},
    saveLoraStack: (cle, name, items) => set(s => ({ loraStacks: { ...s.loraStacks,
      [cle]: [...(s.loraStacks[cle] ?? []).filter(p => p.name !== name), { name, items: items.map(l => ({ ...l })) }] } })),
    deleteLoraStack: (cle, name) => set(s => ({ loraStacks: { ...s.loraStacks, [cle]: (s.loraStacks[cle] ?? []).filter(p => p.name !== name) } })),
    updateVideo: patch =>
      set(s => {
        const video = { ...s.video, ...patch }
        /* Engine family change: the old engine's LoRAs are useless on the new one.
           The current stack is stored and the target engine's stack is restored. */
        const fam = (e: string) => e.startsWith('minimax') ? 'h3' : e.startsWith('ltx') ? 'ltx' : e
        let lastVideoLoras = s.lastVideoLoras
        if (patch.engine && fam(patch.engine) !== fam(s.video.engine) && !('videoLoras' in patch)) {
          lastVideoLoras = { ...lastVideoLoras, [fam(s.video.engine)]: s.video.videoLoras }
          video.videoLoras = lastVideoLoras[fam(patch.engine)] ?? []
        }
        return {
          lastVideoLoras,
          video,
          userPrompt: s.mode === 'video' && !s.promptTouched ? buildVideoPrompt(video) : s.userPrompt,
        }
      }),
    updateSon: patch => set(s => ({ son: { ...s.son, ...patch } })),

    setUserPrompt: v => set({ userPrompt: v, promptTouched: true }),

    resetPrompt: () => set(s => ({
      promptTouched: false,
      userPrompt: s.mode === 'photo' ? buildPhotoPrompt(s.photo)
        : s.mode === 'video' ? buildVideoPrompt(s.video)
        : s.userPrompt,
    })),

    /* Catalog loaded once, when the selector mounts. A failure is not hidden:
       the list stays empty and the selector says so. */
    loadLoras: async () => {
      try {
        const r = await fetch('/api/loras')
        const d = await r.json() as { loras?: LoraInfo[] }
        set({ loraCatalog: d.loras ?? [] })
      } catch {
        set({ loraCatalog: [] })
      }
    },
    toggleLora: (name: string) => set(s => {
      if (s.loraPicks.some(l => l.name === name))
        return { loraPicks: s.loraPicks.filter(l => l.name !== name) }
      // Pre-fill the known trigger: the operator corrects it if needed,
      // but does not start from an empty field on well-labelled LoRAs.
      const info = s.loraCatalog.find(l => l.name === name)
      return { loraPicks: [...s.loraPicks, { name, strength: 1, trigger: info?.trigger ?? '' }] }
    }),
    setLoraTrigger: (name: string, trigger: string) => set(s => ({
      loraPicks: s.loraPicks.map(l => (l.name === name ? { ...l, trigger } : l)),
    })),
    setLoraStrength: (name: string, strength: number) => set(s => ({
      loraPicks: s.loraPicks.map(l => (l.name === name ? { ...l, strength } : l)),
    })),
    clearLoras: () => set({ loraPicks: [] }),
    toggleVideoLora: (name: string) => set(s => {
      const cur = s.video.videoLoras
      if (cur.some(l => l.name === name))
        return { video: { ...s.video, videoLoras: cur.filter(l => l.name !== name) } }
      const info = s.loraCatalog.find(l => l.name === name)
      return { video: { ...s.video, videoLoras: [...cur, { name, strength: 1, trigger: info?.trigger ?? '' }] } }
    }),
    setVideoLoraStrength: (name: string, strength: number) => set(s => ({
      video: { ...s.video, videoLoras: s.video.videoLoras.map(l => (l.name === name ? { ...l, strength } : l)) },
    })),
    setVideoLoraTrigger: (name: string, trigger: string) => set(s => ({
      video: { ...s.video, videoLoras: s.video.videoLoras.map(l => (l.name === name ? { ...l, trigger } : l)) },
    })),
    clearVideoLoras: () => set(s => ({ video: { ...s.video, videoLoras: [] } })),
    setUserDirectives: v => set({ userDirectives: v }),
    setSoulLayer: v => set({ soulLayer: v || null }),
    setMoodLayer: v => set({ moodLayer: v || null }),
    // Editing the composed prompt by hand aligns it with the current auto prompt:
    // the operator just reviewed it, so it is no longer stale.
    setComposed: (pos, neg) => set(s => ({
      composedPositive: pos, composedNegative: neg, composedFrom: s.userPrompt, composedFor: ongletDe(s),
    })),
    setGalleryColumns: n => set({ galleryColumns: n }),
    setLibraryColumns: n => set({ libraryColumns: Math.max(2, Math.min(12, Math.round(n))) }),
    setFolderSort: v => set({ folderSort: v }),
    setSeedValue: v => set({ seedValue: v }),
    carouselBatchId: null,
    setCarouselBatchId: v => set({ carouselBatchId: v }),
    carouselLocks: null,
    setCarouselLocks: v => set({ carouselLocks: v }),
    carouselPromptRacine: null,
    setCarouselPromptRacine: v => set({ carouselPromptRacine: v }),
    photoSize: null,
    setPhotoSize: v => set({ photoSize: v }),
    photoEngine: 'krea',
    setPhotoEngine: e => set({ photoEngine: e }),
    toggleSeedMode: () => set(s => (s.seedMode === 'lock'
      ? { seedMode: 'random' }
      // Switching to lock almost always means "redo the same as the last one",
      // not "reuse a number chosen hours ago".
      : { seedMode: 'lock', seedValue: s.lastSeed ?? s.seedValue })),

    /** Compose: userPrompt + directives → composed prompt (reveal+edit). */
    composeNow: async () => {
      const { userPrompt, userDirectives } = get()
      set({ composing: true, t0Error: null })
      let out
      try {
        out = await composer.compose({ register: 'sfw', userPrompt, userDirectives, mode: get().mode,
          engine: get().mode === 'video'
            ? (get().video.task === 'motion_pure' ? 'motion' : get().video.engine)
            // Edit: dedicated system prompt (engine_edit.txt) — rephrases
            // the edit instruction instead of describing a scene.
            : get().mode === 'photo' && get().photo.task === 'edit' ? 'edit'
            : get().photoEngine,
          // SOUL/MOOD rewriter layers (default null = OFF → composed prompt unchanged).
          soul: get().soulLayer, mood: get().moodLayer })
      } catch (e) {
        // The LLM runs on CPU: 20 to 60 s depending on the model, and it may be
        // missing. Show it in the banner, otherwise the button seems to do nothing
        // and the operator submits a job with an empty composed prompt.
        set({ composing: false, t0Error: t('réécriture impossible — {e}', { e: (e as Error).message }) })
        return
      }
      const t0 = validateT0(out.positive)
      set({
        composedPositive: out.positive,
        composedNegative: out.negative,
        composedFrom: userPrompt,
        composedFor: ongletDe(get()),
        composing: false,
        t0Error: t0.ok ? null : t0.reason ?? t('Bloqué T0'),
      })
    },

    uploadEditSource: async (file: File) => {
      marquerChargement(set, get, 'edit')
      const { updatePhoto } = get()
      updatePhoto({ editUploadState: 'uploading', editUploadError: '', editSourceFile: '',
                    editSourceAssetId: null, editSourceName: file.name })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updatePhoto({ editSourceFile: body.filename, editSourceUri: URL.createObjectURL(file),
                      editUploadState: 'ready' })
      } catch (e) {
        updatePhoto({ editUploadState: 'error', editUploadError: String((e as Error).message || e) })
      }
    },

    pickEditSource: async (assetId: string) => {
      marquerChargement(set, get, 'edit')
      const { updatePhoto } = get()
      updatePhoto({ editSourceAssetId: assetId, editSourceFile: '', editUploadError: '',
                    editUploadState: 'uploading' })
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/to-input`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        const a = get().assets.find(x => x.id === assetId)
        updatePhoto({ editSourceFile: body.filename, editUploadState: 'ready',
                      editSourceUri: a?.uri ?? '', editSourceName: body.filename })
      } catch (e) {
        updatePhoto({ editSourceAssetId: null, editUploadState: 'error',
                      editUploadError: String((e as Error).message || e) })
      }
    },

    pickEndFrame: async (assetId: string) => {
      marquerChargement(set, get, 'end')
      const { updateVideo } = get()
      updateVideo({ endAssetId: assetId, endFrameFile: '', endFrameError: '' })
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/to-input`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        if (get().video.endAssetId === assetId) updateVideo({ endFrameFile: body.filename })
      } catch (e) {
        updateVideo({ endAssetId: null, endFrameError: String((e as Error).message || e) })
      }
    },

    pickStartFrame: async (assetId: string) => {
      marquerChargement(set, get, 'start')
      const { updateVideo } = get()
      // startFrameUri cleared: otherwise the direct preview (clone/upload) would stay
      // painted over the new selection (display priority).
      updateVideo({ startAssetId: assetId, startFrameFile: '', startFrameUri: '', startFrameError: '' })
      // the character follows the start photo: a photo of a character animates with that character
      const photoPerso = get().assets.find(a => a.id === assetId)?.personaId
      if (photoPerso && photoPerso !== get().personaId) void get().choisirPersonnage(photoPerso)
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/to-input`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ startFrameFile: body.filename,
                      startFrameW: body.width ?? 0, startFrameH: body.height ?? 0 })
      } catch (e) {
        // The thumbnail would stay selected while the graph has nothing to
        // read: deselect it and say why.
        updateVideo({ startAssetId: null, startFrameError: String((e as Error).message || e) })
      }
    },

    /** Upload of the Motion Control driver video — same mechanism as images:
     *  what matters is the NAME returned by the server. */
    adoptServerJob: async id => {
      try {
        const { job } = await (await fetch(`/api/jobs/${encodeURIComponent(id)}`)).json() as { job: Record<string, unknown> }
        const nouveau = jobFromApi(job)
        set(st => ({ jobs: [nouveau, ...st.jobs.filter(x => x.id !== nouveau.id)] }))
        worker.adopt(nouveau)
      } catch (e) { console.error('[store] job non suivi :', id, e) }
    },
    retryJob: async (id, draft = false, nouvelleGraine = false) => {
      const res = await fetch(`/api/jobs/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft, nouvelleGraine }) })
      const body = await res.json().catch(() => ({})) as { id?: string; error?: string }
      if (!res.ok || !body.id) return tServeur(body.error) ?? `HTTP ${res.status}`
      const r = await fetch(`/api/jobs/${body.id}`)
      const { job } = await r.json() as { job: Record<string, unknown> }
      const nouveau = jobFromApi(job)
      set(st => ({ jobs: [nouveau, ...st.jobs.filter(x => x.id !== nouveau.id && x.id !== id)] }))
      worker.adopt(nouveau)
      return null
    },
    encoreUne: async asset => {
      if (!asset.jobId) return t('rendu sans job d’origine')
      return get().retryJob(asset.jobId, Boolean(asset.videoDraft), true)
    },
    cancelJob: async (id: string) => {
      try {
        await apiCancelJob(id)
        // The worker poll will report the final state; reflect the intent
        // immediately so the chip does not stay "queued".
        set(st => ({ jobs: st.jobs.map(j => j.id === id ? { ...j, status: 'blocked' } : j) }))
        return null
      } catch (e) {
        return String((e as Error).message || e)
      }
    },

    /* ---------- video extension ----------
       Two inputs (upload / gallery), one path: the video is resolved to its
       LAST FRAME on the server, and that frame becomes the ordinary i2v
       start frame (startFrameFile) — the existing pipeline follows. */
    uploadExtendVideo: async (file: File) => {
      marquerChargement(set, get, 'extend')
      const { updateVideo } = get()
      updateVideo({ extendError: '', extendWarn: '', extendVideoFile: '', extendAssetId: null,
                    startFrameFile: '', extendVideoUri: URL.createObjectURL(file), endAssetId: null, endFrameFile: '', endFrameError: '' })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ extendVideoFile: body.filename })
        await get().extractExtendFrame()
      } catch (e) {
        updateVideo({ extendError: String((e as Error).message || e), extendVideoUri: '' })
      }
    },
    pickExtendClip: async (assetId: string) => {
      marquerChargement(set, get, 'extend')
      const a = get().assets.find(x => x.id === assetId)
      /* New continuation: an end frame from a previous setting (clone of another shot) is unrelated
         to this clip, so it is cleared. */
      get().updateVideo({ extendError: '', extendWarn: '', extendAssetId: assetId, extendVideoFile: '',
                          startFrameFile: '', extendVideoUri: a?.uri ?? '', endAssetId: null, endFrameFile: '', endFrameError: '' })
      await get().extractExtendFrame()
    },
    setExtendPrequel: async on => {
      get().updateVideo({ extendPrequel: on, extendEndFile: '', extendWarn: '', extendError: '' })
      const v = get().video
      if (v.extendVideoFile || v.extendAssetId) await get().extractExtendFrame()
    },
    setExtendPick: async pick => {
      get().updateVideo({ extendPick: pick })
      const v = get().video
      if (v.extendVideoFile || v.extendAssetId) await get().extractExtendFrame()
    },
    extractExtendFrame: async () => {
      const v = get().video
      // Prequel: 1st frame → END frame (no start frame); sequel: last → start.
      const pick = v.extendPrequel ? 'first' : v.extendPick
      try {
        let body: { filename: string; width: number; height: number; warn?: string | null; error?: string }
        if (v.extendVideoFile) {
          const r = await fetch('/api/input/last-frame', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: v.extendVideoFile, pick }) })
          body = await r.json(); if (!r.ok) throw new Error(tServeur(body.error) ?? `HTTP ${r.status}`)
        } else if (v.extendAssetId) {
          const r = await fetch(`/api/assets/${v.extendAssetId}/to-input?frame=${pick}`, { method: 'POST' })
          body = await r.json(); if (!r.ok) throw new Error(tServeur(body.error) ?? `HTTP ${r.status}`)
        } else {
          throw new Error(t('aucune source : déposer une vidéo ou choisir un clip de la galerie'))
        }
        if (v.extendPrequel)
          get().updateVideo({ extendEndFile: body.filename, startFrameFile: '', startFrameW: body.width || 0, startFrameH: body.height || 0,
                              extendWarn: '', extendError: '' })
        else
          get().updateVideo({ startFrameFile: body.filename, startFrameW: body.width || 0, startFrameH: body.height || 0,
                              extendWarn: body.warn || '', extendError: '' })
      } catch (e) {
        get().updateVideo({ extendError: String((e as Error).message || e), startFrameFile: '', extendEndFile: '' })
      }
    },

    uploadMotionDriver: async (file: File) => {
      marquerChargement(set, get, 'driver')
      const { updateVideo } = get()
      updateVideo({ motionDriverFile: '', motionDriverError: '',
                    motionRefUri: URL.createObjectURL(file), motionRefName: file.name })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ motionDriverFile: body.filename, motionDriverSeconds: Number(body.durationS) || 0, motionDriverFrames: Number(body.frames) || 0 })
      } catch (e) {
        updateVideo({ motionDriverError: String((e as Error).message || e), motionRefUri: '' })
      }
    },

    pickMotionStill: async (assetId: string) => {
      marquerChargement(set, get, 'still')
      const { updateVideo } = get()
      // Immediate preview via the asset URI: from a thumbnail, motionStillUri
      // must be set here too, otherwise the slot stays empty.
      const uri = get().assets.find(a => a.id === assetId)?.uri ?? ''
      updateVideo({ motionStillAssetId: assetId, motionStillFile: '', motionStillError: '', motionStillUri: uri })
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/to-input`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ motionStillFile: body.filename })
      } catch (e) {
        updateVideo({ motionStillAssetId: null, motionStillError: String((e as Error).message || e), motionStillUri: '' })
      }
    },

    uploadMotionStill: async (file: File) => {
      marquerChargement(set, get, 'still')
      const { updateVideo } = get()
      updateVideo({ motionStillFile: '', motionStillError: '', motionStillAssetId: null, motionStillUri: URL.createObjectURL(file) })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ motionStillFile: body.filename })
      } catch (e) {
        updateVideo({ motionStillError: String((e as Error).message || e), motionStillUri: '' })
      }
    },

    poserDepartInspiration: async (id: string) => {
      marquerChargement(set, get, 'start')
      const { updateVideo } = get()
      updateVideo({ startFrameFile: '', startAssetId: null, startFrameError: '', startFrameUri: '' })
      try {
        const res = await fetch(`/api/inspirations/${encodeURIComponent(id)}/depart`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ startFrameFile: body.filename, startFrameUri: `/inspirations/${id}-depart.jpg`,
                      startFrameW: body.width ?? 0, startFrameH: body.height ?? 0 })
      } catch (e) {
        updateVideo({ startFrameError: String((e as Error).message || e) })
      }
    },
    uploadStartFrame: async (file: File) => {
      marquerChargement(set, get, 'start')
      const { updateVideo } = get()
      updateVideo({ startFrameFile: '', startAssetId: null, startFrameError: '' })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        // Video dropped as start image = EXTENSION: its LAST frame is
        // extracted and becomes the i2v start frame (the clip
        // continues where it stopped). Image = normal behavior.
        if ((file.type || '').startsWith('video/')) {
          const r = await fetch('/api/input/last-frame', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: body.filename, pick: 'last' }),
          })
          const lf = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(tServeur(lf.error) ?? `HTTP ${r.status}`)
          updateVideo({ startFrameFile: lf.filename, startFrameUri: URL.createObjectURL(file),
                        startFrameW: lf.width ?? 0, startFrameH: lf.height ?? 0 })
        } else {
          updateVideo({ startFrameFile: body.filename, startFrameUri: URL.createObjectURL(file),
                        startFrameW: body.width ?? 0, startFrameH: body.height ?? 0 })
        }
      } catch (e) {
        updateVideo({ startFrameError: String((e as Error).message || e) })
      }
    },

    uploadCnRef: async (file: File) => {
      marquerChargement(set, get, 'cn')
      const { updatePhoto } = get()
      updatePhoto({ cnUploadState: 'uploading', cnUploadError: '', cnRefFile: '' })
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updatePhoto({ cnRefFile: body.filename, cnUploadState: 'ready',
                      cnRefW: body.width ?? 0, cnRefH: body.height ?? 0 })
      } catch (e) {
        updatePhoto({ cnUploadState: 'error', cnUploadError: String((e as Error).message || e) })
      }
    },

    submitJobMobile: async () => {
      await get().submitJob()
      return !get().t0Error
    },

    relaunchJob: async (jobId: string) => {
      const src = get().jobs.find(j => j.id === jobId)
      if (!src) return
      /* Execution inputs (driver, still, engine, source image…) do NOT live at
         the Job's root level: they are in `selections`. Lifting them makes a
         rerun possible — otherwise the server receives a bare video job and
         rejects it with 400, and the clone becomes "blocked" immediately. */
      const sel = (src.selections ?? {}) as Partial<VideoSelections> & Partial<PhotoSelections>
      const video = src.mode === 'video'
      const isMotion = video && sel.task === 'motion_pure'
      const isEdit = src.mode === 'photo' && sel.task === 'edit'
      const clone: Job = {
        ...src,
        id: `${++jobCounter}-${SESSION_TAG}`,
        createdAt: Date.now(),
        status: 'queued',
        seed: { mode: 'random' },
        progress: undefined,
        ...(isEdit ? { op: 'edit' as const, sourceImage: sel.editSourceFile, editStyle: sel.editStyle ?? undefined } : {}),
        ...(video && !isMotion ? {
          videoEngine: sel.engine,
          videoLoras: sel.videoLoras ?? [],
          withAudio: audioEffective(sel.engine ?? 'wan', Boolean(sel.withAudio)),
          sourceImage: sel.startFrameFile || undefined,
          videoSeconds: Math.min(sel.durationS ?? 5, engineInfo(sel.engine ?? 'wan').maxSeconds),
          videoFps: sel.fps ?? 24,
          // The clone only takes draft mode if the engine supports it: after
          // an engine change in memory, the server would reject it.
          videoDraft: Boolean(sel.draft) && Boolean(engineInfo(sel.engine ?? 'wan').draft),
        } : {}),
        ...(isMotion ? {
          motionDriver: sel.motionDriverFile,
          motionPreview: Boolean(sel.motionPreview),
          motionMode: sel.motionMode === 'replace' ? 'replace' : 'animate',
          // The uploaded still is the animated character's reference (Move); Mix starts from the video alone.
          ...(sel.motionStillFile && sel.motionMode !== 'replace' ? { motionRef: sel.motionStillFile } : {}),
        } : {}),
      }
      set(s2 => ({ jobs: [clone, ...s2.jobs] }))
      await worker.submit(clone)
    },

    submitJob: async () => {
      const s = get()
      const isEdit = s.mode === 'photo' && s.photo.task === 'edit'
      const register: Register = 'sfw'
      // All empty and nothing written: the server would reject "empty prompt" — report it here.
      if (s.mode === 'photo' && !s.userPrompt.trim() && !s.composedPositive.trim()) {
        set({ t0Error: t('prompt vide : choisis un élément de composition ou écris le prompt') }); return
      }

      /* A composed prompt is only sent if it was rewritten from THIS prompt.
         Otherwise the raw text is sent: a stale composed prompt would silently
         win over the displayed text. On mobile the composed prompt is not even
         visible: what is on screen must be what is sent. */
      /* …and only in the tab where it was written: a composed prompt derived
         from the image in "Créer" from an EMPTY brief would otherwise look
         fresh in "Rejouer" with an empty field ('' === ''). */
      const fresh = !!s.composedPositive && s.composedFrom === s.userPrompt && s.composedFor === ongletDe(s)
      const positive = !fresh ? s.userPrompt : s.composedPositive
      const t0 = validateT0(positive)
      if (!t0.ok) { set({ t0Error: t0.reason ?? t('Bloqué T0') }); return }
      /* Video safeguard: the server already rejects an i2v job without a start
         image, but the error would arrive after submission, once queued.
         Catch it here so the rejection is shown where the user clicked. */
      if (s.mode === 'video' && s.video.task === 'motion_pure' && s.video.motionMode === 'replace' && !s.video.motionDriverFile) {
        set({ t0Error: s.video.motionDriverError || t('vidéo source manquante : déposer la vidéo où mettre le personnage') })
        return
      }
      if (s.mode === 'video' && s.video.task === 'motion_pure' && s.video.motionMode !== 'replace'
          && (!s.video.motionDriverFile || !s.video.motionStillFile)) {
        set({ t0Error: !s.video.motionDriverFile && !s.video.motionStillFile
          ? t('still ET vidéo source manquantes : ce mode anime une image avec le mouvement d’une vidéo — déposer les deux')
          : !s.video.motionStillFile
            ? (s.video.motionStillError || t('still de départ manquante : déposer l’image à animer'))
            : (s.video.motionDriverError || t('vidéo source manquante : déposer la vidéo dont le mouvement sera transféré')) })
        return
      }
      if (s.mode === 'video' && s.video.task === 'extend' && !s.video.startFrameFile) {
        set({ t0Error: s.video.extendError || t('extension vidéo sans source : déposer une vidéo ou choisir un clip, la dernière frame devient l’image de départ') })
        return
      }
      // Every ENGINE video job (i2v) — except motion/extend, which have their
      // own source — animates an image: without a start frame the server returns 400.
      // ALL these tasks are covered (not just 'i2v') so a leftover
      // 'generate' does not slip through to an opaque 400 → "blocked".
      /* MiniMax H3 accepts the END frame alone (the clip arrives on it).
         The other engines start from an image. */
      /* End thumbnail chosen without a copy to ComfyUI (restored state, or copy
         not yet returned): do it now. */
      if (s.mode === 'video' && s.video.endAssetId && !s.video.endFrameFile) await get().pickEndFrame(s.video.endAssetId)
      const finSeule = H3.includes(get().video.engine) && !!get().video.endFrameFile
      /* Prequel: only Wan (WanFirstLastFrameToVideo) can end on an end frame;
         LTX has no equivalent input. */
      const prequel = s.mode === 'video' && s.video.task === 'extend' && !!s.video.extendPrequel
      if (prequel) {
        if (!['wan', ...H3].includes(s.video.engine)) { set({ t0Error: t('prequel : choisir Wan (LTX ne sait pas arriver sur une frame de fin)') }); return }
        if (!s.video.extendEndFile) { set({ t0Error: s.video.extendError || t('1re frame du clip en cours de préparation — choisir une vidéo à précéder') }); return }
      }
      if (s.mode === 'video' && s.video.task === 't2v' && !positive.trim()) {
        set({ t0Error: t('plan d’ambiance vide : décrire le lieu, la lumière et le mouvement de caméra') }); return
      }
      if (s.mode === 'video'
          && !['motion_pure', 'extend', 't2v'].includes(s.video.task)
          && !s.video.startFrameFile && !finSeule) {
        set({ t0Error: s.video.startFrameError
          // A selected thumbnail whose copy to ComfyUI has not finished
          // is NOT a missing selection: say so, instead of telling
          // the operator nothing was chosen.
          || (s.video.startAssetId
            ? t('image de départ en cours de préparation — réessayer dans une seconde')
            : t('image de départ manquante : choisir une still dans la bibliothèque ou en déposer une')) })
        return
      }
      if (isEdit && !s.photo.editSourceFile) {
        set({
          t0Error: s.photo.editUploadState === 'uploading'
            ? t('préparation de l’image source en cours')
            : t('image source manquante : choisir une still ou déposer un fichier'),
        })
        return
      }

      const selections =
        s.mode === 'photo' ? s.photo : s.mode === 'video' ? s.video : s.son

      /* Batch: the SAME prompt, N times. Only the seed must differ between
         renders, otherwise the batch would render the same image N times.
         In random mode the server draws, so nothing to do here.
         In locked mode the seed is incremented: a batch AND a fixed seed
         contradict each other, and incrementing stays reproducible (the
         provenance keeps each render's exact seed). */
      const n = Math.max(1, Math.min(10, s.batchCount))
      const batchId = s.carouselBatchId ?? (n > 1 ? crypto.randomUUID() : undefined)
      /* One key per SUBMISSION, suffixed by batch index: `base-0`, `base-1`…
         Without the suffix, the jobs of a batch would share one key and the
         server would create only one. */
      /* A submission still in progress keeps ITS key: a second press meanwhile
         is a new intent, not a retry. Reusing its key would make the server
         return the jobs already created, and thumbnails would stay "waiting"
         on nonexistent jobs. */
      const reprise = envoiEnCours ? null : s.requestId
      const reqBase = reprise ?? `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      if (!envoiEnCours) set({ requestId: reqBase })
      const mkJob = (i: number): Job => ({
        id: `${++jobCounter}-${SESSION_TAG}`,
        requestId: `${reqBase}-${i}`,
        batchId,
        carouselLocks: s.carouselLocks ?? undefined,
        promptRacine: s.carouselPromptRacine ?? undefined,
        width: s.mode === 'photo' ? s.photoSize?.w : undefined,
        height: s.mode === 'photo' ? s.photoSize?.h : undefined,
        createdAt: Date.now(),
        // an edit stays filed under the character of its photo, not the active character
        personaId: (isEdit && s.assets.find(a => a.id === s.photo.editSourceAssetId)?.personaId) || s.personaId || 'default',
        ...(s.mode === 'photo' && !isEdit ? { photoEngine: s.photoEngine, ...(s.references.length ? { references: s.references.map(x => x.file) } : {}) } : {}),
        // carousel without a character: the first reference is the original photo, its face is held
        ...(s.carouselBatchId && s.personaId === SANS_PERSONNAGE && s.references.length ? { refVisage: true } : {}),
        register,
        mode: s.mode,
        purpose: 'creative',
        recipeId: `${register}@v1`,
        selections,
        seed: { mode: s.seedMode, value: s.seedMode === 'lock' ? s.seedValue + i : undefined },
        userPrompt: s.userPrompt,
      initialBrief: s.initialBrief ?? undefined,
      promptVision: s.promptVision ?? undefined,

        userDirectives: s.userDirectives,
        composedPositive: positive,
        /* The negative follows the same guard as the positive: a stale composed
           prompt's negative must not be sent. Empty, the server uses the workflow's negative. */
        composedNegative: fresh ? s.composedNegative : '',
        conditioningRefs: buildConditioningRefs(s.mode, selections),
        loras: s.loraPicks.filter(l => !l.off),
        // ControlNet: only in Generation, and only if the upload has
        // succeeded — sending a file name the server has not received would
        // fail the graph at execution, not at validation.
        ...(CONTROLNET_AVAILABLE && !isEdit && s.mode === 'photo' && s.photo.cnRefFile
          ? {
            controlNet: { file: s.photo.cnRefFile, type: s.photo.cnType,
                          strength: s.photo.cnStrength },
            // The latent takes the reference's ASPECT: otherwise the control map
            // is silently cropped and the rendered framing is not
            // the one seen in the thumbnail.
            ...latentFor(s.photo.cnRefW, s.photo.cnRefH),
          }
          : {}),
        // Video starts from a still: the server rejects an i2v job without it.
        // `audioEffective` rather than the raw checkbox: on a silent engine the
        // checkbox is meaningless, and sending `true` would record in provenance
        // a sound request that could never be fulfilled.
        // The "origine" aspect is resolved HERE, from the still's dimensions:
        // the server only knows the ResolutionSelector ratios.
        ...(s.mode === 'video' && s.video.task === 'motion_pure' ? {
          motionDriver: s.video.motionDriverFile,
          // Mix: video only, the server builds the character reference
          motionRef: s.video.motionMode === 'replace' ? undefined : s.video.motionStillFile,
          motionMode: s.video.motionMode === 'replace' ? 'replace' : 'animate',
          motionPreview: s.video.motionPreview,
          motionSceneText: s.video.motionSceneText || undefined,
          motionPoseStrength: s.video.motionPoseStrength,
          mixDebut: s.video.mixDebut,
          // Multi-character Mix: left to right, one pass per person
          ...(s.video.motionMode === 'replace' && s.video.mixPersonnes.length > 1 ? { personaId: s.video.mixPersonnes[0], mixRang: 0, mixTotal: s.video.mixPersonnes.length, mixSuite: s.video.mixPersonnes.slice(1) } : {}),
          motionRefStrength: s.video.motionRefStrength,
        } : s.mode === 'video' && s.video.task === 't2v' ? {
          /* Ambient shot: only LTX-2.5 starts from text. No still, no character
             video LoRA (the server drops them too). */
          t2v: true,
          // with the character: its video LoRA and trigger word (server)
          t2vPersonnage: Boolean(s.video.t2vPersonnage && s.personaVideo) || undefined,
          videoEngine: moteurT2v(Boolean(s.video.t2vPersonnage && s.personaVideo && s.personaVideoWan)),
          withAudio: audioEffective(moteurT2v(Boolean(s.video.t2vPersonnage && s.personaVideo && s.personaVideoWan)), s.video.withAudio),
          composedPositive: `${stripShotMarkers(positive)}. single continuous shot, no cuts`,
          videoSeconds: Math.min(s.video.durationS, engineInfo(moteurT2v(Boolean(s.video.t2vPersonnage && s.personaVideo && s.personaVideoWan))).maxSeconds),
          videoFps: s.video.fps,
          videoDraft: s.video.draft,
          videoAspect: s.video.aspect === 'origine' ? '9:16' : s.video.aspect,
        } : s.mode === 'video' ? {
          videoEngine: s.video.engine,
          videoLoras: s.video.videoLoras.filter(l => !l.off),
          withAudio: audioEffective(s.video.engine, s.video.withAudio),
          sourceImage: s.video.startFrameFile || undefined,
          /* Arrival keyframe: the server reads the file, not the asset id.
             H3, Wan and LTX can end on it (FIN_OK). */
          endImage: prequel ? s.video.extendEndFile || undefined
            : FIN_OK.includes(s.video.engine) ? get().video.endFrameFile || undefined : undefined,
          ...(prequel ? { prequel: true } : {}),
          /* Multi-shot: no node parameter exists, the PROMPT drives it. Checked,
             the sequence is announced; unchecked, a single shot is enforced —
             otherwise MiniMax sometimes cuts on its own. */
          // Idempotent (stripShotMarkers): a prompt that already carries a
          // marker (clone, resubmission) does not get a second one.
          composedPositive: s.video.multiShot
            ? `multi-shot sequence with cinematic cuts. ${stripShotMarkers(positive)}`
            : `${stripShotMarkers(positive)}. single continuous shot, no cuts`,
          // Clamped to the engine: after an engine change, the stored value
          // may exceed the new engine's cap — the server
          // would reject it, so send what the selector shows.
          videoSeconds: Math.min(s.video.durationS, engineInfo(s.video.engine).maxSeconds),
          videoFps: s.video.fps,
          videoDraft: s.video.draft && Boolean(engineInfo(s.video.engine).draft),
          /* Continuation or prequel: always the edit (source + continuation); the server then moves the
             continuation alone to the trash. */
          ...(s.video.task === 'extend'
            ? (s.video.extendVideoFile
              ? { concatWith: s.video.extendVideoFile, concatFrom: 'input' as const }
              : s.video.extendAssetId
                ? { concatWith: (s.assets.find(a => a.id === s.video.extendAssetId)?.uri ?? '').split('/').pop() ?? undefined, concatFrom: 'media' as const }
                : {})
            : {}),
          /* "origine" is sent AS IS: the server probes the still's actual file
             at dispatch (front-end dims, attached as fallback, may be stale). */
          videoAspect: s.video.aspect,
          ...(s.video.aspect === 'origine' && s.video.startFrameW && s.video.startFrameH
            ? { videoSrcW: s.video.startFrameW, videoSrcH: s.video.startFrameH } : {}),
        } : {}),
        ...(isEdit ? {
          op: 'edit' as const,
          sourceImage: s.photo.editSourceFile,
          editStyle: s.photo.editStyle ?? undefined,
          // Edit KEEPS the composed prompt from column 3: it is
          // the edit instruction (composed by the LLM), not a scene
          // description. So it is not overwritten.
        } : {}),
        status: 'queued',
      })

      /* CAROUSEL (photo, generation, batch > 1): same outfit, same location, same
         seed — and for each image a different pose, framing and focal length.
         The text is the AUTO prompt rebuilt for each variant: an LLM-composed
         or hand-edited prompt describes the original scene, not the variant.
         The seed is locked for the whole batch (drawn here if random) so the
         N renders share lighting and grain. The current pose and style open
         the batch; the others are drawn without replacement from the vocabulary.
         Unchecked, the batch is N draws of the SAME prompt (different seeds). */
      /* Carousel: OPEN LOCKS (locks[k] === false) mark the dimensions that vary
         per image. Photo/generation, batch > 1, at least one open.
         Each open dimension is drawn without replacement from the vocabulary;
         closed ones stay fixed. */
      const openLocks = (s.mode === 'photo' && !isEdit && n > 1)
        ? (['env', 'outfit', 'pose', 'style'] as const).filter(k => !s.locks[k])
        : []
      const carousel = openLocks.length > 0
      let batch: Job[]
      if (!carousel) {
        batch = Array.from({ length: n }, (_, i) => mkJob(i))
      } else {
        const spread = (pool: { id: string }[], current: string | null) => {
          const others = pool.map(x => x.id)
            .filter(id => id !== current)
            .sort(() => Math.random() - 0.5)
          const ids = [...(current ? [current] : []), ...others]
          return Array.from({ length: n }, (_, i) => ids[i % ids.length] ?? current)
        }
        const envs = openLocks.includes('env') ? spread(ENVIRONMENTS, s.photo.environmentId) : null
        const outfits = openLocks.includes('outfit') ? spread(OUTFITS, s.photo.outfitId) : null
        const poses = openLocks.includes('pose') ? spread(allTextPoses(), s.photo.textPoseId ?? null) : null
        const styles = openLocks.includes('style') ? spread(allStyles(), s.photo.styleId) : null
        const seed = s.seedMode === 'lock' ? s.seedValue : Math.floor(Math.random() * 2 ** 48)
        batch = Array.from({ length: n }, (_, i) => {
          const sel = {
            ...s.photo,
            ...(envs ? { environmentId: envs[i] } : {}),
            ...(outfits ? { outfitId: outfits[i] } : {}),
            ...(poses ? { textPoseId: poses[i] ?? null } : {}),
            ...(styles ? { styleId: styles[i] ?? s.photo.styleId } : {}),
          } as PhotoSelections
          const text = buildPhotoPrompt(sel)
          return { ...mkJob(i), selections: sel, seed: { mode: 'lock' as const, value: seed },
            userPrompt: text, composedPositive: text }
        })
      }
      // Most recent at the top of the list, so the batch is reversed.
      set({ jobs: [...[...batch].reverse(), ...s.jobs], t0Error: null })
      // Sequential: the worker serializes anyway (single GPU), and
      // sending in parallel would only interleave errors.
      const proprietaire = !envoiEnCours
      envoiEnCours = true
      try { for (const j of batch) await worker.submit(j) }
      finally { if (proprietaire) envoiEnCours = false }
      // Submission sent: clear the gallery selection — the workbench shows
      // progress (nothing to display until the render exists).
      /* Submission succeeded: the key has served its purpose. The next one will
         be new — a new press is a new intent, not a retry. */
      set({ focusAssetId: null, initialBrief: null, promptVision: null,
        ...(get().requestId === reqBase ? { requestId: null } : {}) })
    },
  }
}, {
  name: 'creatoros-ui',
  partialize: s => ({
    /* The composition survives reload — mode, task, selections, edited
       prompt, render count. */
    mode: s.mode,
    photo: s.photo,
    video: s.video,
    son: s.son,
    userPrompt: s.userPrompt,
    promptTouched: s.promptTouched,
    userDirectives: s.userDirectives,
    /* The composed prompt too: on mobile the screen locks during the 50 to
       100 s rewrite and the page reloads on return. `composedFrom` travels
       with it so the freshness guard (composedFrom === userPrompt) stays
       exact after reload. */
    composedPositive: s.composedPositive,
    composedNegative: s.composedNegative,
    composedFrom: s.composedFrom,
    composedFor: s.composedFor,
    soulLayer: s.soulLayer,
    moodLayer: s.moodLayer,
    loraStacks: s.loraStacks,
    lastVideoLoras: s.lastVideoLoras,
    galleryColumns: s.galleryColumns,
    libraryColumns: s.libraryColumns,
    folderSort: s.folderSort,
    batchCount: s.batchCount,
    photoEngine: s.photoEngine,
    expert: s.expert,
    textCollapsed: s.textCollapsed,
    carousel: s.carousel,
  }),
  /* A state saved by an OLDER bundle lacks fields added since. Since
     partialize persists the photo/video/son objects WHOLE, default
     rehydration REPLACES them and an unguarded access (`.trim()`) would
     silently crash submitJob. So the persisted state is merged ON TOP of
     the defaults: every missing field is filled. */
  merge: (persisted, current) => {
    const p = (persisted ?? {}) as Partial<typeof current>
    return {
      ...current, ...p,
      photo: { ...current.photo, ...(p.photo ?? {}) },
      video: sansAncienDefaut({ ...current.video, ...(p.video ?? {}) }),
      son: { ...current.son, ...(p.son ?? {}) },
    }
  },
}))
