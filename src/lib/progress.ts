/* Job progress by TIME: elapsed since rendering started, against the server's
   estimate made at enqueue (measured coefficients, server/jobs.js RENDER_RATES).
   ComfyUI's % (progress of the current node) is shown alongside when available,
   but time drives the bar. */
import { useEffect, useState } from 'react'
import type { Job } from '../types'

export interface RenderRates {
  photoMs: number
  videoSecPerSec: Record<string, number>
  draftSecPerSec: Record<string, number>
  motionSecPerFrame: { final: number; preview: number }
}

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}
export const fmtMin = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `≈ ${Math.round(ms / 60000)} min`)

/** Shared clock: one render every `everyMs`. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t) }, [everyMs])
  return now
}

export function jobProgress(job: Job, now: number) {
  const started = job.status === 'rendering' && job.startedAt ? job.startedAt : null
  const elapsedMs = started ? now - started : 0
  const estimatedMs = job.estimatedMs ?? null
  // Capped at 98%: an estimate is not a promise, the bar never
  // fills up on its own.
  const ratio = estimatedMs && started ? Math.min(0.98, elapsedMs / estimatedMs) : null
  const over = estimatedMs && started ? elapsedMs > estimatedMs : false
  return { started, elapsedMs, estimatedMs, ratio, over }
}

/** Pre-submit estimate, client-side, using the server's coefficients. */
export function estimateVideoMs(rates: RenderRates | null | undefined, engine: string, seconds: number, draft: boolean) {
  if (!rates) return null
  const rate = draft ? (rates.draftSecPerSec[engine] ?? rates.videoSecPerSec[engine] / 3) : rates.videoSecPerSec[engine]
  return Number.isFinite(rate) ? rate * seconds * 1000 : null
}
export function estimateMotionMs(rates: RenderRates | null | undefined, frames: number, preview: boolean) {
  if (!rates || !frames) return null
  return frames * rates.motionSecPerFrame[preview ? 'preview' : 'final'] * 1000
}
