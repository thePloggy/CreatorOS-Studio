/* Stage : on place des blocs et des personnes vus de dessus, on pose le début et la fin
   de la caméra, et le serveur en tire une maquette grise puis un plan fini (POST /api/stage).
   Rien que des nombres partent : aucun fichier, le verrou d'envoi des visiteurs reste fermé. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'

const Stage3D = lazy(() => import('./Stage3D'))

type Objet = { id: number; type: 'personne' | 'boite' | 'modele'; x: number; z: number; h: number; l: number; p: number; rot?: number; y?: number; modele?: string; url?: string }
type Modele = { nom: string; titre: string; url: string }
type Point = { x: number; z: number }

const rond = (n: number) => Math.round(n * 10) / 10

/* Les mouvements : les deux poses de caméra, position au sol et hauteur. */
type Mouvement = { id: string; label: string; cam: [Point, Point]; h: [number, number] }
const MOUVEMENTS: Mouvement[] = [
  { id: 'avance', label: 'Avancer', cam: [{ x: 0, z: 3.6 }, { x: 0, z: 1.6 }], h: [1.5, 1.5] },
  { id: 'recule', label: 'Reculer', cam: [{ x: 0, z: 1.6 }, { x: 0, z: 3.6 }], h: [1.5, 1.5] },
  { id: 'orbiteg', label: 'Orbite gauche', cam: [{ x: 2, z: 2.6 }, { x: -2, z: 2.6 }], h: [1.5, 1.5] },
  { id: 'orbited', label: 'Orbite droite', cam: [{ x: -2, z: 2.6 }, { x: 2, z: 2.6 }], h: [1.5, 1.5] },
  { id: 'grue', label: 'Grue', cam: [{ x: 0, z: 3.4 }, { x: 0, z: 3 }], h: [0.5, 3.4] },
  { id: 'travelling', label: 'Travelling', cam: [{ x: -2.4, z: 3 }, { x: 2.4, z: 3 }], h: [1.5, 1.5] },
  { id: 'fixe', label: 'Fixe', cam: [{ x: 0, z: 3 }, { x: 0, z: 3.01 }], h: [1.5, 1.5] },
]
const ACCESSOIRES: { label: string; o: Pick<Objet, 'type' | 'h' | 'l' | 'p'> }[] = [
  { label: 'Personne', o: { type: 'personne', h: 1.7, l: 0.5, p: 0.3 } },
  { label: 'Bloc', o: { type: 'boite', h: 1.2, l: 1, p: 1 } },
  { label: 'Pilier', o: { type: 'boite', h: 4, l: 0.6, p: 0.6 } },
  { label: 'Mur', o: { type: 'boite', h: 3, l: 8, p: 0.3 } },
]
const nomDe = (o: Objet) => (o.type === 'personne' ? 'Personne' : o.type === 'modele' ? 'Objet 3D' : o.l > 4 ? 'Mur' : o.h > 2.5 ? 'Pilier' : 'Bloc')

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
  const prochain = useRef(4)
  const edition = useEdition()
  const [hauteurs, setHauteurs] = useState<[number, number]>([1.5, 1.5])
  const [viseH, setViseH] = useState(1)
  const [focale, setFocale] = useState(40)
  const [vue, setVue] = useState<'plateau' | 'camera' | 'cote'>(() => window.innerWidth > 1100 ? 'cote' : 'plateau')
  const [instant, setInstant] = useState(0)
  const [lecture, setLecture] = useState(false)
  const [modeles, setModeles] = useState<Modele[]>([])
  const charger = () => fetch('/api/stage/modeles').then(r => r.json()).then((d: { modeles?: Modele[] }) => setModeles(d.modeles ?? [])).catch(() => {})
  useEffect(() => { void charger() }, [])
  const importer = async (f: File) => {
    const r = await fetch(`/api/stage/glb?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: f })
    const b = await r.json().catch(() => ({})) as { nom?: string; error?: string }
    if (!r.ok) setMsg(tServeur(b.error) ?? `HTTP ${r.status}`)
    else { await charger(); ajouterModele({ nom: b.nom!, titre: f.name, url: `/api/stage/modeles/${b.nom}` }) }
  }
  const ajouterModele = (m: Modele) => {
    const id = prochain.current++
    setObjets(l => l.length >= 16 ? l : [...l, { id, type: 'modele', x: 1, z: 0, h: 1.2, l: 1, p: 1, rot: m.nom.startsWith('imp_') ? 0 : 180, modele: m.nom, url: m.url }])
    setChoisi(id)
  }

  const repris = useAppStore(s => s.stageRepris)
  useEffect(() => {
    if (!repris) return
    setObjets(repris.objets.map((o, i) => ({ id: i + 1, l: 0.5, p: 0.3, ...o, url: (o as { modele?: string }).modele ? `/api/stage/modeles/${(o as { modele?: string }).modele}` : undefined })))
    prochain.current = repris.objets.length + 1
    const pt = (c: { oeil: number[] }): Point => ({ x: c.oeil[0], z: c.oeil[2] })
    setCam([pt(repris.camera[0]), pt(repris.camera[repris.camera.length - 1])])
    setPrompt(repris.prompt); setChoisi(null)
  }, [repris])

  const ajouter = (o: Pick<Objet, 'type' | 'h' | 'l' | 'p'>) => {
    const id = prochain.current++
    setObjets(l => l.length >= 16 ? l : [...l, { id, ...o, x: rond(-1.5 + l.length * 0.4), z: -1 }])
    setChoisi(id)
  }
  const sel = objets.find(o => o.id === choisi)
  const regler = (champ: 'h' | 'l' | 'p' | 'rot' | 'y', v: number) => setObjets(l => l.map(o => o.id === choisi ? { ...o, [champ]: v } : o))

  const poses = useMemo(() => {
    const vise = objets.find(o => o.type === 'personne') ?? objets[0]
    return cam.map((c, i) => ({ oeil: [c.x, hauteurs[i], c.z], cible: [vise.x, viseH, vise.z], fov: focale }))
  }, [objets, cam, hauteurs, viseH, focale])
  const lancer = async () => {
    setMsg(''); setOccupe(true)
    const scene = {
      objets: objets.map(({ type, x, z, h, l, p, rot, y, modele }) => ({ type, x, z, h, l, p, rot, y, modele })),
      camera: poses.map((c, i) => ({ t: i, ...c })),
    }
    try {
      const r = await fetch('/api/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene, prompt, format, secondes }) })
      const b = await r.json().catch(() => ({}))
      setMsg(r.ok ? t('Plan lancé, il arrive dans la bibliothèque.') : tServeur(b.error) ?? `HTTP ${r.status}`)
    } catch (e) { setMsg(String((e as Error).message ?? e)) }
    setOccupe(false)
  }

  const [cible, setCible] = useState<HTMLElement | null>(null)
  useEffect(() => { setCible(document.getElementById('stage-vues')) }, [])
  useEffect(() => {
    if (!lecture) return
    const debut = performance.now(); let id = 0
    const pas = (n: number) => { const k = (n - debut) / (secondes * 1000); setInstant(Math.min(1, k)); if (k < 1) id = requestAnimationFrame(pas); else setLecture(false) }
    id = requestAnimationFrame(pas)
    return () => cancelAnimationFrame(id)
  }, [lecture, secondes])
  const plateau3d = (v: 'plateau' | 'camera') => (
    <Stage3D objets={objets} poses={poses} instant={instant} vue={v} choisi={choisi} format={format} onChoisir={setChoisi}
      onBouger={(id, x, z) => setObjets(l => l.map(o => o.id === id ? { ...o, x, z } : o))}
      onCam={(n, x, z) => setCam(c => (n === 0 ? [{ x, z }, c[1]] : [c[0], { x, z }]))} />
  )
  /* Le plateau occupe la grande zone de droite (cf. #stage-vues dans VideoView) ; sur téléphone, le volet. */
  const vues = (
    <div className="flex flex-col gap-2" style={{ height: cible ? '100%' : 460, padding: cible ? '12px 16px 6px' : 0, minHeight: 0 }}>
      <div className="flex gap-4 items-center text-[12px]">
        {(['cote', 'plateau', 'camera'] as const).map(v => <button key={v} className={`onglet ${vue === v ? 'on' : ''}`} onClick={() => setVue(v)}>{t(v === 'cote' ? 'Côte à côte' : v === 'plateau' ? 'Plateau' : 'Caméra')}</button>)}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--faint)', fontSize: 11 }}>{t(vue !== 'camera' ? 'Glisse un accessoire ou un repère rose. Glisse le vide pour tourner, molette pour zoomer.' : 'Ce que verra la caméra à cet instant.')}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}><Suspense fallback={null}>
        {(vue === 'cote' ? ['plateau', 'camera'] as const : [vue]).length > 1
          ? <div className="stage-cote">
              <div><small>{t('Plateau')}</small>{plateau3d('plateau')}</div>
              <div><small>{t('Vue caméra')}</small>{plateau3d('camera')}</div>
            </div>
          : plateau3d(vue as 'plateau' | 'camera')}
      </Suspense></div>
      <div className="flex gap-3 items-center text-[11px]" style={{ color: 'var(--muted)' }}>
        <button className="pill" aria-label={t('Lecture')} onClick={() => { setInstant(0); if (vue === 'plateau') setVue('camera'); setLecture(true) }}>▶</button>
        <input type="range" className="flex-1" min={0} max={1} step={0.01} value={instant} onChange={e => { setLecture(false); setInstant(Number(e.target.value)) }} />
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{(instant * secondes).toFixed(1)} s / {secondes} s</span>
      </div>
    </div>
  )
  return (<>
    {cible ? createPortal(vues, cible) : vues}
    <h2 className="titre-outil">Stage</h2>
    <div className="etiquette">{t('Le plan')}</div>
    <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} maxLength={1200} style={{ width: '100%' }}
      placeholder={t('Décris ce que chaque forme devient : le lieu, la personne, la lumière…')} />
    <div className="etiquette">{t('Caméra')}</div>
    <div className="flex gap-1.5 flex-wrap">
      {MOUVEMENTS.map(m => <button key={m.id} className="pill" onClick={() => { setCam(m.cam); setHauteurs(m.h) }}>{t(m.label)}</button>)}
    </div>
    <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <label className="flex items-center gap-2">{t('Hauteur au début')}<input type="range" className="flex-1" min={0.2} max={6} step={0.1} value={hauteurs[0]} onChange={e => setHauteurs(h => [Number(e.target.value), h[1]])} /></label>
      <label className="flex items-center gap-2">{t('Hauteur à la fin')}<input type="range" className="flex-1" min={0.2} max={6} step={0.1} value={hauteurs[1]} onChange={e => setHauteurs(h => [h[0], Number(e.target.value)])} /></label>
      <label className="flex items-center gap-2">{t('Hauteur visée')}<input type="range" className="flex-1" min={0} max={4} step={0.1} value={viseH} onChange={e => setViseH(Number(e.target.value))} /></label>
      <label className="flex items-center gap-2">{t('Focale')}<input type="range" className="flex-1" min={20} max={90} step={1} value={focale} onChange={e => setFocale(Number(e.target.value))} /></label>
    </div>
    <div className="flex gap-1.5 flex-wrap">
      {['16:9', '9:16', '1:1'].map(f => <button key={f} className="pill" style={format === f ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setFormat(f)}>{f}</button>)}
      {[3, 4, 5].map(n => <button key={n} className="pill" style={secondes === n ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setSecondes(n)}>{n} s</button>)}
    </div>
    <div className="etiquette">{t('Accessoires')} · {objets.length}</div>
    <div className="flex gap-1.5 flex-wrap">
      {ACCESSOIRES.map(a => <button key={a.label} className="pill" onClick={() => ajouter(a.o)}>+ {t(a.label)}</button>)}
      {modeles.length > 0 && <select value="" onChange={e => { const m = modeles.find(x => x.nom === e.target.value); if (m) ajouterModele(m) }} className="pill" style={{ maxWidth: 150 }}>
        <option value="">{t('+ Objet 3D')}</option>
        {modeles.map(m => <option key={m.nom} value={m.nom}>{m.titre.slice(0, 32)}</option>)}
      </select>}
      {edition && <label className="pill" style={{ cursor: 'pointer' }}>{t('Importer .glb')}
        <input type="file" accept=".glb,model/gltf-binary" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void importer(f); e.target.value = '' }} /></label>}
    </div>
    <div className="flex gap-1.5 flex-wrap">
      {objets.map(o => <button key={o.id} className="pill tool" style={o.id === choisi ? { background: 'var(--lv4)', color: 'var(--text)' } : undefined} onClick={() => setChoisi(o.id)}>{t(nomDe(o))} <small>{rond(o.h)} m</small></button>)}
    </div>
    {sel && (
      <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
        <label className="flex items-center gap-2">{t('Hauteur')}<input type="range" className="flex-1" min={0.3} max={sel.type === 'personne' ? 2.2 : 6} step={0.1} value={sel.h} onChange={e => regler('h', Number(e.target.value))} /></label>
        <label className="flex items-center gap-2">{t('Rotation')}<input type="range" className="flex-1" min={-180} max={180} step={5} value={sel.rot ?? 0} onChange={e => regler('rot', Number(e.target.value))} /></label>
        {sel.type === 'modele' && <label className="flex items-center gap-2">{t('Élévation')}<input type="range" className="flex-1" min={0} max={4} step={0.1} value={sel.y ?? 0} onChange={e => regler('y', Number(e.target.value))} /></label>}
        {sel.type === 'boite' && <label className="flex items-center gap-2">{t('Largeur')}<input type="range" className="flex-1" min={0.3} max={12} step={0.1} value={sel.l} onChange={e => regler('l', Number(e.target.value))} /></label>}
        {sel.type === 'boite' && <label className="flex items-center gap-2">{t('Profondeur')}<input type="range" className="flex-1" min={0.2} max={8} step={0.1} value={sel.p} onChange={e => regler('p', Number(e.target.value))} /></label>}
        {objets.length > 1 && <button className="pill" style={{ alignSelf: 'flex-start' }} onClick={() => { setObjets(l => l.filter(o => o.id !== choisi)); setChoisi(null) }}>{t('Retirer')}</button>}
      </div>
    )}
    {msg && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{msg}</div>}
    <button className="cta" style={{ padding: '14px', flexDirection: 'row' }} disabled={occupe || !prompt.trim()} onClick={() => void lancer()}>{t('Tourner le plan')} <small>{format} · {secondes} s · ~3 min</small></button>
  </>)
}
