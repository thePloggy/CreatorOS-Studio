/* Shared link to a section (?s=reel, ?s=image…): the matching mobile space and view. */
export type EspaceMobile = 'library' | 'create' | 'studio' | 'jobs' | 'atelier'
const VUES_STUDIO = ['reel', 'danse', 'cinema', 'presets', 'styles', 'relight', 'tryon', 'dump', 'sref', 'fx', 'angles', 'loop', 'smooth', 'reshoot', 'planlong', 'croquis', 'parole', 'montage', 'restaurer', 'pub', 'recadrer', 'doublage', 'analyse']
/** Section requested by the URL (?s=…), mapped to a mobile space (and Studio view). */
/* Tool pages (?s=outil&o=…) served by a mobile Studio view */
const OUTIL_VERS_VUE: Record<string, string> = { 'effets-video': 'fx', 'refine-details': 'fx', 'day-to-night': 'fx', 'deblur': 'fx', 'decompression': 'fx', 'colorize': 'fx', 'restore-clip': 'fx', 'water': 'fx', 'multi-angle': 'angles', 'loop': 'loop', 'smooth': 'smooth', 'try-on': 'tryon', 'photodump': 'dump', 'style-ref': 'sref' }
export function lienMobile(): { space: EspaceMobile; vue?: string; outil?: string; mode?: 'photo' | 'video'; son?: boolean } | null {
  try {
    const sec = new URLSearchParams(window.location.search).get('s') ?? ''
    if (sec === 'assets') return { space: 'library' }
    if (sec === 'image') return { space: 'create', mode: 'photo' }
    if (sec === 'video') return { space: 'create', mode: 'video' }
    // sound studio: third choice of the Create space, alongside Image and Video
    if (sec === 'son') return { space: 'create', son: true }
    if (sec === 'persona' || sec === 'config' || sec === 'nouveau-personnage' || sec === 'createur' || sec === 'extensions') return { space: 'atelier' }
    if (VUES_STUDIO.includes(sec)) return { space: 'studio', vue: sec }
    const o = new URLSearchParams(window.location.search).get('o') ?? ''
    if (sec === 'outil' && OUTIL_VERS_VUE[o]) return { space: 'studio', vue: OUTIL_VERS_VUE[o], outil: o }
    // other one-gesture tools: their gallery page in the Studio
    if (sec === 'outil' && /^[a-z0-9-]+$/.test(o)) return { space: 'studio', vue: `o:${o}`, outil: o }
  } catch { /* unreadable URL */ }
  return null
}
