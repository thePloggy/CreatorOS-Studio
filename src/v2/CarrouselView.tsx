/* Carousel: one source photo, a series from the same shoot (same outfit, same place,
   varied poses and framing). Studio layout: the photo and carousel settings on the left,
   the batches launched from here on the right. Uses the same engine as the thumbnail
   carousel popup (CarouselPopup), embedded in the page. */
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { Asset } from '../types'
import { t } from '../i18n'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'
import { CarouselPopup } from './popups'

export function CarrouselView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const lots = useSuiviOutil('carrousel')
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [lance, setLance] = useState(false)
  // all carousels in the library (a batch whose renders carry the carousel locks), plus those tracked from here
  const assets = useAppStore(st => st.assets)
  const carrousels = useMemo(() => new Set([...lots.ids, ...assets.filter(a => a.batchLocks && a.batchId).map(a => a.batchId!)]), [assets, lots.ids])
  const dansUnLot = (a: { batchId?: string; batchIds?: string[] }) => !!a.batchId && carrousels.has(a.batchId) || (a.batchIds ?? []).some(b => carrousels.has(b))

  return (
    <OutilPage lots
      howto={{ cle: 'carrousel', titre: 'Une séance photo complète, à partir d’une seule photo', texte: 'Même personne, même tenue, même lieu : 8 poses et cadrages de la même séance, prêts à publier en carrousel.', label: 'Exemple de carrousel', repli: '/vitrine/v2-carrousel.webp' }} titre={t('Carrousel')} texte={t('Une photo de départ, une série de la même séance : même tenue, même lieu, poses et cadrages variés. Les 9 images se publient comme un carrousel Instagram.')}
      jobs={j => dansUnLot(j)} assets={a => dansUnLot(a)} onOpen={onOpen}
      etapes={[
        { titre: 'La photo de départ', texte: 'Une photo de la bibliothèque : elle donne la tenue, le lieu, la lumière et le style.' },
        { titre: 'Les cadenas', texte: 'Fermé, une dimension reste la même dans tout le carrousel (tenue, décor, lumière…) ; ouvert, elle varie d’une image à l’autre.' },
        { titre: 'Les 8 variantes', texte: 'Le rédacteur écrit 8 plans de la même séance, tu les relis et tu les corriges, puis ils partent au rendu avec l’original en tête du lot.' },
      ]}>
      {/* once the carousel is submitted, the photo is cleared so the panel starts fresh for the next one */}
      <ZoneSource media="photo" valeur={source} onChoix={v => { setSource(v); setLance(false) }} label={t('Photo de départ')} />
      {source?.asset && !lance && (
        <CarouselPopup key={source.asset.id} asset={source.asset} integre
          onClose={() => setSource(null)}
          onLaunched={lot => { if (lot) lots.ajouter([lot]); setLance(true); setSource(null) }} />
      )}
      {source?.fichier && !source.asset && <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Choisis une photo de la bibliothèque : le carrousel repart de sa description.')}</span>}
      {lance && !source && <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Les 8 variantes sont en file : elles arrivent à droite, l’original en tête du lot. Choisis une autre photo pour un nouveau carrousel.')}</span>}
    </OutilPage>
  )
}
