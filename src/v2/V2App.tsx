/* ============================================================
   CreatorOS Studio — desktop shell: Assets · Image ·
   Video · Character · Settings sections, library at the core.
   ============================================================ */
import { OutilDedie } from './OutilsDedies'
import { OUTILS_GALERIE, OutilGalerie } from './OutilGalerie'
import { BandeauGithub } from '../components/BandeauGithub'
import { LangSwitch } from '../components/LangSwitch'
import { UndoDelete } from '../components/UndoDelete'
import { RenderIsland, PastilleRendu, useTabTitle } from '../components/RenderWatch'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import './v2.css'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { useTelemetry } from '../components/shell/useTelemetry'
import { VoyantMachine } from './Diagnostic'
import { QuotaDemo } from '../components/QuotaDemo'
import { Ic, Anneau } from './bits'
import { Parcours, parcoursDejaVu } from '../components/Parcours'
import { t } from '../i18n'
import { MenusOutils, type ActionOutil, type Section } from './Navigation'
import { arreterEcoute } from './Ecouter'
import { couperOrphelins } from '../lib/medias'
import { installerDansEcran } from '../lib/dansEcran'
installerDansEcran()

/* Screens are lazy-loaded when opened, so the demo does not ship the whole studio on each visit. */
const ImageView = lazy(() => import('./ImageView').then(m => ({ default: m.ImageView })))
const MontageView = lazy(() => import('./MontageView').then(m => ({ default: m.MontageView })))
const ReelView = lazy(() => import('./ReelView').then(m => ({ default: m.ReelView })))
const PresetsView = lazy(() => import('./PresetsView').then(m => ({ default: m.PresetsView })))
const CinemaView = lazy(() => import('./CinemaView').then(m => ({ default: m.CinemaView })))
const ReshootView = lazy(() => import('./ReshootView').then(m => ({ default: m.ReshootView })))
const HomeView = lazy(() => import('./HomeView').then(m => ({ default: m.HomeView })))
const ParoleView = lazy(() => import('./ParoleView').then(m => ({ default: m.ParoleView })))
const VideoView = lazy(() => import('./VideoView').then(m => ({ default: m.VideoView })))
const SonView = lazy(() => import('./SonView').then(m => ({ default: m.SonView })))
const AssetsView = lazy(() => import('./AssetsView').then(m => ({ default: m.AssetsView })))
const Viewer = lazy(() => import('./Viewer').then(m => ({ default: m.Viewer })))
const CroquisView = lazy(() => import('./CroquisView').then(m => ({ default: m.CroquisView })))
const OutilsClip = () => import('./OutilsClipViews')
const RecadrerView = lazy(() => OutilsClip().then(m => ({ default: m.RecadrerView })))
const RestaurerView = lazy(() => import('./RestaurerView').then(m => ({ default: m.RestaurerView })))
const CarrouselView = lazy(() => import('./CarrouselView').then(m => ({ default: m.CarrouselView })))
const DanseView = lazy(() => import('./DanseView').then(m => ({ default: m.DanseView })))
const StylesView = lazy(() => import('./StylesView').then(m => ({ default: m.StylesView })))
const DoublageView = lazy(() => OutilsClip().then(m => ({ default: m.DoublageView })))
const AnalyseView = lazy(() => OutilsClip().then(m => ({ default: m.AnalyseView })))
const CreerPersonnageView = lazy(() => import('../features/persona/CreerPersonnageView').then(m => ({ default: m.CreerPersonnageView })))
const PubView = lazy(() => import('./PubView').then(m => ({ default: m.PubView })))
const ExtensionsView = lazy(() => import('./ExtensionsView').then(m => ({ default: m.ExtensionsView })))
const PersonaView = lazy(() => import('../features/persona/PersonaView').then(m => ({ default: m.PersonaView })))
const ConfigView = lazy(() => import('../features/config/ConfigView').then(m => ({ default: m.ConfigView })))
const CreateurView = lazy(() => import('../features/createur/CreateurView').then(m => ({ default: m.CreateurView })))


/** GPU · VRAM · CPU · RAM as rings, GPU and CPU temperatures (polled every 5 s).
 *  Compact: rings and temperatures; wide screen: values next to the rings and the card name. */
