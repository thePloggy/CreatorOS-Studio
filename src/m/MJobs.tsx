/* ============================================================
   Jobs: running, queued, failed, history.

   Two rules drive this screen:
   · machine metrics are AT THE TOP, without an extra "Machine" button;
   · a progress bar does not lie; see `Progress` below.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { Job } from '../types'
import { vignetteOf } from '../components/AssetMedia'
import { STATUTS_ACTIFS, STATUTS_EN_CALCUL } from '../types'
import { attente } from '../lib/attente'
import { useAppStore } from '../store/useAppStore'
import { useTelemetry } from '../components/shell/useTelemetry'
import { Ic, Opt, Sheet, fmtDur, useConfirm } from './bits'
import { getLang, t, tp, tServeur } from '../i18n'
import { CleProprietaire } from '../features/config/CleProprietaire'

/** Job error message: the server returns it but the Job type does not
 *  declare it, so it is read without faking the typing. */
const jobError = (j: Job): string | null =>
  tServeur((j as unknown as { error?: string }).error) ?? null

export function MJobs({ goLibrary }: { goLibrary: () => void }) {
  const s = useAppStore()
  const tm = useTelemetry()
  const [detail, setDetail] = useState<Job | null>(null)

  const jobs = [...s.jobs].sort((a, b) => b.createdAt - a.createdAt)
  const running = jobs.filter(j => STATUTS_EN_CALCUL.includes(j.status))
  const queued = jobs.filter(j => j.status === 'queued')
  /* A failed render comes back as `blocked` (JobStatus has no "error"
     state; the message says why). */
  const broken = jobs.filter(j => j.status === 'blocked')
  const done = jobs.filter(j => j.status === 'done').slice(0, 20)

  const gb = (mb?: number) => (mb == null ? null : (mb / 1024).toFixed(1).replace('.', getLang() === 'en' ? '.' : ','))

  return (
    <>
      <div className="htitle">
        <h1>Jobs</h1>
        <p>{t('Continue à créer pendant le calcul.')}</p>
      </div>

      <div className="scroll">
        {/* ---- machine metrics ---- */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{
              width: 9, height: 9, borderRadius: 999,
              background: tm?.gpu ? 'var(--ok)' : 'var(--ko)', display: 'inline-block',
            }} />
            <b style={{ fontSize: 16 }}>{tm?.gpu ? t('Machine connectée') : t('Connexion interrompue')}</b>
          </div>
          {tm?.gpu ? (
            <div className="telem">
              <Cell k="GPU" v={`${tm.gpu.util} %`} />
              <Cell k="CPU" v={tm.cpu?.util != null ? `${tm.cpu.util} %` : t('Indisponible')} />
              {/* The alert threshold is NOT derived from a mock value: until
                  the server provides one, colour only above a clear level
                  and stay factual. */}
              <Cell k={t('Temp. GPU')} v={`${tm.gpu.temp} °C`} warn={tm.gpu.temp >= 83} />
              <Cell k="VRAM" v={gb(tm.gpu.vramUsedMb) ? t('{n} Go', { n: gb(tm.gpu.vramUsedMb)! }) : t('Indisponible')} />
              <Cell k="RAM" v={tm.ram ? t('{used} / {total} Go', { used: gb(tm.ram.usedMb)!, total: gb(tm.ram.totalMb)! }) : t('Indisponible')} />
              {tm.cpu?.temp != null && <Cell k={t('Temp. CPU')} v={`${tm.cpu.temp} °C`} />}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>
              {t('Les mesures ne sont pas disponibles pour l’instant. Les rendus déjà acceptés continuent sur la machine.')}
            </p>
          )}
        </div>

        <Section title={t('En cours')} n={running.length} />
        {running.map(j => <JobCard key={j.id} j={j} onDetail={() => setDetail(j)} />)}
        {running.length === 0 && <p className="muted" style={{ fontSize: 14 }}>{t('Rien en calcul.')}</p>}

        {queued.length > 0 && <>
          <Section title={t('En attente')} n={queued.length} />
          {queued.map((j, i) => <JobCard key={j.id} j={j} rank={i} onDetail={() => setDetail(j)} />)}
        </>}

        {broken.length > 0 && <>
          <Section title={t('À reprendre')} n={broken.length} />
          {broken.map(j => <JobCard key={j.id} j={j} onDetail={() => setDetail(j)} />)}
        </>}

        {done.length > 0 && <>
          <Section title={t('Terminés')} n={done.length} />
          {done.map(j => <JobCard key={j.id} j={j} onDetail={() => setDetail(j)} onResults={goLibrary} />)}
        </>}

        {jobs.length === 0 && <div className="empty">{t('Aucun rendu pour l’instant.')}</div>}
        {/* owner: their key and today's visitors (nothing shows outside a locked studio) */}
        <div style={{ overflowX: 'auto' }}><CleProprietaire /></div>
      </div>

      {detail && <JobSheet j={detail} onClose={() => setDetail(null)} onResults={goLibrary} />}
    </>
  )
}

