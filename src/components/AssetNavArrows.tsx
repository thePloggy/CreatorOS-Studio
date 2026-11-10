/* Navigation arrows over the media of a detail view.
   Shared by the console gallery and the Library. */
import { cn } from '../lib/cn'
import { t } from '../i18n'

export function AssetNavArrows({ index, total, hasPrev, hasNext, prev, next }: {
  index: number
  total: number
  hasPrev: boolean
  hasNext: boolean
  prev: () => void
  next: () => void
}) {
  const btn = (side: 'left' | 'right', on: boolean, act: () => void, glyph: string, title: string) => (
    <button
      onClick={e => { e.stopPropagation(); act() }}
      disabled={!on}
      title={title}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 z-10 w-9 h-14 rounded-ctl border flex items-center justify-center text-[18px]',
        side === 'left' ? 'left-2' : 'right-2',
        on
          ? 'bg-bg/70 border-border2 text-text hover:bg-bg/90 cursor-pointer'
          // Disabled but VISIBLE: hiding it at the end of the list
          // would make navigation look broken.
          : 'bg-bg/30 border-border text-faint cursor-not-allowed',
      )}>
      {glyph}
    </button>
  )

  return (
    <>
      {btn('left', hasPrev, prev, '‹', t('Précédent (←)'))}
      {btn('right', hasNext, next, '›', t('Suivant (→)'))}
      {index >= 0 && (
        <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-10 text-[12px] text-muted bg-bg/80 border border-border rounded-full px-2.5 py-[2px]">
          {index + 1} / {total} · ← →
        </span>
      )}
    </>
  )
}