function Telemetry() {
  const tel = useTelemetry()
  if (!tel?.gpu) return null
  const g = tel.gpu
  const vramPct = g.vramTotalMb ? (g.vramUsedMb / g.vramTotalMb) * 100 : 0
  const ramPct = tel.ram ? (tel.ram.usedMb / tel.ram.totalMb) * 100 : 0
  const go = (mb: number) => (mb / 1024).toFixed(1).replace('.', ',')
  const val = { color: 'var(--text)', fontWeight: 500 } as const
  const jauge = (nom: string, pct: number, titre: string, detail?: string) => (
    <span className="flex items-center gap-1" title={titre}>
      <span>{nom}</span><Anneau pct={pct} titre={titre} taille={16} />
      {detail && <b className="hidden min-[1800px]:inline" style={val}>{detail}</b>}
    </span>
  )
  const temp = (nom: string, v: number | null, alerte: number) => v == null ? null : (
    <span title={t('température {nom}', { nom })}><span className="hidden min-[1800px]:inline">{nom} </span><b style={{ ...val, color: v >= alerte ? 'var(--attention)' : 'var(--text)' }}>{v}°</b></span>
  )
  return (
    <div className="flex items-center gap-1.5 min-[1800px]:gap-3 font-mono text-[12px]" style={{ color: 'var(--muted)', flexShrink: 0 }}
      title={t('GPU, VRAM, CPU, RAM et températures (5 s)')}>
      {g.nom && <b className="hidden min-[1900px]:inline" style={val}>{g.nom}</b>}
      {jauge('GPU', g.util, t('charge GPU : {n} %', { n: g.util }), `${g.util} %`)}
      {jauge('VRAM', vramPct, t('mémoire vidéo : {n} %', { n: Math.round(vramPct) }), `${go(g.vramUsedMb)} ${t('Go')}`)}
      {tel.cpu.util != null && jauge('CPU', tel.cpu.util, t('charge CPU : {n} %', { n: tel.cpu.util }), `${tel.cpu.util} %`)}
      {tel.ram && jauge('RAM', ramPct, t('mémoire vive : {n} %', { n: Math.round(ramPct) }), `${Math.round(tel.ram.usedMb / 1024)}/${Math.round(tel.ram.totalMb / 1024)} ${t('Go')}`)}
      <span className="flex items-center gap-1 min-[1800px]:gap-2">{temp('GPU', g.temp, 80)}{temp('CPU', tel.cpu.temp, 85)}</span>
    </div>
  )
}

const SECTIONS: Section[] = ['accueil', 'croquis', 'image', 'son', 'cinema', 'reshoot', 'video', 'reel', 'presets', 'parole', 'montage', 'assets', 'persona', 'config', 'createur', 'extensions', 'pub', 'recadrer', 'doublage', 'analyse', 'nouveau-personnage', 'restaurer', 'styles', 'relight', 'expand', 'outil', 'carrousel', 'danse']
// a dedicated page's tool and the Camera Moves / Effects family also come from the URL
{
  const q = new URLSearchParams(window.location.search)
  if (q.get('o')) useAppStore.setState({ outilDedie: q.get('o') as never })
  if (q.get('f') === 'camera' || q.get('f') === 'effet') useAppStore.setState({ famillePresets: q.get('f') as 'camera' | 'effet' })
}

