/* ============================================================
   Long Take: a MiniMax H3 clip of 17 s to one minute, built window by window.
   Each window is rendered, watched, then approved or re-rolled; the final blend
   smooths the joins (see server/planlong.js). The page mirrors the controls of
   ComfyUI's "Geiru Window Director" node: approve, re-roll, rewind to a window,
   run all, blend.
   ============================================================ */
import { nomMedia } from '../lib/nomMedia'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'

type Etat = { total: number; approved: number; pending: number; all_made: boolean; blended: boolean; joined: boolean }
type Prise = {
  id: string; creeLe: number; fenetres: number; format: string; prompts: string[]; secondes: number; source: string | null
  apercus: Record<string, { uri: string; job: string }>
  etat: Etat | null; auto: boolean; final: string | null; erreur: string | null
  jobActif: { id: string; statut: string; action: string | null; fenetre: number | null } | null
}
type Infos = { disponible: boolean; raison: string | null; depotPack: string; formats: string[]; durees: { fenetres: number; secondes: number }[]; prises: Prise[] }

const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }
const poster = (url: string, corps?: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps ?? {}) }).then(json)

/* a window lasts 226 frames, the next one starts 187 frames later (24 fps) */
const debutDe = (n: number) => ((n - 1) * 187) / 24
const plage = (n: number) => `${Math.round(debutDe(n))}–${Math.round(debutDe(n) + 226 / 24)} s`

type Couleur = 'approuvee' | 'prete' | 'rendu' | 'afaire'
const COULEURS: Record<Couleur, { fond: string; texte: string; libelle: string }> = {
  approuvee: { fond: '#2f9e62', texte: '#fff', libelle: 'approuvée' },
  prete: { fond: '#e2b93b', texte: '#1a1500', libelle: 'à regarder' },
  rendu: { fond: '#3b82f6', texte: '#fff', libelle: 'en rendu' },
  afaire: { fond: 'var(--lv2)', texte: 'var(--muted)', libelle: 'à faire' },
}
function couleurDe(p: Prise, n: number): Couleur {
  const e = p.etat, a = p.jobActif
  if (a) {
    const cible = a.action === 'approve' ? (e?.pending ?? 0) + 1 : a.action === 'rewind' ? (a.fenetre ?? 1) : a.action === 'reroll' ? Math.max(1, e?.pending ?? 1) : 0
    if (a.action === 'blend' || n === cible) return 'rendu'
    if (a.action === 'approve' && n === e?.pending) return 'approuvee'
    if (a.action === 'rewind' && n > cible) return 'afaire'
  }
  if (!e) return 'afaire'
  if (n <= e.approved) return 'approuvee'
  if (n === e.pending) return e.all_made && (e.blended || e.joined) ? 'approuvee' : 'prete'
  return 'afaire'
}

