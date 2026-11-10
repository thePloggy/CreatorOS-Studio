/* ============================================================
   CreatorOS — data contracts
   TypeScript mirror of the data model.
   These types are the interface between the front end and the
   compute layer (ComfyUI worker or stub worker).
   Any change must be mirrored on the worker side.
   ============================================================ */

/* ---------- Modes & registers ---------- */

export type MediaMode = 'photo' | 'video' | 'son'
/** Content register. This edition produces general-audience content only:
 *  the field stays in the contract (jobs, assets) but has a single value. */
export type Register = 'sfw'

/* ---------- Persona (§1-2 of the model) ---------- */

/** Character: defined on the server (configuration); the front end only reads
 *  its display name. */
export interface Persona {
  id: string
  name: string
}

/* ---------- Vocabularies (§3): variable, selected per job ---------- */

/** Multi-attribute outfit.
 *  `prompt` = the full prompt line (source of truth for generation);
 *  garment/material/color = attributes extracted for autocomplete. */
export interface Outfit {
  id: string
  label: string
  garment: string
  material: string
  fit: string
  color: string
  /** Free tags for autocomplete ("robe", "vert"…). */
  tags: string[]
  /** French title (display) — the prompt stays English. */
  labelFr?: string
  /** Full prompt line (English) — takes precedence over attributes in the prompt. */
  prompt?: string
  /** Usage context: city / beach / chic / sport / general. */
  context?: string
  /** Item origin (traceability). */
  source?: string
}

export interface Environment {
  id: string
  label: string
  location: string
  sceneType: string
  weather: string
  tags: string[]
  /** French title (display) — the prompt stays English. */
  labelFr?: string
  /** Full prompt line (English). */
  prompt?: string
  source?: string
}

export interface PhotoStyle {
  id: string
  label: string
  lens: string
  framing: string
  tags: string[]
  /** French title (display). */
  labelFr?: string
  /** outdoor (shoot framings) | selfie (indoor/selfie framings). */
  context?: string
  source?: string
}

/* ---- Additional vocabularies ---- */

export interface Hairstyle { id: string; label: string; labelFr?: string; prompt: string }

/** Pose as text: inserted into the prompt between outfit and framing. */
export interface TextPose {
  id: string; label: string; prompt: string
  context: string; source: string
  labelFr?: string
}

/* ---------- Current selections (console state) ---------- */

/** Photo task: standard generation, or instruction-based edit. */
export type PhotoTask = 'generate' | 'edit'

export interface PhotoSelections {
  task: PhotoTask
  /** `null` = no outfit in the auto text: the written prompt drives. */
  outfitId: string | null
  /** Outfit attribute overrides (hybrid: defaults + fine tuning). */
  outfitOverrides: Partial<Pick<Outfit, 'material' | 'fit' | 'color'>>
  /** Pose AS TEXT: inserted into the prompt between outfit and
   *  framing. `null` = free pose, the model chooses. */
  textPoseId: string | null

  /* ---- ControlNet (Generation task) ----
     Control goes through the Z-Image Fun-ControlNet, wired into both
     fixed recipes. The MODALITY is not a node parameter: the Union model
     infers it from the input map. Choosing "depth" or "openpose" means
     choosing the PREPROCESSOR applied to the reference image.
     Depth carries pose, framing and props;
     openpose yields a generic standing pose. */
  cnRefUri: string
  cnRefName: string
  /** Name of the file placed in ComfyUI's input/ (POST /api/upload). */
  cnRefFile: string
  cnUploadState: 'idle' | 'uploading' | 'ready' | 'error'
  cnUploadError: string
  /** Actual reference dimensions, returned by POST /api/upload. */
  cnRefW: number
  cnRefH: number
  cnType: 'depth' | 'openpose' | 'canny'
  /** `strength` of the QwenImageDiffsynthControlnet node (the node's only
   *  name for control_context_scale). */
  cnStrength: number
  environmentId: string | null
  weatherOverride?: string
  styleId: string | null
  /* ---- Instruction-based edit (task = 'edit') ----
     Source = image (upload OR gallery still) modified by a free-form
     instruction composed by the LLM ("the dress turns red").
     The person is preserved: Qwen-Image-Edit only changes what the
     instruction asks for. */
  editSourceUri: string
  editSourceName: string
  /** Name of the file placed in input/ (upload) or copied from the gallery
   *  via /api/assets/:id/to-input. This is what the graph reads. */
  editSourceFile: string
  /** edit style (Qwen-Image-Edit LoRA chosen by the server) */
  editStyle?: string | null
  /** Id of the gallery asset chosen as source (null if upload). */
  editSourceAssetId: string | null
  editUploadState: 'idle' | 'uploading' | 'ready' | 'error'
  editUploadError: string
}

