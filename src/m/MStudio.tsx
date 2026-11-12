/* ============================================================
   CreatorOS mobile, Studio space: one-click reel, camera & effects,
   talking avatar and editing. These are the desktop views (src/v2),
   mounted as is in a `.v2` container for their styles: one business
   logic, two presentations.
   ============================================================ */
import { useAppStore } from '../store/useAppStore'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import '../v2/v2.css'
import { ReelView } from '../v2/ReelView'
import { PresetsView } from '../v2/PresetsView'
import { CinemaView } from '../v2/CinemaView'
import { ReshootView } from '../v2/ReshootView'
import { PlanLongView } from '../v2/PlanLongView'
import { ParoleView } from '../v2/ParoleView'
import { MontageView } from '../v2/MontageView'
import { MViewer } from './MViewer'
import { SonView } from '../v2/SonView'
const CroquisView = lazy(() => import('../v2/CroquisView').then(m => ({ default: m.CroquisView })))
const OutilsClip = () => import('../v2/OutilsClipViews')
const RestaurerView = lazy(() => import('../v2/RestaurerView').then(m => ({ default: m.RestaurerView })))
const PubView = lazy(() => import('../v2/PubView').then(m => ({ default: m.PubView })))
const OutilGalerie = lazy(() => import('../v2/OutilGalerie').then(m => ({ default: m.OutilGalerie })))
const StylesView = lazy(() => import('../v2/StylesView').then(m => ({ default: m.StylesView })))
const DanseView = lazy(() => import('../v2/DanseView').then(m => ({ default: m.DanseView })))
const RecadrerView = lazy(() => OutilsClip().then(m => ({ default: m.RecadrerView })))
const DoublageView = lazy(() => OutilsClip().then(m => ({ default: m.DoublageView })))
const AnalyseView = lazy(() => OutilsClip().then(m => ({ default: m.AnalyseView })))
import type { Asset } from '../types'
import { t } from '../i18n'
import { lienMobile } from './lien'
import type { IdOutil } from '../v2/OutilsDedies'

/* One-gesture tools served by the gallery page (OutilGalerie), one "o:<outil>" view each. */
const OUTILS_GALERIE_MOBILE: [IdOutil, string][] = [['inpaint', 'Inpaint'], ['remove-bg', 'Remove Background'], ['upscale', 'Upscale Image'], ['depth', 'Depth Map'],
  ['coverage', 'Coverage'], ['next-shot', 'Next Shot'], ['image-3d', 'Image to 3D'], ['retouch', 'Retouch'], ['remove-objects', 'Remove Objects'], ['change-bg', 'Change Background'],
  ['upscale-1080', 'Upscale 1080p'], ['green-screen', 'Green Screen'], ['add-sound', 'Add Sound'], ['hdr', 'HDR Masters']]
type Vue = `o:${string}` | 'sref' | 'tryon' | 'dump' | 'reel' | 'danse' | 'cinema' | 'presets' | 'styles' | 'relight' | 'fx' | 'angles' | 'loop' | 'smooth' | 'reshoot' | 'planlong' | 'croquis' | 'parole' | 'sons' | 'montage' | 'restaurer' | 'pub' | 'recadrer' | 'doublage' | 'analyse'
const VUES: [Vue, string][] = [['reel', 'One-click Reel'], ['danse', 'Danse'], ['cinema', 'Movie Studio'], ['presets', 'Camera & Effects'], ['styles', 'Styles'], ['relight', 'Relight'], ['sref', 'Style Reference'], ['tryon', 'Try-On'], ['dump', 'Photo Dump'], ['fx', 'Video Effects'], ['angles', 'Multi-Angle'], ['loop', 'Seamless Loop'], ['smooth', 'Smooth Motion'], ['reshoot', 'Re-shoot'], ['planlong', 'Long Take'], ['croquis', 'Sketch to Video'], ['parole', 'Talking Avatar'], ['sons', 'Son'], ['montage', 'Editor'],
  ['restaurer', 'Restore'], ['pub', 'Product Shot'], ['recadrer', 'Extend'], ['doublage', 'Lip Sync'], ['analyse', 'Social Check'],
  ...OUTILS_GALERIE_MOBILE.map(([id, label]) => [`o:${id}`, label] as [Vue, string])]

