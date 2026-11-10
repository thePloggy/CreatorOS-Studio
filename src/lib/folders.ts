/* ============================================================
   Folder sorting — ONE preference, applied wherever folders are
   shown: Library sidebar, "Move to…" menu, detail sheet, mobile
   folder sheet. The server always returns the same order
   (created_at DESC); the client decides the display order.
   ============================================================ */

export type FolderSort = 'recent' | 'ancien' | 'nom' | 'nomDesc' | 'taille'

export const FOLDER_SORTS: { id: FolderSort; label: string; court: string }[] = [
  { id: 'recent', label: 'Plus récents en haut', court: 'récents' },
  { id: 'ancien', label: 'Plus anciens en haut', court: 'anciens' },
  { id: 'nom', label: 'Nom (A → Z)', court: 'A→Z' },
  { id: 'nomDesc', label: 'Nom (Z → A)', court: 'Z→A' },
  { id: 'taille', label: 'Les plus remplis', court: 'remplis' },
]

interface Triable { name: string; createdAt: number; count: number }

export function trierDossiers<T extends Triable>(folders: T[], mode: FolderSort): T[] {
  /* `numeric`: "Lot 2" sorts before "Lot 10"; `base`: accents and case
     do not affect a folder's position. */
  const parNom = (a: T, b: T) =>
    a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true })
  const out = [...folders]
  switch (mode) {
    case 'ancien': return out.sort((a, b) => a.createdAt - b.createdAt)
    case 'nom': return out.sort(parNom)
    case 'nomDesc': return out.sort((a, b) => parNom(b, a))
    /* With equal item counts the name breaks the tie, so the order stays
       stable across reloads. */
    case 'taille': return out.sort((a, b) => b.count - a.count || parNom(a, b))
    default: return out.sort((a, b) => b.createdAt - a.createdAt)
  }
}
