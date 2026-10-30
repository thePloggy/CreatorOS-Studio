/* ============================================================
   CreatorOS — Contrats de données
   Miroir TypeScript du modèle de données projet
   (voir doc projet : creatoros_modele_donnees_8aout2026.md).
   Ces types sont LA « prise » entre la surface (ce front) et le
   plan de calcul (worker ComfyUI réel ou worker bouchon).
   Ne jamais modifier sans répercuter côté worker / agent technique.
   ============================================================ */

/* ---------- Modes & registres ---------- */

export type MediaMode = 'photo' | 'video' | 'son'
/** Registre de contenu. Cette édition ne produit que du contenu tout public :
 *  le champ reste dans le contrat (jobs, assets) mais n'a qu'une valeur. */
export type Register = 'sfw'

/* ---------- Persona (§1-2 du modèle) ---------- */

/** Personnage : défini côté serveur (configuration), le front n'en lit que
 *  le nom d'affichage. */
export interface Persona {
  id: string
  name: string
}

/* ---------- Vocabulaires (§3) : variable, sélectionné par job ---------- */

/** Tenue multi-attributs.
 *  `prompt` = la ligne de prompt complète (source de vérité pour la génération) ;
 *  garment/material/color = attributs extraits pour l'autocomplete. */
export interface Outfit {
  id: string
  label: string
  garment: string
  material: string
  fit: string
  color: string
  /** Tags libres pour l'autocomplete (« robe », « vert »…). */
  tags: string[]
  /** Titre FR (affichage) — le prompt reste EN. */
  labelFr?: string
  /** Ligne de prompt complète (EN) — prioritaire sur les attributs au prompt. */
  prompt?: string
  /** Contexte d'usage : ville / plage / chic / sport / général. */
  context?: string
  /** Origine de l'item (traçabilité). */
  source?: string
}

export interface Environment {
  id: string
  label: string
  location: string
  sceneType: string
  weather: string
  tags: string[]
  /** Titre FR (affichage) — le prompt reste EN. */
  labelFr?: string
  /** Ligne de prompt complète (EN). */
  prompt?: string
  source?: string
}

export interface PhotoStyle {
  id: string
  label: string
  lens: string
  framing: string
  tags: string[]
  /** Titre FR (affichage). */
  labelFr?: string
  /** extérieur (cadrages shooting) | selfie (cadrages intérieur/selfie). */
  context?: string
  source?: string
}

/* ---- Vocabulaires additionnels ---- */

export interface Hairstyle { id: string; label: string; labelFr?: string; prompt: string }

/** Pose exprimée en texte : elle entre dans le prompt, entre la tenue et le cadrage. */
export interface TextPose {
  id: string; label: string; prompt: string
  context: string; source: string
  labelFr?: string
}

/* ---------- Sélections courantes (état de la console) ---------- */

/** Tâche photo : génération classique, ou retouche par instruction. */
export type PhotoTask = 'generate' | 'edit'

export interface PhotoSelections {
  task: PhotoTask
  /** `null` = pas de tenue dans le texte auto : c'est le prompt écrit qui pilote. */
  outfitId: string | null
  /** Overrides d'attributs de la tenue (hybride : défauts + réglage fin). */
  outfitOverrides: Partial<Pick<Outfit, 'material' | 'fit' | 'color'>>
  /** Pose EN TEXTE : c'est elle qui entre dans le prompt, entre la tenue et
   *  le cadrage. `null` = pose libre, le modèle choisit. */
  textPoseId: string | null

