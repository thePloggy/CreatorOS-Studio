/* Character names (id → name), loaded once per page: the detail view shows
   a render's character, or "none". */
import { useEffect, useState } from 'react'
import { SANS_PERSONNAGE } from './personnage'

let cache: Promise<Record<string, string>> | null = null
const charger = () => (cache ??= fetch('/api/personas').then(r => r.json())
  .then((d: { personas?: { id: string; name?: string }[] }) => Object.fromEntries((d.personas ?? []).map(p => [p.id, p.name?.trim() || p.id])))
  .catch(() => { cache = null; return {} }))

/** Character name of a render; null for "none" (no character), undefined while loading. */
export function useNomPersonnage(id: string | null | undefined): string | null | undefined {
  const [noms, setNoms] = useState<Record<string, string> | null>(null)
  useEffect(() => { void charger().then(setNoms) }, [])
  if (!id || id === SANS_PERSONNAGE) return null
  return noms ? (noms[id] ?? id) : undefined
}
