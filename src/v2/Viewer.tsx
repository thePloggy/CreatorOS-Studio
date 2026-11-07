/* ============================================================
   v2 — visionneuse : média + panneau Info (prompt, provenance),
   revue, ponts (Animer / frames / recréer / cloner). Navigation
   ← → sur la liste FILTRÉE (useAssetNav, fix inclus).
   ============================================================ */
import { telechargerWorkflow } from '../lib/workflowComfy'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { LUMIERES, FORMATS } from '../data/lumieres'
import LOOKS from '../data/looks.json'
import { useAssetNav } from '../components/useAssetNav'
import { AssetNavArrows } from '../components/AssetNavArrows'
import { posterOf } from '../components/AssetMedia'
import { renderTime } from '../lib/renderTime'
import { resumeControle } from '../lib/controle'
import { trierDossiers } from '../lib/folders'
import { FolderMenu, Ic, lancerFinition, useConfirm, useExclusiveMenu, useVideoArretee } from './bits'
import { createPortal } from 'react-dom'
import { PointEtDemande } from './PointEtDemande'
import { CarouselPopup } from './popups'
import { AvantApres } from '../components/AvantApres'
import { Pinceau } from '../components/Pinceau'
import { t, getLang, tServeur } from '../i18n'
import { Masters } from './Masters'
import type { ActionOutil } from './Navigation'

const Objet3D = lazy(() => import('./Objet3D'))
import { EditionVideo } from '../components/EditionVideo'
import { useEdition } from '../lib/proprietaire'

/* `/api/folders` renvoie aussi createdAt et count : la fiche ne les affiche
   pas mais le tri partagé en a besoin. */
interface FolderRow { id: string; name: string; createdAt: number; count: number }

/* Copie au clic, pour tous les champs de la vue détail : l'icône apparaît au
   survol, « copié » confirme. Un seul composant, un seul comportement. */
function useCopie(): [boolean, (t: string) => void] {
  const [fait, setFait] = useState(false)
  const t = useRef<number | undefined>(undefined)
  return [fait, (texte: string) => {
    void navigator.clipboard.writeText(texte)
    setFait(true); window.clearTimeout(t.current)
    t.current = window.setTimeout(() => setFait(false), 1400)
  }]
}

function Copiable({ texte, children }: { texte: string; children: React.ReactNode }) {
  const [fait, copier] = useCopie()
  if (!texte || texte === '—') return <>{children}</>
  return (
    <button className="copiable" title={t('copier')} onClick={() => copier(texte)}>
      <span className="copiable-ic">{fait ? '✓' : <Ic n="clipboard" s={11} />}</span>
      {children}
    </button>
  )
}

/* Carte de prompt : même gabarit pour le brief, la vision VLM et le prompt
   composé — trois textes de même nature, qui se lisent en séquence. Un seul
   composant évite que les trois blocs divergent de style à la prochaine
   retouche. */
function PromptCard({ titre, texte, hauteur }: { titre: string; texte: string; hauteur: number }) {
  const [fait, copier] = useCopie()
  const [tout, setTout] = useState(false)
  const long = texte.length > 260
  return (
    <div className="vfiche">
      <div className="vfiche-tete">
        <Ic n="texte" s={14} /><span>{titre}</span>
        <button className={`vfiche-copier copier-btn ${fait ? 'fait' : ''}`} onClick={() => copier(texte)}>
          <Ic n="copy" s={12} /><span className="lbl-a">{t('copier')}</span><span className="lbl-b">{t('copié !')}</span>
        </button>
      </div>
      <div className={`vfiche-corps vfiche-texte ${long && !tout ? 'coupe' : ''}`}
        style={{ maxHeight: tout ? hauteur * 3 : hauteur }}>
        {texte}
      </div>
      {long && <button className="vfiche-voir" onClick={() => setTout(v => !v)}>
        {tout ? t('Réduire') : t('Voir tout')} <span style={{ display: 'inline-flex', transform: tout ? 'rotate(180deg)' : undefined }}><Ic n="chevron" s={12} /></span>
      </button>}
    </div>
  )
}

/* La pile de LoRA du rendu, dans l'ordre où elle s'est appliquée. Toujours
   affichée : il y a au minimum la LoRA d'identité, et son absence sur un rendu
   du personnage est en soi une information. Le poids est ce qui se lit en
   premier — c'est le réglage qui explique le plus de rendus ratés (une LoRA de
   style trop forte prend la main sur l'identité et impose son esthétique). */
export interface LoraLigne { node: string; name: string; label: string; strength: number | null; source: 'job' | 'recette' }

