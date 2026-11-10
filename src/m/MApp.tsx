/* ============================================================
   CreatorOS mobile: shell.

   Four spaces (Library · Create · Studio · Jobs) + the workshop behind
   the avatar. Each space keeps its state; switching never loses work
   in progress.

   Business logic is NOT rewritten: everything goes through the store
   shared with desktop (src/store/useAppStore). This layer is a touch
   presentation, not a second product.
   ============================================================ */
import { BandeauGithub } from '../components/BandeauGithub'
import { PersonaMenu } from '../components/PersonaMenu'
import { LangSwitch } from '../components/LangSwitch'
import { QuotaDemo } from '../components/QuotaDemo'
import { UndoDelete } from '../components/UndoDelete'
import { RenderIsland, RenderRing, useTabTitle } from '../components/RenderWatch'
import { STATUTS_ACTIFS } from '../types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './m.css'
import { useAppStore } from '../store/useAppStore'
import { Ic } from './bits'
import { MLibrary } from './MLibrary'
import { MCreate } from './MCreate'
import { MJobs } from './MJobs'
import { MAtelier } from './MAtelier'
import { MStudio, vueStudioDemandee } from './MStudio'
import { Parcours, parcoursDejaVu } from '../components/Parcours'
import { useDraftPersistence } from './useDraft'
import { t } from '../i18n'
import { installerDansEcran } from '../lib/dansEcran'
import { lienMobile } from './lien'
installerDansEcran()

export type Space = 'library' | 'create' | 'studio' | 'jobs' | 'atelier'

const SPACES: [Space, string, 'library' | 'create' | 'studio' | 'jobs'][] = [
  ['library', 'Bibliothèque', 'library'],
  ['create', 'Créer', 'create'],
  ['studio', 'Studio', 'studio'],
  ['jobs', 'Jobs', 'jobs'],
]
const LAST_SPACE = 'm.space'

export default function MApp() {
  /* First launch: Library. Later launches: the last visited space.
     The workshop is never restored: the app does not open on its
     settings. */
  const [space, setSpace] = useState<Space>(() => {
    // a shared link (?s=reel, ?s=image…) opens the matching space, ahead of the last visited one
    const lien = lienMobile()
    if (lien) return lien.space
    try {
      const s = localStorage.getItem(LAST_SPACE) as Space | null
      return s && ['library', 'create', 'studio', 'jobs'].includes(s) ? s : 'library'
    } catch { return 'library' }
  })
  // outside the Studio, the space is the page (Create, Library…); the Studio manages its own views
  useEffect(() => { if (space !== 'studio') void useAppStore.getState().entrerPage(`m:${space}`) }, [space])
  useEffect(() => {
    if (space !== 'atelier') { try { localStorage.setItem(LAST_SPACE, space) } catch { /* storage refused */ } }
  }, [space])

  const s = useAppStore()
  const [parcours, setParcours] = useState(() => !parcoursDejaVu())
  useEffect(() => { void s.hydrate(); const m = lienMobile()?.mode; if (m) s.setMode(m) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  /* The OS unloads the app as soon as the screen turns off: without this,
     a prompt being written disappears between visits. */
  useDraftPersistence()

  /* Navigation request set by the store (Clone, Animate, Retouch,
     Extend): on mobile, "image" and "video" lead to the same space;
     the form's Image/Video tab tells them apart. */
  const navNonce = s.navRequest?.nonce ?? 0
  useEffect(() => {
    if (!navNonce) return
    if (useAppStore.getState().navRequest?.section === 'cinema') { vueStudioDemandee.v = 'cinema'; setSpace('studio'); return }
    setSpace('create')
  }, [navNonce])

  const active = s.jobs.filter(j => STATUTS_ACTIFS.includes(j.status)).length
  useTabTitle()

  /* REAL height of the capsule exposed as a CSS variable: the space
     reserved below the content must match the measured height, not a
     constant (system font and text zoom change it). */
  const navRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = navRef.current
    if (!el) return
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height) + 20
      document.documentElement.style.setProperty('--navh', `${h}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* Keyboard open: the floating capsule would sit ON the keyboard,
     above the field being edited. It is hidden while the user types;
     `Done` stays in the form. */
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'TEXTAREA'
        || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((t as HTMLInputElement).type)))
    const on = (e: FocusEvent) => { if (isField(e.target)) setTyping(true) }
    const off = (e: FocusEvent) => { if (isField(e.target)) setTyping(false) }
    window.addEventListener('focusin', on)
    window.addEventListener('focusout', off)
    return () => { window.removeEventListener('focusin', on); window.removeEventListener('focusout', off) }
  }, [])

  return (
    <div className="m">
      <BandeauGithub />
      <header className="top">
        <span className="logo">Creator<i>OS</i></span>
        <span style={{ marginLeft: 'auto' }} />
        <QuotaDemo style={{ fontSize: 12, opacity: 0.85 }} />
        <button className="tap-sm" aria-label={t('parcours guidé')} onClick={() => setParcours(true)}
          style={{ marginLeft: 6, marginRight: 6, background: 'none', border: 0, color: 'inherit', fontSize: 17, opacity: 0.75, minWidth: 36, minHeight: 36 }}>?</button>
        <LangSwitch style={{ marginRight: 8 }} />
        <PersonaMenu alignDroite onEdit={() => setSpace('atelier')} className="persona tap-sm" style={{ minHeight: 40 }} />
      </header>

      {space === 'library' && <MLibrary goCreate={() => setSpace('create')} goJobs={() => setSpace('jobs')} />}
      {space === 'create' && <MCreate goJobs={() => setSpace('jobs')} goMontage={() => { vueStudioDemandee.v = 'montage'; setSpace('studio') }} />}
      {space === 'studio' && <MStudio key={s.navRequest?.section === 'cinema' ? navNonce : 0} goVideo={() => { s.setMode('video'); setSpace('create') }} />}
      {space === 'jobs' && <MJobs goLibrary={() => setSpace('library')} />}
      {space === 'atelier' && <MAtelier onBack={() => setSpace('library')} />}
      {parcours && <Parcours onClose={() => setParcours(false)} aller={x => {
        if (x === 'image' || x === 'video') { s.setMode(x === 'image' ? 'photo' : 'video'); setSpace('create') } else setSpace('atelier')
      }} />}
      <UndoDelete bottom={104} />
      <RenderIsland visible={space !== 'jobs'} top={58} onOpen={() => setSpace('library')} />

      {/* glass capsule: permanent labels, active state readable even
          without blur or animation */}
      <nav className="nav" ref={navRef} hidden={typing}
        style={typing ? { display: 'none' } : undefined} aria-label={t('navigation principale')}>
        {SPACES.map(([k, label, icon]) => (
          <button key={k} className={space === k ? 'on' : ''} aria-current={space === k ? 'page' : undefined}
            onClick={() => setSpace(k)}>
            <Ic n={icon} s={22} />
            <span>{t(label)}</span>
            {k === 'create' && <RenderRing />}
            {k === 'jobs' && active > 0 && <span className="badge" aria-label={t('{n} en cours', { n: active })}>{active}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}