  /* ---- ControlNet (tâche Génération) ----
     Le contrôle passe par la Fun-ControlNet Z-Image, branchée sur les deux
     recettes figées. La MODALITÉ n'est pas un paramètre du nœud : le modèle
     Union la déduit de la carte reçue. Choisir « depth » ou « openpose »
     revient donc à choisir le PRÉPROCESSEUR appliqué à l'image de référence.
     Mesuré le 22/08 : depth porte la pose, le cadrage et les accessoires ;
     openpose rend une station debout générique. */
  cnRefUri: string
  cnRefName: string
  /** Nom du fichier déposé dans input/ de ComfyUI (POST /api/upload). */
  cnRefFile: string
  cnUploadState: 'idle' | 'uploading' | 'ready' | 'error'
  cnUploadError: string
  /** Dimensions réelles de la référence, rendues par POST /api/upload. */
  cnRefW: number
  cnRefH: number
  cnType: 'depth' | 'openpose' | 'canny'
  /** `strength` du nœud QwenImageDiffsynthControlnet. Le mandat l'appelle
   *  control_context_scale ; le nœud ne connaît que `strength`. */
  cnStrength: number
  environmentId: string | null
  weatherOverride?: string
  styleId: string | null
  /* ---- Retouche par instruction (task = 'edit') ----
     Source = image (upload OU still de la galerie) qu'on modifie par une
     instruction libre composée par le LLM (« la robe devient rouge »).
     La personne est conservée : Qwen-Image-Edit ne touche que ce que
     l'instruction demande. */
  editSourceUri: string
  editSourceName: string
  /** Nom du fichier déposé dans input/ (upload) ou copié depuis la galerie
   *  via /api/assets/:id/to-input. C'est lui que le graphe lit. */
  editSourceFile: string
  /** Id de l'asset galerie choisi comme source (null si upload). */
  editSourceAssetId: string | null
  editUploadState: 'idle' | 'uploading' | 'ready' | 'error'
  editUploadError: string
}

/** Tâche vidéo : i2v classique, extension d'un clip, ou motion control (une
 *  vidéo de référence pilote le mouvement d'une still — type Wan Animate). */
export type VideoTask = 'i2v' | 'extend' | 'motion_pure' | 't2v'

/** Vidéo : frames à rôles. Start requis, milieu si le modèle le supporte. */
/** Moteurs i2v câblés. Le choix est MANUEL : aucun ne domine les autres,
 *  ils perdent sur des axes différents (cf. server/jobs.js VIDEO_ENGINES). */
/** Recettes photo de l'édition : Krea 2 (défaut) ou FLUX.2 Klein 9B. */
export type PhotoEngine = 'krea' | 'klein' | 'moss'

/** Crédit d'un personnage : l'auteur de sa LoRA, sa page, la licence. */
export interface PersonaCredit { auteur: string; url: string; licence: string }
/** Garde-robe d'un personnage : ids de vocabulaire favoris + lignes libres. */
export interface Garderobe { tenues: string[]; lieux: string[]; perso: { label: string; prompt: string }[] }
export const GARDEROBE_VIDE: Garderobe = { tenues: [], lieux: [], perso: [] }

export type VideoEngine = 'wan' | 'ltx' | 'ltx_hq' | 'minimax' | 'wan_t2v'

