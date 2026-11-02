/* Musique et bruitages générés : ACE-Step 1.5 sur la carte, le morceau rejoint la liste des musiques. */
import { useState } from 'react'
import { t, tServeur } from '../i18n'

export function GenererMusique({ surPret }: { surPret: () => void }) {
  const [genre, setGenre] = useState<'musique' | 'bruitage'>('musique')
  const [prompt, setPrompt] = useState('')
  const [paroles, setParoles] = useState('')
  const [secondes, setSecondes] = useState(30)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState('')
  const lancer = async () => {
    setOccupe(true); setMsg('')
    const r = await fetch('/api/musique', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, paroles, secondes: genre === 'bruitage' ? Math.min(secondes, 20) : secondes, genre }) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); setOccupe(false); return }
    const attendre = async (): Promise<void> => {
      const j = await (await fetch(`/api/jobs/${encodeURIComponent(d.jobId!)}`)).json().catch(() => ({})) as { status?: string; error?: string }
      if (j.status === 'done') { surPret(); setMsg(t('Prêt, choisis-le dans la liste.')); setOccupe(false); return }
      if (j.status === 'blocked') { setMsg(tServeur(j.error) ?? t('échec')); setOccupe(false); return }
      await new Promise(p => setTimeout(p, 1500)); return attendre()
    }
    await attendre()
  }
  const champ = { padding: 7, borderRadius: 9, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12, width: '100%' }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        {(['musique', 'bruitage'] as const).map(g => <button key={g} className="pill tool" style={genre === g ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setGenre(g)}>{t(g === 'musique' ? 'Générer une musique' : 'Générer un bruitage')}</button>)}
      </div>
      <textarea rows={2} style={champ} value={prompt} maxLength={400} onChange={e => setPrompt(e.target.value)}
        placeholder={t(genre === 'musique' ? 'Style, instruments, ambiance : warm lo-fi, soft piano…' : 'Le son : a heavy wooden door creaking open…')} />
      {genre === 'musique' && <textarea rows={2} style={champ} value={paroles} maxLength={2000} onChange={e => setParoles(e.target.value)} placeholder={t('Paroles (facultatif) : vide = instrumental')} />}
      <label className="flex items-center gap-2" style={{ color: 'var(--muted)', fontSize: 11 }}>{secondes} s
        <input type="range" className="flex-1" min={genre === 'bruitage' ? 2 : 5} max={genre === 'bruitage' ? 20 : 120} value={Math.min(secondes, genre === 'bruitage' ? 20 : 120)} onChange={e => setSecondes(Number(e.target.value))} /></label>
      <button className="pill tool" style={{ justifyContent: 'center' }} disabled={occupe || !prompt.trim()} onClick={() => void lancer()}>{occupe ? t('génération…') : t('Générer')}</button>
      {msg && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{msg}</div>}
    </div>
  )
}
