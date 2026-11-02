/* Retouche au pinceau — on peint la zone à refaire, on dit ce qui doit s'y trouver,
   et seule cette zone est régénérée : le reste de l'image revient au pixel près.
   Le masque est peint à la définition de l'image (pas à celle de l'écran).
   Vidéo : on peint sur la PREMIÈRE image du clip ; la zone est suivie d'image en image
   (ou reste fixe dans le cadre, au choix). */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { t, tc, tServeur } from '../i18n'
import { vignetteOf } from './AssetMedia'

export function Pinceau({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const toile = useRef<HTMLCanvasElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const vid = useRef<HTMLVideoElement>(null)
  const video = asset.mediaType === 'video'
  const [suivi, setSuivi] = useState(true)
  const [pret, setPret] = useState(false)
  const [taille, setTaille] = useState(60)          // diamètre, en pixels d'image
  const [gomme, setGomme] = useState(false)
  const [prompt, setPrompt] = useState('')
  /* À 75-80 % une photo garde sa couleur (pull crème resté crème),
     à 95 % elle change. Une vidéo, même à 100 %, garde le vêtement : la retouche
     vidéo corrige, elle ne remplace pas — 75 % suffit et abîme moins. */
  const [force, setForce] = useState(video ? 0.75 : 0.9)
  const [peint, setPeint] = useState(false)
  const [envoi, setEnvoi] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [curseur, setCurseur] = useState<{ x: number; y: number; d: number } | null>(null)
  const dernier = useRef<{ x: number; y: number } | null>(null)
  const pile = useRef<ImageData[]>([])
  const adopter = useAppStore(s => s.adoptServerJob)
  /* Poser un objet : une photo de la bibliothèque et son nom, collés dans la zone suivie. */
  const photos = useAppStore(s => s.assets).filter(a => a.mediaType === 'photo').slice(0, 24)
  const [objet, setObjet] = useState<string | null>(null)
  const [objetNom, setObjetNom] = useState('')
  const [loin, setLoin] = useState(false)
  const [poser, setPoser] = useState(false)
  /* Téléphone : image en haut, réglages dessous (le panneau de 320 px à droite
     ne tient pas sur un écran étroit). Le pinceau suit le doigt (pointer events). */
  const [etroit, setEtroit] = useState(() => window.innerWidth < 760)
  useEffect(() => {
    const r = () => setEtroit(window.innerWidth < 760)
    window.addEventListener('resize', r)
    return () => window.removeEventListener('resize', r)
  }, [])

  const charge = () => {
    const c = toile.current
    const w = video ? vid.current?.videoWidth : img.current?.naturalWidth, h = video ? vid.current?.videoHeight : img.current?.naturalHeight
    if (!c || !w || !h) return
    c.width = w; c.height = h
    setTaille(Math.round(Math.max(w, h) / 18))
    setPret(true)
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); annuler() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const point = (e: React.PointerEvent) => {
    const c = toile.current!, r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, echelle: r.width / c.width }
  }
  const trait = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ctx = toile.current!.getContext('2d')!
    ctx.globalCompositeOperation = gomme ? 'destination-out' : 'source-over'
    ctx.strokeStyle = ctx.fillStyle = '#ff3d9a'
    ctx.lineWidth = taille; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
  }
  const debut = (e: React.PointerEvent) => {
    if (!pret) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const c = toile.current!
    pile.current.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height))
    if (pile.current.length > 12) pile.current.shift()
    const p = point(e); dernier.current = p; trait(p, p); setPeint(true)
  }
  const bouge = (e: React.PointerEvent) => {
    const p = point(e)
    setCurseur({ x: e.clientX, y: e.clientY, d: taille * p.echelle })
    if (dernier.current) { trait(dernier.current, p); dernier.current = p }
  }
  const fin = () => { dernier.current = null }
  const annuler = () => {
    const c = toile.current, d = pile.current.pop()
    if (c && d) { c.getContext('2d')!.putImageData(d, 0, 0); setPeint(pile.current.length > 0 || contient(c)) }
  }
  const effacer = () => {
    const c = toile.current
    if (!c) return
    pile.current.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height))
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setPeint(false)
  }

  const envoyer = async () => {
    const c = toile.current
    if (!c || envoi) return
    if (!contient(c)) { setMsg(t('Peins d’abord la zone à refaire.')); return }
    if (!prompt.trim()) { setMsg(t('Décris ce qui doit apparaître dans la zone peinte.')); return }
    setEnvoi(true); setMsg(null)
    try {
      // masque blanc sur noir, opaque, à la définition de l'image
      const m = document.createElement('canvas'); m.width = c.width; m.height = c.height
      const ctx = m.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, m.width, m.height)
      const src = c.getContext('2d')!.getImageData(0, 0, c.width, c.height), out = ctx.getImageData(0, 0, m.width, m.height)
      for (let i = 0; i < src.data.length; i += 4) if (src.data[i + 3] > 40) { out.data[i] = out.data[i + 1] = out.data[i + 2] = 255 }
      ctx.putImageData(out, 0, 0)
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/inpaint`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask: m.toDataURL('image/png'), prompt: prompt.trim(), strength: poser && objet ? 0.5 : force, ...(video ? { suivi } : {}), ...(poser && objet ? { objetAsset: objet, objetNom, ...(loin ? { loin: true, suivi: false } : {}) } : {}) }) })
      const b = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
      if (!r.ok || !b.jobId) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`)
      await adopter(b.jobId)
      onClose()
    } catch (e) { setMsg(String((e as Error).message ?? e)); setEnvoi(false) }
  }

  const bouton: React.CSSProperties = { border: 0, borderRadius: 9, padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: '#f2f2f4', background: 'rgba(255,255,255,0.1)' }
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: '#08090b', display: 'flex', flexDirection: etroit ? 'column' : 'row', color: '#f2f2f4' }}>
      <div style={{ flex: etroit ? '0 0 auto' : 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, padding: etroit ? '10px 10px 0' : 0 }}>
        <div style={{ position: 'relative', lineHeight: 0 }}>
          {video
            ? <video ref={vid} src={asset.uri} muted playsInline preload="auto" onLoadedMetadata={e => { e.currentTarget.currentTime = 0; charge() }}
                style={{ maxHeight: etroit ? '52vh' : '94vh', maxWidth: '100%', display: 'block', borderRadius: 10 }} />
            : <img ref={img} src={asset.uri} alt="" onLoad={charge} draggable={false}
                style={{ maxHeight: etroit ? '52vh' : '94vh', maxWidth: '100%', display: 'block', borderRadius: 10, userSelect: 'none' }} />}
          <canvas ref={toile} onPointerDown={debut} onPointerMove={bouge} onPointerUp={fin} onPointerCancel={fin} onPointerLeave={() => setCurseur(null)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: .5, cursor: 'none', touchAction: 'none', borderRadius: 10 }} />
        </div>
        {curseur && <span style={{ position: 'fixed', left: curseur.x, top: curseur.y, width: curseur.d, height: curseur.d, transform: 'translate(-50%, -50%)',
          borderRadius: '50%', border: '1.5px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.6)', pointerEvents: 'none' }} />}
      </div>
      <div style={etroit
        ? { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 12, background: '#121317', borderTop: '1px solid rgba(255,255,255,0.08)' }
        : { width: 320, flex: '0 0 320px', padding: 18, display: 'flex', flexDirection: 'column', gap: 14, background: '#121317', borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <b style={{ fontSize: 14, flex: 1 }}>{t('Retouche au pinceau')}</b>
          <button onClick={onClose} aria-label={t('fermer')} style={{ border: 0, background: 'none', color: '#f2f2f4', fontSize: 20, cursor: 'pointer', opacity: .6 }}>×</button>
        </div>
        <div style={{ fontSize: 12, opacity: .6, lineHeight: 1.5 }}>{video
          ? t('Peins la zone sur la première image du clip. Le reste de la vidéo ne change pas. Clips de 10 s au plus. Pour corriger un détail (yeux, main, tache) : changer un vêtement ou sa couleur ne marche pas en vidéo.')
          : t('Peins la zone à refaire. Le reste de l’image ne change pas.')}</div>
        {video && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...bouton, flex: 1, background: suivi ? 'rgba(255,61,154,0.3)' : bouton.background }} onClick={() => setSuivi(true)}
              title={t("la zone suit l'élément peint quand il bouge")}>{t('suivre la zone')}</button>
            <button style={{ ...bouton, flex: 1, background: !suivi ? 'rgba(255,61,154,0.3)' : bouton.background }} onClick={() => setSuivi(false)}
              title={t('la zone reste au même endroit du cadre')}>{t('zone fixe')}</button>
          </div>
        )}
        {video && <button style={{ ...bouton, background: poser ? 'rgba(255,61,154,0.3)' : bouton.background }} onClick={() => setPoser(p => !p)}>{t('Poser un objet d’une photo')}</button>}
        {video && poser && (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
            {photos.map(a => <button key={a.id} onClick={() => setObjet(a.id)} style={{ padding: 0, border: objet === a.id ? '2px solid #ea4e89' : '2px solid transparent', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: 'none', aspectRatio: '1' }}><img src={vignetteOf(a)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></button>)}
          </div>
          <input value={objetNom} onChange={e => setObjetNom(e.target.value)} placeholder={t('nom de l’objet, en anglais : sunglasses')} maxLength={80}
            style={{ padding: 8, borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)', background: '#0b0c0e', color: '#f2f2f4', fontSize: 12 }} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }} title={t('peins la zone où il se tient : il suit la caméra, reste derrière les personnes et prend le flou de la distance')}>
            <input type="checkbox" checked={loin} onChange={e => setLoin(e.target.checked)} /> {t('Au loin, derrière les personnes')}
          </label>
        </>)}
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...bouton, background: !gomme ? 'rgba(255,61,154,0.3)' : bouton.background }} onClick={() => setGomme(false)}>{t('pinceau')}</button>
          <button style={{ ...bouton, background: gomme ? 'rgba(255,255,255,0.25)' : bouton.background }} onClick={() => setGomme(true)}>{t('gomme')}</button>
          <button style={bouton} onClick={annuler} title="⌘Z">{tc('undo', 'annuler')}</button>
          <button style={bouton} onClick={effacer}>{t('tout effacer')}</button>
        </div>
        <label style={{ fontSize: 12 }}>{t('Taille du pinceau · {n} px', { n: taille })}
          <input type="range" min={8} max={400} value={taille} onChange={e => setTaille(Number(e.target.value))} style={{ width: '100%', accentColor: '#ea4e89' }} />
        </label>
        <label style={{ fontSize: 12 }}>{t('Dans la zone peinte, je veux')}
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} placeholder={t('ex. a hand resting on the hip, five fingers, natural skin')}
            style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#0b0c0e', color: '#f2f2f4', fontSize: 12.5, fontFamily: 'inherit', resize: 'vertical' }} />
        </label>
        <label style={{ fontSize: 12 }}>{t('Liberté · {n} %', { n: Math.round(force * 100) })}
          <input type="range" min={30} max={100} value={Math.round(force * 100)} onChange={e => setForce(Number(e.target.value) / 100)} style={{ width: '100%', accentColor: '#ea4e89' }} />
          <span style={{ opacity: .5, fontSize: 12 }}>{t("bas : garde les formes d'origine · haut : refait la zone entièrement")}</span>
        </label>
        {msg && <div style={{ fontSize: 12, color: '#f08a7e' }}>{msg}</div>}
        <span style={{ flex: 1 }} />
        <button disabled={envoi || !peint} onClick={() => void envoyer()}
          style={{ border: 0, borderRadius: 12, padding: '13px 14px', cursor: envoi || !peint ? 'default' : 'pointer', fontWeight: 600, fontSize: 14, color: '#fff',
            background: 'linear-gradient(90deg, #f6a961, #ea4e89)', opacity: envoi || !peint ? .45 : 1 }}>
          {envoi ? t('envoi…') : t('Retoucher la zone')}
        </button>
      </div>
    </div>, document.body)
}

/** La toile porte-t-elle au moins un trait ? */
function contient(c: HTMLCanvasElement) {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < d.length; i += 16) if (d[i] > 40) return true
  return false
}