/** Video task: standard i2v, clip extension, or motion control (a
 *  reference video drives the motion of a still — Wan Animate). */
export type VideoTask = 'i2v' | 'extend' | 'motion_pure' | 't2v'

/** Video: frames with roles. Start required, middle if the model supports it. */
/** Wired i2v engines. The choice is MANUAL: none dominates the others
 *  (see server/jobs.js VIDEO_ENGINES). */
/** Photo recipes of this edition: Krea 2 (default) or FLUX.2 Klein 9B. */
export type PhotoEngine = 'krea' | 'klein' | 'moss' | 'flux3'

/** Character credit: its LoRA author, page, license. */
export interface PersonaCredit { auteur: string; url: string; licence: string }
/** Character wardrobe: favorite vocabulary ids + free lines. */
export interface Garderobe { tenues: string[]; lieux: string[]; perso: { label: string; prompt: string }[] }
export const GARDEROBE_VIDE: Garderobe = { tenues: [], lieux: [], perso: [] }

export type VideoEngine = 'wan' | 'ltx' | 'ltx_hq' | 'minimax' | 'wan_t2v'

export interface VideoSelections {
  task: VideoTask
  /** Render engine, chosen manually. */
  engine: VideoEngine
  /** Engine-native sound — audio is diffused WITH the image, not added
   *  afterwards. Not applicable to Wan, which has no audio stage. */
  withAudio: boolean
  /** Text → video with the active character (requires a video LoRA); otherwise an ambient shot. */
  t2vPersonnage?: boolean
  /** Audio brief (ambience, dialogue line). Merged into the motion prompt:
   *  both sound engines have a single text input shared by image and
   *  sound. Ignored when sound is off. */
  audioText: string
  /** File name of the starting image IN ComfyUI's input folder.
   *  `startAssetId` refers to a library asset; a LoadImage node can only
   *  read a file name — hence both fields. */
  startFrameFile: string
  /** Local preview of a still dropped from disk (outside the library). */
  startFrameUri: string
  /** Still dimensions — they resolve the "origine" aspect. */
  startFrameW: number
  startFrameH: number
  /** Why the still could not be made available to the graph. */
  startFrameError: string
  startAssetId: string | null
  middleAssetId: string | null
  endAssetId: string | null
  /** Copy of the end frame in ComfyUI's input (bare name) — this is what
   *  the job sends as `endImage`, not the asset id. */
  endFrameFile: string
  endFrameError: string
  motionText: string
  cameraText: string
  /* ---- Motion control (task = 'motion_pure') ----
     The UPLOADED reference video drives motion, camera AND duration —
     those i2v settings are ignored in motion mode. */
  /** Reference video driving the motion (upload). */
  motionRefUri: string
  /** Uploaded file name (readable provenance). */
  motionRefName: string
  /** File name STORED on the server (ComfyUI's input/) — the only thing
   *  the pipeline can read. Empty until the upload has succeeded. */
  motionDriverFile: string
  /** Driver duration and frame count (at 24 fps above 30), returned by POST /api/upload —
   *  for the pre-submit estimate (time ∝ frames). */
  motionDriverSeconds: number
  motionDriverFrames: number
  /* ---- Video extension: last frame of a video → i2v start frame ---- */
  extendSource: 'upload' | 'gallery'
  /** Uploaded source video (name in input/) or gallery clip. */
  extendVideoFile: string
  extendAssetId: string | null
  extendVideoUri: string
  extendError: string
  /** 'last' = very last frame · 'sharp' = sharpest frame near the end. */
  extendPick: 'last' | 'sharp'
  /** Server warning (blurry end frame). */
  extendWarn: string
  /** Prequel: the render ENDS on the clip's first frame and is placed before it. */
  extendPrequel?: boolean
  /** Clip's first frame copied into input/ (prequel end frame). */
  extendEndFile?: string
  /** ALSO deliver source + continuation concatenated (second job asset). */
  extendConcat: boolean
  /** Driver upload error, shown where it was rejected. */
  motionDriverError: string
  /** 480x848 preview (~2x faster) instead of the 720x1280 delivery. */
  motionPreview: boolean
  /* ---- Motion control: still + source video ----
     The still is the direct reference: the render's identity can drift
     toward the driver — contract shown in the tab. */
  motionStillFile: string
  motionStillUri: string
  motionStillError: string
  /** MAIN motion-control prompt: character + setting + action.
   *  The motion field only drives the gesture branch. Empty = neutral prefix. */
  motionSceneText: string
  /** Node pose_strength (0.5–1.5): adherence to the driver's gesture. */
  motionPoseStrength: number
  /** Mix: second of the source video to start from (Mix keeps 9.6 s). */
  mixDebut: number
  /** Multi-character Mix: the characters, left to right. */
  mixPersonnes: string[]
  /** reference_image_strength (0.5–1): weight of the still. Lowering it
   *  loosens the fixed context, so the prompt can animate it. */
  motionRefStrength: number
  /** Move (animate): the still replays the gesture; Mix (replace): the character replaces the driver's. */
  motionMode: 'animate' | 'replace'
  /** Library asset chosen as still (exclusive with upload). */
  motionStillAssetId: string | null
  /** Multi-shot: the engine splits into several shots with hard cuts
   *  (MiniMax, prompt-driven — no node parameter exists).
   *  Unchecked: single shot enforced. */
  multiShot: boolean
  /** Optional video LoRAs (turbo, realism, physics…) stacked on the
   *  engine recipe. Empty by default = recipe unchanged. */
  videoLoras: LoraPick[]
  /** Draft: same recipe at reduced resolution (0.4 MP on MiniMax, ~3x
   *  faster). Judges the PROMPT — pacing, energy, slow motion — not the shot:
   *  initial noise changes with resolution, so framing and gesture do
   *  too. No upscale. */
  draft: boolean
  /** Motion output: fps via an interpolation node, resolution via upscale. */
  motionOutFps: 'origine' | '24' | '30' | '60'
  motionOutRes: 'origine' | '480p' | '720p' | '1080p'
  /** 0..1 — motion strength (optional, single scalar). */
  motionStrength: number
  /** Requested duration in seconds (2 to 20 depending on engine). The delivered file has
   *  the GENERATED duration, up to the engine's rounding (MiniMax: 6 s → 6.58 s):
   *  slow motion is fixed in the prompt, not by speeding up afterwards (audio
   *  engines' voice is real-time and does not tolerate atempo). */
  durationS: number
  /** Frame rate of the delivered file. Does not change generation: above the
   *  native rate, export duplicates frames. */
  fps: 24 | 30
  /** 'origine' keeps the starting still's aspect. Other values are those
   *  accepted by ComfyUI's ResolutionSelector node. */
  aspect: VideoAspect
}

