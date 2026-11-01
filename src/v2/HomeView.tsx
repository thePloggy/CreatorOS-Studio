/* ============================================================
   Accueil (21/10) — la vitrine : ce que l'app sait faire, en grandes cartes
   qui tournent en boucle, un clic pour ouvrir l'outil. Les vidéos viennent
   de la bibliothèque du personnage actif (derniers clips, dernier reel) :
   rien n'est figé dans le code, la vitrine montre ce que la machine a rendu.
   ============================================================ */
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { vignetteOf } from '../components/AssetMedia'
import { t } from '../i18n'
import { Pastille } from './bits'
import type { Asset } from '../types'
import { ChoixMedia, GROUPES, useOuvrirOutil, type Section } from './Navigation'

type Cible = 'reel' | 'presets' | 'parole' | 'montage' | 'image' | 'video' | 'assets' | 'stage' | 'reshoot' | 'cinema'

export function HomeView({ go, aller, onPick }: { go: (s: Cible) => void; aller: (s: Section) => void; onPick: (a: Asset) => void }) {
  const { ouvrir, choix, fermerChoix } = useOuvrirOutil(aller)
  const s = useAppStore()
  const [groupe, setGroupe] = useState<string | null>(null)
  const [cherche, setCherche] = useState('')
  const videos = useMemo(() => s.assets.filter(a => a.mediaType === 'video' && a.reviewStatus !== 'rejected' && !a.modele3d)
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt), [s.assets])
  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt), [s.assets])
  const reel = videos.find(a => String(a.jobId).startsWith('mtg-')) ?? videos[0]
  const stage = videos.find(a => String(a.jobId).startsWith('stage-'))
  const autre = videos.find(a => a.id !== reel?.id && a.id !== stage?.id)
  const BANDEAUX: { cible: Cible; titre: string; texte: string; media?: Asset }[] = [
    { cible: 'reel', titre: t('Un brief. Un reel.'), texte: t('Plans, clips, son, fondus et accroche : le reel se monte tout seul.'), media: reel },
    { cible: 'stage', titre: 'Stage', texte: t('Place tes formes, pose ta caméra : le plan fini suit la mise en scène.'), media: stage },
    { cible: 'presets', titre: t('Caméra & effets'), texte: t('Un mouvement de caméra de cinéma sur n’importe quelle photo, en un clic.'), media: autre },
  ]
  // vignettes fixes : le catalogue ne lance aucune vidéo, seuls les bandeaux tournent
  const vignettes = useMemo(() => [...videos, ...photos].sort((x, y) => y.createdAt - x.createdAt).filter(a => vignetteOf(a) || a.uri), [videos, photos])
  const mot = cherche.trim().toLowerCase()
  const groupes = GROUPES.filter(g => !groupe || g.titre === groupe)
    .map(g => ({ ...g, outils: g.outils.filter(o => !mot || `${t(o.label)} ${t(o.texte)}`.toLowerCase().includes(mot)) })).filter(g => g.outils.length)
  let n = 0
  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'grid', gap: 28 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          {BANDEAUX.map(b => (
            <button key={b.titre} onClick={() => go(b.cible)} className="bandeau">
              <span className="bandeau-media">{b.media && (b.media.mediaType === 'video'
                ? <video src={b.media.uri} poster={vignetteOf(b.media)} muted loop autoPlay playsInline />
                : <img src={b.media.uri} alt="" />)}</span>
              <b>{b.titre}</b>
              <span>{b.texte}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input value={cherche} onChange={e => setCherche(e.target.value)} placeholder={t('Chercher un outil')} className="cherche-outil" />
          <button className={`wtab ${!groupe ? 'on' : ''}`} onClick={() => setGroupe(null)}>{t('Tout')}</button>
          {GROUPES.map(g => <button key={g.titre} className={`wtab ${groupe === g.titre ? 'on' : ''}`} onClick={() => setGroupe(g.titre)}>{t(g.titre)}</button>)}
        </div>
        {groupes.map(g => (
          <div key={g.titre} style={{ display: 'grid', gap: 12 }}>
            <b style={{ fontSize: 20, fontWeight: 800 }}>{t(g.titre)}</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 14 }}>
              {g.outils.map(o => {
                const a = vignettes.length ? vignettes[n++ % vignettes.length] : undefined
                return (
                  <button key={o.label} onClick={() => ouvrir(o)} className="carte-outil">
                    <span className="carte-image">{a && <img src={vignetteOf(a) ?? a.uri} alt="" loading="lazy" />}{o.pastille && <i><Pastille k={o.pastille} /></i>}</span>
                    <b>{t(o.label)}</b>
                    <span>{t(o.texte)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
      </div>
    </div>
  )
}
