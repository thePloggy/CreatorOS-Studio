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
export const BANDEAU_REEL = anime('reel-w', { texte: 'Sunday morning at a flower market' })
const compareVideo = (nom: string, legA: string, legB: string): Apercu => ({ ...compare(nom, legA, legB), videoA: v(`${nom}-a.mp4`), videoB: v(`${nom}-b.mp4`), auto: true } as Apercu)

export const BANDEAU_CAMERA = anime('camera-w', { puces: ['Orbite', 'Dolly zoom', 'Crash zoom', 'Drone', 'Arc', 'Bullet time'], auto: true })

/** Clé : le libellé de l'outil dans GROUPES. */
export const APERCUS: Record<string, Apercu> = {
  'One-click Reel': { type: 'media', image: v('reel.webp'), texte: 'Sunday morning at a flower market' },
  'Text to Image': { type: 'media', image: v('photo.webp'), refs: [v('ref.webp')] },
  'Image to Video': { type: 'media', image: v('video-a.webp'), video: v('video-b.mp4'), puces: ['Photo → clip'] },
  'Text to Video': anime('texte', { texte: 'Rain on a quiet Lisbon street at dusk, slow push-in' }),
  'Talking Avatar': anime('avatar', { texte: 'Are you ready to run!' }),
  'Voice-over': { type: 'media', image: v('onde.webp'), onde: true, texte: 'Welcome to the studio' },
  'Music & Sound Effects': { type: 'media', image: v('onde.webp'), onde: true, texte: 'warm lo-fi hip hop, soft piano' },
  'Stage': { ...compare('stage', 'Maquette 3D', 'Rendu final') },
  'Cinema Studio': { type: 'media', image: v('cine.webp'), puces: ['50 mm', 'f/2.8', 'Heure dorée'] },
  'Camera Moves': anime('camera', { auto: true }),
  'Effects': anime('camera', { auto: true }),
  'Re-shoot': compareVideo('reshoot', 'Plan d’origine', 'Caméra qui tourne'),
  'Swap': compareVideo('mix', 'Original', 'Personnages échangés'),
  'Motion Control': compareVideo('move', 'Vidéo d’origine', 'Geste repris'),
  'Image to 3D': { ...compare('objet', 'Photo', 'Modèle 3D'), videoB: v('objet-b.mp4') } as Apercu,
  'Retouch': compareVideo('retouche', 'Avant', 'Objet posé'),
  'Multi-Angle, Styles & Relight': compare('look', 'Photo', 'Figurine'),
  'Editor': { type: 'media', image: v('montage.webp') },
  'Upscale 1080p': compare('nette', 'Clip d’origine', 'SeedVR2'),
  'HDR Masters': { type: 'media', image: v('stage-b.webp'), puces: ['HLG', 'ProRes 4444', 'EXR ACEScg'] },
  'Green Screen': compareVideo('detour', 'Clip', 'Fond vert'),
  'Lip Sync': compareVideo('doublage', 'Voix d’origine', 'Nouvelle voix'),
  'Extend': compareVideo('recadrer', '9:16', '16:9'),
  'Restore': compare('restaurer', 'Photo d’origine', 'Restaurée et colorisée'),
  'Sketch to Video': { type: 'media', image: v('croquis.webp'), video: v('croquis.mp4'), auto: true },
  'Extensions': compare('extensions', 'Photo', 'Extension Illustration'),
  'Character': { type: 'media', image: v('personnage.webp'), puces: ['4 visages', 'Planche', '12 images', 'LoRA'] },
  'Product Shot': { type: 'media', image: v('pack.webp'), puces: ['Packshot', 'Mise en scène', 'Affiche', 'Personnage', 'Clip'] },
  'Social Check': { type: 'media', image: v('analyse.webp'), puces: ['Accroche 8/10', 'Sujet 9/10', 'Image 9/10', 'Histoire 7/10'] },
}

/** Réglages montrés par un aperçu : affichés sous l'image, jamais posés dessus. */
export const pucesDe = (a?: Apercu) => (a && a.type === 'media' ? a.puces ?? [] : [])

export function ApercuOutil({ apercu }: { apercu?: Apercu }) {
  const racine = useRef<HTMLSpanElement>(null)
  const auto = !!apercu?.auto
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
