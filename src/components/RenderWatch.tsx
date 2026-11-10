/* Suivre un rendu sans rester devant la galerie.
   - useTabTitle : le titre de l'onglet porte le nombre de rendus en cours, puis
     le nombre de rendus arrivés pendant que l'onglet était en arrière-plan ;
   - RenderIsland : pastille flottante « rendu · 42 % », puis « prêt → voir »
     quand un rendu arrive, là où la galerie n'est pas visible (visionneuse
     ouverte, autre section, autre espace du mobile) ;
   - jobFraction : avancement d'un job de 0 à 1, mesure ComfyUI sinon écoulé / estimé. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { STATUTS_ACTIFS, STATUTS_EN_CALCUL } from '../types'
import type { Asset, Job } from '../types'
import { t, tp } from '../i18n'

export function jobFraction(j: Job): number {
  if (j.status === 'post-process') return 0.97
  if (j.progress?.max) return Math.min(0.96, j.progress.value / j.progress.max)
  if (j.startedAt && j.estimatedMs) return Math.min(0.96, (Date.now() - j.startedAt) / j.estimatedMs)
  return 0
}

/** Le rendu actuellement en calcul, s'il y en a un. */
export function useRunningJob(): Job | null {
  const jobs = useAppStore(s => s.jobs)
  const [, tick] = useState(0)
  const j = jobs.find(x => STATUTS_EN_CALCUL.includes(x.status)) ?? null
  useEffect(() => {
    if (!j) return
    const t = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [j?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return j
}

/** Les assets arrivés depuis le montage du composant (le plus récent d'abord). */
function useArrivals(onArrive: (a: Asset) => void) {
  const assets = useAppStore(s => s.assets)
  const connus = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (connus.current === null) { if (assets.length) connus.current = new Set(assets.map(a => a.id)); return }
    for (const a of assets) if (!connus.current.has(a.id)) { connus.current.add(a.id); onArrive(a) }
  }, [assets]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function useTabTitle(base = 'CreatorOS Studio') {
  const actifs = useAppStore(s => s.jobs.filter(j => STATUTS_ACTIFS.includes(j.status)).length)
  const [prets, setPrets] = useState(0)
  useArrivals(() => { if (document.hidden) setPrets(n => n + 1) })
  useEffect(() => {
    const vu = () => { if (!document.hidden) setPrets(0) }
    document.addEventListener('visibilitychange', vu)
    return () => document.removeEventListener('visibilitychange', vu)
  }, [])
  useEffect(() => {
    document.title = prets ? tp(prets, '({n} prêt) {base}', '({n} prêts) {base}', { base }) : actifs ? t('▸ {n} en rendu · {base}', { n: actifs, base }) : base
  }, [prets, actifs, base])
}

export function RenderIsland({ visible, top = 70, onOpen }: { visible: boolean; top?: number; onOpen: (a: Asset) => void }) {
  const j = useRunningJob()
  const [pret, setPret] = useState<Asset | null>(null)
  useArrivals(a => setPret(a))
  useEffect(() => {
    if (!pret) return
    const t = window.setTimeout(() => setPret(null), 8000)
    return () => window.clearTimeout(t)
  }, [pret])
  useEffect(() => { if (!visible) setPret(null) }, [visible])
  if (!visible || (!j && !pret)) return null
  const pct = j ? Math.round(jobFraction(j) * 100) : 0
  return (
    <div style={{ position: 'fixed', top, left: '50%', transform: 'translateX(-50%)', zIndex: 320, display: 'flex', alignItems: 'center', gap: 10,
      padding: pret ? '6px 8px 6px 6px' : '8px 14px', borderRadius: 999, fontSize: 12.5, whiteSpace: 'nowrap', color: '#f2f2f4',
      background: 'rgba(24, 25, 30, 0.94)', border: '1px solid rgba(255,255,255,0.13)', boxShadow: '0 10px 34px rgba(0,0,0,0.5)' }}>
      {pret ? (
        <button onClick={() => { onOpen(pret); setPret(null) }}
          style={{ display: 'flex', alignItems: 'center', gap: 9, border: 0, background: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', padding: 0 }}>
          <img alt="" src={pret.mediaType === 'video' ? `/api/poster/${encodeURIComponent(pret.uri.split('/').pop() ?? '')}` : pret.uri}
            style={{ width: 30, height: 30, borderRadius: 999, objectFit: 'cover' }} />
          {pret.mediaType === 'video' ? t('Vidéo prête') : t('Image prête')} <b style={{ color: '#f6a961' }}>{t('→ voir')}</b>
        </button>
      ) : j && (
        <>
          <span style={{ width: 62, height: 5, borderRadius: 9, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${Math.max(4, pct)}%`, background: 'linear-gradient(90deg, #f6a961, #ea4e89)' }} />
          </span>
          {j.status === 'post-process' ? t('finition') : t('rendu')} · {pct} %
          <span style={{ opacity: .5 }}>#{j.id}</span>
        </>
      )}
    </div>
  )
}

/** Anneau d'avancement à poser autour d'une icône (bouton Créer du mobile). */
export function RenderRing({ size = 34 }: { size?: number }) {
  const j = useRunningJob()
  if (!j) return null
  const p = Math.max(0.04, jobFraction(j))
  return <span aria-hidden style={{ position: 'absolute', left: '50%', top: 4, width: size, height: size, marginLeft: -size / 2, borderRadius: 999, pointerEvents: 'none',
    background: `conic-gradient(#ea4e89 ${p * 360}deg, rgba(255,255,255,0.12) 0)`,
    WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px))',
    mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px))' }} />
}

/* ---------- pastille de la barre du haut ----------
   Toujours visible pendant un rendu : l'étape en clair, les pas, le temps écoulé et restant,
   le nombre de rendus en attente, un bouton Arrêter. Si rien n'avance depuis 2 min (ni les pas
   ni l'étape), elle prévient que le rendu semble bloqué. Un clic déplie la liste des rendus. */
const fmt = (s: number) => s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`
export function PastilleRendu() {
  const j = useRunningJob()
  const jobs = useAppStore(s => s.jobs)
  const annuler = useAppStore(s => s.cancelJob)
  const [ouvert, setOuvert] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  // dernier signal de vie : les pas ou l'étape qui changent
  const signal = useRef<{ cle: string; at: number }>({ cle: '', at: Date.now() })
  const cle = j ? `${j.id}|${j.progress?.value ?? ''}|${j.phase ?? ''}|${j.status}` : ''
  if (cle !== signal.current.cle) signal.current = { cle, at: Date.now() }
  const attente = jobs.filter(x => x.status === 'queued' || x.status === 'queued-comfy').length
  if (!j && !attente) return null
  const ecoule = j?.startedAt ? (Date.now() - j.startedAt) / 1000 : 0
  const reste = j?.progress?.etaS ?? (j?.startedAt && j?.estimatedMs ? Math.max(0, (j.estimatedMs - (Date.now() - j.startedAt)) / 1000) : null)
  const bloque = !!j && Date.now() - signal.current.at > 120_000
  const pct = j ? Math.round(jobFraction(j) * 100) : 0
  const stop = async (id: string) => { setErreur(null); const e = await annuler(id); if (e) setErreur(e) }
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOuvert(o => !o)} title={t('Rendus en cours')}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 11px', borderRadius: 999, fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer',
          color: '#f2f2f4', background: bloque ? 'rgba(234,78,78,0.18)' : 'var(--lv2)', border: `1px solid ${bloque ? 'rgba(234,78,78,0.6)' : 'var(--lv3)'}` }}>
        {j ? (<>
          <span style={{ width: 46, height: 5, borderRadius: 9, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${Math.max(4, pct)}%`, background: 'linear-gradient(90deg, #f6a961, #ea4e89)' }} />
          </span>
          <span className="pastille-phase">{bloque ? t('semble bloqué') : j.status === 'post-process' ? t('finition') : t(j.phase ?? 'rendu')}</span>
          {j.progress?.max ? <span style={{ opacity: .6 }}>{j.progress.value}/{j.progress.max}</span> : null}
          <span className="pastille-temps" style={{ opacity: .6 }}>{fmt(ecoule)}{reste != null ? ` · ${t('reste ~{t}', { t: fmt(reste) })}` : ''}</span>
        </>) : <span style={{ opacity: .7 }}>{t('en attente')}</span>}
        {attente ? <span style={{ padding: '1px 7px', borderRadius: 9, background: 'var(--lv3)', fontSize: 11 }}>+{attente}</span> : null}
      </button>
      {ouvert && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 400, width: 320, padding: 10, borderRadius: 12, fontSize: 12,
          background: 'rgba(24,25,30,0.98)', border: '1px solid var(--lv3)', boxShadow: '0 12px 34px rgba(0,0,0,0.5)', display: 'grid', gap: 6 }}>
          {bloque && <div style={{ color: '#f39a9a' }}>{t('Rien n’a bougé depuis plus de 2 minutes : le rendu est peut-être bloqué. Tu peux l’arrêter et le relancer.')}</div>}
          {jobs.filter(x => STATUTS_ACTIFS.includes(x.status)).slice(0, 8).map(x => (
            <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <b>{x.status === 'queued' || x.status === 'queued-comfy' ? t('en attente') : t(x.phase ?? 'rendu')}</b>
                <span style={{ opacity: .55 }}> · {x.mode === 'video' ? t('vidéo') : t('image')} · #{x.id}</span>
              </span>
              <button className="pill" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => void stop(x.id)}>{t('Arrêter')}</button>
            </div>
          ))}
          {erreur && <div style={{ color: '#f39a9a' }}>{erreur}</div>}
        </div>
      )}
    </div>
  )
}
