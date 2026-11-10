/* ============================================================
   Montage — mini-éditeur de reel. Les plans viennent de la
   bibliothèque (clips et photos) ; on les ordonne, on les coupe, on choisit
   la transition vers le suivant, un texte par plan et une musique. L'aperçu
   rejoue la suite dans le navigateur (coupes et textes ; les fondus ne sont
   rendus qu'à l'export). L'export est un rendu ffmpeg côté serveur
   (server/montage.js) livré comme un asset vidéo de la bibliothèque.
   ============================================================ */
import { nomMedia } from '../lib/nomMedia'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { vignetteOf } from '../components/AssetMedia'
import { fetchAssetsDe } from '../worker/apiWorker'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { GenererMusique } from './GenererMusique'
import { Ic } from './bits'

type Transition = 'coupe' | 'fondu' | 'noir'
interface Plan {
  assetId: string; debut: number; fin: number | null; duree: number
  texte: string; textePos: 'haut' | 'centre' | 'bas'; transition: Transition; transitionDuree: number
  /** Zone gardée de l'image source, en fractions (0..1). Absente = image entière. */
  crop?: Crop | null
}
interface Crop { x: number; y: number; w: number; h: number }
interface Musique { fichier: string; volume: number; fonduEntree: number; fonduSortie: number; decalage: number }
interface Donnees {
  format: '9:16' | '4:5' | '1:1' | '16:9'; cadrage: 'remplir' | 'flou'
  sonClips: boolean; volumeClips: number; musique: Musique | null; clips: Plan[]
}
interface Projet { id: string; nom: string; data: Donnees }
interface Resume { id: string; nom: string; updatedAt: number; clips: number }
interface MusiqueRow { nom: string; duree: number }

const RATIO: Record<Donnees['format'], number> = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 }
const PX_SEC = 46
const ESPACE = 26        // largeur du bouton de transition entre deux vignettes
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

