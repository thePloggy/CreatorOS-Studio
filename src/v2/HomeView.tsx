/* ============================================================
   Accueil (21/10) — la vitrine : ce que l'app sait faire, en grandes cartes
   qui tournent en boucle, un clic pour ouvrir l'outil. Les vidéos viennent
   de la bibliothèque du personnage actif (derniers clips, dernier reel) :
   rien n'est figé dans le code, la vitrine montre ce que la machine a rendu.
   ============================================================ */
import { useMemo } from 'react'
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
  const videos = useMemo(() => s.assets.filter(a => a.mediaType === 'video' && a.reviewStatus !== 'rejected' && !a.modele3d)
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt), [s.assets])
  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt), [s.assets])
  const reel = videos.find(a => String(a.jobId).startsWith('mtg-')) ?? videos[0]
  const autres = videos.filter(a => a.id !== reel?.id && !String(a.jobId).startsWith('stage-'))
  const CARTES: { cible: Cible; titre: string; texte: string; media?: { uri: string; video: boolean; poster?: string } }[] = [
    { cible: 'presets', titre: t('Caméra & effets'), texte: t('Un mouvement de caméra de cinéma sur n’importe quelle photo, en un clic.'),
      media: autres[0] && { uri: autres[0].uri, video: true, poster: vignetteOf(autres[0]) } },
    { cible: 'parole', titre: t('Avatar parlant'), texte: t('Une photo, ta voix : elle parle face caméra, lèvres calées. La pub UGC en un clic.'),
      media: autres.find(a => String(a.jobId).startsWith('parole-')) ? { uri: autres.find(a => String(a.jobId).startsWith('parole-'))!.uri, video: true }
        : photos[0] && { uri: photos[0].uri, video: false } },
    { cible: 'montage', titre: t('Montage'), texte: t('Coupe, fondus, texte, recadrage, musique : le reel se termine ici.'),
      media: autres[1] && { uri: autres[1].uri, video: true, poster: vignetteOf(autres[1]) } },
    { cible: 'image', titre: t('Photo'), texte: t('Ton personnage, cohérent d’une image à l’autre, en séances complètes.'),
      media: photos[0] && { uri: photos[0].uri, video: false } },
    { cible: 'video', titre: t('Vidéo'), texte: t('Image → vidéo, transfert de mouvement, prequel / sequel, retouche au pinceau suivie.'),
      media: autres[2] && { uri: autres[2].uri, video: true, poster: vignetteOf(autres[2]) } },
  ]
  const stage = videos.find(a => String(a.jobId).startsWith('stage-'))
  const VITRINE: typeof CARTES = [
    { cible: 'reel', titre: t('Un brief. Un reel.'), texte: t('Plans, clips, son, fondus et accroche : le reel se monte tout seul.'), media: reel && { uri: reel.uri, video: true, poster: vignetteOf(reel) } },
    CARTES[0], CARTES[1],
    { cible: 'reshoot', titre: 'Re-shoot', texte: t('Replace la caméra sur un clip déjà tourné.'), media: autres[3] && { uri: autres[3].uri, video: true, poster: vignetteOf(autres[3]) } },
  ]
  const legende = (titre: string, texte: string, grand = false) => (
    <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: grand ? '90px 26px 24px' : '50px 16px 15px', background: 'linear-gradient(transparent, rgba(0,0,0,.88))', display: 'grid', gap: 5 }}>
      <b className="home-titre" style={{ fontSize: grand ? 72 : 34, lineHeight: .98 }}>{titre}</b>
      <span style={{ fontSize: grand ? 14.5 : 12.5, opacity: .85, lineHeight: 1.45, maxWidth: 520 }}>{texte}</span>
    </span>
  )
  const fond: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }
  const carte: React.CSSProperties = { position: 'relative', borderRadius: 18, overflow: 'hidden', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: '#fff', background: 'linear-gradient(160deg, var(--lv3), var(--lv1))' }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'grid', gap: 26 }}>
        <div style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', opacity: .6 }}>{t('Open source · modèles ouverts · sur ton GPU')}</div>
        {/* ---------- vitrine : Stage en grand, quatre cartes autour ---------- */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(285px, 1fr))', gridAutoRows: 220, gap: 12 }}>
          <button onClick={() => go('stage')} style={{ ...carte, gridColumn: 'span 2', gridRow: 'span 2' }}>
            {stage && <video src={stage.uri} poster={vignetteOf(stage)} muted loop autoPlay playsInline style={fond} />}
            <span style={{ position: 'absolute', left: 22, top: 20 }}><Pastille k="new" /></span>
            {legende('STAGE', t('Place tes formes, pose ta caméra : le plan fini suit la mise en scène.'), true)}
          </button>
          {VITRINE.map(c => (
            <button key={c.titre} onClick={() => go(c.cible)} style={carte}>
              {c.media && (c.media.video
                ? <video src={c.media.uri} poster={c.media.poster} muted loop autoPlay playsInline style={fond} />
                : <img src={c.media.uri} alt="" style={fond} />)}
              {legende(c.titre, c.texte)}
            </button>
          ))}
        </div>
        {/* ---------- tous les outils, rangés comme les menus ---------- */}
        {GROUPES.map(g => (
          <div key={g.titre} style={{ display: 'grid', gap: 12 }}>
            <b className="home-titre" style={{ fontSize: 26 }}>{t(g.titre)}</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {g.outils.map(o => (
                <button key={o.label} onClick={() => ouvrir(o)} style={{ borderRadius: 13, border: '1px solid var(--lv3)', padding: '13px 15px', cursor: 'pointer', textAlign: 'left', background: 'var(--lv1)', color: 'var(--text)', display: 'grid', gap: 3, font: 'inherit' }}>
                  <b style={{ fontSize: 13.5 }}>{t(o.label)}{o.pastille && <Pastille k={o.pastille} />}</b>
                  <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{t(o.texte)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
      </div>
    </div>
  )
}
