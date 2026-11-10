/* ============================================================
   Asset display: photo or video.

   Shared by the four places that show media (console grid and large
   view, library grid and detail): an `<img>` on an mp4 gives a broken
   thumbnail.
   ============================================================ */
import type { Asset } from '../types'
import { cn } from '../lib/cn'
import { t } from '../i18n'

/** Server-extracted JPEG thumbnail of a video. iOS Safari shows nothing
 *  for an unplayed <video>: without `poster`, a grid of clips is a grid
 *  of black. `preload="none"` with a poster: nothing is downloaded until
 *  playback, and the thumbnail is shown. */
export const posterOf = (a: Pick<Asset, 'uri' | 'mediaType'>): string | undefined =>
  a.mediaType === 'video' && a.uri ? `/api/poster/${encodeURIComponent(a.uri.split('/').pop() ?? '')}` : undefined

/** 540 px JPEG thumbnail for any grid, photo or video: the original
 *  (PNG up to 3.8 MB) is kept for the large view. */
export const vignetteOf = (a: Pick<Asset, 'uri'>): string =>
  a.uri ? `/api/poster/${encodeURIComponent(a.uri.split('/').pop() ?? '')}` : ''

/** Grid thumbnail. Video is muted and looped: a preview, not playback;
 *  sound is judged in the large view. `preload="metadata"` so that a
 *  grid of twenty clips does not download twenty full videos. */
export function AssetThumb({ asset, className }: { asset: Asset; className?: string }) {
  if (!asset.uri)
    return <>{asset.mediaType === 'video' ? '▶' : '▢'} #{asset.jobId}</>
  if (asset.mediaType === 'video')
    return (
      <>
        <video src={asset.uri} poster={posterOf(asset)} muted loop playsInline preload="none"
          onMouseEnter={e => void (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
          onMouseLeave={e => { const v = e.currentTarget as HTMLVideoElement; v.pause(); v.currentTime = 0 }}
          className={cn('absolute inset-0 w-full h-full object-cover', className)} />
        <span className="absolute bottom-1.5 left-1.5 text-[12px] bg-bg/80 border border-border2 rounded px-1 text-muted">▶</span>
      </>
    )
  return (
    <img src={vignetteOf(asset)} alt={t('génération #{id}', { id: asset.jobId })} loading="lazy"
      className={cn('absolute inset-0 w-full h-full object-cover', className)} />
  )
}

/** Large view: visible controls, sound on. This is where an audio render
 *  is judged, so no `muted`. */
export function AssetFull({ asset, className }: { asset: Asset; className?: string }) {
  if (!asset.uri)
    return <>{asset.mediaType === 'video' ? '▶' : '▢'} {t('aucun média')}</>
  if (asset.mediaType === 'video')
    return (
      <video src={asset.uri} poster={posterOf(asset)} controls loop playsInline autoPlay
        className={cn('zoomable max-w-full max-h-[90vh] object-contain', className)} />
    )
  return (
    <img src={asset.uri} alt={t('génération #{id}', { id: asset.jobId })}
      className={cn('zoomable max-w-full max-h-[90vh] object-contain', className)} />
  )
}
