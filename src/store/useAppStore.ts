/* ============================================================
   Store global (zustand) — état de la console + jobs + assets.
   Un seul store, découpé par domaines. Les composants lisent
   des tranches ; toute la logique d'envoi passe par ici.
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
import { worker, fetchAssets, pushReview, deleteAsset as apiDeleteAsset, cancelJob as apiCancelJob } from '../worker/apiWorker'
import { OUTFITS, ENVIRONMENTS, STYLES, MUSIC_LIBRARY, firstId } from '../data/vocabularies'
import { allTextPoses, allStyles } from './useVocabStore'
import { setEngineCatalog } from '../features/console/video/engines'
import { setT0Blocklist } from '../core/validator'
import { audioEffective, engineInfo, moteurT2v, VIDEO_ENGINES } from '../features/console/video/engines'
import type { RenderRates } from '../lib/progress'
import { t, tServeur } from '../i18n'

/** Onglet de composition : mode + tâche (photo:generate, video:i2v, video:motion_pure…). */
const ongletDe = (s: { mode: string; photo: { task: string }; video: { task: string } }) =>
  s.mode === 'video' ? `video:${s.video.task}` : `photo:${s.photo.task}`

/* ---------- État ---------- */

export interface StageScene { objets: { type: 'personne' | 'boite'; x: number; z: number; h: number; l?: number; p?: number }[]; camera: { oeil: number[] }[]; prompt: string }

interface AppState {
  /* Navigation */
  mode: MediaMode
  /** Nom d'affichage du personnage, configuré côté serveur (/api/health). */
  personaName: string
  /** Personnage actif (id serveur) : la bibliothèque ne montre que ses rendus. */
  personaId: string | null
  /** Le personnage actif a-t-il une LoRA d'identité FLUX.2 Klein ? Sinon la recette Klein est grisée. */
  personaKlein: boolean
  /** Le personnage actif a-t-il une LoRA vidéo ? Le texte → vidéo peut alors le montrer. */
  personaVideo: boolean
  /** La LoRA vidéo du personnage est une LoRA Wan (texte → vidéo sur Wan T2V). */
  personaVideoWan: boolean
  /** Crédit de la LoRA du personnage actif (auteur, page, licence). */
  personaCredit: PersonaCredit | null
  /** Garde-robe du personnage actif : éléments favoris (tenues, lieux) et lignes libres. */
  personaGarderobe: Garderobe
  setGarderobe: (g: Garderobe) => Promise<string | null>
  /** URL de la photo de profil de la persona (avec jeton ?v=), null = rond neutre. */
  personaAvatar: string | null
  uploadPersonaAvatar: (file: File) => Promise<void>
  /** Relit le personnage actif (nom, photo) — après un changement de personnage. */
  refreshPersona: () => Promise<void>
  /** Asset à ouvrir en grande vue (palette ⌘K → galerie). Consommé puis remis à null. */
  focusAssetId: string | null
  setFocusAsset: (id: string | null) => void
  /** Ce que le serveur préfixe au prompt, lu de /api/health (bloc des 4 couches). */
  serverInfo: { preambles: Record<string, string>; composerModels: Record<string, string>; renderRates: RenderRates | null } | null
  promoteJob: (id: string) => Promise<void>
  /** Suppression DÉFINITIVE d'un job terminé/bloqué : la ligne, ses rendus et
   *  leurs fichiers (cascade serveur). Rend le nombre de rendus emportés. */
  deleteJob: (id: string) => Promise<number>
  uploadExtendVideo: (file: File) => Promise<void>
  pickExtendClip: (assetId: string) => Promise<void>
  setExtendPick: (pick: 'last' | 'sharp') => Promise<void>
  setExtendPrequel: (on: boolean) => Promise<void>
  extractExtendFrame: () => Promise<void>
  /** Nouvel ordre de la file d'attente (ids des jobs en attente, dans l'ordre voulu). */
  reorderJobs: (ids: string[]) => Promise<void>

  /* Sélections par mode */
  photo: PhotoSelections
  video: VideoSelections
  son: SonSelections

  /* Prompt (colonne 3) */
  userPrompt: string          // ↻ auto depuis sélecteurs, éditable
  promptTouched: boolean      // true dès que l'utilisateur édite à la main
  userDirectives: string
  composedPositive: string
  composedNegative: string
  /** Prompt auto tel qu'il était AU MOMENT de la composition. Sert à savoir
   *  si le composé a été laissé derrière par un changement de sélecteur :
   *  c'est lui qui part au job, un composé périmé gagne donc silencieusement
   *  sur des sélections plus récentes. */
  composedFrom: string
  /** Onglet où le composé a été écrit (mode + tâche) : il ne part que de là. */
  composedFor: string
  composing: boolean
  t0Error: string | null
  /** Couches rewriter SOUL/MOOD (scaffold, défaut null = OFF). Passées au
   *  composeur ; null → prompt composé strictement identique à sans. */
  soulLayer: string | null
  moodLayer: string | null
  seedMode: 'lock' | 'random'
  seedValue: number
  /** Seed RÉELLEMENT tirée par le serveur au dernier job. En mode aléatoire
   *  c'est la seule façon de retrouver un rendu qu'on vient de voir. */
  lastSeed: number | null

  /* LoRA additionnelles empilées sur l'identité (pose/style).
     La liste OFFERTE vient du backend — jamais figée ici : elle dépend
     de ce qui est réellement présent dans ~/models/loras. */
  loraCatalog: LoraInfo[]
  loraPicks: LoraPick[]

  /* Jobs & assets */
  jobs: Job[]
  assets: Asset[]

  /* Galerie */
  galleryColumns: number
  /** Densité de la Bibliothèque. Réglage SÉPARÉ de `galleryColumns` : la
   *  colonne 4 fait 300 px de large, la Bibliothèque occupe l'écran — une
   *  valeur commune donnerait des vignettes minuscules d'un côté ou une
   *  seule colonne de l'autre. */
  libraryColumns: number
  /** Ordre d'apparition des dossiers — réglage unique, valable pour TOUTES
   *  les listes de dossiers (sidebar, menu « Déplacer vers… », fiche détail,
   *  feuille mobile). Comme un Finder : le tri suit l'opérateur, pas l'écran. */
  folderSort: FolderSort
  setFolderSort: (v: FolderSort) => void

