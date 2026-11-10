/* Character selected for upcoming renders. It belongs to the browser:
   two visitors can work on two characters at once. Every API call carries
   it in the X-Personnage header. */
const CLE = 'creatoros.personnageChoisi'
export const SANS_PERSONNAGE = 'aucun'

let choisi: string | null = null
try { choisi = localStorage.getItem(CLE) } catch { /* storage unavailable */ }
/* Owner: each new tab starts with no character (whole library, no forced face);
   a character chosen afterwards stays for that tab. Visitors keep theirs. */
try {
  if (localStorage.getItem('creatoros.ownerKey') && !sessionStorage.getItem('creatoros.personnageOnglet')) {
    sessionStorage.setItem('creatoros.personnageOnglet', '1')
    choisi = SANS_PERSONNAGE
    localStorage.setItem(CLE, SANS_PERSONNAGE)
  }
} catch { /* storage unavailable */ }

export const personnageChoisi = () => choisi

/** `persister`: false for a PAGE-level choice (it does not become the studio's default character). */
export function retenirPersonnage(id: string, persister = true) {
  choisi = id
  if (persister) try { localStorage.setItem(CLE, id) } catch { /* storage unavailable */ }
}
/** The studio's default character (chosen in the header or the Characters page). */
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
