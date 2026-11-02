/* ============================================================
   Les moteurs i2v câblés, côté affichage.

   Le ROUTAGE vit dans server/jobs.js (VIDEO_ENGINES) : c'est lui qui associe
   une clé à un fichier de recette. Ici on ne garde que ce qu'il faut pour
   choisir — le nom, la force, la présence d'un étage audio, l'ordre de
   grandeur du temps. Les clés doivent correspondre ; si elles divergent, le
   serveur refuse le job en nommant les clés qu'il connaît, plutôt que de
   replier sur un autre moteur en silence.

   Aucun de ces moteurs ne domine les autres : ils perdent sur des axes
   différents. Le choix est donc manuel, et l'interface dit sur quoi il porte
   au lieu de laisser deviner.
   ============================================================ */
import type { VideoEngine } from '../../../types'

export interface EngineInfo {
  key: VideoEngine
  /** Nom court, celui du bouton. */
  label: string
  /** Durée maximale en secondes — une limite de VRAM, pas une préférence :
   *  au-delà, le rendu tombe en OOM au premier échantillonneur. */
  maxSeconds: number
  /** Ce que ce moteur fait MIEUX que les autres — l'indice de force. */
  force: string
  /** A un étage audio. Faux → la case « son » est grisée. */
  audio: boolean
  /** Ordre de grandeur du rendu, en minutes, pour un plan de ~5 s sur 5090. */
  minutes: number
  /** Mode brouillon disponible : même recette à surface réduite. `minutes`
   *  est l'ordre de grandeur en brouillon. Absent → pas de case à cocher. */
  draft?: { label: string; minutes: number }
}

export const VIDEO_ENGINES: EngineInfo[] = [
  {
    key: 'wan',
    // 8 s en direct ; au-delà le serveur bascule sur la recette à fenêtres
    // de contexte (12 s sondés : 30 min) — plus lent, cohérence
    // légèrement plus souple, mais ça rend.
    maxSeconds: 12,
    label: 'Wan 2.2 (I2V A14B)',
    force: 'image la plus propre — le plan qui doit tenir en grand',
    audio: false,
    minutes: 9,
    draft: { label: '0,4 MP (480×848 en 9:16)', minutes: 2 },
  },
  {
    key: 'ltx_hq',
    // 16 s sondés : 9 min, 30,9 Go — 20 s non sondé.
    maxSeconds: 16,
    label: 'LTX-2.5 (22B)',
    force: 'avec le son, rapide — 896×1600 en plusieurs passes',
    audio: true,
    minutes: 5,
    draft: { label: '0,7 MP au lieu de 1,4', minutes: 2 },
  },

]

/** Forme de VIDEO_ENGINES côté serveur (GET /api/health). */
interface ServerEngine {
  maxSeconds: number; minutes: number; audio: boolean
  draft?: { megapixels: number; minutes: number }
}

/** Le serveur est la source pour tout ce qui est MESURÉ ou IMPOSÉ (plafond,
 *  minutes, audio, brouillon) ; le front garde le libellé et l'indice de
 *  force, qui sont de l'écriture. Fusion en place : les composants lisent
 *  VIDEO_ENGINES au rendu, et hydrate() déclenche un rendu. */
/* Texte → vidéo AVEC un personnage dont la LoRA vidéo est une paire Wan haut /
   bas bruit (Aisha). Hors du sélecteur i2v : il ne part d'aucune image. */
export const T2V_WAN: EngineInfo = {
  key: 'wan_t2v',
  maxSeconds: 5,
  label: 'Wan 2.2 (T2V A14B)',
  force: 'le personnage depuis le texte seul, quand son identité est une LoRA Wan',
  audio: false,
  minutes: 6,
  draft: { label: '0,3 MP', minutes: 2 },
}

export function setEngineCatalog(list: unknown) {
  if (!list || typeof list !== 'object') return
  for (const e of [...VIDEO_ENGINES, T2V_WAN]) {
    const srv = (list as Record<string, ServerEngine | undefined>)[e.key]
    if (!srv) continue
    if (Number.isFinite(srv.maxSeconds)) e.maxSeconds = srv.maxSeconds
    if (Number.isFinite(srv.minutes)) e.minutes = srv.minutes
    if (typeof srv.audio === 'boolean') e.audio = srv.audio
    e.draft = srv.draft
      ? { label: `${String(srv.draft.megapixels).replace('.', ',')} MP`, minutes: srv.draft.minutes }
      : undefined
  }
}

/** Seul moteur dont la recette sait partir du TEXTE (plan d'ambiance). */
export const T2V_ENGINE: VideoEngine = 'ltx_hq'

/** Moteur du texte → vidéo : Wan T2V quand le personnage est demandé et que sa
 *  LoRA vidéo est une LoRA Wan, LTX-2.5 sinon (plans d'ambiance, LoRA LTX). */
export const moteurT2v = (persoWan: boolean): VideoEngine => persoWan ? 'wan_t2v' : T2V_ENGINE

export const engineInfo = (key: VideoEngine): EngineInfo =>
  [...VIDEO_ENGINES, T2V_WAN].find(e => e.key === key) ?? VIDEO_ENGINES[0]

/** Le son est-il RÉELLEMENT produit ? Le drapeau de l'opérateur ne suffit
 *  pas : sur un moteur muet il ne veut rien dire, et c'est cette valeur-là
 *  qui part au serveur. */
export const audioEffective = (key: VideoEngine, wanted: boolean) =>
  engineInfo(key).audio && wanted

/** Ce que la langue du moteur impose au brief audio. Mesuré, pas supposé :
 *  MiniMax a rendu la réplique française mot pour mot (langue détectée à
 *  0,88) là où LTX a transcrit « coucou toi » en « Kuku toa ». */
export const AUDIO_HINT: Partial<Record<VideoEngine, string>> = {
  ltx_hq: 'Voix correcte en anglais, brouillonne en français · ambiance quasi muette',
}

/* ---------- format ----------
   Les formats sont ceux du nœud ResolutionSelector de ComfyUI : en proposer
   d'autres ferait échouer le graphe à l'exécution, pas à la validation. */
export const ASPECTS = ['9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9', '21:9'] as const
export type AspectRatio = typeof ASPECTS[number]

/** Format de la liste le plus proche de dimensions données. Sert au mode
 *  « format de l'image » : la still de départ fait rarement un ratio rond
 *  (832×1216 n'est ni du 9:16 ni du 2:3, mais il est bien plus près du 2:3). */
export function nearestAspect(w: number, h: number): AspectRatio {
  if (!w || !h) return '9:16'
  const target = w / h
  let best: AspectRatio = '9:16'
  let dist = Infinity
  for (const a of ASPECTS) {
    const [rw, rh] = a.split(':').map(Number)
    // Comparaison en logarithme : sans ça, l'écart entre 16:9 et 21:9 pèserait
    // bien plus que celui, tout aussi visible, entre 9:16 et 2:3.
    const d = Math.abs(Math.log(target / (rw / rh)))
    if (d < dist) { dist = d; best = a }
  }
  return best
}

/* ---------- multi-plans ----------
   Aucun paramètre de nœud n'existe : c'est le PROMPT qui pilote le découpage
   (vérifié dans /object_info sur les trois moteurs).
   MiniMax coupe, LTX suit un découpage demandé plan par plan, Wan coupe
   les LIEUX et les angles mais ignore les changements d'échelle (pas de
   gros plan obtenu) — activé quand même, le prompt fait la différence. */
export const MULTISHOT_ENGINES: ReadonlySet<VideoEngine> = new Set(['ltx_hq', 'wan'])
