import type { Job } from '../types'
import { t } from '../i18n'
import { fmtDur } from './progress'

/** What a not-yet-started render is waiting for: its queue position and estimated
 *  delay, or the GPU still busy with another render (job handed to ComfyUI,
 *  which finishes its own first). Null: nothing more to say. */
export function attente(j: Job): string | null {
  if (j.status === 'queued-comfy') return t('la carte graphique finit un autre rendu, le tien part juste après')
  if (j.status !== 'queued' || !j.file) return null
  const rang = j.file.rang === 1 ? t('prochain à partir') : t('{n}e dans la file', { n: j.file.rang })
  return j.file.attenteMs >= 20_000 ? `${rang} · ${t('départ dans ~{d}', { d: fmtDur(j.file.attenteMs) })}` : rang
}
