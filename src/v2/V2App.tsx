/* ============================================================
   CreatorOS Studio — shell desktop : sections Assets · Image ·
   Vidéo · Personnage · Paramètres, bibliothèque au cœur.
   ============================================================ */
import { PersonaMenu } from '../components/PersonaMenu'
import { LangSwitch } from '../components/LangSwitch'
import { UndoDelete } from '../components/UndoDelete'
import { RenderIsland, useTabTitle } from '../components/RenderWatch'
import { useEffect, useMemo, useState } from 'react'
import './v2.css'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { ImageView } from './ImageView'
import { Pastille } from './bits'
import { MontageView } from './MontageView'
import { ReelView } from './ReelView'
import { PresetsView } from './PresetsView'
import { CinemaView } from './CinemaView'
import { ReshootView } from './ReshootView'
import { HomeView } from './HomeView'
import { ParoleView } from './ParoleView'
import { VideoView } from './VideoView'
import { AssetsView } from './AssetsView'
import { Viewer } from './Viewer'
import { PersonaView } from '../features/persona/PersonaView'
import { ConfigView } from '../features/config/ConfigView'
import { CreateurView } from '../features/createur/CreateurView'
import { useTelemetry } from '../components/shell/useTelemetry'
import { VoyantMachine } from './Diagnostic'
import { QuotaDemo } from '../components/QuotaDemo'
import { Ic } from './bits'
import { Parcours, parcoursDejaVu } from '../components/Parcours'
import { t } from '../i18n'

type Section = 'accueil' | 'image' | 'cinema' | 'reshoot' | 'video' | 'reel' | 'presets' | 'parole' | 'montage' | 'assets' | 'persona' | 'config' | 'createur'

/** Mini-barre de charge (seuils 70/90). */
function TBar({ pct }: { pct: number }) {
  const c = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--attention)' : 'var(--positif)'
  return (
    <span style={{ display: 'inline-block', width: 38, height: 4, borderRadius: 99, background: 'var(--lv3)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', height: '100%', borderRadius: 99, background: c, width: `${Math.max(3, Math.min(100, pct))}%` }} />
    </span>
  )
}

/** GPU util · VRAM · température — CPU util · RAM (polling 5 s, comme v5). */
function Telemetry() {
  const tel = useTelemetry()
  if (!tel?.gpu) return null
  const g = tel.gpu
  const vramPct = g.vramTotalMb ? (g.vramUsedMb / g.vramTotalMb) * 100 : 0
  const vramGb = (g.vramUsedMb / 1024).toFixed(1).replace('.', ',')
  const ramPct = tel.ram ? (tel.ram.usedMb / tel.ram.totalMb) * 100 : 0
  const dot = <span style={{ color: 'var(--faint)', margin: '0 6px' }}>·</span>
  const cell = { display: 'flex', alignItems: 'center', gap: 6 } as const
  return (<>
    <div className="hidden lg:flex 2xl:hidden items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--muted)', flexShrink: 0 }} title={t('VRAM utilisée')}>
      {g.nom && <b style={{ color: 'var(--text)', fontWeight: 500 }}>{g.nom}</b>}<TBar pct={vramPct} />
    </div>
    <div className="hidden 2xl:flex items-center font-mono text-[10px]" style={{ color: 'var(--muted)', flexShrink: 0 }}
      title={t('GPU util · VRAM · température — CPU util · RAM (5 s)')}>
      {g.nom && <b style={{ color: 'var(--text)', fontWeight: 500, marginRight: 8 }}>{g.nom}</b>}
      <span style={cell}>GPU <TBar pct={g.util} /> <b style={{ color: 'var(--text)', fontWeight: 500 }}>{g.util} %</b></span>
      {dot}
      <span style={cell}>VRAM <TBar pct={vramPct} /> <b style={{ color: 'var(--text)', fontWeight: 500 }}>{vramGb} {t('Go')}</b></span>
      {dot}
      <span style={{ color: g.temp >= 80 ? 'var(--attention)' : undefined }}>{g.temp}°</span>
      {tel.cpu.util != null && <span className="hidden 2xl:flex items-center">{dot}<span style={cell}>CPU <TBar pct={tel.cpu.util} /> <b style={{ color: 'var(--text)', fontWeight: 500 }}>{tel.cpu.util} %</b></span></span>}
      {tel.ram && <span className="hidden 2xl:flex items-center">{dot}<span style={cell}>RAM <TBar pct={ramPct} /> <b style={{ color: 'var(--text)', fontWeight: 500 }}>{Math.round(tel.ram.usedMb / 1024)}/{Math.round(tel.ram.totalMb / 1024)} {t('Go')}</b></span></span>}
    </div>
  </>)
}