  /* Nombre de rendus lancés par « Envoyer » — 1 à 5, même prompt. */
  batchCount: number
  /** Axe de variation du lot photo (seed par défaut). */
  /** Carrousel : le lot garde tenue et lieu, change pose, cadrage et focale à
   *  chaque image (même seed). Décoché : N images du même prompt, seeds
   *  différentes. Indépendant du nombre de rendus. */
  carousel: boolean

  /* Carrousel v5 — VERROUS PAR LIGNE de recette : fermé (true) = valeur fixe
   *  pour tout le lot ; ouvert (false) = varie à chaque image (tirage front).
   *  Défaut tout fermé. Le carrousel est actif dès qu'un verrou est ouvert. */
  locks: Record<'env' | 'outfit' | 'pose' | 'style', boolean>
  toggleLock: (k: 'env' | 'outfit' | 'pose' | 'style') => void

  /* Mode expert : masque les textes d'aide explicatifs (note d'intrant,
   *  chaîne déduite) et révèle la chaîne compacte. Préférence d'affichage. */
  expert: boolean
  toggleExpert: () => void

  /** Volet « LE TEXTE » (bandeau bas de l'établi) replié. Préférence d'affichage. */
  textCollapsed: boolean
  toggleTextCollapsed: () => void

  /* Bibliothèque : actions de revue (le garde-fou manuel vit ici) */
  reviewAsset: (id: string, status: Asset['reviewStatus']) => void
  toggleExportReady: (id: string) => void
  /** Caption gravée d'un reel, écrite à la main ou choisie parmi les propositions. */
  setCaption: (id: string, caption: string) => void
  /** Clé d'idempotence de l'envoi EN COURS. Posée au premier essai, gardée
   *  tant qu'il n'a pas abouti (une reprise réutilise la même clé et le
   *  serveur rend le job déjà créé), effacée après succès : l'envoi suivant
   *  est une nouvelle intention, donc une nouvelle clé. */
  requestId: string | null
  /** Suppression définitive : ligne, provenance et fichier sur disque. */
  removeAsset: (id: string) => Promise<void>
  /** Suppression en lot, tolérante aux échecs partiels. Retourne ce qui a
   *  réellement été supprimé pour que la vue le dise, plutôt qu'un succès muet. */
  removeAssets: (ids: string[]) => Promise<{ removed: number; failed: string[] }>
  /** Dernières suppressions (corbeille côté serveur) : de quoi proposer « annuler ». */
  lastDeleted: { ids: string[]; at: number } | null
  dismissDeleted: () => void
  undoDelete: () => Promise<string | null>
  setBatchCount: (n: number) => void
  setCarousel: (on: boolean) => void
  /** Vide tenue, lieu, pose et style : le texte auto devient vide, l'opérateur pilote au prompt. */
  clearComposition: () => void
  /** « ▷ Animer » depuis une photo : bascule en vidéo i2v avec cette still. */
  animateFrom: (asset: Asset) => Promise<void>
  boucleFrom: (asset: Asset) => Promise<void>
  stageOuvert: boolean
  stageRepris: StageScene | null
  ouvrirStage: (scene?: StageScene | null) => void
  /** « ✎ Retoucher » depuis une photo : bascule en photo/edit, image source. */
  retouchFrom: (asset: Asset) => Promise<void>
  /** « ⇥ Prolonger » depuis une vidéo : bascule en vidéo/extend, ce clip en source. */
  extendFrom: (asset: Asset) => Promise<void>

