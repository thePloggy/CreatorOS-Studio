/* ============================================================
   Point et demande : un clic sur la photo pose un repère, une bulle demande
   « que changer ici ? », Entrée lance une retouche localisée (même route que le
   pinceau : /api/assets/:id/inpaint) avec un masque rond autour du point.
   Plus simple que le pinceau pour une petite retouche ciblée.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'
import { Ic } from './bits'

/** Rayon du masque, en part du plus petit côté de l'image. */
const RAYON = 0.1

export function PointEtDemande({ asset, actif, onFin, className, style }: {
  asset: Asset; actif: boolean; onFin: () => void; className?: string; style?: React.CSSProperties
}) {
  const adopter = useAppStore(s => s.adoptServerJob)
  const img = useRef<HTMLImageElement>(null)
  const champ = useRef<HTMLInputElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [consigne, setConsigne] = useState('')
  const [envoi, setEnvoi] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // taille réelle du disque à l'écran : le masque se base sur le plus petit côté de l'image
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => { if (!actif) { setPoint(null); setConsigne(''); setMsg(null) } }, [actif])
  useEffect(() => { if (point) champ.current?.focus() }, [point])

  const poser = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!actif) return
    const r = e.currentTarget.getBoundingClientRect()
    setPoint({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); setMsg(null)
  }
  const envoyer = async () => {
    const im = img.current
    if (!im || !point || !consigne.trim() || envoi) return
    setEnvoi(true); setMsg(null)
    try {
      // masque blanc sur noir à la définition de l'image : un disque autour du point
      const w = im.naturalWidth, h = im.naturalHeight
      const m = document.createElement('canvas'); m.width = w; m.height = h
      const ctx = m.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(point.x * w, point.y * h, Math.min(w, h) * RAYON, 0, Math.PI * 2); ctx.fill()
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/inpaint`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask: m.toDataURL('image/png'), prompt: consigne.trim(), strength: 0.9 }) })
      const b = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
      if (!r.ok || !b.jobId) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`)
      await adopter(b.jobId)
      setMsg(t('Retouche en file : elle arrive dans la bibliothèque.')); setPoint(null); setConsigne('')
      window.setTimeout(onFin, 1600)
    } catch (e) { setMsg(String((e as Error).message ?? e)) }
    setEnvoi(false)
  }

  return (
    <span className={`point-cadre ${actif ? 'actif' : ''}`}>
      <img ref={img} src={asset.uri} alt="" className={className} style={style} onClick={poser} onLoad={e => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {actif && !point && <span className="point-aide">{t('Clique sur ce que tu veux changer')}</span>}
      {point && (
        <>
          <i className="point-repere" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, '--r': `${dim ? RAYON * 2 * Math.min(dim.w, dim.h) / dim.w * 100 : RAYON * 200}%` } as React.CSSProperties} aria-hidden />
          <form className="point-bulle" style={{ left: `${Math.min(78, Math.max(22, point.x * 100))}%`,
            ...(point.y > 0.62
              ? { top: `${(point.y - (dim ? RAYON * Math.min(dim.w, dim.h) / dim.h : RAYON)) * 100}%`, transform: 'translate(-50%, calc(-100% - 12px))' }
              : { top: `${(point.y + (dim ? RAYON * Math.min(dim.w, dim.h) / dim.h : RAYON)) * 100}%`, transform: 'translate(-50%, 12px)' }) }}
            onSubmit={e => { e.preventDefault(); void envoyer() }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPoint(null) } }}>
            <input ref={champ} value={consigne} onChange={e => setConsigne(e.target.value)} placeholder={t('Que changer ici ? Ex. « une veste en cuir rouge »')} aria-label={t('Que changer ici ?')} />
            <button type="submit" className="cta" disabled={envoi || !consigne.trim()}><Ic n="sparkle" s={14} />{envoi ? t('Envoi…') : t('Refaire ici')}</button>
          </form>
        </>
      )}
      {msg && <span className="point-msg" role="status">{msg}</span>}
    </span>
  )
}
