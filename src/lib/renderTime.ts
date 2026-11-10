/** Readable render duration: "48 s", "12 min 04 s". null if unknown
 *  (0 = job re-attached after a restart, no measurement). */
export function renderTime(ms?: number | null): string | null {
  if (!ms || ms <= 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(s % 60).padStart(2, '0')} s`
}
