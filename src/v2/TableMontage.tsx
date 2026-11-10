/* ============================================================
   Table de montage du Movie Studio : les images clés posées sur une frise,
   chacune à son instant, une action par segment, et un seul plan LTX-2.5
   (16 s au plus) qui passe par toutes les images.

   Le serveur pose chaque image en guide à son index (cf. ltxImagesCles,
   server/comfy.js) ; le prompt est minuté segment par segment, avec le
   personnage et sa tenue mot pour mot (sans eux, LTX habille le personnage
   à sa façon d'un segment à l'autre) et la lumière et la caméra de la fiche.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, JobCard } from './bits'
import { VERSION_HOWTO } from './HowItWorks'
import { STATUTS_ACTIFS } from '../types'
import { FramePicker } from './popups'
import { t, getLang } from '../i18n'

export type CleTable = { assetId: string; uri: string; t: number }
/** Le dernier plan envoyé : son job, et l'instant de chaque image clé tel qu'il a été rendu (base de l'aperçu de vitesse). */
/* uri / assetId : le clip d'un film de la liste (il peut ne pas être parmi les assets chargés). */
export type Rendu = { jobId: string; duree: number; cles: { assetId: string; t: number }[]; uri?: string; assetId?: string }
export type Etat = { duree: number; cles: CleTable[]; actions: string[]; perso: string; son: boolean; rendu?: Rendu | null }

const CLE = 'cine:table'
const DUREES = [6, 8, 10, 12, 16]
const PAS = 1 / 3   // index LTX multiples de 8 images à 24 i/s
export const TABLE_VIDE: Etat = { duree: 16, cles: [], actions: [], perso: '', son: true, rendu: null }
const lire = (): Etat => {
  try { const v = JSON.parse(localStorage.getItem(CLE) ?? 'null'); if (v?.cles) return { duree: 16, actions: [], perso: '', son: true, ...v } } catch { /* vide */ }
  return { duree: 16, cles: [], actions: [], perso: '', son: true }
}
const sec = (x: number) => x.toFixed(1).replace('.', ',')
const accroche = (x: number, d: number) => Math.max(0, Math.min(d, Math.round(x / PAS) * PAS))

/** Ajout depuis ailleurs (les prises de la fiche) : l'image arrive en fin de frise. */
export function ajouterALaTable(a: Pick<Asset, 'id' | 'uri'>) {
  const e = lire()
  if (e.cles.some(c => c.assetId === a.id)) return
  const t0 = e.cles.length ? Math.min(e.duree, Math.max(...e.cles.map(c => c.t)) + 3) : 0
  e.cles = [...e.cles, { assetId: a.id, uri: a.uri, t: accroche(t0, e.duree) }].sort((x, y) => x.t - y.t)
  localStorage.setItem(CLE, JSON.stringify(e))
  window.dispatchEvent(new Event('cine:table'))
}