export interface VideoSelections {
  task: VideoTask
  /** Moteur de rendu, choisi à la main. */
  engine: VideoEngine
  /** Son natif du moteur — l'audio est diffusé AVEC l'image, pas ajouté
   *  après. Sans objet sur Wan, qui n'a pas d'étage audio. */
  withAudio: boolean
  /** Texte → vidéo avec le personnage actif (il faut une LoRA vidéo) ; sinon plan d'ambiance. */
  t2vPersonnage?: boolean
  /** Brief audio (ambiance, réplique). Rejoint le prompt de mouvement : les
   *  deux moteurs sonores n'ont qu'une seule entrée texte, commune à l'image
   *  et au son. Ignoré quand le son est coupé. */
  audioText: string
  /** Nom du fichier de l'image de départ DANS le dossier input de ComfyUI.
   *  `startAssetId` désigne un asset de la bibliothèque ; un nœud LoadImage,
   *  lui, ne sait lire qu'un nom de fichier — d'où les deux champs. */
  startFrameFile: string
  /** Aperçu local d'une still déposée depuis le disque (hors bibliothèque). */
  startFrameUri: string
  /** Dimensions de la still — elles résolvent le format « origine ». */
  startFrameW: number
  startFrameH: number
  /** Pourquoi la still n'a pas pu être mise à disposition du graphe. */
  startFrameError: string
  startAssetId: string | null
  middleAssetId: string | null
  endAssetId: string | null
  /** Copie de la frame de fin dans l'input ComfyUI (nom nu) — c'est ELLE que
   *  le job envoie en `endImage`, pas l'id d'asset. */
  endFrameFile: string
  endFrameError: string
  motionText: string
  cameraText: string
  /* ---- Motion control (task = 'motion_pure') ----
     La vidéo de référence UPLOADÉE pilote mouvement, caméra ET durée —
     ces réglages i2v sont donc ignorés en motion. */
  /** Vidéo de référence qui pilote le mouvement (upload). */
  motionRefUri: string
  /** Nom du fichier uploadé (provenance lisible). */
  motionRefName: string
  /** Nom du fichier DÉPOSÉ côté serveur (input/ de ComfyUI) — la seule chose
   *  que la chaîne sait lire. Vide tant que le dépôt n'a pas abouti. */
  motionDriverFile: string
  /** Durée et images du driver (à 24 fps au-delà de 30), rendues par POST /api/upload —
   *  pour l'estimation avant envoi (temps ∝ images). */
  motionDriverSeconds: number
  motionDriverFrames: number
  /* ---- Extension vidéo : dernière frame d'une vidéo → start-frame i2v ---- */
  extendSource: 'upload' | 'gallery'
  /** Vidéo source uploadée (nom dans input/) ou clip de la galerie. */
  extendVideoFile: string
  extendAssetId: string | null
  extendVideoUri: string
  extendError: string
  /** 'last' = toute dernière frame · 'sharp' = la plus nette de la fin. */
  extendPick: 'last' | 'sharp'
  /** Avertissement du serveur (frame de fin floue). */
  extendWarn: string
  /** Prequel : le rendu ARRIVE sur la 1re frame du clip et passe devant lui. */
  extendPrequel?: boolean
  /** 1re frame du clip copiée dans input/ (frame de fin du prequel). */
  extendEndFile?: string
  /** Livrer AUSSI source + continuation concaténées (second asset du job). */
  extendConcat: boolean
  /** Erreur de dépôt du driver, affichée à l'endroit du refus. */
  motionDriverError: string
  /** Prévisu 480x848 (~2x plus rapide) au lieu de la livraison 720x1280. */
  motionPreview: boolean
  /* ---- Motion control : still + vidéo source ----
     La still est la réf directe : l'identité du rendu peut être tirée vers
     le driver — contrat affiché dans l'onglet. */
  motionStillFile: string
  motionStillUri: string
  motionStillError: string
  /** Prompt PRINCIPAL du motion control : personnage + décor + action.
   *  Le champ mouvement ne pilote que la branche geste. Vide = préfixe neutre. */
  motionSceneText: string
  /** pose_strength du nœud (0,5–1,5) : adhérence au geste du driver. */
  motionPoseStrength: number
  /** Mix : seconde de la vidéo source où commencer (le Mix en garde 9,6 s). */
  mixDebut: number
  /** reference_image_strength (0,5–1) : poids de la still. La baisser
   *  relâche le contexte figé — le prompt peut alors l'animer. */
  motionRefStrength: number
  /** Move (animate) : la still rejoue le geste ; Mix (replace) : le personnage prend la place de celui du driver. */
  motionMode: 'animate' | 'replace'
  /** Asset de bibliothèque choisi comme still (exclusif de l'upload). */
  motionStillAssetId: string | null
  /** Multi-plans : le moteur découpe en plusieurs plans avec des coupes
   *  franches (constaté sur MiniMax, piloté par le prompt — aucun paramètre
   *  de nœud n'existe). Décoché : plan unique imposé. */
  multiShot: boolean
  /** LoRAs vidéo optionnelles (turbo, réalisme, physique…) empilées sur la
   *  recette du moteur. Défaut vide = recette inchangée. */
  videoLoras: LoraPick[]
  /** Brouillon : même recette à surface réduite (0,4 MP sur MiniMax, ~x3
   *  plus vite). Juge le PROMPT — débit, énergie, ralenti — pas le plan :
   *  le bruit initial change avec la résolution, le cadrage et le geste
   *  aussi. Sans upscale : mesuré, il n'y remet rien. */
  draft: boolean
  /** Sortie motion : fps via nœud d'interpolation, définition via upscale. */
  motionOutFps: 'origine' | '24' | '30' | '60'
  motionOutRes: 'origine' | '480p' | '720p' | '1080p'
  /** 0..1 — force du mouvement (optionnel, scalaire unique). */
  motionStrength: number
  /** Durée demandée, en secondes (2 à 20 selon le moteur). Le fichier livré fait la durée
   *  GÉNÉRÉE, à l'arrondi du moteur près (MiniMax : 6 s → 6,58 s) :
   *  le ralenti se combat au prompt, pas par accélération après coup (la
   *  voix des moteurs audio est en temps réel et ne supporte pas l'atempo). */
  durationS: number
  /** Cadence du fichier livré. Ne change pas la génération : au-dessus de la
   *  cadence native, l'export duplique des images. */
  fps: 24 | 30
  /** 'origine' conserve le format de la still de départ. Les autres valeurs
   *  sont celles qu'accepte le nœud ResolutionSelector de ComfyUI. */
  aspect: VideoAspect
}