export default function V2App() {
  /* deep-link : ?s=video|persona|config (défaut image). */
  const initial = (new URLSearchParams(window.location.search).get('s') as Section) || 'accueil'
  const [montageAOuvrir, setMontageAOuvrir] = useState<string | null>(null)
  const stageOuvert = useAppStore(st => st.stageOuvert)
  const ouvrirStage = useAppStore(st => st.ouvrirStage)
  const [section, setSection] = useState<Section>(['accueil', 'image', 'cinema', 'reshoot', 'video', 'reel', 'presets', 'parole', 'montage', 'assets', 'persona', 'config', 'createur'].includes(initial) ? initial : 'accueil')
  const [focus, setFocus] = useState<{ a: Asset; list: Asset[] } | null>(null)
  const s = useAppStore()
  const [parcours, setParcours] = useState(() => !parcoursDejaVu())

  useEffect(() => { void s.hydrate() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* L'URL suit la section (?s=…) : un ⌘R recharge LÀ où on était au lieu
     de retomber sur Image. replaceState — pas d'entrées d'historique. */
  useEffect(() => {
    const url = section === 'accueil' ? window.location.pathname : `${window.location.pathname}?s=${section}`
    window.history.replaceState(null, '', url)
  }, [section])

  /* asset re-résolu à chaque render : la revue change reviewStatus, la
     visionneuse doit voir la version fraîche (sinon les boutons mentent).
     La liste de navigation est CELLE de la grille filtrée au moment du clic
     (les flèches restent dans le filtre). */
  const focusFresh = focus ? s.assets.find(a => a.id === focus.a.id) ?? null : null
  const navList = useMemo(
    () => (focus ? focus.list.map(x => s.assets.find(a => a.id === x.id) ?? x) : []),
    [s.assets, focus])

  /* Clone depuis n'importe quelle section (Assets, visionneuse…) : le store
     pose une demande de navigation, le shell l'exécute — la console où
     atterrissent les réglages devient visible d'elle-même. */
  const navNonce = s.navRequest?.nonce ?? 0
  useEffect(() => {
    const target = useAppStore.getState().navRequest?.section
    if (navNonce && target) setSection(target)
  }, [navNonce])

  const activeJobs = s.jobs.filter(j => STATUTS_ACTIFS.includes(j.status)).length
  useTabTitle()

  return (
    <div className="v2 h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* ---------- barre du haut (couche basse) ---------- */}
      <header className="flex items-center gap-3 px-4 flex-none" style={{ background: '#0a0b0d', height: 62, paddingBottom: 12 }}>
        <span className="text-[15px] font-bold tracking-tight select-none" style={{ color: 'var(--text)', cursor: 'pointer' }} onClick={() => setSection('accueil')}>
          Creator<span style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>OS</span>
        </span>
        <PersonaMenu onEdit={() => setSection('persona')}
          className="flex items-center gap-1.5 rounded-full py-[3px] pr-2.5 pl-1 text-[12px]"
          style={{ background: section === 'persona' ? 'var(--lv3)' : 'var(--lv2)', border: 0, cursor: 'pointer', color: 'var(--text)' }} />
        <nav className="flex gap-0.5 ml-2 items-center">
          {([['accueil', 'Accueil'], ['assets', 'Assets'], ['image', 'Image'], ['cinema', '🎬 Ciné'], ['video', 'Vidéo'], ['reel', '✨ Reel'], ['presets', 'Caméra & effets'], ['reshoot', '🎥 Re-shoot'], ['parole', 'Avatar parlant'], ['montage', 'Montage']] as const).map(([k, label]) => (
            <button key={k}
              className="px-2.5 py-1.5 rounded-[9px] text-[12.5px]"
              style={{ background: section === k ? 'var(--lv3)' : 'transparent', color: section === k ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}
              onClick={() => { useAppStore.setState({ stageOuvert: false }); setSection(k) }}>{t(label)}</button>
          ))}
          <button className="px-2.5 py-1.5 rounded-[9px] text-[12.5px]"
            style={{ background: section === 'video' && stageOuvert ? 'var(--lv3)' : 'transparent', color: section === 'video' && stageOuvert ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}
            onClick={() => ouvrirStage()}>Stage<Pastille k="new" /></button>
          <span style={{ width: 1, height: 18, background: 'var(--lv3)', margin: '0 10px' }} />
          <button
            className="px-3.5 py-1.5 rounded-[9px] text-[12.5px]"
            style={{ background: section === 'config' ? 'var(--lv3)' : 'transparent', color: section === 'config' ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer' }}
            onClick={() => setSection('config')}>{t('Paramètres')}</button>
          <button
            className="px-3.5 py-1.5 rounded-[9px] text-[12.5px]"
            style={{ background: section === 'createur' ? 'var(--lv3)' : 'transparent', color: section === 'createur' ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer' }}
            onClick={() => setSection('createur')}>{t('Créateur')}</button>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[11px]" style={{ color: 'var(--faint)' }}>
          <Telemetry />
          {activeJobs > 0 && <span style={{ color: 'var(--accent)' }}>{t('{n} en rendu', { n: activeJobs })}</span>}
          <QuotaDemo />
          <VoyantMachine />
          <button title={t('parcours guidé')} aria-label={t('parcours guidé')} onClick={() => setParcours(true)}
            style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><Ic n="help" s={15} /></button>
          <LangSwitch />
        </div>
      </header>

      {/* ---------- section active (couche haute) ---------- */}
      {/* PAS d'overflow-y ici : les vues scrollent en interne (.scrollwrap,
          sidebars) — un scroll global créait un micro-défilement de tout le
          contenu hors header. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden"
        /* Ceinture+bretelles : un conteneur overflow-hidden reste scrollable
           PROGRAMMATIQUEMENT (focus d'un input hors-champ, scrollIntoView) —
           c'est ce qui faisait glisser la barre de tri sous le header sans
           aucun moyen de remonter. Tout scroll résiduel est annulé net. */
        onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0 }}>
        {section === 'image' && <ImageView onOpen={(a, list) => setFocus({ a, list })} goVideo={() => setSection('video')} />}
        {section === 'cinema' && <CinemaView onOpen={(a, list) => setFocus({ a, list })} goVideo={() => setSection('video')} />}
        {section === 'reshoot' && <ReshootView />}
        {section === 'video' && <VideoView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'accueil' && <HomeView go={c => { if (c === 'stage') ouvrirStage(); else setSection(c) }} />}
        {section === 'parole' && <ParoleView goVideo={() => setSection('video')} />}
        {section === 'presets' && <PresetsView goVideo={() => setSection('video')} />}
        {section === 'reel' && <ReelView goMontage={id => { setMontageAOuvrir(id); setSection('montage') }} />}
        {section === 'montage' && <MontageView ouvrirId={montageAOuvrir} onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'assets' && <AssetsView onOpen={(a, list) => setFocus({ a, list })} />}
        {section === 'persona' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><PersonaView /></div>}
        {section === 'config' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><ConfigView /></div>}
        {section === 'createur' && <div className="layer1 flex-1 min-h-0 overflow-y-auto"><div className="p-4 max-w-[720px]"><CreateurView /></div></div>}
      </div>

      {parcours && <Parcours onClose={() => setParcours(false)} aller={setSection} />}
      <UndoDelete />
      <RenderIsland visible={!!focusFresh || section === 'persona' || section === 'config' || section === 'createur'} onOpen={a => setFocus({ a, list: s.assets.filter(x => x.mediaType === a.mediaType && x.reviewStatus !== 'rejected') })} />
      {focusFresh && (
        <Viewer asset={focusFresh} list={navList}
          onGo={a => setFocus(f => (a && f ? { a, list: f.list } : null))} onClose={() => setFocus(null)}
          goVideo={() => setSection('video')} goImage={() => setSection('image')} />
      )}
    </div>
  )
}
