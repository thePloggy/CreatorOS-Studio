/* Choix d'une voix : celle du personnage, une voix du studio (Kokoro) ou, pour le propriétaire,
   une voix clonée (un extrait de la bibliothèque audio, Chatterbox). Valeur : id Kokoro, « perso » ou « clone:<extrait> ». */
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { useAppStore } from '../store/useAppStore'

type Voix = { id: string; nom: string }
export function useVoix() {
  const [etat, setEtat] = useState<{ voix: Voix[]; clones: Voix[]; disponible: boolean }>({ voix: [], clones: [], disponible: false })
  useEffect(() => { void fetch('/api/voix').then(r => r.json()).then(d => setEtat({ voix: d.voix ?? [], clones: d.clones ?? [], disponible: !!d.disponible })).catch(() => {}) }, [])
  return etat
}

export function ChoixVoix({ valeur, onChange, perso = true, vide, ariaLabel }: {
  valeur: string; onChange: (v: string) => void
  /** proposer « la voix du personnage » */
  perso?: boolean
  /** libellé d'un choix vide (aucune voix), absent si non proposé */
  vide?: string
  ariaLabel?: string
}) {
  const { voix, clones, disponible } = useVoix()
  const voixPerso = useAppStore(s => s.personaVoix)
  const nomPerso = useAppStore(s => s.personaName)
  if (!disponible) return null
  const nomDe = (id: string | null) => !id ? null : id.startsWith('clone:') ? `${t('voix clonée')} · ${id.slice(6)}` : voix.find(v => v.id === id)?.nom ?? id
  return (
    <select value={valeur} onChange={e => onChange(e.target.value)} className="champ" style={{ fontSize: 12 }} aria-label={ariaLabel ?? t('Voix')}>
      {vide !== undefined && <option value="">{vide}</option>}
      {perso && voixPerso && <option value="perso">{t('Voix de {nom}', { nom: nomPerso })} ({nomDe(voixPerso)})</option>}
      <optgroup label={t('Voix du studio')}>{voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}</optgroup>
      {clones.length > 0 && <optgroup label={t('Voix clonée (extrait de ta bibliothèque audio)')}>{clones.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}</optgroup>}
    </select>
  )
}
