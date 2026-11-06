/* ============================================================
   Aperçus de l'accueil : chaque outil montre ce qu'il fait, sur de vrais
   rendus rangés dans public/vitrine. Un avant/après se lit en glissant la
   souris. Une vidéo marquée `auto` joue dès qu'elle est à l'écran, les
   autres au survol.
   ============================================================ */
import { useEffect, useRef } from 'react'
import { t } from '../i18n'

const v = (nom: string) => `/vitrine/${nom}`

export type Apercu =
  | { type: 'compare'; a: string; b: string; legA: string; legB: string; videoA?: string; videoB?: string; auto?: boolean }
  | { type: 'media'; image: string; video?: string; puces?: string[]; texte?: string; refs?: string[]; onde?: boolean; auto?: boolean }

const compare = (nom: string, legA: string, legB: string): Apercu => ({ type: 'compare', a: v(`${nom}-a.webp`), b: v(`${nom}-b.webp`), legA, legB })
const anime = (nom: string, reste: Partial<Extract<Apercu, { type: 'media' }>> = {}): Apercu => ({ type: 'media', image: v(`${nom}.webp`), video: v(`${nom}.mp4`), ...reste })

export const BANDEAU_STAGE: Apercu = { ...compare('stage', 'Maquette 3D', 'Rendu final'), videoA: v('stage-a.mp4'), videoB: v('stage-b.mp4') } as Apercu
export const BANDEAU_CINEMA: Apercu = { type: 'media', image: v('v2-cine-w.webp'), video: v('v2-cine-w2.mp4'), puces: ['35 mm', 'f/2.8', 'Clair-obscur', 'Pellicule 500T'], auto: true }
export const BANDEAU_RESTORE: Apercu = { type: 'compare', a: v('restaurer-a2.webp'), b: v('restaurer-b2.webp'), videoA: v('restaurer-a2.mp4'), videoB: v('restaurer-b2.mp4'), auto: true, legA: 'Archive de 1951', legB: 'Restaurée et colorisée' }
export const BANDEAU_REEL = anime('reel-w', { texte: 'Golden hour in Alfama', auto: true })
const compareVideo = (nom: string, legA: string, legB: string): Apercu => ({ ...compare(nom, legA, legB), videoA: v(`${nom}-a.mp4`), videoB: v(`${nom}-b.mp4`), auto: true } as Apercu)

export const BANDEAU_CAMERA = anime('camera-w', { puces: ['Orbite', 'Dolly zoom', 'Crash zoom', 'Drone', 'Arc', 'Bullet time'], auto: true })

