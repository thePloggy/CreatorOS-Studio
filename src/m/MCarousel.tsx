/* ============================================================
   Carrousel — neuf propositions à partir d'une photo existante.

   L'ORIGINE n'est jamais regénérée : c'est la référence de lecture,
   pas une proposition. Il y a donc 8 réécritures cochables + 1 témoin,
   et le décompte d'envoi ne porte que sur les huit.
   ============================================================ */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, Sheet } from './bits'
import { t, tp, tServeur } from '../i18n'
import { corrigerFiche, type Corrections } from '../lib/ficheCorrigee'

type Dim = 'outfit' | 'pose' | 'env' | 'props' | 'light' | 'style'
const LABELS: Record<Dim, string> = {
  outfit: 'the outfit / clothing',
  pose: 'the body pose / position',
  env: 'the setting / location / background',
  props: 'the props around her',
  light: 'the light',
  style: 'the photographic style',
}
const FR: Record<Dim, string> = { outfit: 'Tenue', pose: 'Pose', env: 'Décor', props: 'Accessoires', light: 'Lumière', style: 'Style photo' }
/* `env` côté mobile s'appelle `location` côté serveur. */
const VERS_SERVEUR: Record<Dim, string> = { outfit: 'outfit', pose: 'pose', env: 'location', props: 'props', light: 'light', style: 'style' }

