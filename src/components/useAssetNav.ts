/* ============================================================
   Navigation from one asset to the next in a detail view.

   The list walked is the DISPLAYED one, not the whole database:
   if the operator filtered on "validated", arrows must stay within
   the validated ones.
   ============================================================ */
import { useEffect, useRef } from 'react'
import type { Asset } from '../types'

/** A text field has keyboard focus: arrows move the caret there.
 *  Hijacking them would change image while typing. */
function typing(el: EventTarget | null) {
  const t = el as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function useAssetNav(
  list: Asset[],
  current: Asset | null,
  go: (a: Asset | null) => void,
) {
  const index = current ? list.findIndex(a => a.id === current.id) : -1
  /* Last known position IN the list. When the current asset leaves the
     displayed filter (e.g. sorted "to review", then marked "validated"),
     index drops to -1 while the detail view stays open. Then switch to the
     previous neighbour in the category (or the new first one) so the
     arrows keep working. */
  const lastIndex = useRef(-1)
  if (index >= 0) lastIndex.current = index
  useEffect(() => {
    if (!current || index >= 0) return
    if (lastIndex.current < 0) return // opened outside the list: do not jump
    if (!list.length) { go(null); return }
    const at = Math.min(Math.max(lastIndex.current - 1, 0), list.length - 1)
    go(list[at])
  }, [current, index, list, go])
  const hasPrev = index > 0
  const hasNext = index >= 0 && index < list.length - 1
  const prev = () => { if (hasPrev) go(list[index - 1]) }
  const next = () => { if (hasNext) go(list[index + 1]) }

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.key === 'ArrowLeft' && hasPrev) { e.preventDefault(); go(list[index - 1]) }
      else if (e.key === 'ArrowRight' && hasNext) { e.preventDefault(); go(list[index + 1]) }
      else if (e.key === 'Escape') { e.preventDefault(); go(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, index, hasPrev, hasNext, list, go])

  return { index, total: list.length, hasPrev, hasNext, prev, next }
}
