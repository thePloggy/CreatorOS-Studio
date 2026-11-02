/* Créer un personnage de zéro : des traits, 4 portraits, un choix ; le studio en fait un
   personnage avec sa planche de référence, 12 images et, si demandé, sa LoRA Klein. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'

const champ = { padding: '7px 10px', borderRadius: 8, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit' } as const

export function CreerPersonnage() {
  const edition = useEdition()
  const s = useAppStore()
  const [traits, setTraits] = useState({ genre: 'woman', age: 28, origine: '', cheveux: '', yeux: '', style: '', signes: '' })
  const [jobs, setJobs] = useState<string[]>([])
  const [choisi, setChoisi] = useState<string | null>(null)
  const [nom, setNom] = useState('')
  const [entrainer, setEntrainer] = useState(true)
  const [suivi, setSuivi] = useState<{ id: string; planche: string | null; images: string; entrainementEtat: string | null } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const portraits = useMemo(() => s.assets.filter(a => a.jobId && jobs.includes(a.jobId) && a.mediaType === 'photo'), [s.assets, jobs])
  useEffect(() => {
    if (!suivi || suivi.entrainementEtat === 'done') return
    const h = setInterval(() => void fetch(`/api/personnages/creer/${suivi.id}`).then(r => r.json()).then(setSuivi).catch(() => {}), 4000)
    return () => clearInterval(h)
  }, [suivi])
  if (!edition) return null
  const maj = (k: keyof typeof traits, v: string | number) => setTraits(x => ({ ...x, [k]: v }))
  const poster = async (url: string, corps: object) => {
    setMsg(null)
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return null }
    return d
  }
  const proposer = async () => {
    const d = await poster('/api/personnages/propositions', { traits })
    if (d) { setJobs(d.jobs); setChoisi(null); for (const j of d.jobs) void s.adoptServerJob(j) }
  }
  const creer = async () => {
    const d = await poster('/api/personnages/creer', { assetId: choisi, nom, traits, entrainer })
    if (d) { setSuivi(d); await s.refreshPersona() }
  }
  return (
    <div className="border border-border rounded-card bg-surface2 p-4 mb-4" style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      <b>{t('Créer un personnage')}</b>
      <span style={{ color: 'var(--muted)' }}>{t('Décris-le : le studio propose 4 visages, tu choisis, il crée le personnage, sa planche de référence, 12 images et sa LoRA.')}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        <select value={traits.genre} onChange={e => maj('genre', e.target.value)} style={champ} aria-label={t('genre')}>
          <option value="woman">{t('femme')}</option><option value="man">{t('homme')}</option><option value="person">{t('personne')}</option>
        </select>
        <label className="flex gap-2 items-center" style={{ color: 'var(--muted)' }}>{t('âge')}<input type="number" min={21} max={80} value={traits.age} onChange={e => maj('age', Number(e.target.value))} style={{ ...champ, width: 70 }} /></label>
        <input value={traits.origine} onChange={e => maj('origine', e.target.value)} placeholder={t('origine, en anglais')} style={champ} maxLength={40} />
        <input value={traits.cheveux} onChange={e => maj('cheveux', e.target.value)} placeholder={t('cheveux : long auburn wavy')} style={champ} maxLength={50} />
        <input value={traits.yeux} onChange={e => maj('yeux', e.target.value)} placeholder={t('yeux : green')} style={champ} maxLength={30} />
        <input value={traits.style} onChange={e => maj('style', e.target.value)} placeholder={t('style : minimalist streetwear')} style={champ} maxLength={80} />
        <input value={traits.signes} onChange={e => maj('signes', e.target.value)} placeholder={t('signes : freckles, small nose ring')} style={{ ...champ, gridColumn: 'span 2' }} maxLength={120} />
      </div>
      <button className="pill" style={{ justifySelf: 'start' }} onClick={() => void proposer()}>{t('4 propositions')}</button>
      {jobs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          {jobs.map(j => { const a = portraits.find(x => x.jobId === j); return (
            <button key={j} disabled={!a} onClick={() => a && setChoisi(a.id)} aria-pressed={!!a && choisi === a.id} aria-label={t('choisir ce visage')}
              style={{ aspectRatio: '1', padding: 0, borderRadius: 10, overflow: 'hidden', cursor: a ? 'pointer' : 'wait', background: 'var(--lv1)', border: a && choisi === a.id ? '3px solid var(--accent)' : '3px solid transparent' }}>
              {a ? <img src={a.uri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: 'var(--muted)' }}>…</span>}
            </button>) })}
        </div>
      )}
      {choisi && (
        <div className="flex gap-2 items-center flex-wrap">
          <input value={nom} onChange={e => setNom(e.target.value)} placeholder={t('nom du personnage')} style={champ} maxLength={40} />
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={entrainer} onChange={e => setEntrainer(e.target.checked)} /> {t('entraîner sa LoRA (~35 min)')}</label>
          <button className="pill" disabled={nom.trim().length < 2} onClick={() => void creer()}>{t('Créer le personnage')}</button>
        </div>
      )}
      {suivi && <span>{t('Planche : {p} · images : {i}', { p: suivi.planche ?? '…', i: suivi.images })}{suivi.entrainementEtat ? ` · ${t('LoRA : {e}', { e: suivi.entrainementEtat })}` : ''}</span>}
      {msg && <span style={{ color: 'var(--danger)' }}>{msg}</span>}
    </div>
  )
}
