/* Takes: clips from the same batch (× N renders launched together) compared side by side.
   All takes play at once on the same clock, to spot the best motion.
   Keep the best (the others are marked rejected), keep several,
   or open them one by one in the viewer. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../types'
import { posterOf } from '../components/AssetMedia'
import { t } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import './prises.css'

export function PrisesViewer({ items, onClose, onOpenAsset }: {
  items: Asset[]; onClose: () => void; onOpenAsset?: (a: Asset) => void
}) {
  const review = useAppStore(st => st.reviewAsset)
  const vids = useRef<(HTMLVideoElement | null)[]>([])
  const [joue, setJoue] = useState(true)
  const [son, setSon] = useState<number | null>(null)
  const [pos, setPos] = useState(0)
  const [duree, setDuree] = useState(0)
  const [focus, setFocus] = useState(0)
  const n = items.length
  const cols = n <= 3 ? n : n === 4 ? 2 : 3

  const tous = useCallback((f: (v: HTMLVideoElement) => void) => { vids.current.forEach(v => { if (v) f(v) }) }, [])
  // the first take drives the clock; the others are resynced when they drift
  useEffect(() => {
    let id = 0
    const tic = () => {
      const m = vids.current[0]
      if (m) {
        setPos(m.currentTime)
        if (m.duration && Number.isFinite(m.duration)) setDuree(m.duration)
        tous(v => { if (v !== m && v.duration && Math.abs(v.currentTime - (m.currentTime % v.duration)) > 0.12) v.currentTime = m.currentTime % v.duration })
      }
      id = requestAnimationFrame(tic)
    }
    id = requestAnimationFrame(tic)
    return () => cancelAnimationFrame(id)
  }, [tous])
  useEffect(() => { tous(v => { if (joue) void v.play().catch(() => {}); else v.pause() }) }, [joue, tous])
  useEffect(() => { vids.current.forEach((v, i) => { if (v) v.muted = son !== i }) }, [son])

  const garderSeule = (a: Asset) => { for (const x of items) review(x.id, x.id === a.id ? 'approved' : 'rejected'); onClose() }
  const caler = (s: number) => tous(v => { v.currentTime = v.duration ? Math.min(s, v.duration - 0.05) : s })

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === ' ') { e.preventDefault(); setJoue(j => !j) }
      else if (e.key === 'ArrowRight') setFocus(f => (f + 1) % n)
      else if (e.key === 'ArrowLeft') setFocus(f => (f - 1 + n) % n)
      else if (e.key === 'Enter') garderSeule(items[focus])
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) setFocus(Number(e.key) - 1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return createPortal(
    <div className="v2 pr-fond" role="dialog" aria-modal="true" aria-label={t('Compare takes')} onClick={onClose}>
      <div className="pr-boite" onClick={e => e.stopPropagation()}>
        <header className="pr-tete">
          <div>
            <h2>{t('Compare takes')}</h2>
            <p>{t('{n} takes of the same shot, playing in sync. Keep the best one, the others go to Rejected.', { n })}</p>
          </div>
          <button className="pr-fermer" onClick={onClose} aria-label={t('Close')}>✕</button>
        </header>
        <div className="pr-grille" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {items.map((a, i) => (
            <figure key={a.id} className={`pr-prise ${i === focus ? 'pr-focus' : ''} ${a.reviewStatus === 'approved' ? 'pr-gardee' : ''} ${a.reviewStatus === 'rejected' ? 'pr-refusee' : ''}`}
              onMouseEnter={() => setFocus(i)}>
              <video ref={el => { vids.current[i] = el }} src={a.uri} poster={posterOf(a)} muted={son !== i} loop playsInline autoPlay preload="auto"
                onClick={() => setSon(s => (s === i ? null : i))} />
              <span className="pr-num">{i + 1}</span>
              {a.reviewStatus === 'approved' && <span className="pr-etat">{t('Kept')}</span>}
              {a.reviewStatus === 'rejected' && <span className="pr-etat pr-etat-r">{t('Rejected')}</span>}
              <figcaption>
                <button className="pr-garder" onClick={() => garderSeule(a)}>{t('Keep this take')}</button>
                <button onClick={() => review(a.id, a.reviewStatus === 'approved' ? 'pending' : 'approved')} title={t('Keep it too, without touching the others')}>
                  {a.reviewStatus === 'approved' ? '★' : '☆'}
                </button>
                <button onClick={() => setSon(s => (s === i ? null : i))} title={t('Listen to this take')}>{son === i ? '🔊' : '🔈'}</button>
                {onOpenAsset && <button onClick={() => onOpenAsset(a)} title={t('Open in the viewer')}>⤢</button>}
              </figcaption>
            </figure>
          ))}
        </div>
        <footer className="pr-pied">
          <button className="pr-lecture" onClick={() => setJoue(j => !j)} aria-label={joue ? t('Pause') : t('Play')}>{joue ? '❚❚' : '▶'}</button>
          <input type="range" min={0} max={duree || 1} step={0.02} value={Math.min(pos, duree || 1)} aria-label={t('Position')}
            onChange={e => { setJoue(false); caler(Number(e.target.value)) }} />
          <span className="pr-temps">{fmt(pos)} / {fmt(duree)}</span>
          <span className="pr-aide">{t('Space: play · 1–9: pick · Enter: keep')}</span>
        </footer>
      </div>
    </div>, document.body)
}
