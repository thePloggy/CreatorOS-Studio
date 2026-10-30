/* ============================================================
   Reel en un clic (21/10) — un brief, et l'app réalise le reel : plans
   rédigés, photos, clips LTX, montage avec fondus et accroche, export.
   Le suivi vient du serveur (server/reel.js) ; ici on lance et on regarde.
   Le montage produit reste modifiable dans l'onglet Montage.
   ============================================================ */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { getLang, t, tServeur } from '../i18n'

interface PlanReel { still: string; motion: string; avertissements?: string[]; clipJob?: string | null; photoUri: string | null; clipUri: string | null; photoEtat: string | null; clipEtat: string | null; supprime?: boolean }
interface Reel {
  id: string; brief: string; etat: 'redaction' | 'photos' | 'clips' | 'export' | 'fini' | 'echec'
  n: number; accroche?: string; plans: PlanReel[]; montageId?: string; reelUri: string | null; erreur?: string | null; createdAt: number
}
interface MusiqueRow { nom: string; duree: number }

const EXEMPLES = [
  'Un dimanche matin à Paris : café en terrasse, balade sur les quais, librairie ancienne, lumière dorée',
  'Road trip au coucher du soleil dans le désert, vieille décapotable, vent dans les cheveux',
  'Séance de yoga au lever du soleil sur une terrasse en bois face à la mer',
  'Soirée cocktail sur un rooftop à New York, néons et lumières de la ville',
]
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

export function ReelView({ goMontage }: { goMontage: (montageId: string) => void }) {
  const s = useAppStore()
  const [brief, setBrief] = useState('')
  const [n, setN] = useState(5)
  const [duree, setDuree] = useState(4)
  const [musique, setMusique] = useState('')
  const [musiques, setMusiques] = useState<MusiqueRow[]>([])
  const [reels, setReels] = useState<Reel[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const charger = () => void fetch('/api/reels').then(json).then(d => setReels(d.reels ?? [])).catch(e => setErr(String(e.message)))
  useEffect(charger, [s.personaId])
  useEffect(() => { void fetch('/api/montage/musiques').then(json).then(d => setMusiques(d.musiques ?? [])).catch(() => {}) }, [])
  const enCours = reels.some(r => !['fini', 'echec'].includes(r.etat))
  useEffect(() => {
    if (!enCours) return
    const h = setInterval(charger, 3000)
    return () => clearInterval(h)
  }, [enCours])

  const lancer = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await json(await fetch('/api/reels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, n, duree, musique: musique || undefined, langue: getLang() }) }))
      setReels(x => [r, ...x]); setBrief('')
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 18 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{t('Reel en un clic')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('Décris la scène : {nom} est photographiée plan par plan, chaque plan est animé avec le son, puis le reel est monté avec fondus, accroche et musique.', { nom: s.personaName })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
          <textarea value={brief} onChange={e => setBrief(e.target.value)} maxLength={600} placeholder={t('Le lieu, l’ambiance, ce qui se passe…')}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && brief.trim()) void lancer() }}
            style={{ minHeight: 84, resize: 'vertical', padding: 12, borderRadius: 12, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 14 }} />
          <div className="flex gap-1.5 flex-wrap">
            {EXEMPLES.map(x => <button key={x} className="pill tool" style={{ fontSize: 11 }} onClick={() => setBrief(t(x))}>{t(x).split(':')[0].split(',')[0]}</button>)}
          </div>
          <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 12, color: 'var(--muted)' }}>
            <span>{t('Plans')}</span>
            {[3, 4, 5, 6].map(k => <button key={k} className={`wtab ${n === k ? 'on' : ''}`} onClick={() => setN(k)}>{k}</button>)}
            <span style={{ marginLeft: 10 }}>{t('Durée par plan')}</span>
            {[3, 4, 5].map(k => <button key={k} className={`wtab ${duree === k ? 'on' : ''}`} onClick={() => setDuree(k)}>{k} s</button>)}
            <span style={{ marginLeft: 10 }}>{t('Musique')}</span>
            <select value={musique} onChange={e => setMusique(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: 8, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12 }}>
              <option value="">{t('son des clips seulement')}</option>
              {musiques.map(m => <option key={m.nom} value={m.nom}>{m.nom}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button className="cta" style={{ padding: '10px 18px', flexDirection: 'row' }} disabled={busy || !brief.trim()} onClick={() => void lancer()}>
              {busy ? '…' : `✨ ${t('Réaliser le reel')}`}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)' }}>{t('Compter environ {m} min : rédaction, {n} photos, {n} clips LTX-2.5 avec le son, montage.', { m: 2 + n * 3, n })}</div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
        </div>

        {reels.filter(r => r.etat !== 'fini' || r.reelUri || r.plans.some(p => !p.supprime)).map(r => <CarteReel key={r.id} r={r} goMontage={goMontage}
          onRetirer={() => void fetch(`/api/reels/${r.id}`, { method: 'DELETE' }).then(json).then(() => setReels(x => x.filter(y => y.id !== r.id))).catch(e => setErr(String(e.message)))} />)}
        {!reels.length && <div style={{ fontSize: 12.5, color: 'var(--faint)', textAlign: 'center', padding: 20 }}>{t('Aucun reel pour ce personnage.')}</div>}
      </div>
    </div>
  )
}

const ETAPES: Reel['etat'][] = ['redaction', 'photos', 'clips', 'export', 'fini']
const NOM_ETAPE: Record<string, string> = { redaction: 'Rédaction', photos: 'Photos', clips: 'Clips', export: 'Montage', fini: 'Prêt' }

