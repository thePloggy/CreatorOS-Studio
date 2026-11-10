/* Gallery pages for one-step tools: video effects (Refine Details, Day to Night, Unblur, Remove
   Compression), Multi-Angle, Seamless Loop, Smooth Motion, Try-On, Photo Dump and Style Reference. Same layout as Dance: "How it works"
   on top, a large gallery (effects, your library clips or photos, your renders), a compact
   panel with numbered steps. Launching reuses the tool page config (CONFS): same calls, same
   parameters. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { t } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { Ic, failedJobs } from './bits'
import { useSuiviOutil } from './OutilPage'
import { CONFS, type IdOutil, type Valeurs } from './OutilsDedies'
import { ANGLES } from './Viewer'
import { posterOf, vignetteOf } from '../components/AssetMedia'
import { ActionPanneau, Aucun, BarreGalerie, Carte, EtapesPanneau, RendusGalerie, memoireReglages, useCarteAuCentre, useMouvementReduit, useSurvolPossible, type EtapePanneau } from './Galerie'
import { HowItWorks, howto } from './HowItWorks'
import { Pinceau } from '../components/Pinceau'
import { Masters } from './Masters'

/** Tools served by this page, and the "How it works" page of each. */
export const OUTILS_GALERIE: Partial<Record<IdOutil, Page>> = {}
type Page = string
const EFFETS: IdOutil[] = ['refine-details', 'day-to-night', 'deblur', 'decompression', 'colorize', 'restore-clip', 'water']
for (const e of EFFETS) OUTILS_GALERIE[e] = 'fx'
OUTILS_GALERIE['effets-video'] = 'fx'
OUTILS_GALERIE['multi-angle'] = 'angles'; OUTILS_GALERIE['loop'] = 'loop'; OUTILS_GALERIE['smooth'] = 'smooth'
OUTILS_GALERIE['try-on'] = 'tryon'; OUTILS_GALERIE['photodump'] = 'dump'; OUTILS_GALERIE['style-ref'] = 'sref'

/* The four video effects: real showcase renders (still image, clip on hover). */
const V = (n: string) => `/vitrine/${n}`
const APERCU_EFFET: Record<string, { fixe: string; video: string; avant: string; apres: string }> = {
  'refine-details': { fixe: V('v2-fx-fin.webp'), video: V('v2-fx-fin.mp4'), avant: 'Lisse', apres: 'Détaillé' },
  'day-to-night': { fixe: V('v2-fx-nuit-b.webp'), video: V('v2-fx-nuit-b.mp4'), avant: 'Jour', apres: 'Nuit' },
  'deblur': { fixe: V('v2-fx-net-b.webp'), video: V('v2-fx-net-b.mp4'), avant: 'Flou', apres: 'Net' },
  'decompression': { fixe: V('v2-fx-propre-b.webp'), video: V('v2-fx-propre-b.mp4'), avant: 'Compressé', apres: 'Nettoyé' },
  'colorize': { fixe: V('v2-fx-couleur.webp'), video: V('v2-fx-couleur.mp4'), avant: 'Noir et blanc', apres: 'Couleur' },
  'restore-clip': { fixe: V('v2-fx-restaure.webp'), video: V('v2-fx-restaure.mp4'), avant: 'Archive', apres: 'Restauré' },
  'water': { fixe: V('v2-fx-eau.webp'), video: V('v2-fx-eau.mp4'), avant: 'Sec', apres: 'Inondé' },
}
/* Video Effects: the page takes the title and showreel of the chosen effect. */
const HERO_EFFET: Partial<Record<IdOutil, string>> = {
  'refine-details': 'Plus de matière, le même mouvement', 'day-to-night': 'Le même plan, la nuit', 'deblur': 'Un plan flou redevient net',
  'decompression': 'Une vidéo propre, sans artefacts', 'colorize': 'Le noir et blanc retrouve ses couleurs', 'restore-clip': 'Une vieille vidéo, restaurée',
  'water': 'De l’eau dans ton plan',
}

/* For Seamless Loop: motions that return to their starting point, one click to reuse. */
const IDEES_BOUCLE = ['her hair moves in the wind', 'candles flicker softly', 'waves roll in and out', 'steam rises from the cup']
/* For Photo Dump: locations, one click to reuse. */
const IDEES_LIEU = ['in Tokyo', 'on a Greek island', 'in Paris in autumn', 'in New York', 'on a ski trip', 'in Bali']
/* For Style Reference: scenes to paint in the chosen style. */
const IDEES_SCENE = ['an old lighthouse keeper on wet rocks at dusk', 'a cyclist racing through a rainy neon street', 'a fox reading under a cherry tree',
  'a fishing village at sunrise', 'a girl and her dog on a rooftop at night', 'a busy market in the mountains']

