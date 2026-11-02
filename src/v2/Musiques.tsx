/* Musiques et bruitages de la bibliothèque : ceux générés ici et ceux déposés dans le montage. */
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { GenererMusique } from './GenererMusique'

export function Musiques() {
  const [liste, setListe] = useState<{ nom: string; duree: number }[] | null>(null)
  const charger = () => void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string; duree: number }[] }) => setListe(d.musiques ?? [])).catch(() => setListe([]))
  useEffect(charger, [])
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="musiques">
        <h2 className="titre-outil">{t('Musiques et sons')}</h2>
        <GenererMusique surPret={charger} />
        {liste?.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>{t('Rien pour l’instant : génère ton premier morceau.')}</p>}
        {liste?.map(m => (
          <div key={m.nom} className="musique">
            <b>{m.nom.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')}</b>
            <audio controls preload="none" src={`/api/montage/musiques/${encodeURIComponent(m.nom)}`} />
          </div>
        ))}
      </div>
    </div>
  )
}
