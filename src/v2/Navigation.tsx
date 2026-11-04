/* ============================================================
   Navigation : trois familles, Image, Vidéo, Audio (plus les extensions).
   Chaque famille ouvre un grand menu en colonnes (créer, modifier, réaliser,
   finir) avec une vignette par outil, et la colonne des modèles employés. Un outil
   qui part d'un média existant ouvre le choix dans la bibliothèque, puis la
   visionneuse où se trouve son bouton.
   ============================================================ */
import type { IdOutil } from './OutilsDedies'
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'
import { Pastille } from './bits'
import { FramePicker } from './popups'
import { APERCUS } from './Apercus'

export type Section = 'croquis' | 'accueil' | 'image' | 'cinema' | 'reshoot' | 'video' | 'reel' | 'presets' | 'parole' | 'montage' | 'assets' | 'persona' | 'config' | 'createur' | 'extensions' | 'pub' | 'recadrer' | 'doublage' | 'analyse' | 'nouveau-personnage' | 'restaurer' | 'styles' | 'relight' | 'expand' | 'outil' | 'carrousel'
/** L'outil à ouvrir dans la visionneuse une fois le média choisi. */
export type ActionOutil = 'objet3d' | 'retouche' | 'looks' | 'nette' | 'master' | 'detour' | 'recadrer' | 'doubler' | 'analyse' | 'profondeur'
  | 'transparent' | 'pinceau' | 'coverage' | 'suivant' | 'boucle' | 'son' | 'fluide' | 'retirer' | 'fond'
export type Outil = { label: string; texte: string; pastille?: 'new' | 'top' } & (
  { section: Section; dedie?: IdOutil; tache?: 'creer' | 'texte' | 'move' | 'mix' | 'etendre' | 'musiques' | 'camera' | 'effets' | 'comfy' | 'edition' | 'hd' | 'cloner' | 'changer' } | { stage: true } | { depuis: 'photo' | 'video'; titre: string; action: ActionOutil })

/** Une famille d'outils de la barre du haut : des colonnes de sous-menus et les modèles qui les portent. */
export type Menu = { titre: string; colonnes: { titre: string; outils: Outil[] }[]; modeles: [string, string, 'h3'?][]; defaut?: string }