  /* Actions */
  /** Charge la bibliothèque persistée (SQLite → galerie) au démarrage. */
  hydrate: () => Promise<void>
  /** Recharge un asset dans la console (colonnes 2 & 3), en UN set atomique. */
  cloneFrom: (asset: Asset) => void
  /** Suit un job créé côté serveur (retouche au pinceau, etc.) : il apparaît dans la file de l'interface. */
  adoptServerJob: (id: string) => Promise<void>
  /** Demande de navigation posée par le clone : la console vit dans les
   *  sections Image/Vidéo, or on clone aussi depuis Assets (ou une autre
   *  section) — sans ça les réglages atterrissaient dans une console
   *  invisible. Le nonce force la prise en compte même si la cible ne
   *  change pas. Consommée par le shell (V2App). */
  navRequest: { section: 'image' | 'video' | 'presets' | 'parole' | 'reshoot'; nonce: number } | null
  /** « Utiliser dans… » (30/10) : le média que la section cible reprend à son ouverture,
   *  puis efface. Les sections gardent leur source en état local ; ce champ est le seul pont. */
  passerelle: { cible: 'presets' | 'parole' | 'reshoot'; assetId: string } | null
  utiliserDans: (cible: 'presets' | 'parole' | 'reshoot', asset: Asset) => void
  prendrePasserelle: (cible: 'presets' | 'parole' | 'reshoot') => Asset | null
  setMode: (m: MediaMode) => void
  /** prompts séparés par mode : chaque section retrouve son texte (image XXX / vidéo YYY). */
  promptStash: Partial<Record<MediaMode, { text: string; touched: boolean }>>
  /** brief d'origine écrasé par « Remplacer » de l'Enhancer (provenance). */
  initialBrief: string | null
  /* Description VLM de la still, retenue au moment où l'Enhancer est
     appliqué. Elle part avec le job pour être relisible en vue détail : un
     prompt composé surprenant s'explique soit par une image mal lue, soit par
     une consigne mal suivie, et on ne peut pas trancher sans elle. */
  promptVision: string | null
  updatePhoto: (patch: Partial<PhotoSelections>) => void
  updateVideo: (patch: Partial<VideoSelections>) => void
  /** Piles de LoRA nommées, par famille de moteur ('photo', 'h3', 'wan', 'ltx'). */
  loraStacks: Record<string, { name: string; items: LoraPick[] }[]>
  /** Dernières LoRA vidéo utilisées par famille : rappelées quand on revient sur le moteur. */
  lastVideoLoras: Record<string, LoraPick[]>
  saveLoraStack: (cle: string, name: string, items: LoraPick[]) => void
  deleteLoraStack: (cle: string, name: string) => void
  updateSon: (patch: Partial<SonSelections>) => void
  setUserPrompt: (v: string) => void
  /** Annule l'édition manuelle et resynchronise le prompt auto sur les
   *  sélecteurs. Sans ça, `promptTouched` est un aller simple : une seule
   *  frappe fige le prompt pour toute la session, sans rien afficher. */
  resetPrompt: () => void
  setUserDirectives: (v: string) => void
  setSoulLayer: (v: string | null) => void
  setMoodLayer: (v: string | null) => void
  /** Charge l'inventaire réel des LoRA depuis le backend. */
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
  /** Saisie directe d'une seed en mode lock (v2). */
  setSeedValue: (v: number) => void
  /** batchId imposé au prochain submitJob (carrousel v2) — consommé puis remis à null. */
  carouselBatchId: string | null
  setCarouselBatchId: (v: string | null) => void
  carouselLocks: Record<string, boolean> | null
  setCarouselLocks: (v: Record<string, boolean> | null) => void
  /** Prompt de l'opérateur à l'origine de la lignée, porté par les jobs d'un
   *  carrousel : un carrousel relancé depuis un de ses plans repart de lui. */
  carouselPromptRacine: string | null
  setCarouselPromptRacine: (v: string | null) => void
  /** Format photo (v2) : dimensions envoyées avec le job. null = défaut recette. */
  photoSize: { w: number; h: number; label: string } | null
  photoEngine: PhotoEngine
  setPhotoEngine: (e: PhotoEngine) => void
  setPhotoSize: (v: { w: number; h: number; label: string } | null) => void
  composeNow: () => Promise<void>
  /** Retouche par instruction : image source depuis le disque… */
  uploadEditSource: (file: File) => Promise<void>
  /** …ou depuis la galerie (recopiée dans input/ via /api/assets/:id/to-input). */
  pickEditSource: (assetId: string) => Promise<void>
  /** Même dépôt que ci-dessus, pour l'image de référence ControlNet. */
  uploadCnRef: (file: File) => Promise<void>
  /** Choisit une still de la bibliothèque comme image de départ vidéo. Le
   *  serveur la recopie dans le dossier input/ de ComfyUI et rend le NOM :
   *  c'est la seule chose qu'un nœud LoadImage sait lire. */
  pickStartFrame: (assetId: string) => Promise<void>
  /** Frame de fin (keyframe d'arrivée, moteurs MiniMax H3) : copiée dans
   *  l'input ComfyUI comme la frame de départ. */
  pickEndFrame: (assetId: string) => Promise<void>
  /** Dépôt d'une image de départ venue du disque (hors bibliothèque). */
  uploadStartFrame: (file: File) => Promise<void>
  /** Dépôt de la vidéo driver du Motion Control. */
  uploadMotionDriver: (file: File) => Promise<void>
  /** Dépôt de la still du Motion Control (réf directe). */
  uploadMotionStill: (file: File) => Promise<void>
  /** Still du Motion Control choisie dans la bibliothèque. */
  pickMotionStill: (assetId: string) => Promise<void>
  /** Annule un job en file ou en cours. Rend le message d'échec éventuel. */
  /** Relance un job terminé avec ses réglages d'origine ; rend le message d'erreur, ou null. */
  retryJob: (id: string, draft?: boolean, nouvelleGraine?: boolean) => Promise<string | null>
  /** « Encore une » : relance le job d'un rendu avec ses réglages et une graine neuve. */
  encoreUne: (asset: Asset) => Promise<string | null>
  cancelJob: (id: string) => Promise<string | null>
  submitJob: () => Promise<void>

  /** Envoi mobile : envoie et dit si l'envoi est parti (bandeau sinon). */
  submitJobMobile: () => Promise<boolean>
  /** « ↻ seed » de l'onglet Jobs : même recette, seed re-tirée, sans rouvrir
   *  la composition. S'appuie sur ce que la liste des jobs expose. */
  relaunchJob: (jobId: string) => Promise<void>
}

/* ---------- Défauts ---------- */

/* Défauts = premiers items de chaque vocabulaire. */
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
  editSourceAssetId: null,
  editUploadState: 'idle',
  editUploadError: '',
}

