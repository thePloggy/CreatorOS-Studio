/* ============================================================
   Re-shoot — un clip de la bibliothèque, un angle : le même instant
   filmé par une autre caméra (MoGe-2 → CrossViewWarp → LTX-2.5 + IC-LoRA
   CrossView-Warp, cf. server/jobs.js). Le rendu arrive dans la bibliothèque ;
   ici on voit la prise d'origine et la nouvelle côte à côte.
   ============================================================ */
import { nomMedia } from '../lib/nomMedia'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { poseA, type Pose } from './pose'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { JobCard } from './bits'
import { t, tServeur } from '../i18n'

const Scene3D = lazy(() => import('./Scene3D'))
const CLE = 'creatoros.reshoot.prises'
const lire = (): { job: string; source: string }[] => { try { return JSON.parse(localStorage.getItem(CLE) || '[]') } catch { return [] } }
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

/* az : degrés autour du sujet (négatif = gauche), el : hauteur. Les mouvements
   vont d'une pose à l'autre sur toute la durée du clip. */
const ANGLES: { id: string; label: string; az: number[]; el: number[] }[] = [
  { id: 'gauche', label: 'Côté gauche', az: [-35], el: [0] },
  { id: 'droite', label: 'Côté droit', az: [35], el: [0] },
  { id: 'trois-quarts', label: 'Trois-quarts', az: [-45], el: [10] },
  { id: 'plongee', label: 'Plongée', az: [15], el: [30] },
  { id: 'contre-plongee', label: 'Contre-plongée', az: [15], el: [-15] },
  { id: 'balayage', label: 'Balayage', az: [-35, 35], el: [5, 5] },
  { id: 'descente', label: 'Descente', az: [20, 20], el: [35, 0] },
  { id: 'orbite', label: 'Orbite', az: [-50, 50], el: [10, 10] },
]

/** Schéma vu de dessus : le sujet au centre, la caméra d'origine en bas, la nouvelle (ou sa course). */
function Schema({ az, el, on }: { az: number[]; el: number[]; on: boolean }) {
  const pt = (a: number, e: number) => { const r = 34 - e * 0.25, rad = (a * Math.PI) / 180; return [50 + r * Math.sin(rad), 50 + r * Math.cos(rad)] }
  const c = on ? 'var(--accent)' : 'var(--text)'
  const [x0, y0] = pt(az[0], el[0]), fin = az.length > 1 ? pt(az[1], el[1]) : null
  const arc = fin ? `M ${x0} ${y0} A ${34 - el[0] * 0.25} ${34 - el[0] * 0.25} 0 0 ${az[1] > az[0] ? 0 : 1} ${fin[0]} ${fin[1]}` : null
  return (
    <svg viewBox="0 0 100 100" style={{ width: 30, height: 30, flex: 'none' }}>
      <circle cx="50" cy="50" r="34" fill="none" stroke="var(--muted)" strokeOpacity=".55" strokeWidth="1.5" strokeDasharray="3 4" />
      <circle cx="50" cy="50" r="8" fill="var(--muted)" />
      <rect x="44" y="81" width="12" height="8" rx="2" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
      {arc && <path d={arc} fill="none" stroke={c} strokeWidth="3.5" markerEnd="url(#fl)" />}
      <defs><marker id="fl" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={c} /></marker></defs>
      {!fin && <circle cx={x0} cy={y0} r="7" fill={c} />}
      {!fin && <line x1={x0} y1={y0} x2="50" y2="50" stroke={c} strokeWidth="1.2" strokeDasharray="2 3" />}
      {el[el.length - 1] !== 0 && <text x="50" y="14" textAnchor="middle" fontSize="13" fill="var(--muted)">{el[el.length - 1] > 0 ? '▲' : '▼'} {Math.abs(el[el.length - 1])}°</text>}
    </svg>
  )
}

/** La sphère autour du sujet, vue de trois-quarts haut : où est la caméra d'origine (gris),
    où est la nouvelle (rose), la zone sûre du modèle, le trajet d'un mouvement. Elle se
    glisse comme l'image (droite = tourner à droite, haut = monter). */