export function MontageView({ onOpen, ouvrirId }: { onOpen: (a: Asset, list: Asset[]) => void; ouvrirId?: string | null }) {
  const edition = useEdition()
  const s = useAppStore()
  const [liste, setListe] = useState<Resume[]>([])
  const [projet, setProjet] = useState<Projet | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [choisir, setChoisir] = useState(false)
  const [musiques, setMusiques] = useState<MusiqueRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [rendu, setRendu] = useState<{ jobId: string; p: number | null; etat: 'en cours' | 'livre' | 'echec'; msg?: string } | null>(null)
  const [durees, setDurees] = useState<Record<string, number>>({})   // durée réelle des clips, lue sur le fichier

  const charger = useCallback(() => void fetch('/api/montages').then(json).then(d => setListe(d.montages ?? [])).catch(e => setErr(String(e.message))), [])
  // un vrai changement de personnage ferme le projet ; l'arrivée de l'actif au chargement, non
  const personaVu = useRef(s.personaId)
  useEffect(() => {
    charger()
    if (personaVu.current && personaVu.current !== s.personaId) { setProjet(null); setSel(null) }
    personaVu.current = s.personaId
  }, [charger, s.personaId])
  useEffect(() => { void fetch('/api/montage/musiques').then(json).then(d => setMusiques(d.musiques ?? [])).catch(() => {}) }, [])

  /* Enregistrement automatique, 700 ms après la dernière modification. */
  const aEcrire = useRef<Projet | null>(null)
  useEffect(() => {
    if (!projet) return
    aEcrire.current = projet
    const h = setTimeout(() => {
      const p = aEcrire.current
      if (p) void fetch(`/api/montages/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: p.nom, data: p.data }) })
        .then(json).catch(e => setErr(String(e.message)))
    }, 700)
    return () => clearTimeout(h)
  }, [projet])

  const ouvrir = async (id: string) => { setErr(null); setSel(null); setRendu(null); try { setProjet(await json(await fetch(`/api/montages/${id}`))) } catch (e) { setErr(String((e as Error).message)) } }
  const nouveau = async () => {
    try { const p = await json(await fetch('/api/montages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: t('Nouveau montage') }) })); charger(); setProjet(p); setSel(null) }
    catch (e) { setErr(String((e as Error).message)) }
  }
  const supprimer = async (id: string) => {
    await fetch(`/api/montages/${id}`, { method: 'DELETE' }).catch(() => {})
    if (projet?.id === id) setProjet(null)
    charger()
  }
  // arrivée depuis un reel en un clic : on ouvre son montage
  useEffect(() => { if (ouvrirId) void ouvrir(ouvrirId) }, [ouvrirId]) // eslint-disable-line react-hooks/exhaustive-deps
  const maj = (f: (d: Donnees) => Donnees) => setProjet(p => p && { ...p, data: f(p.data) })
  const majPlan = (i: number, patch: Partial<Plan>) => maj(d => ({ ...d, clips: d.clips.map((c, k) => k === i ? { ...c, ...patch } : c) }))
  /* Transition générée : LTX-2.5 relie la dernière image gardée d'un plan à la première gardée du suivant
     (coupe et recadrage des plans, format du montage), avec le son ; le clip rendu est inséré entre les deux,
     en coupes franches. Clé = le plan de départ (son asset), pour retrouver sa place si l'ordre a bougé. */
  const [transitions, setTransitions] = useState<Record<string, { jobId: string; vers: string; duree: number }>>({})
  const [effetsTrans, setEffetsTrans] = useState<{ id: string; nom: string }[]>([])
  const [effetTrans, setEffetTrans] = useState('fondu')
  const [dureeTrans, setDureeTrans] = useState(5)
  useEffect(() => { void fetch('/api/montage/transition').then(r => r.json()).then((x: { effets?: { id: string; nom: string }[] }) => setEffetsTrans(x.effets ?? [])).catch(() => {}) }, [])
  // gardées par projet dans le navigateur : quitter la page pendant le rendu ne perd pas l'insertion
  const cleTrans = projet ? `creatoros-transitions-${projet.id}` : null
  useEffect(() => {
    if (!cleTrans) return
    try { setTransitions(JSON.parse(localStorage.getItem(cleTrans) ?? '{}')) } catch { setTransitions({}) }
  }, [cleTrans])
  useEffect(() => {
    if (!cleTrans) return
    try { if (Object.keys(transitions).length) localStorage.setItem(cleTrans, JSON.stringify(transitions)); else localStorage.removeItem(cleTrans) } catch { /* stockage refusé */ }
  }, [cleTrans, transitions])
  const genererTransition = async (i: number) => {
    if (!projet) return
    const A = projet.data.clips[i], B = projet.data.clips[i + 1]
    if (!A || !B || !assets[A.assetId] || !assets[B.assetId]) return
    setErr(null)
    const bord = (c: Plan) => ({ assetId: c.assetId, debut: c.debut, fin: c.fin, crop: c.crop ?? null })
    try {
      const r = await json(await fetch('/api/montage/transition', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: projet.data.format, a: bord(A), b: bord(B), effet: effetTrans, secondes: dureeTrans }) }))
      if (!r.id) throw new Error(r.error ?? 'transition refusée')
      void s.adoptServerJob(r.id)
      setTransitions(x => ({ ...x, [A.assetId]: { jobId: r.id, vers: B.assetId, duree: dureeTrans } }))
    } catch (e) { setErr(String((e as Error).message)) }
  }
  // dès que le clip de transition arrive dans la bibliothèque, il prend sa place dans le montage
  useEffect(() => {
    for (const [de, { jobId, vers, duree: dt }] of Object.entries(transitions)) {
      const clip = s.assets.find(a => a.jobId === jobId && a.mediaType === 'video')
      if (!clip) continue
      setTransitions(x => { const y = { ...x }; delete y[de]; return y })
      maj(dd => {
        const i = dd.clips.findIndex((c, k) => c.assetId === de && dd.clips[k + 1]?.assetId === vers)
        const insere: Plan = { assetId: clip.id, debut: 0, fin: null, duree: dt ?? 5, texte: '', textePos: 'bas', transition: 'coupe', transitionDuree: 0.5 }
        if (i < 0) return { ...dd, clips: [...dd.clips, insere] }
        const clips = dd.clips.map((c, k) => k === i ? { ...c, transition: 'coupe' as const } : c)
        return { ...dd, clips: [...clips.slice(0, i + 1), insere, ...clips.slice(i + 1)] }
      })
    }
  }, [s.assets, transitions])  // eslint-disable-line react-hooks/exhaustive-deps

  /* Un plan peut venir d'un rendu absent de la bibliothèque chargée (autre
     personnage, au-delà de la page chargée) : on va le chercher au serveur. */
  const [ailleurs, setAilleurs] = useState<Record<string, Asset>>({})
  const assets = useMemo(() => ({ ...ailleurs, ...Object.fromEntries(s.assets.map(a => [a.id, a])) }), [s.assets, ailleurs])
  const manquants = (projet?.data.clips ?? []).filter(c => !assets[c.assetId]).length
  useEffect(() => {
    if (!manquants) return
    void fetchAssetsDe('all').then(l => setAilleurs(Object.fromEntries(l.map(a => [a.id, a])))).catch(() => {})
  }, [manquants > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const dureeTotale = (c: Plan) => durees[c.assetId] ?? assets[c.assetId]?.durationS ?? 5
  const estVideo = (c: Plan) => assets[c.assetId]?.mediaType === 'video'
  const dureePlan = (c: Plan) => estVideo(c) ? Math.max(0.2, Math.min(dureeTotale(c), c.fin ?? dureeTotale(c)) - c.debut) : c.duree
  const d = projet?.data
  const longueur = useMemo(() => {
    if (!d) return 0
    return d.clips.reduce((acc, c, i) => {
      const suiv = d.clips[i + 1]
      const f = suiv && c.transition !== 'coupe' ? Math.min(c.transitionDuree, dureePlan(c) / 2, dureePlan(suiv) / 2) : 0
      return acc + dureePlan(c) - f
    }, 0)
  }, [d, durees, assets]) // eslint-disable-line react-hooks/exhaustive-deps

  const ajouter = (a: Asset) => {
    maj(dd => ({ ...dd, clips: [...dd.clips, { assetId: a.id, debut: 0, fin: null, duree: 3, texte: '', textePos: 'bas', transition: 'coupe', transitionDuree: 0.5 }] }))
    setSel(d?.clips.length ?? 0)
  }
  const deplacer = (de: number, vers: number) => maj(dd => {
    const c = [...dd.clips]; const [x] = c.splice(de, 1); c.splice(vers, 0, x); return { ...dd, clips: c }
  })

  /* ---------- export ---------- */
  const exporter = async () => {
    if (!projet) return
    setErr(null)
    try {
      await json(await fetch(`/api/montages/${projet.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: projet.nom, data: projet.data }) }))
      const r = await json(await fetch(`/api/montages/${projet.id}/export`, { method: 'POST' }))
      setRendu({ jobId: r.jobId, p: 0, etat: 'en cours' })
      void s.adoptServerJob(r.jobId)
    } catch (e) { setErr(String((e as Error).message)) }
  }
  useEffect(() => {
    if (!rendu || rendu.etat !== 'en cours') return
    const h = setInterval(async () => {
      try {
        const { progression } = await json(await fetch(`/api/montages/rendu/${rendu.jobId}`))
        const { job } = await json(await fetch(`/api/jobs/${rendu.jobId}`))
        if (job.status === 'done') setRendu(x => x && { ...x, p: 1, etat: 'livre' })
        else if (job.status === 'blocked') setRendu(x => x && { ...x, etat: 'echec', msg: tServeur(job.error) ?? '' })
        else setRendu(x => x && { ...x, p: progression })
      } catch { /* on réessaie au tour suivant */ }
    }, 1200)
    return () => clearInterval(h)
  }, [rendu?.jobId, rendu?.etat]) // eslint-disable-line react-hooks/exhaustive-deps
  const livre = rendu?.etat === 'livre' ? s.assets.find(a => a.jobId === rendu.jobId) : undefined

  /* ---------- musique ---------- */
  const deposerMusique = async (f: File) => {
    setErr(null)
    try {
      const r = await json(await fetch(`/api/montage/musiques?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': f.type || 'audio/mpeg' }, body: f }))
      setMusiques(m => [{ nom: r.nom, duree: r.duree }, ...m])
      maj(dd => ({ ...dd, musique: { fichier: r.nom, volume: 0.8, fonduEntree: 0.5, fonduSortie: 1.5, decalage: 0 } }))
    } catch (e) { setErr(String((e as Error).message)) }
  }

  const plan = sel !== null && d ? d.clips[sel] : null

  /* ---------- lecture et tête de lecture ----------
     Position = (plan, temps dans le plan). La frise et la règle partagent la
     même géométrie : vignette i de x[i] à x[i] + w[i], ESPACE entre deux. */
  const [lecture, setLecture] = useState(false)
  const [recadre, setRecadre] = useState(false)
  const [pos, setPos] = useState({ i: 0, t: 0 })
  const [cible, setCible] = useState({ i: 0, t: 0, n: 0 })
  const allerA = (p: { i: number; t: number }) => { setPos(p); setCible(c => ({ ...p, n: c.n + 1 })) }
  const geo = useMemo(() => {
    const w: number[] = [], x: number[] = [], debut: number[] = []
    let cx = 0, ct = 0
    ;(d?.clips ?? []).forEach((c, i, l) => {
      const du = dureePlan(c)
      w.push(Math.max(64, du * PX_SEC)); x.push(cx); debut.push(ct)
      cx += w[i] + (i < l.length - 1 ? ESPACE : 0)
      const suiv = l[i + 1]
      ct += du - (suiv && c.transition !== 'coupe' ? Math.min(c.transitionDuree, du / 2, dureePlan(suiv) / 2) : 0)
    })
    return { w, x, debut, total: cx }
  }, [d, durees, assets]) // eslint-disable-line react-hooks/exhaustive-deps
  const teteX = d && d.clips[pos.i] ? geo.x[pos.i] + Math.min(1, pos.t / Math.max(0.01, dureePlan(d.clips[pos.i]))) * geo.w[pos.i] : 0
  const versTemps = (px: number) => {
    const l = d?.clips ?? []
    for (let i = 0; i < l.length; i++) {
      if (px < geo.x[i] + geo.w[i] + (i < l.length - 1 ? ESPACE / 2 : 1e9)) {
        const du = dureePlan(l[i])
        return { i, t: Math.min(du - 0.02, Math.max(0, (px - geo.x[i]) / geo.w[i]) * du) }
      }
    }
    return { i: 0, t: 0 }
  }
  const basculerLecture = (on: boolean) => {
    if (on && d && pos.i === d.clips.length - 1 && pos.t >= dureePlan(d.clips[pos.i]) - 0.05) allerA({ i: 0, t: 0 })
    setLecture(on)
  }

  /* Temps GLOBAL du reel (celui de l'export, fondus compris) ↔ (plan, temps
     dans le plan). Pendant un fondu, c'est le plan suivant qui prend la main. */
  const tGlobal = d && d.clips[pos.i] ? geo.debut[pos.i] + pos.t : 0
  const versPlan = (T: number) => {
    const l = d?.clips ?? []
    if (!l.length) return { i: 0, t: 0 }
    let i = 0
    while (i + 1 < l.length && geo.debut[i + 1] <= T) i++
    return { i, t: Math.min(dureePlan(l[i]) - 0.02, Math.max(0, T - geo.debut[i])) }
  }

  /* Entrée ou Espace : lecture / pause, sauf en tapant dans un champ. Capturé
     avant le bouton qui a le focus, sinon Entrée « recliquerait » ce bouton. */
  const bascule = useRef(basculerLecture)
  bascule.current = basculerLecture
  const lectureRef = useRef(lecture)
  lectureRef.current = lecture
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const el = e.target as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      if (!projet || choisir || recadre) return
      e.preventDefault(); e.stopPropagation()
      bascule.current(!lectureRef.current)
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [projet, choisir, recadre])

  /* ---------- découpe à la souris : bords des vignettes ---------- */
  const rogne = useRef<null | { i: number; cote: 'g' | 'd'; x0: number; debut: number; fin: number; duree: number; total: number; video: boolean }>(null)
  const commencerRogne = (e: React.PointerEvent, i: number, cote: 'g' | 'd') => {
    e.stopPropagation(); e.preventDefault()
    if (!d) return
    const c = d.clips[i]
    rogne.current = { i, cote, x0: e.clientX, debut: c.debut, fin: c.fin ?? dureeTotale(c), duree: c.duree, total: dureeTotale(c), video: estVideo(c) }
    setSel(i); setLecture(false)
    const borne = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    const bouge = (ev: PointerEvent) => {
      const r = rogne.current
      if (!r) return
      const ds = (ev.clientX - r.x0) / PX_SEC
      if (!r.video) { majPlan(i, { duree: Number(borne(r.duree + ds, 0.5, 10).toFixed(2)) }); return }
      if (r.cote === 'g') {
        const v = Number(borne(r.debut + ds, 0, r.fin - 0.2).toFixed(2))
        majPlan(i, { debut: v }); allerA({ i, t: 0 })
      } else {
        const v = Number(borne(r.fin + ds, r.debut + 0.2, r.total).toFixed(2))
        majPlan(i, { fin: v >= r.total - 0.01 ? null : v }); allerA({ i, t: Math.max(0, v - r.debut - 0.04) })
      }
    }
    const fin = () => {
      window.removeEventListener('pointermove', bouge); window.removeEventListener('pointerup', fin)
      setTimeout(() => { rogne.current = null }, 0)        // le clic qui suit le relâcher ne sélectionne pas
    }
    window.addEventListener('pointermove', bouge); window.addEventListener('pointerup', fin)
  }

  /* ---------- recadrage ---------- */
  const [cropLibre, setCropLibre] = useState(false)
  useEffect(() => { if (sel === null) setRecadre(false) }, [sel])
  const ouvrirRecadre = () => {
    if (sel === null || !d || !plan) return
    setLecture(false); allerA({ i: sel, t: pos.i === sel ? pos.t : 0 })
    const a = assets[plan.assetId]
    if (!plan.crop && a) majPlan(sel, { crop: cropAuFormat(a.width || 1080, a.height || 1920, RATIO[d.format]) })
    setRecadre(true)
  }

  return (
    <div className="flex-1 min-h-0 flex mt-racine" style={{ gap: 0 }}>
      {/* ---------- projets ---------- */}
      <aside className="mt-projets" style={{ width: 210, flex: 'none', borderRight: '1px solid var(--lv2)', padding: 12, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: 6 }}>
        <button className="cta" style={{ padding: 10, flexDirection: 'row' }} onClick={() => void nouveau()}>＋ {t('Nouveau montage')}</button>
        {liste.length === 0 && <div style={{ fontSize: 12, color: 'var(--faint)', padding: '6px 2px' }}>{t('Aucun montage pour ce personnage.')}</div>}
        {liste.map(m => (
          <div key={m.id} onClick={() => void ouvrir(m.id)} style={{ padding: '8px 10px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5,
            background: projet?.id === m.id ? 'var(--lv3)' : 'var(--lv1)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.nom}</span>
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{m.clips}</span>
            <button title={t('supprimer')} onClick={e => { e.stopPropagation(); if (window.confirm(t('Supprimer ce montage ? Les clips de la bibliothèque ne sont pas touchés.'))) void supprimer(m.id) }}
              style={{ border: 0, background: 'none', color: 'var(--faint)', cursor: 'pointer', fontSize: 13 }}>×</button>
          </div>
        ))}
      </aside>

      {!projet || !d ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 30 }}>
          <div style={{ maxWidth: 420, lineHeight: 1.6 }}>
            <b style={{ fontSize: 15, color: 'var(--text)' }}>{t('Montage')}</b><br />
            {t('Mets bout à bout des clips et des photos de ta bibliothèque, coupe-les, ajoute des fondus, du texte et une musique, puis exporte le reel.')}
            {err && <div style={{ color: 'var(--danger)', marginTop: 10 }}>{err}</div>}
            <div style={{ width: 320, marginTop: 18, textAlign: 'left' }}><GenererMusique surPret={() => void fetch('/api/montage/musiques').then(json).then(r => setMusiques(r.musiques ?? []))} /></div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex flex-col">
          {/* ---------- barre du projet ---------- */}
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--lv2)', flexWrap: 'wrap' }}>
            <input value={projet.nom} onChange={e => setProjet({ ...projet, nom: e.target.value })} maxLength={80}
              style={{ background: 'transparent', border: 0, color: 'var(--text)', font: 'inherit', fontSize: 14, fontWeight: 700, minWidth: 120, flex: '0 1 240px' }} />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('{n} plan(s) · {d}', { n: d.clips.length, d: fmt(longueur) })}</span>
            <span style={{ flex: 1 }} />
            {(['9:16', '4:5', '1:1', '16:9'] as const).map(f => (
              <button key={f} className={`wtab ${d.format === f ? 'on' : ''}`} onClick={() => maj(x => ({ ...x, format: f }))}>{f}</button>
            ))}
            <span style={{ width: 1, height: 16, background: 'var(--lv3)' }} />
            {([['remplir', t('remplir')], ['flou', t('fond flou')]] as const).map(([k, l]) => (
              <button key={k} className={`wtab ${d.cadrage === k ? 'on' : ''}`} title={k === 'remplir' ? t('recadre au format') : t('image entière sur un fond flouté')}
                onClick={() => maj(x => ({ ...x, cadrage: k }))}>{l}</button>
            ))}
            <button className="cta" style={{ padding: '8px 14px', flexDirection: 'row', marginLeft: 6 }} disabled={!d.clips.length || rendu?.etat === 'en cours'}
              onClick={() => void exporter()}>{rendu?.etat === 'en cours' ? t('Export… {p} %', { p: Math.round((rendu.p ?? 0) * 100) }) : t('Exporter le reel')}</button>
          </div>
          {(err || rendu) && (
            <div className="px-4 py-1.5 text-[12px] flex items-center gap-3" style={{ borderBottom: '1px solid var(--lv2)' }}>
              {err && <span style={{ color: 'var(--danger)' }}>{err}</span>}
              {rendu?.etat === 'echec' && <span style={{ color: 'var(--danger)' }}>{t('Export échoué')} — {rendu.msg}</span>}
              {rendu?.etat === 'livre' && (<>
                <span style={{ color: 'var(--ok, #6fcf97)' }}>✓ {t('Reel livré dans la bibliothèque')}</span>
                {livre && <button className="pill tool" onClick={() => onOpen(livre, [livre])}>{t('Ouvrir')}</button>}
                {livre && <a className="pill tool" href={livre.uri} download={`${projet.nom.replace(/[^\w-]+/g, '_') || 'montage'}.mp4`}>{t('Télécharger')}</a>}
              </>)}
            </div>
          )}

          <div className="flex-1 min-h-0 flex mt-corps">
            {/* ---------- aperçu ---------- */}
            <div className="flex-1 min-w-0 flex items-center justify-center mt-apercu" style={{ padding: 16, background: '#08090b' }}>
              <Apercu d={d} assets={assets} dureePlan={dureePlan} cible={cible} lecture={lecture} onLecture={basculerLecture}
                onPos={(i, t2) => setPos(p => p.i === i && Math.abs(p.t - t2) < 0.03 ? p : { i, t: t2 })}
                onDuree={(id, s2) => setDurees(x => x[id] === s2 ? x : { ...x, [id]: s2 })}
                recadre={recadre && sel !== null} libre={cropLibre} onCrop={c2 => sel !== null && majPlan(sel, { crop: c2 })} />
            </div>

            {/* ---------- inspecteur ---------- */}
            <aside className="mt-inspecteur" style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--lv2)', padding: 14, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 12, fontSize: 12 }}>
              {plan && sel !== null ? (<>
                <div className="flex items-center gap-2">
                  <b style={{ fontSize: 13 }}>{t('Plan {n}', { n: sel + 1 })}</b>
                  <span style={{ color: 'var(--faint)' }}>{estVideo(plan) ? t('clip') : t('photo')} · {fmt(dureePlan(plan))}</span>
                  <span style={{ flex: 1 }} />
                  <button className="pill tool" disabled={sel === 0} onClick={() => { deplacer(sel, sel - 1); setSel(sel - 1) }}>←</button>
                  <button className="pill tool" disabled={sel === d.clips.length - 1} onClick={() => { deplacer(sel, sel + 1); setSel(sel + 1) }}>→</button>
                </div>
                {estVideo(plan) ? (<>
                  <Curseur label={t('Début')} min={0} max={Math.max(0.2, (plan.fin ?? dureeTotale(plan)) - 0.2)} pas={0.05} val={plan.debut}
                    onChange={v => majPlan(sel, { debut: v })} />
                  <Curseur label={t('Fin')} min={plan.debut + 0.2} max={dureeTotale(plan)} pas={0.05} val={plan.fin ?? dureeTotale(plan)}
                    onChange={v => majPlan(sel, { fin: v >= dureeTotale(plan) - 0.01 ? null : v })} />
                </>) : (
                  <Curseur label={t('Durée à l’écran')} min={0.5} max={10} pas={0.1} val={plan.duree} onChange={v => majPlan(sel, { duree: v })} />
                )}
                {!recadre ? (
                  <button className="pill tool" style={{ justifyContent: 'center' }} onClick={ouvrirRecadre}>
                    ✂ {plan.crop ? t('Modifier le recadrage') : t('Recadrer')}
                  </button>
                ) : (
                  <div style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 10, background: 'var(--lv1)' }}>
                    <b>{t('Recadrage')}</b>
                    <div className="flex gap-1">
                      <button className={`wtab ${!cropLibre ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => {
                        setCropLibre(false)
                        const a = assets[plan.assetId]
                        if (a && sel !== null) majPlan(sel, { crop: cropAuFormat(a.width || 1080, a.height || 1920, RATIO[d.format]) })
                      }}>{t('au format {f}', { f: d.format })}</button>
                      <button className={`wtab ${cropLibre ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => setCropLibre(true)}>{t('libre')}</button>
                    </div>
                    <div className="flex gap-1.5">
                      <button className="pill tool" onClick={() => { majPlan(sel, { crop: null }); setRecadre(false) }}>{t('Image entière')}</button>
                      <span style={{ flex: 1 }} />
                      <button className="pill" onClick={() => setRecadre(false)}>{t('Terminer')}</button>
                    </div>
                    {cropLibre && <span style={{ fontSize: 12, color: 'var(--faint)' }}>{t('libre : la zone gardée sera ensuite remplie ou posée sur le fond flou, selon le réglage du montage')}</span>}
                  </div>
                )}
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={{ color: 'var(--muted)' }}>{t('Texte sur le plan')}</span>
                  <textarea value={plan.texte} maxLength={220} onChange={e => majPlan(sel, { texte: e.target.value })} placeholder={t('vide = pas de texte')}
                    style={{ minHeight: 64, resize: 'vertical', padding: 8, borderRadius: 9, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12.5 }} />
                </label>
                <div className="flex gap-1">
                  {([['haut', t('haut')], ['centre', t('centre')], ['bas', t('bas')]] as const).map(([k, l]) => (
                    <button key={k} className={`wtab ${plan.textePos === k ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => majPlan(sel, { textePos: k })}>{l}</button>
                  ))}
                </div>
                {sel < d.clips.length - 1 && (<>
                  <span style={{ color: 'var(--muted)' }}>{t('Vers le plan suivant')}</span>
                  <div className="flex gap-1">
                    {([['coupe', t('coupe')], ['fondu', t('fondu')], ['noir', t('noir')]] as const).map(([k, l]) => (
                      <button key={k} className={`wtab ${plan.transition === k ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => majPlan(sel, { transition: k })}>{l}</button>
                    ))}
                  </div>
                  {plan.transition !== 'coupe' && <Curseur label={t('Durée du fondu')} min={0.2} max={1.5} pas={0.05} val={plan.transitionDuree} onChange={v => majPlan(sel, { transitionDuree: v })} />}
                  <span style={{ color: 'var(--muted)' }}>{t('Transition générée (LTX-2.5, avec le son)')}</span>
                  <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
                    {effetsTrans.map(e => <button key={e.id} className={`wtab ${effetTrans === e.id ? 'on' : ''}`} onClick={() => setEffetTrans(e.id)}>{t(e.nom)}</button>)}
                  </div>
                  <div className="flex gap-1">
                    {[3, 5, 8].map(n => <button key={n} className={`wtab ${dureeTrans === n ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => setDureeTrans(n)}>{n} s</button>)}
                  </div>
                  <button className="pill tool" disabled={!!transitions[plan.assetId]} onClick={() => void genererTransition(sel)}
                    title={t('LTX-2.5 dessine le passage de la dernière image gardée de ce plan à la première du suivant, au format du montage et avec le son ; le clip est inséré entre les deux')}>
                    {transitions[plan.assetId] ? t('✨ transition en cours de rendu…') : t('✨ Générer la transition (~1 min)')}</button>
                </>)}
                <div className="flex gap-1.5">
                  <button className="pill tool" onClick={() => maj(x => ({ ...x, clips: [...x.clips.slice(0, sel + 1), { ...plan }, ...x.clips.slice(sel + 1)] }))}>{t('Dupliquer')}</button>
                  <button className="pill tool" style={{ color: 'var(--danger)' }} onClick={() => { maj(x => ({ ...x, clips: x.clips.filter((_, k) => k !== sel) })); setSel(null) }}>{t('Retirer du montage')}</button>
                </div>
              </>) : (<>
                <b style={{ fontSize: 13 }}>{t('Son')}</b>
                <label className="flex items-center gap-2" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={d.sonClips} onChange={e => maj(x => ({ ...x, sonClips: e.target.checked }))} />
                  {t('garder le son des clips')}
                </label>
                {d.sonClips && <Curseur label={t('Volume des clips')} min={0} max={1.5} pas={0.05} val={d.volumeClips} pct onChange={v => maj(x => ({ ...x, volumeClips: v }))} />}
                <span style={{ color: 'var(--muted)' }}>{t('Musique')}</span>
                <select value={d.musique?.fichier ?? ''} onChange={e => maj(x => ({ ...x, musique: e.target.value ? { fichier: e.target.value, volume: x.musique?.volume ?? 0.8, fonduEntree: 0.5, fonduSortie: 1.5, decalage: 0 } : null }))}
                  style={{ padding: 7, borderRadius: 9, background: 'var(--lv1)', border: '1px solid var(--lv3)', color: 'var(--text)', font: 'inherit', fontSize: 12 }}>
                  <option value="">{t('aucune')}</option>
                  {musiques.map(m => <option key={m.nom} value={m.nom}>{m.nom} ({fmt(m.duree)})</option>)}
                </select>
                <GenererMusique surPret={() => void fetch('/api/montage/musiques').then(json).then(r => setMusiques(r.musiques ?? []))} />
                {edition && <label className="pill tool" style={{ justifyContent: 'center', cursor: 'pointer' }}>＋ {t('ajouter une musique…')}
                  <input type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void deposerMusique(f); e.target.value = '' }} />
                </label>}
                {d.musique && (<>
                  <audio src={`/api/montage/musiques/${encodeURIComponent(d.musique.fichier)}`} controls style={{ width: '100%', height: 32 }} />
                  <Curseur label={t('Volume de la musique')} min={0} max={1.5} pas={0.05} val={d.musique.volume} pct onChange={v => maj(x => ({ ...x, musique: x.musique && { ...x.musique, volume: v } }))} />
                  <Curseur label={t('Départ dans la musique')} min={0} max={Math.max(1, (musiques.find(m => m.nom === d.musique?.fichier)?.duree ?? 60) - 1)} pas={0.5} val={d.musique.decalage}
                    onChange={v => maj(x => ({ ...x, musique: x.musique && { ...x.musique, decalage: v } }))} />
                  <Curseur label={t('Fondu de fin')} min={0} max={8} pas={0.25} val={d.musique.fonduSortie} onChange={v => maj(x => ({ ...x, musique: x.musique && { ...x.musique, fonduSortie: v } }))} />
                </>)}
                <div style={{ fontSize: 12, color: 'var(--faint)', lineHeight: 1.5 }}>
                  {t('Clique un plan de la frise pour le couper, lui mettre un texte ou choisir la transition vers le suivant. Glisse-dépose pour changer l’ordre.')}
                </div>
              </>)}
            </aside>
          </div>

          {/* ---------- timeline globale : le reel à l'échelle, de 0 à la fin ----------
              Clic ou glisser n'importe où (la barre verticale suit) pour se
              promener dans le montage ; les plans se chevauchent sur leurs fondus. */}
          {d.clips.length > 0 && (
            <div style={{ borderTop: '1px solid var(--lv2)', padding: '8px 14px 2px', flex: 'none' }}>
              <div className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(tGlobal)}</span>
                <span>/ {fmt(longueur)}</span>
                <span style={{ color: 'var(--faint)' }}>{t('Entrée ou Espace : lecture / pause')}</span>
              </div>
              <div onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setLecture(false); const r = e.currentTarget.getBoundingClientRect(); allerA(versPlan((e.clientX - r.left) / r.width * longueur)) }}
                onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const r = e.currentTarget.getBoundingClientRect(); allerA(versPlan(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * longueur)) }}
                style={{ position: 'relative', height: 42, flex: 'none', borderRadius: 7, background: 'var(--lv1)', cursor: 'ew-resize', touchAction: 'none', overflow: 'hidden' }}>
                {d.clips.map((c, i) => {
                  const a = assets[c.assetId]
                  const g = longueur > 0 ? geo.debut[i] / longueur * 100 : 0, w = longueur > 0 ? dureePlan(c) / longueur * 100 : 0
                  return (
                    <div key={i} title={t('plan {n}', { n: i + 1 })} style={{ position: 'absolute', left: `${g}%`, width: `${w}%`, top: i % 2 ? 21 : 4, height: 15, borderRadius: 4, overflow: 'hidden',
                      background: sel === i ? 'var(--accent)' : 'var(--lv3)', opacity: .9, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.35)' }}>
                      {a && <img src={a.mediaType === 'video' ? vignetteOf(a) : a.uri} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: sel === i ? .55 : .8 }} />}
                      <span style={{ position: 'absolute', left: 3, top: -1, fontSize: 12, color: '#fff', textShadow: '0 0 3px #000' }}>{i + 1}</span>
                    </div>
                  )
                })}
                {/* graduation : une marque par seconde, chiffrée toutes les 5 s */}
                {Array.from({ length: Math.floor(longueur) + 1 }, (_, k) => (
                  <span key={`g${k}`} style={{ position: 'absolute', left: `${k / Math.max(longueur, 0.01) * 100}%`, bottom: 0, width: 1, height: k % 5 ? 3 : 6, background: 'rgba(255,255,255,.35)' }} />
                ))}
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${longueur > 0 ? tGlobal / longueur * 100 : 0}%`, width: 2, marginLeft: -1, background: '#fff', boxShadow: '0 0 4px rgba(0,0,0,.8)', pointerEvents: 'none' }}>
                  <span style={{ position: 'absolute', top: 0, left: -5, width: 12, height: 9, borderRadius: '0 0 3px 3px', background: '#fff' }} />
                </div>
              </div>
            </div>
          )}

          {/* ---------- frise ---------- */}
          <div style={{ padding: '6px 14px 10px', overflowX: 'auto', flex: 'none' }}>
            {/* Règle : clic ou glisser pour se placer dans le montage. Même géométrie
                que les vignettes en dessous, la tête de lecture tombe donc juste. */}
            <div onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); allerA(versTemps(e.clientX - r.left)) }}
              onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const r = e.currentTarget.getBoundingClientRect(); allerA(versTemps(e.clientX - r.left)) }}
              style={{ position: 'relative', height: 18, width: geo.total, cursor: 'pointer', marginBottom: 4, touchAction: 'none' }}>
              {geo.x.map((x, i) => (
                <div key={i} style={{ position: 'absolute', left: x, width: geo.w[i], top: 7, height: 4, borderRadius: 2, background: 'var(--lv3)' }} />
              ))}
              {geo.x.map((x, i) => <span key={`t${i}`} style={{ position: 'absolute', left: x + 2, top: -2, fontSize: 12, color: 'var(--faint)' }}>{fmt(geo.debut[i])}</span>)}
            </div>
            <div className="flex items-stretch" style={{ gap: 0, minHeight: 92, position: 'relative' }}>
              {d.clips.length > 0 && (
                <div style={{ position: 'absolute', top: -22, bottom: -2, left: teteX, width: 2, background: 'var(--accent)', zIndex: 3, pointerEvents: 'none', borderRadius: 1,
                  boxShadow: '0 0 6px rgba(0,0,0,.6)' }}>
                  <span style={{ position: 'absolute', top: -2, left: -5, width: 12, height: 8, borderRadius: 2, background: 'var(--accent)' }} />
                </div>
              )}
              {d.clips.map((c, i) => {
                const a = assets[c.assetId]
                return (
                  <div key={i} className="flex items-stretch">
                    <div draggable onDragStart={e => { if (rogne.current) { e.preventDefault(); return } e.dataTransfer.setData('text/plain', String(i)) }}
                      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const de = Number(e.dataTransfer.getData('text/plain')); if (Number.isFinite(de) && de !== i) { deplacer(de, i); setSel(i) } }}
                      onClick={() => { if (rogne.current) return; setSel(sel === i ? null : i); allerA({ i, t: 0 }) }}
                      style={{ width: geo.w[i], height: 92, borderRadius: 10, overflow: 'hidden', position: 'relative', cursor: 'pointer', flex: 'none',
                        outline: sel === i ? '2px solid var(--accent)' : '1px solid var(--lv3)', background: '#111' }}>
                      {a ? <img src={a.mediaType === 'video' ? vignetteOf(a) : a.uri} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: .85 }} />
                        : <span style={{ fontSize: 12, color: 'var(--danger)', padding: 6, display: 'block' }}>{t('asset supprimé')}</span>}
                      <span style={{ position: 'absolute', left: 12, bottom: 4, fontSize: 12, padding: '1px 5px', borderRadius: 6, background: 'rgba(0,0,0,.65)' }}>{i + 1} · {fmt(dureePlan(c))}</span>
                      {c.texte.trim() && <span style={{ position: 'absolute', right: 12, top: 4, fontSize: 12, padding: '1px 5px', borderRadius: 6, background: 'rgba(0,0,0,.65)' }}>T</span>}
                      {c.crop && <span style={{ position: 'absolute', left: 12, top: 4, fontSize: 12, padding: '1px 5px', borderRadius: 6, background: 'rgba(0,0,0,.65)' }}>✂</span>}
                      {/* poignées de découpe : bord gauche = début, bord droit = fin (durée pour une photo) */}
                      {estVideo(c) && <Poignee cote="g" onDown={e => commencerRogne(e, i, 'g')} />}
                      <Poignee cote="d" onDown={e => commencerRogne(e, i, 'd')} />
                    </div>
                    {i < d.clips.length - 1 && (
                      <button title={t('transition — clic pour changer')} onClick={() => majPlan(i, { transition: c.transition === 'coupe' ? 'fondu' : c.transition === 'fondu' ? 'noir' : 'coupe' })}
                        style={{ width: ESPACE, border: 0, background: 'none', color: c.transition === 'coupe' ? 'var(--faint)' : 'var(--accent)', cursor: 'pointer', fontSize: 13, flex: 'none' }}>
                        {c.transition === 'coupe' ? '│' : c.transition === 'fondu' ? '⧓' : '◼'}
                      </button>
                    )}
                  </div>
                )
              })}
              {/* le point de départ du montage : bien visible, plus large quand la frise est vide */}
              <button className="cta montage-ajout" onClick={() => setChoisir(true)}
                style={{ width: d.clips.length ? 120 : 220, height: 92, marginLeft: d.clips.length ? 12 : 0, flex: 'none' }}>
                <Ic n="plus" s={20} /><span>{t('ajouter un plan')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {choisir && <ChoixPlans assets={s.assets} onClose={() => setChoisir(false)} onPick={a => ajouter(a)} />}
    </div>
  )
}

function Curseur({ label, min, max, pas, val, onChange, pct }: { label: string; min: number; max: number; pas: number; val: number; onChange: (v: number) => void; pct?: boolean }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="flex" style={{ color: 'var(--muted)' }}>{label}<span style={{ marginLeft: 'auto', color: 'var(--text)' }}>{pct ? `${Math.round(val * 100)} %` : `${val.toFixed(2)} s`}</span></span>
      <input type="range" min={min} max={max} step={pas} value={Math.min(max, Math.max(min, val))} onChange={e => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Poignée de découpe au bord d'une vignette de la frise. */
function Poignee({ cote, onDown }: { cote: 'g' | 'd'; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div onPointerDown={onDown} title={cote === 'g' ? t('glisser pour couper le début') : t('glisser pour couper la fin')}
      style={{ position: 'absolute', top: 0, bottom: 0, [cote === 'g' ? 'left' : 'right']: 0, width: 10, cursor: 'ew-resize', zIndex: 2, touchAction: 'none',
        background: 'linear-gradient(to ' + (cote === 'g' ? 'right' : 'left') + ', rgba(255,255,255,.28), rgba(255,255,255,0))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ width: 2, height: 22, borderRadius: 1, background: 'rgba(255,255,255,.85)' }} />
    </div>
  )
}

/** Place un média recadré (`crop`, fractions de l'image source) dans un cadre
 *  de FW×FH : la zone gardée couvre le cadre (`cover`) ou y tient entière
 *  (`contain`). Même calcul que l'export : recadrage, puis remplissage. */
function placer(FW: number, FH: number, sw: number, sh: number, crop: Crop | null | undefined, mode: 'cover' | 'contain'): React.CSSProperties {
  const cr = crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const RA = (cr.w * sw) / (cr.h * sh)
  const largeur = (mode === 'cover') === (FW / FH > RA)
  const rw = largeur ? FW : FH * RA, rh = largeur ? FW / RA : FH
  const mw = rw / cr.w, mh = rh / cr.h
  return { position: 'absolute', width: mw, height: mh, left: (FW - rw) / 2 - cr.x * mw, top: (FH - rh) / 2 - cr.y * mh, maxWidth: 'none', objectFit: 'fill' }
}

/** Plus grand rectangle centré au rapport `R` (largeur / hauteur en pixels). */
function cropAuFormat(sw: number, sh: number, R: number): Crop {
  let w = Math.min(1, (R * sh) / sw), h = (w * sw) / (sh * R)
  if (h > 1) { h = 1; w = (h * sh * R) / sw }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/** Aperçu : rejoue les plans à la suite (coupes franches, recadrages et
 *  textes ; les fondus et la musique ne s'entendent qu'à l'export). Piloté
 *  par le montage : `cible` dit où se placer, `onPos` rend la position. */
function Apercu({ d, assets, dureePlan, cible, lecture, onLecture, onPos, onDuree, recadre, libre, onCrop }: {
  d: Donnees; assets: Record<string, Asset>; dureePlan: (c: Plan) => number
  cible: { i: number; t: number; n: number }; lecture: boolean; onLecture: (on: boolean) => void
  onPos: (i: number, t: number) => void; onDuree: (id: string, s: number) => void
  recadre: boolean; libre: boolean; onCrop: (c: Crop) => void
}) {
  const [ci, setCi] = useState(0)
  const local0 = useRef(0)                       // position à appliquer au chargement / à la reprise
  const photo = useRef({ at: 0, t: 0 })
  const vid = useRef<HTMLVideoElement>(null)
  const cadreRef = useRef<HTMLDivElement>(null)
  const [taille, setTaille] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = cadreRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTaille({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const i = Math.min(ci, Math.max(0, d.clips.length - 1))
  const c = d.clips[i]
  const a = c ? assets[c.assetId] : undefined
  const video = a?.mediaType === 'video'
  const sw = a?.width || 1080, sh = a?.height || 1920

  /* Fondus (comme à l'export) : le plan i+1 commence `fondu` secondes avant
     la fin du plan i. Pendant ses premières secondes, le plan précédent joue
     encore dessous — fondu enchaîné : le nouveau apparaît par-dessus ; noir :
     l'ancien descend au noir, le nouveau en remonte. */
  const fonduApres = (k: number) => {
    const x = d.clips[k], y = d.clips[k + 1]
    return x && y && x.transition !== 'coupe' ? Math.min(x.transitionDuree, dureePlan(x) / 2, dureePlan(y) / 2) : 0
  }
  const [locT, setLocT] = useState(0)
  const vidPrec = useRef<HTMLVideoElement>(null)
  const fp = !recadre && i > 0 ? fonduApres(i - 1) : 0
  const prec = fp > 0 && locT < fp ? d.clips[i - 1] : null
  const aPrec = prec ? assets[prec.assetId] : undefined
  const xF = prec ? locT / fp : 1
  const tempsPrec = (t: number) => prec ? prec.debut + dureePlan(prec) - fp + t : 0

  // ordre de se placer, venu de la frise
  useEffect(() => {
    if (!d.clips.length) return
    const k = Math.min(cible.i, d.clips.length - 1)
    local0.current = cible.t
    photo.current = { at: performance.now(), t: cible.t }
    setCi(k)
    setLocT(cible.t)
    const v = vid.current
    if (v && v.dataset.plan === String(k)) v.currentTime = d.clips[k].debut + cible.t
    const vp = vidPrec.current, pk = d.clips[k - 1]
    if (vp && pk && vp.dataset.plan === String(k - 1)) vp.currentTime = pk.debut + dureePlan(pk) - fonduApres(k - 1) + cible.t
  }, [cible.n]) // eslint-disable-line react-hooks/exhaustive-deps

  // lecture : une boucle d'animation suit le temps et passe au plan suivant
  useEffect(() => {
    if (!c || !lecture || recadre) { vid.current?.pause(); vidPrec.current?.pause(); return }
    if (video) void vid.current?.play().catch(() => {})
    else photo.current = { at: performance.now(), t: local0.current }
    void vidPrec.current?.play().catch(() => {})
    let raf = 0
    const tick = () => {
      const dur = dureePlan(c)
      const v = vid.current
      const loc = video ? (v ? v.currentTime - c.debut : 0) : photo.current.t + (performance.now() - photo.current.at) / 1000
      // on passe au plan suivant au DÉBUT du fondu : il commence là sur la timeline
      if (i + 1 < d.clips.length && loc >= dur - fonduApres(i) - 0.03) { local0.current = 0; setLocT(0); setCi(i + 1); onPos(i + 1, 0); return }
      if (loc >= dur - 0.03) { onLecture(false); onPos(i, dur); return }
      local0.current = Math.max(0, loc)
      setLocT(Math.max(0, loc))
      onPos(i, Math.max(0, loc))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lecture, recadre, i, c?.assetId, c?.debut, c?.fin, c?.duree]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- recadrage : rectangle déplaçable, coins tirables ---------- */
  const R = RATIO[d.format]
  const geste = useRef<null | { mode: 'bouge' | 'nw' | 'ne' | 'sw' | 'se'; x0: number; y0: number; crop: Crop }>(null)
  const crop = c?.crop ?? null
  const debutGeste = (e: React.PointerEvent, mode: 'bouge' | 'nw' | 'ne' | 'sw' | 'se') => {
    e.stopPropagation(); e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    geste.current = { mode, x0: e.clientX, y0: e.clientY, crop: crop ?? { x: 0, y: 0, w: 1, h: 1 } }
  }
  const pendantGeste = (e: React.PointerEvent) => {
    const g = geste.current
    if (!g || !taille.w) return
    const dx = (e.clientX - g.x0) / taille.w, dy = (e.clientY - g.y0) / taille.h
    const k = g.crop
    const borne = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    if (g.mode === 'bouge') { onCrop({ ...k, x: borne(k.x + dx, 0, 1 - k.w), y: borne(k.y + dy, 0, 1 - k.h) }); return }
    // coin opposé fixe
    const ax = g.mode.includes('w') ? k.x + k.w : k.x, ay = g.mode.includes('n') ? k.y + k.h : k.y
    const px = borne((g.mode.includes('w') ? k.x : k.x + k.w) + dx, 0, 1), py = borne((g.mode.includes('n') ? k.y : k.y + k.h) + dy, 0, 1)
    let w = Math.max(0.05, Math.abs(px - ax)), h = Math.max(0.05, Math.abs(py - ay))
    if (!libre) {
      // largeur pilote, hauteur déduite du format ; on réduit si ça sort de l'image
      h = (w * sw) / (sh * R)
      const hMax = g.mode.includes('n') ? ay : 1 - ay, wMax = g.mode.includes('w') ? ax : 1 - ax
      if (h > hMax) { h = hMax; w = (h * sh * R) / sw }
      if (w > wMax) { w = wMax; h = (w * sw) / (sh * R) }
    }
    onCrop({ x: g.mode.includes('w') ? ax - w : ax, y: g.mode.includes('n') ? ay - h : ay, w, h })
  }

  const ratioCadre = recadre ? sw / sh : R
  const cadre: React.CSSProperties = { aspectRatio: String(ratioCadre), height: ratioCadre < 1 ? 'min(100%, 70vh)' : undefined, width: ratioCadre >= 1 ? 'min(100%, 70vh)' : undefined,
    maxWidth: '100%', maxHeight: '100%', position: 'relative', overflow: 'hidden', borderRadius: 8, background: '#000' }
  const fond = a && taille.w ? placer(taille.w, taille.h, sw, sh, recadre ? null : crop, 'cover') : undefined
  const avant = a && taille.w ? placer(taille.w, taille.h, sw, sh, recadre ? null : crop, recadre || d.cadrage === 'flou' ? 'contain' : 'cover') : undefined
  const k = crop ?? { x: 0, y: 0, w: 1, h: 1 }
  return (
    <div className="flex flex-col items-center gap-2" style={{ height: '100%', width: '100%', justifyContent: 'center' }}>
      <div ref={cadreRef} style={cadre}>
        {prec && aPrec && taille.w > 0 && (() => {
          const pw = aPrec.width || 1080, ph = aPrec.height || 1920, pv = aPrec.mediaType === 'video'
          const pf = placer(taille.w, taille.h, pw, ph, prec.crop, 'cover'), pa = placer(taille.w, taille.h, pw, ph, prec.crop, d.cadrage === 'flou' ? 'contain' : 'cover')
          return (<div style={{ position: 'absolute', inset: 0 }}>
            {d.cadrage === 'flou' && <img src={pv ? vignetteOf(aPrec) : aPrec.uri} alt="" style={{ ...pf, filter: 'blur(18px) brightness(.85)' }} />}
            {pv ? <video key={`p${i - 1}:${aPrec.id}`} data-plan={i - 1} ref={vidPrec} src={aPrec.uri} style={pa} playsInline muted={!d.sonClips}
                onLoadedMetadata={e => { e.currentTarget.currentTime = tempsPrec(local0.current); if (lecture) void e.currentTarget.play().catch(() => {}) }} />
              : <img src={aPrec.uri} alt="" style={pa} />}
          </div>)
        })()}
        <div style={{ position: 'absolute', inset: 0, opacity: !prec ? 1 : prec.transition === 'noir' ? (xF < 0.5 ? 0 : 1) : xF }}>
          {a && !recadre && d.cadrage === 'flou' && fond && <img src={video ? vignetteOf(a) : a.uri} alt="" style={{ ...fond, filter: 'blur(18px) brightness(.85)' }} />}
          {a && video && <video key={`${i}:${a.id}`} data-plan={i} ref={vid} src={a.uri} style={avant} playsInline muted={!d.sonClips}
            onLoadedMetadata={e => { onDuree(a.id, e.currentTarget.duration); e.currentTarget.currentTime = c.debut + local0.current; if (lecture && !recadre) void e.currentTarget.play().catch(() => {}) }} />}
          {a && !video && <img src={a.uri} alt="" style={avant} />}
        </div>
        {prec?.transition === 'noir' && <div style={{ position: 'absolute', inset: 0, background: '#000', opacity: 1 - Math.abs(2 * xF - 1), pointerEvents: 'none' }} />}
        {!recadre && c?.texte.trim() && (
          <div style={{ position: 'absolute', left: '6%', right: '6%', textAlign: 'center', color: '#fff', fontWeight: 700, fontSize: 'clamp(11px, 2.2vh, 22px)', lineHeight: 1.25,
            textShadow: '0 0 4px rgba(0,0,0,.8), 0 1px 2px rgba(0,0,0,.9)', whiteSpace: 'pre-wrap',
            ...(c.textePos === 'haut' ? { top: '11%' } : c.textePos === 'centre' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: '20%' }) }}>{c.texte}</div>
        )}
        {recadre && c && (
          <div style={{ position: 'absolute', inset: 0, touchAction: 'none' }} onPointerMove={pendantGeste} onPointerUp={() => { geste.current = null }}>
            <div onPointerDown={e => debutGeste(e, 'bouge')} onPointerMove={pendantGeste} onPointerUp={() => { geste.current = null }}
              style={{ position: 'absolute', left: `${k.x * 100}%`, top: `${k.y * 100}%`, width: `${k.w * 100}%`, height: `${k.h * 100}%`, cursor: 'move',
                border: '2px solid #fff', boxShadow: '0 0 0 9999px rgba(0,0,0,.55)', boxSizing: 'border-box' }}>
              {(['nw', 'ne', 'sw', 'se'] as const).map(m => (
                <span key={m} onPointerDown={e => debutGeste(e, m)} onPointerMove={pendantGeste} onPointerUp={() => { geste.current = null }}
                  style={{ position: 'absolute', width: 16, height: 16, background: '#fff', borderRadius: 3, cursor: m === 'nw' || m === 'se' ? 'nwse-resize' : 'nesw-resize',
                    [m.includes('n') ? 'top' : 'bottom']: -8, [m.includes('w') ? 'left' : 'right']: -8 }} />
              ))}
            </div>
          </div>
        )}
        {!c && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--faint)', fontSize: 12 }}>{t('ajoute un premier plan ↓')}</div>}
      </div>
      <div className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {!recadre && <button className="pill" disabled={!d.clips.length} onClick={() => onLecture(!lecture)}>{lecture ? '❚❚' : '▶'}</button>}
        {c && <span>{recadre ? t('recadrage du plan {n} : glisse le cadre, tire un coin', { n: i + 1 }) : t('plan {n} / {t}', { n: i + 1, t: d.clips.length })}</span>}
        {!recadre && <span style={{ color: 'var(--faint)' }}>{t('la musique s’entend à l’export')}</span>}
      </div>
    </div>
  )
}

/** Choix des plans : les clips et photos de la bibliothèque, les validés d'abord. */
function ChoixPlans({ assets, onClose, onPick }: { assets: Asset[]; onClose: () => void; onPick: (a: Asset) => void }) {
  const [type, setType] = useState<'video' | 'photo'>('video')
  const [pris, setPris] = useState(0)
  const liste = useMemo(() => assets.filter(a => a.mediaType === type && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt), [assets, type])
  return (
    <div className="pop" onClick={onClose}>
      <div className="pbox" style={{ width: 'min(820px,94%)' }} onClick={e => e.stopPropagation()}>
        <h3>{t('Ajouter des plans')} {pris > 0 && <span style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 8 }}>{t('{n} ajouté(s)', { n: pris })}</span>}<button className="x" onClick={onClose}>✕</button></h3>
        <div className="wtabs">
          <button className={`wtab ${type === 'video' ? 'on' : ''}`} onClick={() => setType('video')}>{t('Clips')}</button>
          <button className={`wtab ${type === 'photo' ? 'on' : ''}`} onClick={() => setType('photo')}>{t('Photos')}</button>
        </div>
        <div className="pkgrid">
          {liste.map(a => (
            <button key={a.id} className="pk" aria-label={nomMedia(a)} onClick={() => { onPick(a); setPris(n => n + 1) }} title={a.reviewStatus === 'approved' ? t('validé') : ''}>
              <img src={a.mediaType === 'video' ? vignetteOf(a) : a.uri} alt="" loading="lazy" />
              {a.reviewStatus === 'approved' && <span style={{ position: 'absolute', right: 4, top: 4, fontSize: 12 }}>✓</span>}
            </button>
          ))}
          {!liste.length && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 12, padding: 12 }}>{t('rien dans la bibliothèque')}</div>}
        </div>
      </div>
    </div>
  )
}