function PileLoras({ loras, charge }: { loras: LoraLigne[] | null; charge: boolean }) {
  return (
    <div className="vfiche text-[12px]">
      <div className="vfiche-tete"><Ic n="graphe" s={14} /><span>{t('LoRA appliquées')}</span></div>
      {charge && !loras && <div className="mt-2" style={{ color: 'var(--faint)' }}>…</div>}
      {loras && loras.length === 0 && <div className="mt-2" style={{ color: 'var(--faint)' }}>{t('aucune')}</div>}
      {loras?.map(l => (
        <div key={l.node} className="flex justify-between items-baseline gap-2 py-[3px]" style={{ color: 'var(--muted)' }}>
          <span className="truncate" title={l.name}>
            <Copiable texte={l.name}>{l.label}</Copiable>
            {l.source === 'job' && <span className="ml-1" style={{ color: 'var(--attention)' }} title={t('ajoutée par le job, pas par la recette')}>•</span>}
          </span>
          <b style={{ color: 'var(--text)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            <Copiable texte={l.strength == null ? '' : String(l.strength)}>{l.strength == null ? '—' : l.strength.toFixed(2).replace('.', ',')}</Copiable>
          </b>
        </div>
      ))}
    </div>
  )
}

/* Caption gravée du reel : le texte que la livraison écrira sur le bandeau.
   Modifiable ; enregistrée en quittant le champ (ou Entrée). Les autres
   propositions du rédacteur restent cliquables. 45 caractères tiennent sur
   une ligne du bandeau — au-delà il passe sur deux, sans être refusé. */
function CaptionCard({ asset }: { asset: Asset }) {
  const s = useAppStore()
  const [texte, setTexte] = useState(asset.caption ?? '')
  useEffect(() => { setTexte(asset.caption ?? '') }, [asset.id, asset.caption])
  const enregistrer = (t: string) => { if (t.trim() !== (asset.caption ?? '')) s.setCaption(asset.id, t) }
  const n = texte.trim().length
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--lv2)' }}>
      <h4 className="text-[12px] uppercase tracking-wider flex items-center" style={{ color: 'var(--faint)' }}>
        {t('Caption (texte gravé)')}
        <span className="ml-auto normal-case tracking-normal" style={{ color: n > 45 ? 'var(--attention)' : 'var(--faint)' }}>{n}/45</span>
      </h4>
      <textarea className="mt-2 w-full text-[12px] rounded-lg p-2" rows={2} value={texte}
        placeholder={t('vide — « Captions » sur la sélection, ou écris-la ici')}
        style={{ background: 'var(--lv3)', color: 'var(--text)', border: 0, resize: 'vertical' }}
        onChange={e => setTexte(e.target.value)}
        onBlur={() => enregistrer(texte)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
      {(asset.captionOptions?.length ?? 0) > 1 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {asset.captionOptions!.filter(o => o.caption !== texte.trim()).map(o => (
            <button key={o.caption} className="text-left text-[12px] rounded-md px-2 py-1"
              style={{ background: 'none', border: '1px solid var(--lv3)', color: 'var(--muted)', cursor: 'pointer' }}
              onClick={() => { setTexte(o.caption); s.setCaption(asset.id, o.caption) }}>
              {o.caption} <span className="texte-faible">· {o.family}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Angles : la même photo vue d'une autre position de caméra — Qwen-Image-Edit 2511 avec la LoRA
 *  Multiple-Angles de fal (Apache-2.0, 96 poses apprises sur des rendus Gaussian Splatting). */
export const LORA_ANGLES = 'qwen/qwen-image-edit-2511-multiple-angles-lora.safetensors'
export const ANGLES = [
  { id: 'g34', label: '¾ gauche', vue: 'front-left quarter view eye-level shot medium shot' },
  { id: 'd34', label: '¾ droite', vue: 'front-right quarter view eye-level shot medium shot' },
  { id: 'profil', label: 'Profil', vue: 'right side view eye-level shot medium shot' },
  { id: 'dos', label: 'De dos', vue: 'back view eye-level shot medium shot' },
  { id: 'plongee', label: 'Plongée', vue: 'front view high-angle shot medium shot' },
  { id: 'contre', label: 'Contre-plongée', vue: 'front view low-angle shot medium shot' },
  { id: 'large', label: 'Plan large', vue: 'front view eye-level shot wide shot' },
  { id: 'serre', label: 'Gros plan', vue: 'front view eye-level shot close-up' },
]



/* Looks en un clic : consignes de retouche prêtes (Qwen-Image-Edit 2511), dans src/data/looks.json. */
/* Analyse pour les réseaux : notes du modèle de vision et mesures, présentées comme une estimation. */
function AnalyseClip({ asset, ouvert }: { asset: Asset; ouvert: boolean }) {
  const [r, setR] = useState<{ notes: Record<string, number>; global: number; mesures: { duree: number; format: string; son: boolean; coupes: number }; conseils: string[] } | null>(null)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { setR(null); setMsg(null) }, [asset.id])
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    const x = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ langue: getLang() }) })
    const d = await x.json().catch(() => ({}))
    setOccupe(false)
    if (!x.ok) setMsg(tServeur(d.error) ?? `HTTP ${x.status}`); else setR(d)
  }
  return (
    <div className={ouvert || r ? 'guide-outil' : 'flex gap-1.5 items-center flex-wrap text-[12px]'} style={ouvert || r ? undefined : { color: 'var(--muted)' }}>
      {ouvert || r ? <b>{t('Analyse pour les réseaux')}</b> : t('Analyse')}
      {(ouvert || r) && <p>{t('Une estimation de qualité par le modèle de vision local et quelques mesures, pas une prédiction de vues.')}</p>}
      {!r && <button className="pill" disabled={occupe} onClick={() => void lancer()}>{occupe ? t('analyse…') : t('Analyser ce clip')}</button>}
      {r && <>
        <div className="flex gap-3 flex-wrap" style={{ fontSize: 13 }}>
          <b style={{ fontSize: 18 }}>{r.global}/10</b>
          {Object.entries(r.notes).map(([k, v]) => <span key={k}>{t(k)} <b>{v}</b></span>)}
        </div>
        <span className="texte-doux">{r.mesures.duree} s, {r.mesures.format}, {r.mesures.son ? t('avec son') : t('muet')}, {t('{n} coupes', { n: r.mesures.coupes })}</span>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{r.conseils.map((c, i) => <li key={i}>{t(c)}</li>)}</ul>
      </>}
      {msg && <span className="texte-erreur">{msg}</span>}
    </div>
  )
}

/* Recadrer et doubler un clip : deux petits panneaux, mis en avant quand l'outil a été choisi au menu. */
function OutilsClip({ asset, ouvert, onLance }: { asset: Asset; ouvert?: ActionOutil; onLance: (jobId: string) => Promise<void> }) {
  const [voix, setVoix] = useState<{ nom: string }[]>([])
  const [audio, setAudio] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string }[] }) => {
    const l = (d.musiques ?? []).sort((a, b) => Number(b.nom.startsWith('voix_')) - Number(a.nom.startsWith('voix_'))); setVoix(l); setAudio(l[0]?.nom ?? '') }).catch(() => {}) }, [])
  // changeur de voix (propriétaire) : le timbre change, les mots et le rythme du clip restent
  const edition = useEdition()
  const [voixStudio, setVoixStudio] = useState<{ id: string; nom: string }[]>([])
  const [cible, setCible] = useState('af_heart')
  const [occupe, setOccupe] = useState(false)
  useEffect(() => { if (edition) void fetch('/api/voix').then(r => r.json()).then((d: { voix: { id: string; nom: string }[]; clone?: boolean }) => setVoixStudio(d.clone ? d.voix : [])).catch(() => {}) }, [edition])
  const changer = async () => {
    setOccupe(true); setMsg(null)
    const r = await fetch('/api/voix/changer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id, voix: cible }) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    setOccupe(false)
    if (!r.ok || !d.jobId) setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); else await onLance(d.jobId)
  }
  const poster = async (route: string, body: object) => {
    setMsg(null)
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); else await onLance(d.jobId)
  }
  return (<>
    <div className={ouvert === 'recadrer' ? 'guide-outil' : 'flex gap-1.5 items-center flex-wrap text-[12px]'} style={ouvert === 'recadrer' ? undefined : { color: 'var(--muted)' }}>
      {ouvert === 'recadrer' ? <b>{t('Recadrer')}</b> : t('Recadrer')}
      {ouvert === 'recadrer' && <p>{t('Wan VACE regarde le clip au centre du nouveau cadre et génère les bords image par image ; le clip d’origine reste intact. Environ 10 min.')}</p>}
      <div className="flex gap-1.5 flex-wrap">{['9:16', '16:9', '1:1', '4:5'].map(f => <button key={f} className="pill" onClick={() => void poster('recadrer', { format: f })}>{f}</button>)}</div>
    </div>
    <div className={ouvert === 'doubler' ? 'guide-outil' : 'flex gap-1.5 items-center flex-wrap text-[12px]'} style={ouvert === 'doubler' ? undefined : { color: 'var(--muted)' }}>
      {ouvert === 'doubler' ? <b>{t('Doublage')}</b> : t('Doubler')}
      {ouvert === 'doubler' && <p>{t('Choisis une voix de la bibliothèque audio (crée-la dans Bibliothèque > Audio). Les 3 premières secondes du clip sont doublées.')}</p>}
      <select value={audio} onChange={e => setAudio(e.target.value)} aria-label={t('voix à poser')} style={{ maxWidth: 200, background: 'var(--lv2)', color: 'var(--text)', border: '1px solid var(--lv3)', borderRadius: 8, padding: '4px 6px', font: 'inherit' }}>
        {voix.map(v => <option key={v.nom} value={v.nom}>{v.nom.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')}</option>)}
      </select>
      <button className="pill" disabled={!audio} onClick={() => void poster('doubler', { audio })}>{t('Doubler')}</button>
    </div>
    {edition && voixStudio.length > 0 && <div className="flex gap-1.5 items-center flex-wrap text-[12px] texte-doux">
      {t('Changer la voix')}
      <select className="champ" value={cible} onChange={e => setCible(e.target.value)} aria-label={t('voix cible')} style={{ maxWidth: 200, fontSize: 12 }}>
        {voixStudio.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}
      </select>
      <button className="pill" disabled={occupe} onClick={() => void changer()}>{occupe ? t('synthèse…') : t('Changer')}</button>
    </div>}
    {msg && <div className="text-[12px] texte-erreur">{msg}</div>}
  </>)
}

export function Viewer({ asset, list, onGo, onClose, goVideo, goImage, action }: {
  asset: Asset
  /** l'outil choisi depuis l'accueil ou les menus : son panneau s'ouvre tout seul */
  action?: ActionOutil
  list: Asset[]
  onGo: (a: Asset | null) => void
  onClose: () => void
  goVideo: () => void
  goImage: () => void
}) {
  const videoArretee = useVideoArretee()
  const proprio = useEdition()
  const s = useAppStore()
  const nav = useAssetNav(list, asset, a => (a ? onGo(a) : onClose()))
  const [prov, setProv] = useState<string | null>(null)
  /* Agrandissement : l'image d'origine, si elle est encore en bibliothèque. */
  /* Restauration : on compare toujours à la source d'origine, pas à l'étape intermédiaire. */
  const parent = asset.origineUri ? { id: `${asset.id}-origine`, uri: asset.origineUri, mediaType: asset.mediaType }
    : asset.parentAssetId ? s.assets.find(a => a.id === asset.parentAssetId && a.mediaType === asset.mediaType) ?? null : null
  const [compare, setCompare] = useState(false)
  // un clip affiné ou une restauration s'ouvre sur son avant / après : c'est ce qu'on vient voir
  // un effet vidéo (Refine Details, Day to Night, Unblur…, Remove Objects) aussi : on vient voir la différence
  useEffect(() => { setCompare(['seedvr2', 'ltx_effet', 'ltx_cleanplate'].includes(String(asset.videoEngine)) || !!asset.origineUri) }, [asset.id, asset.videoEngine, asset.origineUri])
  const [pinceau, setPinceau] = useState(action === 'pinceau' && asset.mediaType === 'photo')
  const [pointer, setPointer] = useState(false)
  useEffect(() => { setPointer(false) }, [asset.id])
  const [editer, setEditer] = useState(action === 'retouche' || action === 'detour' || action === 'retirer' || action === 'fond')
  const [details, setDetails] = useState(true)
  const [plusOuvert, setPlusOuvert] = useState(action === 'looks')
  const [finMsg, setFinMsg] = useState<{ ok: boolean; txt: string } | null>(null)
  useEffect(() => { setFinMsg(null) }, [asset.id])
  const finition = async (op: 'foley' | 'interpolate') => {
    let prompt: string | undefined
    if (op === 'foley') {
      const p = window.prompt(t('Quels sons ? (vide = ambiance naturelle de la scène, sans voix ni musique)'), '')
      if (p === null) return
      prompt = p.trim() || undefined
    }
    const e = await lancerFinition(asset, op, prompt)
    setFinMsg(e ? { ok: false, txt: e } : { ok: true, txt: op === 'foley' ? t('son en cours : un nouveau clip arrive dans la bibliothèque') : t('fluidité en cours : un nouveau clip arrive dans la bibliothèque') })
  }

  /* Voisins préchargés : ← → affiche tout de suite (image, ou vignette d'une vidéo). */
  useEffect(() => {
    if (nav.index < 0) return
    for (const v of [list[nav.index + 1], list[nav.index - 1], list[nav.index + 2]]) {
      if (!v) continue
      const im = new Image()
      im.src = v.mediaType === 'video' ? `/api/poster/${encodeURIComponent(v.uri.split('/').pop() ?? '')}` : v.uri
    }
  }, [nav.index, list])
  /* Lue par asset : le graphe exécuté est trop lourd pour voyager avec la
     galerie, mais une pile de LoRA est minuscule et se recharge à chaque
     navigation ← →. */
  const [loras, setLoras] = useState<LoraLigne[] | null>(null)
  useEffect(() => {
    setLoras(null)
    let vivant = true
    void fetch(`/api/assets/${encodeURIComponent(asset.id)}/loras`).then(r => r.json())
      .then(d => { if (vivant) setLoras(d.loras ?? []) }).catch(() => { if (vivant) setLoras([]) })
    return () => { vivant = false }
  }, [asset.id])
  /* metadata réelles du fichier vidéo (source de vérité : dims + durée). */
  const [clip, setClip] = useState<{ w: number; h: number; dur: number } | null>(null)
  const [allFolders, setAllFolders] = useState<FolderRow[]>([])
  useEffect(() => { void fetch('/api/folders').then(r => r.json())
    .then(d => setAllFolders(d.folders ?? [])).catch(() => {}) }, [])
  /* On parcourt la liste TRIÉE plutôt que `asset.folders` : la fiche détail
     nomme les dossiers dans l'ordre choisi par l'opérateur, comme partout. */
  const folderNames = trierDossiers(allFolders, s.folderSort)
    .filter(f => (asset.folders ?? []).includes(f.id))
    .map(f => f.name)
  const [menu, setMenu] = useState<{ x: number; bottom: number } | null>(null)
  const [carousel, setCarousel] = useState(false)
  const p = asset.provenance

  /* « Ouvrir dans ComfyUI » : le graphe exact du rendu en .json, et ses modèles avec leur licence */
  const [modeles, setModeles] = useState<{ fichier: string; licence: string | null }[] | null>(null)
  const [voirLooks, setVoirLooks] = useState(false)
  const lancerLook = async (consigne: string) => {
    await s.retouchFrom(asset)
    s.setUserPrompt(consigne)
    useAppStore.setState({ promptTouched: true, composedPositive: '' })
    await s.submitJob()
    onClose(); goImage()
  }
  const lancerAngle = async (vue: string) => {
    const avant = useAppStore.getState().loraPicks
    useAppStore.setState({ loraPicks: [{ name: LORA_ANGLES, strength: 1, trigger: '' }] })
    try { await lancerLook(`<sks> ${vue}`) } finally { useAppStore.setState({ loraPicks: avant }) }
  }
  /* Coverage, Push in, Next beat : le plan d'après, à partir de cette photo. */
  const [planMsg, setPlanMsg] = useState('')
  const coverage = async () => {
    const avant = useAppStore.getState().loraPicks
    useAppStore.setState({ loraPicks: [{ name: LORA_ANGLES, strength: 1, trigger: '' }] })
    try {
      for (const id of ['large', 'd34', 'serre']) {
        await s.retouchFrom(asset)
        s.setUserPrompt(`<sks> ${ANGLES.find(a => a.id === id)!.vue}`)
        useAppStore.setState({ promptTouched: true, composedPositive: '' })
        await s.submitJob()
      }
    } finally { useAppStore.setState({ loraPicks: avant }) }
    onClose(); goImage()
  }
  const nextBeat = async () => {
    setPlanMsg('')
    try {
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/moment-suivant`, { method: 'POST' })
      const d = await r.json().catch(() => ({})) as { texte?: string; error?: string }
      if (!r.ok || !d.texte) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      await lancerLook(`The same person, same outfit, same place and same light, a few seconds later: ${d.texte} Keep the same face and photo style.`)
    } catch (e) { setPlanMsg(String((e as Error).message || e)) }
  }
  const [netteMsg, setNetteMsg] = useState('')
  const nettete = async () => {
    setNetteMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/seedvr`, { method: 'POST' })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) setNetteMsg(tServeur(d.error) ?? `HTTP ${r.status}`)
    else { await s.adoptServerJob(d.jobId); onClose() }
  }
  const [voir3d, setVoir3d] = useState(false)
  const [cible3d, setCible3d] = useState('')
  const [guide3d, setGuide3d] = useState(action === 'objet3d')
  const placerDansStage = () => {
    s.ouvrirStage({ objets: [{ type: 'modele', modele: `${asset.jobId}.glb`, x: 0, z: 0, h: 1.5, rot: 180 }], camera: [{ oeil: [0.5, 1.5, 3.4] }, { oeil: [-0.3, 1.5, 1.8] }], prompt: '' })
    onClose()
  }
  const objet3d = async () => {
    setAgrandirMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/objet3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cible: cible3d }) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) setAgrandirMsg(tServeur(d.error) ?? `HTTP ${r.status}`)
    else { await s.adoptServerJob(d.jobId); onClose() }
  }
  const [agrandirMsg, setAgrandirMsg] = useState('')
  const rouvrirStage = async () => {
    const r = await fetch(`/api/stage/${encodeURIComponent(asset.jobId ?? '')}/scene`)
    if (!r.ok) return
    s.ouvrirStage(await r.json()); onClose(); goVideo()
  }
  const transparent = async () => {
    setAgrandirMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/transparent`, { method: 'POST' })
    if (!r.ok) setAgrandirMsg(tServeur((await r.json().catch(() => ({}))).error) ?? `HTTP ${r.status}`)
  }
  const [profMsg, setProfMsg] = useState('')
  const profondeur = async () => {
    setProfMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/profondeur`, { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setProfMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    await s.adoptServerJob(d.jobId); onClose(); goImage()
  }
  const agrandir = async (format: string) => {
    setAgrandirMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/agrandir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setAgrandirMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    onClose(); goImage()
  }
  const telechargerGraphe = async () => setModeles(await telechargerWorkflow(asset.id) ?? [])
  const loadProv = async () => {
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`)
    setProv(JSON.stringify(await r.json(), null, 1))
  }

  return (
    <div className="fixed inset-0 z-50 flex max-[820px]:flex-col" style={{ background: 'var(--bg)' }}>
      {pinceau && <Pinceau asset={asset} onClose={() => setPinceau(false)} />}
      {editer && <EditionVideo asset={asset} detourDirect={action === 'detour'} opDepart={action === 'retirer' || action === 'fond' ? action : undefined} onClose={() => setEditer(false)} onPinceau={() => setPinceau(true)} />}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden" style={{ background: 'var(--scene)' }}>
        {/* le média en grand flou derrière lui : la pièce prend sa lumière */}
        <img className="ambiance" alt="" src={asset.mediaType === 'video' ? posterOf(asset) : asset.uri} />
        <button className="absolute top-3 left-3 z-10 b2" onClick={onClose}>{t('‹ retour')}</button>
        {asset.mediaType === 'photo' && !(parent && compare) && (
          <button className={`absolute bottom-3 left-3 z-10 b2 ${pointer ? 'point-bouton-on' : ''}`} onClick={() => setPointer(v => !v)}
            title={t('clique sur un point de l’image et dis ce qui doit y changer')}>
            <Ic n={pointer ? 'x' : 'edit'} s={14} />{pointer ? t('Annuler le pointage') : t('Pointer pour retoucher')}</button>
        )}
        {nav.index >= 0 && (
          <span className="absolute top-4 left-1/2 -translate-x-1/2 pill9">{nav.index + 1} / {nav.total} · ← →</span>
        )}
        {parent && (
          <button className="absolute top-3 right-3 z-10 b2" onClick={() => setCompare(c => !c)} title={t('comparer avec l\'image d\'origine')}>
            {compare ? t('× fermer la comparaison') : t('⇆ avant / après')}
          </button>
        )}
        {parent && compare
          ? <AvantApres avant={parent} apres={asset} className="max-h-[92vh] max-w-full rounded-[10px]" style={{ maxWidth: '86%', boxShadow: 'var(--sh-md)' }} />
          : asset.mediaType === 'video'
          ? <video ref={videoArretee} data-lecture-active src={asset.uri} controls autoPlay loop playsInline className="relative max-h-[92vh] max-w-[86%] rounded-[12px]" style={{ boxShadow: 'var(--sh-media)' }}
              onLoadedMetadata={e => { const el = e.target as HTMLVideoElement; setClip({ w: el.videoWidth, h: el.videoHeight, dur: el.duration }) }} />
          : <PointEtDemande asset={asset} actif={pointer} onFin={() => setPointer(false)} className="relative max-h-[92vh] rounded-[12px] object-contain" style={{ boxShadow: 'var(--sh-media)', maxWidth: '100%' }} />}
        <AssetNavArrows {...nav} />
      </div>

      <aside className="viewer-panel flex-none flex flex-col gap-2.5 p-4 overflow-y-auto" style={{ width: 330, background: 'var(--lv1)' }}>
          {guide3d && asset.mediaType === 'photo' && (
            <div className="guide-outil">
              <b>{t('Objet 3D')}</b>
              <ol>
                <li>{t('Écris en anglais l’objet à garder sur la photo, par exemple toy robot.')}</li>
                <li>{t('Lance la création : environ 1 minute.')}</li>
                <li>{t('Ouvre le résultat dans la bibliothèque : fais-le tourner, télécharge le GLB ou pose-le dans la scène 3D.')}</li>
              </ol>
              <input value={cible3d} onChange={e => setCible3d(e.target.value)} placeholder={t('quel objet ? en anglais')} maxLength={80} />
              <button className="pill" title={t('TRELLIS.2 : la photo devient un modèle GLB, utilisable dans la scène 3D')} disabled={!cible3d.trim()} onClick={() => void objet3d()}>{t('Créer le modèle 3D')}</button>
              {agrandirMsg && <span className="texte-erreur">{agrandirMsg}</span>}
            </div>
          )}
          {action === 'nette' && asset.mediaType === 'video' && (
            <div className="guide-outil">
              <b>{t('Netteté 1080p')}</b>
              <p>{t('SeedVR2 monte le clip en 1080p, le mouvement ne change pas.')}</p>
              <button className="pill" onClick={() => void nettete()}>{t('Lancer la netteté')}</button>
              {netteMsg && <span className="texte-erreur">{netteMsg}</span>}
            </div>
          )}
          {action === 'profondeur' && asset.mediaType === 'photo' && <div className="guide-outil"><b>{t('Carte de profondeur')}</b>
            <span>{t('La carte de profondeur d’une photo (Depth Anything V2), pour le relief, le compositing et les ControlNet.')}</span>
            <button className="cta" style={{ alignSelf: 'flex-start' }} onClick={() => void profondeur()}>{t('Calculer la profondeur')}</button>
            {profMsg && <span className="texte-erreur">{profMsg}</span>}</div>}
          {action === 'transparent' && asset.mediaType === 'photo' && <div className="guide-outil"><b>{t('Fond transparent')}</b>
            <span>{t('Le sujet est gardé, le fond disparaît : un PNG transparent, rien n’est redessiné.')}</span>
            <button className="cta" style={{ alignSelf: 'flex-start' }} onClick={() => void transparent().then(() => { onClose(); goImage() })}>{t('Retirer le fond')}</button>
            {agrandirMsg && <span className="texte-erreur">{agrandirMsg}</span>}</div>}
          {(action === 'coverage' || action === 'suivant') && asset.mediaType === 'photo' && <div className="guide-outil">
            <b>{action === 'coverage' ? 'Coverage' : 'Next Shot'}</b>
            <span>{t(action === 'coverage' ? 'Trois plans de la même scène en un clic : large, trois-quarts et serré.' : 'Le plan d’après : la même personne, au même endroit, quelques secondes plus tard.')}</span>
            <button className="cta" style={{ alignSelf: 'flex-start' }} onClick={() => void (action === 'coverage' ? coverage() : nextBeat())}>{t('Lancer')}</button>
            {planMsg && <span className="texte-erreur">{planMsg}</span>}</div>}
          {action === 'boucle' && asset.mediaType === 'photo' && <div className="guide-outil"><b>Seamless Loop</b>
            <span>{t('Un clip qui revient à son image de départ : il tourne en boucle sans raccord.')}</span>
            <button className="cta" style={{ alignSelf: 'flex-start' }} onClick={() => { void s.boucleFrom(asset); onClose(); goVideo() }}>{t('Préparer la boucle')}</button></div>}
          {(action === 'son' || action === 'fluide') && asset.mediaType === 'video' && <div className="guide-outil">
            <b>{action === 'son' ? 'Add Sound' : 'Smooth Motion'}</b>
            <span>{t(action === 'son' ? 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).' : 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.')}</span>
            <button className="cta" style={{ alignSelf: 'flex-start' }} onClick={() => void finition(action === 'son' ? 'foley' : 'interpolate')}>{t('Lancer')}</button>
            {finMsg && <span className={finMsg.ok ? 'texte-doux' : 'texte-erreur'}>{finMsg.txt}</span>}</div>}
          {action === 'master' && asset.mediaType === 'video' && <div className="guide-outil"><b>{t('Masters HDR')}</b><Masters asset={asset} /></div>}
          {asset.mediaType === 'video' && (action === 'analyse' || !action) && <AnalyseClip asset={asset} ouvert={action === 'analyse'} />}
          {asset.mediaType === 'video' && (action === 'recadrer' || action === 'doubler' || !action) && <OutilsClip asset={asset} ouvert={action} onLance={async id => { await s.adoptServerJob(id); onClose() }} />}
        {/* ---------- la chaîne du prompt, dans l'ordre où elle s'est faite ----------
            Brief → ce que le VLM a lu dans la still → prompt composé. Les deux
            premiers blocs n'apparaissent que s'ils existent ET apportent
            quelque chose : un rendu sans Enhancer garde une seule carte, comme
            avant. Séparer la VISION du reste est le point : quand un prompt
            composé décrit une tenue ou une pose inattendue, la cause est soit
            une image mal lue, soit une consigne mal suivie — deux correctifs
            qui n'ont rien à voir, et qu'on ne peut pas départager sans voir ce
            que le modèle avait sous les yeux. */}
        {asset.mediaType === 'video' && <CaptionCard asset={asset} />}
        {p.initialBrief && p.initialBrief !== (p.composedPositive || p.userPrompt) && (
          <PromptCard titre={t('Prompt initial (avant Enhancer)')} texte={p.initialBrief} hauteur={90} />
        )}
        {p.promptVision && (
          <PromptCard titre={t('Vision VLM de la still')} texte={p.promptVision} hauteur={110} />
        )}
        {p.promptReecrit && (
          <PromptCard titre={t('Prompt réécrit (envoyé à FLUX 3)')} texte={p.promptReecrit} hauteur={150} />
        )}
        <PromptCard titre={p.promptReecrit ? t('Ton prompt') : p.promptVision || p.initialBrief ? t('Prompt composé (envoyé au moteur)') : t('Prompt composé')}
          texte={p.composedPositive || p.userPrompt || '—'} hauteur={130} />
        <div className="vfiche text-[12px]">
          <button className="vfiche-tete vfiche-pli" onClick={() => setDetails(v => !v)} aria-expanded={details}>
            <Ic n="info" s={14} /><span>{t('Détails')}</span>
            <span className="vfiche-chevron" style={{ transform: details ? 'rotate(180deg)' : undefined }}><Ic n="chevron" s={13} /></span>
          </button>
          {details && <div className="vfiche-corps">
          {([
            ['Recette', p.recipeId || '—'],
            /* La seed sert à rejouer un rendu : elle doit être lisible ET
               copiable. `verrouillée` = choix de l'opérateur avant l'envoi,
               lu dans les sélections ; sinon elle a été tirée au hasard,
               mais reste affichée puisque c'est celle qui a produit l'image. */
            ['Seed', p.seed?.value != null
              ? `${p.seed.value} · ${(p.selections as { seed?: { mode?: string } } | undefined)?.seed?.mode === 'lock' ? t('fixe') : t('aléatoire')}`
              : t('aléatoire'), p.seed?.value != null ? String(p.seed.value) : ''],
            ['Format', asset.aspect + (asset.videoDraft ? t(' · brouillon') : '')],
            ['Dimensions', (() => {
              const w = clip?.w || asset.width, h = clip?.h || asset.height
              return w && h ? `${w} × ${h}` : '—'
            })()],
            ...(asset.mediaType === 'video' ? [
              ['Clip', (() => {
                const fps = asset.videoFps ?? (p.selections as { fps?: number } | undefined)?.fps
                return clip ? `${clip.dur >= 9.5 ? Math.round(clip.dur) : clip.dur.toFixed(1)} s${fps ? ` · ${fps} fps` : ''}` : '…'
              })()],
              ['Moteur', asset.videoEngine ?? '—'],
              ['Contrôle', resumeControle(asset.controle) ?? t('en cours ou indisponible')],
            ] as const : []),
            ['Rendu', renderTime(asset.renderMs) || '—'],
            ['Job', `#${asset.jobId}`, asset.jobId],
            /* Dossiers d'appartenance : l'asset ne porte que des IDs, les noms
               viennent de /api/folders (chargé une fois à l'ouverture). */
            ['Dossiers', folderNames.length ? folderNames.join(', ') : t('aucun')],
          ] as ReadonlyArray<readonly [string, React.ReactNode, string?]>).map(([k, val, brut]) => (
            <div key={k} className="flex justify-between py-[3px]" style={{ color: 'var(--muted)' }}>
              <span>{t(k)}</span>
              <b style={{ color: 'var(--text)', fontWeight: 500 }}>
                {/* la seed se copie SANS « · fixe » : c'est le nombre qu'on recolle */}
                <Copiable texte={brut ?? (typeof val === 'string' ? val : '')}>{val}</Copiable>
              </b>
            </div>
          ))}
          <div className="flex gap-3 items-center mt-1">
            <button className="text-[12px]" style={{ color: 'var(--muted)', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void loadProv()}>{t('provenance complète…')}</button>
            <button className="text-[12px]" style={{ color: 'var(--muted)', background: 'none', border: 0, cursor: 'pointer' }}
              title={t('Le graphe exact de ce rendu, à glisser dans ComfyUI')} onClick={() => void telechargerGraphe()}>{t('workflow ComfyUI')}</button>
          </div>
          {modeles && <div className="mt-1 text-[12px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            {modeles.length ? modeles.map(m => <div key={m.fichier}>{m.fichier.replace(/\.(safetensors|gguf)$/, '')} · {m.licence ?? t('licence : voir la fiche du modèle')}</div>) : t('aucun modèle nommé dans ce graphe')}
          </div>}
          {prov && <pre className="mt-1 text-[12px] max-h-[120px] overflow-auto" style={{ color: 'var(--faint)' }}>{prov}</pre>}
          </div>}
        </div>
        <PileLoras loras={loras} charge />
        <div className="flex gap-1.5">
          {proprio && <button className="b2 flex-1" style={{ color: 'var(--positif)', background: asset.reviewStatus === 'approved' ? 'var(--positif-doux)' : undefined }}
            onClick={() => s.reviewAsset(asset.id, asset.reviewStatus === 'approved' ? 'pending' : 'approved')}><Ic n="heart" s={14} />{t('Valider')}</button>}
          {proprio && <button className="b2 flex-1" style={{ color: 'var(--danger)', background: asset.reviewStatus === 'rejected' ? 'var(--danger-doux)' : undefined }}
            onClick={() => s.reviewAsset(asset.id, asset.reviewStatus === 'rejected' ? 'pending' : 'rejected')}><Ic n="x" s={14} />{t('Refuser')}</button>}
          <button className="b2 flex-1" disabled={asset.reviewStatus !== 'approved'}
            style={{ opacity: asset.reviewStatus === 'approved' ? 1 : .4 }}
            onClick={() => s.toggleExportReady(asset.id)}><Ic n={asset.exportReady ? 'check' : 'upload'} s={14} />Export</button>
        </div>

        {String(asset.jobId).startsWith('stage-') && <button className="b2" onClick={() => void rouvrirStage()}>{t('Ouvrir dans la scène 3D')}</button>}
        <div className="mt-auto flex flex-col gap-1.5">
          {asset.mediaType === 'photo' && (
            <button className="cta" style={{ padding: '13px', flexDirection: 'row', gap: 8 }}
              onClick={() => { void s.animateFrom(asset); onClose(); goVideo() }}><Ic n="camera" s={16} />{t('Animer (i2v)')}</button>
          )}
          {asset.mediaType === 'photo' && (
            <button className="b2" title={t('la photo sert de départ et d’arrivée : le clip tourne sans saute')}
              onClick={() => { void s.boucleFrom(asset); onClose(); goVideo() }}><Ic n="loop" s={14} />{t('Boucle')}</button>
          )}
          {asset.mediaType === 'video' && (<>
            <button className="cta" style={{ padding: '13px', flexDirection: 'row', gap: 8 }}
              onClick={() => { s.updateVideo({ task: 'extend' }); void s.pickExtendClip(asset.id); onClose(); goVideo() }}><Ic n="extend" s={16} />{t('Étendre')}</button>
            <button className="b2" onClick={() => setEditer(true)} title={t('au pinceau ou au prompt')}><Ic n="edit" s={14} />{t('Éditer')}</button>
            <div className="flex gap-1.5">
              {!asset.withAudio && <button className="b2 flex-1" title={t('générer une piste d’ambiance (LTX-2.5) calée sur les images, sans voix ni musique')}
                onClick={() => void finition('foley')}><Ic n="sound" s={14} />{t('Ajouter le son')}</button>}
              {asset.postOp !== 'interpolate' && <button className="b2 flex-1" title={t('RIFE ×2 : double les images, le mouvement devient plus fluide')}
                onClick={() => void finition('interpolate')}><Ic n="wave" s={14} />{t('Fluidité 48 i/s')}</button>}
            </div>
          </>)}
          {/* « Utiliser dans… » : ce média ouvre une autre section, déjà choisi comme source */}
          {asset.jobId && <button className="pill workflow-comfy" onClick={() => void telechargerGraphe()} title={t('Le graphe exact de ce rendu, à glisser dans ComfyUI')}>
            <Ic n="graphe" /> {t('Télécharger le workflow ComfyUI')}</button>}
          <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
            {t('Utiliser dans')}
            {asset.mediaType === 'photo' && <>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => { s.utiliserDans('presets', asset); onClose() }}>{t('Caméra & effets')}</button>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => { s.utiliserDans('parole', asset); onClose() }}>{t('Avatar parlant')}</button>
            </>}
            {asset.mediaType === 'video' && <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => { s.utiliserDans('reshoot', asset); onClose() }}>{t('Re-shoot')}</button>}
            {asset.mediaType === 'video' && <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('SeedVR2 : le clip monte en 1080p, le mouvement ne change pas')} onClick={() => void nettete()}>{t('Netteté 1080p')}</button>}
            {netteMsg && <span className="text-[12px]" style={{ color: 'var(--danger)' }}>{netteMsg}</span>}
          </div>
          {asset.mediaType === 'video' && action !== 'master' && <details className="plus"><summary>{t('Exporter un master')}</summary><div><Masters asset={asset} /></div></details>}
          {asset.modele3d && (
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Objet 3D')}
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setVoir3d(v => !v)}>{t('Voir en 3D')}</button>
              <a className="pill" style={{ fontSize: 12, padding: '4px 9px' }} href={asset.modele3d} download>{t('Télécharger le GLB')}</a>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={placerDansStage}>{t('Placer dans la scène 3D')}</button>
            </div>
          )}
          {voir3d && asset.modele3d && createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'var(--scene)' }}><Suspense fallback={null}><Objet3D url={asset.modele3d} /></Suspense>
            <button className="pill" style={{ position: 'absolute', top: 16, right: 16 }} onClick={() => setVoir3d(false)}>{t('fermer')}</button></div>, document.body)}
          {finMsg && <div className="text-[12px]" style={{ color: finMsg.ok ? 'var(--positif)' : 'var(--danger)' }}>{finMsg.txt}</div>}
          {asset.mediaType === 'photo' && <details className="plus" open={plusOuvert} onToggle={e => setPlusOuvert(e.currentTarget.open)}><summary>{t('Plus…')}</summary><div>
            <button className="b2" onClick={() => { void s.retouchFrom(asset); onClose(); goImage() }}><Ic n="edit" s={14} />{t('Éditer (retouche)')}</button>
            <button className="b2" onClick={() => setPinceau(true)} title={t('peindre une zone et la refaire, le reste de l\'image ne change pas')}><Ic n="brush" s={14} />{t('Pinceau')}</button>
            {/* Looks en un clic : une retouche Qwen-Image-Edit à consigne prête, lancée tout de suite */}
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setVoirLooks(v => !v)}>{t('Look')} {voirLooks ? '▴' : `▾ ${LOOKS.length}`}</button>
              {voirLooks && LOOKS.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={l.consigne}
                  onClick={() => void lancerLook(l.consigne)}>{getLang() === 'en' ? l.en : l.label}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Angle')}
              {ANGLES.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('la même photo, vue d’une autre position de caméra')}
                  onClick={() => void lancerAngle(l.vue)}>{t(l.label)}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Plan suivant')}
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('3 plans de la même scène : large, ¾ et gros plan')} onClick={() => void coverage()}>Coverage</button>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('le même instant, la caméra plus près')}
                onClick={() => void lancerLook('Move the camera closer: a tighter shot of the same person at the same moment, framed from the chest up. Keep the same face, outfit, pose, light and background.')}>Push in</button>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('le moment d’après, imaginé à partir de l’image')} onClick={() => void nextBeat()}>Next beat</button>
              {planMsg && <span className="texte-erreur">{planMsg}</span>}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Lumière')}
              {LUMIERES.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('la même photo, un autre éclairage')}
                  onClick={() => void lancerLook(l.consigne)}>{t(l.label)}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Agrandir')}
              {FORMATS.map(f => (
                <button key={f} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('élargit le cadre et invente la suite de la scène sur les bords')}
                  onClick={() => void agrandir(f)}>{f}</button>
              ))}
              {agrandirMsg && <span className="texte-erreur">{agrandirMsg}</span>}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setGuide3d(true)}>{t('Objet 3D')}</button>
              <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t('à joindre au prompt photo, 6 au plus')} onClick={() => { void s.ajouterReference(asset); onClose() }}>{t('Référence')}</button>
            </div>
            <button className="pill" style={{ fontSize: 12, padding: '4px 9px', alignSelf: 'flex-start' }} title={t('PNG avec alpha : le sujet est gardé, le fond disparaît, rien n’est redessiné')}
              onClick={() => void transparent()}>{t('Fond transparent')}</button>
            <button className="pill" style={{ fontSize: 12, padding: '4px 9px', alignSelf: 'flex-start' }} title={t('La carte de profondeur d’une photo (Depth Anything V2), pour le relief, le compositing et les ControlNet.')}
              onClick={() => void profondeur()}>{t('Carte de profondeur')}</button>
          </div></details>}
          <div className="flex gap-1.5">
            {asset.mediaType === 'photo' && (<>
              <button className="b2 flex-1" onClick={() => { void s.pickStartFrame(asset.id); onClose(); goVideo() }}><Ic n="debut" s={14} />{t('Frame départ')}</button>
              <button className="b2 flex-1" onClick={() => { void s.pickEndFrame(asset.id); onClose(); goVideo() }}><Ic n="fin" s={14} />{t('Frame fin')}</button>
            </>)}
          </div>
          <div className="flex gap-1.5">
            <button className="b2 flex-1" onClick={() => { s.cloneFrom(asset); onClose(); (asset.mediaType === 'video' ? goVideo : goImage)() }}><Ic n="copy" s={14} />{t('Cloner')}</button>
            {asset.jobId && !asset.postOp && <button className="b2 flex-1" title={t('mêmes réglages, nouvelle graine')}
              onClick={() => void s.encoreUne(asset).then(e => setFinMsg(e ? { ok: false, txt: e } : { ok: true, txt: t('encore une : en file') }))}><Ic n="dice" s={14} />{t('Encore une')}</button>}
            <a className="b2 flex-1 text-center" href={asset.uri} download style={{ textDecoration: 'none' }}><Ic n="download" s={14} />{t('Télécharger')}</a>
            <button className="b2" style={{ flex: '0 0 44px' }} title={t('plus…')} onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                if (menu) { setMenu(null); return }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: Math.min(r.left, window.innerWidth - 210), bottom: window.innerHeight - r.top + 6 })
              }}><Ic n="dots" /></button>
          </div>
        </div>
        {nav.index >= 0 && <div className="aide-clavier">{t('← → pour parcourir, Échap pour fermer · {n} médias', { n: nav.total })}</div>}
      </aside>
      {menu && <ViewerMenu asset={asset} at={menu} onClose={() => setMenu(null)}
        onCarousel={() => { setMenu(null); setCarousel(true) }}
        onDeleted={() => { setMenu(null); onClose() }} />}
      {carousel && <CarouselPopup asset={asset} onClose={() => setCarousel(false)} onLaunched={() => { setCarousel(false); onClose(); goImage() }} />}
    </div>
  )
}

