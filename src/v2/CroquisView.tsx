/* Croquis vers vidéo : dessine la scène au trait, décris-la, choisis ce qui bouge.
   Le serveur en tire une image (FLUX.2 Klein) puis un clip (LTX-2.5), dans la bibliothèque. */
import { useEffect, useRef, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { ChoixPersonnage } from './ChoixPersonnage'

const FORMATS = { '16:9': [960, 540], '9:16': [405, 720], '1:1': [600, 600] } as const
type Format = keyof typeof FORMATS
type Etat = { id: string; photo: string | null; clip: string | null }

export function CroquisView() {
  const toile = useRef<HTMLCanvasElement>(null)
  const [format, setFormat] = useState<Format>('16:9')
  const [epaisseur, setEpaisseur] = useState(6)
  const [gomme, setGomme] = useState(false)
  const [scene, setScene] = useState('')
  const [mouvement, setMouvement] = useState('')
  const [suivi, setSuivi] = useState<Etat | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const histo = useRef<ImageData[]>([])
  const adopter = useAppStore(s => s.adoptServerJob)
  const [w, h] = FORMATS[format]

  const fond = () => { const c = toile.current!; const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); histo.current = [] }
  useEffect(fond, [format])
  useEffect(() => {
    if (!suivi || suivi.clip === 'done') return
    const h = setInterval(() => void fetch(`/api/croquis/${suivi.id}`).then(r => r.json()).then((d: Etat & { photoJob?: string; clipJob?: string }) => {
      setSuivi(d)
      if (d.clipJob) void adopter(d.clipJob)
    }).catch(() => {}), 2500)
    return () => clearInterval(h)
  }, [suivi, adopter])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [(e.clientX - r.left) * w / r.width, (e.clientY - r.top) * h / r.height] }
  const dessin = useRef<number[] | null>(null)
  const debut = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = toile.current!.getContext('2d')!; histo.current.push(x.getImageData(0, 0, w, h)); if (histo.current.length > 30) histo.current.shift()
    e.currentTarget.setPointerCapture(e.pointerId); dessin.current = point(e)
  }
  const trace = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dessin.current) return
    const x = toile.current!.getContext('2d')!, p = point(e)
    x.strokeStyle = gomme ? '#fff' : '#111'; x.lineWidth = gomme ? epaisseur * 4 : epaisseur; x.lineCap = 'round'; x.lineJoin = 'round'
    x.beginPath(); x.moveTo(dessin.current[0], dessin.current[1]); x.lineTo(p[0], p[1]); x.stroke(); dessin.current = p
  }
  const annuler = () => { const d = histo.current.pop(); if (d) toile.current!.getContext('2d')!.putImageData(d, 0, 0) }

  const lancer = async () => {
    setErr(null)
    const r = await fetch('/api/croquis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: toile.current!.toDataURL('image/png'), scene, mouvement, format, secondes: 5 }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setSuivi(d); if (d.photoJob) void adopter(d.photoJob)
  }
  const etape = !suivi ? null : suivi.clip === 'done' ? t('Clip prêt : il est dans la bibliothèque.') : suivi.clip ? t('Image prête, le clip se rend (~5 min)…') : suivi.photo === 'blocked' ? t('L’image a échoué : réessaie.') : t('L’image se rend à partir du croquis…')

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 14 }}>
        <div>
          <h2 className="titre-outil">{t('Croquis vers vidéo')}</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('Dessine la scène au trait : FLUX.2 Klein en fait une image qui garde ta composition, puis LTX-2.5 l’anime avec le son.')}</p>
        </div>
        <div className="croquis">
          <div className="croquis-toile">
            <canvas ref={toile} width={w} height={h} style={{ aspectRatio: `${w} / ${h}` }}
              onPointerDown={debut} onPointerMove={trace} onPointerUp={() => { dessin.current = null }} onPointerLeave={() => { dessin.current = null }} />
            <div className="flex gap-1.5 flex-wrap items-center text-[12px]" style={{ color: 'var(--muted)' }}>
              {(Object.keys(FORMATS) as Format[]).map(f => <button key={f} className={`pill ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>{f}</button>)}
              <span style={{ width: 10 }} />
              <button className={`pill ${!gomme ? 'on' : ''}`} onClick={() => setGomme(false)}>{t('crayon')}</button>
              <button className={`pill ${gomme ? 'on' : ''}`} onClick={() => setGomme(true)}>{t('gomme')}</button>
              <label className="flex gap-1.5 items-center">{t('épaisseur')}<input type="range" min={2} max={20} value={epaisseur} onChange={e => setEpaisseur(Number(e.target.value))} aria-label={t('épaisseur')} /></label>
              <button className="pill" onClick={annuler}>{t('défaire')}</button>
              <button className="pill" onClick={fond}>{t('tout effacer')}</button>
            </div>
          </div>
          <div className="croquis-panneau">
            <ChoixPersonnage />
            <label>{t('Ce que montre le dessin')}<textarea value={scene} onChange={e => setScene(e.target.value)} maxLength={400} rows={3} placeholder={t('en anglais : a lighthouse on a cliff at sunset, waves below')} /></label>
            <label>{t('Ce qui bouge')}<textarea value={mouvement} onChange={e => setMouvement(e.target.value)} maxLength={300} rows={2} placeholder={t('en anglais : waves crash, slow push in')} /></label>
            <button className="btn-gen" disabled={!scene.trim() || (!!suivi && suivi.clip !== 'done' && suivi.photo !== 'blocked')} onClick={() => void lancer()}>{t('Image puis clip')}</button>
            {etape && <p style={{ margin: 0, fontSize: 13 }}>{etape}</p>}
            {err && <p style={{ margin: 0, fontSize: 13, color: 'var(--danger)' }}>{err}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
