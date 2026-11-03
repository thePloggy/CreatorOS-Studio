/* ============================================================
   CreatorOS mobile — espace Studio : reel en un clic, caméra & effets,
   avatar parlant et montage. Ce sont les vues du bureau (src/v2), posées
   telles quelles dans un conteneur `.v2` pour leurs styles : un seul code
   métier, deux présentations.
   ============================================================ */
import { lazy, Suspense, useState } from 'react'
import '../v2/v2.css'
import { ReelView } from '../v2/ReelView'
import { PresetsView } from '../v2/PresetsView'
import { CinemaView } from '../v2/CinemaView'
import { ReshootView } from '../v2/ReshootView'
import { ParoleView } from '../v2/ParoleView'
import { MontageView } from '../v2/MontageView'
import { MViewer } from './MViewer'
import { Musiques } from '../v2/Musiques'
const CroquisView = lazy(() => import('../v2/CroquisView').then(m => ({ default: m.CroquisView })))
import type { Asset } from '../types'
import { t } from '../i18n'
import { lienMobile } from './lien'

type Vue = 'reel' | 'cinema' | 'presets' | 'reshoot' | 'croquis' | 'parole' | 'sons' | 'montage'
const VUES: [Vue, string][] = [['reel', 'Reel'], ['cinema', 'Ciné'], ['presets', 'Caméra & effets'], ['reshoot', 'Re-shoot'], ['croquis', 'Croquis vers vidéo'], ['parole', 'Avatar parlant'], ['sons', 'Musique et voix'], ['montage', 'Montage']]

export function MStudio({ goVideo }: { goVideo: () => void }) {
  const [vue, setVue] = useState<Vue>(() => { const v = lienMobile()?.vue; return (VUES.some(([x]) => x === v) ? v : 'reel') as Vue })
  const [montageAOuvrir, setMontageAOuvrir] = useState<string | null>(null)
  const [vu, setVu] = useState<{ a: Asset; list: Asset[] } | null>(null)
  return (
    <div className="v2 mstudio">
      <div className="mstudio-onglets" role="tablist">
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
        {vue === 'sons' && <Musiques />}
        {vue === 'montage' && <MontageView ouvrirId={montageAOuvrir} onOpen={(a, list) => setVu({ a, list })} />}
      </div>
      {vu && <MViewer asset={vu.a} list={vu.list} onGo={a => setVu({ a, list: vu.list })} onClose={() => setVu(null)}
        folders={[]} onFoldersChanged={() => {}} />}
    </div>
  )
}