/** Ratios accepted by the ResolutionSelector node, plus 'origine'. */
export type VideoAspect = 'origine' | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9'

export type AudioLayer = 'voix' | 'ambiance' | 'musique'

export interface SonSelections {
  layer: AudioLayer
  /** Voice: emotion + pace (language/accent = in the voice anchor). */
  emotion: string
  pace: string
  script: string
  prosodyDirective: string
  /** Ambience: description + target video project. */
  ambianceText: string
  /** Music: royalty-free library track. */
  musicTrackId: string
  projectId: string
}

/* ---------- Job (§8): the execution contract ---------- */

export type JobStatus =
  | 'queued' | 'composing' | 'validated' | 'blocked'
  | 'rendering' | 'post-process' | 'done' | 'review' | 'approved' | 'rejected'
  /* Written by the server: submitted to ComfyUI but still waiting there,
     retry after OOM/connection loss. */
  | 'queued-comfy' | 'retry'

/* The GPU is working for this job: render, but also post passes
   (identity retouch, smoothing: 10 min or more on a motion clip). */
export const STATUTS_EN_CALCUL: JobStatus[] = ['rendering', 'post-process', 'retry']
export const STATUTS_EN_FILE: JobStatus[] = ['queued', 'queued-comfy']
export const STATUTS_ACTIFS: JobStatus[] = [...STATUTS_EN_FILE, ...STATUTS_EN_CALCUL]

