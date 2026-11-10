/* ============================================================
   Comparison: 2 to 4 renders side by side (Krea vs Klein, two seeds,
   before / after a finishing pass). Videos play together: play, pause,
   rewind and sound are driven for all at once.
   With two renders, "curtain" mode by default: both are overlaid and
   the split follows the mouse (or finger), A left, B right; sound comes
   from the side that covers more of the screen.
   Opened from the selection bar (desktop and mobile).
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../types'
import { badgesOf } from '../v2/bits'
import { posterOf } from './AssetMedia'
import { t } from '../i18n'

/* inline styles: the comparison also opens on mobile, outside v2.css */
const BTN = { background: '#1c1e23', color: '#e8e9ec', border: 0, borderRadius: 9, padding: '7px 12px', fontSize: 12, cursor: 'pointer' } as const
const PILL = { fontSize: 12, padding: '2px 6px', borderRadius: 6, background: '#1c1e23', color: '#b9bbc2' } as const

export function Comparer({ assets, onClose }: { assets: Asset[]; onClose: () => void }) {
  const vids = useRef<(HTMLVideoElement | null)[]>([])
  const [joue, setJoue] = useState(false)
  const [son, setSon] = useState(false)
  const liste = assets.slice(0, 4)
  const aVideo = liste.some(a => a.mediaType === 'video')
  const [rideau, setRideau] = useState(liste.length === 2)
  const [x, setX] = useState(50)
  const suivre = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setX(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }
  const changerMode = () => { tous(v => v.pause()); setJoue(false); vids.current = []; setRideau(m => !m) }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === ' ' && aVideo) { e.preventDefault(); basculer() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const tous = (f: (v: HTMLVideoElement) => void) => vids.current.forEach(v => { if (v) f(v) })
  const basculer = () => {
    if (joue) { tous(v => v.pause()); setJoue(false); return }
    tous(v => { void v.play().catch(() => { /* playback refused */ }) }); setJoue(true)
  }
  const auDebut = () => tous(v => { v.currentTime = 0 })

  return createPortal(
    <div className="v2" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(6,7,9,.94)', display: 'flex', flexDirection: 'column', color: '#e8e9ec' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>{t('Comparer')} · {liste.length}</b>
        {aVideo && (<>
          <button style={BTN} onClick={basculer}>{joue ? t('⏸ Pause') : t('▶ Lire ensemble')}</button>
          <button style={BTN} onClick={auDebut}>{t('⏮ Au début')}</button>
          <button style={BTN} onClick={() => { setSon(v => !v) }}>{son ? t('🔊 Son') : t('🔇 Muet')}</button>
        </>)}
        {liste.length === 2 && <button style={BTN} onClick={changerMode}>{rideau ? t('◫ Côte à côte') : t('◧ Rideau')}</button>}
        <button style={{ ...BTN, marginLeft: 'auto' }} onClick={onClose}>{t('Fermer')}</button>
      </div>
      {rideau ? (
        <div onClick={e => e.stopPropagation()} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: '0 16px 16px' }}>
          <div onPointerMove={suivre} onPointerDown={suivre}
            style={{ position: 'relative', flex: 1, minHeight: 0, background: '#0b0c0f', borderRadius: 10, overflow: 'hidden', cursor: 'ew-resize', touchAction: 'none', userSelect: 'none' }}>
            {liste.map((a, i) => (
              <div key={a.id} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                clipPath: i === 0 ? `inset(0 ${100 - x}% 0 0)` : `inset(0 0 0 ${x}%)` }}>
                {a.mediaType === 'video'
                  ? <video ref={el => { vids.current[i] = el }} src={a.uri} poster={posterOf(a)} loop playsInline
                      muted={!son || (i === 0 ? x < 50 : x >= 50)}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  : <img src={a.uri} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
              </div>
            ))}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${x}%`, width: 2, marginLeft: -1, background: '#fff', boxShadow: '0 0 8px rgba(0,0,0,.6)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: `${x}%`, width: 30, height: 30, margin: '-15px 0 0 -15px', borderRadius: 99,
              background: '#fff', color: '#14161a', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>⇔</div>
            <b style={{ position: 'absolute', top: 10, left: 12, fontSize: 13, textShadow: '0 1px 4px #000', opacity: x > 8 ? 1 : 0 }}>A</b>
            <b style={{ position: 'absolute', top: 10, right: 12, fontSize: 13, textShadow: '0 1px 4px #000', opacity: x < 92 ? 1 : 0 }}>B</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            {liste.map((a, i) => <Legende key={a.id} a={a} i={i} />)}
          </div>
        </div>
      ) : (
      <div onClick={e => e.stopPropagation()}
        style={{ flex: 1, minHeight: 0, display: 'grid', gap: 8, padding: '0 16px 16px',
          gridTemplateColumns: `repeat(auto-fit, minmax(min(${liste.length > 2 ? 220 : 300}px, 100%), 1fr))` }}>
        {liste.map((a, i) => (
          <figure key={a.id} style={{ margin: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0c0f', borderRadius: 10, overflow: 'hidden' }}>
              {a.mediaType === 'video'
                ? <video ref={el => { vids.current[i] = el }} src={a.uri} poster={posterOf(a)} loop playsInline muted={!son}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                : <img src={a.uri} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
            </div>
            <Legende a={a} i={i} />
          </figure>
        ))}
      </div>
      )}
    </div>, document.body)
}

function Legende({ a, i }: { a: Asset; i: number }) {
  const graine = a.provenance?.seed?.value
  return (
    <figcaption style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#9a9ca3' }}>
      <b style={{ color: '#e8e9ec' }}>{String.fromCharCode(65 + i)}</b>
      {badgesOf(a).map(b => <span key={b.cle} style={PILL}>{b.txt}</span>)}
      {graine != null && <span>{t('graine')} {graine}</span>}
      {a.width && a.height && <span>{a.width}×{a.height}</span>}
    </figcaption>
  )
}