export default function V2App() {
  /* deep-link: ?s=video|persona|config (default image). */
  const initial = (new URLSearchParams(window.location.search).get('s') as Section) || 'accueil'
  const [montageAOuvrir, setMontageAOuvrir] = useState<string | null>(null)
  const ouvrirStage = useAppStore(st => st.ouvrirStage)
  const outilDedie = useAppStore(st => st.outilDedie)
  const [section, setSection] = useState<Section>(SECTIONS.includes(initial) ? initial : 'accueil')
  const [focus, setFocus] = useState<{ a: Asset; list: Asset[]; action?: ActionOutil } | null>(null)
  const s = useAppStore()
  const [parcours, setParcours] = useState(() => !parcoursDejaVu())

  useEffect(() => { void s.hydrate() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // each page has its own character (chosen in the page), otherwise the studio default
  const outilCourant = useAppStore(st => st.outilDedie)
  useEffect(() => { void useAppStore.getState().entrerPage(section === 'outil' ? `outil:${outilCourant}` : section) }, [section, outilCourant])

  /* Each page has its own URL (?s=section, &o=tool for a tool page): reload keeps the same page, and browser Back returns
     to the previous page. */
  const depuisHistorique = useRef(false)
  useEffect(() => {
    const q = new URLSearchParams()
    if (section !== 'accueil') q.set('s', section)
    if (section === 'outil') q.set('o', outilDedie)
    const url = `${window.location.pathname}${q.toString() ? `?${q}` : ''}`
    if (url === `${window.location.pathname}${window.location.search}`) { depuisHistorique.current = false; return }
    if (depuisHistorique.current) { depuisHistorique.current = false; window.history.replaceState(null, '', url) }
    else window.history.pushState(null, '', url)
  }, [section, outilDedie])
  useEffect(() => {
    const lire = () => {
      const q = new URLSearchParams(window.location.search)
      const sec = (q.get('s') as Section) || 'accueil'
      depuisHistorique.current = true
      if (q.get('o')) useAppStore.setState({ outilDedie: q.get('o') as typeof outilDedie })
      if (q.get('f') === 'camera' || q.get('f') === 'effet') useAppStore.setState({ famillePresets: q.get('f') as 'camera' | 'effet' })
      setFocus(null)
      setSection(SECTIONS.includes(sec) ? sec : 'accueil')
    }
    window.addEventListener('popstate', lire)
    return () => window.removeEventListener('popstate', lire)
  }, [])

  /* Asset re-resolved on each render: review changes reviewStatus and
     the viewer must see the fresh version. The navigation list is the
     filtered grid's list at click time (arrows stay within the filter). */
  const focusFresh = focus ? s.assets.find(a => a.id === focus.a.id) ?? null : null
  /* On page or media change, stop any audio still playing (detached clip, preview),
     except the open viewer's video. */
  useEffect(() => {
    const h = window.setTimeout(() => {
      document.querySelectorAll<HTMLMediaElement>('video, audio').forEach(m => { if (!m.muted && !m.paused && !m.hasAttribute('data-lecture-active')) m.pause() })
      if (!focus) arreterEcoute()
      couperOrphelins()
    }, 0)
    return () => window.clearTimeout(h)
  }, [section, focus?.a.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const navList = useMemo(
    () => (focus ? focus.list.map(x => s.assets.find(a => a.id === x.id) ?? x) : []),
    [s.assets, focus])

  /* Clone from any section (Assets, viewer…): the store posts a
     navigation request and the shell executes it, so the console
     receiving the settings becomes visible. */
  const navNonce = s.navRequest?.nonce ?? 0
  useEffect(() => {
    const target = useAppStore.getState().navRequest?.section
    if (navNonce && target) setSection(target)
  }, [navNonce])

  const activeJobs = s.jobs.filter(j => STATUTS_ACTIFS.includes(j.status)).length
  useTabTitle()

  return (
    <div className="v2 h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* ---------- top bar (lower layer) ---------- */}
      <h1 className="sr-only">CreatorOS Studio</h1>
      <BandeauGithub />
      <header className="flex items-center gap-3 px-4 flex-none" style={{ background: '#0a0b0d', height: 62, paddingBottom: 12 }}>
        <span className="text-[15px] font-bold tracking-tight select-none" style={{ color: 'var(--text)', cursor: 'pointer' }} onClick={() => setSection('accueil')}>
          Creator<span style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>OS</span>
        </span>
        <nav className="flex gap-0.5 ml-2 items-center">
          {([['accueil', 'Accueil'], ['assets', 'Bibliothèque'], ['persona', 'Personnages']] as [Section, string][]).map(([k, label]) => (
            <button key={k} className={`nav-lien ${section === k ? 'actif' : ''}`}
              onClick={() => { useAppStore.setState({ stageOuvert: false }); setSection(k) }}>{t(label)}</button>
          ))}
          <span style={{ width: 1, height: 18, background: 'var(--lv3)', margin: '0 6px' }} />
          <MenusOutils section={section} aller={setSection} onPick={(a, action) => setFocus({ a, list: [a], action })} />
          <span style={{ width: 1, height: 18, background: 'var(--lv3)', margin: '0 10px' }} />
          <button
            className={`nav-lien ${section === 'config' ? 'actif' : ''}`}
            onClick={() => setSection('config')}>{t('Paramètres')}</button>
          <button
            className={`nav-lien ${section === 'createur' ? 'actif' : ''}`}
            onClick={() => setSection('createur')}>{t('Créateur')}</button>
        </nav>
        <div className="ml-auto flex items-center gap-2 min-[1800px]:gap-3 text-[12px] flex-none" style={{ color: 'var(--faint)', whiteSpace: 'nowrap' }}>
          <PastilleRendu />
          <Telemetry />
          {activeJobs > 0 && <span className="masquer-etroit" style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>{t('{n} en rendu', { n: activeJobs })}</span>}
          <span className="masquer-tres-etroit"><QuotaDemo /></span>
          <VoyantMachine />
          <button title={t('parcours guidé')} aria-label={t('parcours guidé')} onClick={() => setParcours(true)}
            style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><Ic n="help" s={15} /></button>
          <LangSwitch />
        </div>
      </header>

      {/* ---------- active section (upper layer) ---------- */}
      {/* No overflow-y here: views scroll internally (.scrollwrap,
          sidebars); a global scroll would shift all content below the header. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden"
        /* An overflow-hidden container can still be scrolled
           programmatically (focusing an off-screen input, scrollIntoView):
           any residual scroll is reset so the sort bar stays under the header. */
        onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0 }}>
        <Suspense fallback={null}>
        {section === 'image' && <ImageView onOpen={(a, list) => setFocus({ a, list })} goVideo={() => setSection('video')} />}
        {section === 'cinema' && <CinemaView onOpen={(a, list) => setFocus({ a, list })} goVideo={() => setSection('video')} />}
        {section === 'reshoot' && <ReshootView />}
        {section === 'video' && <VideoView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'son' && <SonView goMontage={() => setSection('montage')} />}
        {section === 'croquis' && <Suspense fallback={null}><CroquisView /></Suspense>}
        {section === 'extensions' && <ExtensionsView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'pub' && <PubView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'recadrer' && <RecadrerView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'restaurer' && <RestaurerView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'carrousel' && <CarrouselView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'danse' && <DanseView onOpen={(a, list) => setFocus({ a, list })} goMontage={() => setSection('montage')} />}
        {section === 'outil' && (OUTILS_GALERIE[outilDedie]
          ? <OutilGalerie key={outilDedie} id={outilDedie} onOpen={(a, list) => setFocus({ a, list })} />
          : <OutilDedie key={outilDedie} id={outilDedie} onOpen={(a, list) => setFocus({ a, list })} />)}
        {(section === 'styles' || section === 'relight' || section === 'expand') && <StylesView key={section} mode={section} goImage={() => setSection('image')} onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'doublage' && <DoublageView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'analyse' && <AnalyseView />}
        {section === 'nouveau-personnage' && <CreerPersonnageView />}
        {section === 'accueil' && <HomeView go={c => { if (c === 'stage') ouvrirStage(); else setSection(c) }} aller={setSection} onPick={(a, action) => setFocus({ a, list: [a], action })} />}
        {section === 'parole' && <ParoleView goVideo={() => setSection('video')} />}
        {section === 'presets' && <PresetsView goVideo={() => setSection('video')} onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'reel' && <ReelView goMontage={id => { setMontageAOuvrir(id); setSection('montage') }} />}
        {section === 'montage' && <MontageView ouvrirId={montageAOuvrir} onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'assets' && <AssetsView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'persona' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><PersonaView /></div>}
        {section === 'config' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><ConfigView /></div>}
        {section === 'createur' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><div className="p-4 max-w-[720px]"><CreateurView /></div></div>}
        </Suspense>
      </div>

      {parcours && <Parcours onClose={() => setParcours(false)} aller={setSection} />}
      <UndoDelete />
      <RenderIsland visible={!!focusFresh || section === 'persona' || section === 'config' || section === 'createur'} onOpen={a => setFocus({ a, list: s.assets.filter(x => x.mediaType === a.mediaType && x.reviewStatus !== 'rejected') })} />
      {focusFresh && (<Suspense fallback={null}>
        <Viewer key={focus?.action ?? 'libre'} action={focus?.action} asset={focusFresh} list={navList}
          onGo={a => setFocus(f => (a && f ? { a, list: f.list } : null))} onClose={() => setFocus(null)}
          goVideo={() => setSection('video')} goImage={() => setSection('image')} />
      </Suspense>)}
    </div>
  )
}
