/* Keeps menus and popups on screen: each opens at its usual place and, only if it
   overflows the viewport, is shifted just enough to fit (and height-limited with
   scrolling if taller than the screen). One observer for the whole app watches
   every element carrying one of these classes or the data-popup attribute. */
const SELECTEUR = '.menu, .elements-choix, [data-popup]'
const MARGE = 8

function caler(el: HTMLElement) {
  el.style.translate = ''
  if (el.dataset.hauteurCalee) { el.style.maxHeight = ''; el.style.overflowY = ''; delete el.dataset.hauteurCalee }
  const r = el.getBoundingClientRect()
  if (!r.width && !r.height) return
  const W = window.innerWidth, H = window.innerHeight
  let dx = 0, dy = 0
  if (r.right > W - MARGE) dx = W - MARGE - r.right
  if (r.left + dx < MARGE) dx = MARGE - r.left
  if (r.height > H - 2 * MARGE) {
    el.style.maxHeight = `${H - 2 * MARGE}px`; el.style.overflowY = 'auto'; el.dataset.hauteurCalee = '1'
    dy = MARGE - r.top
  } else {
    if (r.bottom > H - MARGE) dy = H - MARGE - r.bottom
    if (r.top + dy < MARGE) dy = MARGE - r.top
  }
  if (dx || dy) el.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`
}

let installe = false
export function installerDansEcran() {
  if (installe || typeof window === 'undefined') return
  installe = true
  const suivis = new Set<HTMLElement>()
  const taille = new ResizeObserver(entrees => { for (const e of entrees) caler(e.target as HTMLElement) })
  const suivre = (el: HTMLElement) => {
    if (suivis.has(el)) return
    suivis.add(el); taille.observe(el)
    requestAnimationFrame(() => caler(el))
  }
  const balayer = (racine: ParentNode) => {
    if (racine instanceof HTMLElement && racine.matches(SELECTEUR)) suivre(racine)
    racine.querySelectorAll?.<HTMLElement>(SELECTEUR).forEach(suivre)
  }
  new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(n => { if (n instanceof HTMLElement) balayer(n) })
      m.removedNodes.forEach(n => { if (n instanceof HTMLElement) for (const el of [...suivis]) if (!el.isConnected) { suivis.delete(el); taille.unobserve(el) } })
    }
  }).observe(document.body, { childList: true, subtree: true })
  balayer(document.body)
  window.addEventListener('resize', () => suivis.forEach(caler))
}
