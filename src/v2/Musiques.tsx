/* Musiques et bruitages de la bibliothèque : ceux générés ici et ceux déposés dans le montage. */
import { useEffect, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { GenererMusique } from './GenererMusique'

function VoixOff({ surPret }: { surPret: () => void }) {
  const [voix, setVoix] = useState<{ id: string; nom: string }[]>([])
  const [dispo, setDispo] = useState(true)
  const [clone, setClone] = useState(false)
  const [cloner, setCloner] = useState(false)
  const [refs, setRefs] = useState<string[]>([])
  const [ref, setRef] = useState('')
  const [accord, setAccord] = useState(false)
  const edition = useEdition()
  const [choix, setChoix] = useState('af_heart')
  const [texte, setTexte] = useState('')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void fetch('/api/voix').then(r => r.json()).then((d: { disponible: boolean; voix: { id: string; nom: string }[]; clone?: boolean }) => { setVoix(d.voix); setDispo(d.disponible); setClone(!!d.clone) }).catch(() => {})
    void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string }[] }) => { const l = (d.musiques ?? []).map(m => m.nom); setRefs(l); setRef(l[0] ?? '') }).catch(() => {}) }, [])
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    const r = cloner
      ? await fetch('/api/voix/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte, reference: ref, accord }) })
      : await fetch('/api/voix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte, voix: choix }) })
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
          {clone && edition && <span className="flex gap-1">
            <button className={`pill ${!cloner ? 'on' : ''}`} onClick={() => setCloner(false)}>{t('Voix du studio')}</button>
            <button className={`pill ${cloner ? 'on' : ''}`} onClick={() => setCloner(true)}>{t('Cloner une voix')}</button>
          </span>}
          {cloner
            ? <select value={ref} onChange={e => setRef(e.target.value)} aria-label={t('extrait de référence')} style={{ maxWidth: 260, background: 'var(--lv2)', color: 'var(--text)', border: '1px solid var(--lv3)', borderRadius: 8, padding: '6px 8px', font: 'inherit' }}>
                {refs.map(n => <option key={n} value={n}>{n.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')}</option>)}
              </select>
            : <select value={choix} onChange={e => setChoix(e.target.value)} aria-label={t('voix')} style={{ background: 'var(--lv2)', color: 'var(--text)', border: '1px solid var(--lv3)', borderRadius: 8, padding: '6px 8px', font: 'inherit' }}>
                {voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}
              </select>}
          <button className="pill" disabled={!texte.trim() || occupe || (cloner && (!accord || !ref))} onClick={() => void lancer()}>{occupe ? t('synthèse…') : cloner ? t('Cloner et dire') : t('Générer la voix')}</button>
          <span style={{ color: 'var(--faint)' }}>{cloner ? 'Chatterbox · MIT' : 'Kokoro-82M · Apache-2.0'}</span>
        </div>
        {cloner && <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={accord} onChange={e => setAccord(e.target.checked)} /> {t('Cette voix est la mienne, ou la personne a donné son accord. L’extrait de référence (5 à 20 s) vient de la bibliothèque audio.')}
        </label>}
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
