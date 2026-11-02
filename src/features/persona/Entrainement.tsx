/* Entraîner le personnage : une LoRA FLUX.2 Klein apprise sur ses images de la bibliothèque.
   Réservé au propriétaire du studio ; le GPU y est occupé une quarantaine de minutes. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'

export function Entrainement() {
  const edition = useEdition()
  const s = useAppStore()
  const [pret, setPret] = useState<boolean | null>(null)
  const [choix, setChoix] = useState<Set<string>>(new Set())
  const [mot, setMot] = useState('')
  const [pas, setPas] = useState(1500)
  const [msg, setMsg] = useState<{ ok: boolean; txt: string } | null>(null)
  useEffect(() => { void fetch('/api/entrainement').then(r => r.json()).then(d => setPret(!!d.pret)).catch(() => setPret(false)) }, [])
  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.personaId === s.personaId && a.reviewStatus !== 'rejected').slice(0, 60), [s.assets, s.personaId])
  const basculer = (id: string) => setChoix(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else if (n.size < 30) n.add(id); return n })
  const lancer = async () => {
    setMsg(null)
    const r = await fetch(`/api/personas/${encodeURIComponent(s.personaId ?? '')}/entrainer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets: [...choix], declencheur: mot, pas }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg({ ok: false, txt: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
    await s.adoptServerJob(d.jobId)
    setMsg({ ok: true, txt: t('Entraînement lancé : la LoRA s’ajoute au personnage à la fin (~{m} min).', { m: Math.round(pas * 1.6 / 60 + 3) }) })
  }
  return (
    <div className="border border-border rounded-card bg-surface2 p-4 mb-4" style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      <b>{t('Entraîner ce personnage')} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· LoRA FLUX.2 Klein · ai-toolkit</span></b>
      {!edition ? <span style={{ color: 'var(--muted)' }}>{t('Réservé au propriétaire du studio.')}</span>
        : pret === false ? <span style={{ color: 'var(--muted)' }}>{t('ai-toolkit n’est pas installé sur ce studio.')}</span> : (<>
        <span style={{ color: 'var(--muted)' }}>{t('Choisis 8 à 30 images du personnage, variées (angles, lumières, tenues) : son visage sera appris et tenu sur Klein.')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
          {photos.map(a => (
            <button key={a.id} onClick={() => basculer(a.id)} aria-pressed={choix.has(a.id)} aria-label={t('sélectionner')}
              style={{ padding: 0, aspectRatio: '3/4', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', border: choix.has(a.id) ? '3px solid var(--accent)' : '3px solid transparent', background: 'none' }}>
              <img src={a.uri} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <span>{choix.size} / 30</span>
          <input value={mot} onChange={e => setMot(e.target.value)} placeholder={t('mot déclencheur, ex. jzl4')} maxLength={16} aria-label={t('mot déclencheur')}
            style={{ padding: '6px 10px', borderRadius: 8, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit' }} />
          <select value={pas} onChange={e => setPas(Number(e.target.value))} aria-label={t('durée')} style={{ padding: '6px 8px', borderRadius: 8, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit' }}>
            <option value={800}>{t('rapide · 800 pas')}</option><option value={1500}>{t('normal · 1500 pas')}</option><option value={2500}>{t('fin · 2500 pas')}</option>
          </select>
          <button className="pill" disabled={choix.size < 8 || mot.trim().length < 3} onClick={() => void lancer()}>{t('Entraîner')}</button>
        </div>
        {msg && <span style={{ color: msg.ok ? 'var(--positif)' : 'var(--danger)' }}>{msg.txt}</span>}
      </>)}
    </div>
  )
}
