/* Curseur avant / après — juger un agrandissement (Photo HD, upscale vidéo) à l'œil,
   sur le même cadre, au lieu de basculer entre deux assets. L'« après » est dessous,
   l'« avant » dessus, rogné à gauche du curseur. Deux vidéos sont tenues calées. */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { t } from '../i18n'

export function AvantApres({ avant, apres, className, style }: { avant: Asset; apres: Asset; className?: string; style?: React.CSSProperties }) {
  const [x, setX] = useState(50)
  const boite = useRef<HTMLDivElement>(null)
  const vAvant = useRef<HTMLVideoElement>(null), vApres = useRef<HTMLVideoElement>(null)
  const video = apres.mediaType === 'video'
  // la vidéo « après » mène : l'« avant » la suit dès qu'elle s'en écarte
  useEffect(() => {
    if (!video) return
    const iv = window.setInterval(() => {
      const a = vAvant.current, b = vApres.current
      if (!a || !b || !a.duration || !b.duration) return
      const cible = (b.currentTime / b.duration) * a.duration
      if (Math.abs(a.currentTime - cible) > 0.12) a.currentTime = cible
      if (b.paused !== a.paused) { if (b.paused) a.pause(); else void a.play().catch(() => {}) }
    }, 120)
    return () => window.clearInterval(iv)
  }, [video, avant.id, apres.id])
  const bouger = (e: React.PointerEvent) => {
    if (!(e.buttons & 1) && e.type !== 'pointerdown') return
    const r = boite.current?.getBoundingClientRect()
    if (r) setX(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }
  const calque: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', clipPath: `inset(0 ${100 - x}% 0 0)` }
  const etiquette: React.CSSProperties = { position: 'absolute', top: 10, fontSize: 10, letterSpacing: '.06em', padding: '3px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.65)', color: '#fff', pointerEvents: 'none' }
  return (
    <div ref={boite} className={className} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); bouger(e) }} onPointerMove={bouger}
      style={{ position: 'relative', display: 'inline-block', cursor: 'ew-resize', touchAction: 'none', userSelect: 'none', lineHeight: 0, ...style }}>
      {video
        ? <video ref={vApres} src={apres.uri} autoPlay loop muted playsInline className={className} style={{ display: 'block' }} />
        : <img src={apres.uri} alt="" draggable={false} className={className} style={{ display: 'block' }} />}
      {video
        ? <video ref={vAvant} src={avant.uri} autoPlay loop muted playsInline style={calque} />
        : <img src={avant.uri} alt="" draggable={false} style={calque} />}
      <span style={{ ...etiquette, left: 10 }}>{t('AVANT')}{avant.width ? ` · ${avant.width}×${avant.height}` : ''}</span>
      <span style={{ ...etiquette, right: 10 }}>{t('APRÈS')}{apres.width ? ` · ${apres.width}×${apres.height}` : ''}</span>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${x}%`, width: 2, marginLeft: -1, background: '#fff', boxShadow: '0 0 8px rgba(0,0,0,0.6)', pointerEvents: 'none' }}>
        <span style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 30, height: 30, borderRadius: 99, background: '#fff', color: '#111',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, lineHeight: 1 }}>⇆</span>
      </div>
    </div>
  )
}
