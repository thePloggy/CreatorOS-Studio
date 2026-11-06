/* ============================================================
   CreatorOS mobile — espace Studio : reel en un clic, caméra & effets,
   avatar parlant et montage. Ce sont les vues du bureau (src/v2), posées
   telles quelles dans un conteneur `.v2` pour leurs styles : un seul code
   métier, deux présentations.
   ============================================================ */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import '../v2/v2.css'
import { ReelView } from '../v2/ReelView'
import { PresetsView } from '../v2/PresetsView'
import { CinemaView } from '../v2/CinemaView'
import { ReshootView } from '../v2/ReshootView'
import { ParoleView } from '../v2/ParoleView'
import { MontageView } from '../v2/MontageView'
import { MViewer } from './MViewer'
import { SonView } from '../v2/SonView'
const CroquisView = lazy(() => import('../v2/CroquisView').then(m => ({ default: m.CroquisView })))
const OutilsClip = () => import('../v2/OutilsClipViews')
const RestaurerView = lazy(() => import('../v2/RestaurerView').then(m => ({ default: m.RestaurerView })))
const PubView = lazy(() => import('../v2/PubView').then(m => ({ default: m.PubView })))
const RecadrerView = lazy(() => OutilsClip().then(m => ({ default: m.RecadrerView })))
const DoublageView = lazy(() => OutilsClip().then(m => ({ default: m.DoublageView })))
const AnalyseView = lazy(() => OutilsClip().then(m => ({ default: m.AnalyseView })))
import type { Asset } from '../types'
import { t } from '../i18n'
import { lienMobile } from './lien'

type Vue = 'reel' | 'cinema' | 'presets' | 'reshoot' | 'croquis' | 'parole' | 'sons' | 'montage' | 'restaurer' | 'pub' | 'recadrer' | 'doublage' | 'analyse'
const VUES: [Vue, string][] = [['reel', 'One-click Reel'], ['cinema', 'Movie Studio'], ['presets', 'Camera & Effects'], ['reshoot', 'Re-shoot'], ['croquis', 'Sketch to Video'], ['parole', 'Talking Avatar'], ['sons', 'Son'], ['montage', 'Editor'],
  ['restaurer', 'Restore'], ['pub', 'Product Shot'], ['recadrer', 'Extend'], ['doublage', 'Lip Sync'], ['analyse', 'Social Check']]

/** Vue du Studio demandée depuis un autre espace (« Utiliser au montage » du studio son). */
export const vueStudioDemandee: { v: Vue | null } = { v: null }

export function MStudio({ goVideo }: { goVideo: () => void }) {
  const [vue, setVue] = useState<Vue>(() => {
    const d = vueStudioDemandee.v; vueStudioDemandee.v = null
    const v = d ?? lienMobile()?.vue; return (VUES.some(([x]) => x === v) ? v : 'reel') as Vue
  })
  const [montageAOuvrir, setMontageAOuvrir] = useState<string | null>(null)
  const [vu, setVu] = useState<{ a: Asset; list: Asset[] } | null>(null)
  // l'onglet actif reste visible dans la barre qui défile
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
        {vue === 'presets' && <PresetsView goVideo={goVideo} />}
        {vue === 'reshoot' && <ReshootView />}
        {vue === 'croquis' && <Suspense fallback={null}><CroquisView /></Suspense>}
        {vue === 'parole' && <ParoleView goVideo={goVideo} />}
        {vue === 'sons' && <SonView goMontage={() => setVue('montage')} />}
        {vue === 'montage' && <MontageView ouvrirId={montageAOuvrir} onOpen={(a, list) => setVu({ a, list })} />}
        <Suspense fallback={null}>
          {vue === 'restaurer' && <RestaurerView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'pub' && <PubView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'recadrer' && <RecadrerView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'doublage' && <DoublageView onOpen={(a, list) => setVu({ a, list })} />}
          {vue === 'analyse' && <AnalyseView />}
        </Suspense>
      </div>
      {vu && <MViewer asset={vu.a} list={vu.list} onGo={a => setVu({ a, list: vu.list })} onClose={() => setVu(null)}
        folders={[]} onFoldersChanged={() => {}} />}
    </div>
  )
}