export type JobPurpose = 'creative' | 'calibration'

export interface ConditioningRef {
  type: 'frame_start' | 'frame_middle' | 'frame_end' | 'edit_source' | 'motion_ref_video'
  uri: string
  weight?: number
}

/** A LoRA offered by the backend (`GET /api/loras`).
 *  `arch` is READ from the safetensors header, not guessed from the name: a Flux
 *  LoRA applied to a Z-Image graph raises no clear error, it renders a
 *  plausible but wrong image. */
export interface LoraInfo {
  name: string
  arch: 'zimage' | 'flux1' | 'flux2' | 'h3' | 'inconnue' | 'illisible'
  kind: 'identite' | 'identite_ancienne' | 'style' | 'autre'
  scope: Register | 'all' | 'identite' | 'autre'
  /** Trigger word. Without it in the prompt the LoRA is loaded but stays
   *  inert. */
  trigger: string | null
  /** Where the word comes from — `tags` is evidence (ss_tag_frequency, what the
   *  captions contained), `nom` only a suggestion to confirm. */
  triggerSource: 'tags' | 'nom' | 'aucun'
  bytes: number | null
}

/** LoRA stacked on the identity for a job (pose, style). */
export interface LoraPick {
  name: string
  strength: number
  /** Trigger word override. Empty ⇒ the server resolves it from the file. */
  trigger?: string
  /** Muted: stays in the stack, not sent to the render. */
  off?: boolean
}

/** Render progress, relayed from ComfyUI's WebSocket. */
export interface JobProgress { value: number; max: number; etaS: number | null }

