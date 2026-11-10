import type { Asset } from '../types'
import { t } from '../i18n'

/** Accessible name of a thumbnail: the start of the prompt, else the media type. */
export function nomMedia(a: Asset): string {
  const p = a.provenance?.userPrompt || a.provenance?.composedPositive
  const type = a.mediaType === 'video' ? t('Vidéo') : t('Photo')
  return p ? `${type} : ${p.slice(0, 80)}` : type
}
