/* Musiques et bruitages de la bibliothèque : ceux générés ici et ceux déposés dans le montage. */
import { useEffect, useState } from 'react'
import { t, tServeur } from '../i18n'
import { GenererMusique } from './GenererMusique'

function VoixOff({ surPret }: { surPret: () => void }) {
  const [voix, setVoix] = useState<{ id: string; nom: string }[]>([])
  const [dispo, setDispo] = useState(true)
  const [choix, setChoix] = useState('af_heart')
  const [texte, setTexte] = useState('')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void fetch('/api/voix').then(r => r.json()).then((d: { disponible: boolean; voix: { id: string; nom: string }[] }) => { setVoix(d.voix); setDispo(d.disponible) }).catch(() => {}) }, [])
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    const r = await fetch('/api/voix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte, voix: choix }) })
    const d = await r.json().catch(() => ({}))
    setOccupe(false)
    if (!r.ok) setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); else { setTexte(''); surPret() }
  }
  return (
    <div className="musique" style={{ gap: 8 }}>
      <b>{t('Voix off')}</b>
      {!dispo ? <span style={{ color: 'var(--muted)' }}>{t('Voix non installée sur ce studio.')}</span> : (<>
        <textarea value={texte} onChange={e => setTexte(e.target.value)} maxLength={1200} rows={3} placeholder={t('Le texte à dire, en anglais')}
          style={{ padding: 10, borderRadius: 10, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit' }} />
        <div className="flex gap-2 items-center flex-wrap">
          <select value={choix} onChange={e => setChoix(e.target.value)} aria-label={t('voix')} style={{ background: 'var(--lv2)', color: 'var(--text)', border: '1px solid var(--lv3)', borderRadius: 8, padding: '6px 8px', font: 'inherit' }}>
            {voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}
          </select>
          <button className="pill" disabled={!texte.trim() || occupe} onClick={() => void lancer()}>{occupe ? t('synthèse…') : t('Générer la voix')}</button>
          <span style={{ color: 'var(--faint)' }}>Kokoro-82M · Apache-2.0</span>
        </div>
        {msg && <span style={{ color: 'var(--danger)' }}>{msg}</span>}
      </>)}
    </div>
  )
}

export function Musiques() {
  const [liste, setListe] = useState<{ nom: string; duree: number }[] | null>(null)
  const charger = () => void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string; duree: number }[] }) => setListe(d.musiques ?? [])).catch(() => setListe([]))
  useEffect(charger, [])
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="musiques">
        <h2 className="titre-outil">{t('Musiques et sons')}</h2>
        <VoixOff surPret={charger} />
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
