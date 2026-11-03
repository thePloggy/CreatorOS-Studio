/* Lien partagé vers une section (?s=reel, ?s=image…) : l'espace mobile et la vue qui lui correspondent. */
export type EspaceMobile = 'library' | 'create' | 'studio' | 'jobs' | 'atelier'
const VUES_STUDIO = ['reel', 'cinema', 'presets', 'reshoot', 'croquis', 'parole', 'montage', 'restaurer', 'pub', 'recadrer', 'doublage', 'analyse']
/** Section demandée par l'adresse (?s=…), traduite en espace mobile (et vue du Studio). */
export function lienMobile(): { space: EspaceMobile; vue?: string; mode?: 'photo' | 'video' } | null {
  try {
    const sec = new URLSearchParams(window.location.search).get('s') ?? ''
    if (sec === 'assets') return { space: 'library' }
    if (sec === 'image') return { space: 'create', mode: 'photo' }
    if (sec === 'video') return { space: 'create', mode: 'video' }
    if (sec === 'persona' || sec === 'config' || sec === 'nouveau-personnage' || sec === 'createur' || sec === 'extensions') return { space: 'atelier' }
    if (VUES_STUDIO.includes(sec)) return { space: 'studio', vue: sec }
  } catch { /* adresse illisible */ }
  return null
}