type Onglet = 'effets' | 'biblio' | 'rendus'
type Reglages = { outil: IdOutil; assetId: string; v: Omit<Valeurs, 'second'> & { secondId?: string } }
/* Try-On: what a library click selects, the person or the garment. */
type Cible = 'personne' | 'vetement'

const PAGES: Record<string, { titre: string; texte: string; media: 'photo' | 'video'; cle: string; repli: string; label: string
  heroTitre: string; heroTexte: string; etapes: [string, string][] }> = {
  fx: { titre: 'Video Effects', texte: 'Un clip, un effet : plus de détail, la nuit, net ou sans artefacts, le mouvement ne change pas.', media: 'video',
    cle: 'fx', repli: V('v2-fx-nuit-b.webp'), label: 'Exemples d’effets vidéo',
    heroTitre: 'Le même clip, en mieux', heroTexte: 'Plus de détail, la nuit à la place du jour, un plan net ou propre : le cadrage et le mouvement restent.',
    etapes: [['Choisis ton clip', 'Un rendu du studio ou une vidéo de ta bibliothèque.'], ['Choisis l’effet', 'Chaque aperçu montre un vrai résultat.'], ['Reçois ton clip', 'Il arrive dans Rendus et dans ta bibliothèque.']] },
  angles: { titre: 'Multi-Angle', texte: 'La même photo vue d’un autre angle : ¾, profil, plongée, contre-plongée, plan large.', media: 'photo',
    cle: 'angles', repli: V('v2-vespa-b.webp'), label: 'Exemples d’angles',
    heroTitre: 'La même scène, vue d’un autre angle', heroTexte: 'Trois-quarts, profil, de dos, plongée ou gros plan : même personne, même lieu, autre caméra.',
    etapes: [['Choisis ta photo', 'Une personne ou un objet bien visible, pris dans ta bibliothèque.'], ['Choisis l’angle', 'Huit angles de caméra, du plan large au gros plan.'], ['Reçois ta photo', 'Elle arrive dans Rendus et dans ta bibliothèque, prête à animer.']] },
  loop: { titre: 'Seamless Loop', texte: 'Un clip qui revient à son image de départ : il tourne en boucle sans raccord.', media: 'photo',
    cle: 'loop', repli: V('v2-cine-w.webp'), label: 'Exemples de boucles',
    heroTitre: 'Une photo qui tourne en boucle, sans raccord', heroTexte: 'Cheveux au vent, flammes, vagues : le clip revient à sa première image et repart sans coupure.',
    etapes: [['Choisis ta photo', 'Elle sert de première et de dernière image.'], ['Décris le mouvement', 'Un mouvement qui peut revenir à son point de départ, en anglais.'], ['Reçois ta boucle', 'Elle arrive dans Rendus et dans ta bibliothèque, prête à publier.']] },
  smooth: { titre: 'Smooth Motion', texte: 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.', media: 'video',
    cle: 'smooth', repli: V('v2-smooth.webp'), label: 'Exemple de mouvement fluidifié',
    heroTitre: 'Un mouvement deux fois plus fluide', heroTexte: 'RIFE invente l’image entre deux images : même durée, deux fois plus d’images, plus de saccades.',
    etapes: [['Choisis ton clip', 'Un clip à 24 images par seconde ou moins, pris dans ta bibliothèque.'], ['Reçois ton clip', 'Même plan, à 48 images par seconde, dans Rendus et ta bibliothèque.']] },
  tryon: { titre: 'Try-On', texte: 'La personne d’une photo porte le vêtement d’une autre photo : même visage, même pose, même décor.', media: 'photo',
    cle: 'tryon', repli: V('look-b.webp'), label: 'Exemple d’essayage',
    heroTitre: 'Ta personne porte le vêtement d’une autre photo', heroTexte: 'Une photo de la personne, une photo du vêtement seul : couleur, tissu et coupe sont repris, le visage, la pose et le décor restent.',
    etapes: [['Choisis la personne', 'Une photo de ta bibliothèque où la tenue se voit bien.'], ['Choisis le vêtement', 'Le vêtement seul, à plat ou sur cintre, bien éclairé.'], ['Récupère la photo', 'Elle arrive dans Rendus et dans ta bibliothèque.']] },
  dump: { titre: 'Photo Dump', texte: 'Quatre photos du quotidien de la même personne, d’après une seule photo : rue, café, bord de l’eau, selfie.', media: 'photo',
    cle: 'dump', repli: V('look-a.webp'), label: 'Exemple de photo dump',
    heroTitre: 'Une photo, quatre moments de la même journée', heroTexte: 'Rue, café, bord de l’eau, selfie : même personne, même tenue, dans le lieu de ton choix.',
    etapes: [['Choisis une photo', 'Le visage et la tenue bien visibles.'], ['Choisis un lieu (facultatif)', 'Une ville, une île, une saison, ou rien : le studio choisit.'], ['Reçois quatre photos', 'Elles arrivent ensemble dans Rendus et dans ta bibliothèque.']] },
  sref: { titre: 'Style Reference', texte: 'Une image donne le style (trait, palette, matière), ton texte donne la scène : une image neuve, peinte dans ce style.', media: 'photo',
    cle: 'sref', repli: V('look-a.webp'), label: 'Exemple de référence de style',
    heroTitre: 'Le style d’une image, ta scène à toi', heroTexte: 'Trait, palette et matière viennent de l’image choisie ; ce qui s’y passe vient de ton texte.',
    etapes: [['Choisis une image de style', 'Une illustration, une peinture, une BD : seul son style compte.'], ['Décris la scène', 'En anglais : qui, où, quoi, quelle lumière.'], ['Récupère l’image', 'Elle arrive dans Rendus et dans ta bibliothèque.']] },
}

