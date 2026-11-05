/* ============================================================
   Reel en un clic — un brief, et l'app réalise le reel : plans
   rédigés, photos, clips LTX, montage avec fondus et accroche, export.
   Le suivi vient du serveur (server/reel.js) ; ici on lance et on regarde.
   Le montage produit reste modifiable dans l'onglet Montage.
   ============================================================ */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { getLang, t, tServeur } from '../i18n'
import { ChoixPersonnage } from './ChoixPersonnage'
import { ChoixVoix } from './ChoixVoix'
import { useEdition } from '../lib/proprietaire'
import { Ecouter, urlEchantillonVoix, urlMusique } from './Ecouter'

interface PlanReel { still: string; motion: string; avertissements?: string[]; clipJob?: string | null; photoUri: string | null; clipUri: string | null; photoEtat: string | null; clipEtat: string | null; supprime?: boolean }
interface Reel {
  id: string; brief: string; etat: 'redaction' | 'photos' | 'clips' | 'export' | 'fini' | 'echec'
  n: number; accroche?: string; plans: PlanReel[]; montageId?: string; reelUri: string | null; erreur?: string | null; createdAt: number
}
interface MusiqueRow { nom: string; duree: number }
interface PresetReel { id: string; nom: string; texte: string; exemple: string }

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
  // par défaut, la voix enregistrée sur la fiche du personnage
  const [voixOff, setVoixOff] = useState(() => (useAppStore.getState().personaVoix ? 'perso' : ''))
  const [caler, setCaler] = useState(true)
  const [musiques, setMusiques] = useState<MusiqueRow[]>([])
  /* Nouveau morceau depuis le reel : ACE-Step le compose à la durée du reel, puis il est choisi. */
  const [nouvelle, setNouvelle] = useState<{ prompt: string; job: string | null; msg: string } | null>(null)
  const genererMorceau = async () => {
    if (!nouvelle?.prompt.trim()) return
    const r = await fetch('/api/musique', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: nouvelle.prompt, paroles: '', secondes: n * duree + 2, genre: 'musique' }) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) { setNouvelle(x => x && { ...x, msg: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
    setNouvelle(x => x && { ...x, job: d.jobId!, msg: '' })
    void s.adoptServerJob(d.jobId)
    const avant = new Set(musiques.map(m => m.nom))
    for (let k = 0; k < 120; k++) {
      await new Promise(p => setTimeout(p, 2000))
      const j = await fetch(`/api/jobs/${encodeURIComponent(d.jobId)}`).then(json).catch(() => null) as { job?: { status?: string; error?: string } } | null
      const st = j?.job?.status
      if (st === 'done') {
        const liste = await fetch('/api/montage/musiques').then(json).then((x: { musiques?: MusiqueRow[] }) => x.musiques ?? []).catch(() => [] as MusiqueRow[])
        setMusiques(liste)
        const neuf = liste.find(m => !avant.has(m.nom))
        if (neuf) setMusique(neuf.nom)
        setNouvelle(null); return
      }
      if (st === 'blocked' || st === 'failed') { setNouvelle(x => x && { ...x, job: null, msg: tServeur(j?.job?.error) ?? t('échec') }); return }
    }
  }
  const [reels, setReels] = useState<Reel[]>([])
  // un preset (saut de tenues, GRWM…) : la structure du reel est tenue par le studio, le brief remplit les cases
  const [presets, setPresets] = useState<PresetReel[]>([])
  const [preset, setPreset] = useState<string>('')
  useEffect(() => { void fetch('/api/reels/presets').then(json).then(d => setPresets(d.presets ?? [])).catch(() => {}) }, [])
  const choisi = presets.find(p => p.id === preset)
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
        body: JSON.stringify(preset ? { preset, brief, langue: getLang() } : { brief, n, duree, musique: musique || undefined, voix: voixOff || undefined, calerMusique: !!musique && caler, langue: getLang() }) }))
      setReels(x => [r, ...x]); setBrief('')
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 18 }}>
        <div>
          <h2 className="titre-outil">{t('Reel en un clic')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('Décris la scène : {nom} est photographiée plan par plan, chaque plan est animé avec le son, puis le reel est monté avec fondus, accroche et musique.', { nom: s.personaName })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
          <ChoixPersonnage />
          {presets.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Format')}</span>
            {/* un format tenu par le studio : son aperçu tourne en boucle, muet */}
            <div className="flex gap-2" style={{ overflowX: 'auto', paddingBottom: 4 }}>
              <button onClick={() => setPreset('')} style={{ flex: '0 0 96px', height: 170, borderRadius: 12, border: `2px solid ${!preset ? 'var(--accent)' : 'var(--lv3)'}`, background: 'var(--lv2)', color: 'var(--text)', fontSize: 12, padding: 8, cursor: 'pointer' }}>
                <b style={{ display: 'block', marginBottom: 4 }}>{t('Libre')}</b><span style={{ color: 'var(--muted)', fontSize: 11 }}>{t('Ton brief, ta structure')}</span>
              </button>
              {presets.filter(p => p.id !== 'journee').map(p => (
                <button key={p.id} onClick={() => setPreset(p.id)} title={t(p.texte)}
                  style={{ flex: '0 0 96px', height: 170, borderRadius: 12, border: `2px solid ${preset === p.id ? 'var(--accent)' : 'var(--lv3)'}`, background: '#000', padding: 0, overflow: 'hidden', position: 'relative', cursor: 'pointer' }}>
                  <video src={`/vitrine/reels/${p.id}.mp4`} poster={`/vitrine/reels/${p.id}.webp`} muted loop playsInline autoPlay preload="metadata"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <b style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px 6px 6px', fontSize: 11.5, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.75))', textAlign: 'left' }}>{t(p.nom)}</b>
                </button>
              ))}
            </div>
          </div>}
          {choisi && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t(choisi.texte)}</div>}
          <textarea value={brief} onChange={e => setBrief(e.target.value)} maxLength={600} placeholder={choisi ? t(choisi.exemple) : t('Le lieu, l’ambiance, ce qui se passe…')}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && brief.trim()) void lancer() }}
            style={{ minHeight: 84, resize: 'vertical', padding: 12, borderRadius: 12, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 14 }} />
          {!preset && <div className="flex gap-1.5 flex-wrap">
            {EXEMPLES.map(x => <button key={x} className="pill tool" style={{ fontSize: 12 }} onClick={() => setBrief(t(x))}>{t(x).split(':')[0].split(',')[0]}</button>)}
          </div>}
          {!preset && <div className="flex items-center gap-3 flex-wrap" style={{ fontSize: 12, color: 'var(--muted)' }}>
            <span>{t('Plans')}</span>
            {[3, 4, 5, 6].map(k => <button key={k} className={`wtab ${n === k ? 'on' : ''}`} onClick={() => setN(k)}>{k}</button>)}
            <span style={{ marginLeft: 10 }}>{t('Durée par plan')}</span>
            {[3, 4, 5].map(k => <button key={k} className={`wtab ${duree === k ? 'on' : ''}`} onClick={() => setDuree(k)}>{k} s</button>)}
            {/* chaque réglage reste groupé avec son étiquette : un retour à la ligne ne les sépare plus */}
            <span className="reel-reglage">
              <span>{t('Musique')}</span>
              <select value={musique} onChange={e => setMusique(e.target.value)} className="champ" style={{ fontSize: 12 }} aria-label={t('Musique')}>
                <option value="">{t('son des clips seulement')}</option>
                {musiques.map(m => <option key={m.nom} value={m.nom}>{m.nom}</option>)}
              </select>
              <Ecouter src={urlMusique(musique)} titre={t('Écouter la musique')} />
              <button className="pill tool" style={{ fontSize: 12 }} disabled={!!nouvelle?.job} onClick={() => setNouvelle(x => x ? null : { prompt: '', job: null, msg: '' })}>
                {nouvelle?.job ? t('morceau en cours…') : `＋ ${t('Nouveau morceau')}`}</button>
              {musique && <label className="flex gap-1.5 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={caler} onChange={e => setCaler(e.target.checked)} /> {t('couper sur le rythme')}</label>}
            </span>
            <span className="reel-reglage">
              <span>{t('Voix off')}</span>
              <ChoixVoix valeur={voixOff} onChange={setVoixOff} vide={t('aucune')} ariaLabel={t('Voix off')} />
              {voixOff && !voixOff.startsWith('clone:') && voixOff !== 'perso' && <Ecouter src={urlEchantillonVoix(voixOff)} titre={t('Écouter la voix')} />}
            </span>
            {nouvelle && !nouvelle.job && <span className="reel-reglage" style={{ flexBasis: '100%' }}>
              <input className="champ" style={{ flex: 1, fontSize: 12 }} value={nouvelle.prompt} autoFocus maxLength={300}
                placeholder={t('Le style du morceau, ex. sunny acoustic guitar and light percussion, upbeat, 100 bpm')}
                onChange={e => setNouvelle(x => x && { ...x, prompt: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && nouvelle.prompt.trim()) void genererMorceau() }} />
              <button className="pill" disabled={!nouvelle.prompt.trim()} onClick={() => void genererMorceau()}>{t('Générer')} · {n * duree + 2} s</button>
              {nouvelle.msg && <span className="texte-erreur">{nouvelle.msg}</span>}
            </span>}
          </div>}
          <div className="flex items-center gap-3">
            <span style={{ flex: 1, fontSize: 12, color: 'var(--faint)' }}>{preset
              ? t('Compter environ 25 min : le format est tenu par le studio, les images puis les clips, montage.')
              : t('Compter environ {m} min : rédaction, {n} photos, {n} clips LTX-2.5 avec le son, montage.', { m: 2 + n * 3, n })}</span>
            <button className="cta" style={{ padding: '10px 18px', flexDirection: 'row' }} disabled={busy || (!brief.trim() && !preset)} onClick={() => void lancer()}>
              {busy ? '…' : `✨ ${t('Réaliser le reel')}`}
            </button>
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
        </div>

        {reels.filter(r => r.etat !== 'fini' || r.reelUri || r.plans.some(p => !p.supprime)).map(r => <CarteReel key={r.id} r={r} goMontage={goMontage}
          onRetirer={() => void fetch(`/api/reels/${r.id}`, { method: 'DELETE' }).then(json).then(() => setReels(x => x.filter(y => y.id !== r.id))).catch(e => setErr(String(e.message)))}
          onAnnuler={() => void fetch(`/api/reels/${r.id}/annuler`, { method: 'POST' }).then(json).then((n: Reel) => setReels(x => x.map(y => y.id === r.id ? n : y))).catch(e => setErr(String(e.message)))} />)}
        {!reels.length && <div style={{ fontSize: 12.5, color: 'var(--faint)', textAlign: 'center', padding: 20 }}>{t('Aucun reel pour ce personnage.')}</div>}
      </div>
    </div>
  )
}