/** Clé : le libellé de l'outil dans GROUPES. */
export const APERCUS: Record<string, Apercu> = {
  'Edit Image': { type: 'compare', a: v('v2-edit-a.webp'), b: v('v2-edit-b.webp'), legA: 'Photo', legB: 'Punk violet, collier' },
  'Inpaint': { type: 'compare', a: v('v2-inpaint-a.webp'), b: v('v2-inpaint-b.webp'), legA: 'Photo', legB: 'Panier repeint' },
  'Depth Map': { type: 'compare', a: v('v2-depth-a.webp'), b: v('v2-depth-b.webp'), legA: 'Photo', legB: 'Profondeur' },
  'Remove Background': { type: 'compare', a: v('v2-transp-a.webp'), b: v('v2-transp-b.webp'), legA: 'Photo', legB: 'PNG transparent' },
  'Upscale Image': { type: 'compare', a: v('v2-upimg-a.webp'), b: v('v2-upimg-b.webp'), legA: '400 px', legB: 'SeedVR2 · 2048 px' },
  'Dance': { type: 'media', image: v('v2-danse.webp'), video: v('v2-danse.mp4'), auto: true },
  'Carousel': { type: 'media', image: v('v2-carrousel.webp'), video: v('v2-carrousel.mp4'), auto: true },
  'Coverage': { type: 'media', image: v('v2-coverage.webp'), puces: ['Large', '¾', 'Serré'] },
  'Next Shot': { type: 'media', image: v('v2-suivant.webp'), puces: ['Plan 1', 'Plan 2'] },
  'Seamless Loop': { type: 'media', image: v('v2-cine-w.webp'), video: v('v2-cine-w.mp4'), auto: true },
  'Extend Video': { type: 'media', image: v('v2-video-b.webp'), video: v('v2-video-b.mp4'), auto: true },
  'Remove Objects': { type: 'compare', a: v('v2-retirer-a.webp'), b: v('v2-retirer-b.webp'), videoA: v('v2-retirer-a.mp4'), videoB: v('v2-retirer-b.mp4'), legA: 'Clip', legB: 'Place vidée' },
  'Change Background': { type: 'compare', a: v('v2-fond-a.webp'), b: v('v2-fond-b.webp'), videoA: v('v2-fond-a.mp4'), videoB: v('v2-fond-b.mp4'), legA: 'Clip', legB: 'Bord de mer' },
  'Add Sound': { type: 'media', image: v('onde.webp'), onde: true, texte: 'waves, gulls, distant tram' },
  'Smooth Motion': { type: 'media', image: v('v2-smooth.webp'), video: v('v2-smooth.mp4'), puces: ['24 → 48 i/s', 'RIFE'] },
  'Voice Clone': { type: 'media', image: v('onde.webp'), onde: true, texte: 'your voice, from a short sample' },
  'Voice Changer': { type: 'media', image: v('onde.webp'), onde: true, texte: 'same line, another voice' },
  'One-click Reel': anime('reel', { texte: 'Golden hour in Alfama', auto: true }),
  'Text to Image': { type: 'media', image: v('v2-photo.webp'), puces: ['Krea 2', 'LoRA d’identité'] },
  'Image to Video': { type: 'media', image: v('v2-video-a.webp'), video: v('v2-video-b.mp4'), puces: ['Photo → clip', 'Son'] },
  'Text to Video': { type: 'media', image: v('v2-texte.webp'), video: v('v2-texte.mp4'), texte: 'A jazz trumpeter plays alone in a narrow alley at night' },
  'Talking Avatar': { type: 'media', image: v('v2-avatar.webp'), video: v('v2-avatar.mp4'), texte: 'Hi, I’m Jessica.' },
  'Dialog & Voice Studio': { type: 'media', image: v('onde.webp'), onde: true, texte: 'Welcome to the studio' },
  'Music Studio': { type: 'media', image: v('onde.webp'), onde: true, texte: 'warm lo-fi hip hop, soft piano' },
  'Sound Effects': { type: 'media', image: v('onde.webp'), onde: true, texte: 'a heavy wooden door creaking open' },
  'Scène 3D': { ...compare('stage', 'Maquette 3D', 'Rendu final') },
  'Movie Studio': { type: 'media', image: v('v2-cine.webp'), video: v('v2-cine-v.mp4'), puces: ['35 mm', 'f/2.8', 'Clair-obscur', '500T'] },
  'Camera Moves': anime('camera-z2', { auto: true }),
  'Effects': anime('effets-z2', { auto: true }),
  'Re-shoot': { type: 'compare', a: v('v2-reshoot-a.webp'), b: v('v2-reshoot-b.webp'), videoA: v('v2-reshoot-a.mp4'), videoB: v('v2-reshoot-b.mp4'), legA: 'Plan d’origine', legB: 'Caméra qui tourne', auto: true },
  'Swap': compareVideo('mix', 'Original', 'Personnages échangés'),
  'Motion Control': compareVideo('move', 'Vidéo d’origine', 'Geste repris'),
  'Image to 3D': { ...compare('objet', 'Photo', 'Modèle 3D'), videoB: v('objet-b.mp4') } as Apercu,
  'Retouch': compareVideo('retouche', 'Avant', 'Objet posé'),
  'Styles': { type: 'compare', a: v('v2-renard.webp'), b: v('v2-briques.webp'), legA: 'Photo', legB: 'Brick toy' },
  'Relight': { type: 'compare', a: v('v2-renard.webp'), b: v('v2-neon.webp'), legA: 'Photo', legB: 'Néons' },
  'Expand': { type: 'compare', a: v('v2-expand-a.webp'), b: v('v2-expand-b.webp'), legA: '9:16', legB: '16:9' },
  'Multi-Angle': { type: 'compare', a: v('v2-vespa-a.webp'), b: v('v2-vespa-b.webp'), legA: 'Photo', legB: 'Contre-plongée' },
  'Editor': { type: 'media', image: v('montage.webp') },
  'Day to Night': { type: 'compare', a: v('v2-fx-nuit-a.webp'), b: v('v2-fx-nuit-b.webp'), videoA: v('v2-fx-nuit-a.mp4'), videoB: v('v2-fx-nuit-b.mp4'), auto: true, legA: 'Jour', legB: 'Nuit' },
  'Unblur': { type: 'compare', a: v('v2-fx-net-a.webp'), b: v('v2-fx-net-b.webp'), videoA: v('v2-fx-net-a.mp4'), videoB: v('v2-fx-net-b.mp4'), auto: true, legA: 'Flou', legB: 'Net' },
  'Remove Compression': { type: 'compare', a: v('v2-fx-propre-a.webp'), b: v('v2-fx-propre-b.webp'), videoA: v('v2-fx-propre-a.mp4'), videoB: v('v2-fx-propre-b.mp4'), auto: true, legA: 'Compressé', legB: 'Nettoyé' },
  'Refine Details': { type: 'media', image: v('v2-fx-fin.webp'), video: v('v2-fx-fin.mp4'), auto: true },
  'Upscale 1080p': { type: 'compare', a: v('v2-up1080-a.webp'), b: v('v2-up1080-b.webp'), videoA: v('v2-up1080-a.mp4'), videoB: v('v2-up1080-b.mp4'), legA: '480p flou', legB: 'SeedVR2 7B · 1080p' },
  'HDR Masters': { type: 'media', image: v('stage-b.webp'), puces: ['HLG', 'ProRes 4444', 'EXR ACEScg'] },
  'Green Screen': compareVideo('detour', 'Clip', 'Fond vert'),
  'Lip Sync': compareVideo('doublage', 'Voix d’origine', 'Nouvelle voix'),
  'Reframe': compareVideo('recadrer', '9:16', '16:9'),
  'Restore': { type: 'compare', a: v('restaurer-a2.webp'), b: v('restaurer-b2.webp'), videoA: v('restaurer-a2.mp4'), videoB: v('restaurer-b2.mp4'), auto: true, legA: 'Archive de 1951', legB: 'Restaurée et colorisée' },
  'Sketch to Video': { type: 'media', image: v('croquis.webp'), video: v('croquis.mp4'), auto: true },
  'ComfyUI Official Workflows': { type: 'media', image: v('v2-comfy.webp'), puces: ['262 workflows', 'Modèles manquants', 'Ouvrir dans ComfyUI'] },
  'Extensions': compare('extensions', 'Photo', 'Extension Illustration'),
  'Character': { type: 'media', image: v('v2-personnage.webp'), puces: ['4 visages', 'Planche', '12 images', 'LoRA'] },
  'Product Shot': { type: 'media', image: v('v2-pack.webp'), video: v('v2-pack.mp4'), auto: true, puces: ['Packshot', 'Mise en scène', 'Affiche', 'Personnage', 'Clip'] },
  'Social Check': { type: 'media', image: v('analyse.webp'), puces: ['Accroche 8/10', 'Sujet 9/10', 'Image 9/10', 'Histoire 7/10'] },
}

