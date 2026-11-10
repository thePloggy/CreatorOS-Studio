/* Sketch to video: draw the scene as line art, describe it, choose what moves.
   The server derives an image (FLUX.2 Klein) then a clip (LTX-2.5), saved to the library. */
import { useEffect, useRef, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { ChoixPersonnage } from './ChoixPersonnage'

const FORMATS = { '16:9': [960, 540], '9:16': [405, 720], '1:1': [600, 600] } as const
type Format = keyof typeof FORMATS
type Photo = { job: string; statut: string | null; assetId: string | null; uri: string | null }
type Etat = { id: string; photo: string | null; clip: string | null; photos?: Photo[]; choix?: string | null; clipJob?: string | null; avecPersonnage?: boolean }

export function CroquisView() {
  const toile = useRef<HTMLCanvasElement>(null)
  const [format, setFormat] = useState<Format>('16:9')
  const [epaisseur, setEpaisseur] = useState(6)
  const [gomme, setGomme] = useState(false)
  const [scene, setScene] = useState('')
  const [mouvement, setMouvement] = useState('')
  const [suivi, setSuivi] = useState<Etat | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // hovered proposal (large preview) and selected proposal (to confirm before animating)
  const [survol, setSurvol] = useState<string | null>(null)
  const [retenue, setRetenue] = useState<string | null>(null)
  const histo = useRef<ImageData[]>([])
  const adopter = useAppStore(s => s.adoptServerJob)
  const [w, h] = FORMATS[format]

  const fond = () => { const c = toile.current!; const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); histo.current = [] }
  useEffect(fond, [format])
  useEffect(() => {
    if (!suivi || suivi.clip === 'done') return
    const h = setInterval(() => void fetch(`/api/croquis/${suivi.id}`).then(r => (r.ok ? r.json() : null)).then((d: Etat | null) => {
      if (!d) return
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
    setRetenue(null); setSurvol(null)
    setSuivi(d); for (const p of (d.photos ?? []) as Photo[]) void adopter(p.job)
  }
  const choisir = async (assetId: string) => {
    if (!suivi) return
    setErr(null)
    const r = await fetch(`/api/croquis/${suivi.id}/choisir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setSuivi(d); if (d.clipJob) void adopter(d.clipJob)
  }
  // the hovered or selected image is shown large over the sketch; the sketch returns on leave
  const apercu = (suivi?.photos ?? []).find(p => p.assetId && p.assetId === (survol ?? (suivi?.clipJob ? null : retenue)))?.uri ?? undefined
  const enAttenteDeChoix = !!suivi && !suivi.clipJob && suivi.photo !== 'blocked'
  const etape = !suivi ? null : suivi.clip === 'done' ? t('Clip prêt : il est dans la bibliothèque.') : suivi.clipJob ? t('Le clip se rend à partir de l’image choisie (~5 min)…')
    : suivi.photo === 'blocked' ? t('Les images ont échoué : réessaie.') : suivi.photos?.some(p => p.uri) ? t('Survole une image pour la voir en grand, clique pour la retenir, puis confirme.') : t('Trois images se rendent à partir du croquis…')

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 14 }}>
        <div>
          <h2 className="titre-outil">{t('Croquis vers vidéo')}</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('Dessine la scène au trait : FLUX.2 Klein en fait une image qui garde ta composition, puis LTX-2.5 l’anime avec le son.')}</p>
        </div>
        <div className="croquis">
          <div className="croquis-toile">
            <div style={{ position: 'relative', justifySelf: 'center', width: `min(100%, calc(70vh * ${w / h}))` }}>
            <canvas ref={toile} width={w} height={h} style={{ aspectRatio: `${w} / ${h}`, width: '100%' }}
              onPointerDown={debut} onPointerMove={trace} onPointerUp={() => { dessin.current = null }} onPointerLeave={() => { dessin.current = null }} />
              {apercu && (
                <img src={apercu} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 14, pointerEvents: 'none', boxShadow: '0 0 0 2px var(--accent)' }} />
              )}
            </div>
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
            <button className="btn-gen" disabled={!scene.trim() || (!!suivi && !!suivi.clipJob && suivi.clip !== 'done')} onClick={() => void lancer()}>{suivi && !suivi.clipJob ? t('3 autres images') : t('3 images, puis le clip')}</button>
            {etape && <p style={{ margin: 0, fontSize: 13 }}>{etape}</p>}
            {suivi && suivi.avecPersonnage === false && <p className="texte-doux" style={{ margin: 0, fontSize: 12 }}>{t('La description ne parle d’aucune personne : l’image est rendue sans personnage. Nomme-la ou décris-la pour la faire apparaître.')}</p>}
            {suivi?.photos && (enAttenteDeChoix || suivi.choix) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {suivi.photos.map(p => (
                  <button key={p.job} disabled={!p.assetId || !!suivi.clipJob} onClick={() => p.assetId && setRetenue(p.assetId)}
                    onMouseEnter={() => p.assetId && setSurvol(p.assetId)} onMouseLeave={() => setSurvol(null)} onFocus={() => p.assetId && setSurvol(p.assetId)} onBlur={() => setSurvol(null)}
                    aria-pressed={(retenue ?? suivi.choix) === p.assetId} aria-label={t('voir cette image en grand et la retenir')}
                    style={{ padding: 0, borderRadius: 8, overflow: 'hidden', aspectRatio: format === '9:16' ? '9 / 16' : format === '1:1' ? '1' : '16 / 9', background: 'var(--lv2)',
                      border: (retenue ?? suivi.choix) === p.assetId ? '2px solid var(--accent)' : '2px solid transparent', cursor: p.assetId && !suivi.clipJob ? 'pointer' : 'default',
                      opacity: (retenue ?? suivi.choix) && (retenue ?? suivi.choix) !== p.assetId ? 0.45 : 1 }}>
                    {p.uri ? <img src={p.uri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      : <span className="texte-faible" style={{ fontSize: 11 }}>{p.statut === 'blocked' ? t('échec') : '…'}</span>}
                  </button>
                ))}
              </div>
            )}
            {retenue && !suivi?.clipJob && (
              <div className="flex gap-2 items-center flex-wrap">
                <button className="btn-gen" style={{ flex: 1 }} onClick={() => void choisir(retenue)}>{t('Animer cette image')}</button>
                <button className="pill" onClick={() => setRetenue(null)}>{t('Annuler')}</button>
              </div>
            )}
            {err && <p style={{ margin: 0, fontSize: 13, color: 'var(--danger)' }}>{err}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
