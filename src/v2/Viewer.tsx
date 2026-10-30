/* ============================================================
   v2 — visionneuse : média + panneau Info (prompt, provenance),
   revue, ponts (Animer / frames / recréer / cloner). Navigation
   ← → sur la liste FILTRÉE (useAssetNav, fix inclus).
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import LOOKS from '../data/looks.json'
import { useAssetNav } from '../components/useAssetNav'
import { AssetNavArrows } from '../components/AssetNavArrows'
import { renderTime } from '../lib/renderTime'
import { resumeControle } from '../lib/controle'
import { trierDossiers } from '../lib/folders'
import { FolderMenu, Ic, lancerFinition, useConfirm, useExclusiveMenu } from './bits'
import { createPortal } from 'react-dom'
import { CarouselPopup } from './popups'
import { AvantApres } from '../components/AvantApres'
import { Pinceau } from '../components/Pinceau'
import { t, getLang, tServeur } from '../i18n'
import { EditionVideo } from '../components/EditionVideo'

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
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--lv2)' }}>
      <h4 className="text-[10px] uppercase tracking-wider flex items-center" style={{ color: 'var(--faint)' }}>
        {titre}
        <button className={`copier-btn ml-auto text-[10px] normal-case tracking-normal ${fait ? 'fait' : ''}`}
          onClick={() => copier(texte)}>
          <span className="lbl-a">{t('copier')}</span><span className="lbl-b">{t('copié !')}</span>
        </button>
      </h4>
      <div className="mt-2 text-[11px] overflow-y-auto"
        style={{ color: 'var(--muted)', lineHeight: 1.55, maxHeight: hauteur, whiteSpace: 'pre-wrap' }}>
        {texte}
      </div>
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
    <div className="rounded-xl p-3 text-[11px]" style={{ background: 'var(--lv2)' }}>
      <h4 className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>{t('LoRA appliquées')}</h4>
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
      <h4 className="text-[10px] uppercase tracking-wider flex items-center" style={{ color: 'var(--faint)' }}>
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
            <button key={o.caption} className="text-left text-[11px] rounded-md px-2 py-1"
              style={{ background: 'none', border: '1px solid var(--lv3)', color: 'var(--muted)', cursor: 'pointer' }}
              onClick={() => { setTexte(o.caption); s.setCaption(asset.id, o.caption) }}>
              {o.caption} <span style={{ color: 'var(--faint)' }}>· {o.family}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Angles (30/10) : la même photo vue d'une autre position de caméra — Qwen-Image-Edit 2511 avec la LoRA
 *  Multiple-Angles de fal (Apache-2.0, 96 poses apprises sur des rendus Gaussian Splatting). */
const LORA_ANGLES = 'qwen/qwen-image-edit-2511-multiple-angles-lora.safetensors'
const ANGLES = [
  { id: 'g34', label: '¾ gauche', vue: 'front-left quarter view eye-level shot medium shot' },
  { id: 'd34', label: '¾ droite', vue: 'front-right quarter view eye-level shot medium shot' },
  { id: 'profil', label: 'Profil', vue: 'right side view eye-level shot medium shot' },
  { id: 'dos', label: 'De dos', vue: 'back view eye-level shot medium shot' },
  { id: 'plongee', label: 'Plongée', vue: 'front view high-angle shot medium shot' },
  { id: 'contre', label: 'Contre-plongée', vue: 'front view low-angle shot medium shot' },
  { id: 'large', label: 'Plan large', vue: 'front view eye-level shot wide shot' },
  { id: 'serre', label: 'Gros plan', vue: 'front view eye-level shot close-up' },
]

/* Lumière (30/10) : la même photo, un autre éclairage. */
const GARDE = 'Keep the person, face, pose, outfit, background and framing unchanged.'
const LUMIERES = [
  { id: 'gauche', label: 'Par la gauche', consigne: `Relight the photo with soft directional light coming from the left, with shadows falling to the right. ${GARDE}` },
  { id: 'droite', label: 'Par la droite', consigne: `Relight the photo with soft directional light coming from the right, with shadows falling to the left. ${GARDE}` },
  { id: 'fenetre', label: 'Fenêtre', consigne: `Relight the photo with soft natural window light from one side. ${GARDE}` },
  { id: 'studio', label: 'Studio', consigne: `Relight the photo with clean professional softbox studio lighting. ${GARDE}` },
  { id: 'bleue', label: 'Heure bleue', consigne: `Relight the photo to cool blue hour dusk light. ${GARDE}` },
  { id: 'neon', label: 'Néons', consigne: `Relight the photo with magenta and cyan neon light from both sides, at night. ${GARDE}` },
  { id: 'bougie', label: 'Bougie', consigne: `Relight the photo with warm flickering candlelight in a dim room. ${GARDE}` },
]
const FORMATS = ['16:9', '9:16', '4:5', '1:1', '+30%']

