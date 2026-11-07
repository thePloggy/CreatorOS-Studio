/* Personnage choisi pour les prochains rendus. Il appartient au navigateur :
   deux visiteurs peuvent travailler sur deux personnages à la fois. Chaque
   appel à l'API le porte dans l'en-tête X-Personnage. */
const CLE = 'creatoros.personnageChoisi'
export const SANS_PERSONNAGE = 'aucun'

let choisi: string | null = null
try { choisi = localStorage.getItem(CLE) } catch { /* stockage indisponible */ }
/* Propriétaire : chaque nouvel onglet part sans personnage (toute la bibliothèque, aucun visage
   imposé) ; un personnage choisi ensuite reste pour l'onglet. Les visiteurs gardent le leur. */
try {
  if (localStorage.getItem('creatoros.ownerKey') && !sessionStorage.getItem('creatoros.personnageOnglet')) {
    sessionStorage.setItem('creatoros.personnageOnglet', '1')
    choisi = SANS_PERSONNAGE
    localStorage.setItem(CLE, SANS_PERSONNAGE)
  }
} catch { /* stockage indisponible */ }

export const personnageChoisi = () => choisi

/** `persister` : faux pour un choix de PAGE (il ne devient pas le personnage par défaut du studio). */
export function retenirPersonnage(id: string, persister = true) {
  choisi = id
  if (persister) try { localStorage.setItem(CLE, id) } catch { /* stockage indisponible */ }
}
/** Le personnage par défaut du studio (choisi dans l'en-tête ou la page Personnages). */
export const personnageParDefaut = () => { try { return localStorage.getItem(CLE) } catch { return null } }

export function installerPersonnage() {
  const origine = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!choisi || !/^(\/|https?:\/\/[^/]+\/)api\//.test(url) || new URL(url, location.href).origin !== location.origin) return origine(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('X-Personnage', encodeURIComponent(choisi))
    return origine(input, { ...init, headers })
  }
}