const defaultVideo: VideoSelections = {
  task: 'i2v',
  // Wan par défaut : muet, mais c'est lui qui rend l'image la plus propre,
  // et un plan muet propre se rattrape au montage alors qu'un plan sale non.
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
  motionSceneText: '', motionPoseStrength: 1, mixDebut: 0, motionRefStrength: 1, motionMode: 'animate',
  multiShot: false, draft: false, videoLoras: [],
  motionOutFps: 'origine', motionOutRes: 'origine',
  motionText: 'respiration douce, léger mouvement des cheveux, sourire vers l’objectif',
  cameraText: 'push-in lent',
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

/* Les identifiants de job sont la clé primaire côté SQLite : deux sessions
   du navigateur ne doivent pas produire le même. Le compteur reste lisible
   (#443), un suffixe de session le rend unique dans la durée. */
let jobCounter = 442
/** Moteurs à keyframes (MiniMaxH3ImageToVideo : first_frame / last_frame). */
const H3: string[] = ['minimax']
/** Une LoRA vidéo nommée « …wan… » (paire haut / bas bruit) : identité portée par Wan. */
const estLoraWan = (l: unknown[] | undefined) => (l ?? []).some(x => /wan/i.test(String((x as { name?: string })?.name ?? '')))
/** Un envoi de lot est en cours (les POST partent un par un). */
let envoiEnCours = false
const SESSION_TAG = Math.random().toString(36).slice(2, 6)

/** Références de conditionnement dérivées des sélections
 *  (image source, frames, vidéo de référence motion…). */
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

/** Dimensions de latent au FORMAT d'une référence, ~1 Mpx, multiples de 16.
 *  Renvoie {} si la référence n'a pas de taille connue : la recette garde
 *  alors son défaut plutôt que de recevoir des dimensions inventées. */
function latentFor(w: number, h: number): { width?: number; height?: number } {
  if (!w || !h) return {}
  const k = Math.sqrt(1_000_000 / (w * h))
  const r = (v: number) => Math.max(256, Math.round((v * k) / 16) * 16)
  return { width: r(w), height: r(h) }
}

/** Retire les marqueurs de plan ajoutés à la SOUMISSION vidéo. Sans ça, un
 *  clone repart avec un prompt qui les porte déjà et la soumission les
 *  re-suffixe : « single continuous shot, no cuts » s'empile à chaque clone. */
function stripShotMarkers(p: string): string {
  return p
    .replace(/^multi-shot sequence with cinematic cuts\.\s*/i, '')
    .replace(/[.\s]*\bsingle continuous shot, no cuts\b[.\s]*$/i, '')
}

/* ---------- Store ---------- */

/** Un job tel que l'API le rend → le Job du store (reprise après rechargement, relance). */
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

/* Persistance : UNIQUEMENT les préférences d'affichage.
   `partialize` n'est pas une optimisation, c'est la condition pour que ça
   marche : sans lui, `jobs` et `assets` partiraient en localStorage et la
   galerie se rechargerait sur un instantané périmé, en concurrence avec
   `hydrate()` qui lit la base. Ce qui vient du serveur doit venir du serveur. */
export const useAppStore = create<AppState>()(persist((set, get) => {
  // Abonnement unique aux updates du worker (mock ou réel).
  worker.onUpdate((job, asset) => {
    set(s => ({
      jobs: s.jobs.map(j => (j.id === job.id ? job : j)),
      // le rendu d'un autre personnage (lancé avant un changement) n'entre pas dans la grille
      assets: asset && (!asset.personaId || !s.personaId || asset.personaId === s.personaId) ? [asset, ...s.assets] : s.assets,
      // En mode aléatoire la seed est tirée côté serveur : sans ce retour,
      // l'opérateur voit une image qu'il ne peut plus reproduire.
      lastSeed: Number.isFinite(job.seed?.value) ? (job.seed!.value as number) : s.lastSeed,
    }))
  })

  return {
    mode: 'photo',
    personaName: 'Personnage',
    personaId: null,
    personaKlein: false,
    personaVideo: false,
    personaVideoWan: false,
    personaCredit: null,
    personaGarderobe: GARDEROBE_VIDE,
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
      // Refléter l'ordre localement : les jobs en attente dans l'ordre demandé,
      // les autres inchangés à leur place.
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
    /* Défaut ALÉATOIRE. Il était sur « lock » avec une valeur en dur : tous
       les jobs d'une session partageaient donc la seed 1837442, et les rendus
       se ressemblaient sans raison visible. Le verrou reste à un clic, mais
       il doit être un geste délibéré, pas l'état de départ. */
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

    // Borné ici plutôt qu'au rendu : un composant qui enverrait 50 jobs
    // saturerait la file pour un quart d'heure.
    setBatchCount: n => set({ batchCount: Math.max(1, Math.min(10, Math.round(n))) }),
    setCarousel: carousel => set({ carousel }),
    clearComposition: () => get().updatePhoto({ outfitId: null, environmentId: null, styleId: null, textPoseId: null, outfitOverrides: {}, weatherOverride: undefined }),
    /* Ces trois-là emmènent l'opérateur AILLEURS : ils posent donc la même
       demande de navigation que le clone. Le desktop passe déjà ses propres
       callbacks (goVideo/goImage) et ignore le champ — l'ajouter ne change
       rien pour lui ; le mobile, lui, n'a que ce canal. */
    utiliserDans: (cible, asset) =>
      set(st => ({ passerelle: { cible, assetId: asset.id }, navRequest: { section: cible, nonce: (st.navRequest?.nonce ?? 0) + 1 } })),
    prendrePasserelle: cible => {
      const p = get().passerelle
      if (p?.cible !== cible) return null
      set({ passerelle: null })
      return get().assets.find(a => a.id === p.assetId) ?? null
    },

    animateFrom: async asset => {
      if (asset.mediaType !== 'photo') return
      get().setMode('video')
      get().updateVideo({ task: 'i2v' })
      set(st => ({ navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      await get().pickStartFrame(asset.id)
    },

    stageOuvert: false,
    stageRepris: null,
    ouvrirStage: (scene = null) => set(st => ({ stageOuvert: true, stageRepris: scene, navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } })),

    /* Boucle : la même photo en départ et en arrivée, sur Wan (seul moteur qui porte les deux). */
    boucleFrom: async asset => {
      await get().animateFrom(asset)
      get().updateVideo({ engine: 'wan' })
      await get().pickEndFrame(asset.id)
    },

    retouchFrom: async asset => {
      if (asset.mediaType !== 'photo') return
      get().setMode('photo')
      get().updatePhoto({ task: 'edit' })
      set(st => ({ navRequest: { section: 'image', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      await get().pickEditSource(asset.id)
    },

    extendFrom: async asset => {
      if (asset.mediaType !== 'video') return
      set(st => ({ navRequest: { section: 'video', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
      get().setMode('video')
      get().updateVideo({ task: 'extend' })
      await get().pickExtendClip(asset.id)
    },

    /** Suppression définitive. On attend le serveur avant de retirer la
     *  vignette : disparaître de l'écran puis réapparaître au rechargement
     *  parce que la suppression a échoué est pire que d'attendre 100 ms. */
    removeAsset: async id => {
      await apiDeleteAsset(id)
      set(s => ({ assets: s.assets.filter(a => a.id !== id) }))
    },

    /** Séquentiel et tolérant : un asset qui échoue ne doit ni interrompre les
     *  suivants, ni disparaître de la liste alors qu'il est toujours en base.
     *  On ne retire que ce que le serveur a confirmé. */
    removeAssets: async ids => {
      const ok: string[] = []
      const failed: string[] = []
      for (const id of ids) {
        try { await apiDeleteAsset(id); ok.push(id) }
        catch (e) { failed.push(id); console.error('[suppression]', id, e) }
      }
      if (ok.length) {
        const gone = new Set(ok)
        /* Suppressions rapprochées : une seule annonce, une seule annulation. */
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
        const p = await (await fetch('/api/persona')).json() as { id?: string; name?: string | null; avatar?: string | null; lorasKlein?: unknown[]
          videoLoras?: unknown[]; credit?: PersonaCredit | null; garderobe?: Garderobe }
        set({ personaVideo: Boolean(p.videoLoras?.length), personaVideoWan: estLoraWan(p.videoLoras), personaCredit: p.credit ?? null, personaGarderobe: p.garderobe ?? GARDEROBE_VIDE })
        const change = (p.id ?? null) !== get().personaId
        const klein = Boolean(p.lorasKlein?.length)
        // personnage Krea seul : la recette Klein n'a rien pour tenir son visage
        set({ personaKlein: klein, ...(klein ? {} : { photoEngine: 'krea' as const }) })
        set({ personaName: p.name?.trim() || t('Personnage'), personaAvatar: p.avatar ?? null, personaId: p.id ?? null })
        if (change) set({ assets: await fetchAssets() })
      } catch { /* hors ligne : on garde l'affichage */ }
    },

    hydrate: async () => {
      // Photo de profil : un fichier, pas une donnée — chargée à part, sans bloquer.
      void fetch('/api/persona/avatar/meta').then(r => r.json()).then((m: { url: string | null }) => set({ personaAvatar: m.url })).catch(() => {})
      // Le mode « son » n'a pas de chaîne : un état persisté dessus repart en photo.
      if (get().mode === 'son') get().setMode('photo')
      // moteur vidéo retiré de cette édition (MiniMax H3, LTX rapide) mais resté en mémoire du navigateur
      if (!VIDEO_ENGINES.some(e => e.key === get().video.engine)) get().updateVideo({ engine: get().video.engine === 'ltx' ? 'ltx_hq' : 'wan' })
      /* Plafonds, minutes, brouillons et liste T0 : le serveur est la source,
         le front n'en garde qu'un repli hors ligne. */
      try {
        const h = await (await fetch('/api/health')).json()
        setEngineCatalog(h.videoEngines)
        setT0Blocklist(h.t0Blocklist)
        // Nom du personnage : configuré côté serveur, « Personnage » à défaut.
        const nom = (h.persona?.name ?? h.personaName) as string | undefined
        set({ serverInfo: { preambles: h.preambles ?? {}, composerModels: h.composerModels ?? {}, renderRates: h.renderRates ?? null },
          personaId: (h.persona?.id as string | undefined) ?? null,
          personaKlein: Boolean((h.persona?.lorasKlein as unknown[] | undefined)?.length),
          personaVideo: Boolean((h.persona?.videoLoras as unknown[] | undefined)?.length),
          personaVideoWan: estLoraWan(h.persona?.videoLoras as unknown[] | undefined),
          personaCredit: (h.persona?.credit as PersonaCredit | undefined) ?? null,
          personaGarderobe: (h.persona?.garderobe as Garderobe | undefined) ?? GARDEROBE_VIDE,
          ...((h.persona?.lorasKlein as unknown[] | undefined)?.length ? {} : { photoEngine: 'krea' as const }),
          ...(nom?.trim() ? { personaName: nom.trim() } : {}) })
      } catch (e) { console.warn('[store] catalogue moteurs non chargé :', e) }
      try { set({ assets: await fetchAssets() }) }
      catch (e) { console.error('[store] bibliothèque non chargée :', e) }
      /* Les jobs aussi — TOUS, y compris ceux en vol : la base est la source
         de vérité, et chaque appareil s'ABONNE aux jobs en cours (adopt =
         même boucle d'interrogation que submit, sans re-soumettre). C'est ce
         qui rend la file visible après un rechargement, sur l'ordinateur comme sur
         le téléphone, avec progression et asset à l'arrivée. */
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
        /* Les jobs DÉJÀ connus et encore « en cours » à l'écran sont re-suivis :
           si leur suivi s'est perdu, c'est ce qui rattrape l'état réel (le
           worker n'ouvre jamais deux suivis pour le même job). */
        for (const j of get().jobs)
          if (known.has(j.id) && j.status !== 'done' && j.status !== 'blocked') worker.adopt(j)
      } catch (e) { console.error('[store] jobs non rechargés :', e) }
    },

    /** Clone : réinjecte toute la lignée d'un asset dans la console.
     *
     *  Un SEUL `set` : passer par updatePhoto + setComposed ne marchait pas.
     *  updatePhoto ne régénère `userPrompt` que si `promptTouched` est faux —
     *  donc dès que l'utilisateur avait édité le prompt à la main, le champ
     *  restait figé sur l'ancien texte. On écrit ici `userPrompt` explicitement
     *  et on pose `promptTouched: true` pour qu'aucune reconstruction
     *  automatique ne vienne écraser la valeur clonée juste après.
     *
     *  Repli : les assets d'avant l'élargissement de `provenance` n'ont pas de
     *  `userPrompt` — on retombe sur le prompt composé pour ne rien casser. */
    cloneFrom: asset => {
      const p = asset.provenance
      const isVideo = asset.mediaType === 'video'
      set(s => ({
        mode: asset.mediaType,
        photo: isVideo ? s.photo : { ...s.photo, ...(p.selections as Partial<PhotoSelections>) },
        video: isVideo ? { ...s.video, ...(p.selections as Partial<VideoSelections>) } : s.video,
        /* Le VRAI prompt (composé, celui qui a rendu) — pas le brief code
           court (« corr#30v0 still42 fix ») saisi par l'opérateur. */
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
      /* Vidéo : re-préparer la STILL du job cloné. La provenance INLINE des
         vignettes est allégée (selections souvent absentes) : on va chercher
         la provenance COMPLÈTE au besoin, et `sourceImage` (le fichier input
         du job, toujours enregistré en i2v) sert de repli universel. */
      if (isVideo) {
        void (async () => {
          let sel = p.selections as Partial<VideoSelections> | undefined
          let source = (p as { sourceImage?: string }).sourceImage
          /* La provenance INLINE des vignettes n'a PAS les selections (trop
             lourdes pour la liste) : sans ce fetch, `task` n'était jamais
             restaurée et un clone d'un rendu « Créer » laissait la sidebar
             sur l'onglet Rejouer en cours. */
          if (!sel || !sel.task) {
            try {
              const full = await (await fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`)).json()
              sel = (full.selections as Partial<VideoSelections> | null) ?? sel
              source = full.sourceImage ?? source
            } catch { /* injoignable : on garde l'inline */ }
          }
          // Onglet + réglages du job cloné (le premier set n'avait que
          // l'inline, souvent vide). Le mode courant ne doit pas survivre.
          if (sel && Object.keys(sel).length)
            get().updateVideo(sel as Partial<VideoSelections>)
          const startId = sel?.startAssetId
          if (startId && get().assets.some(a => a.id === startId)) { void get().pickStartFrame(startId); return }
          const file = sel?.startFrameFile || source
          // Dims remises à zéro : celles de la still PRÉCÉDENTE restaient et
          // faussaient le format « origine » (#443-eh8a, écrasement 16 %).
          // Le serveur sonde le fichier réel au dispatch de toute façon.
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
        /* Prompts SÉPARÉS par mode (demande 15/09) : le texte du mode quitté
           est rangé, celui du mode rejoint est restauré s'il avait été édité
           à la main — sinon prompt auto du mode. */
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
    /** Patch les sélections photo + régénère le prompt auto
     *  (sauf si l'utilisateur a pris la main sur le champ). */
    updatePhoto: patch =>
      set(s => {
        const photo = { ...s.photo, ...patch }
        // Changer de tâche change la NATURE du champ texte : prompt de scène
        // en génération, instruction en retouche. Reporter l'un dans l'autre
        // enverrait une description de scène complète comme instruction.
        // On repart donc du prompt auto, même si l'opérateur avait pris la
        // main sur le champ précédent.
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
        /* Changement de famille de moteur : les LoRA de l'ancien ne valent rien sur
           le nouveau. On range la pile en cours et on rappelle celle du moteur visé. */
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

    /* Catalogue chargé une fois, au montage du sélecteur. Un échec n'est pas
       masqué : la liste reste vide et le sélecteur le dit. */
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
      // Pré-remplir le déclencheur connu : l'opérateur corrige si besoin,
      // mais il ne part pas d'un champ vide sur les LoRA bien étiquetées.
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
    // Éditer le composé à la main l'aligne sur le prompt auto du moment :
    // l'opérateur vient de le relire, il n'est plus périmé.
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
      // Passer en verrou signifie presque toujours « refaire la même que la
      // dernière », pas « reprendre un nombre choisi il y a trois heures ».
      : { seedMode: 'lock', seedValue: s.lastSeed ?? s.seedValue })),

    /** Composer : userPrompt + directives → prompt composé (reveal+edit). */
    composeNow: async () => {
      const { userPrompt, userDirectives } = get()
      set({ composing: true, t0Error: null })
      let out
      try {
        out = await composer.compose({ register: 'sfw', userPrompt, userDirectives, mode: get().mode,
          engine: get().mode === 'video'
            ? (get().video.task === 'motion_pure' ? 'motion' : get().video.engine)
            // Retouche : system prompt dédié (engine_edit.txt) — reformule
            // l'instruction d'édition au lieu de décrire une scène.
            : get().mode === 'photo' && get().photo.task === 'edit' ? 'edit'
            : get().photoEngine,
          // Couches rewriter SOUL/MOOD (défaut null = OFF → composé inchangé).
          soul: get().soulLayer, mood: get().moodLayer })
      } catch (e) {
        // Le LLM tourne sur CPU : 20 à 60 s selon le modèle, et il peut être
        // absent. On le dit dans le bandeau, sinon le bouton semble ne rien
        // faire et l'opérateur envoie un job avec un composé vide.
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
      const { updateVideo } = get()
      // startFrameUri vidé : sinon l'aperçu direct (clone/upload) resterait
      // peint par-dessus la nouvelle sélection (priorité d'affichage).
      updateVideo({ startAssetId: assetId, startFrameFile: '', startFrameUri: '', startFrameError: '' })
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/to-input`, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(tServeur(body.error) ?? `HTTP ${res.status}`)
        updateVideo({ startFrameFile: body.filename,
                      startFrameW: body.width ?? 0, startFrameH: body.height ?? 0 })
      } catch (e) {
        // La vignette resterait sélectionnée alors que le graphe n'a rien à
        // lire : on la désélectionne et on dit pourquoi.
        updateVideo({ startAssetId: null, startFrameError: String((e as Error).message || e) })
      }
    },

    /** Dépôt de la vidéo driver du Motion Control — même mécanique que les
     *  images : ce qui compte est le NOM rendu par le serveur. */
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
        // Le poll du worker rapportera l'état final ; on reflète tout de
        // suite l'intention pour que le chip ne reste pas « queued ».
        set(st => ({ jobs: st.jobs.map(j => j.id === id ? { ...j, status: 'blocked' } : j) }))
        return null
      } catch (e) {
        return String((e as Error).message || e)
      }
    },

    /* ---------- extension vidéo ----------
       Deux entrées (upload / galerie), un seul chemin : la vidéo est résolue
       en DERNIÈRE FRAME côté serveur, et cette frame devient la start-frame
       i2v ordinaire (startFrameFile) — toute la chaîne existante suit. */
    uploadExtendVideo: async (file: File) => {
      const { updateVideo } = get()
      updateVideo({ extendError: '', extendWarn: '', extendVideoFile: '', extendAssetId: null,
                    startFrameFile: '', extendVideoUri: URL.createObjectURL(file) })
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
      const a = get().assets.find(x => x.id === assetId)
      get().updateVideo({ extendError: '', extendWarn: '', extendAssetId: assetId, extendVideoFile: '',
                          startFrameFile: '', extendVideoUri: a?.uri ?? '' })
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
      // Prequel : 1re frame → frame de FIN (pas de frame de départ) ; sequel : dernière → départ.
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
      const { updateVideo } = get()
      // Aperçu immédiat via l'URI de l'asset : seul le chemin upload posait
      // motionStillUri — depuis une vignette, le slot restait vide.
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

    uploadStartFrame: async (file: File) => {
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
        // Vidéo déposée comme image de départ = PROLONGATION : on extrait sa
        // DERNIÈRE frame et c'est elle qui devient la start-frame i2v (le clip
        // reprend là où il s'était arrêté). Image = comportement normal.
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
      /* Les entrées d'exécution (driver, still, moteur, image source…) ne
         vivent PAS au niveau racine du Job : elles sont dans `selections`.
         Les remonter est ce qui rend la relance possible — sans ça le
         serveur reçoit un job vidéo nu et le refuse en 400, et le clone
         passe « blocked » à la seconde (constaté le 24/08). */
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
        ...(isEdit ? { op: 'edit' as const, sourceImage: sel.editSourceFile } : {}),
        ...(video && !isMotion ? {
          videoEngine: sel.engine,
          videoLoras: sel.videoLoras ?? [],
          withAudio: audioEffective(sel.engine ?? 'wan', Boolean(sel.withAudio)),
          sourceImage: sel.startFrameFile || undefined,
          videoSeconds: Math.min(sel.durationS ?? 5, engineInfo(sel.engine ?? 'wan').maxSeconds),
          videoFps: sel.fps ?? 24,
          // Le clone ne prend le brouillon que si le moteur le porte : après
          // un changement de moteur en mémoire, le serveur refuserait.
          videoDraft: Boolean(sel.draft) && Boolean(engineInfo(sel.engine ?? 'wan').draft),
        } : {}),
        ...(isMotion ? {
          motionDriver: sel.motionDriverFile,
          motionPreview: Boolean(sel.motionPreview),
          motionMode: sel.motionMode === 'replace' ? 'replace' : 'animate',
          // La still déposée est la réf du personnage animé (Move) ; le Mix part de la vidéo seule.
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
      // Tout vide et rien d'écrit : le serveur refuserait « prompt vide » — on le dit ici.
      if (s.mode === 'photo' && !s.userPrompt.trim() && !s.composedPositive.trim()) {
        set({ t0Error: t('prompt vide : choisis un élément de composition ou écris le prompt') }); return
      }

      /* Un composé n'est envoyé que s'il a été réécrit depuis CE prompt.
         Sinon c'est le texte brut qui part : un composé périmé l'emportait
         en silence sur le texte affiché : des vidéos rendues sur la scène
         d'une ancienne still alors que le téléphone montrait autre chose. Sur
         mobile le composé n'est même pas visible : ce qui est à l'écran doit
         être ce qui part. */
      /* …et seulement dans l'onglet où il a été écrit (20/10) : un composé tiré de
         l'image dans « Créer » à partir d'un brief VIDE passait pour frais dans
         « Rejouer » au champ vide ('' === ''), et le prompt de Créer partait. */
      const fresh = !!s.composedPositive && s.composedFrom === s.userPrompt && s.composedFor === ongletDe(s)
      const positive = !fresh ? s.userPrompt : s.composedPositive
      const t0 = validateT0(positive)
      if (!t0.ok) { set({ t0Error: t0.reason ?? t('Bloqué T0') }); return }
      /* Garde-fou vidéo : le serveur refuse déjà un i2v sans image de départ,
         mais l'erreur arriverait après l'envoi, une fois le job en file. On
         l'attrape ici pour que le refus soit lisible à l'endroit du clic. */
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
      // Tout job vidéo par MOTEUR (i2v) — hors motion/extend qui ont leur
      // propre source — anime une image : sans start-frame le serveur 400.
      // On couvre TOUS ces tasks (pas juste 'i2v') pour ne pas laisser un
      // 'generate' résiduel filer jusqu'au 400 → « blocked » opaque.
      /* MiniMax H3 accepte la frame de FIN seule (le clip arrive sur elle) :
         vérifié au banc du 30/09. Les autres moteurs partent d'une image. */
      /* Vignette de fin choisie sans copie vers ComfyUI (état gardé d'avant le
         30/09, ou copie pas encore revenue) : on la fait maintenant. */
      if (s.mode === 'video' && s.video.endAssetId && !s.video.endFrameFile) await get().pickEndFrame(s.video.endAssetId)
      const finSeule = H3.includes(get().video.engine) && !!get().video.endFrameFile
      /* Prequel : seul Wan (WanFirstLastFrameToVideo) sait arriver sur une
         frame de fin ; LTX n'a pas d'entrée équivalente. */
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
          // Une vignette sélectionnée dont la copie vers ComfyUI n'est pas
          // finie n'est PAS une absence : on le dit, au lieu d'accuser
          // l'opérateur de n'avoir rien choisi.
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

      /* Lot : le MÊME prompt, N fois. La seule chose qui doit différer d'un
         rendu à l'autre est la seed — sinon le lot rendrait N fois la même
         image et n'aurait aucun intérêt.
         En mode aléatoire c'est le serveur qui tire, donc rien à faire ici.
         En mode verrouillé, on incrémente : demander un lot ET une seed fixe
         est contradictoire, et incrémenter reste reproductible (la provenance
         garde la seed exacte de chaque rendu). */
      const n = Math.max(1, Math.min(10, s.batchCount))
      const batchId = s.carouselBatchId ?? (n > 1 ? crypto.randomUUID() : undefined)
      /* Une clé par ENVOI, déclinée par index de lot : `base-0`, `base-1`…
         Sans le suffixe, les 4 jobs d'un lot partageraient la même clé et le
         serveur n'en créerait qu'un seul. */
      /* Un envoi encore en cours garde SA clé : un second appui pendant ce
         temps est une nouvelle intention, pas une reprise. Le 29/09, un lot
         lancé pendant l'envoi du précédent a repris sa clé : le serveur a
         rendu les jobs déjà créés, et deux vignettes sont restées « en
         attente » sur des jobs qui n'existaient pas. */
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
        // une retouche reste rangée sous le personnage de sa photo, pas sous le personnage actif
        personaId: (isEdit && s.assets.find(a => a.id === s.photo.editSourceAssetId)?.personaId) || 'default',
        ...(s.mode === 'photo' && !isEdit ? { photoEngine: s.photoEngine } : {}),
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
        composedNegative: s.composedNegative,
        conditioningRefs: buildConditioningRefs(s.mode, selections),
        loras: s.loraPicks.filter(l => !l.off),
        // ControlNet : uniquement en Génération, et seulement si le dépôt a
        // abouti — envoyer un nom de fichier que le serveur n'a pas reçu ferait
        // échouer le graphe à l'exécution, pas à la validation.
        ...(CONTROLNET_AVAILABLE && !isEdit && s.mode === 'photo' && s.photo.cnRefFile
          ? {
            controlNet: { file: s.photo.cnRefFile, type: s.photo.cnType,
                          strength: s.photo.cnStrength },
            // Le latent prend le FORMAT de la référence : sinon la carte de
            // contrôle est recadrée en silence et le cadrage rendu n'est pas
            // celui qu'on voit dans la vignette.
            ...latentFor(s.photo.cnRefW, s.photo.cnRefH),
          }
          : {}),
        // La vidéo part d'une still : le serveur refuse un job i2v sans elle.
        // `audioEffective` plutôt que la case brute : sur un moteur muet la
        // case ne veut rien dire, et envoyer `true` ferait croire, en
        // provenance, qu'on a demandé un son qui n'a jamais pu exister.
        // Le format « origine » est résolu ICI, sur les dimensions de la
        // still : le serveur ne connaît que les ratios du ResolutionSelector.
        ...(s.mode === 'video' && s.video.task === 'motion_pure' ? {
          motionDriver: s.video.motionDriverFile,
          // Mix : la vidéo seule, le serveur fabrique la référence du personnage
          motionRef: s.video.motionMode === 'replace' ? undefined : s.video.motionStillFile,
          motionMode: s.video.motionMode === 'replace' ? 'replace' : 'animate',
          motionPreview: s.video.motionPreview,
          motionSceneText: s.video.motionSceneText || undefined,
          motionPoseStrength: s.video.motionPoseStrength,
          mixDebut: s.video.mixDebut,
          motionRefStrength: s.video.motionRefStrength,
        } : s.mode === 'video' && s.video.task === 't2v' ? {
          /* Plan d'ambiance : seul LTX-2.5 part du texte. Pas de still, pas de
             LoRA vidéo du personnage (le serveur les écarte aussi). */
          t2v: true,
          // avec le personnage : sa LoRA vidéo et son mot déclencheur (serveur)
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
          /* Keyframe d'arrivée : jusqu'au 30/09 l'interface la montrait sans
             jamais l'envoyer (seul l'id d'asset partait, que le serveur ne
             lit pas). Seuls les moteurs MiniMax H3 ont une entrée last_frame. */
          endImage: prequel ? s.video.extendEndFile || undefined
            : H3.includes(s.video.engine) ? get().video.endFrameFile || undefined : undefined,
          ...(prequel ? { prequel: true } : {}),
          /* Multi-plans : aucun paramètre de nœud n'existe, c'est le PROMPT
             qui pilote. Coché, on annonce la séquence ; décoché, on impose
             le plan unique — sans quoi MiniMax coupe parfois de lui-même. */
          // Idempotent (stripShotMarkers) : un prompt qui porte déjà un
          // marqueur — vieux clone, resoumission — n'en reçoit pas un second.
          composedPositive: s.video.multiShot
            ? `multi-shot sequence with cinematic cuts. ${stripShotMarkers(positive)}`
            : `${stripShotMarkers(positive)}. single continuous shot, no cuts`,
          // Borné au moteur : après un changement de moteur, la valeur en
          // mémoire peut dépasser le plafond du nouveau — le serveur
          // refuserait, autant envoyer ce que le sélecteur affiche.
          videoSeconds: Math.min(s.video.durationS, engineInfo(s.video.engine).maxSeconds),
          videoFps: s.video.fps,
          videoDraft: s.video.draft && Boolean(engineInfo(s.video.engine).draft),
          // Extension vidéo : livrer aussi le plan complet (source + continuation).
          ...(s.video.task === 'extend' && s.video.extendConcat
            ? (s.video.extendVideoFile
              ? { concatWith: s.video.extendVideoFile, concatFrom: 'input' as const }
              : s.video.extendAssetId
                ? { concatWith: (s.assets.find(a => a.id === s.video.extendAssetId)?.uri ?? '').split('/').pop() ?? undefined, concatFrom: 'media' as const }
                : {})
            : {}),
          /* « origine » part TEL QUEL : le serveur sonde le fichier réel de la
             still au dispatch (les dims du front, jointes en repli, peuvent
             être périmées — #443-eh8a). */
          videoAspect: s.video.aspect,
          ...(s.video.aspect === 'origine' && s.video.startFrameW && s.video.startFrameH
            ? { videoSrcW: s.video.startFrameW, videoSrcH: s.video.startFrameH } : {}),
        } : {}),
        ...(isEdit ? {
          op: 'edit' as const,
          sourceImage: s.photo.editSourceFile,
          // La retouche GARDE le composé de la colonne 3 : c'est lui
          // l'instruction d'édition (composée par le LLM), pas un descriptif
          // de scène. On ne l'écrase donc pas.
        } : {}),
        status: 'queued',
      })

      /* CARROUSEL (photo, génération, lot > 1) : même tenue, même lieu, même
         seed — et à chaque image une pose, un cadrage et une focale
         différents. Le texte est le prompt AUTO reconstruit sur chaque
         variante : un composé LLM ou un prompt édité à la main décrit la
         scène d'origine, pas la variante. La seed est verrouillée pour tout
         le lot (tirée ici si aléatoire) pour que les N rendus partagent
         lumière et grain. La pose et le style courants ouvrent le lot, les
         autres sont tirés sans remise dans le vocabulaire.
         Décoché, le lot est N tirages du MÊME prompt (seeds différentes). */
      /* Carrousel v5 : les VERROUS OUVERTS (locks[k] === false) désignent les
         dimensions qui varient par image. Photo/génération, lot > 1, ≥1 ouvert.
         Chaque dimension ouverte est tirée sans remise dans le vocabulaire ;
         les fermées restent fixes. */
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
      // Les plus récents en tête de liste, donc le lot à l'envers.
      set({ jobs: [...[...batch].reverse(), ...s.jobs], t0Error: null })
      // Séquentiel : le worker sérialise de toute façon (un seul GPU), et
      // envoyer en parallèle ne ferait qu'entrelacer les erreurs.
      const proprietaire = !envoiEnCours
      envoiEnCours = true
      try { for (const j of batch) await worker.submit(j) }
      finally { if (proprietaire) envoiEnCours = false }
      // Envoi parti : on efface la sélection galerie — l'établi montre la
      // progression (rien à afficher tant que le rendu n'existe pas).
      /* Envoi abouti : la clé a joué son rôle. La suivante sera neuve — un
         nouvel appui est une nouvelle intention, pas une reprise. */
      set({ focusAssetId: null, initialBrief: null, promptVision: null,
        ...(get().requestId === reqBase ? { requestId: null } : {}) })
    },
  }
}, {
  name: 'creatoros-ui',
  partialize: s => ({
    /* Spec mobile §10 : la composition survit au rechargement — mode, tâche,
       sélections, prompt édité, nombre de rendus. */
    mode: s.mode,
    photo: s.photo,
    video: s.video,
    son: s.son,
    userPrompt: s.userPrompt,
    promptTouched: s.promptTouched,
    userDirectives: s.userDirectives,
    /* Le composé aussi : sur mobile, l'écran se verrouille pendant les 50 à
       100 s de réécriture et la page se recharge au retour — sans ça le texte
       réécrit disparaissait. `composedFrom` voyage avec lui : la garde de
       fraîcheur (composedFrom === userPrompt) reste exacte après rechargement. */
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
  /* Un état sauvé par un bundle ANTÉRIEUR ne connaît pas les champs ajoutés
     depuis. Comme partialize persiste les
     objets photo/video/son ENTIERS, la rehydratation par défaut les REMPLACE
     et un accès non protégé (`.trim()`) plantait submitJob en silence — le
     bouton « Envoyer » ne faisait rien. On fusionne
     donc le persisté PAR-DESSUS les défauts : tout champ manquant est comblé. */
  merge: (persisted, current) => {
    const p = (persisted ?? {}) as Partial<typeof current>
    return {
      ...current, ...p,
      photo: { ...current.photo, ...(p.photo ?? {}) },
      video: { ...current.video, ...(p.video ?? {}) },
      son: { ...current.son, ...(p.son ?? {}) },
    }
  },
}))
