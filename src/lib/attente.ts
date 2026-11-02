import type { Job } from '../types'
import { t } from '../i18n'
import { fmtDur } from './progress'

/** Ce qu'attend un rendu pas encore parti : son rang et le délai estimé
 *  avant son départ, ou la carte graphique encore prise par un autre rendu
 *  (job remis à ComfyUI, qui finit d'abord le sien). Null : rien à dire de plus. */
export function attente(j: Job): string | null {
  if (j.status === 'queued-comfy') return t('la carte graphique finit un autre rendu, le tien part juste après')
  if (j.status !== 'queued' || !j.file) return null
  const rang = j.file.rang === 1 ? t('prochain à partir') : t('{n}e dans la file', { n: j.file.rang })
  return j.file.attenteMs >= 20_000 ? `${rang} · ${t('départ dans ~{d}', { d: fmtDur(j.file.attenteMs) })}` : rang
}
