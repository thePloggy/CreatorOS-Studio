/* ============================================================
   Navigation (01/11) : les outils rangés par intention, Créer, Mettre en
   scène, Transformer, Finir. Chaque menu dit ce que fait l'outil. Un outil
   qui part d'un média existant ouvre le choix dans la bibliothèque, puis la
   visionneuse où se trouve son bouton.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'
import { Pastille } from './bits'
import { FramePicker } from './popups'

export type Section = 'accueil' | 'image' | 'cinema' | 'reshoot' | 'video' | 'reel' | 'presets' | 'parole' | 'montage' | 'assets' | 'persona' | 'config' | 'createur'
export type Outil = { label: string; texte: string; pastille?: 'new' | 'top' } & (
  { section: Section; tache?: 'creer' | 'texte' | 'move' | 'mix' | 'etendre' } | { stage: true } | { depuis: 'photo' | 'video'; titre: string })

export const GROUPES: { titre: string; outils: Outil[] }[] = [
  { titre: 'Créer', outils: [
    { label: 'Reel', texte: 'Un brief, un reel monté, son compris.', section: 'reel', pastille: 'top' },
    { label: 'Photo', texte: 'Ton personnage, avec jusqu’à 6 images de référence.', section: 'image' },
    { label: 'Vidéo', texte: 'D’une photo vers un clip, avec son.', section: 'video', tache: 'creer' },
    { label: 'Depuis un texte', texte: 'Un plan d’ambiance sans photo de départ.', section: 'video', tache: 'texte' },
    { label: 'Avatar parlant', texte: 'Une photo, une voix ou un texte : les lèvres suivent.', section: 'parole' },
    { label: 'Musique et bruitages', texte: 'Génère un morceau ou un son dans le montage.', section: 'montage', pastille: 'new' },
  ] },
  { titre: 'Mettre en scène', outils: [
    { label: 'Stage', texte: 'Bloque la scène en 3D, objets GLB compris, pose la caméra.', stage: true, pastille: 'new' },
    { label: 'Studio ciné', texte: 'Boîtier, objectif, lumière, pellicule : une fiche de plan.', section: 'cinema' },
    { label: 'Caméra & effets', texte: 'Mouvements et effets en un clic sur une photo.', section: 'presets', pastille: 'top' },
    { label: 'Re-shoot', texte: 'Le même moment filmé d’un autre angle.', section: 'reshoot' },
  ] },
  { titre: 'Transformer', outils: [
    { label: 'Mix', texte: 'Tes personnages prennent la place de 1 à 3 personnes.', section: 'video', tache: 'mix', pastille: 'new' },
    { label: 'Move', texte: 'Une photo reprend le geste d’une vidéo.', section: 'video', tache: 'move' },
    { label: 'Objet 3D', texte: 'Une photo devient un modèle GLB.', depuis: 'photo', titre: 'Photo à passer en 3D', pastille: 'new' },
    { label: 'Retouche et objet', texte: 'Peins une zone, change-la ou pose l’objet d’une photo.', depuis: 'video', titre: 'Clip à retoucher', pastille: 'new' },
    { label: 'Angles, looks, lumière', texte: 'Une photo sous un autre jour, en un clic.', depuis: 'photo', titre: 'Photo à transformer' },
  ] },
  { titre: 'Finir', outils: [
    { label: 'Montage', texte: 'Timeline, fondus, texte, musique, transitions générées.', section: 'montage' },
    { label: 'Netteté 1080p', texte: 'SeedVR2 monte le clip en 1080p.', depuis: 'video', titre: 'Clip à affiner' },
    { label: 'Masters HDR', texte: 'HLG, ProRes, EXR ACEScg et ProRes avec alpha.', depuis: 'video', titre: 'Clip à exporter', pastille: 'new' },
    { label: 'Fond vert ou transparent', texte: 'SAM3 garde le sujet, rien n’est redessiné.', depuis: 'video', titre: 'Clip à détourer' },
  ] },
]

/** Lance un outil : l'ouverture d'une section, avec le bon onglet quand il y en a. */
export function useOuvrirOutil(aller: (s: Section) => void) {
  const ouvrirStage = useAppStore(st => st.ouvrirStage)
  const updateVideo = useAppStore(st => st.updateVideo)
  const [choix, setChoix] = useState<{ type: 'photo' | 'video'; titre: string } | null>(null)
  const ouvrir = (o: Outil) => {
    if ('stage' in o) { ouvrirStage(); return }
    if ('depuis' in o) { setChoix({ type: o.depuis, titre: o.titre }); return }
    useAppStore.setState({ stageOuvert: false })
    if (o.tache === 'creer') updateVideo({ task: 'i2v' })
    if (o.tache === 'texte') updateVideo({ task: 't2v' })
    if (o.tache === 'move' || o.tache === 'mix') updateVideo({ task: 'motion_pure', motionMode: o.tache === 'mix' ? 'replace' : 'animate' })
    aller(o.section)
  }
  return { ouvrir, choix, fermerChoix: () => setChoix(null) }
}

export function ChoixMedia({ choix, onClose, onPick }: { choix: { type: 'photo' | 'video'; titre: string } | null; onClose: () => void; onPick: (a: Asset) => void }) {
  const assets = useAppStore(s => s.assets)
  return <FramePicker open={!!choix} onClose={onClose} title={t(choix?.titre ?? '')} assets={assets.filter(a => a.mediaType === choix?.type)}
    onPickAsset={a => { onClose(); onPick(a) }} onPickUpload={onClose} />
}

export function MenusOutils({ section, aller, onPick }: { section: Section; aller: (s: Section) => void; onPick: (a: Asset) => void }) {
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
  const actif = (g: (typeof GROUPES)[number]) => g.outils.some(o => ('stage' in o ? section === 'video' && stageOuvert : 'section' in o && o.section === section && !stageOuvert))
  return (
    <div ref={racine} className="flex gap-0.5 items-center" style={{ position: 'relative' }} onMouseLeave={() => setOuvert(null)}>
      {GROUPES.map(g => (
        <div key={g.titre} style={{ position: 'relative' }} onMouseEnter={() => setOuvert(g.titre)}>
          <button aria-expanded={ouvert === g.titre} className="px-2.5 py-1.5 rounded-[9px] text-[12.5px]" onClick={() => setOuvert(o => (o === g.titre ? null : g.titre))}
            style={{ background: ouvert === g.titre || actif(g) ? 'var(--lv3)' : 'transparent', color: ouvert === g.titre || actif(g) ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {t(g.titre)} <span style={{ fontSize: 9, opacity: .6 }}>▾</span>
          </button>
          {ouvert === g.titre && (
            <div style={{ position: 'absolute', top: '100%', left: 0, paddingTop: 6, zIndex: 300 }}>
              <div style={{ width: 340, padding: 6, borderRadius: 14, background: 'var(--lv2)', border: '1px solid var(--lv3)', boxShadow: '0 18px 50px rgba(0,0,0,.55)', display: 'grid', gap: 2 }}>
                {g.outils.map(o => (
                  <button key={o.label} className="nav-outil" onClick={() => { setOuvert(null); ouvrir(o) }}>
                    <b>{t(o.label)}{o.pastille && <Pastille k={o.pastille} />}</b>
                    <span>{t(o.texte)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
      <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
    </div>
  )
}