export interface Job {
  id: string
  createdAt: number
  /** Render start and total duration (ms) — reported by the API, used by the
   *  "rendering since" counter and "rendered in" in the queue. */
  startedAt?: number | null
  durationMs?: number | null
  /** Estimate made by the server at enqueue (measured coefficients). */
  estimatedMs?: number | null
  personaId: string
  /** Photo diffusion engine chosen in the console (absent: the server's default). */
  photoEngine?: PhotoEngine
  register: Register
  mode: MediaMode
  purpose: JobPurpose
  recipeId: string
  /** Serialized selections (photo | video | sound by mode). */
  selections: PhotoSelections | VideoSelections | SonSelections
  seed: { mode: 'lock' | 'random'; value?: number }
  /** "Image prompt" field (auto from selectors, editable). */
  userPrompt: string
  /** Brief typed BEFORE the Enhancer's "replace prompt" — the original the
   *  composed prompt overwrote on screen (rule: what is displayed is what is sent). */
  initialBrief?: string
  /* What the VLM read in the starting still, given as input to the
     rewriter. Absent if no image was provided. */
  promptVision?: string
  /** prompt rewritten by the FLUX 3 rewriter (what the engine received) */
  promptReecrit?: string
  /** Instructions to the LLM composer (how to phrase). */
  userDirectives: string
  /* Produced by the composer — editable before dispatch (reveal+edit) */
  composedPositive: string
  composedNegative: string
  conditioningRefs: ConditioningRef[]
  /** Stacked AFTER the recipe's identity LoRA, in this order. */
  loras: LoraPick[]
  /* `op` distinguishes a GENERATION from an EDIT. The produced media is a
     photo in both cases, so `mode` cannot carry the distinction. */
  op?: 'generate' | 'edit'
  /** Bare file name in ComfyUI's input/ folder. */
  sourceImage?: string
  editStyle?: string
  /** Z-Image ControlNet inserted into the generation recipe. */
  controlNet?: { file: string; type: 'depth' | 'openpose' | 'canny'; strength: number }
  /* ---- Video ---- */
  videoEngine?: VideoEngine
  /** Ambient shot: text → video, with no starting image or character (LTX). */
  t2v?: boolean
  t2vPersonnage?: boolean
  /** Optional video LoRAs stacked on the engine recipe. */
  videoLoras?: LoraPick[]
  /** Sound request. The server forces it to false on a silent engine. */
  withAudio?: boolean
  /** DELIVERED duration in seconds, file frame rate, aspect. 'origine' is sent
   *  AS IS with videoSrcW/H (actual still dimensions): the server sets literal
   *  dimensions at the exact ratio — snapping to a round ResolutionSelector
   *  ratio would stretch the still. */
  videoSeconds?: number
  videoFps?: number
  videoAspect?: VideoAspect
  videoSrcW?: number
  videoSrcH?: number
  /** Batch: id shared by the jobs of one submission (batch > 1 or
   *  carousel) — groups their renders into a single thumbnail. */
  batchId?: string
  /** Submission IDEMPOTENCY key (unique index on the server). Unique PER JOB,
   *  including within a batch: a shared key would create only one render.
   *  Reused as is on a retry (lost response, suspended app), renewed only
   *  on a new user intent. */
  requestId?: string
  /** Carousel checkboxes at submit time (kept=true / varies=false). */
  carouselLocks?: Record<string, boolean>
  /** Operator prompt at the origin of the lineage (carousel). */
  promptRacine?: string
  /** Per-job photo dimensions — override DEFAULT_SIZE on the server. */
  width?: number
  height?: number
  /** Draft: reduced resolution. Rejected by the server on an engine that
   *  does not support it (server-side VIDEO_ENGINES[...].draft). */
  videoDraft?: boolean
  /** End keyframe (bare file name in input/). Only MiniMax wires it
   *  (`last_frame`); Wan/LTX report it as not injected. */
  endImage?: string
  /** Video extension: concatenate the source (bare name) with the continuation. */
  concatWith?: string
  concatFrom?: 'input' | 'media'
  /* ---- Motion Control: still + source video → Animate ---- */
  motionDriver?: string
  motionPreview?: boolean
  motionSceneText?: string
  motionPoseStrength?: number
  mixDebut?: number
  motionRefStrength?: number
  motionMode?: 'animate' | 'replace'
  /** Clips longer than 81 frames: chained in chunks (default) or context windows. */
  motionJoin?: 'morceaux' | 'fenetres'
  /** Name of the reference still (ComfyUI's input/). */
  motionRef?: string
  status: JobStatus
  /** What the render is doing right now ("loading models", "computing frames", "decoding"…). */
  phase?: string
  /** Timestamp of the latest live preview pushed by ComfyUI (absent: no preview). */
  apercu?: number
  /** Waiting: queue position (1 = next) and estimated wait before start. */
  file?: { rang: number; attenteMs: number }
  /** Failure cause, already translated by the server (server/erreurs.js). */
  error?: string | null
  /** Present only while rendering; approximate (per node). */
  progress?: JobProgress
}

/* ---------- Asset (§10): the library ---------- */

