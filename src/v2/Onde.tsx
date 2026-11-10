/* Waveform player: the file is decoded by the browser (Web Audio, decodeAudioData),
   reduced to a few hundred peaks and drawn on a canvas. Clicking the waveform seeks;
   only one sound plays at a time in the studio. Decoding happens only once the player
   is on screen, and once per file. */
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

const NB_PICS = 240
const cache = new Map<string, Promise<Float32Array | null>>()

/** Normalized peaks (0..1) of an audio file, cached by URL. */
function pics(src: string): Promise<Float32Array | null> {
  let p = cache.get(src)
  if (!p) {
    p = (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer()
        // offline context: decoding needs no user gesture and no audio output
        const ctx = new OfflineAudioContext(1, 1, 44100)
        const audio = await ctx.decodeAudioData(buf)
        const canaux = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, c) => audio.getChannelData(c))
        const pas = Math.max(1, Math.floor(audio.length / NB_PICS))
        const out = new Float32Array(NB_PICS)
        let max = 0
        for (let i = 0; i < NB_PICS; i++) {
          let m = 0
          const debut = i * pas, fin = Math.min(audio.length, debut + pas)
          // one sample out of 8 is enough for drawing
          for (const d of canaux) for (let k = debut; k < fin; k += 8) { const v = Math.abs(d[k]); if (v > m) m = v }
          out[i] = m; if (m > max) max = m
        }
        if (max > 0) for (let i = 0; i < NB_PICS; i++) out[i] /= max
        return out
      } catch { return null }
    })()
    cache.set(src, p)
  }
  return p
}

let enLecture: HTMLAudioElement | null = null
const fmt = (s: number) => !Number.isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function LecteurOnde({ src, duree, compact }: { src: string; duree?: number | null; compact?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null)
  const toile = useRef<HTMLCanvasElement>(null)
  const boite = useRef<HTMLDivElement>(null)
  const [onde, setOnde] = useState<Float32Array | null | undefined>(undefined)
  const [lecture, setLecture] = useState(false)
  const [pos, setPos] = useState(0)
  const [total, setTotal] = useState(duree ?? 0)
  const [largeur, setLargeur] = useState(0)

  // decode when the player becomes visible
  useEffect(() => {
    const el = boite.current
    if (!el) return
    let vivant = true
    const io = new IntersectionObserver(e => {
      if (!e.some(x => x.isIntersecting)) return
      io.disconnect()
      void pics(src).then(p => { if (vivant) setOnde(p) })
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => { vivant = false; io.disconnect() }
  }, [src])
  useEffect(() => {
    const el = boite.current
    if (!el) return
    const ro = new ResizeObserver(() => setLargeur(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // drawing: bars, the played part in accent color
  useEffect(() => {
    const c = toile.current
    if (!c || !largeur) return
    const h = compact ? 34 : 46, dpr = window.devicePixelRatio || 1
    c.width = Math.round(largeur * dpr); c.height = Math.round(h * dpr)
    c.style.width = `${largeur}px`; c.style.height = `${h}px`
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, largeur, h)
    const css = getComputedStyle(c)
    const lu = css.getPropertyValue('--accent').trim() || '#8b7cff'
    const reste = css.getPropertyValue('--lv4').trim() || '#3a3d46'
    const barre = 3, ecart = 1.5
    const n = Math.max(1, Math.floor(largeur / (barre + ecart)))
    const avance = total > 0 ? pos / total : 0
    for (let i = 0; i < n; i++) {
      const v = onde ? onde[Math.min(onde.length - 1, Math.floor((i / n) * onde.length))] : 0.08
      const bh = Math.max(2, v * (h - 4))
      g.fillStyle = i / n < avance ? lu : reste
      g.fillRect(i * (barre + ecart), (h - bh) / 2, barre, bh)
    }
  }, [onde, largeur, pos, total, compact])

  const basculer = () => {
    const a = audio.current
    if (!a) return
    if (!a.paused) { a.pause(); return }
    if (enLecture && enLecture !== a) enLecture.pause()
    enLecture = a
    void a.play().catch(() => setLecture(false))
  }
  const placer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const a = audio.current
    if (!a) return
    const r = e.currentTarget.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const aller = () => { a.currentTime = f * (a.duration || total); setPos(a.currentTime) }
    if (a.readyState >= 1) aller()
    else { a.preload = 'metadata'; a.addEventListener('loadedmetadata', aller, { once: true }); a.load() }
  }
  return (
    <div className={`onde ${compact ? 'compacte' : ''}`}>
      <button type="button" className="onde-jouer" onClick={basculer} aria-label={lecture ? t('Pause') : t('Lire')} title={lecture ? t('Pause') : t('Lire')}>
        {lecture ? <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
          : <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>}
      </button>
      <div ref={boite} className="onde-toile">
        <canvas ref={toile} onClick={placer} role="slider" aria-label={t('Position de lecture')} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(pos)} />
      </div>
      <span className="onde-temps">{fmt(pos)} / {fmt(total)}</span>
      <audio ref={audio} src={src} preload="none"
        onPlay={() => setLecture(true)} onPause={() => setLecture(false)} onEnded={() => { setLecture(false); setPos(0) }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime)} onLoadedMetadata={e => setTotal(e.currentTarget.duration)} />
    </div>
  )
}