/** Formats acceptés par le nœud ResolutionSelector, plus 'origine'. */
export type VideoAspect = 'origine' | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9'

export type AudioLayer = 'voix' | 'ambiance' | 'musique'

export interface SonSelections {
  layer: AudioLayer
  /** Voix : émotion + débit (langue/accent = dans l'ancre voix). */
  emotion: string
  pace: string
  script: string
  prosodyDirective: string
  /** Ambiance : description + projet vidéo cible. */
  ambianceText: string
  /** Musique : piste bibliothèque royalty-free. */
  musicTrackId: string
  projectId: string
}

/* ---------- Job (§8) : le contrat d'exécution ---------- */

export type JobStatus =
  | 'queued' | 'composing' | 'validated' | 'blocked'
  | 'rendering' | 'post-process' | 'done' | 'review' | 'approved' | 'rejected'
  /* Écrits par le serveur : soumis à ComfyUI mais encore en attente chez
     lui, relance après OOM/connexion. */
  | 'queued-comfy' | 'retry'

/* Le GPU travaille pour ce job : rendu, mais aussi les passes d'après
   (retouche d'identité, fluidité : 10 min et plus sur un motion). Sans
   elles l'écran disait « rien en cours » carte à 100 % (10/10). */
export const STATUTS_EN_CALCUL: JobStatus[] = ['rendering', 'post-process', 'retry']
export const STATUTS_EN_FILE: JobStatus[] = ['queued', 'queued-comfy']
export const STATUTS_ACTIFS: JobStatus[] = [...STATUTS_EN_FILE, ...STATUTS_EN_CALCUL]

export type JobPurpose = 'creative' | 'calibration'

export interface ConditioningRef {
  type: 'frame_start' | 'frame_middle' | 'frame_end' | 'edit_source' | 'motion_ref_video'
  uri: string
  weight?: number
}

/** Une LoRA offerte par le backend (`GET /api/loras`).
 *  `arch` est LUE dans l'en-tête safetensors, pas devinée du nom : une LoRA
 *  Flux appliquée à un graphe Z-Image ne lève pas d'erreur franche, elle rend
 *  une image plausible mais fausse. */
