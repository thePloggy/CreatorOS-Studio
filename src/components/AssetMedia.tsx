/* ============================================================
   Affichage d'un asset — photo ou vidéo.

   Commun aux quatre endroits qui montrent un média (grille et grande vue
   de la console, grille et détail de la bibliothèque) : un `<img>` sur un
   mp4 donne une vignette cassée.
   ============================================================ */
import type { Asset } from '../types'
import { cn } from '../lib/cn'
import { t } from '../i18n'

/** Vignette JPEG d'une vidéo, extraite côté serveur. iOS Safari n'affiche
 *  rien d'un <video> non lu : sans `poster`, une grille de clips est une
 *  grille de noirs. `preload="none"` avec un poster : rien
 *  n'est téléchargé tant qu'on ne lit pas, et la vignette est là. */
export const posterOf = (a: Pick<Asset, 'uri' | 'mediaType'>): string | undefined =>
  a.mediaType === 'video' && a.uri ? `/api/poster/${encodeURIComponent(a.uri.split('/').pop() ?? '')}` : undefined

/** Vignette JPEG de 540 px pour toute grille, photo comme vidéo : l'original
 *  (PNG jusqu'à 3,8 Mo) reste pour la grande vue. */
export const vignetteOf = (a: Pick<Asset, 'uri'>): string =>
  a.uri ? `/api/poster/${encodeURIComponent(a.uri.split('/').pop() ?? '')}` : ''

/** Vignette de grille. La vidéo est muette et en boucle : c'est un aperçu,
 *  pas une lecture — le son se juge en grande vue. `preload="metadata"` pour
 *  qu'une grille de vingt clips ne télécharge pas vingt vidéos entières. */
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
        <span className="absolute bottom-1.5 left-1.5 text-[9px] bg-bg/80 border border-border2 rounded px-1 text-muted">▶</span>
      </>
    )
  return (
    <img src={vignetteOf(asset)} alt={t('génération #{id}', { id: asset.jobId })} loading="lazy"
      className={cn('absolute inset-0 w-full h-full object-cover', className)} />
  )
}

/** Grande vue : contrôles visibles, son actif. C'est ici qu'on juge un rendu
 *  sonore, donc pas de `muted` — l'opérateur décide. */
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
