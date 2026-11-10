/* Noms des personnages (id → nom), chargés une fois pour la page : la vue détaillée
   affiche le personnage d'un rendu, ou « aucun ». */
import { useEffect, useState } from 'react'
import { SANS_PERSONNAGE } from './personnage'

let cache: Promise<Record<string, string>> | null = null
const charger = () => (cache ??= fetch('/api/personas').then(r => r.json())
  .then((d: { personas?: { id: string; name?: string }[] }) => Object.fromEntries((d.personas ?? []).map(p => [p.id, p.name?.trim() || p.id])))
  .catch(() => { cache = null; return {} }))

/** Le nom du personnage d'un rendu ; null pour « aucun » (pas de personnage), undefined pendant le chargement. */
export function useNomPersonnage(id: string | null | undefined): string | null | undefined {
  const [noms, setNoms] = useState<Record<string, string> | null>(null)
  useEffect(() => { void charger().then(setNoms) }, [])
  if (!id || id === SANS_PERSONNAGE) return null
  return noms ? (noms[id] ?? id) : undefined
}