function Cell({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="cell">
      <small>{k}</small>
      <b style={warn ? { color: 'var(--warn)' } : undefined}>{v}</b>
    </div>
  )
}

function Section({ title, n }: { title: string; n: number }) {
  return <div className="secttl"><b>{title}</b><span>{n}</span></div>
}

/* ---------- progress bar ----------
   ComfyUI pushes `progress` only intermittently, and value/max cover only
   the current NODE: neither an end-to-end measurement nor a continuous
   stream. Two modes:
     · no measurement  → nominal speed (elapsed / estimated);
     · on each measurement → snap to the real value, then continue at a
       speed recomputed to reach 100 % at the estimated end.
   With neither estimate NOR measurement, show an INDETERMINATE progress
   with elapsed time: an estimated duration never becomes a percentage. */
function Progress({ j }: { j: Job }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  const anchor = useRef<{ pct: number; at: number; elapsed: number } | null>(null)
  const floor = useRef(0)
  const prog = j.progress
  const elapsed = j.startedAt ? Date.now() - j.startedAt : 0
  useEffect(() => {
    if (!prog?.max) return
    const measured = Math.min(0.99, prog.value / prog.max)
    anchor.current = { pct: measured, at: Date.now(), elapsed }
    floor.current = Math.max(0, measured - 0.15)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prog?.value, prog?.max])

  const est = j.estimatedMs || 0
  const indeterminate = !est && !anchor.current
  let ratio = 0
  if (anchor.current) {
    const a = anchor.current
    const remaining = Math.max(2000, est - a.elapsed)
    ratio = a.pct + (1 - a.pct) * ((Date.now() - a.at) / remaining)
  } else if (est) ratio = elapsed / est
  const pct = Math.round(Math.min(0.96, Math.max(floor.current, ratio)) * 100)

  return (<>
    {j.apercu && (
      <img src={`/api/jobs/${encodeURIComponent(j.id)}/apercu?t=${j.apercu}`} alt={t('aperçu du rendu en cours')}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        style={{ display: 'block', height: 150, borderRadius: 10, margin: '0 0 8px', objectFit: 'contain' }} />
    )}
    <div className={`bar ${indeterminate ? 'idle' : ''}`} role="progressbar"
      aria-valuenow={indeterminate ? undefined : pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${indeterminate ? 34 : Math.max(pct, 3)}%` }} />
    </div>
    <div className="muted" style={{ fontSize: 13 }}>
      {j.phase ? `${t(j.phase)} · ` : ''}{t('{d} écoulées', { d: fmtDur(elapsed) })}{est ? t(' · estimé ~{d}', { d: fmtDur(est) }) : ''}
    </div>
    {est > 0 && elapsed > est * 1.6 && elapsed - est > 90_000 && (
      <div style={{ fontSize: 12.5, color: '#ffb648', marginTop: 4 }}>{t('Anormalement lent — la mémoire vidéo est peut-être saturée.')}</div>
    )}
  </>)
}

function JobCard({ j, rank, onDetail, onResults }: {
  j: Job; rank?: number; onDetail: () => void; onResults?: () => void
}) {
  const s = useAppStore()
  const assets = s.assets.filter(a => a.jobId === j.id)
  const label = j.mode === 'video'
    ? `${j.videoEngine ?? t('vidéo')}${j.videoDraft ? t(' · brouillon') : ''}`
    : (j.recipeId?.split('@')[0] ?? t('image'))
  const title = (j.composedPositive || j.userPrompt || '—').split('\n')[0]

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {assets[0]
          ? <img className="thumb" style={{ width: 54, height: 72, borderRadius: 10, objectFit: 'cover' }}
              src={vignetteOf(assets[0])} alt="" />
          : <span className="thumb" style={{ width: 54, height: 72, borderRadius: 10, background: 'var(--card-2)', display: 'grid', placeItems: 'center' }}>
              <Ic n={j.mode === 'video' ? 'film' : 'image'} s={20} />
            </span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 15, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </b>
          <small className="muted" style={{ display: 'block', marginTop: 2 }}>
            {label}
            {attente(j) ? ` · ${attente(j)}` : rank != null ? (rank === 0 ? t(' · 1er dans la file') : t(' · {n}e dans la file', { n: rank + 1 })) : ''}
          </small>
        </div>
      </div>

      {j.status === 'rendering' && <div style={{ marginTop: 10 }}><Progress j={j} /></div>}
      {j.status === 'post-process' && <small className="muted" style={{ display: 'block', marginTop: 8 }}>{t('finition en cours (retouche d’identité, fluidité)')}</small>}
      {j.status === 'blocked' && <p className="err">{jobError(j) || t('Rendu bloqué : reprends les réglages.')}</p>}
      {j.status === 'done' && (
        <small className="muted" style={{ display: 'block', marginTop: 8 }}>
          {tp(assets.length, '{n} résultat', '{n} résultats')}
          {j.durationMs ? t(' · rendu en {d}', { d: fmtDur(j.durationMs) }) : ''}
        </small>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="chip" onClick={onDetail}>{t('Voir les réglages')}</button>
        {j.status === 'done' && assets.length > 0 && onResults && (
          <button className="chip on" onClick={onResults}>{t('Résultats')}</button>
        )}
      </div>
    </div>
  )
}

function JobSheet({ j, onClose, onResults }: { j: Job; onClose: () => void; onResults: () => void }) {
  const s = useAppStore()
  const [armed, arm] = useConfirm()
  const [asked, setAsked] = useState(false)
  const assets = s.assets.filter(a => a.jobId === j.id)
  const cancellable = STATUTS_ACTIFS.includes(j.status)

  return (
    <Sheet title={`Job #${j.id}`} onClose={onClose}>
      <Row k={t('État')} v={({
        queued: t('En attente'), 'queued-comfy': t('Acceptée par ComfyUI'), rendering: t('En cours'),
        done: t('Terminé'), blocked: t('Bloqué'), retry: t('Relance'), 'post-process': t('Finition'),
      } as Record<string, string>)[j.status] ?? j.status} />
      <Row k={t('Type')} v={j.mode === 'video' ? t('Vidéo') : t('Image')} />
      {j.mode === 'video' && <Row k={t('Moteur')} v={`${j.videoEngine ?? '—'}${j.videoDraft ? t(' · brouillon') : ''}`} />}
      <Row k={t('Seed')} v={j.seed?.value != null ? String(j.seed.value) : t('aléatoire')} />
      {j.durationMs != null && <Row k={t('Durée du rendu')} v={fmtDur(j.durationMs)} />}
      {jobError(j) && <Row k={t('Erreur')} v={jobError(j)!} wrap />}
      <Row k="Prompt" v={j.composedPositive || j.userPrompt || '—'} wrap />

      {j.status === 'done' && assets.length > 0 && (
        <button className="cta" style={{ marginTop: 16 }} onClick={() => { onClose(); onResults() }}>
          {tp(assets.length, 'Voir le résultat', 'Voir les {n} résultats')}
        </button>
      )}

      {j.status === 'queued' && (
        <Opt label={t('Prioriser')} hint={t('passe en tête de file — n’interrompt pas le rendu en cours')}
          onClick={() => { void s.promoteJob(j.id); onClose() }} />
      )}
      {cancellable && (
        <Opt label={asked ? t('Annulation demandée…') : armed ? t('⚠ Confirmer l’annulation') : t('Annuler ce job')}
          hint={j.status === 'rendering' ? t('le job reste affiché tant que la machine n’a pas confirmé l’arrêt') : undefined}
          onClick={() => {
            if (asked) return
            if (arm()) { void s.cancelJob(j.id); setAsked(true) }
          }} />
      )}
    </Sheet>
  )
}

function Row({ k, v, wrap }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="muted" style={{ fontSize: 13 }}>{k}</div>
      <div style={{ fontSize: 15, marginTop: 2, whiteSpace: wrap ? 'pre-wrap' : undefined, lineHeight: 1.45 }}>{v}</div>
    </div>
  )
}