/** Réglages montrés par un aperçu : affichés sous l'image, jamais posés dessus. */
export const pucesDe = (a?: Apercu) => (a && a.type === 'media' ? a.puces ?? [] : [])

export function ApercuOutil({ apercu }: { apercu?: Apercu }) {
  const racine = useRef<HTMLSpanElement>(null)
  // toute vidéo d'aperçu joue en boucle dès qu'elle est à l'écran, sans attendre le survol
  const auto = !!apercu && (apercu.type === 'compare' ? !!(apercu.videoA || apercu.videoB) : !!apercu.video)
  useEffect(() => {
    const el = racine.current
    if (!auto || !el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const io = new IntersectionObserver(([e]) => {
      el.querySelectorAll('video').forEach(video => { if (e.isIntersecting) void video.play().catch(() => {}); else video.pause() })
    }, { rootMargin: '100px' })
    io.observe(el)
    return () => io.disconnect()
  }, [auto])
  if (!apercu) return null
  const videos = () => [...(racine.current?.querySelectorAll('video') ?? [])]
  const entrer = () => { if (!auto) videos().forEach(el => { el.currentTime = 0; void el.play().catch(() => {}) }) }
  const sortir = () => {
    if (!auto) videos().forEach(el => el.pause())
    racine.current?.style.setProperty('--coupe', '50%')
  }
  const suivre = (e: React.PointerEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--coupe', `${Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))}%`)
  }
  if (apercu.type === 'compare') return (
    <span ref={racine} className="apercu compare" onPointerEnter={entrer} onPointerMove={suivre} onPointerLeave={sortir}>
      <span className="couche">{apercu.videoB ? <video src={apercu.videoB} poster={apercu.b} muted loop playsInline preload="none" /> : <img src={apercu.b} alt="" loading="lazy" />}</span>
      <span className="couche dessus">{apercu.videoA ? <video src={apercu.videoA} poster={apercu.a} muted loop playsInline preload="none" /> : <img src={apercu.a} alt="" loading="lazy" />}</span>
      <span className="trait"><i>⇆</i></span>
      <em className="leg gauche">{t(apercu.legA)}</em>
      <em className="leg droite">{t(apercu.legB)}</em>
    </span>
  )
  return (
    <span ref={racine} className={`apercu ${apercu.onde ? 'onde' : ''}`} onPointerEnter={entrer} onPointerLeave={sortir}>
      {apercu.video ? <video src={apercu.video} poster={apercu.image} muted loop playsInline preload="none" /> : <img src={apercu.image} alt="" loading="lazy" />}
      {apercu.refs && <span className="refs">{apercu.refs.map(r => <img key={r} src={r} alt="" loading="lazy" />)}<small>{t('Image de référence')}</small></span>}
      {apercu.texte && <span className="prompt">{apercu.texte}</span>}
    </span>
  )
}