export interface LoraInfo {
  name: string
  arch: 'zimage' | 'flux1' | 'flux2' | 'h3' | 'inconnue' | 'illisible'
  kind: 'identite' | 'identite_ancienne' | 'style' | 'autre'
  scope: Register | 'all' | 'identite' | 'autre'
  /** Mot déclencheur. Sans lui dans le prompt, la LoRA est chargée mais reste
   *  inerte — l'image sort plausible et on croit la LoRA faible. */
  trigger: string | null
  /** D'où vient ce mot — `tags` est une preuve (ss_tag_frequency, ce que les
   *  légendes contenaient), `nom` une simple proposition à confirmer. */
  triggerSource: 'tags' | 'nom' | 'aucun'
  bytes: number | null
}

/** LoRA empilée sur l'identité pour un job (pose, style). */
export interface LoraPick {
  name: string
  strength: number
  /** Surcharge du mot déclencheur. Vide ⇒ le serveur résout depuis le fichier. */
  trigger?: string
  /** Coupée : reste dans la pile, ne part pas au rendu. */
  off?: boolean
}

/** Progression du rendu, relayée depuis la WebSocket de ComfyUI. */
export interface JobProgress { value: number; max: number; etaS: number | null }

export interface Job {
  id: string
  createdAt: number
  /** Passage en rendu et durée totale (ms) — remontés par l'API, servent au
   *  compteur « en rendu depuis » et au « rendu en » de la file. */
  startedAt?: number | null
  durationMs?: number | null
  /** Estimation faite par le serveur à l'enqueue (coefficients mesurés). */
  estimatedMs?: number | null
  personaId: string
  /** Moteur de diffusion photo choisi dans la console (absent : celui du serveur). */
  photoEngine?: PhotoEngine
  register: Register
  mode: MediaMode
  purpose: JobPurpose
  recipeId: string
  /** Sélections sérialisées (photo | vidéo | son selon mode). */
  selections: PhotoSelections | VideoSelections | SonSelections
  seed: { mode: 'lock' | 'random'; value?: number }
  /** Champ « prompt image » (auto depuis sélecteurs, éditable). */
  userPrompt: string
  /** Brief tapé AVANT « Remplacer le prompt » de l'Enhancer — l'original
   *  que le composé a écrasé à l'écran (règle « ce qui est affiché part »). */
  initialBrief?: string
  /* Ce que le VLM a lu dans la still de départ, donné en entrée au
     réécriveur. Absent si aucune image n'a été fournie. */
  promptVision?: string
  /** Ordres au composeur LLM (comment formuler). */
  userDirectives: string
  /* Produit par le composeur — éditable avant dispatch (reveal+edit) */
  composedPositive: string
  composedNegative: string
  conditioningRefs: ConditioningRef[]
  /** Empilées APRÈS la LoRA d'identité de la recette, dans cet ordre. */
  loras: LoraPick[]
  /* `op` distingue une GÉNÉRATION d'une ÉDITION. Le média produit reste une
     photo dans les deux cas : `mode` ne peut pas porter la distinction. */
  op?: 'generate' | 'edit'
  /** Nom de fichier nu dans le dossier input/ de ComfyUI. */
  sourceImage?: string
  /** ControlNet Z-Image inséré dans la recette de génération. */
  controlNet?: { file: string; type: 'depth' | 'openpose' | 'canny'; strength: number }
  /* ---- Vidéo ---- */
  videoEngine?: VideoEngine
  /** Plan d'ambiance : texte → vidéo, sans image de départ ni personnage (LTX). */
  t2v?: boolean
  t2vPersonnage?: boolean
  /** LoRAs vidéo optionnelles empilées sur la recette du moteur. */
  videoLoras?: LoraPick[]
  /** Demande de son. Le serveur la ramène à false sur un moteur muet. */
  withAudio?: boolean
  /** Durée LIVRÉE en secondes, cadence du fichier, format. 'origine' part
   *  TEL QUEL accompagné de videoSrcW/H (dims réelles de la still) : le
   *  serveur cale des dimensions littérales au ratio exact — le snap sur un
   *  ratio rond du ResolutionSelector étirait la still (#443-jdjy). */
  videoSeconds?: number
  videoFps?: number
  videoAspect?: VideoAspect
  videoSrcW?: number
  videoSrcH?: number
  /** Lot : identifiant partagé par les jobs d'un même envoi (lot > 1 ou
   *  carrousel) — permet de grouper leurs rendus en une seule vignette. */
  batchId?: string
  /** Clé d'IDEMPOTENCE d'envoi (index unique côté serveur). Unique PAR JOB,
   *  y compris dans un lot : une clé partagée ne créerait qu'un seul rendu.
   *  Réutilisée telle quelle sur une reprise (réponse perdue, app suspendue),
   *  renouvelée seulement sur une nouvelle intention de l'utilisateur. */
  requestId?: string
  /** Cases du carrousel au moment de l'envoi (gardé=true / varie=false). */
  carouselLocks?: Record<string, boolean>
  /** Prompt de l'opérateur à l'origine de la lignée (carrousel v2). */
  promptRacine?: string
  /** Dimensions photo par job (v2) — surchargent DEFAULT_SIZE côté serveur. */
  width?: number
  height?: number
  /** Brouillon : surface réduite. Refusé par le serveur sur un moteur qui
   *  ne le porte pas (VIDEO_ENGINES[...].draft côté serveur). */
  videoDraft?: boolean
  /** Keyframe d'arrivée (nom de fichier nu dans input/). MiniMax seul la
   *  câble (`last_frame`) ; Wan/LTX la signalent non injectée. */
  endImage?: string
  /** Extension vidéo : concaténer la source (nom nu) à la continuation. */
  concatWith?: string
  concatFrom?: 'input' | 'media'
  /* ---- Motion Control : still + vidéo source → Animate ---- */
  motionDriver?: string
  motionPreview?: boolean
  motionSceneText?: string
  motionPoseStrength?: number
  mixDebut?: number
  motionRefStrength?: number
  motionMode?: 'animate' | 'replace'
  /** Clips de plus de 81 images : enchaînés par morceaux (défaut) ou fenêtres de contexte (ancienne voie). */
  motionJoin?: 'morceaux' | 'fenetres'
  /** Nom de la still qui sert de réf (input/ de ComfyUI). */
  motionRef?: string
  status: JobStatus
  /** Ce que fait le rendu en ce moment (« chargement des modèles », « calcul des images », « décodage »…). */
  phase?: string
  /** Horodatage du dernier aperçu en direct poussé par ComfyUI (absent : pas d'aperçu). */
  apercu?: number
  /** En attente : rang dans la file (1 = le prochain) et attente estimée avant le départ. */
  file?: { rang: number; attenteMs: number }
  /** Cause de l'échec, déjà traduite par le serveur (server/erreurs.js). */
  error?: string | null
  /** Présente uniquement pendant le rendu ; approximative (par nœud). */
  progress?: JobProgress
}

