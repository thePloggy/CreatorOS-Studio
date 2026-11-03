/* Registre des lecteurs audio et vidéo créés dans la page. Un lecteur retiré de la page
   peut continuer de jouer (Safari) : couperOrphelins() arrête tout ce qui n'est plus affiché. */
const lecteurs = new Set<WeakRef<HTMLMediaElement>>()

export function suivreLecteurs() {
  const noter = (n: Node) => {
    if (!(n instanceof Element)) return
    if (n instanceof HTMLMediaElement) lecteurs.add(new WeakRef(n))
    n.querySelectorAll('video, audio').forEach(m => lecteurs.add(new WeakRef(m as HTMLMediaElement)))
  }
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(noter))).observe(document.documentElement, { childList: true, subtree: true })
}

export function couperOrphelins() {
  for (const r of lecteurs) {
    const m = r.deref()
    if (!m) { lecteurs.delete(r); continue }
    if (m.isConnected) continue
    lecteurs.delete(r)
    if (!m.paused) { try { m.pause() } catch { /* déjà libéré */ } }
  }
}
