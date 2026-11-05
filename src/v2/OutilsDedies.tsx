/* Pages dédiées des outils d'un seul geste : à gauche le média de départ et les réglages, à droite
   « Comment ça marche » et l'historique de tous les rendus de l'outil (repérés par le préfixe de
   leur job, ou suivis depuis ce navigateur quand l'outil partage sa recette avec un autre). */
import { useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { OutilPage, ZoneSource, useSuiviOutil, type Etape } from './OutilPage'
import { lancerFinition } from './bits'
import { Pinceau } from '../components/Pinceau'
import { Masters } from './Masters'
import { ANGLES, LORA_ANGLES } from './Viewer'

export type IdOutil = 'inpaint' | 'remove-bg' | 'depth' | 'loop' | 'retouch' | 'remove-objects' | 'change-bg'
  | 'upscale' | 'green-screen' | 'add-sound' | 'smooth' | 'hdr' | 'multi-angle' | 'coverage' | 'next-shot' | 'image-3d'
  | 'refine-details' | 'day-to-night' | 'deblur' | 'decompression'

type Valeurs = { texte: string; texte2: string; alpha: boolean; choix: string }
type Conf = {
  titre: string; texte: string; media: 'photo' | 'video' | 'choix'
  /** préfixes d'id de job propres à l'outil : tout son historique, même lancé ailleurs */
  prefixes?: string[]
  etapes: Etape[]
  champ?: { label: string; placeholder: string; requis?: boolean }
  champ2?: { label: string; placeholder: string }
  alpha?: boolean
  choix?: { label: string; options: { id: string; label: string }[] }
  bouton: string
  /** lance le rendu et rend l'id du job (ou rien quand l'outil ouvre un éditeur) */
  lancer?: (a: Asset, v: Valeurs) => Promise<string | null>
  pinceau?: boolean
}

const poster = async (url: string, body: unknown): Promise<string> => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({})) as { jobId?: string; id?: string; error?: string }
  if (!r.ok || !(d.jobId ?? d.id)) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
  return (d.jobId ?? d.id)!
}
const finition = async (a: Asset, op: 'foley' | 'interpolate', prompt?: string) => {
  const e = await lancerFinition(a, op, prompt)
  if (e) throw new Error(e)
  return useAppStore.getState().jobs[0]?.id ?? null
}

/* Retouche Qwen-Image-Edit d'une photo, sans quitter la page ; avec la LoRA d'angles si demandé. */
async function retouche(a: Asset, consigne: string, angles = false): Promise<string | null> {
  const st = useAppStore.getState()
  const avant = st.loraPicks
  if (angles) useAppStore.setState({ loraPicks: [{ name: LORA_ANGLES, strength: 1, trigger: '' }] })
  try {
    st.setMode('photo'); st.updatePhoto({ task: 'edit' })
    await useAppStore.getState().pickEditSource(a.id)
    useAppStore.getState().setUserPrompt(consigne)
    useAppStore.setState({ promptTouched: true, composedPositive: '' })
    await useAppStore.getState().submitJob()
    return useAppStore.getState().jobs[0]?.id ?? null
  } finally { if (angles) useAppStore.setState({ loraPicks: avant }) }
}