export interface Asset {
  /** 3D object: GLB URL next to the turntable preview. */
  modele3d?: string
  /** Recipe, engine, operation and LoRA, lowercased: for search. */
  search?: string
  id: string
  jobId: string
  /** Character of the job that rendered the asset — the library shows only the active one. */
  personaId?: string | null
  parentAssetId?: string
  /** restoration: the original source, for before / after */
  origineUri?: string
  mediaType: MediaMode
  /** Media URL (placeholder in mock). */
  uri: string
  aspect: string
  /** Dimensions of the rendered file (assets columns). */
  width?: number
  height?: number
  /** Video job frame rate (payload) — selections may be missing (upscale). */
  videoFps?: number
  /** Folders (ids) the asset belongs to — multiple membership. */
  folders?: string[]
  /** Text burned onto the reel (written by the writer, editable). */
  caption?: string
  /** The writer's other suggestions, to pick one without rerunning. */
  captionOptions?: CaptionOption[]
  durationS?: number
  register: Register
  /** Full lineage: copy of selections + seed + prompts.
   *  `userPrompt` / `userDirectives` are required for cloning:
   *  without them the RAW prompt (from the "Prompt image" field) is lost
   *  at generation and "Cloner" cannot repopulate column 3. */
  provenance: Pick<Job,
    'selections' | 'seed' | 'recipeId' | 'composedPositive' | 'composedNegative'
    | 'userPrompt' | 'userDirectives' | 'initialBrief' | 'promptVision' | 'promptReecrit'>
  reviewStatus: 'pending' | 'approved' | 'rejected'
  exportReady: boolean
  createdAt: number
  /** Asset function — generation or edit; i2v engine or 'motion'.
   *  This is what filters the galleries. */
  op?: 'generate' | 'edit'
  videoEngine?: VideoEngine | 'motion'
  /** Rendered in draft mode (reduced resolution, e.g. 0.4 MP): flagged in
   *  the galleries so it is not mistaken for a deliverable render. */
  videoDraft?: boolean
  /** Clip with an audio track (LTX with sound, or added sound effect). */
  withAudio?: boolean
  /** Ambient shot: text → video, without a character. */
  t2v?: boolean
  /** Photo recipe of the render (Krea 2 / FLUX.2 Klein). */
  photoEngine?: PhotoEngine
  /** Finish applied to an existing render (sound effect, smoothing, upscale, HD). */
  postOp?: 'foley' | 'interpolate' | 'upscale' | 'photo_hd'
  /** Source batch (jobs.payload.batchId): assets of one batch are grouped
   *  into a mosaic thumbnail in the v2 galleries. */
  batchId?: string
  /** Multiple membership: a still that seeds several carousels
   *  appears in EACH batch (duplicated on display). */
  batchIds?: string[]
  /** Batch carousel checkboxes (kept/varies) — reliable provenance. */
  batchLocks?: Record<string, boolean>
  /** Job render duration in ms (jobs.duration_ms). 0 or absent = unknown
   *  (job resumed without a start date in the database). */
  renderMs?: number
  /** Automatic clip check (server/controle.js): timestamped defects, face score, take. */
  controle?: Controle
}

export interface Controle {
  boucle?: { ssim: number; propre: boolean }
  duree?: number
  problemes: { type: string; debut: number; fin: number; detail: string; grave: boolean }[]
  visage?: { score: number | null; min?: number; mesures?: number; detail?: string } | null
  /** Expected camera move (preset) and the one read from optical flow. */
  camera?: { attendu: string; mesure: string } | null
  prise?: number
  priseDe?: string
  relance?: string | boolean
  choix?: 'gardée' | 'écartée'
}

/** Variation axis of a photo batch: the seed (same scene, N draws) or a
 *  composition element (same seed, N poses / outfits / locations — for
 *  a consistent carousel). */
/** Deprecated: per-axis batches are replaced by the "carousel" checkbox
 *  (same outfit and location, different poses / framings / focal lengths). */
export type BatchAxis = never

/* ---------- Sound workshop: video project + stems ---------- */

export interface AudioStem {
  id: string
  layer: AudioLayer
  durationS: number
  label: string
}

export interface SoundProject {
  id: string
  label: string
  videoAssetId: string
  videoDurationS: number
  stems: AudioStem[]
}

/* ---------- Worker: shared mock / real interface (§8) ---------- */

/** The front end only talks to this interface: the ComfyUI worker
 *  (via the server). */
export interface GenerationWorker {
  submit(job: Job): Promise<void>
  /** Subscription to status transitions + produced assets. */
  onUpdate(cb: (job: Job, asset?: Asset) => void): () => void
}

/** A caption suggestion and its family (location, mood, outfit…). */
export interface CaptionOption { caption: string; family: string }