function CarteReel({ r, goMontage, onRetirer }: { r: Reel; goMontage: (id: string) => void; onRetirer: () => void }) {
  // refaire un seul plan (30/10) : sa photo reste, son clip est rendu à nouveau, le reel est remonté
  const [planRefait, setPlanRefait] = useState<number | null>(null)
  const [geste, setGeste] = useState('')
  const [errPlan, setErrPlan] = useState<string | null>(null)
  const refaire = async () => {
    if (planRefait === null) return
    setErrPlan(null)
    try {
      await json(await fetch(`/api/reels/${encodeURIComponent(r.id)}/plans/${planRefait}/refaire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motion: geste }) }))
      setPlanRefait(null)
    } catch (e) { setErrPlan(String((e as Error).message)) }
  }
  const idx = r.etat === 'echec' ? -1 : ETAPES.indexOf(r.etat)
  const photos = r.plans.filter(p => p.photoUri).length, clips = r.plans.filter(p => p.clipUri).length
  const detail = (e: Reel['etat']) => e === 'photos' ? ` ${photos}/${r.plans.length || r.n}` : e === 'clips' ? ` ${clips}/${r.plans.length || r.n}` : ''
  return (
    <div className="carte-reel" style={{ display: 'grid', gridTemplateColumns: r.reelUri ? 'minmax(0, 1fr) 260px' : 'minmax(0, 1fr)', gap: 16, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
      <div style={{ display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.accroche ? `« ${r.accroche} »` : r.brief}</div>
        {r.accroche && <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{r.brief}</div>}
        <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: 11 }}>
          {ETAPES.map((e, k) => (
            <span key={e} style={{ padding: '3px 9px', borderRadius: 999, background: k < idx || r.etat === 'fini' ? 'var(--lv3)' : k === idx ? 'var(--accent)' : 'var(--lv2)',
              color: k === idx && r.etat !== 'fini' ? '#fff' : k <= idx ? 'var(--text)' : 'var(--faint)' }}>
              {k < idx || r.etat === 'fini' ? '✓ ' : ''}{t(NOM_ETAPE[e])}{k === idx ? detail(e) : ''}
            </span>
          ))}
          {r.etat === 'echec' && <span style={{ color: 'var(--danger)' }}>{t('échec')} — {tServeur(r.erreur ?? '')}</span>}
        </div>
        <div className="flex gap-2" style={{ overflowX: 'auto' }}>
          {(r.plans.length ? r.plans : Array.from({ length: r.n }, () => null)).map((p, i) => p?.supprime ? null : (
            <div key={i} title={p?.still ?? ''} style={{ width: 86, flex: 'none', aspectRatio: '9 / 16', borderRadius: 10, overflow: 'hidden', background: 'var(--lv2)', position: 'relative' }}>
              {p?.clipUri ? <video src={p.clipUri} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : p?.photoUri ? <img src={p.photoUri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: .8 }} />
                : <div className="flex items-center justify-center" style={{ height: '100%', fontSize: 10, color: 'var(--faint)' }}>{t('plan {n}', { n: i + 1 })}</div>}
              {p && !p.clipUri && (p.photoEtat === 'rendering' || p.clipEtat === 'rendering' || p.clipEtat === 'queued-comfy') &&
                <span style={{ position: 'absolute', left: 4, bottom: 4, fontSize: 9, padding: '1px 5px', borderRadius: 5, background: 'rgba(0,0,0,.7)' }}>{p.clipJob ? t('anime…') : t('photo…')}</span>}
              {/* contrôle du plan avant le rendu : ce que la réécriture n'a pas su corriger */}
              {p?.avertissements?.length ? <span title={p.avertissements.map(x => t(x)).join(' · ')}
                style={{ position: 'absolute', right: 4, top: 4, fontSize: 10, padding: '1px 5px', borderRadius: 5, background: 'rgba(255,182,72,.9)', color: '#111' }}>⚠</span> : null}
              {p && (r.etat === 'fini' || r.etat === 'echec') && <button title={t('Refaire ce plan')} onClick={() => { setPlanRefait(i); setGeste(p.motion) }}
                style={{ position: 'absolute', left: 4, top: 4, fontSize: 11, width: 22, height: 22, border: 0, borderRadius: 6, cursor: 'pointer', color: '#fff', background: 'rgba(0,0,0,.65)' }}>↻</button>}
            </div>
          ))}
        </div>
        {planRefait !== null && (
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Plan {n} : le mouvement à refaire, les autres plans ne bougent pas', { n: planRefait + 1 })}</span>
            <textarea value={geste} maxLength={300} rows={2} onChange={e => setGeste(e.target.value)}
              style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12.5 }} />
            <div className="flex gap-2 items-center">
              <button className="pill tool" onClick={() => void refaire()}>↻ {t('Refaire ce plan')}</button>
              <button className="pill tool" onClick={() => setPlanRefait(null)}>{t('Annuler')}</button>
              {errPlan && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{errPlan}</span>}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          {r.montageId && <button className="pill tool" onClick={() => goMontage(r.montageId!)}>{t('Ouvrir dans le Montage')}</button>}
          {(r.etat === 'fini' || r.etat === 'echec') && <button className="pill tool" title={t('Les photos et clips restent dans la bibliothèque')} onClick={onRetirer}>✕ {t('Retirer de la liste')}</button>}
        </div>
      </div>
      {r.reelUri && (
        <div style={{ display: 'grid', gap: 8 }}>
          <video src={r.reelUri} controls playsInline style={{ width: '100%', aspectRatio: '9 / 16', borderRadius: 12, background: '#000' }} />
          <a className="pill tool" style={{ justifyContent: 'center' }} href={r.reelUri} download={`reel-${r.id}.mp4`}>{t('Télécharger')}</a>
        </div>
      )}
    </div>
  )
}