const CONFS: Record<IdOutil, Conf> = {
  'inpaint': { titre: 'Inpaint', texte: 'Peins une zone de la photo et dis ce qui doit y apparaître : le reste ne change pas.', media: 'photo', prefixes: ['inp-'], pinceau: true, bouton: 'Peindre la zone',
    etapes: [{ titre: 'Choisis la photo', texte: 'Dans la bibliothèque, à gauche.' }, { titre: 'Peins la zone', texte: 'Au pinceau, sur ce qui doit changer.' }, { titre: 'Décris le changement', texte: 'En anglais : ce qui doit apparaître dans la zone.' }] },
  'remove-bg': { titre: 'Remove Background', texte: 'Le sujet est gardé, le fond disparaît : un PNG transparent, rien n’est redessiné.', media: 'photo', prefixes: ['transp-'], bouton: 'Retirer le fond',
    champ: { label: 'Sujet à garder (facultatif, en anglais)', placeholder: 'person · perfume bottle · red car' },
    etapes: [{ titre: 'Choisis la photo', texte: 'Une personne ou un objet bien visible.' }, { titre: 'Nomme le sujet', texte: 'Vide : la personne. Sinon l’objet à garder, en anglais.' }, { titre: 'Récupère le PNG', texte: 'SAM3 découpe le sujet, le fond devient transparent.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/transparent`, { sujet: v.texte.trim() || undefined }) },
  'depth': { titre: 'Depth Map', texte: 'La carte de profondeur d’une photo (Depth Anything V2), pour le relief, le compositing et les ControlNet.', media: 'photo', prefixes: ['depth-'], bouton: 'Calculer la profondeur',
    etapes: [{ titre: 'Choisis la photo', texte: 'N’importe quelle photo de la bibliothèque.' }, { titre: 'Calcule', texte: 'Quelques secondes : proche en clair, loin en sombre.' }, { titre: 'Utilise-la', texte: 'Relief, flou de profondeur, ControlNet depth dans ComfyUI.' }],
    lancer: a => poster(`/api/assets/${encodeURIComponent(a.id)}/profondeur`, {}) },
  'loop': { titre: 'Seamless Loop', texte: 'Un clip qui revient à son image de départ : il tourne en boucle sans raccord.', media: 'photo', bouton: 'Créer la boucle',
    champ: { label: 'Ce qui bouge (en anglais)', placeholder: 'her hair moves in the wind, the lights flicker', requis: true },
    etapes: [{ titre: 'Choisis la photo', texte: 'Elle sert de première et de dernière image.' }, { titre: 'Décris le mouvement', texte: 'Un mouvement qui peut revenir à son point de départ.' }, { titre: 'Boucle', texte: 'Wan 2.2 relie la photo à elle-même : le clip tourne sans raccord.' }],
    lancer: async (a, v) => {
      const s = useAppStore.getState()
      await s.boucleFrom(a)
      s.setUserPrompt(v.texte.trim())
      useAppStore.setState({ promptTouched: true })
      await useAppStore.getState().submitJob()
      return useAppStore.getState().jobs[0]?.id ?? null
    } },
  'retouch': { titre: 'Retouch', texte: 'Peins une zone du clip et dis ce qui doit y apparaître : le reste du clip ne change pas.', media: 'video', prefixes: ['inpv-'], pinceau: true, bouton: 'Peindre la zone',
    etapes: [{ titre: 'Choisis le clip', texte: 'Dans la bibliothèque, à gauche.' }, { titre: 'Peins la zone', texte: 'Sur la première image : elle est suivie sur tout le clip.' }, { titre: 'Décris le changement', texte: 'En anglais : la nouvelle chose, ou l’objet d’une photo à poser.' }] },
  'remove-objects': { titre: 'Remove Objects', texte: 'Retire une personne ou un objet du clip : le décor derrière est reconstitué.', media: 'video', prefixes: ['cleanplate-'], bouton: 'Nettoyer le clip',
    champ: { label: 'À retirer (en anglais)', placeholder: 'people · the car · the passers-by', requis: true },
    champ2: { label: 'Décor à reconstituer (facultatif)', placeholder: 'an empty cobblestone street' },
    etapes: [{ titre: 'Choisis le clip', texte: 'Un plan fixe ou un mouvement lent marche le mieux.' }, { titre: 'Nomme ce qui part', texte: 'En anglais : people, the car, the dog.' }, { titre: 'Récupère le clip', texte: 'Le décor est reconstruit derrière, le son d’origine est gardé.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'retirer', cible: v.texte.trim(), prompt: v.texte2.trim() }) },
  'refine-details': { titre: 'Refine Details', texte: 'Le clip retrouve de la matière : peau, tissus, cheveux et grain, sans changer le mouvement (LTX-2.5).', media: 'video', prefixes: ['effet-'], bouton: 'Affiner le clip',
    etapes: [{ titre: 'Choisis le clip', texte: 'Un rendu trop lisse : une danse, un motion control, un clip IA.' }, { titre: 'Lance', texte: 'LTX-2.5 et l’IC-LoRA Refine Details de Lightricks redessinent le détail.' }, { titre: 'Compare', texte: 'Même cadrage, même mouvement, plus de texture.' }],
    lancer: a => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'effet', effet: 'refine-details' }) },
  'day-to-night': { titre: 'Day to Night', texte: 'Le même plan, la nuit : lumières, ciel et ambiance changent, le mouvement reste.', media: 'video', prefixes: ['effet-'], bouton: 'Passer à la nuit',
    champ: { label: 'Ambiance de nuit (facultatif, en anglais)', placeholder: 'warm street lamps, a deep blue sky' },
    etapes: [{ titre: 'Choisis le clip', texte: 'Un plan de jour, en extérieur de préférence.' }, { titre: 'Décris la nuit', texte: 'Facultatif : les lumières, le ciel.' }, { titre: 'Récupère le clip', texte: 'La même scène et le même mouvement, de nuit.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'effet', effet: 'day-to-night', prompt: v.texte.trim() }) },
  'deblur': { titre: 'Unblur', texte: 'Un clip flou ou bougé redevient net, sans changer la scène.', media: 'video', prefixes: ['effet-'], bouton: 'Rendre net',
    etapes: [{ titre: 'Choisis le clip', texte: 'Un plan flou de bougé ou de mise au point.' }, { titre: 'Lance', texte: 'LTX-2.5 et l’IC-LoRA Deblur de Lightricks.' }, { titre: 'Compare', texte: 'Même plan, net.' }],
    lancer: a => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'effet', effet: 'deblur' }) },
  'decompression': { titre: 'Remove Compression', texte: 'Les blocs et les bandes d’une vidéo trop compressée disparaissent.', media: 'video', prefixes: ['effet-'], bouton: 'Nettoyer la compression',
    etapes: [{ titre: 'Choisis le clip', texte: 'Une vidéo de réseau social ou de messagerie, très compressée.' }, { titre: 'Lance', texte: 'LTX-2.5 et l’IC-LoRA Decompression de Lightricks.' }, { titre: 'Compare', texte: 'Même plan, sans artefacts.' }],
    lancer: a => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'effet', effet: 'decompression' }) },
  'change-bg': { titre: 'Change Background', texte: 'Le sujet reste, le décor du clip change : décris le nouveau.', media: 'video', bouton: 'Changer le décor',
    champ: { label: 'Nouveau décor (en anglais)', placeholder: 'a sunny beach at golden hour', requis: true },
    champ2: { label: 'Sujet à garder (facultatif)', placeholder: 'person' },
    etapes: [{ titre: 'Choisis le clip', texte: 'Une personne bien détachée du fond.' }, { titre: 'Décris le décor', texte: 'En anglais, le lieu et la lumière.' }, { titre: 'Récupère le clip', texte: 'Le sujet et son geste restent, le décor change autour.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'fond', prompt: v.texte.trim(), cible: v.texte2.trim() || 'person' }) },
  'upscale': { titre: 'Upscale', texte: 'SeedVR2 monte la photo ou le clip en haute définition sans le redessiner.', media: 'choix', prefixes: ['seedvr-'], bouton: 'Monter en HD',
    etapes: [{ titre: 'Choisis la photo ou le clip', texte: 'Un rendu du studio ou un fichier ancien.' }, { titre: 'Lance', texte: 'SeedVR2 7B : les détails se resserrent, rien n’est inventé.' }, { titre: 'Compare', texte: 'Le résultat s’ouvre en avant / après.' }],
    lancer: async a => a.mediaType === 'video'
      ? poster(`/api/assets/${encodeURIComponent(a.id)}/seedvr`, {})
      : (async () => {
          const r = await fetch('/api/restauration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media: 'photo', assetId: a.id, nettoyer: false, couleur: false, hd: true }) })
          const d = await r.json().catch(() => ({})) as { etapes?: { job?: string }[]; error?: string }
          if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
          return d.etapes?.map(e => e.job).find(Boolean) ?? null
        })() },
  'green-screen': { titre: 'Green Screen', texte: 'SAM3 garde le sujet, rien n’est redessiné.', media: 'video', prefixes: ['detour-'], bouton: 'Détourer le clip', alpha: true,
    champ: { label: 'Sujet à garder (facultatif, en anglais)', placeholder: 'person · dog · car' },
    etapes: [{ titre: 'Choisis le clip', texte: 'Le sujet bien visible du début à la fin.' }, { titre: 'Fond vert ou transparent', texte: 'Fond vert pour le montage, ou WebM avec alpha.' }, { titre: 'Récupère le clip', texte: 'Le sujet est suivi image par image, rien n’est redessiné.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/edit-video`, { mode: 'detourer', cible: v.texte.trim(), alpha: v.alpha }) },
  'add-sound': { titre: 'Add Sound', texte: 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).', media: 'video', prefixes: ['son-'], bouton: 'Ajouter le son',
    champ: { label: 'Quels sons ? (facultatif, en anglais)', placeholder: 'waves, gulls, a distant tram' },
    etapes: [{ titre: 'Choisis le clip', texte: 'Un clip muet ou dont le son ne va pas.' }, { titre: 'Décris les sons', texte: 'Vide : l’ambiance naturelle de la scène, sans voix ni musique.' }, { titre: 'Récupère le clip', texte: 'Un nouveau clip, image identique, avec son son.' }],
    lancer: (a, v) => finition(a, 'foley', v.texte.trim() || undefined) },
  'smooth': { titre: 'Smooth Motion', texte: 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.', media: 'video', prefixes: ['rife-'], bouton: 'Fluidifier',
    etapes: [{ titre: 'Choisis le clip', texte: 'Un clip à 24 i/s ou moins.' }, { titre: 'Lance', texte: 'RIFE invente l’image entre deux images.' }, { titre: 'Récupère le clip', texte: 'Même durée, deux fois plus d’images.' }],
    lancer: a => finition(a, 'interpolate') },
  'multi-angle': { titre: 'Multi-Angle', texte: 'La même photo vue d’un autre angle : ¾, profil, plongée, contre-plongée, plan large.', media: 'photo', bouton: 'Changer d’angle',
    choix: { label: 'Angle', options: ANGLES.map(x => ({ id: x.id, label: x.label })) },
    etapes: [{ titre: 'Choisis la photo', texte: 'Une personne ou un objet bien visible.' }, { titre: 'Choisis l’angle', texte: '¾, profil, de dos, plongée, contre-plongée, large, serré.' }, { titre: 'Récupère la photo', texte: 'Qwen-Image-Edit avec la LoRA Multiple-Angles : même scène, autre caméra.' }],
    lancer: (a, v) => retouche(a, `<sks> ${(ANGLES.find(x => x.id === v.choix) ?? ANGLES[0]).vue}`, true) },
  'coverage': { titre: 'Coverage', texte: 'Trois plans de la même scène en un clic : large, trois-quarts et serré.', media: 'photo', bouton: 'Lancer les trois plans',
    etapes: [{ titre: 'Choisis la photo', texte: 'Le plan de départ de ta scène.' }, { titre: 'Lance', texte: 'Trois retouches : plan large, ¾ et gros plan.' }, { titre: 'Monte', texte: 'Trois angles cohérents pour couvrir la scène.' }],
    lancer: async a => { let id: string | null = null; for (const k of ['large', 'd34', 'serre']) id = await retouche(a, `<sks> ${ANGLES.find(x => x.id === k)!.vue}`, true); return id } },
  'next-shot': { titre: 'Next Shot', texte: 'Le plan d’après : la même personne, au même endroit, quelques secondes plus tard.', media: 'photo', bouton: 'Imaginer le plan suivant',
    etapes: [{ titre: 'Choisis la photo', texte: 'Le plan où en est ton histoire.' }, { titre: 'Lance', texte: 'Le VLM lit la photo et écrit ce qui se passe juste après.' }, { titre: 'Récupère le plan', texte: 'Même personne, même lieu, même lumière, quelques secondes plus tard.' }],
    lancer: async a => {
      const r = await fetch(`/api/assets/${encodeURIComponent(a.id)}/moment-suivant`, { method: 'POST' })
      const d = await r.json().catch(() => ({})) as { texte?: string; error?: string }
      if (!r.ok || !d.texte) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      return retouche(a, `The same person, same outfit, same place and same light, a few seconds later: ${d.texte} Keep the same face and photo style.`)
    } },
  'image-3d': { titre: 'Image to 3D', texte: 'Une photo devient un modèle à faire tourner, à télécharger ou à poser dans la scène 3D.', media: 'photo', prefixes: ['objet3d-'], bouton: 'Créer le modèle 3D',
    champ: { label: 'Objet à garder (en anglais)', placeholder: 'toy robot · red armchair · perfume bottle', requis: true },
    etapes: [{ titre: 'Choisis la photo', texte: 'Un objet bien détaché, entier dans le cadre.' }, { titre: 'Nomme l’objet', texte: 'En anglais : SAM3 le découpe.' }, { titre: 'Récupère le GLB', texte: 'TRELLIS.2 en une minute : à faire tourner, télécharger ou poser dans la scène 3D.' }],
    lancer: (a, v) => poster(`/api/assets/${encodeURIComponent(a.id)}/objet3d`, { cible: v.texte.trim() }) },
  'hdr': { titre: 'HDR Masters', texte: 'HLG, ProRes, EXR ACEScg et ProRes avec alpha.', media: 'video', bouton: '',
    etapes: [{ titre: 'Choisis le clip', texte: 'Un rendu fini.' }, { titre: 'Choisis le master', texte: 'HLG pour les écrans HDR, ProRes ou EXR pour l’étalonnage.' }, { titre: 'Télécharge', texte: 'Le fichier se prépare puis se télécharge.' }] },
}

export function OutilDedie({ id, onOpen }: { id: IdOutil; onOpen: (a: Asset, list: Asset[]) => void }) {
  const c = CONFS[id]
  const s = useAppStore()
  const suivi = useSuiviOutil(`dedie-${id}`)
  const [media, setMedia] = useState<'photo' | 'video'>(c.media === 'video' ? 'video' : 'photo')
  const [source, setSource] = useState<{ asset?: Asset } | null>(null)
  const [v, setV] = useState<Valeurs>({ texte: '', texte2: '', alpha: false, choix: c.choix?.options[0]?.id ?? '' })
  const [msg, setMsg] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)
  const [peindre, setPeindre] = useState(false)
  const a = source?.asset
  const lancer = async () => {
    if (!a) return
    if (c.pinceau) { setPeindre(true); return }
    if (!c.lancer) return
    setOccupe(true); setMsg(null)
    try {
      const job = await c.lancer(a, v)
      if (job) { suivi.ajouter([job]); void s.adoptServerJob(job) }
    } catch (e) { setMsg(String((e as Error).message || e)) }
    setOccupe(false)
  }
  const dejaVu = (jobId: string) => suivi.ids.has(jobId) || !!c.prefixes?.some(p => jobId.startsWith(p))
  const pret = !!a && (!c.champ?.requis || !!v.texte.trim())
  return (
    <>
      <OutilPage titre={c.titre} texte={t(c.texte)} etapes={c.etapes} onOpen={onOpen}
        jobs={j => dejaVu(j.id)} assets={x => dejaVu(x.jobId)}
        action={c.bouton ? <button className="cta" disabled={!pret || occupe} onClick={() => void lancer()}>{occupe ? '…' : t(c.bouton)}</button> : undefined}>
        {c.media === 'choix' && <div className="wtabs">
          <button className={`wtab ${media === 'photo' ? 'on' : ''}`} onClick={() => { setMedia('photo'); setSource(null) }}>{t('Photo')}</button>
          <button className={`wtab ${media === 'video' ? 'on' : ''}`} onClick={() => { setMedia('video'); setSource(null) }}>{t('Vidéo')}</button>
        </div>}
        <ZoneSource media={media} valeur={source} onChoix={x => setSource(x?.asset ? { asset: x.asset } : null)} label={t(media === 'video' ? 'Clip de départ' : 'Photo de départ')} />
        {c.champ && <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t(c.champ.label)}</span>
          <input className="champ" value={v.texte} maxLength={300} placeholder={c.champ.placeholder} onChange={e => setV({ ...v, texte: e.target.value })} /></label>}
        {c.champ2 && <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t(c.champ2.label)}</span>
          <input className="champ" value={v.texte2} maxLength={300} placeholder={c.champ2.placeholder} onChange={e => setV({ ...v, texte2: e.target.value })} /></label>}
        {c.alpha && <div className="wtabs">
          <button className={`wtab ${!v.alpha ? 'on' : ''}`} onClick={() => setV({ ...v, alpha: false })}>{t('Fond vert')}</button>
          <button className={`wtab ${v.alpha ? 'on' : ''}`} onClick={() => setV({ ...v, alpha: true })}>{t('Transparent (WebM)')}</button>
        </div>}
        {c.choix && <div style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t(c.choix.label)}</span>
          <div className="flex gap-1.5 flex-wrap">{c.choix.options.map(o => <button key={o.id} className={`pill ${v.choix === o.id ? 'on' : ''}`} onClick={() => setV({ ...v, choix: o.id })}>{t(o.label)}</button>)}</div></div>}
        {id === 'hdr' && a && <Masters asset={a} />}
        {msg && <span className="texte-erreur">{msg}</span>}
      </OutilPage>
      {peindre && a && <Pinceau asset={a} onClose={() => setPeindre(false)} />}
    </>
  )
}
