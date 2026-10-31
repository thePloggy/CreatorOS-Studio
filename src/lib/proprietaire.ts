/* ============================================================
   Clé du propriétaire du studio (démo publique).

   Quand le serveur a une clé (CREATOROS_OWNER_KEY), la page Créateur, les
   personnages, la garde-robe, les recettes et les prompts ne s'écrivent
   qu'avec elle. Le propriétaire la saisit une fois dans Paramètres ; elle
   reste dans CE navigateur et part en en-tête X-Owner-Key sur les écritures
   (POST / PUT / PATCH / DELETE de même origine vers /api/). Le visiteur, lui,
   voit ces écrans en lecture seule.
   ============================================================ */
import { useSyncExternalStore } from 'react'

const CLE = 'creatoros.ownerKey'

export function lireCleProprietaire(): string | null {
  try { return localStorage.getItem(CLE) || null } catch { return null }
}
export function ecrireCleProprietaire(v: string | null) {
  try { if (v) localStorage.setItem(CLE, v); else localStorage.removeItem(CLE) } catch { /* stockage indisponible */ }
  void verifier()
}

/** Ajoute l'en-tête aux écritures de même origine vers /api/ (et aux lectures réservées) — une seule fois, au démarrage. */
export function brancherCleProprietaire() {
  const origine = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const cle = lireCleProprietaire()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const methode = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const memeOrigine = url.startsWith('/') || url.startsWith(window.location.origin)
    const chemin = memeOrigine ? new URL(url, window.location.origin).pathname : ''
    // les écritures, plus les lectures réservées au propriétaire (visiteurs du jour, chemins du serveur)
    const lectureReservee = chemin === '/api/visites' || chemin === '/api/health' || chemin === '/api/uploads' || chemin === '/api/quota' || chemin.startsWith('/api/corbeille')
    if (cle && (lectureReservee || (methode !== 'GET' && methode !== 'HEAD')) && chemin.startsWith('/api/')) {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      h.set('X-Owner-Key', cle)
      return origine(input, { ...init, headers: h })
    }
    return origine(input, init)
  }
}

/* ---------- état partagé : studio verrouillé ? ce navigateur a-t-il la clé ? ---------- */
interface Etat { verrou: boolean; proprietaire: boolean }
let etat: Etat | null = null
const abonnes = new Set<() => void>()

async function verifier() {
  try {
    const r = await fetch('/api/proprietaire', { method: 'POST' })
    etat = r.ok ? await r.json() as Etat : { verrou: true, proprietaire: false }
  } catch { etat = { verrou: true, proprietaire: false } }
  abonnes.forEach(f => f())
}

function abonner(f: () => void) {
  abonnes.add(f)
  if (!etat && abonnes.size === 1) void verifier()
  return () => { abonnes.delete(f) }
}

/** État du verrou ; null tant que le serveur n'a pas répondu. */
export const useVerrou = () => useSyncExternalStore(abonner, () => etat)

/** Ce navigateur peut-il modifier le studio ? Faux tant que la réponse n'est pas
 *  arrivée : un visiteur ne voit jamais passer de bouton d'édition. */
export function useEdition(): boolean {
  const e = useVerrou()
  return !!e && (!e.verrou || e.proprietaire)
}