/* The other one-step tools: same layout, settings taken from their config (CONFS). */
const GENERIQUES: Partial<Record<IdOutil, { heroTitre: string; heroTexte: string; repli: string; label: string }>> = {
  'inpaint': { heroTitre: 'Change une zone, garde tout le reste', heroTexte: 'Peins la zone au pinceau et décris ce qui doit y apparaître : le reste de la photo ne bouge pas.', repli: V('look-a.webp'), label: 'Exemple de retouche d’une zone' },
  'remove-bg': { heroTitre: 'Le sujet, sans le fond', heroTexte: 'SAM3 découpe la personne ou l’objet : un PNG transparent, prêt pour une affiche ou un montage.', repli: V('look-a.webp'), label: 'Exemple de fond retiré' },
  'depth': { heroTitre: 'Le relief de ta photo, en une image', heroTexte: 'Proche en clair, loin en sombre : pour le flou de profondeur, le relief ou un ControlNet.', repli: V('look-a.webp'), label: 'Exemple de carte de profondeur' },
  'retouch': { heroTitre: 'Change un élément du clip, le reste ne bouge pas', heroTexte: 'Peins la zone sur la première image : elle est suivie sur tout le clip et remplacée par ce que tu décris.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple de retouche vidéo' },
  'remove-objects': { heroTitre: 'Retire ce qui gêne, le décor revient', heroTexte: 'Une personne, une voiture, un passant : le studio l’efface et reconstruit le décor derrière, sur tout le plan.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple d’objet retiré' },
  'change-bg': { heroTitre: 'Même sujet, autre décor', heroTexte: 'Ta personne et son geste restent : le lieu autour change, avec sa lumière.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple de décor changé' },
  'upscale': { heroTitre: 'La même photo, en haute définition', heroTexte: 'SeedVR2 resserre les détails sans rien inventer : peau, tissu et lumière restent fidèles.', repli: V('look-a.webp'), label: 'Exemple de photo agrandie' },
  'upscale-1080': { heroTitre: 'Ton clip en 1080p', heroTexte: 'SeedVR2 monte le clip en Full HD sans le redessiner : même plan, plus de définition.', repli: V('v2-fx-fin.webp'), label: 'Exemple de clip en 1080p' },
  'green-screen': { heroTitre: 'Le sujet détouré, image par image', heroTexte: 'Fond vert pour le montage ou WebM transparent : SAM3 suit le sujet, rien n’est redessiné.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple de détourage' },
  'add-sound': { heroTitre: 'Un clip muet trouve son son', heroTexte: 'Vagues, pas, moteur, rumeur de rue : le son est généré d’après l’image, calé sur ce qui s’y passe.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple de son ajouté' },
  'coverage': { heroTitre: 'Trois plans de ta scène en un clic', heroTexte: 'Plan large, trois-quarts et serré : de quoi monter une séquence à partir d’une seule photo.', repli: V('v2-vespa-b.webp'), label: 'Exemple de couverture d’une scène' },
  'next-shot': { heroTitre: 'Le plan d’après', heroTexte: 'Le studio lit ta photo et imagine la suite : même personne, même lieu, quelques secondes plus tard.', repli: V('v2-vespa-b.webp'), label: 'Exemple de plan suivant' },
  'image-3d': { heroTitre: 'Une photo devient un objet 3D', heroTexte: 'TRELLIS.2 en une minute : un modèle à faire tourner, à télécharger ou à poser dans la scène 3D.', repli: V('look-a.webp'), label: 'Exemple de modèle 3D' },
  'hdr': { heroTitre: 'Des masters pour l’étalonnage et les écrans HDR', heroTexte: 'HLG, ProRes, EXR ACEScg : avec une vraie expansion des hautes lumières, pas un simple changement de conteneur.', repli: V('v2-fx-nuit-b.webp'), label: 'Exemple de master HDR' },
}
for (const [id, g] of Object.entries(GENERIQUES) as [IdOutil, NonNullable<(typeof GENERIQUES)[IdOutil]>][]) {
  const c = CONFS[id]
  OUTILS_GALERIE[id] = id
  PAGES[id] = { titre: c.titre, texte: c.texte, media: c.media === 'video' ? 'video' : 'photo', cle: id, repli: g.repli, label: g.label,
    heroTitre: g.heroTitre, heroTexte: g.heroTexte, etapes: c.etapes.map(e => [e.titre, e.texte] as [string, string]) }
}

