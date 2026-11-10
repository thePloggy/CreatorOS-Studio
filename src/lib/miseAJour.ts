/* After a studio update, a tab left open requests chunks from the previous build that
   no longer exist, so the view fails to load. The page is then reloaded once, without looping. */
const CLE = 'creatoros.rechargeMiseAJour'
const MORCEAU_ABSENT = /dynamically imported module|Importing a module script failed|error loading dynamically|Unable to preload CSS|text\/html.*MIME|MIME.*text\/html/i

function recharger() {
  try {
    const dernier = Number(sessionStorage.getItem(CLE) ?? 0)
    if (Date.now() - dernier < 15_000) return
    sessionStorage.setItem(CLE, String(Date.now()))
  } catch { /* storage unavailable: reload anyway */ }
  window.location.reload()
}

export function surveillerMiseAJour() {
  window.addEventListener('vite:preloadError', e => { e.preventDefault(); recharger() })
  window.addEventListener('unhandledrejection', e => { if (MORCEAU_ABSENT.test(String(e.reason?.message ?? e.reason))) recharger() })
  window.addEventListener('error', e => { if (MORCEAU_ABSENT.test(String(e.message))) recharger() })
}
