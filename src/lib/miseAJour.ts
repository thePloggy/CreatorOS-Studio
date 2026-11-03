/* Après une mise à jour du studio, un onglet resté ouvert réclame des morceaux du build précédent,
   qui n'existent plus : la vue ne se charge pas. On recharge alors la page une fois, sans boucler. */
const CLE = 'creatoros.rechargeMiseAJour'
const MORCEAU_ABSENT = /dynamically imported module|Importing a module script failed|error loading dynamically|Unable to preload CSS|text\/html.*MIME|MIME.*text\/html/i

function recharger() {
  try {
    const dernier = Number(sessionStorage.getItem(CLE) ?? 0)
    if (Date.now() - dernier < 15_000) return
    sessionStorage.setItem(CLE, String(Date.now()))
  } catch { /* stockage indisponible : on recharge quand même */ }
  window.location.reload()
}

export function surveillerMiseAJour() {
  window.addEventListener('vite:preloadError', e => { e.preventDefault(); recharger() })
  window.addEventListener('unhandledrejection', e => { if (MORCEAU_ABSENT.test(String(e.reason?.message ?? e.reason))) recharger() })
  window.addEventListener('error', e => { if (MORCEAU_ABSENT.test(String(e.message))) recharger() })
}