/* ---------- Asset (§10) : la bibliothèque, livrable du POC ---------- */

export interface Asset {
  /** Recette, moteur, opération et LoRA, en minuscules : pour la recherche. */
  search?: string
  id: string
  jobId: string
  /** Personnage du job qui a rendu l'asset — la bibliothèque n'affiche que l'actif. */
  personaId?: string | null
  parentAssetId?: string
  mediaType: MediaMode
  /** URL du média (placeholder en mock). */
  uri: string
  aspect: string
  /** Dimensions du fichier rendu (colonnes assets). */
  width?: number
  height?: number
  /** Cadence du job vidéo (payload) — les selections peuvent manquer (upscale). */
  videoFps?: number
  /** Dossiers (ids) auxquels l'asset appartient — appartenances multiples. */
  folders?: string[]
  /** Texte gravé sur le reel (écrit par le rédacteur, modifiable). */
  caption?: string
  /** Les autres propositions du rédacteur, pour en choisir une sans relancer. */
  captionOptions?: CaptionOption[]
  durationS?: number
  register: Register
  /** Lignée complète : copie des sélections + seed + prompts.
   *  `userPrompt` / `userDirectives` sont indispensables au clonage :
   *  sans eux, le prompt BRUT (celui du champ « Prompt image ») est perdu
   *  à la génération et « Cloner » ne peut plus repeupler la colonne 3. */
  provenance: Pick<Job,
    'selections' | 'seed' | 'recipeId' | 'composedPositive' | 'composedNegative'
    | 'userPrompt' | 'userDirectives' | 'initialBrief' | 'promptVision'>
  reviewStatus: 'pending' | 'approved' | 'rejected'
  exportReady: boolean
  createdAt: number
  /** Fonction de l'asset — génération ou retouche ; moteur i2v ou 'motion'.
   *  C'est ce qui filtre les galeries. */
  op?: 'generate' | 'edit'
  videoEngine?: VideoEngine | 'motion'
  /** Rendu en mode brouillon (surface réduite, ex. 0,4 MP) : à baliser dans
   *  les galeries pour ne pas confondre avec un rendu livrable. */
  videoDraft?: boolean
  /** Clip avec piste son (LTX avec 🔊, ou bruitage ajouté). */
  withAudio?: boolean
  /** Plan d'ambiance : texte → vidéo, sans personnage. */
  t2v?: boolean
  /** Recette photo du rendu (Krea 2 / FLUX.2 Klein). */
  photoEngine?: PhotoEngine
  /** Finition appliquée à un rendu existant (bruitage, fluidité, upscale, HD). */
  postOp?: 'foley' | 'interpolate' | 'upscale' | 'photo_hd'
  /** Lot d'origine (jobs.payload.batchId) : les assets d'un même lot se
   *  regroupent en une vignette-mosaïque dans les galeries v2. */
  batchId?: string
  /** Appartenances multiples : une still origine de plusieurs carrousels
   *  apparaît dans CHAQUE lot (dupliquée à l'affichage). */
  batchIds?: string[]
  /** Cases du carrousel du lot (gardé/varie) — provenance fiable. */
  batchLocks?: Record<string, boolean>
  /** Durée du rendu du job en ms (jobs.duration_ms). 0 ou absent = inconnue
   *  (job repris sans date de départ en base). */
  renderMs?: number
  /** Contrôle automatique du clip (server/controle.js) : défauts horodatés, score de visage, prise. */
  controle?: Controle
}

