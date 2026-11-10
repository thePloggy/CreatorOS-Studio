/* ============================================================
   App — switches between the two shells: the mobile app (m/) below
   821 px, the desktop console (v2/) above. Same store, same server.
   ============================================================ */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { useLang } from './i18n'
const MApp = lazy(() => import('./m/MApp'))
/* Lazy-loaded desktop console: a phone never downloads it just to show the library. */
const V2App = lazy(() => import('./v2/V2App'))

/** Mobile breakpoint: the shell switches below 821 px. */
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

/** Placeholder shown while the lazy shell loads. */
function Booting() {
  return <div style={{ height: '100vh', background: '#0a0b0d' }} />
}

export default function App() {
  const isMobile = useIsMobile()
  // changing language remounts the shell: each t() reads the language at render time
  const lang = useLang()
  const hydrate = useAppStore(s => s.hydrate)

  /* Resync when the tab regains focus: a sleeping computer or a background
     tab can miss the end of a render. After 30 s away, the server state is
     reloaded (the server is the source of truth). */
  useEffect(() => {
    let cache = 0
    const cb = () => {
      if (document.hidden) { cache = Date.now(); return }
      if (cache && Date.now() - cache > 30_000) void hydrate()
    }
    document.addEventListener('visibilitychange', cb)
    return () => document.removeEventListener('visibilitychange', cb)
  }, [hydrate])

  /* `?desktop=1` forces the desktop console on a phone. */
  const forceDesktop = new URLSearchParams(window.location.search).get('desktop') === '1'
  if (isMobile && !forceDesktop) return <Suspense fallback={<Booting />}><MApp key={lang} /></Suspense>
  return <Suspense fallback={<Booting />}><V2App key={lang} /></Suspense>
}
