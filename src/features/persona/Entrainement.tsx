/* Entraîner le personnage : une LoRA par moteur coché (FLUX.2 Klein, Krea 2), apprise sur ses images de la bibliothèque.
   Réservé au propriétaire du studio ; le GPU y est occupé une demi-heure environ par moteur. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'

type Moteur = { id: string; nom: string; pret: boolean; secParPas: number; preparationS: number }
export const dureeMin = (m: Moteur, pas: number) => Math.round((pas * m.secParPas + m.preparationS) / 60)
type Travail = { id: string; personaId: string | null; statut: string; moteur?: string; declencheur: string | null; images: number | null; pas: number | null; total: number | null
  debut: number | null; fin: number | null; resteMs: number; erreur: string | null; lora: string | null }
const EN_COURS = ['queued', 'rendering', 'running', 'pending']

/** Les entraînements du personnage : en file, en cours (pas faits, temps restant), finis (LoRA ajoutée) ou en échec. */
function SuiviEntrainements({ travaux, onAnnuler, moteurs }: { travaux: Travail[]; onAnnuler: (id: string) => void; moteurs: Moteur[] }) {
  if (!travaux.length) return null
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {travaux.map(w => {
        const enCours = EN_COURS.includes(w.statut)
        const pc = w.pas != null && w.total ? Math.min(100, Math.round(w.pas / w.total * 100)) : null
        return (
          <div key={w.id} style={{ display: 'grid', gap: 5, padding: enCours ? '10px 12px' : '7px 12px', borderRadius: 10, background: 'rgba(127,127,127,0.10)' }} title={w.lora ?? undefined}>
            <div className="flex gap-2 items-center flex-wrap">
              <b>{moteurs.find(m => m.id === (w.moteur ?? 'klein'))?.nom ?? w.moteur} · {w.declencheur ?? w.id}</b>
              <span className="texte-doux">{w.images ? t('{n} images', { n: w.images }) : ''}{w.total ? ` · ${t('{n} pas', { n: w.total })}` : ''}</span>
              <span style={{ marginLeft: 'auto', color: w.statut === 'done' ? 'var(--positif)' : enCours ? 'var(--muted)' : 'var(--danger)' }}>
                {w.statut === 'done' ? t('terminé') : w.statut === 'queued' ? t('en file') : enCours ? (pc != null ? `${pc} %` : t('préparation…')) : /^annulé/.test(w.erreur ?? '') ? t('annulé') : t('échec')}
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
            {enCours && <button className="pill" style={{ justifySelf: 'start', fontSize: 12 }} onClick={() => onAnnuler(w.id)}>■ {t('Annuler l’entraînement')}</button>}
            {w.erreur && !enCours && w.statut !== 'done' && !/^annulé/.test(w.erreur) && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{tServeur(w.erreur) ?? w.erreur}</span>}
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
  const [moteurs, setMoteurs] = useState<Moteur[]>([])
  const [coches, setCoches] = useState<Set<string>>(new Set(['klein']))
  const charger = () => fetch('/api/entrainement').then(r => r.json()).then(d => { setPret(!!d.pret); setTravaux(d.travaux ?? []); setMoteurs(d.moteurs ?? []) })
  const annuler = async (id: string) => {
    if (!confirmerAnnulation(id)) return
    await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    void charger().catch(() => {})
  }
  const [aConfirmer, setAConfirmer] = useState<string | null>(null)
  const confirmerAnnulation = (id: string) => { if (aConfirmer === id) { setAConfirmer(null); return true } setAConfirmer(id); setTimeout(() => setAConfirmer(x => (x === id ? null : x)), 4000); return false }
  const cochables = moteurs.filter(m => m.pret)
  const totalMin = cochables.filter(m => coches.has(m.id)).reduce((n, m) => n + dureeMin(m, pas), 0)
  useEffect(() => { void charger().catch(() => setPret(false)) }, [])
  const miens = useMemo(() => travaux.filter(w => w.personaId === s.personaId).slice(0, 3), [travaux, s.personaId])
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
      body: JSON.stringify({ assets: [...choix], declencheur: mot, pas, moteurs: [...coches].filter(id => cochables.some(m => m.id === id)) }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg({ ok: false, txt: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
    await s.adoptServerJob(d.jobId)
    void charger().catch(() => {})
    for (const j of (d.jobIds ?? []).slice(1)) await s.adoptServerJob(j)
    setMsg({ ok: true, txt: t('Entraînement lancé : la LoRA s’ajoute au personnage à la fin (~{m} min).', { m: totalMin }) })
  }
  return (
    <div className="border border-border rounded-card bg-surface2 p-4" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
      <b>{t('Entraîner ce personnage')} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {t('une LoRA par moteur coché')} · ai-toolkit</span></b>
      {!edition ? <span className="texte-doux">{t('Réservé au propriétaire du studio.')}</span>
        : pret === false ? <span className="texte-doux">{t('ai-toolkit n’est pas installé sur ce studio.')}</span> : (<>
        <SuiviEntrainements travaux={miens} moteurs={moteurs} onAnnuler={id => void annuler(id)} />
        {aConfirmer && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{t('Clique encore sur Annuler pour arrêter cet entraînement (le travail fait est perdu).')}</span>}
        {/* réglages et lancement d'abord, au-dessus du choix des images */}
        <div className="entrainement-reglages">
          <div className="flex gap-3 items-center flex-wrap">
            <span className="texte-doux">{t('LoRA pour')}</span>
            {moteurs.map(m => (
              <label key={m.id} className="flex gap-1.5 items-center" style={{ cursor: m.pret ? 'pointer' : 'not-allowed', opacity: m.pret ? 1 : 0.45 }}
                title={m.pret ? t('~{m} min avec ces réglages', { m: dureeMin(m, pas) }) : t('modèle de base absent sur ce studio')}>
                <input type="checkbox" disabled={!m.pret} checked={m.pret && coches.has(m.id)}
                  onChange={e => setCoches(c => { const n = new Set(c); if (e.target.checked) n.add(m.id); else n.delete(m.id); return n })} />
                {m.nom} <span className="texte-doux">~{dureeMin(m, pas)} min</span>
              </label>
            ))}
            <label className="flex gap-1.5 items-center" style={{ opacity: 0.45, cursor: 'not-allowed' }} title={t('MOSS n’accepte pas de LoRA')}><input type="checkbox" disabled /> MOSS Image</label>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input value={mot} onChange={e => setMot(e.target.value)} placeholder={t('mot déclencheur, ex. jzl4')} maxLength={16} aria-label={t('mot déclencheur')}
              className="champ" />
            <select value={pas} onChange={e => setPas(Number(e.target.value))} aria-label={t('durée')} className="champ">
              <option value={800}>{t('rapide · 800 pas')}</option><option value={1500}>{t('normal · 1500 pas')}</option><option value={2500}>{t('fin · 2500 pas')}</option>
            </select>
            <button className="pill" disabled={choix.size < 8 || mot.trim().length < 3 || totalMin === 0} onClick={() => void lancer()}>{t('Entraîner')}{totalMin ? ` · ~${totalMin} min` : ''}</button>
            <span style={{ marginLeft: 'auto', fontWeight: 600, color: choix.size >= 8 ? 'var(--positif)' : 'var(--muted)' }}>{t('{n} / 30 images', { n: choix.size })}</span>
          </div>
          {msg && <span style={{ color: msg.ok ? 'var(--positif)' : 'var(--danger)' }}>{msg.txt}</span>}
        </div>
        <span className="texte-doux">{t('Choisis 8 à 30 images du personnage, variées (angles, lumières, tenues) : son visage sera appris et tenu sur les moteurs cochés.')}</span>
        {/* images entières, sans recadrage : on juge le visage et la tenue */}
        <div className="entrainement-images">
          {photos.map(a => (
            <button key={a.id} onClick={() => basculer(a.id)} aria-pressed={choix.has(a.id)} aria-label={t('sélectionner')} className={choix.has(a.id) ? 'choisie' : ''}>
              <img src={a.uri} alt="" loading="lazy" />
              {choix.has(a.id) && <i>✓</i>}
            </button>
          ))}
        </div>
      </>)}
    </div>
  )
}