export interface Controle {
  duree?: number
  problemes: { type: string; debut: number; fin: number; detail: string; grave: boolean }[]
  visage?: { score: number | null; min?: number; mesures?: number; detail?: string } | null
  /** Mouvement de caméra attendu (preset) et lu dans le flux optique. */
  camera?: { attendu: string; mesure: string } | null
  prise?: number
  priseDe?: string
  relance?: string | boolean
  choix?: 'gardée' | 'écartée'
}

/** Axe de variation d'un lot photo : la seed (même scène, N tirages) ou un
 *  élément de composition (même seed, N poses / tenues / lieux — de quoi
 *  faire un carrousel cohérent). */
/** Retiré le 29/08 : le lot par axe est remplacé par la case « carrousel »
 *  (même tenue et lieu, poses / cadrages / focales différents). */
export type BatchAxis = never

/* ---------- Atelier son : projet vidéo + stems ---------- */

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

/* ---------- Worker : interface commune mock / réel (§8) ---------- */

/** Le front ne parle qu'à cette interface : le worker ComfyUI réel
 *  (via le serveur). */
export interface GenerationWorker {
  submit(job: Job): Promise<void>
  /** Abonnement aux transitions de statut + assets produits. */
  onUpdate(cb: (job: Job, asset?: Asset) => void): () => void
}

/** Une proposition de caption et sa famille (lieu, humeur, outfit…). */
export interface CaptionOption { caption: string; family: string }