const ETAPES: Reel['etat'][] = ['redaction', 'photos', 'clips', 'export', 'fini']
const NOM_ETAPE: Record<string, string> = { redaction: 'Rédaction', photos: 'Photos', clips: 'Clips', export: 'Montage', fini: 'Prêt' }

function CarteReel({ r, goMontage, onRetirer, onAnnuler }: { r: Reel; goMontage: (id: string) => void; onRetirer: () => void; onAnnuler: () => void }) {
  // refaire un seul plan : sa photo reste, son clip est rendu à nouveau, le reel est remonté
  const [planRefait, setPlanRefait] = useState<number | null>(null)
  const [confirme, setConfirme] = useState<'annuler' | 'supprimer' | null>(null)
  const edition = useEdition()
  const enCours = r.etat !== 'fini' && r.etat !== 'echec'
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
  const idx = r.etat === 'echec' ? -1 : (r.etat as string) === 'montage' ? ETAPES.indexOf('export') : ETAPES.indexOf(r.etat)
  const photos = r.plans.filter(p => p.photoUri).length, clips = r.plans.filter(p => p.clipUri).length
  const detail = (e: Reel['etat']) => e === 'photos' ? ` ${photos}/${r.plans.length || r.n}` : e === 'clips' ? ` ${clips}/${r.plans.length || r.n}` : ''
  return (
    <div className="carte-reel" style={{ display: 'grid', gridTemplateColumns: r.reelUri ? 'minmax(0, 1fr) 260px' : 'minmax(0, 1fr)', gap: 16, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
      <div style={{ display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.accroche ? `« ${r.accroche} »` : r.brief}</div>
        {r.accroche && <div style={{ fontSize: 12, color: 'var(--faint)' }}>{r.brief}</div>}
        <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: 12 }}>
          {ETAPES.map((e, k) => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, background: k < idx || r.etat === 'fini' ? 'var(--lv3)' : k === idx ? 'var(--accent)' : 'var(--lv2)',
              color: k === idx && r.etat !== 'fini' ? '#fff' : k <= idx ? 'var(--text)' : 'var(--faint)' }}>
              {k < idx || r.etat === 'fini' ? '✓ ' : ''}{t(NOM_ETAPE[e])}{k === idx ? detail(e) : ''}
              {k === idx && r.etat !== 'fini' && <span className="reel-loader" role="status" aria-label={t('en cours')} />}
            </span>
          ))}
          {r.etat === 'echec' && (r.erreur === 'annulé' ? <span style={{ color: 'var(--muted)' }}>{t('Annulé')}</span> : <span className="texte-erreur">{t('échec')} — {tServeur(r.erreur ?? '')}</span>)}
        </div>
        <div className="flex gap-2" style={{ overflowX: 'auto' }}>
          {(r.plans.length ? r.plans : Array.from({ length: r.n }, () => null)).map((p, i) => p?.supprime ? null : (
            <div key={i} title={p?.still ?? ''} style={{ width: 86, flex: 'none', aspectRatio: '9 / 16', borderRadius: 10, overflow: 'hidden', background: 'var(--lv2)', position: 'relative' }}>
              {p?.clipUri ? <video src={p.clipUri} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : p?.photoUri ? <img src={p.photoUri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: .8 }} />
                : <div className="flex items-center justify-center" style={{ height: '100%', fontSize: 12, color: 'var(--faint)' }}>{t('plan {n}', { n: i + 1 })}</div>}
              {p && !p.clipUri && (p.photoEtat === 'rendering' || p.clipEtat === 'rendering' || p.clipEtat === 'queued-comfy') &&
                <span className="pastille-media" style={{ left: 4, bottom: 4 }}>{p.clipJob ? t('anime…') : t('photo…')}</span>}
              {/* contrôle du plan avant le rendu : ce que la réécriture n'a pas su corriger */}
              {p?.avertissements?.length ? <span title={p.avertissements.map(x => t(x)).join(' · ')}
                className="pastille-media" style={{ right: 4, top: 4, background: 'var(--attention)', color: 'var(--bg)' }}>⚠</span> : null}
              {p && (r.etat === 'fini' || r.etat === 'echec') && <button title={t('Refaire ce plan')} onClick={() => { setPlanRefait(i); setGeste(p.motion) }}
                style={{ position: 'absolute', left: 4, top: 4, fontSize: 12, width: 22, height: 22, border: 0, borderRadius: 6, cursor: 'pointer', color: '#fff', background: 'var(--voile)' }}>↻</button>}
            </div>
          ))}
        </div>
        {planRefait !== null && (
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Plan {n} : le mouvement à refaire, les autres plans ne bougent pas', { n: planRefait + 1 })}</span>
            <textarea value={geste} maxLength={300} rows={2} onChange={e => setGeste(e.target.value)}
              className="champ" style={{ fontSize: 12.5 }} />
            <div className="flex gap-2 items-center">
              <button className="pill tool" onClick={() => void refaire()}>↻ {t('Refaire ce plan')}</button>
              <button className="pill tool" onClick={() => setPlanRefait(null)}>{t('Annuler')}</button>
              {errPlan && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{errPlan}</span>}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          {r.montageId && <button className="pill tool" onClick={() => goMontage(r.montageId!)}>{t('Ouvrir dans le Montage')}</button>}
          {edition && (r.etat === 'fini' || r.etat === 'echec') && <button className="pill tool" title={t('Les photos et clips restent dans la bibliothèque')} onClick={onRetirer}>✕ {t('Retirer de la liste')}</button>}
          {edition && enCours && (confirme
            ? <>
                <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>{t('Arrêter ce reel ?')}</span>
                <button className="pill tool" onClick={() => { setConfirme(null); confirme === 'annuler' ? onAnnuler() : onRetirer() }}>{t('Oui')}</button>
                <button className="pill tool" onClick={() => setConfirme(null)}>{t('Non')}</button>
              </>
            : <>
                <button className="pill tool" title={t('Les rendus en file sont arrêtés ; ce qui est déjà fait reste dans la bibliothèque')} onClick={() => setConfirme('annuler')}>■ {t('Annuler')}</button>
                <button className="pill tool" title={t('Arrête le reel et le retire de la liste ; ce qui est déjà fait reste dans la bibliothèque')} onClick={() => setConfirme('supprimer')}>✕ {t('Supprimer')}</button>
              </>)}
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