export function MCarousel({ asset, onClose, onSent }: {
  asset: Asset; onClose: () => void; onSent: () => void
}) {
  const s = useAppStore()
  const base = asset.provenance?.composedPositive || asset.provenance?.userPrompt || ''
  /* Coché = GARDÉ. Par défaut on garde la tenue et le décor, et on fait
     varier la pose et la lumière : c'est la déclinaison la plus courante. */
  const [keep, setKeep] = useState<Record<Dim, boolean>>({ outfit: true, pose: false, env: true, props: true, light: true, style: false })
  /* Décomposition montrée AVANT les cadenas, comme sur le desktop : sans elle
     on verrouille sans savoir ce que chaque dimension contient. */
  const [dims, setDims] = useState<Record<string, string> | null>(null)
  const [dimsErr, setDimsErr] = useState(false)
  /* Préparation du carrousel, renvoyée telle quelle à la rédaction. */
  const [prep, setPrep] = useState<{ racine: string | null; vlm: string | null; fiche: unknown } | null>(null)
  const [corr, setCorr] = useState<Corrections>({})
  const [edite, setEdite] = useState<string | null>(null)
  const [keepSeed, setKeepSeed] = useState(false)
  const [phase, setPhase] = useState<'config' | 'busy' | 'review' | 'sending'>('config')
  const [variants, setVariants] = useState<string[]>([])
  /* LoRA attribuée par la grille à chaque plan (facultatif). */
  const [lorasPlans, setLorasPlans] = useState<({ name: string; strength: number; trigger: string }[] | null)[]>([])
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [tab, setTab] = useState(0)
  const [err, setErr] = useState('')
  const [sec, setSec] = useState(0)
  const [sentN, setSentN] = useState(0)

  useEffect(() => {
    setDims(null); setDimsErr(false); setPrep(null); setCorr({}); setEdite(null)
    void fetch('/api/carrousel/fiche', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchorUri: asset.uri, prompt: base, register: 'sfw' }) })
      .then(r => r.json()).then(d => {
        if (!d.dims) { setDimsErr(true); return }
        setDims(d.dims); setPrep({ racine: d.racine ?? null, vlm: d.vlm ?? null, fiche: d.fiche })
      })
      .catch(() => setDimsErr(true))
  }, [asset.uri, base])

  const rewrite = async () => {
    const vary = (Object.keys(LABELS) as Dim[]).filter(k => !keep[k]).map(k => LABELS[k])
    if (!vary.length) { setErr(t('Ouvre au moins un cadenas : ce qui est ouvert est ce que le carrousel fait varier.')); return }
    const contrat = Object.fromEntries((Object.keys(FR) as Dim[]).map(k => [VERS_SERVEUR[k], keep[k]]))
    setPhase('busy'); setErr(''); setSec(0)
    const t0 = Date.now()
    const tick = window.setInterval(() => setSec(Math.round((Date.now() - t0) / 1000)), 1000)
    try {
      const r = await fetch('/api/carrousel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: base, register: 'sfw', n: 8, keep: contrat, anchorUri: asset.uri,
          ...corrigerFiche(prep, corr), promptRacine: prep?.racine ?? undefined,
        }),
        signal: AbortSignal.timeout(600000),
      })
      const d = await r.json().catch(() => ({ error: t('réponse illisible du serveur') }))
      if (!r.ok || d.error) throw new Error(tServeur(d.error) || `HTTP ${r.status}`)
      if (!Array.isArray(d.variants) || !d.variants.length) throw new Error(t('aucune variante produite'))
      setVariants([base, ...d.variants.slice(0, 8)])
      setLorasPlans(Array.isArray(d.loras) ? d.loras.slice(0, 8) : [])
      // toutes cochées d'emblée : relire et décocher est plus rapide que cocher
      setChosen(new Set(d.variants.slice(0, 8).map((_: string, i: number) => i + 1)))
      setTab(1)
      setPhase('review')
    } catch (e) {
      setErr((e as Error).name === 'TimeoutError'
        ? t('Délai dépassé (10 min) — le processeur est chargé, réessaie.')
        : String((e as Error).message || e))
      setPhase('config')
    }
    window.clearInterval(tick)
  }

  const send = async () => {
    setPhase('sending'); setSentN(0)
    const seedVal = keepSeed ? asset.provenance?.seed?.value : undefined
    const bid = crypto.randomUUID()
    /* Le rendu ORIGINAL rejoint le lot sans être recalculé : il en est la
       première vignette. */
    try {
      await fetch(`/api/jobs/${encodeURIComponent(asset.jobId)}/batch-id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: bid }),
      })
    } catch { /* non bloquant : le lot se formera sans l'original */ }

    s.setMode('photo')
    s.updatePhoto({ task: 'generate' })
    s.setBatchCount(1)
    s.setCarouselBatchId(bid)
    s.setCarouselLocks(keep as unknown as Record<string, boolean>)
    s.setCarouselPromptRacine(prep?.racine ?? null)
    const lorasAvant = useAppStore.getState().loraPicks
    let done = 0
    for (const i of [...chosen].sort((a, b) => a - b)) {
      const v = variants[i]?.trim()
      if (!v) continue
      const lp = lorasPlans[i - 1]
      useAppStore.setState({ loraPicks: lp ?? lorasAvant })
      s.setUserPrompt(v)
      if (seedVal != null) {
        if (useAppStore.getState().seedMode !== 'lock') s.toggleSeedMode()
        s.setSeedValue(seedVal)
      } else if (useAppStore.getState().seedMode === 'lock') s.toggleSeedMode()
      await s.submitJob()
      done++; setSentN(done)
    }
    s.setCarouselBatchId(null)
    s.setCarouselLocks(null)
    s.setCarouselPromptRacine(null)
    useAppStore.setState({ loraPicks: lorasAvant })
    await s.hydrate()
    onSent()
  }

  return (
    <Sheet title={t('Carrousel')} onClose={onClose} maxHeight="92dvh">
      {phase === 'config' && (<>
        <p className="muted" style={{ fontSize: 14 }}>
          {t("Cadenas fermé = la dimension reste constante dans tout le shooting ; ouvert = le rédacteur en fait ce qu'il veut.")}
        </p>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          {dims ? t('👁 image lue') : dimsErr ? t('⚠ aperçu indisponible — les cadenas restent utilisables') : t('👁 lecture de l’image…')}
        </p>
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          {(Object.keys(FR) as Dim[]).map(k => (
            <div key={k}>
              <button className={`chip ${keep[k] ? 'on' : ''}`} style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => setKeep(p => ({ ...p, [k]: !p[k] }))} aria-pressed={keep[k]}>
                {keep[k] ? '🔒' : '🔓'} {t(FR[k])} — {keep[k] ? t('constant') : t('libre')}
              </button>
              {!dims && !dimsErr
                ? <span className="dimload" aria-label={t('lecture de l’image en cours')}><i /><i /></span>
                : dims && dims[VERS_SERVEUR[k]] !== undefined
                  ? (edite === VERS_SERVEUR[k]
                    ? <div style={{ marginTop: 4, display: 'grid', gap: 6 }}>
                        <textarea rows={2} autoFocus value={corr[VERS_SERVEUR[k]] ?? dims[VERS_SERVEUR[k]] ?? ''}
                          style={{ width: '100%', font: 'inherit', fontSize: 14, padding: 8, borderRadius: 10 }}
                          aria-label={t('corriger ce que le VLM a lu')}
                          onChange={e => setCorr(c => ({ ...c, [VERS_SERVEUR[k]]: e.target.value }))} />
                        <div className="chipline">
                          <button className="chip" onClick={() => { setCorr(c => { const n = { ...c }; delete n[VERS_SERVEUR[k]]; return n }); setEdite(null) }}>{t('Lecture du VLM')}</button>
                          <button className="chip on" onClick={() => setEdite(null)}>OK</button>
                        </div>
                      </div>
                    : <em style={{ display: 'block', marginTop: 3, fontStyle: 'normal', fontSize: 12, lineHeight: 1.35,
                        color: corr[VERS_SERVEUR[k]]?.trim() ? 'var(--accent)' : 'var(--tx2)' }}>
                        {corr[VERS_SERVEUR[k]]?.trim() || dims[VERS_SERVEUR[k]] || '—'}
                        <button onClick={() => setEdite(VERS_SERVEUR[k])} aria-label={t('corriger ce que le VLM a lu')}
                          style={{ marginLeft: 6, border: 0, background: 'none', color: 'var(--tx2)', fontSize: 13, padding: '4px 6px' }}>{t('✎ corriger')}</button>
                      </em>)
                  : null}
            </div>
          ))}
        </div>
        <div className="chipline" style={{ marginTop: 10 }}>
          <button className={`chip ${keepSeed ? 'on' : ''}`} onClick={() => setKeepSeed(v => !v)}
            aria-pressed={keepSeed}>{keepSeed ? '🔒' : '🎲'} Seed</button>
        </div>
        {err && <p className="err">{err}</p>}
        <button className="cta" style={{ marginTop: 20 }} onClick={() => void rewrite()}>
          {t('Proposer 8 variantes')}
        </button>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          {t('Un passage du réécriveur sur la machine de rendu : compte une à deux minutes.')}
        </p>
      </>)}

      {phase === 'busy' && (
        <div style={{ textAlign: 'center', padding: '36px 0' }}>
          <div className="spin" style={{ margin: '0 auto 16px' }} />
          <p className="muted">{t('Le réécriveur travaille… {sec} s', { sec })}</p>
        </div>
      )}

      {phase === 'review' && (<>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 0 10px' }}>
          {variants.map((_, i) => (
            <button key={i} className={`chip ${tab === i ? 'on' : ''}`} style={{ flex: 'none' }}
              onClick={() => setTab(i)}>
              {i === 0 ? t('Origine') : i}
              {i > 0 && chosen.has(i) && <span style={{ color: 'var(--acc)' }}>•</span>}
            </button>
          ))}
        </div>

        {tab === 0 ? (<>
          <p className="muted" style={{ fontSize: 13 }}>
            {t('L’original, pour comparaison. Il rejoint le lot tel quel et n’est jamais recalculé.')}
          </p>
          <div className="card" style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, color: 'var(--tx2)' }}>
            {variants[0] || '—'}
          </div>
        </>) : (<>
          <button className={`chip ${chosen.has(tab) ? 'on' : ''}`}
            onClick={() => setChosen(c => { const n = new Set(c); n.has(tab) ? n.delete(tab) : n.add(tab); return n })}>
            {chosen.has(tab) ? <><Ic n="check" s={15} /> {t('Sélectionnée')}</> : t('Non sélectionnée')}
          </button>
          <textarea className="field" style={{ marginTop: 10, minHeight: 200 }} value={variants[tab] ?? ''}
            onChange={e => setVariants(v => v.map((x, i) => (i === tab ? e.target.value : x)))} />
        </>)}

        <button className="cta" style={{ marginTop: 16 }} disabled={chosen.size === 0}
          onClick={() => void send()}>
          {tp(chosen.size, 'Générer {n} proposition', 'Générer {n} propositions')}
        </button>
        {chosen.size === 0 && (
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{t('Sélectionne au moins une variante.')}</p>
        )}
      </>)}

      {phase === 'sending' && (
        <div style={{ textAlign: 'center', padding: '36px 0' }}>
          <div className="spin" style={{ margin: '0 auto 16px' }} />
          <p className="muted">{t('Envoi… {done} / {total}', { done: sentN, total: chosen.size })}</p>
        </div>
      )}
    </Sheet>
  )
}
