/* ============================================================
   CreatorOS mobile — shell.

   Quatre espaces (Bibliothèque · Créer · Studio · Jobs) + l'atelier derrière
   l'avatar. Chaque espace garde son état ; passer de l'un à l'autre ne
   perd jamais le travail en cours.

   Le métier n'est PAS réécrit : tout passe par le store partagé avec le
   desktop (src/store/useAppStore). Cette couche est une présentation
   tactile, pas un second produit.
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
  /* Premier lancement : Bibliothèque. Lancements suivants : le dernier
     espace visité. L'atelier n'est jamais restauré — on n'ouvre
     pas l'application sur ses réglages. */
  const [space, setSpace] = useState<Space>(() => {
    // un lien partagé (?s=reel, ?s=image…) ouvre l'espace correspondant, avant le dernier visité
    const lien = lienMobile()
    if (lien) return lien.space
    try {
      const s = localStorage.getItem(LAST_SPACE) as Space | null
      return s && ['library', 'create', 'studio', 'jobs'].includes(s) ? s : 'library'
    } catch { return 'library' }
  })
  useEffect(() => {
    if (space !== 'atelier') { try { localStorage.setItem(LAST_SPACE, space) } catch { /* stockage refusé */ } }
  }, [space])

  const s = useAppStore()
  const [parcours, setParcours] = useState(() => !parcoursDejaVu())
  useEffect(() => { void s.hydrate(); const m = lienMobile()?.mode; if (m) s.setMode(m) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  /* L'OS décharge l'application dès que l'écran s'éteint : sans ça, un
     prompt en cours de rédaction disparaît entre deux consultations. */
  useDraftPersistence()

  /* Demande de navigation posée par le store (Cloner, Animer, Retoucher,
     Prolonger) : sur mobile, « image » comme « vidéo » mènent au même
     espace — c'est l'onglet Image/Vidéo du formulaire qui les distingue. */
  const navNonce = s.navRequest?.nonce ?? 0
  useEffect(() => {
    if (navNonce) setSpace('create')
  }, [navNonce])

  const active = s.jobs.filter(j => STATUTS_ACTIFS.includes(j.status)).length
  useTabTitle()

  /* Hauteur RÉELLE de la capsule reportée en variable CSS : la place
     réservée sous le contenu doit correspondre à ce qui est mesuré, pas à
     une constante (la police système et le zoom texte la font varier). */
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

  /* Clavier ouvert : la capsule flottante se retrouverait POSÉE SUR le
     clavier, au-dessus du champ en cours de saisie. On la masque tant que
     l'utilisateur écrit — `Terminé` reste dans le formulaire. */
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
      {space === 'studio' && <MStudio goVideo={() => { s.setMode('video'); setSpace('create') }} />}
      {space === 'jobs' && <MJobs goLibrary={() => setSpace('library')} />}
      {space === 'atelier' && <MAtelier onBack={() => setSpace('library')} />}
      {parcours && <Parcours onClose={() => setParcours(false)} aller={x => {
        if (x === 'image' || x === 'video') { s.setMode(x === 'image' ? 'photo' : 'video'); setSpace('create') } else setSpace('atelier')
      }} />}
      <UndoDelete bottom={104} />
      <RenderIsland visible={space !== 'jobs'} top={58} onOpen={() => setSpace('library')} />

      {/* capsule Liquid Glass — libellés permanents, état actif lisible même
          sans flou ni animation */}
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
