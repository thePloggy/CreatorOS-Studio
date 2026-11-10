/* ============================================================
   T0 validator — non-LLM enforcement of the hard floor:
   adult character, no minors, identity integrity.
   Runs after composition, before dispatch. Cannot be overridden:
   the LLM cannot bypass it.
   ============================================================ */
import { t } from '../i18n'

export interface ValidationResult {
  ok: boolean
  reason?: string
}

/** Always-blocked terms (never overridable). */
let T0_BLOCKLIST = [
  'minor', 'teen', 'child', 'underage', 'barely legal', 'schoolgirl',
  'young girl', 'loli', 'jeune fille mineure',
]

/** The reference list lives on the server (server/t0.js, re-applied to the
 *  resolved text) and arrives via GET /api/health on mount; the list above
 *  is only the offline fallback. */
export function setT0Blocklist(list: unknown) {
  if (Array.isArray(list) && list.length && list.every(x => typeof x === 'string')) T0_BLOCKLIST = list
}

export function validateT0(composedPositive: string): ValidationResult {
  const lower = composedPositive.toLowerCase()
  const hit = T0_BLOCKLIST.find(term => lower.includes(term))
  if (hit) return { ok: false, reason: t('Terme bloqué (T0) : « {hit} »', { hit }) }
  return { ok: true }
}
