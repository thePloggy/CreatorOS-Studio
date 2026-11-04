/* Carousel : une photo de départ, une série de la même séance (même tenue, même lieu,
   poses et cadrages variés), comme un carrousel Instagram. Au gabarit studio : la photo et
   les réglages du carrousel à gauche, les lots lancés d'ici à droite. Le moteur est celui de
   la fenêtre carrousel des vignettes (CarouselPopup), posé dans la page. */
import { useState } from 'react'
import type { Asset } from '../types'
import { t } from '../i18n'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'
import { CarouselPopup } from './popups'

export function CarrouselView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const lots = useSuiviOutil('carrousel')
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [lance, setLance] = useState(false)
  const dansUnLot = (a: { batchId?: string; batchIds?: string[] }) => !!a.batchId && lots.ids.has(a.batchId) || (a.batchIds ?? []).some(b => lots.ids.has(b))

  return (
    <OutilPage titre={t('Carrousel')} texte={t('Une photo de départ, une série de la même séance : même tenue, même lieu, poses et cadrages variés. Les 9 images se publient comme un carrousel Instagram.')}
      jobs={j => dansUnLot(j)} assets={a => dansUnLot(a)} onOpen={onOpen}
      etapes={[
        { titre: 'La photo de départ', texte: 'Une photo de la bibliothèque : elle donne la tenue, le lieu, la lumière et le style.' },
        { titre: 'Les cadenas', texte: 'Fermé, une dimension reste la même dans tout le carrousel (tenue, décor, lumière…) ; ouvert, elle varie d’une image à l’autre.' },
        { titre: 'Les 8 variantes', texte: 'Le rédacteur écrit 8 plans de la même séance, tu les relis et tu les corriges, puis ils partent au rendu avec l’original en tête du lot.' },
      ]}>
      <ZoneSource media="photo" valeur={source} onChoix={v => { setSource(v); setLance(false) }} label={t('Photo de départ')} />
      {source?.asset && !lance && (
        <CarouselPopup key={source.asset.id} asset={source.asset} integre
          onClose={() => setSource(null)}
          onLaunched={lot => { if (lot) lots.ajouter([lot]); setLance(true) }} />
      )}
      {source?.fichier && !source.asset && <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Choisis une photo de la bibliothèque : le carrousel repart de sa description.')}</span>}
      {lance && <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Les 8 variantes sont en file : elles arrivent à droite, l’original en tête du lot.')}</span>}
    </OutilPage>
  )
}
