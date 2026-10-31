/* Stage (31/10) : on place des blocs et des personnes vus de dessus, on pose le début et la fin
   de la caméra, et le serveur en tire une maquette grise puis un plan fini (POST /api/stage).
   Rien que des nombres partent : aucun fichier, le verrou d'envoi des visiteurs reste fermé. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'

type Objet = { id: number; type: 'personne' | 'boite'; x: number; z: number; h: number; l: number; p: number }
type Point = { x: number; z: number }
type Prise = { genre: 'objet'; id: number } | { genre: 'cam'; n: 0 | 1 } | null

const COTE = 300, DEMI = 6, Z_HAUT = -8                          // la vue couvre 12 × 12 m
const versPx = (x: number, z: number) => [(x + DEMI) / (2 * DEMI) * COTE, (z - Z_HAUT) / (2 * DEMI) * COTE]
const versM = (px: number, py: number) => ({ x: px / COTE * 2 * DEMI - DEMI, z: py / COTE * 2 * DEMI + Z_HAUT })
const rond = (n: number) => Math.round(n * 10) / 10
const borne = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))

const MOUVEMENTS: { id: string; label: string; cam: [Point, Point] }[] = [
  { id: 'avance', label: 'Avancer', cam: [{ x: 0, z: 3.4 }, { x: 0, z: 1.6 }] },
  { id: 'recule', label: 'Reculer', cam: [{ x: 0, z: 1.6 }, { x: 0, z: 3.4 }] },
  { id: 'travelling', label: 'Travelling', cam: [{ x: -2, z: 3 }, { x: 2, z: 3 }] },
  { id: 'fixe', label: 'Fixe', cam: [{ x: 0, z: 3 }, { x: 0, z: 3.01 }] },
]

export function StagePanel() {
  const [objets, setObjets] = useState<Objet[]>([
    { id: 1, type: 'personne', x: 0, z: 0, h: 1.7, l: 0.5, p: 0.3 },
    { id: 2, type: 'boite', x: 1.8, z: -0.6, h: 1, l: 1.4, p: 0.8 },
    { id: 3, type: 'boite', x: 0, z: -4, h: 3.2, l: 10, p: 0.3 },
  ])
  const [cam, setCam] = useState<[Point, Point]>([{ x: 0.5, z: 3.4 }, { x: -0.3, z: 1.8 }])
  const [choisi, setChoisi] = useState<number | null>(1)
  const [prompt, setPrompt] = useState('')
  const [format, setFormat] = useState('16:9')
  const [secondes, setSecondes] = useState(4)
  const [msg, setMsg] = useState('')
  const [occupe, setOccupe] = useState(false)
  const prise = useRef<Prise>(null)
  const svg = useRef<SVGSVGElement>(null)
  const prochain = useRef(4)

  const repris = useAppStore(s => s.stageRepris)
  useEffect(() => {
    if (!repris) return
    setObjets(repris.objets.map((o, i) => ({ id: i + 1, l: 0.5, p: 0.3, ...o })))
    prochain.current = repris.objets.length + 1
    const pt = (c: { oeil: number[] }): Point => ({ x: c.oeil[0], z: c.oeil[2] })
    setCam([pt(repris.camera[0]), pt(repris.camera[repris.camera.length - 1])])
    setPrompt(repris.prompt); setChoisi(null)
  }, [repris])

  const bouger = (e: React.PointerEvent) => {
    const p = prise.current, r = svg.current?.getBoundingClientRect()
    if (!p || !r) return
    const m = versM((e.clientX - r.left) / r.width * COTE, (e.clientY - r.top) / r.height * COTE)
    const x = rond(borne(m.x, -DEMI, DEMI)), z = rond(borne(m.z, Z_HAUT, Z_HAUT + 2 * DEMI))
    if (p.genre === 'objet') setObjets(l => l.map(o => o.id === p.id ? { ...o, x, z } : o))
    else setCam(c => (p.n === 0 ? [{ x, z }, c[1]] : [c[0], { x, z }]))
  }
  const ajouter = (type: Objet['type']) => {
    const id = prochain.current++
    setObjets(l => l.length >= 16 ? l : [...l, type === 'personne' ? { id, type, x: -1, z: 0, h: 1.7, l: 0.5, p: 0.3 } : { id, type, x: -1.5, z: -1, h: 1.2, l: 1, p: 1 }])
    setChoisi(id)
  }
  const sel = objets.find(o => o.id === choisi)
  const regler = (champ: 'h' | 'l' | 'p', v: number) => setObjets(l => l.map(o => o.id === choisi ? { ...o, [champ]: v } : o))

  const lancer = async () => {
    setMsg(''); setOccupe(true)
    const vise = objets.find(o => o.type === 'personne') ?? objets[0]
    const cible = [vise.x, 1, vise.z]
    const scene = {
      objets: objets.map(({ type, x, z, h, l, p }) => ({ type, x, z, h, l, p })),
      camera: cam.map((c, i) => ({ t: i, oeil: [c.x, 1.5, c.z], cible, fov: 40 })),
    }
    try {
      const r = await fetch('/api/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene, prompt, format, secondes }) })
      const b = await r.json().catch(() => ({}))
      setMsg(r.ok ? t('Plan lancé, il arrive dans la bibliothèque.') : tServeur(b.error) ?? `HTTP ${r.status}`)
    } catch (e) { setMsg(String((e as Error).message ?? e)) }
    setOccupe(false)
  }

  const [c0x, c0y] = versPx(cam[0].x, cam[0].z), [c1x, c1y] = versPx(cam[1].x, cam[1].z)
  return (<>
    <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('Vue de dessus : glisse les formes et les deux caméras.')}</div>
    <svg ref={svg} viewBox={`0 0 ${COTE} ${COTE}`} style={{ width: '100%', background: 'var(--lv2)', borderRadius: 12, touchAction: 'none', cursor: 'grab' }}
      onPointerMove={bouger} onPointerUp={() => { prise.current = null }} onPointerLeave={() => { prise.current = null }}>
      {Array.from({ length: 11 }, (_, i) => (i + 1) * 25).map(n => <g key={n} stroke="rgba(255,255,255,.05)"><line x1={n} y1={0} x2={n} y2={COTE} /><line x1={0} y1={n} x2={COTE} y2={n} /></g>)}
      {[...objets].sort((a, b) => Number(a.type === 'personne') - Number(b.type === 'personne')).map(o => {
        const [x, y] = versPx(o.x, o.z), on = o.id === choisi
        const saisir = (e: React.PointerEvent) => { e.stopPropagation(); setChoisi(o.id); prise.current = { genre: 'objet', id: o.id } }
        return o.type === 'personne'
          ? <circle key={o.id} cx={x} cy={y} r={8} fill="#f6a961" stroke={on ? '#fff' : 'none'} strokeWidth={2} onPointerDown={saisir} />
          : <rect key={o.id} x={x - o.l * 12.5} y={y - o.p * 12.5} width={o.l * 25} height={o.p * 25} fill="#8a8d96" stroke={on ? '#fff' : 'none'} strokeWidth={2} onPointerDown={saisir} />
      })}
      <line x1={c0x} y1={c0y} x2={c1x} y2={c1y} stroke="#ea4e89" strokeDasharray="4 4" />
      {([[c0x, c0y], [c1x, c1y]] as const).map(([x, y], n) => (
        <g key={n} onPointerDown={e => { e.stopPropagation(); prise.current = { genre: 'cam', n: n as 0 | 1 } }}>
          <circle cx={x} cy={y} r={10} fill="#ea4e89" />
          <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none' }}>{n + 1}</text>
        </g>
      ))}
    </svg>
    <div className="flex gap-1.5 flex-wrap">
      <button className="pill" onClick={() => ajouter('personne')}>{t('+ Personne')}</button>
      <button className="pill" onClick={() => ajouter('boite')}>{t('+ Bloc')}</button>
      {sel && objets.length > 1 && <button className="pill" onClick={() => { setObjets(l => l.filter(o => o.id !== choisi)); setChoisi(null) }}>{t('Retirer')}</button>}
    </div>
    {sel && (
      <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
        <label className="flex items-center gap-2">{t('Hauteur')}<input type="range" className="flex-1" min={0.3} max={sel.type === 'personne' ? 2.2 : 6} step={0.1} value={sel.h} onChange={e => regler('h', Number(e.target.value))} /></label>
        {sel.type === 'boite' && <label className="flex items-center gap-2">{t('Largeur')}<input type="range" className="flex-1" min={0.3} max={12} step={0.1} value={sel.l} onChange={e => regler('l', Number(e.target.value))} /></label>}
        {sel.type === 'boite' && <label className="flex items-center gap-2">{t('Profondeur')}<input type="range" className="flex-1" min={0.2} max={8} step={0.1} value={sel.p} onChange={e => regler('p', Number(e.target.value))} /></label>}
      </div>
    )}
    <div className="flex gap-1.5 items-center flex-wrap text-[11px]" style={{ color: 'var(--muted)' }}>
      {t('Caméra')}
      {MOUVEMENTS.map(m => <button key={m.id} className="pill" onClick={() => setCam(m.cam)}>{t(m.label)}</button>)}
    </div>
    <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} maxLength={1200} style={{ width: '100%' }}
      placeholder={t('Décris ce que chaque forme devient : le lieu, la personne, la lumière…')} />
    <div className="flex gap-1.5 flex-wrap">
      {['16:9', '9:16', '1:1'].map(f => <button key={f} className="pill" style={format === f ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setFormat(f)}>{f}</button>)}
      {[3, 4, 5].map(n => <button key={n} className="pill" style={secondes === n ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setSecondes(n)}>{n} s</button>)}
    </div>
    {msg && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{msg}</div>}
    <button className="cta" style={{ padding: '14px', flexDirection: 'row' }} disabled={occupe || !prompt.trim()} onClick={() => void lancer()}>{t('Tourner le plan')}</button>
  </>)
}
