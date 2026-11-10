/* ============================================================
   Visitor's Comfy Cloud key.

   Stored in THIS browser only (localStorage). With a key, every render
   submission (POST /api/…) carries it in the X-Comfy-Key header: the server
   sends the render to Comfy Cloud on the visitor's account and forgets the
   key at the end of the job. Without a key, the render runs on the server's ComfyUI.
   ============================================================ */
const CLE = 'creatoros.comfyKey'

export function lireCleComfy(): string | null {
  try { return localStorage.getItem(CLE) || null } catch { return null }
}
export function ecrireCleComfy(v: string | null) {
  try { if (v) localStorage.setItem(CLE, v); else localStorage.removeItem(CLE) } catch { /* storage unavailable */ }
}

/** Adds the header to same-origin POST requests to /api/ — install once,
 *  at startup. Other requests are left untouched. */
export function brancherCleComfy() {
  const origine = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const cle = lireCleComfy()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const methode = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const memeOrigine = url.startsWith('/') || url.startsWith(window.location.origin)
    if (cle && methode === 'POST' && memeOrigine && new URL(url, window.location.origin).pathname.startsWith('/api/')) {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      h.set('X-Comfy-Key', cle)
      return origine(input, { ...init, headers: h })
    }
    return origine(input, init)
  }
}