export function TableMontage({ style }: { style: string }) {
  const s = useAppStore()
  const [e, setE] = useState<Etat>(lire)
  const [choix, setChoix] = useState(false)
  const [envoi, setEnvoi] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; texte: string } | null>(null)
  const [voir, setVoir] = useState(false)
  const frise = useRef<HTMLDivElement>(null)
  const glisse = useRef<string | null>(null)

  useEffect(() => { localStorage.setItem(CLE, JSON.stringify(e)) }, [e])
  useEffect(() => {
    const maj = () => setE(lire())
    window.addEventListener('cine:table', maj)
    return () => window.removeEventListener('cine:table', maj)
  }, [])

  const cles = [...e.cles].sort((a, b) => a.t - b.t)
  const segments = cles.slice(0, -1).map((c, i) => ({ de: c.t, a: cles[i + 1].t }))
  const majCles = (f: (c: CleTable[]) => CleTable[]) => setE(x => ({ ...x, cles: f(x.cles).sort((a, b) => a.t - b.t) }))

  // glisser une image le long de la frise (souris et doigt)
  const deplacer = (clientX: number) => {
    const r = frise.current?.getBoundingClientRect(); const id = glisse.current
    if (!r || !id) return
    const t0 = accroche(((clientX - r.left) / r.width) * e.duree, e.duree)
    majCles(l => l.map(c => c.assetId === id ? { ...c, t: t0 } : c))
  }
  useEffect(() => {
    const bouge = (ev: PointerEvent) => { if (glisse.current) deplacer(ev.clientX) }
    const lache = () => { glisse.current = null }
    window.addEventListener('pointermove', bouge); window.addEventListener('pointerup', lache)
    return () => { window.removeEventListener('pointermove', bouge); window.removeEventListener('pointerup', lache) }
  })

  const prompt = (() => {
    // le prompt est en anglais : instants avec un point (« 4.7 s »), pas la virgule de l'affichage
    const en = (x: number) => x.toFixed(1)
    const morceaux = segments.map((g, i) => (e.actions[i] ?? '').trim() ? `${en(g.de)}-${en(g.a)} s: ${(e.actions[i] ?? '').trim().replace(/[.\s]+$/, '')}.` : '').filter(Boolean)
    return [
      `Cinematic film shot, one continuous take, ${e.duree} seconds.`,
      e.perso.trim() ? `${e.perso.trim().replace(/[.\s]+$/, '')}; the same person and the same outfit for the whole shot.` : '',
      style.trim(),
      ...morceaux,
      'Real-time speed, no cuts, no dissolve, no scene change.',
    ].filter(Boolean).join(' ').replace(/\.\./g, '.')
  })()

  async function envoyer() {
    if (cles.length < 2) { setMsg({ ok: false, texte: t('Pose au moins deux images sur la frise.') }); return }
    setEnvoi(true); setMsg(null)
    try {
      const fichiers: { filename: string; width: number; height: number }[] = []
      for (const c of cles) {
        if (c.assetId.startsWith('up:')) {   // image envoyée depuis l'ordinateur : déjà dans input/
          const im = new Image(); im.src = c.uri; await im.decode()
          fichiers.push({ filename: c.assetId.slice(3), width: im.naturalWidth, height: im.naturalHeight }); continue
        }
        const r = await fetch(`/api/assets/${encodeURIComponent(c.assetId)}/to-input`, { method: 'POST' })
        const b = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`)
        fichiers.push(b)
      }
      const id = `table-${Date.now().toString(36)}`
      const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id, personaId: s.personaId, register: 'sfw', purpose: 'creative', concatFrom: 'media', videoSpeed: 1, mode: 'video', op: 'generate',
        workflowFile: 'PROD_video_ltx_hq.json', videoEngine: 'ltx_hq', withAudio: e.son,
        sourceImage: fichiers[0].filename, keyframes: cles.map((c, i) => ({ image: fichiers[i].filename, t: c.t })),
        seed: { mode: 'random' }, videoSeconds: e.duree, videoFps: 24, videoAspect: 'origine', videoSrcW: fichiers[0].width, videoSrcH: fichiers[0].height,
        userPrompt: prompt, composedPositive: prompt,
        composedNegative: 'dissolve, crossfade, cut, scene change, morphing, extra limbs, deformed, text, watermark',
      }) })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`)
      await s.adoptServerJob(id)
      const rendu = { jobId: id, duree: e.duree, cles: cles.map(c => ({ assetId: c.assetId, t: c.t })) }
      setE(x => ({ ...x, rendu }))
      // le plan envoyé devient un film de la liste de Movie Studio (fiche, prises et table du moment)
      window.dispatchEvent(new CustomEvent('cine:film-envoye', { detail: { jobId: id, table: { ...e, rendu } } }))
      setMsg({ ok: true, texte: t('Plan envoyé à LTX : il arrive dans la bibliothèque.') })
    } catch (err) { setMsg({ ok: false, texte: String((err as Error).message ?? err) }) }
    setEnvoi(false)
  }

  /* ---- aperçu de vitesse : le clip rendu, rejoué segment par segment à la vitesse des nouveaux instants ---- */
  const clip: { id: string; uri: string } | undefined = e.rendu
    ? (s.assets.find(x => x.jobId === e.rendu!.jobId && x.mediaType === 'video') ?? (e.rendu.uri ? { id: e.rendu.assetId ?? '', uri: e.rendu.uri } : undefined))
    : undefined
  const [confirmer, setConfirmer] = useState(false)
  const jobRendu = e.rendu ? s.jobs.find(j => j.id === e.rendu!.jobId) : undefined
  const points = (() => {
    const r = e.rendu
    if (!r) return []
    const p = r.cles.map(o => ({ src: o.t, dst: cles.find(c => c.assetId === o.assetId)?.t ?? o.t })).sort((x, y) => x.src - y.src)
    return [{ src: 0, dst: 0 }, ...p.filter(x => x.src > 0.05 && x.src < r.duree - 0.05), { src: r.duree, dst: p.find(x => x.src >= r.duree - 0.05)?.dst ?? e.duree }]
  })()
  const modifie = points.some(p => Math.abs(p.src - p.dst) > 0.05)
  const ordreOk = points.every((p, i) => i === 0 || p.dst > points[i - 1].dst + 0.1)
  const video = useRef<HTMLVideoElement>(null)
  const [tete, setTete] = useState<number | null>(null)
  useEffect(() => {
    let raf = 0
    const boucle = () => {
      const v = video.current
      if (v && points.length > 1) {
        const x = v.currentTime
        const i = Math.max(1, points.findIndex(p => p.src > x))
        const a0 = points[i - 1], a1 = points[i] ?? points[points.length - 1]
        const k = a1.src > a0.src && a1.dst > a0.dst ? (a1.src - a0.src) / (a1.dst - a0.dst) : 1
        const r = Math.max(0.25, Math.min(4, k))
        if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r
        setTete(a0.dst + (x - a0.src) * (a1.src > a0.src ? (a1.dst - a0.dst) / (a1.src - a0.src) : 1))
      }
      raf = requestAnimationFrame(boucle)
    }
    raf = requestAnimationFrame(boucle)
    return () => cancelAnimationFrame(raf)
  })
  async function appliquerVitesse() {
    if (!clip?.id) return
    setEnvoi(true); setMsg(null)
    try {
      const r = await fetch(`/api/assets/${encodeURIComponent(clip.id)}/retemps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: points.slice(1) }) })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`)
      await s.adoptServerJob(b.jobId)
      setMsg({ ok: true, texte: t('Vitesse appliquée : le nouveau clip est dans la bibliothèque.') })
    } catch (err) { setMsg({ ok: false, texte: String((err as Error).message ?? err) }) }
    setEnvoi(false)
  }

  const graduations = Array.from({ length: e.duree + 1 }, (_, i) => i)
  return (
    <section className="carte-reel table-montage" aria-label={t('Table de montage')}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="titre-outil" style={{ fontSize: 18 }}>{t('Table de montage')}</h3>
        <span style={{ flex: 1 }} />
        <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{t('Durée')}</span>
        {DUREES.map(d => <button key={d} className={`wtab ${e.duree === d ? 'on' : ''}`} onClick={() => setE(x => ({ ...x, duree: d, cles: x.cles.map(c => ({ ...c, t: Math.min(c.t, d) })) }))}>{d} s</button>)}
      </div>

      <div className="tm-apercu">
        {clip ? <video ref={video} src={clip.uri} controls loop playsInline preload="auto" />
          : jobRendu && STATUTS_ACTIFS.includes(jobRendu.status)
            ? <div className="tm-rendu"><JobCard j={jobRendu} queueIds={s.jobs.filter(j => j.status === 'queued').map(j => j.id)} /></div>
            : jobRendu && ['failed', 'blocked', 'cancelled'].includes(jobRendu.status)
              ? <div className="tm-attente">{t('Le rendu a échoué : déplace ou change une image clé, puis relance.')}</div>
              : (<figure className="tm-demo">
                  {/* tant qu'aucun plan n'est rendu : la démonstration de la table, en boucle */}
                  <video src={`/danses/howto/cinema-table-demo${getLang() === 'en' ? '-en' : ''}.mp4?v=${VERSION_HOWTO}`} poster={`/danses/howto/cinema-table-demo${getLang() === 'en' ? '-en' : ''}.jpg?v=${VERSION_HOWTO}`} muted loop playsInline autoPlay aria-hidden />
                  <figcaption>{t('Pose tes images clés sur la frise, écris ce qui se passe entre elles, envoie : un seul plan passe par chacune.')}</figcaption>
                </figure>)}
      {e.rendu && (<>
          {clip && <div className="tm-apercu-aide">{modifie
            ? (ordreOk ? t('Aperçu à la nouvelle vitesse : déplace une image clé plus tôt pour accélérer le segment, plus tard pour le ralentir.') : t('Les images clés doivent rester dans l’ordre du rendu.'))
            : t('Déplace une image clé sur la frise : l’aperçu rejoue le clip à la nouvelle vitesse, en direct.')}</div>}
      </>)}
      </div>
      <div className="tm-frise-cadre">
        <div className="tm-frise" ref={frise} style={{ minWidth: e.duree * 64 }}>
          {graduations.map(i => <span key={i} className="tm-grad" style={{ left: `${(i / e.duree) * 100}%` }}><i />{i % 2 === 0 || e.duree <= 8 ? <small>{i} s</small> : null}</span>)}
          {segments.map((g, i) => <span key={i} className="tm-segment" style={{ left: `${(g.de / e.duree) * 100}%`, width: `${((g.a - g.de) / e.duree) * 100}%` }}>
            {/* durée du passage d'une image à la suivante : ce que durera ce morceau du plan */}
            <small title={t('durée entre ces deux images')}>{sec(g.a - g.de)} s</small>
          </span>)}
          {cles.map(c => (
            <div key={c.assetId} className="tm-cle" style={{ left: `${(c.t / e.duree) * 100}%` }}
              onPointerDown={ev => { ev.preventDefault(); glisse.current = c.assetId }}>
              <img src={c.uri} alt="" draggable={false} />
              <small>{sec(c.t)} s</small>
              <button className="tm-retirer" title={t('retirer de la frise')} aria-label={t('retirer de la frise')}
                onPointerDown={ev => ev.stopPropagation()} onClick={() => majCles(l => l.filter(x => x.assetId !== c.assetId))}><Ic n="x" s={11} /></button>
            </div>
          ))}
          {clip && tete != null && <span className="tm-tete" style={{ left: `${(Math.min(e.duree, tete) / e.duree) * 100}%` }} />}
          {!cles.length && <div className="tm-vide">
            <button className="cta tm-cta" onClick={() => setChoix(true)}><Ic n="plus" s={16} /> {t('Ajouter une image clé')}</button>
            <small>{t('ou « Sur la table » sous une prise de la fiche')}</small>
          </div>}
        </div>
      </div>
      <div className="flex gap-2 flex-wrap" style={{ marginTop: 8 }}>
        {cles.length > 0 && <button className="cta tm-ajout" onClick={() => setChoix(true)}><Ic n="plus" s={14} /> {t('Image clé')}</button>}
        {cles.length > 0 && <button className="pill tool" onClick={() => {
          const n = cles.length
          majCles(l => l.map(c => ({ ...c, t: accroche((cles.findIndex(x => x.assetId === c.assetId) / Math.max(1, n - 1)) * e.duree, e.duree) })))
        }}>{t('Répartir')}</button>}
        {cles.length > 0 && <button className="pill tool" onClick={() => setE(x => ({ ...x, cles: [], actions: [] }))}>{t('Vider')}</button>}
      </div>

      {segments.length > 0 && (
        <div className="tm-actions">
          {segments.map((g, i) => (
            <label key={i} className="tm-action">
              <span>{sec(g.de)} → {sec(g.a)} s</span>
              <input value={e.actions[i] ?? ''} placeholder={t('Ce qui se passe, en anglais : action, mouvement de caméra…')}
                onChange={ev => setE(x => { const a = [...x.actions]; a[i] = ev.target.value; return { ...x, actions: a } })} />
            </label>
          ))}
        </div>
      )}

      <label className="tm-perso">
        <span>{t('Personnage et tenue, mot pour mot')}</span>
        <textarea rows={2} value={e.perso} onChange={ev => setE(x => ({ ...x, perso: ev.target.value }))}
          placeholder={t('Ex. « She is a woman with long auburn hair under a dark cowboy hat, wearing a brown leather duster coat, riding a black horse »')} />
      </label>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
        <button className={`wtab tm-son ${e.son ? 'on' : ''}`} onClick={() => setE(x => ({ ...x, son: !x.son }))} aria-pressed={e.son}
          title={e.son ? t('Son activé : LTX génère l’ambiance et les bruitages avec l’image. Clique pour couper.') : t('Son coupé : le plan sera muet. Clique pour l’activer.')}>
          <Ic n={e.son ? 'sound' : 'soundOff'} s={15} /> {e.son ? t('Son') : t('Muet')}</button>
        <button className="cine-voir" onClick={() => setVoir(!voir)}>{voir ? '▾' : '▸'} {t('Ce que lit le moteur')}</button>
        <span style={{ flex: 1 }} />
        {/* Recommencer : tout effacer (fiche, prises, table), après confirmation dans la page */}
        {confirmer
          ? <span className="tm-confirmer" role="alert">{t('Tout effacer : fiche, prises et table ?')}
              <button className="pill" style={{ color: 'var(--danger)' }} onClick={() => { setE({ ...TABLE_VIDE }); setConfirmer(false); setMsg(null); window.dispatchEvent(new Event('cine:recommencer')) }}>{t('Effacer')}</button>
              <button className="pill tool" onClick={() => setConfirmer(false)}>{t('Annuler')}</button></span>
          : <button className="pill tool" onClick={() => setConfirmer(true)} title={t('Efface la fiche, les prises et la table pour repartir de zéro')}><Ic n="refresh" s={13} /> {t('Recommencer')}</button>}
        {clip?.id && modifie && ordreOk && <button className="pill" disabled={envoi} onClick={() => void appliquerVitesse()} title={t('ffmpeg recalcule la vitesse du clip rendu, segment par segment, image et son : quelques secondes')}><Ic n="refresh" s={13} /> {t('Appliquer la vitesse')}</button>}
        <button className="cta" style={{ padding: '10px 20px', flexDirection: 'row' }} disabled={envoi || cles.length < 2} onClick={() => void envoyer()}>
          {envoi ? '…' : <><Ic n="film" s={15} /> {clip && modifie ? t('Relancer avec ces instants') : t('Envoyer à LTX')}</>} <small style={{ marginLeft: 6 }}>{e.duree} s · {cles.length} {t('images')}</small>
        </button>
      </div>
      {voir && <div className="cine-prompt">{prompt}</div>}
      {msg && <div role="status" style={{ fontSize: 12, marginTop: 6, color: msg.ok ? 'var(--positif)' : 'var(--danger)' }}>{msg.texte}</div>}

      <FramePicker open={choix} onClose={() => setChoix(false)} assets={s.assets} title={t('Image clé de la frise')}
        onPickAsset={a => { ajouterALaTable(a); setE(lire()) }}
        onPickUpload={n => { ajouterALaTable({ id: `up:${n}`, uri: `/api/uploads/${encodeURIComponent(n)}` }); setE(lire()) }} />
    </section>
  )
}