export function PlanLongView() {
  const s = useAppStore()
  const [infos, setInfos] = useState<Infos | null>(null)
  const [prise, setPrise] = useState<Prise | null>(null)
  const [choix, setChoix] = useState(1)                 // window being watched
  const [photo, setPhoto] = useState<Asset | null>(null)
  const [format, setFormat] = useState('9:16')
  const [fenetres, setFenetres] = useState(4)
  const [prompts, setPrompts] = useState<string[]>([''])
  const [auto, setAuto] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt).slice(0, 80), [s.assets])

  const charger = useCallback(async () => {
    try { const d = await json(await fetch('/api/planlong')) as Infos; setInfos(d); return d } catch (e) { setErr((e as Error).message); return null }
  }, [])
  useEffect(() => { void charger() }, [charger])

  // follow the open take while a render runs or "run all" is on
  const id = prise?.id, suivre = !!prise && (!!prise.jobActif || prise.auto)
  useEffect(() => {
    if (!id || !suivre) return
    let vivant = true
    const tic = async () => {
      try {
        const p = await json(await fetch(`/api/planlong/${id}`)) as Prise
        if (!vivant) return
        setPrise(avant => {
          // a window just arrived: show it
          if (avant && p.etat && p.etat.pending !== avant.etat?.pending && p.etat.pending > 0) setChoix(p.etat.pending)
          return p
        })
      } catch { /* the next tick retries */ }
    }
    const h = window.setInterval(() => void tic(), 2500)
    return () => { vivant = false; window.clearInterval(h) }
  }, [id, suivre])

  const ouvrir = (p: Prise) => { setPrise(p); setChoix(Math.max(1, p.etat?.pending ?? 1)); setErr(null) }
  const reglerFenetres = (n: number) => { setFenetres(n); setPrompts(ps => Array.from({ length: n }, (_, i) => ps[i] ?? '')) }
  useEffect(() => { reglerFenetres(4) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const creer = async () => {
    if (!photo) return
    setBusy(true); setErr(null)
    try {
      const r = await poster('/api/planlong', { assetId: photo.id, fenetres, format, prompts, auto }) as { id: string; job: string }
      void s.adoptServerJob(r.job)
      ouvrir(await json(await fetch(`/api/planlong/${r.id}`)) as Prise)
      void charger()
    } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  const agir = async (action: 'reroll' | 'approve' | 'rewind' | 'blend', extra: { fenetre?: number; auto?: boolean } = {}) => {
    if (!prise) return
    setBusy(true); setErr(null)
    try {
      const r = await poster(`/api/planlong/${prise.id}/action`, { action, prompts: prise.prompts, ...extra }) as { job: string }
      void s.adoptServerJob(r.job)
      setPrise(await json(await fetch(`/api/planlong/${prise.id}`)) as Prise)
    } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  const arreter = async () => { if (!prise) return; try { await poster(`/api/planlong/${prise.id}/arret`); setPrise({ ...prise, auto: false }) } catch (e) { setErr((e as Error).message) } }
  const supprimer = async () => {
    if (!prise) return
    setBusy(true); setErr(null)
    try { await json(await fetch(`/api/planlong/${prise.id}`, { method: 'DELETE' })); setPrise(null); void charger() } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }

  const e = prise?.etat ?? null
  const occupe = busy || !!prise?.jobActif
  const final = prise?.final ? s.assets.find(a => a.id === prise.final) : null
  const apercu = prise?.apercus?.[String(choix)]?.uri ?? null
  const carte = { background: 'var(--lv1)', borderRadius: 18, padding: 16, display: 'grid', gap: 14 } as const

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div>
          <h2 className="titre-outil">{t('Plan long')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Un clip de 17 s à une minute, construit fenêtre par fenêtre : tu valides chaque morceau avant de rendre le suivant.')}</div>
        </div>

        {infos && !infos.disponible && <div className="carte-reel" style={carte}>
          <div style={{ fontSize: 13 }}>{tServeur(infos.raison)}</div>
          <a className="pill" style={{ justifySelf: 'start' }} href={infos.depotPack} target="_blank" rel="noreferrer">{t('Voir le pack de nœuds sur GitHub')}</a>
        </div>}

        {infos?.disponible && !prise && <div className="carte-reel" style={carte}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('1. La photo de départ')}</div>
            <div className="pkgrid" style={{ maxHeight: 250 }}>
              {photos.map(a => (
                <button key={a.id} className="pk" aria-label={nomMedia(a)} onClick={() => setPhoto(a)} style={{ outline: photo?.id === a.id ? '3px solid var(--accent)' : undefined }}>
                  <img src={a.uri} alt="" loading="lazy" />
                </button>
              ))}
              {!photos.length && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 12, padding: 12 }}>{t('rien dans la bibliothèque')}</div>}
            </div>
          </div>
          <div className="flex gap-4 flex-wrap">
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('2. Le format')}</div>
              <div className="flex gap-1">{infos.formats.map(f => <button key={f} className={`wtab ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>{f}</button>)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('3. La durée')}</div>
              <div className="flex gap-1 flex-wrap">{infos.durees.map(d => (
                <button key={d.fenetres} className={`wtab ${fenetres === d.fenetres ? 'on' : ''}`} onClick={() => reglerFenetres(d.fenetres)}
                  title={t('{n} fenêtres', { n: d.fenetres })}>{Math.round(d.secondes)} s</button>))}</div>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('4. Ce qui se passe, fenêtre par fenêtre (en anglais). Une fenêtre vide reprend la précédente.')}</div>
            <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 6 }}>{t('Décris la suite du même plan : rappelle le lieu et écris « same continuous shot, no cut », sinon le modèle peut couper vers une autre scène.')}</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {prompts.map((p, i) => (
                <label key={i} style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                  {t('Fenêtre {n}', { n: i + 1 })} · {plage(i + 1)}
                  <textarea className="champ" rows={2} maxLength={4000} value={p} style={{ fontSize: 13, resize: 'vertical' }}
                    onChange={ev => setPrompts(ps => ps.map((x, k) => (k === i ? ev.target.value : x)))} />
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2" style={{ fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={auto} onChange={ev => setAuto(ev.target.checked)} />
              {t('Tout enchaîner sans attendre ma validation')}
            </label>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{t('MiniMax H3 · environ 1 min 40 par fenêtre')}</span>
            <button className="cta" style={{ padding: '10px 18px', flexDirection: 'row' }} disabled={!photo || !prompts[0]?.trim() || busy} onClick={() => void creer()}>
              {busy ? '…' : t('Rendre la fenêtre 1')}
            </button>
          </div>
          {err && <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
        </div>}

        {prise && <div className="carte-reel" style={carte}>
          <div className="flex items-center gap-2 flex-wrap">
            <b style={{ fontSize: 14 }}>{t('Prise du {d}', { d: new Date(prise.creeLe).toLocaleString() })}</b>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{Math.round(prise.secondes)} s · {prise.format} · {t('{n} fenêtres', { n: prise.fenetres })}</span>
            <span style={{ flex: 1 }} />
            <button className="pill" onClick={() => { setPrise(null); void charger() }}>{t('Nouvelle prise')}</button>
          </div>

          {/* the strip: one square per window */}
          <div role="tablist" aria-label={t('Fenêtres du plan')} style={{ display: 'grid', gridTemplateColumns: `repeat(${prise.fenetres}, minmax(0, 1fr))`, gap: 6 }}>
            {Array.from({ length: prise.fenetres }, (_, i) => i + 1).map(n => {
              const c = COULEURS[couleurDe(prise, n)]
              return (
                <button key={n} role="tab" aria-selected={choix === n} onClick={() => setChoix(n)}
                  className={couleurDe(prise, n) === 'rendu' ? 'pl-pouls' : undefined}
                  style={{ background: c.fond, color: c.texte, border: 0, borderRadius: 10, padding: '8px 4px', cursor: 'pointer', display: 'grid', gap: 2, minHeight: 52,
                    outline: choix === n ? '3px solid var(--accent)' : undefined, outlineOffset: 2, transition: 'background .2s' }}>
                  <b style={{ fontSize: 15 }}>{n}</b>
                  <span style={{ fontSize: 10.5, opacity: .9 }}>{t(c.libelle)}</span>
                </button>
              )
            })}
          </div>

          <div className="pl-corps" style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 6 }}>
              {final && e?.blended
                ? <video key={final.uri} src={final.uri} controls playsInline loop style={{ width: '100%', maxHeight: 520, borderRadius: 12, background: '#000' }} />
                : apercu
                  ? <video key={apercu} src={apercu} controls autoPlay muted loop playsInline style={{ width: '100%', maxHeight: 520, borderRadius: 12, background: '#000' }} />
                  : <div style={{ aspectRatio: prise.format.replace(':', ' / '), maxHeight: 520, borderRadius: 12, background: 'var(--lv2)', display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 13, padding: 12, textAlign: 'center' }}>
                      {couleurDe(prise, choix) === 'rendu' ? t('rendu en cours…') : t('cette fenêtre n’est pas encore rendue')}
                    </div>}
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {final && e?.blended ? t('Clip final, raccords fusionnés. Il est dans la bibliothèque.')
                  : t('Fenêtre {n} · {p} · l’aperçu commence sur le raccord avec la fenêtre précédente.', { n: choix, p: plage(choix) })}
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                {t('Prompt de la fenêtre {n}', { n: choix })}
                <textarea className="champ" rows={5} maxLength={4000} value={prise.prompts[choix - 1] ?? ''} disabled={occupe} style={{ fontSize: 13, resize: 'vertical' }}
                  onChange={ev => setPrise({ ...prise, prompts: prise.prompts.map((x, k) => (k === choix - 1 ? ev.target.value : x)) })} />
              </label>
              <div className="flex gap-2 flex-wrap">
                {e && !e.all_made && e.pending > 0 && <button className="cta" style={{ padding: '10px 16px', flexDirection: 'row' }} disabled={occupe}
                  onClick={() => void agir('approve')}>{t('Approuver la fenêtre {n}', { n: e.pending })}</button>}
                {e?.all_made && <button className="cta" style={{ padding: '10px 16px', flexDirection: 'row' }} disabled={occupe}
                  onClick={() => void agir('blend')}>{e.blended ? t('Refaire la fusion') : t('Fusionner le clip')}</button>}
                {e && e.pending > 0 && <button className="pill" disabled={occupe} onClick={() => void agir('reroll')}>{t('Refaire la fenêtre {n}', { n: e.pending })}</button>}
                {e && e.total > 0 && choix < (e.pending || e.total + 1) && <button className="pill" disabled={occupe} onClick={() => void agir('rewind', { fenetre: choix })}>{t('Revenir à la fenêtre {n}', { n: choix })}</button>}
                {e && !e.all_made && e.pending > 0 && (prise.auto
                  ? <button className="pill" onClick={() => void arreter()}>{t('Arrêter l’enchaînement')}</button>
                  : <button className="pill" disabled={occupe} onClick={() => void agir('approve', { auto: true })}>{t('Tout enchaîner')}</button>)}
                {(!e || !e.total) && !prise.jobActif && <button className="cta" style={{ padding: '10px 16px', flexDirection: 'row' }} disabled={occupe}
                  onClick={() => void agir('reroll')}>{t('Rendre la fenêtre 1')}</button>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {prise.jobActif ? t('Un rendu est en cours : la bande se met à jour toute seule.')
                  : e?.all_made ? t('Toutes les fenêtres sont rendues. La fusion repasse sur tout le clip pour lisser les raccords.')
                  : t('Refaire garde tes fenêtres approuvées. Revenir à une fenêtre efface celles qui la suivent.')}
              </div>
              {(prise.erreur || err) && <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{tServeur(prise.erreur) ?? err}</div>}
              <button className="pill" style={{ justifySelf: 'start', color: 'var(--danger)' }} disabled={occupe} onClick={() => void supprimer()}>{t('Supprimer cette prise')}</button>
            </div>
          </div>
        </div>}

        {!prise && !!infos?.prises.length && <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Prises en cours ou terminées')}</div>
          <div className="flex gap-2 flex-wrap">
            {infos.prises.map(p => (
              <button key={p.id} className="pill" onClick={() => ouvrir(p)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.source && <img src={p.source} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />}
                {new Date(p.creeLe).toLocaleDateString()} · {Math.round(p.secondes)} s · {p.etat?.blended ? t('terminée') : t('{a} sur {n}', { a: p.etat?.approved ?? 0, n: p.fenetres })}
              </button>
            ))}
          </div>
        </div>}
      </div>
    </div>
  )
}
