/* Entraîner le personnage : une LoRA FLUX.2 Klein apprise sur ses images de la bibliothèque.
   Réservé au propriétaire du studio ; le GPU y est occupé une quarantaine de minutes. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'

type Travail = { id: string; personaId: string | null; statut: string; declencheur: string | null; images: number | null; pas: number | null; total: number | null
  debut: number | null; fin: number | null; resteMs: number; erreur: string | null; lora: string | null }
const EN_COURS = ['queued', 'rendering', 'running', 'pending']

/** Les entraînements du personnage : en file, en cours (pas faits, temps restant), finis (LoRA ajoutée) ou en échec. */
function SuiviEntrainements({ travaux }: { travaux: Travail[] }) {
  if (!travaux.length) return null
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {travaux.map(w => {
        const enCours = EN_COURS.includes(w.statut)
        const pc = w.pas != null && w.total ? Math.min(100, Math.round(w.pas / w.total * 100)) : null
        return (
          <div key={w.id} style={{ display: 'grid', gap: 5, padding: '10px 12px', borderRadius: 10, background: 'rgba(127,127,127,0.10)' }}>
            <div className="flex gap-2 items-center flex-wrap">
              <b>{w.declencheur ?? w.id}</b>
              <span className="texte-doux">{w.images ? t('{n} images', { n: w.images }) : ''}{w.total ? ` · ${t('{n} pas', { n: w.total })}` : ''}</span>
              <span style={{ marginLeft: 'auto', color: w.statut === 'done' ? 'var(--positif)' : enCours ? 'var(--muted)' : 'var(--danger)' }}>
                {w.statut === 'done' ? t('terminé') : w.statut === 'queued' ? t('en file') : enCours ? (pc != null ? `${pc} %` : t('préparation…')) : t('échec')}
              </span>
            </div>
            {enCours && (
              <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pc ?? 0} aria-label={t('avancement de l’entraînement')}
                style={{ height: 6, borderRadius: 99, background: 'rgba(127,127,127,0.22)', overflow: 'hidden' }}>
                <div style={{ width: `${pc ?? 2}%`, height: '100%', background: 'var(--accent)', transition: 'width .6s ease' }} />
              </div>
            )}
            {enCours && <span className="texte-doux" style={{ fontSize: 12 }}>
              {w.pas != null && w.total ? t('pas {n} / {t}', { n: w.pas, t: w.total }) + ' · ' : ''}{w.resteMs > 0 ? t('encore ~{m} min', { m: Math.max(1, Math.round(w.resteMs / 60000)) }) : ''}
            </span>}
            {w.statut === 'done' && w.lora && <span className="texte-doux" style={{ fontSize: 12 }}>{t('LoRA ajoutée au personnage : {nom}', { nom: w.lora })}</span>}
            {w.erreur && !enCours && w.statut !== 'done' && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{tServeur(w.erreur) ?? w.erreur}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function Entrainement() {
  const edition = useEdition()
  const s = useAppStore()
  const [pret, setPret] = useState<boolean | null>(null)
  const [choix, setChoix] = useState<Set<string>>(new Set())
  const [mot, setMot] = useState('')
  const [pas, setPas] = useState(1500)
  const [msg, setMsg] = useState<{ ok: boolean; txt: string } | null>(null)
  const [travaux, setTravaux] = useState<Travail[]>([])
  const charger = () => fetch('/api/entrainement').then(r => r.json()).then(d => { setPret(!!d.pret); setTravaux(d.travaux ?? []) })
  useEffect(() => { void charger().catch(() => setPret(false)) }, [])
  const miens = useMemo(() => travaux.filter(w => w.personaId === s.personaId).slice(0, 4), [travaux, s.personaId])
  const actif = miens.some(w => EN_COURS.includes(w.statut))
  useEffect(() => {
    if (!actif) return
    const h = setInterval(() => void charger().catch(() => {}), 5000)
    return () => clearInterval(h)
  }, [actif])
  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.personaId === s.personaId && a.reviewStatus !== 'rejected').slice(0, 60), [s.assets, s.personaId])
  const basculer = (id: string) => setChoix(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else if (n.size < 30) n.add(id); return n })
  const lancer = async () => {
    setMsg(null)
    const r = await fetch(`/api/personas/${encodeURIComponent(s.personaId ?? '')}/entrainer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets: [...choix], declencheur: mot, pas }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg({ ok: false, txt: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
    await s.adoptServerJob(d.jobId)
    void charger().catch(() => {})
    setMsg({ ok: true, txt: t('Entraînement lancé : la LoRA s’ajoute au personnage à la fin (~{m} min).', { m: Math.round(pas * 1.6 / 60 + 3) }) })
  }
  return (
    <div className="border border-border rounded-card bg-surface2 p-4 mb-4" style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      <b>{t('Entraîner ce personnage')} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· LoRA FLUX.2 Klein · ai-toolkit</span></b>
      {!edition ? <span className="texte-doux">{t('Réservé au propriétaire du studio.')}</span>
        : pret === false ? <span className="texte-doux">{t('ai-toolkit n’est pas installé sur ce studio.')}</span> : (<>
        <SuiviEntrainements travaux={miens} />
        <span className="texte-doux">{t('Choisis 8 à 30 images du personnage, variées (angles, lumières, tenues) : son visage sera appris et tenu sur Klein.')}</span>
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
            className="champ" />
          <select value={pas} onChange={e => setPas(Number(e.target.value))} aria-label={t('durée')} className="champ">
            <option value={800}>{t('rapide · 800 pas')}</option><option value={1500}>{t('normal · 1500 pas')}</option><option value={2500}>{t('fin · 2500 pas')}</option>
          </select>
          <button className="pill" disabled={choix.size < 8 || mot.trim().length < 3} onClick={() => void lancer()}>{t('Entraîner')}</button>
        </div>
        {msg && <span style={{ color: msg.ok ? 'var(--positif)' : 'var(--danger)' }}>{msg.txt}</span>}
      </>)}
    </div>
  )
}
