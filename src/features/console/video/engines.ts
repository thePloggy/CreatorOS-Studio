/* ============================================================
   The wired i2v engines, display side.

   ROUTING lives in server/jobs.js (VIDEO_ENGINES), which maps a key
   to a recipe file. This file only keeps what is needed to choose:
   name, strength, audio stage, order of magnitude of render time.
   Keys must match; if they diverge, the server rejects the job and
   lists the keys it knows, instead of silently falling back to
   another engine.

   No engine dominates the others, so the choice is manual and the
   UI states what each one is good at.
   ============================================================ */
import type { VideoEngine } from '../../../types'

export interface EngineInfo {
  key: VideoEngine
  /** Short name, shown on the button. */
  label: string
  /** Maximum duration in seconds — a VRAM limit: beyond it the
   *  render runs out of memory at the first sampler. */
  maxSeconds: number
  /** What this engine does BETTER than the others — the strength hint. */
  force: string
  /** Has an audio stage. False → the "sound" checkbox is disabled. */
  audio: boolean
  /** Order of magnitude of render time, in minutes, for a ~5 s shot on a 32 GB card. */
  minutes: number
  /** Draft mode available: same recipe at reduced resolution. `minutes`
   *  is the draft order of magnitude. Absent → no checkbox. */
  draft?: { label: string; minutes: number }
  /** Self-installed engine (weights under a restricted license). */
  optionnel?: 'h3'
}

export const VIDEO_ENGINES: EngineInfo[] = [
  {
    key: 'wan',
    // 8 s direct; beyond that the server switches to the context-window
    // recipe (12 s ≈ 30 min) — slower, slightly looser coherence.
    maxSeconds: 12,
    label: 'Wan 2.2 (I2V A14B)',
    force: 'image la plus propre — le plan qui doit tenir en grand',
    audio: false,
    minutes: 9,
    draft: { label: '0,4 MP (480×848 en 9:16)', minutes: 2 },
  },
  {
    key: 'ltx_hq',
    // 16 s ≈ 9 min, 30.9 GB.
    maxSeconds: 16,
    label: 'LTX-2.5 (22B)',
    force: 'avec le son, rapide — 896×1600 en plusieurs passes',
    audio: true,
    minutes: 5,
    draft: { label: '0,7 MP au lieu de 1,4', minutes: 2 },
  },
  {
    key: 'minimax',
    maxSeconds: 12,
    label: 'MiniMax H3',
    force: 'le plus fluide, tient l’identité et sait tourner autour du sujet',
    audio: true,
    minutes: 12,
    draft: { label: '0,4 MP', minutes: 4 },
    optionnel: 'h3',
  },

]

/** Shape of the server's VIDEO_ENGINES (GET /api/health). */
interface ServerEngine {
  maxSeconds: number; minutes: number; audio: boolean
  draft?: { megapixels: number; minutes: number }
}

/** The server is the source for everything MEASURED or ENFORCED (cap,
 *  minutes, audio, draft); the front end keeps the label and the strength
 *  hint. Merged in place: components read VIDEO_ENGINES at render time,
 *  and hydrate() triggers a render. */
/* Text → video WITH a character whose video LoRA is a Wan high/low noise
   pair. Not in the i2v selector: it starts from no image. */
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

/** Only engine whose recipe can start from TEXT (ambient shot). */
export const T2V_ENGINE: VideoEngine = 'ltx_hq'

/** Text → video engine: Wan T2V when the character is requested and its
 *  video LoRA is a Wan LoRA, otherwise LTX-2.5 (ambient shots, LTX LoRA). */
export const moteurT2v = (persoWan: boolean): VideoEngine => persoWan ? 'wan_t2v' : T2V_ENGINE

export const engineInfo = (key: VideoEngine): EngineInfo =>
  [...VIDEO_ENGINES, T2V_WAN].find(e => e.key === key) ?? VIDEO_ENGINES[0]

/** Is sound ACTUALLY produced? The operator flag is not enough: it is
 *  meaningless on a silent engine, and this value is what is sent to the server. */
export const audioEffective = (key: VideoEngine, wanted: boolean) =>
  engineInfo(key).audio && wanted

/** What the engine's language support implies for the audio brief:
 *  LTX renders French dialogue poorly, MiniMax renders it faithfully. */
export const AUDIO_HINT: Partial<Record<VideoEngine, string>> = {
  ltx_hq: 'Voix correcte en anglais, brouillonne en français · ambiance quasi muette',
}

/* ---------- aspect ratio ----------
   The ratios are those of ComfyUI's ResolutionSelector node: any other
   value would fail the graph at execution, not at validation. */
export const ASPECTS = ['9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9', '21:9'] as const
export type AspectRatio = typeof ASPECTS[number]

/** Closest listed aspect ratio to given dimensions. Used by the
 *  "image aspect" mode: the starting still rarely has a round ratio
 *  (832×1216 is neither 9:16 nor 2:3, but much closer to 2:3). */
export function nearestAspect(w: number, h: number): AspectRatio {
  if (!w || !h) return '9:16'
  const target = w / h
  let best: AspectRatio = '9:16'
  let dist = Infinity
  for (const a of ASPECTS) {
    const [rw, rh] = a.split(':').map(Number)
    // Compare in log space: otherwise the gap between 16:9 and 21:9 would weigh
    // much more than the equally visible one between 9:16 and 2:3.
    const d = Math.abs(Math.log(target / (rw / rh)))
    if (d < dist) { dist = d; best = a }
  }
  return best
}

/* ---------- multi-shot ----------
   No node parameter exists: the PROMPT drives the cuts.
   MiniMax cuts, LTX follows a shot-by-shot breakdown, Wan cuts
   LOCATIONS and angles but ignores scale changes (no close-up) —
   enabled anyway, the prompt makes the difference. */
export const MULTISHOT_ENGINES: ReadonlySet<VideoEngine> = new Set(['ltx_hq', 'wan'])
