/* ============================================================
   Galerie « Caméra & effets » — des cartes qui tournent en boucle,
   une photo, un clic : le clip part dans la file de rendu ordinaire et arrive
   dans la bibliothèque (onglet Vidéo). Les presets vivent côté serveur
   (server/presets.js) ; ici on choisit et on lance.
   ============================================================ */
import { APERCUS, ApercuOutil } from './Apercus'
import type { IdOutil } from './OutilsDedies'
import { nomMedia } from '../lib/nomMedia'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { getLang, t, tServeur } from '../i18n'
import { vignetteOf } from '../components/AssetMedia'

interface Preset { id: string; famille: 'camera' | 'effet'; nom: string; nomEn: string; icone: string; lora: string | null; apercu: string | null; moteur: 'ltx_hq' | 'wan21' | 'wan21_hq'; deuxRendus?: boolean }
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

/** Un aperçu ne se télécharge et ne joue que lorsqu'il est à l'écran. */
function VideoVisible({ src, style }: { src: string; style: React.CSSProperties }) {
  const v = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = v.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) void el.play().catch(() => {}); else el.pause() }, { rootMargin: '100px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return <video ref={v} src={src} muted loop playsInline preload="none" style={style} />
}

/* Outils sur un clip : la même vignette qu'à l'accueil (vrais rendus), un clic ouvre la page de l'outil. */
const OUTILS_CLIP: { label: string; texte: string; dedie?: IdOutil }[] = [
  { label: 'Remove Objects', texte: 'Retire une personne ou un objet du clip : le décor derrière est reconstitué.', dedie: 'remove-objects' },
  { label: 'Change Background', texte: 'Le sujet reste, le décor du clip change : décris le nouveau.', dedie: 'change-bg' },
  { label: 'Green Screen', texte: 'SAM3 garde le sujet, rien n’est redessiné.', dedie: 'green-screen' },
  { label: 'Add Sound', texte: 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).', dedie: 'add-sound' },
  { label: 'Smooth Motion', texte: 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.', dedie: 'smooth' },
  { label: 'Upscale 1080p', texte: 'SeedVR2 monte le clip en 1080p.', dedie: 'upscale' },
  { label: 'Extend Video', texte: 'Le clip continue : quelques secondes de plus, dans le même mouvement.' },
]

export function PresetsView({ goVideo }: { goVideo: () => void }) {
  const ouvrirOutilClip = (o: { dedie?: IdOutil }) => {
    if (!o.dedie) { useAppStore.getState().updateVideo({ task: 'extend' }); goVideo(); return }
    useAppStore.setState(st => ({ outilDedie: o.dedie!, navRequest: { section: 'outil', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
  }
  const [presets, setPresets] = useState<Preset[]>([])
  const [ouvert, setOuvert] = useState<Preset | null>(null)
  const [famille, setFamille] = useState<'camera' | 'effet' | 'clip'>(() => useAppStore.getState().famillePresets ?? 'camera')
  // le menu ouvre Camera Moves ou Effects : la galerie suit, à l'ouverture comme déjà ouverte
  const demandee = useAppStore(st => st.famillePresets)
  useEffect(() => { if (demandee) { setFamille(demandee); useAppStore.setState({ famillePresets: null }) } }, [demandee])
  // « Utiliser dans… » depuis la visionneuse : la photo est déjà choisie, il reste le mouvement
  const [photoVenue, setPhotoVenue] = useState<Asset | null>(null)
  useEffect(() => { setPhotoVenue(useAppStore.getState().prendrePasserelle('presets')) }, [])
  useEffect(() => { void fetch('/api/presets').then(json).then(d => setPresets(d.presets ?? [])).catch(() => {}) }, [])
  const liste = presets.filter(p => p.famille === famille)
  const nom = (p: Preset) => getLang() === 'en' ? p.nomEn : p.nom
  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <h2 className="titre-outil">{famille === 'effet' ? 'Effects' : famille === 'clip' ? t('Sur un clip') : 'Camera Moves'}</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{photoVenue
              ? t('Photo choisie : il reste à choisir un mouvement.')
              : t('Choisis un mouvement, choisis une photo : le clip arrive dans ta bibliothèque.')}</div>
          </div>
          <span style={{ flex: 1 }} />
          <div className="wtabs">
            <button className={`wtab ${famille === 'camera' ? 'on' : ''}`} onClick={() => setFamille('camera')}>{t('Mouvements de caméra')}</button>
            {presets.some(p => p.famille === 'effet') && <button className={`wtab ${famille === 'effet' ? 'on' : ''}`} onClick={() => setFamille('effet')}>{t('Effets')}</button>}
            <button className={`wtab ${famille === 'clip' ? 'on' : ''}`} onClick={() => setFamille('clip')}>{t('Sur un clip')}</button>
          </div>
        </div>
        {famille === 'clip' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {OUTILS_CLIP.map(o => (
              <button key={o.label} onClick={() => ouvrirOutilClip(o)} style={{ borderRadius: 14, border: 0, padding: 0, overflow: 'hidden', cursor: 'pointer', textAlign: 'left', color: 'var(--text)', background: 'var(--lv2)', display: 'grid' }}>
                <span style={{ aspectRatio: '4 / 3', display: 'block', overflow: 'hidden', position: 'relative', pointerEvents: 'none' }}><ApercuOutil apercu={APERCUS[o.label]} /></span>
                <span style={{ display: 'grid', gap: 5, padding: '12px 14px 14px' }}>
                  <b style={{ fontSize: 14 }}>{o.label}</b>
                  <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{t(o.texte)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          {liste.map(p => (
            <button key={p.id} onClick={() => setOuvert(p)}
              style={{ position: 'relative', aspectRatio: '9 / 14', borderRadius: 16, overflow: 'hidden', border: 0, padding: 0, cursor: 'pointer', color: '#fff', textAlign: 'left',
                background: 'linear-gradient(160deg, var(--lv3), var(--lv1))' }}>
              {p.apercu
                ? <VideoVisible src={p.apercu} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 46, opacity: .5 }}>{p.icone}</span>}
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '28px 12px 11px', background: 'linear-gradient(transparent, rgba(0,0,0,.8))', fontSize: 13.5, fontWeight: 700 }}>
                {nom(p)}{p.lora && <span style={{ marginLeft: 6, fontSize: 12, padding: '1px 5px', borderRadius: 5, background: 'rgba(255,255,255,.2)' }}>LoRA</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
      {ouvert && <Lancer p={ouvert} nom={nom(ouvert)} photoInitiale={photoVenue} onClose={() => setOuvert(null)} goVideo={goVideo} />}
    </div>
  )
}

function Lancer({ p, nom, photoInitiale, onClose, goVideo }: { p: Preset; nom: string; photoInitiale: Asset | null; onClose: () => void; goVideo: () => void }) {
  const s = useAppStore()
  const [photo, setPhoto] = useState<Asset | null>(photoInitiale)
  const [detail, setDetail] = useState('')
  const [duree, setDuree] = useState(5)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [fait, setFait] = useState(false)
  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt).slice(0, 120), [s.assets])
  const go = async () => {
    if (!photo) return
    setBusy(true); setErr(null)
    try {
      const r = await json(await fetch(`/api/presets/${p.id}/lancer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: photo.id, detail, duree }) }))
      void s.adoptServerJob(r.jobId)
      setFait(true)
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }
  return (
    <div className="pop" onClick={onClose}>
      <div className="pbox" style={{ width: 'min(860px,94%)' }} onClick={e => e.stopPropagation()}>
        <h3>{p.icone} {nom} <button className="x" onClick={onClose}>✕</button></h3>
        {fait ? (
          <div style={{ display: 'grid', gap: 10, padding: '10px 2px', fontSize: 13 }}>
            <div>✓ {t('Le clip est en file de rendu. Il arrivera dans l’onglet Vidéo.')}</div>
            <div className="flex gap-2">
              <button className="pill" onClick={() => { onClose(); goVideo() }}>{t('Aller à Vidéo')}</button>
              <button className="pill tool" onClick={() => { setFait(false); setPhoto(null) }}>{t('Une autre photo')}</button>
            </div>
          </div>
        ) : (<>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('1. Choisis la photo à animer')}</div>
          <div className="pkgrid" style={{ maxHeight: 300 }}>
            {photos.map(a => (
              <button key={a.id} className="pk" aria-label={nomMedia(a)} onClick={() => setPhoto(a)} style={{ outline: photo?.id === a.id ? '3px solid var(--accent)' : undefined }}>
                <img src={vignetteOf(a)} alt="" loading="lazy" />
              </button>
            ))}
            {!photos.length && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 12, padding: 12 }}>{t('rien dans la bibliothèque')}</div>}
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <input value={detail} onChange={e => setDetail(e.target.value)} maxLength={300} placeholder={t('2. Optionnel : ce qu’elle fait pendant le plan (en anglais)')}
              className="champ" style={{ fontSize: 12.5 }} />
            <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 12, color: 'var(--muted)' }}>
              <span>{t('Durée')}</span>
              {(p.moteur.startsWith('wan21') ? [3, 4, 5] : [4, 5, 6, 8]).map(k => <button key={k} className={`wtab ${duree === k ? 'on' : ''}`} onClick={() => setDuree(k)}>{k} s</button>)}
              <span style={{ marginLeft: 8, color: 'var(--faint)' }}>{p.moteur === 'wan21_hq' ? t('Wan 2.1 · LoRA dédiée · muet · ~8 min') : p.moteur === 'wan21' ? t('Wan 2.1 · LoRA dédiée · muet') : p.deuxRendus ? t('LTX-2.5 puis Wan 2.2 · deux rendus, le second finit sur ta photo') : `LTX-2.5 · ${t('avec le son')}${p.lora ? ' · LoRA' : ''}`}</span>
              <span style={{ flex: 1 }} />
              <button className="cta" style={{ padding: '9px 16px', flexDirection: 'row' }} disabled={!photo || busy} onClick={() => void go()}>{busy ? '…' : `✨ ${t('Animer')}`}</button>
            </div>
            {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
          </div>
        </>)}
      </div>
    </div>
  )
}