/* ---------- rouvrir un plan rendu dans la table ----------
   La provenance d'un plan de la table garde ses images clés (retrouvées dans la bibliothèque) et son prompt
   minuté : on en refait l'état de la table — images à leur instant, actions par segment, personnage et tenue. */
type ProvTable = { keyframes?: { assetId: string; uri: string; t: number }[] | null; videoSeconds?: number | null; withAudio?: boolean | null; composedPositive?: string | null; userPrompt?: string | null }
export function etatDepuisProvenance(p: ProvTable, jobId?: string | null): Etat | null {
  const cles = (p.keyframes ?? []).filter(k => k.assetId && Number.isFinite(k.t))
  if (cles.length < 2) return null
  const texte = p.composedPositive || p.userPrompt || ''
  const duree = Number(p.videoSeconds) || Math.max(...cles.map(c => c.t)) || 16
  const tries = [...cles].sort((a, b) => a.t - b.t)
  // « 0.0-4.7 s: action. » jusqu'au segment suivant ou à « Real-time speed »
  const segs = [...texte.matchAll(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*s:\s*(.*?)(?=\s\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?\s*s:|\sReal-time speed|$)/g)]
    .map(m => ({ de: Number(m[1].replace(',', '.')), a: Number(m[2].replace(',', '.')), texte: m[3].trim().replace(/\.$/, '') }))
  const actions = tries.slice(0, -1).map((c, i) => segs.find(s => Math.abs(s.de - c.t) < 0.25 && Math.abs(s.a - tries[i + 1].t) < 0.25)?.texte ?? segs[i]?.texte ?? '')
  // le personnage : la phrase après « N seconds. », jusqu'à « ; the same … »
  const perso = texte.match(/seconds\.\s*(.*?);\s*the same/)?.[1]?.trim() ?? ''
  return { duree: Math.min(16, Math.max(6, Math.round(duree))), cles: tries.map(c => ({ assetId: c.assetId, uri: c.uri, t: Math.min(c.t, duree) })), actions, perso, son: p.withAudio !== false,
    // le clip rouvert devient « le dernier rendu » : il s'affiche dans l'aperçu et sert à l'aperçu de vitesse
    rendu: jobId ? { jobId, duree: Math.round(duree), cles: tries.map(c => ({ assetId: c.assetId, t: c.t })) } : null }
}
/** Pose cet état dans la table (Movie Studio le lit à l'ouverture). */
export function ouvrirDansTable(e: Etat) {
  localStorage.setItem(CLE, JSON.stringify(e))
  window.dispatchEvent(new Event('cine:table'))
}
/** L'état de table d'un rendu vidéo s'il vient de la table de montage, sinon null (provenance lue une fois). */
export function useRenduTable(asset: Asset): Etat | null {
  const [etat, setEtat] = useState<Etat | null>(null)
  useEffect(() => {
    setEtat(null)
    if (asset.mediaType !== 'video') return
    let fini = false
    void fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`).then(r => r.ok ? r.json() : null)
      .then((p: ProvTable | null) => { if (!fini && p) setEtat(etatDepuisProvenance(p, asset.jobId)) }).catch(() => {})
    return () => { fini = true }
  }, [asset.id, asset.mediaType, asset.jobId])
  return etat
}
