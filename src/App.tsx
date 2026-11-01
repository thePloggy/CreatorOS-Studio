/* ============================================================
   App — aiguillage entre les deux shells : l'app mobile (m/) sous
   821 px, la console desktop (v2/) au-dessus. Même store, même serveur.
   ============================================================ */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { useLang } from './i18n'
const MApp = lazy(() => import('./m/MApp'))
/* Chargement PARESSEUX de la console desktop : un téléphone n'a aucune
   raison de la télécharger pour afficher la bibliothèque. */
const V2App = lazy(() => import('./v2/V2App'))

/** Bascule mobile : le shell change en dessous de 821 px. */
function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 820px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)')
    const cb = (e: MediaQueryListEvent) => setM(e.matches)
    mq.addEventListener('change', cb)
    return () => mq.removeEventListener('change', cb)
  }, [])
  return m
}

/** Écran d'attente pendant le chargement du shell paresseux. */
function Booting() {
  return <div style={{ height: '100vh', background: '#0a0b0d' }} />
}

export default function App() {
  const isMobile = useIsMobile()
  // changer de langue remonte le shell : chaque t() relit la langue au rendu
  const lang = useLang()
  const hydrate = useAppStore(s => s.hydrate)

  /* Resynchronisation au retour sur l'onglet : un ordinateur en veille ou un
     onglet en arrière-plan peut rater la fin d'un rendu. Après 30 s d'absence
     on relit l'état du serveur — c'est lui la source de vérité. */
  useEffect(() => {
    let cache = 0
    const cb = () => {
      if (document.hidden) { cache = Date.now(); return }
      if (cache && Date.now() - cache > 30_000) void hydrate()
    }
    document.addEventListener('visibilitychange', cb)
    return () => document.removeEventListener('visibilitychange', cb)
  }, [hydrate])

  /* `?desktop=1` force la console desktop sur un téléphone (utile pour comparer). */
  const forceDesktop = new URLSearchParams(window.location.search).get('desktop') === '1'
  if (isMobile && !forceDesktop) return <Suspense fallback={<Booting />}><MApp key={lang} /></Suspense>
  return <Suspense fallback={<Booting />}><V2App key={lang} /></Suspense>
}