/** The video effect requested by the URL (?s=outil&o=day-to-night…), else Refine Details. */
const EFFETS_VIDEO = ['refine-details', 'day-to-night', 'deblur', 'decompression', 'colorize', 'restore-clip', 'water'] as const
const effetDemande = (): IdOutil => EFFETS_VIDEO.find(e => e === lienMobile()?.outil) ?? 'effets-video'

/** Studio view requested from another space ("Use in edit" from the sound studio). */
export const vueStudioDemandee: { v: Vue | null } = { v: null }

export function MStudio({ goVideo }: { goVideo: () => void }) {
  const [vue, setVue] = useState<Vue>(() => {
    const d = vueStudioDemandee.v; vueStudioDemandee.v = null
    const v = d ?? lienMobile()?.vue; return (VUES.some(([x]) => x === v) ? v : 'reel') as Vue
  })
  const [montageAOuvrir, setMontageAOuvrir] = useState<string | null>(null)
  // each studio view has its own character (chosen in the view), else the default one
  useEffect(() => { void useAppStore.getState().entrerPage(`m:${vue}`) }, [vue])
  const [vu, setVu] = useState<{ a: Asset; list: Asset[] } | null>(null)
  // the active tab stays visible in the scrolling bar
  const barre = useRef<HTMLDivElement>(null)
  useEffect(() => { barre.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [vue])
  return (
    <div className="v2 mstudio">
      <div ref={barre} className="mstudio-onglets" role="tablist">
        {VUES.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={vue === k} className={vue === k ? 'on' : ''} onClick={() => setVue(k)}>{t(label)}</button>
        ))}
      </div>
      <div className="mstudio-corps">
        {vue === 'reel' && <ReelView goMontage={id => { setMontageAOuvrir(id); setVue('montage') }} />}
        {vue === 'cinema' && <CinemaView onOpen={(a, list) => setVu({ a, list })} goVideo={goVideo} />}
        {vue === 'presets' && <PresetsView goVideo={goVideo} onOpen={(a, list) => setVu({ a, list })} />}
        {vue === 'reshoot' && <ReshootView />}
        {vue === 'planlong' && <PlanLongView />}
        {vue === 'croquis' && <Suspense fallback={null}><CroquisView /></Suspense>}
        {vue === 'parole' && <ParoleView goVideo={goVideo} />}
        {vue === 'sons' && <SonView goMontage={() => setVue('montage')} />}
        {vue === 'montage' && <MontageView ouvrirId={montageAOuvrir} onOpen={(a, list) => setVu({ a, list })} />}
        <Suspense fallback={null}>
          {vue === 'restaurer' && <RestaurerView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'fx' && <OutilGalerie key="fx" id={effetDemande()} onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'angles' && <OutilGalerie key="angles" id="multi-angle" onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'loop' && <OutilGalerie key="loop" id="loop" onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'smooth' && <OutilGalerie key="smooth" id="smooth" onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'sref' && <OutilGalerie key="sref" id="style-ref" onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'tryon' && <OutilGalerie key="tryon" id="try-on" onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'dump' && <OutilGalerie key="dump" id="photodump" onOpen={(a, list) => setVu({ a, list })} />}
          {(vue === 'styles' || vue === 'relight') && <StylesView key={vue} mode={vue} onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'danse' && <DanseView onOpen={(a, list) => setVu({ a, list })} goMontage={() => setVue('montage')} />}
          {vue === 'pub' && <PubView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'recadrer' && <RecadrerView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'doublage' && <DoublageView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'analyse' && <AnalyseView />}
          {vue.startsWith('o:') && <OutilGalerie key={vue} id={vue.slice(2) as IdOutil} onOpen={(a, list) => setVu({ a, list })} />}
        </Suspense>
      </div>
      {vu && <MViewer asset={vu.a} list={vu.list} onGo={a => setVu({ a, list: vu.list })} onClose={() => setVu(null)}
        folders={[]} onFoldersChanged={() => {}} />}
    </div>
  )
}