const INCL = (22 * Math.PI) / 180
function proj(az: number, el: number) {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180
  const x = Math.sin(a) * Math.cos(e), y = Math.sin(e), z = Math.cos(a) * Math.cos(e)
  return { x: 50 + 38 * x, y: 50 - 38 * (y * Math.cos(INCL) - z * Math.sin(INCL)), devant: z * Math.cos(INCL) + y * Math.sin(INCL) > 0 }
}
function trace(pts: [number, number][]) {    // deux chemins : la face avant (pleine), l'arrière (pâle)
  let av = '', ar = '', prec: boolean | null = null
  for (const [az, el] of pts) {
    const p = proj(az, el), c = `${p.x.toFixed(1)} ${p.y.toFixed(1)}`
    if (p.devant) { av += (prec === true ? ' L ' : ' M ') + c } else { ar += (prec === false ? ' L ' : ' M ') + c }
    prec = p.devant
  }
  return { av, ar }
}
const pas = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n)
const GRILLE = (() => {
  const lignes = [...[-60, -30, 0, 30, 60].map(el => pas(-180, 180, 72).map(az => [az, el] as [number, number])),
    ...pas(-180, 150, 11).map(az => pas(-90, 90, 36).map(el => [az, el] as [number, number]))].map(trace)
  const zone = [...pas(-45, 45, 18).map(az => [az, -20]), ...pas(-20, 30, 10).map(el => [45, el]), ...pas(45, -45, 18).map(az => [az, 30]), ...pas(30, -20, 10).map(el => [-45, el])]
    .map(([az, el]) => { const p = proj(az, el); return `${p.x.toFixed(1)},${p.y.toFixed(1)}` }).join(' ')
  return { lignes, zone }
})()
function Sphere({ pose, base, cles, onPose }: { pose: Pose; base: Pose; cles: Pose[] | null; onPose: (p: Pose) => void }) {
  const tire = useRef<{ x: number; y: number; p: Pose } | null>(null)
  const c = proj(pose.az, pose.el), o = proj(0, 0)
  const chemin = cles ? trace(pas(0, 1, 30).map(k => { const q = poseA(cles, pose, k); return [q.az, q.el] as [number, number] })) : null
  return (
    <svg className="rs-sphere" viewBox="0 0 100 100"
      onPointerDown={e => { tire.current = { x: e.clientX, y: e.clientY, p: base }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={e => { const d = tire.current; if (!d) return
        onPose({ az: Math.round(Math.max(-90, Math.min(90, d.p.az + (e.clientX - d.x) * 1.1))), el: Math.round(Math.max(-35, Math.min(45, d.p.el - (e.clientY - d.y) * 0.9))) }) }}
      onPointerUp={() => { tire.current = null }}>
      <defs><radialGradient id="rs-boule" cx="38%" cy="32%" r="75%"><stop offset="0" stopColor="#3a3c46" /><stop offset="1" stopColor="#121318" /></radialGradient></defs>
      <circle cx="50" cy="50" r="38" fill="url(#rs-boule)" fillOpacity=".82" stroke="rgba(255,255,255,.22)" strokeWidth=".8" />
      {GRILLE.lignes.map((l, i) => <g key={i}><path d={l.ar} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth=".6" /><path d={l.av} fill="none" stroke="rgba(255,255,255,.2)" strokeWidth=".6" /></g>)}
      <polygon points={GRILLE.zone} fill="rgba(110,231,160,.13)" stroke="rgba(110,231,160,.45)" strokeWidth=".7" />
      <circle cx="50" cy="50" r="3" fill="#c9cad0" />
      <circle cx={o.x} cy={o.y} r="3.2" fill="#9a9ca3" stroke="#121318" strokeWidth=".8" />
      {chemin && <path d={chemin.av + chemin.ar} fill="none" stroke="#ffab5e" strokeWidth="1.6" />}
      <line x1="50" y1="50" x2={c.x} y2={c.y} stroke="#f24d8a" strokeWidth="1.1" strokeDasharray="2 2" opacity={c.devant ? 1 : 0.5} />
      <circle cx={c.x} cy={c.y} r="5" fill="#f24d8a" stroke="#fff" strokeWidth="1.2" opacity={c.devant ? 1 : 0.6} />
      <path d="M 4 50 l 5 -4 v 8 z M 96 50 l -5 -4 v 8 z M 50 4 l -4 5 h 8 z M 50 96 l -4 -5 h 8 z" fill="rgba(255,255,255,.45)" />
    </svg>
  )
}

/** Deux vidéos lues ensemble : la prise d'origine et le re-shoot. */
function CoteACote({ avant, apres }: { avant: string | null; apres: string }) {
  const a = useRef<HTMLVideoElement>(null), b = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = b.current; if (!v) return
    const sync = () => { if (a.current && Math.abs(a.current.currentTime - v.currentTime) > 0.08) a.current.currentTime = v.currentTime }
    v.addEventListener('timeupdate', sync); return () => v.removeEventListener('timeupdate', sync)
  }, [])
  return (
    <div className="rs-duo">
      {avant && <figure><video ref={a} src={avant} muted loop autoPlay playsInline /><figcaption>{t('Prise d’origine')}</figcaption></figure>}
      <figure><video ref={b} src={apres} loop autoPlay playsInline muted controls /><figcaption>{t('Nouvel angle')}</figcaption></figure>
    </div>
  )
}

