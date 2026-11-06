/* Lien partagé vers une section (?s=reel, ?s=image…) : l'espace mobile et la vue qui lui correspondent. */
export type EspaceMobile = 'library' | 'create' | 'studio' | 'jobs' | 'atelier'
const VUES_STUDIO = ['reel', 'danse', 'cinema', 'presets', 'reshoot', 'croquis', 'parole', 'montage', 'restaurer', 'pub', 'recadrer', 'doublage', 'analyse']
/** Section demandée par l'adresse (?s=…), traduite en espace mobile (et vue du Studio). */
export function lienMobile(): { space: EspaceMobile; vue?: string; mode?: 'photo' | 'video'; son?: boolean } | null {
  try {
    const sec = new URLSearchParams(window.location.search).get('s') ?? ''
    if (sec === 'assets') return { space: 'library' }
    if (sec === 'image') return { space: 'create', mode: 'photo' }
    if (sec === 'video') return { space: 'create', mode: 'video' }
    // studio son : troisième choix de l'espace Créer, au rang d'Image et de Vidéo
    if (sec === 'son') return { space: 'create', son: true }
    if (sec === 'persona' || sec === 'config' || sec === 'nouveau-personnage' || sec === 'createur' || sec === 'extensions') return { space: 'atelier' }
    if (VUES_STUDIO.includes(sec)) return { space: 'studio', vue: sec }
  } catch { /* adresse illisible */ }
  return null
}
