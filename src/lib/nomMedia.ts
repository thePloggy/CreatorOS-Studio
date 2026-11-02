import type { Asset } from '../types'
import { t } from '../i18n'

/** Nom accessible d'une vignette : le début du prompt, sinon le type de média. */
export function nomMedia(a: Asset): string {
  const p = a.provenance?.userPrompt || a.provenance?.composedPositive
  const type = a.mediaType === 'video' ? t('Vidéo') : t('Photo')
  return p ? `${type} : ${p.slice(0, 80)}` : type
}