export const MENUS: Menu[] = [
  { titre: 'Image', defaut: 'Text to Image', colonnes: [
      { titre: 'Créer une image', outils: [
      { label: 'Text to Image', texte: 'Ton personnage, avec jusqu’à 6 images de référence.', section: 'image' },
      { label: 'Movie Studio', texte: 'Boîtier, objectif, lumière, pellicule : une fiche de plan.', section: 'cinema' },
      { label: 'Carousel', texte: 'Une photo de départ, une série de la même séance : même tenue, même lieu, poses et cadrages variés.', section: 'carrousel', pastille: 'new' },
      { label: 'Character', texte: 'Décris-le : 4 visages, une planche de référence, 12 images et sa LoRA.', section: 'nouveau-personnage', pastille: 'new' },
      { label: 'Product Shot', texte: 'Ton produit en photo ou en mots, ton personnage, une scène : affiche, visuels et clip.', section: 'pub', pastille: 'new' },
      ] },
      { titre: 'Modifier une image', outils: [
      { label: 'Edit Image', texte: 'Décris le changement : la photo est retouchée, le reste ne bouge pas (Qwen-Image-Edit).', section: 'image', tache: 'edition' },
      { label: 'Inpaint', texte: 'Peins une zone de la photo et dis ce qui doit y apparaître : le reste ne change pas.', section: 'outil', dedie: 'inpaint' },
      { label: 'Remove Background', texte: 'Le sujet est gardé, le fond disparaît : un PNG transparent, rien n’est redessiné.', section: 'outil', dedie: 'remove-bg', pastille: 'new' },
      { label: 'Upscale Image', texte: 'SeedVR2 monte la photo en haute définition sans la redessiner.', section: 'outil', dedie: 'upscale' },
      { label: 'Restore', texte: 'Vieille photo ou clip abîmé : réparé, colorisé, en HD.', section: 'restaurer', pastille: 'new' },
      { label: 'Depth Map', texte: 'La carte de profondeur d’une photo (Depth Anything V2), pour le relief, le compositing et les ControlNet.', section: 'outil', dedie: 'depth', pastille: 'new' },
      ] },
      { titre: 'Styles et lumière', outils: [
      { label: 'Styles', texte: 'Une mosaïque de styles : BD, manga, pâte à modeler, pixel, affiche, néon… sur n’importe quelle photo.', section: 'styles', pastille: 'new' },
      { label: 'Relight', texte: 'La même photo sous un autre éclairage : fenêtre, studio, néons, bougie, heure bleue…', section: 'relight', pastille: 'new' },
      { label: 'Expand', texte: 'La photo élargie en 16:9, 9:16, 4:5 ou 1:1 : les bords sont inventés dans la continuité.', section: 'expand', pastille: 'new' },
      ] },
      { titre: 'Réaliser', outils: [
      { label: 'Multi-Angle', texte: 'La même photo vue d’un autre angle : ¾, profil, plongée, contre-plongée, plan large.', section: 'outil', dedie: 'multi-angle' },
      { label: 'Coverage', texte: 'Trois plans de la même scène en un clic : large, trois-quarts et serré.', section: 'outil', dedie: 'coverage', pastille: 'new' },
      { label: 'Next Shot', texte: 'Le plan d’après : la même personne, au même endroit, quelques secondes plus tard.', section: 'outil', dedie: 'next-shot', pastille: 'new' },
      { label: 'Image to 3D', texte: 'Une photo devient un modèle à faire tourner, à télécharger ou à poser dans la scène 3D.', section: 'outil', dedie: 'image-3d', pastille: 'new' },
      ] },
    ], modeles: [['Krea 2', 'Photo du personnage, LoRA d’identité'], ['FLUX.2 Klein 9B', 'Images de référence, croquis'], ['Qwen-Image-Edit 2511', 'Angles, looks, retouche'], ['SeedVR2', 'Restauration et HD'], ['TRELLIS.2', 'Photo vers modèle 3D']] },
  { titre: 'Vidéo', defaut: 'Image to Video', colonnes: [
      { titre: 'Créer une vidéo', outils: [
      { label: 'One-click Reel', texte: 'Un brief, un reel monté, son compris.', section: 'reel' },
      { label: 'Image to Video', texte: 'D’une photo vers un clip, avec son.', section: 'video', tache: 'creer' },
      { label: 'Text to Video', texte: 'Un plan d’ambiance sans photo de départ.', section: 'video', tache: 'texte' },
      { label: 'Sketch to Video', texte: 'Dessine la scène au trait : elle devient une image, puis un clip.', section: 'croquis', pastille: 'new' },
      { label: 'Talking Avatar', texte: 'Une photo, une voix ou un texte : les lèvres suivent.', section: 'parole' },
      { label: 'Seamless Loop', texte: 'Un clip qui revient à son image de départ : il tourne en boucle sans raccord.', section: 'outil', dedie: 'loop', pastille: 'new' },
      ] },
      { titre: 'Réaliser', outils: [
      { label: 'Scène 3D', texte: 'Bloque la scène en 3D, objets GLB compris, pose la caméra.', stage: true, pastille: 'new' },
      { label: 'Camera Moves', texte: 'Dolly, orbite, crash zoom, drone, bullet time : un mouvement de cinéma sur n’importe quelle photo.', section: 'presets', tache: 'camera' },
      { label: 'Effects', texte: 'Explosion, gonflement, électricité, figurine : un effet viral en un clic sur une photo.', section: 'presets', tache: 'effets' },
      { label: 'Re-shoot', texte: 'Le même moment filmé d’un autre angle.', section: 'reshoot' },
      { label: 'Motion Control', texte: 'Une photo reprend le geste d’une vidéo.', section: 'video', tache: 'move' },
      ] },
      { titre: 'Modifier une vidéo', outils: [
      { label: 'Swap', texte: 'Tes personnages prennent la place de 1 à 3 personnes.', section: 'video', tache: 'mix', pastille: 'new' },
      { label: 'Retouch', texte: 'Peins une zone, change-la ou pose l’objet d’une photo.', section: 'outil', dedie: 'retouch', pastille: 'new' },
      { label: 'Extend Video', texte: 'Le clip continue : quelques secondes de plus, dans le même mouvement.', section: 'video', tache: 'etendre' },
      { label: 'Reframe', texte: 'Le clip passe en 9:16, 16:9 ou 1:1, les bords sont générés.', section: 'recadrer', pastille: 'new' },
      { label: 'Remove Objects', texte: 'Retire une personne ou un objet du clip : le décor derrière est reconstitué.', section: 'outil', dedie: 'remove-objects', pastille: 'new' },
      { label: 'Change Background', texte: 'Le sujet reste, le décor du clip change : décris le nouveau.', section: 'outil', dedie: 'change-bg', pastille: 'new' },
      { label: 'Restore', texte: 'Vieille photo ou clip abîmé : réparé, colorisé, en HD.', section: 'restaurer', pastille: 'new' },
      { label: 'Upscale 1080p', texte: 'SeedVR2 monte le clip en 1080p.', section: 'outil', dedie: 'upscale' },
      { label: 'Green Screen', texte: 'SAM3 garde le sujet, rien n’est redessiné.', section: 'outil', dedie: 'green-screen' },
      ] },
      { titre: 'Finir', outils: [
      { label: 'Editor', texte: 'Timeline, fondus, texte, musique, transitions générées.', section: 'montage' },
      { label: 'Lip Sync', texte: 'Une nouvelle voix sur un clip : les lèvres suivent.', section: 'doublage', pastille: 'new' },
      { label: 'Add Sound', texte: 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).', section: 'outil', dedie: 'add-sound', pastille: 'new' },
      { label: 'Smooth Motion', texte: 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.', section: 'outil', dedie: 'smooth' },
      { label: 'HDR Masters', texte: 'HLG, ProRes, EXR ACEScg et ProRes avec alpha.', section: 'outil', dedie: 'hdr', pastille: 'new' },
      { label: 'Social Check', texte: 'Accroche, sujet, image, histoire : une note et trois conseils avant de publier.', section: 'analyse', pastille: 'new' },
      ] },
    ], modeles: [['LTX-2.5 22B', 'Clip avec son, IC-LoRA, caméra'], ['Wan 2.2 A14B', 'Image vers vidéo, transitions'], ['Wan 2.1 + effect LoRAs', '25 mouvements et effets'], ['MiniMax H3', 'Clip avec son, le plus fluide · prébranché, à installer', 'h3'], ['Wan Animate 2', 'Mix et Move'], ['InfiniteTalk', 'Avatar parlant, doublage'], ['SAM3', 'Suivi, détourage'], ['SeedVR2 7B', 'Netteté et restauration']] },
  { titre: 'Audio', defaut: 'Music & Sound Effects', colonnes: [
      { titre: 'Créer du son', outils: [
      { label: 'Music & Sound Effects', texte: 'Génère un morceau ou un son, retrouve-les tous dans la bibliothèque.', section: 'assets', tache: 'musiques', pastille: 'new' },
      { label: 'Voice-over', texte: 'Tape une phrase, choisis une voix : le fichier rejoint la bibliothèque audio.', section: 'assets', tache: 'musiques' },
      { label: 'Voice Clone', texte: 'Ta voix, d’après un court extrait que tu enregistres avec ton accord (propriétaire du studio).', section: 'assets', tache: 'cloner', pastille: 'new' },
      { label: 'Voice Changer', texte: 'Une phrase enregistrée, redite avec une autre voix (propriétaire du studio).', section: 'assets', tache: 'changer', pastille: 'new' },
      ] },
      { titre: 'Sur un clip', outils: [
      { label: 'Lip Sync', texte: 'Une nouvelle voix sur un clip : les lèvres suivent.', section: 'doublage', pastille: 'new' },
      { label: 'Talking Avatar', texte: 'Une photo, une voix ou un texte : les lèvres suivent.', section: 'parole' },
      { label: 'Add Sound', texte: 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).', section: 'outil', dedie: 'add-sound', pastille: 'new' },
      ] },
    ], modeles: [['ACE-Step 1.5', 'Musique et bruitages'], ['Kokoro-82M', 'Voix off'], ['Chatterbox', 'Clonage et changement de voix (propriétaire)']] },
  { titre: 'Extensions', defaut: 'Extensions', colonnes: [
      { titre: 'Ajouter des fonctions', outils: [
      { label: 'Extensions', texte: 'Des fonctions ajoutées par la communauté, sans code : un workflow ComfyUI et un formulaire.', section: 'extensions', pastille: 'new' },
      { label: 'ComfyUI Official Workflows', texte: 'Le catalogue des workflows officiels de ComfyUI, avec les modèles manquants, à télécharger et ouvrir dans ComfyUI.', section: 'extensions', tache: 'comfy' },
      ] },
    ], modeles: [['Workflows ComfyUI', 'Un workflow et un formulaire, sans code']] },
]

/** Les familles à plat (accueil, recherche) : un outil présent dans deux colonnes n'y figure qu'une fois. */
export const GROUPES: { titre: string; outils: Outil[] }[] = MENUS.map(m => {
  const vus = new Set<string>()
  return { titre: m.titre, outils: m.colonnes.flatMap(c => c.outils).filter(o => !vus.has(o.label) && (vus.add(o.label), true)) }
})

/** Lance un outil : l'ouverture d'une section, avec le bon onglet quand il y en a. */
export function useOuvrirOutil(aller: (s: Section) => void) {
  const ouvrirStage = useAppStore(st => st.ouvrirStage)
  const updateVideo = useAppStore(st => st.updateVideo)
  const [choix, setChoix] = useState<Choix | null>(null)
  const ouvrir = (o: Outil) => {
    if ('stage' in o) { ouvrirStage(); return }
    if ('depuis' in o) { setChoix({ type: o.depuis, titre: o.titre, action: o.action }); return }
    useAppStore.setState({ stageOuvert: false })
    useAppStore.setState({ ongletMusiques: o.tache === 'musiques' })
    if (o.section === 'extensions') useAppStore.setState({ ongletExtensions: o.tache === 'comfy' ? 'comfy' : 'tout' })
    if (o.tache === 'camera' || o.tache === 'effets') useAppStore.setState({ famillePresets: o.tache === 'camera' ? 'camera' : 'effet' })
    useAppStore.setState({ demandeOutil: o.tache === 'hd' || o.tache === 'cloner' || o.tache === 'changer' ? o.tache : null })
    if (o.tache === 'cloner' || o.tache === 'changer') useAppStore.setState({ ongletMusiques: true })
    if (o.tache === 'edition') useAppStore.getState().updatePhoto({ task: 'edit' })
    if (o.tache === 'etendre') updateVideo({ task: 'extend' })
    if (o.tache === 'creer') updateVideo({ task: 'i2v' })
    if (o.tache === 'texte') updateVideo({ task: 't2v' })
    if (o.tache === 'move' || o.tache === 'mix') updateVideo({ task: 'motion_pure', motionMode: o.tache === 'mix' ? 'replace' : 'animate' })
    if (o.section === 'outil' && o.dedie) useAppStore.setState({ outilDedie: o.dedie })
    aller(o.section)
  }
  return { ouvrir, choix, fermerChoix: () => setChoix(null) }
}

type Choix = { type: 'photo' | 'video'; titre: string; action: ActionOutil }

export function ChoixMedia({ choix, onClose, onPick }: { choix: Choix | null; onClose: () => void; onPick: (a: Asset, action?: ActionOutil) => void }) {
  const assets = useAppStore(s => s.assets)
  return <FramePicker open={!!choix} onClose={onClose} title={t(choix?.titre ?? '')} media={choix?.type} assets={assets.filter(a => a.mediaType === choix?.type && !a.modele3d)}
    onPickAsset={a => { const action = choix?.action; onClose(); onPick(a, action) }} onPickUpload={onClose} />
}

/** Petite vignette d'un outil, tirée de son aperçu d'accueil. */
function vignetteOutil(label: string): string | null {
  const a = APERCUS[label]
  if (!a) return null
  return a.type === 'compare' ? a.b : a.image
}

export function MenusOutils({ section, aller, onPick }: { section: Section; aller: (s: Section) => void; onPick: (a: Asset, action?: ActionOutil) => void }) {
  const [ouvert, setOuvert] = useState<string | null>(null)
  const { ouvrir, choix, fermerChoix } = useOuvrirOutil(aller)
  const racine = useRef<HTMLDivElement>(null)
  const stageOuvert = useAppStore(s => s.stageOuvert)
  useEffect(() => {
    if (!ouvert) return
    const dehors = (e: MouseEvent) => { if (!racine.current?.contains(e.target as Node)) setOuvert(null) }
    const echap = (e: KeyboardEvent) => { if (e.key === 'Escape') setOuvert(null) }
    document.addEventListener('mousedown', dehors); document.addEventListener('keydown', echap)
    return () => { document.removeEventListener('mousedown', dehors); document.removeEventListener('keydown', echap) }
  }, [ouvert])
  const outils = (m: Menu) => m.colonnes.flatMap(c => c.outils)
  const outilDedie = useAppStore(st => st.outilDedie)
  // la page dédiée « outil » sert plusieurs familles : seule celle qui porte l'outil ouvert s'allume
  const actif = (m: Menu) => outils(m).some(o => ('stage' in o ? section === 'video' && stageOuvert
    : 'section' in o && o.section === section && !stageOuvert && (section !== 'outil' || o.dedie === outilDedie)))
  const nb = (m: Menu) => new Set(outils(m).map(o => o.label)).size
  return (
    <div ref={racine} className="flex gap-0.5 items-center" style={{ position: 'relative' }} onMouseLeave={() => setOuvert(null)}>
      {MENUS.map(m => (
        <div key={m.titre} onMouseEnter={() => setOuvert(m.titre)}>
          <button aria-expanded={ouvert === m.titre} className="px-2.5 py-1.5 rounded-[9px] text-[12.5px]" onClick={() => {
              // un clic sur la famille ouvre son outil principal (le survol montre le menu)
              const o = m.defaut ? outils(m).find(x => x.label === m.defaut) : null
              setOuvert(null)
              if (o) ouvrir(o)
            }}
            style={{ background: ouvert === m.titre || actif(m) ? 'var(--lv3)' : 'transparent', color: ouvert === m.titre || actif(m) ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {t(m.titre)}
          </button>
          {ouvert === m.titre && (
            <div data-popup className="mega-menu" style={{ position: 'absolute', top: '100%', left: 0, paddingTop: 8, zIndex: 300 }}>
              <div className="mega-boite">
                <div className="mega-outils">
                  <div className="mega-entete">{t('Outils')} <span>{t('{n} outils', { n: nb(m) })}</span></div>
                  <div className="mega-colonnes" style={{ gridTemplateColumns: `repeat(${m.colonnes.length}, minmax(230px, 1fr))` }}>
                    {m.colonnes.map(c => (
                      <div key={c.titre} className="mega-colonne">
                        <div className="mega-titre">{t(c.titre)}</div>
                        {c.outils.map(o => {
                          const v = vignetteOutil(o.label)
                          return (
                            <button key={o.label} className="mega-outil" onClick={() => { setOuvert(null); ouvrir(o) }}>
                              <span className="mega-vignette">{v && <img src={v} alt="" loading="lazy" />}</span>
                              <span className="mega-texte"><b>{t(o.label)}{o.pastille && <Pastille k={o.pastille} />}</b><span>{t(o.texte)}</span></span>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mega-modeles">
                  <div className="mega-entete">{t('Modèles')}</div>
                  {m.modeles.map(([nom, role, lien]) => lien
                    ? <button key={nom} className="mega-modele mega-lien" onClick={() => { setOuvert(null); useAppStore.setState({ ongletConfig: 'modeles' }); aller('config') }}>
                        <b>{nom} <em>{t('à installer')} ›</em></b><span>{t(role)}</span></button>
                    : <div key={nom} className="mega-modele"><b>{nom}</b><span>{t(role)}</span></div>)}
                  <div className="mega-pied">{t('Poids ouverts, sur ta carte graphique.')}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
    </div>
  )
}
