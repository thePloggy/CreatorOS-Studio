/* ============================================================
   Studio owner key (public demo).

   When the server has a key (CREATOROS_OWNER_KEY), the Creator page,
   characters, wardrobe, recipes and prompts can only be written with it.
   The owner enters it once in Settings; it stays in THIS browser and is
   sent in the X-Owner-Key header on writes (same-origin POST / PUT /
   PATCH / DELETE to /api/). Visitors see these screens read-only.
   ============================================================ */
import { useSyncExternalStore } from 'react'

const CLE = 'creatoros.ownerKey'

export function lireCleProprietaire(): string | null {
  try { return localStorage.getItem(CLE) || null } catch { return null }
}
export function ecrireCleProprietaire(v: string | null) {
  try { if (v) localStorage.setItem(CLE, v); else localStorage.removeItem(CLE) } catch { /* storage unavailable */ }
  void verifier()
}

/** Adds the header to same-origin writes to /api/ (and to restricted reads) — install once, at startup. */
export function brancherCleProprietaire() {
  const origine = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const cle = lireCleProprietaire()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const methode = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const memeOrigine = url.startsWith('/') || url.startsWith(window.location.origin)
    const chemin = memeOrigine ? new URL(url, window.location.origin).pathname : ''
    // writes, plus owner-only reads (daily visitors, server paths)
    const lectureReservee = chemin === '/api/visites' || chemin === '/api/health' || chemin === '/api/uploads' || chemin === '/api/quota' || chemin.startsWith('/api/corbeille')
    if (cle && (lectureReservee || (methode !== 'GET' && methode !== 'HEAD')) && chemin.startsWith('/api/')) {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      h.set('X-Owner-Key', cle)
      return origine(input, { ...init, headers: h })
    }
    return origine(input, init)
  }
}

/* ---------- shared state: is the studio locked? does this browser have the key? ---------- */
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

/** Outside React: can this browser edit the studio? (waits for the server response) */
export async function editionPossible(): Promise<boolean> {
  if (!etat) await verifier()
  return !!etat && (!etat.verrou || etat.proprietaire)
}

/** Lock state; null until the server has responded. */
export const useVerrou = () => useSyncExternalStore(abonner, () => etat)

/** Can this browser edit the studio? False until the response arrives,
 *  so a visitor never sees an edit button flash. */
export function useEdition(): boolean {
  const e = useVerrou()
  return !!e && (!e.verrou || e.proprietaire)
}