/* Looks en un clic : consignes de retouche prêtes (Qwen-Image-Edit 2511), dans src/data/looks.json. */
export function Viewer({ asset, list, onGo, onClose, goVideo, goImage }: {
  asset: Asset
  list: Asset[]
  onGo: (a: Asset | null) => void
  onClose: () => void
  goVideo: () => void
  goImage: () => void
}) {
  const s = useAppStore()
  const nav = useAssetNav(list, asset, a => (a ? onGo(a) : onClose()))
  const [prov, setProv] = useState<string | null>(null)
  /* Agrandissement : l'image d'origine, si elle est encore en bibliothèque. */
  const parent = asset.parentAssetId ? s.assets.find(a => a.id === asset.parentAssetId && a.mediaType === asset.mediaType) ?? null : null
  const [compare, setCompare] = useState(false)
  const [pinceau, setPinceau] = useState(false)
  const [editer, setEditer] = useState(false)
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
  useEffect(() => { setCompare(false) }, [asset.id])
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

  /* « Ouvrir dans ComfyUI » (30/10) : le graphe exact du rendu en .json, et ses modèles avec leur licence */
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
  const [agrandirMsg, setAgrandirMsg] = useState('')
  const agrandir = async (format: string) => {
    setAgrandirMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/agrandir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setAgrandirMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    onClose(); goImage()
  }
  const telechargerGraphe = async () => {
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/workflow`)
    if (!r.ok) { setModeles([]); return }
    const d = await r.json()
    setModeles(d.modeles ?? [])
    const url = URL.createObjectURL(new Blob([JSON.stringify(d.workflow, null, 1)], { type: 'application/json' }))
    const lien = document.createElement('a'); lien.href = url; lien.download = `${asset.id}-workflow-api.json`; lien.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  const loadProv = async () => {
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`)
    setProv(JSON.stringify(await r.json(), null, 1))
  }

  return (
    <div className="fixed inset-0 z-50 flex max-[820px]:flex-col" style={{ background: 'var(--bg)' }}>
      {pinceau && <Pinceau asset={asset} onClose={() => setPinceau(false)} />}
      {editer && <EditionVideo asset={asset} onClose={() => setEditer(false)} onPinceau={() => setPinceau(true)} />}
      <div className="flex-1 relative flex items-center justify-center" style={{ background: '#08090b' }}>
        <button className="absolute top-3 left-3 z-10 b2" onClick={onClose}>{t('‹ retour')}</button>
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
          ? <video src={asset.uri} controls autoPlay loop playsInline className="max-h-[92vh] max-w-[86%] rounded-[10px]" style={{ boxShadow: 'var(--sh-md)' }}
              onLoadedMetadata={e => { const el = e.target as HTMLVideoElement; setClip({ w: el.videoWidth, h: el.videoHeight, dur: el.duration }) }} />
          : <img src={asset.uri} alt="" className="max-h-[92vh] max-w-[86%] rounded-[10px] object-contain" style={{ boxShadow: 'var(--sh-md)' }} />}
        <AssetNavArrows {...nav} />
      </div>

      <aside className="viewer-panel flex-none flex flex-col gap-2.5 p-4 overflow-y-auto" style={{ width: 330, background: 'var(--lv1)' }}>
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
          <PromptCard titre={t('👁 Vision VLM de la still')} texte={p.promptVision} hauteur={110} />
        )}
        <PromptCard titre={p.promptVision || p.initialBrief ? t('Prompt composé (envoyé au moteur)') : t('Prompt composé')}
          texte={p.composedPositive || p.userPrompt || '—'} hauteur={130} />
        <div className="rounded-xl p-3 text-[11px]" style={{ background: 'var(--lv2)' }}>
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
            <button className="text-[10px]" style={{ color: 'var(--muted)', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void loadProv()}>{t('provenance complète…')}</button>
            <button className="text-[10px]" style={{ color: 'var(--muted)', background: 'none', border: 0, cursor: 'pointer' }}
              title={t('Le graphe exact de ce rendu, à glisser dans ComfyUI')} onClick={() => void telechargerGraphe()}>{t('⤓ workflow ComfyUI')}</button>
          </div>
          {modeles && <div className="mt-1 text-[10px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            {modeles.length ? modeles.map(m => <div key={m.fichier}>{m.fichier.replace(/\.(safetensors|gguf)$/, '')} · {m.licence ?? t('licence : voir la fiche du modèle')}</div>) : t('aucun modèle nommé dans ce graphe')}
          </div>}
          {prov && <pre className="mt-1 text-[9px] max-h-[120px] overflow-auto" style={{ color: 'var(--faint)' }}>{prov}</pre>}
        </div>
        <PileLoras loras={loras} charge />
        <div className="flex gap-1.5">
          <button className="b2 flex-1" style={{ color: 'var(--positif)', background: asset.reviewStatus === 'approved' ? 'rgba(62,207,114,.14)' : undefined }}
            onClick={() => s.reviewAsset(asset.id, asset.reviewStatus === 'approved' ? 'pending' : 'approved')}>{t('♥ Valider')}</button>
          <button className="b2 flex-1" style={{ color: 'var(--danger)', background: asset.reviewStatus === 'rejected' ? 'rgba(240,85,72,.14)' : undefined }}
            onClick={() => s.reviewAsset(asset.id, asset.reviewStatus === 'rejected' ? 'pending' : 'rejected')}>{t('✕ Refuser')}</button>
          <button className="b2 flex-1" disabled={asset.reviewStatus !== 'approved'}
            style={{ opacity: asset.reviewStatus === 'approved' ? 1 : .4 }}
            onClick={() => s.toggleExportReady(asset.id)}>⇪ Export{asset.exportReady ? ' ✓' : ''}</button>
        </div>

        <div className="mt-auto flex flex-col gap-1.5">
          {asset.mediaType === 'photo' && (
            <button className="cta" style={{ padding: '13px', flexDirection: 'row' }}
              onClick={() => { void s.animateFrom(asset); onClose(); goVideo() }}>{t('▶ Animer (i2v)')}</button>
          )}
          {asset.mediaType === 'video' && (<>
            <button className="cta" style={{ padding: '13px', flexDirection: 'row' }}
              onClick={() => { s.updateVideo({ task: 'extend' }); void s.pickExtendClip(asset.id); onClose(); goVideo() }}>{t('⧉ Étendre')}</button>
            <button className="b2" onClick={() => setEditer(true)} title={t('au pinceau ou au prompt')}>{t('✎ Éditer')}</button>
            <div className="flex gap-1.5">
              {!asset.withAudio && <button className="b2 flex-1" title={t('générer une piste d’ambiance (LTX-2.5) calée sur les images, sans voix ni musique')}
                onClick={() => void finition('foley')}>{t('♪ Ajouter le son')}</button>}
              {asset.postOp !== 'interpolate' && <button className="b2 flex-1" title={t('RIFE ×2 : double les images, le mouvement devient plus fluide')}
                onClick={() => void finition('interpolate')}>{t('≈ Fluidité 48 i/s')}</button>}
            </div>
          </>)}
          {/* « Utiliser dans… » (30/10) : ce média ouvre une autre section, déjà choisi comme source */}
          <div className="flex gap-1.5 items-center flex-wrap text-[10.5px]" style={{ color: 'var(--muted)' }}>
            {t('Utiliser dans')}
            {asset.mediaType === 'photo' && <>
              <button className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} onClick={() => { s.utiliserDans('presets', asset); onClose() }}>{t('Caméra & effets')}</button>
              <button className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} onClick={() => { s.utiliserDans('parole', asset); onClose() }}>{t('Avatar parlant')}</button>
            </>}
            {asset.mediaType === 'video' && <button className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} onClick={() => { s.utiliserDans('reshoot', asset); onClose() }}>{t('🎥 Re-shoot')}</button>}
          </div>
          {finMsg && <div className="text-[10.5px]" style={{ color: finMsg.ok ? 'var(--positif)' : 'var(--danger)' }}>{finMsg.txt}</div>}
          {asset.mediaType === 'photo' && (<>
            <button className="b2" onClick={() => { void s.retouchFrom(asset); onClose(); goImage() }}>{t('✎ Éditer (retouche)')}</button>
            <button className="b2" onClick={() => setPinceau(true)} title={t('peindre une zone et la refaire, le reste de l\'image ne change pas')}>{t('🖌 Pinceau')}</button>
            {/* Looks en un clic (30/10) : une retouche Qwen-Image-Edit à consigne prête, lancée tout de suite */}
            <div className="flex gap-1.5 items-center flex-wrap text-[10.5px]" style={{ color: 'var(--muted)' }}>
              <button className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} onClick={() => setVoirLooks(v => !v)}>{t('Look')} {voirLooks ? '▴' : `▾ ${LOOKS.length}`}</button>
              {voirLooks && LOOKS.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} title={l.consigne}
                  onClick={() => void lancerLook(l.consigne)}>{getLang() === 'en' ? l.en : l.label}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[10.5px]" style={{ color: 'var(--muted)' }}>
              {t('Angle')}
              {ANGLES.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} title={t('la même photo, vue d’une autre position de caméra')}
                  onClick={() => void lancerAngle(l.vue)}>{t(l.label)}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[10.5px]" style={{ color: 'var(--muted)' }}>
              {t('Lumière')}
              {LUMIERES.map(l => (
                <button key={l.id} className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} title={t('la même photo, un autre éclairage')}
                  onClick={() => void lancerLook(l.consigne)}>{t(l.label)}</button>
              ))}
            </div>
            <div className="flex gap-1.5 items-center flex-wrap text-[10.5px]" style={{ color: 'var(--muted)' }}>
              {t('Agrandir')}
              {FORMATS.map(f => (
                <button key={f} className="pill" style={{ fontSize: 10.5, padding: '4px 9px' }} title={t('élargit le cadre et invente la suite de la scène sur les bords')}
                  onClick={() => void agrandir(f)}>{f}</button>
              ))}
              {agrandirMsg && <span style={{ color: 'var(--danger)' }}>{agrandirMsg}</span>}
            </div>
          </>
)}
          <div className="flex gap-1.5">
            {asset.mediaType === 'photo' && (<>
              <button className="b2 flex-1" onClick={() => { void s.pickStartFrame(asset.id); onClose(); goVideo() }}>{t('Frame départ')}</button>
              <button className="b2 flex-1" onClick={() => { void s.pickEndFrame(asset.id); onClose(); goVideo() }}>{t('Frame fin')}</button>
            </>)}
          </div>
          <div className="flex gap-1.5">
            <button className="b2 flex-1" onClick={() => { s.cloneFrom(asset); onClose(); (asset.mediaType === 'video' ? goVideo : goImage)() }}>{t('⧉ Cloner')}</button>
            {asset.jobId && !asset.postOp && <button className="b2 flex-1" title={t('mêmes réglages, nouvelle graine')}
              onClick={() => void s.encoreUne(asset).then(e => setFinMsg(e ? { ok: false, txt: e } : { ok: true, txt: t('encore une : en file') }))}>{t('🎲 Encore une')}</button>}
            <a className="b2 flex-1 text-center" href={asset.uri} download style={{ textDecoration: 'none' }}>{t('⤓ Télécharger')}</a>
            <button className="b2" style={{ flex: '0 0 44px' }} title={t('plus…')} onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                if (menu) { setMenu(null); return }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: Math.min(r.left, window.innerWidth - 210), bottom: window.innerHeight - r.top + 6 })
              }}><Ic n="dots" /></button>
          </div>
        </div>
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
        <div className="sep" />
        <button style={{ color: 'var(--danger)' }}
          onClick={() => { if (arm()) { void s.removeAsset(asset.id); onDeleted() } }}>
          <Ic n="trash" /> {armed ? t('⚠ Confirmer la suppression') : t('Supprimer')}
        </button>
        {showFolders && <FolderMenu nested side={at.x + 210 + 330 > window.innerWidth ? 'left' : 'right'}
          onClose={onClose} assetIds={[asset.id]} at={at} />}
      </div>
    </div>, document.body)
}