/* ---------- menu ⋯ du viewer : parité avec la vignette + carrousel ---------- */
function ViewerMenu({ asset, at, onClose, onCarousel, onDeleted }: {
  asset: Asset; at: { x: number; bottom: number }; onClose: () => void
  onCarousel: () => void; onDeleted: () => void
}) {
  const edition = useEdition()
  const s = useAppStore()
  const [armed, arm] = useConfirm()
  const [showFolders, setShowFolders] = useState(false)
  useExclusiveMenu(onClose)
  const copyImage = async () => {
    try {
      const blob = await (await fetch(asset.uri)).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    } catch { await navigator.clipboard.writeText(window.location.origin + asset.uri) }
    onClose()
  }
  return createPortal(
    <div className="v2" style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'none', pointerEvents: 'none' }}>
      <div className="menu" style={{ left: at.x, bottom: at.bottom, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        {asset.mediaType === 'photo' && <button onClick={() => void copyImage()}><Ic n="clipboard" /> {t('Copier l\'image')}</button>}
        <button onClick={() => { void navigator.clipboard.writeText(window.location.origin + asset.uri); onClose() }}><Ic n="link" /> {t('Copier l\'URL')}</button>
        <button style={showFolders ? { background: 'var(--lv4)' } : undefined}
          onMouseEnter={() => setShowFolders(true)}
          onClick={e => { e.stopPropagation(); setShowFolders(f => !f) }}><Ic n="folderIn" /> {t('Déplacer vers… ›')}</button>
        {asset.mediaType === 'photo' && <button onClick={onCarousel}><Ic n="grid" /> {t('Carrousel')}</button>}
        {edition && <div className="sep" />}
        {edition && <button style={{ color: 'var(--danger)' }}
          onClick={() => { if (arm()) { void s.removeAsset(asset.id); onDeleted() } }}>
          <Ic n="trash" /> {armed ? t('⚠ Confirmer la suppression') : t('Supprimer')}
        </button>}
        {showFolders && <FolderMenu nested side={at.x + 210 + 330 > window.innerWidth ? 'left' : 'right'}
          onClose={onClose} assetIds={[asset.id]} at={at} />}
      </div>
    </div>, document.body)
}