const court = (a: Asset) => { const p = a.provenance?.userPrompt || a.provenance?.composedPositive; return p ? p.replace(/\s+/g, ' ').slice(0, 60) : '' }

export function OutilGalerie({ id, onOpen }: { id: IdOutil; onOpen: (a: Asset, list: Asset[]) => void }) {
  const page = OUTILS_GALERIE[id]!
  const P0 = PAGES[page]
  const s = useAppStore()
  const reduit = useMouvementReduit()
  const survolPossible = useSurvolPossible()
  const outilsPage = page === 'fx' ? EFFETS : [id]
  // one tracker per tool (same as its tool page); history stays shared
  const o = (i: number) => `dedie-${outilsPage[i] ?? outilsPage[0]}`
  const suivis = [useSuiviOutil(o(0)), useSuiviOutil(o(1)), useSuiviOutil(o(2)), useSuiviOutil(o(3)), useSuiviOutil(o(4)), useSuiviOutil(o(5)), useSuiviOutil(o(6)), useSuiviOutil(o(7))]
  const memoire = useMemo(() => memoireReglages<Reglages>(`galerie:${page}:reglages`), [page])
  // from the "Video Effects" entry: no effect preselected
  const depart: IdOutil = id === 'effets-video' ? 'refine-details' : id
  const [outil, setOutil] = useState<IdOutil>(depart)
  const c = CONFS[outil]
  const [peindre, setPeindre] = useState(false)
  const [onglet, setOnglet] = useState<Onglet>(page === 'fx' ? 'effets' : 'biblio')
  const [source, setSource] = useState<Asset | null>(null)
  const [cible, setCible] = useState<Cible>('personne')
  const [v, setV] = useState<Valeurs>({ texte: '', texte2: '', alpha: false, choix: CONFS[depart].choix?.options[0]?.id ?? '' })
  // opened from the menu via a specific effect: it is preselected
  const [choixFait, setChoixFait] = useState(page === 'fx' && id !== 'effets-video')
  // Video Effects: title, text and showreel of the chosen effect
  const P = page === 'fx' && choixFait ? { ...P0, titre: CONFS[outil].titre, texte: CONFS[outil].texte, cle: `fx-${outil}`, repli: APERCU_EFFET[outil]?.fixe ?? P0.repli,
    heroTitre: HERO_EFFET[outil] ?? P0.heroTitre, heroTexte: CONFS[outil].texte } : P0
  const [options, setOptions] = useState(false)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [recherche, setRecherche] = useState('')
  const [reglages, setReglages] = useState(memoire.lire)
  const [appel, setAppel] = useState(false)
  const galerie = useRef<HTMLElement | null>(null)
  const ancre = useRef<HTMLDivElement | null>(null)
  const panneau = useRef<HTMLElement | null>(null)
  const champ = useRef<HTMLTextAreaElement | null>(null)

  const changerOnglet = (o: Onglet) => {
    setOnglet(o); setRecherche('')
    const g = galerie.current; const haut = o === 'rendus' ? 0 : ancre.current?.offsetTop ?? 0
    if (g && g.scrollTop > haut) g.scrollTo({ top: haut })
  }
  const commencer = () => {
    ancre.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' })
    const cible = panneau.current?.querySelector<HTMLElement>('.dz-etape.prochaine') ?? panneau.current?.querySelector<HTMLElement>('.dz-action .cta:not(:disabled)')
    cible?.focus({ preventScroll: true })
    setAppel(true); window.setTimeout(() => setAppel(false), 1600)
  }

  const lancer = async (r: Reglages) => {
    const a = s.assets.find(x => x.id === r.assetId) ?? source
    const conf = CONFS[r.outil]
    const second = r.v.secondId ? s.assets.find(x => x.id === r.v.secondId) ?? (v.second?.id === r.v.secondId ? v.second : undefined) : undefined
    if (a && conf.pinceau) { setSource(a); setPeindre(true); return }
    if (!a || !conf.lancer || (conf.second && !second)) return
    setOccupe(true); setMsg(null)
    try {
      const job = await conf.lancer(a, { ...r.v, second })
      if (job) {
        suivis[Math.max(0, outilsPage.indexOf(r.outil))].ajouter([job]); void s.adoptServerJob(job)
        memoire.noter(job, r); setReglages(memoire.lire())
      }
      changerOnglet('rendus')
    } catch (e) { setMsg(String((e as Error).message || e)) }
    setOccupe(false)
  }

  // the page's renders: tracked from this browser, or carrying the tool's prefix
  const prefixes = outilsPage.flatMap(o => CONFS[o].prefixes ?? [])
  const dejaVu = (jobId: string) => suivis.some(x => x.ids.has(jobId)) || prefixes.some(p => jobId.startsWith(p))
  const enCours = s.jobs.filter(j => dejaVu(j.id) && STATUTS_ACTIFS.includes(j.status))
  const echecs = failedJobs(s.jobs, P.media === 'video' || page === 'loop').filter(j => dejaVu(j.id))
  const livres = s.assets.filter(a => a.jobId && dejaVu(String(a.jobId))).slice(0, 60)
  const photos = P.media === 'photo'

  // the library: your clips or photos, newest first
  const q = recherche.trim().toLowerCase()
  // whole library (search covers everything); cards load in batches of 160 while scrolling
  const biblio = useMemo(() => s.assets.filter(a => a.mediaType === P.media && !a.modele3d && a.reviewStatus !== 'rejected')
    .sort((x, y) => y.createdAt - x.createdAt), [s.assets, P.media])
  const [nbBiblio, setNbBiblio] = useState(160)
  const biblioFiltree = biblio.filter(a => !q || court(a).toLowerCase().includes(q))
  const biblioVue = biblioFiltree.slice(0, nbBiblio)
  const suite = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = suite.current
    if (!el || biblioVue.length >= biblioFiltree.length) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNbBiblio(n => n + 160) }, { root: galerie.current, rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [biblioVue.length, biblioFiltree.length])
  const centre = useCarteAuCentre(!survolPossible && !reduit && onglet !== 'rendus', [onglet, q, biblio.length])

  const angle = ANGLES.find(x => x.id === v.choix)
  const texteRequis = !!c.champ?.requis
  const tryon = page === 'tryon'
  const pret = !!source && (!texteRequis || !!v.texte.trim()) && (page !== 'fx' || choixFait) && (!tryon || !!v.second) && !occupe && (!!c.lancer || !!c.pinceau)
  const manque = !source ? (tryon ? t('Choisis d’abord la personne dans ta bibliothèque.') : page === 'sref' ? t('Choisis d’abord une image de style dans ta bibliothèque.') : P.media === 'video' ? t('Choisis d’abord un clip de ta bibliothèque.') : t('Choisis d’abord une photo de ta bibliothèque.'))
    : tryon && !v.second ? t('Choisis maintenant le vêtement seul.')
    : page === 'fx' && !choixFait ? t('Choisis un effet dans la galerie.')
    : texteRequis && !v.texte.trim() ? (page === 'sref' ? t('Décris la scène, en anglais.') : page === 'loop' ? t('Décris le mouvement, en anglais.') : t(c.champ!.label)) : null
  const prochaine = !source ? 1 : (page === 'fx' && !choixFait) || (texteRequis && !v.texte.trim()) || (tryon && !v.second) ? 2 : 0
  // the hero follows the chosen effect; step videos are the page's own
  const fichiers = { hero: howto(P.cle).hero, etape: howto(P0.cle).etape }
  const libelleBiblio = P.media === 'video' ? t('Tes clips') : t('Tes photos')

  const etapes: EtapePanneau[] = [tryon
    ? { n: 1, label: t('La personne'), valeur: source ? t('Personne choisie') : t('Choisir la personne'), fait: !!source, icone: 'user',
        vignette: source ? vignetteOf(source) : undefined, ouvrir: () => { setCible('personne'); changerOnglet('biblio') }, courant: onglet === 'biblio' && cible === 'personne' }
    : page === 'sref'
    ? { n: 1, label: t('Style'), valeur: source ? t('Image de style choisie') : t('Choisir l’image de style'), fait: !!source, icone: 'image',
        vignette: source ? vignetteOf(source) : undefined, ouvrir: () => changerOnglet('biblio'), courant: onglet === 'biblio' }
    : { n: 1, label: P.media === 'video' ? t('Clip') : t('Photo'), valeur: source ? (P.media === 'video' ? t('Clip choisi') : t('Photo choisie')) : P.media === 'video' ? t('Choisir un clip') : t('Choisir une photo'),
      fait: !!source, icone: P.media === 'video' ? 'play' : 'image', vignette: source ? (P.media === 'video' ? posterOf(source) : vignetteOf(source)) : undefined,
      ouvrir: () => changerOnglet('biblio'), courant: onglet === 'biblio' },
  ]
  if (tryon) etapes.push({ n: 2, label: t('Le vêtement'), valeur: v.second ? t('Vêtement choisi') : t('Choisir le vêtement'), fait: !!v.second, icone: 'image',
    vignette: v.second ? vignetteOf(v.second) : undefined, ouvrir: () => { setCible('vetement'); changerOnglet('biblio') }, courant: onglet === 'biblio' && cible === 'vetement' })
  if (page === 'sref') etapes.push({ n: 2, label: t('Scène'), valeur: v.texte.trim() || t('Décrire la scène'), fait: !!v.texte.trim(), icone: 'edit',
    ouvrir: () => { setOptions(true); window.setTimeout(() => champ.current?.focus(), 0) } })
  if (page === 'dump') etapes.push({ n: 2, label: t('Lieu'), valeur: v.texte.trim() || t('Au choix du studio'), fait: !!v.texte.trim(), icone: 'camera',
    ouvrir: () => { setOptions(true); window.setTimeout(() => champ.current?.focus(), 0) } })
  if (page === 'fx') etapes.push({ n: 2, label: t('Effet'), valeur: choixFait ? CONFS[outil].titre : t('Choisir un effet'), fait: choixFait, icone: 'grid',
    vignette: choixFait ? APERCU_EFFET[outil].fixe : undefined, ouvrir: () => changerOnglet('effets'), courant: onglet === 'effets' })
  if (page === 'angles') etapes.push({ n: 2, label: t('Angle'), valeur: angle ? t(angle.label) : t('Choisir un angle'), fait: !!angle, icone: 'camera',
    ouvrir: () => { setOptions(true); panneau.current?.querySelector<HTMLElement>('.dz-segments button[aria-pressed="true"]')?.focus() } })
  if (GENERIQUES[outil] && c.pinceau) etapes.push({ n: 2, label: t('Zone'), valeur: t('Peindre au pinceau'), fait: false, icone: 'edit',
    ouvrir: () => { if (source) setPeindre(true) } })
  else if (GENERIQUES[outil] && (c.champ || c.choix || c.alpha)) etapes.push({ n: 2, label: t('Réglage'),
    valeur: v.texte.trim() || (c.choix ? t(c.choix.options.find(x => x.id === v.choix)?.label ?? '') : c.alpha ? (v.alpha ? t('Transparent (WebM)') : t('Fond vert')) : c.champ?.requis ? t(c.champ.label) : t('Facultatif')),
    fait: !!v.texte.trim() || !!c.choix || (!!c.alpha && !c.champ), icone: 'edit',
    ouvrir: () => { setOptions(true); window.setTimeout(() => champ.current?.focus(), 0) } })
  if (page === 'loop') etapes.push({ n: 2, label: t('Mouvement'), valeur: v.texte.trim() || t('Décrire le mouvement'), fait: !!v.texte.trim(), icone: 'play',
    ouvrir: () => { setOptions(true); window.setTimeout(() => champ.current?.focus(), 0) } })

  const choisirSource = (a: Asset) => {
    if (tryon) {
      // the same photo cannot fill both roles
      if (cible === 'vetement') { if (a.id === source?.id) return; setV({ ...v, second: a }); if (!source) setCible('personne'); return }
      if (a.id === v.second?.id) return
      setSource(a); if (!v.second) setCible('vetement')
      return
    }
    setSource(a); if (page === 'fx' && !choixFait) changerOnglet('effets')
  }

  return (
    <div className="dz">
      <aside ref={panneau} className={`dz-panneau ${options ? 'options-ouvertes' : ''} ${appel ? 'appel' : ''}`} aria-label={P.titre}>
        <header className="dz-tete">
          <h2 className="titre-outil">{P.titre}</h2>
          <p>{t(P.texte)}</p>
        </header>

        <EtapesPanneau etapes={etapes} prochaine={prochaine} />

        <div className="dz-apercu dz-apercu-source">
          <figure>
            {source
              ? (P.media === 'video'
                  ? <video key={source.id} src={source.uri} poster={posterOf(source)} muted loop playsInline {...(reduit ? { controls: true, preload: 'none' } : { autoPlay: true })} />
                  : <img key={source.id} src={vignetteOf(source)} alt="" />)
              : <button type="button" className="dz-apercu-vide" onClick={() => { setCible('personne'); changerOnglet('biblio') }}><span className="vide-icone"><Ic n={tryon ? 'user' : P.media === 'video' ? 'play' : 'image'} s={22} /></span>{tryon ? t('Choisir la personne') : page === 'sref' ? t('Choisir l’image de style') : P.media === 'video' ? t('Choisir un clip') : t('Choisir une photo')}</button>}
            <figcaption>{tryon ? t('La personne') : page === 'sref' ? t('Le style') : P.media === 'video' ? t('Ton clip') : t('Ta photo')}</figcaption>
          </figure>
          {tryon && (
            <figure>
              {v.second
                ? <img key={v.second.id} src={vignetteOf(v.second)} alt="" />
                : <button type="button" className="dz-apercu-vide" onClick={() => { setCible('vetement'); changerOnglet('biblio') }}><span className="vide-icone"><Ic n="image" s={22} /></span>{t('Choisir le vêtement')}</button>}
              <figcaption>{t('Le vêtement')}</figcaption>
            </figure>
          )}
        </div>

        {outil === 'hdr' && source && <div className="dz-options"><Masters asset={source} /></div>}

        {(c.champ || c.choix || c.alpha) && (
          <div className="dz-options" id={`galerie-${page}-options`}>
            {c.choix && (
              <div className="dz-champ">
                <span>{t(c.choix.label)}</span>
                <div className="dz-segments" role="group" aria-label={t(c.choix.label)}>
                  {c.choix.options.map(o => <button key={o.id} type="button" aria-pressed={v.choix === o.id} className={v.choix === o.id ? 'on' : ''} onClick={() => setV({ ...v, choix: o.id })}>{t(o.label)}</button>)}
                </div>
              </div>
            )}
            {c.champ && (
              <label className="dz-champ">
                <span>{t(c.champ.label)}</span>
                <textarea ref={champ} rows={2} value={v.texte} maxLength={300} placeholder={c.champ.placeholder} onChange={e => setV({ ...v, texte: e.target.value })} />
              </label>
            )}
            {c.champ2 && (
              <label className="dz-champ">
                <span>{t(c.champ2.label)}</span>
                <textarea rows={2} value={v.texte2} maxLength={300} placeholder={c.champ2.placeholder} onChange={e => setV({ ...v, texte2: e.target.value })} />
              </label>
            )}
            {c.alpha && (
              <div className="dz-champ">
                <span>{t('Sortie')}</span>
                <div className="dz-segments" role="group" aria-label={t('Sortie')}>
                  <button type="button" aria-pressed={!v.alpha} className={!v.alpha ? 'on' : ''} onClick={() => setV({ ...v, alpha: false })}>{t('Fond vert')}</button>
                  <button type="button" aria-pressed={v.alpha} className={v.alpha ? 'on' : ''} onClick={() => setV({ ...v, alpha: true })}>{t('Transparent (WebM)')}</button>
                </div>
              </div>
            )}
            {(page === 'loop' || page === 'dump' || page === 'sref') && (
              <div className="dz-idees" role="group" aria-label={page === 'dump' ? t('Idées de lieux') : page === 'sref' ? t('Idées de scène') : t('Idées de mouvement')}>
                {(page === 'dump' ? IDEES_LIEU : page === 'sref' ? IDEES_SCENE : IDEES_BOUCLE).map(i => <button key={i} type="button" aria-pressed={v.texte === i} className={v.texte === i ? 'on' : ''}
                  onClick={() => setV({ ...v, texte: page === 'dump' && v.texte === i ? '' : i })}>{i}</button>)}
              </div>
            )}
          </div>
        )}

        {outil !== 'hdr' && <ActionPanneau id={`galerie-${page}`} nbEnCours={enCours.length} onVoirRendus={onglet !== 'rendus' ? () => changerOnglet('rendus') : undefined}
          options={options} onOptions={() => setOptions(o => !o)} avecOptions={!!(c.champ || c.choix || c.alpha)} pret={pret}
          onLancer={() => { if (source) { const { second, ...reste } = v; void lancer({ outil, assetId: source.id, v: { ...reste, secondId: second?.id } }) } }}
          label={occupe ? t('Envoi…') : page === 'fx' && !choixFait ? t('Appliquer l’effet') : t(c.bouton)} manque={manque} msg={msg} />}
      </aside>

      <section className="dz-galerie" ref={galerie} aria-label={t('Galerie')}>
        {onglet !== 'rendus' && (
          <HowItWorks cleMemoire={`hiw:${P.cle}`} reduit={reduit} onCommencer={commencer}
            hero={{ ...fichiers.hero, repli: P.repli }} labelHero={t(P.label)} titre={t(P.heroTitre)} texte={t(P.heroTexte)}
            etapes={P.etapes.map(([ti, te], i) => ({ titre: t(ti), texte: t(te), ...(i === P.etapes.length - 1 ? { ...fichiers.hero, repli: P.repli } : fichiers.etape(i + 1)) }))} />
        )}
        <div ref={ancre} className="dz-ancre" aria-hidden />
        <BarreGalerie<Onglet> onglet={onglet} onOnglet={changerOnglet}
          onglets={[
            ...(page === 'fx' ? [{ cle: 'effets' as const, label: t('Effets'), n: EFFETS.length }] : []),
            { cle: 'biblio', label: libelleBiblio, n: biblio.length },
            { cle: 'rendus', label: t('Rendus'), n: livres.length + enCours.length, enCours: enCours.length },
          ]}
          recherche={recherche} onRecherche={onglet === 'biblio' ? setRecherche : undefined}
          placeholder={P.media === 'video' ? t('Chercher un clip') : t('Chercher une photo')} />

        {onglet === 'effets' ? (
          <div className="dz-grille dz-grille-paysage" ref={centre.racine}>
            {EFFETS.map(e => {
              const ap = APERCU_EFFET[e]
              return <Carte key={e} cle={e} titre={CONFS[e].titre} detail={`${t(ap.avant)} → ${t(ap.apres)}`} fixe={ap.fixe} video={ap.video} paysage
                choisie={choixFait && outil === e} auCentre={centre.cle === e} survolPossible={survolPossible} reduit={reduit}
                onChoisir={() => { setOutil(e); setChoixFait(true) }} />
            })}
          </div>
        ) : onglet === 'biblio' ? (
          <>
          {tryon && (
            <div className="dz-cible" role="group" aria-label={t('Tu choisis')}>
              {(['personne', 'vetement'] as const).map((k, i) => {
                const choix = k === 'personne' ? source : v.second
                return (
                  <button key={k} type="button" aria-pressed={cible === k} className={cible === k ? 'on' : ''} onClick={() => setCible(k)}>
                    <span className="dz-cible-vignette">{choix ? <img src={vignetteOf(choix)} alt="" /> : <i>{i + 1}</i>}</span>
                    <span><small>{t('Étape {n}', { n: i + 1 })}</small><b>{k === 'personne' ? t('La personne') : t('Le vêtement')}</b></span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="dz-grille" ref={centre.racine}>
            {biblioVue.map(a => {
              const estPersonne = source?.id === a.id; const estVetement = tryon && v.second?.id === a.id
              return (
                <Carte key={a.id} cle={a.id} titre={court(a) || (P.media === 'video' ? t('Vidéo') : t('Photo'))} sansLegende classe={estVetement ? 'second' : tryon && estPersonne ? 'premier' : undefined}
                  fixe={P.media === 'video' ? (posterOf(a) ?? vignetteOf(a)) : vignetteOf(a)} video={P.media === 'video' ? a.uri : undefined}
                  badge={tryon && (estPersonne || estVetement) ? (estVetement ? t('Vêtement') : t('La personne')) : undefined}
                  choisie={estPersonne || estVetement} auCentre={centre.cle === a.id} survolPossible={survolPossible} reduit={reduit} onChoisir={() => choisirSource(a)} />
              )
            })}
            {biblio.length === 0
              ? <div className="dz-etat dz-etat-grille"><b>{P.media === 'video' ? t('Aucun clip dans ta bibliothèque pour l’instant.') : t('Aucune photo dans ta bibliothèque pour l’instant.')}</b></div>
              : biblioVue.length === 0 && <Aucun onEffacer={() => setRecherche('')} texte={t('Rien ne correspond.')} />}
          </div>
          {biblioVue.length < biblioFiltree.length && <div ref={suite} className="dz-suite" aria-hidden />}
          </>
        ) : (
          <RendusGalerie photo={photos} enCours={enCours} echecs={echecs} livres={livres} onOpen={onOpen}
            legende={a => { const r = reglages[String(a.jobId)]; const o = r ? CONFS[r.outil] : CONFS[depart]
              const an = r && page === 'angles' ? ANGLES.find(x => x.id === r.v.choix) : undefined
              return { titre: o.titre, detail: an ? t(an.label) : r && page === 'sref' ? `${r.v.choix} · ${r.v.texte.trim()}` : r && (page === 'dump' || page === 'tryon') && r.v.texte.trim() ? r.v.texte.trim() : undefined } }}
            gestes={a => { const r = reglages[String(a.jobId)]; return r ? <button type="button" className="pill" disabled={occupe} onClick={() => void lancer(r)}><Ic n="refresh" s={13} />{t('Refaire')}</button> : null }}
            vide={<div className="dz-etat"><b>{t('Tes rendus apparaîtront ici.')}</b>
              <button type="button" className="pill" onClick={() => changerOnglet(page === 'fx' ? 'effets' : 'biblio')}>{page === 'fx' ? t('Choisir un effet') : libelleBiblio}</button></div>} />
        )}
      </section>
      {peindre && source && <Pinceau asset={source} onClose={() => setPeindre(false)} />}
    </div>
  )
}