export function ReshootView() {
  const s = useAppStore()
  const [clip, setClip] = useState<Asset | null>(null)
  // « Utiliser dans… » depuis la visionneuse : ce clip est déjà choisi
  useEffect(() => { const a = useAppStore.getState().prendrePasserelle('reshoot'); if (a) setClip(a) }, [])
  const [angle, setAngle] = useState('droite')
  const [pose, setPose] = useState<Pose>({ az: 35, el: 0 })
  const [cles, setCles] = useState<Pose[] | null>(null)       // mouvement : pose de début, pose de fin
  const [edite, setEdite] = useState<0 | 1>(1)                  // quelle pose du mouvement la souris règle
  const [tt, setTt] = useState(1)
  const [joue, setJoue] = useState(false)
  const [vue, setVue] = useState<'camera' | 'orbite'>('camera')
  const [tire, setTire] = useState(false)                     // l'indice « glisse » s'efface au premier glisser
  const [scene, setScene] = useState<{ id: string; url: string | null; err?: string } | null>(null)
  const [texte, setTexte] = useState('')
  const [prises, setPrises] = useState(lire)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { try { localStorage.setItem(CLE, JSON.stringify(prises.slice(0, 40))) } catch { /* stockage indisponible */ } }, [prises])
  const clips = useMemo(() => s.assets.filter(a => a.mediaType === 'video' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt).slice(0, 80), [s.assets])

  // la scène 3D du clip choisi (calculée par le serveur au premier choix, ~quelques s)
  useEffect(() => {
    if (!clip) return
    let vivant = true
    setScene({ id: clip.id, url: null })
    void fetch('/api/reshoot/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: clip.id }) })
      .then(json).then(d => { if (vivant) setScene({ id: clip.id, url: d.url }) })
      .catch(e => { if (vivant) setScene({ id: clip.id, url: null, err: String((e as Error).message) }) })
    return () => { vivant = false }
  }, [clip?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  // lecture du mouvement dans l'aperçu
  useEffect(() => {
    if (!joue) return
    let t0: number | null = null, id = 0
    const pas = (ts: number) => { t0 ??= ts; const k = (ts - t0) / 3000; setTt(Math.min(1, k)); if (k < 1) id = requestAnimationFrame(pas); else setJoue(false) }
    id = requestAnimationFrame(pas); return () => cancelAnimationFrame(id)
  }, [joue])

  const choisir = (a: typeof ANGLES[number]) => {
    setAngle(a.id)
    if (a.az.length > 1) { setCles([{ az: a.az[0], el: a.el[0] }, { az: a.az[1], el: a.el[1] }]); setEdite(1); setTt(0); setJoue(true) }
    else { setCles(null); setPose({ az: a.az[0], el: a.el[0] }); setTt(1) }
  }
  const regler = (p: Pose) => {
    setAngle('libre')
    if (cles) { const c = [...cles]; c[edite] = p; setCles(c); setTt(edite) }
    else setPose(p)
  }
  const courant = cles ? cles[edite] : pose
  const ratio = clip?.width && clip?.height ? clip.width / clip.height : 9 / 16
  const go = async () => {
    if (!clip) return
    setBusy(true); setErr(null)
    const corps = angle !== 'libre' ? { angle } : cles ? { cles: [{ t: 0, ...cles[0] }, { t: 1, ...cles[1] }] } : { azimut: pose.az, elevation: pose.el }
    try {
      const r = await json(await fetch('/api/reshoot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: clip.id, texte, ...corps }) }))
      void s.adoptServerJob(r.id)
      setPrises(p => [{ job: r.id, source: clip.id }, ...p])
    } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  const queueIds = s.jobs.filter(j => j.status === 'queued').map(j => j.id)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div>
          <h2 className="titre-outil">{t('Re-shoot')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Un clip, un nouvel angle : le même instant filmé par une deuxième caméra.')}</div>
        </div>
        <div className="carte-reel" style={{ background: 'var(--lv1)', borderRadius: 18, padding: 16, display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('1. Le clip')}</div>
            <div className="pkgrid rs-clips" style={{ maxHeight: 250 }}>
              {clips.map(a => (
                <button key={a.id} className="pk" aria-label={nomMedia(a)} onClick={() => setClip(a)} style={{ outline: clip?.id === a.id ? '3px solid var(--accent)' : undefined }}>
                  <video src={a.uri} muted loop playsInline preload="metadata"
                    onMouseEnter={e => void e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()} />
                </button>
              ))}
              {!clips.length && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 11, padding: 12 }}>{t('rien dans la bibliothèque')}</div>}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('2. L’angle')}</div>
            <div className="rs-scene">
              <div className="rs-3d-cadre" style={{ '--ar': ratio, aspectRatio: String(ratio) } as CSSProperties}>
                {!clip ? <div className="rs-3d-vide">{t('Choisis un clip : sa scène 3D apparaît ici.')}</div>
                  : scene?.err ? <div className="rs-3d-vide" style={{ color: 'var(--danger)' }}>{scene.err}</div>
                  : !scene?.url ? <div className="rs-3d-vide">{t('lecture de la géométrie du clip…')}</div>
                  : <Suspense fallback={<div className="rs-3d-vide">…</div>}>
                      <Scene3D url={scene.url} pose={pose} cles={cles} t={tt} vue={vue} onPose={p => { setTire(true); regler(p) }} />
                    </Suspense>}
                <div className="rs-3d-haut">
                  <button className={`wtab ${vue === 'camera' ? 'on' : ''}`} onClick={() => setVue('camera')}>{t('Vue caméra')}</button>
                  <button className={`wtab ${vue === 'orbite' ? 'on' : ''}`} onClick={() => setVue('orbite')}>{t('Vue orbite')}</button>
                  <span style={{ flex: 1 }} />
                  {cles && <button className="wtab on" onClick={() => { setTt(0); setJoue(true) }}>▶ {t('le mouvement')}</button>}
                </div>
                {scene?.url && vue === 'camera' && <>
                  <Sphere pose={poseA(cles, pose, tt)} cles={cles} onPose={p => { setTire(true); regler(p) }} base={courant} />
                  {!tire && <div className="rs-3d-indice">⟷ {t('glisse l’image')}</div>}
                </>}
              </div>
              {cles && <input type="range" className="rs-scrub" min={0} max={1000} value={Math.round(tt * 1000)} onChange={e => { setJoue(false); setTt(Number(e.target.value) / 1000) }} />}
              <div className="rs-legende">
                {vue === 'camera' ? t('Glisse l’image ou la sphère pour tourner autour d’elle. En flou : ce que la première caméra n’a jamais vu, que le modèle va inventer.')
                  : t('En gris la caméra d’origine, en rose la nouvelle, en orange son trajet. Glisse pour tourner autour de la scène.')}
              </div>
            </div>
            <div className="rs-barre">
              <div className="flex gap-1">
                <button className={`wtab ${!cles ? 'on' : ''}`} onClick={() => { setAngle('libre'); setCles(null); setTt(1) }}>{t('Plan fixe')}</button>
                <button className={`wtab ${cles ? 'on' : ''}`} onClick={() => { setAngle('libre'); setCles(cles ?? [{ az: -pose.az || -30, el: pose.el }, pose]); setEdite(1); setTt(1) }}>{t('Mouvement')}</button>
              </div>
              {cles && <div className="flex gap-1">
                <button className={`wtab ${edite === 0 ? 'on' : ''}`} onClick={() => { setEdite(0); setTt(0) }}>{t('Début')}</button>
                <button className={`wtab ${edite === 1 ? 'on' : ''}`} onClick={() => { setEdite(1); setTt(1) }}>{t('Fin')}</button>
              </div>}
              <label>{t('Autour d’elle')}
                <input type="range" min={-90} max={90} value={courant.az} onChange={e => regler({ ...courant, az: Number(e.target.value) })} />
                <b>{courant.az > 0 ? '+' : ''}{courant.az}°</b></label>
              <label>{t('Hauteur')}
                <input type="range" min={-35} max={45} value={courant.el} onChange={e => regler({ ...courant, el: Number(e.target.value) })} />
                <b>{courant.el > 0 ? '+' : ''}{courant.el}°</b></label>
            </div>
            {Math.abs(courant.az) > 45 || courant.el > 30 || courant.el < -20
              ? <div className="rs-alerte">{t('hors de la zone sûre (±45°, −20° à +30°) : le modèle invente davantage')}</div>
              : Math.abs(courant.az) < 8 && Math.abs(courant.el) < 8 ? <div className="rs-alerte">{t('trop proche de la prise d’origine : le modèle s’y prend mal')}</div> : null}
            <div className="rs-presets">
              <span>{t('Raccourcis')}</span>
              {ANGLES.map(a => (
                <button key={a.id} className={`rs-angle ${angle === a.id ? 'on' : ''}`} onClick={() => choisir(a)}>
                  <Schema az={a.az} el={a.el} on={angle === a.id} />
                  <span>{t(a.label)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={texte} onChange={e => setTexte(e.target.value)} maxLength={300} placeholder={t('3. Optionnel : ce que la nouvelle caméra découvre (en anglais)')}
              style={{ flex: 1, minWidth: 240, padding: '9px 11px', borderRadius: 10, background: 'var(--lv2)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12.5 }} />
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('LTX-2.5 · IC-LoRA CrossView · ~2 min pour 4 s')}</span>
            <button className="cta" style={{ padding: '10px 18px', flexDirection: 'row' }} disabled={!clip || busy} onClick={() => void go()}>{busy ? '…' : `🎥 ${t('Re-tourner')}`}</button>
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
        </div>

        {prises.length > 0 && <div style={{ display: 'grid', gap: 12 }}>
          {prises.map(p => {
            const j = s.jobs.find(x => x.id === p.job)
            const rendu = s.assets.find(a => a.jobId === p.job && a.mediaType === 'video')
            const src = s.assets.find(a => a.id === p.source)
            if (!rendu && !(j && STATUTS_ACTIFS.includes(j.status))) return null
            return (
              <div key={p.job} className="rs-prise">
                {rendu ? <CoteACote avant={src?.uri ?? null} apres={rendu.uri} /> : j && <div style={{ width: 220 }}><JobCard j={j} queueIds={queueIds} /></div>}
              </div>
            )
          })}
        </div>}
      </div>
    </div>
  )
}
