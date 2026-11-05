/* Danse : la personne d'une photo danse une danse du catalogue dans un studio en 3D.
   Au gabarit studio : la photo, le studio et la danse à gauche, les danses rendues à droite.
   La danse (capture de mouvement) est jouée par un mannequin dans le studio, caméra qui l'accompagne ;
   LTX en fait une vraie vidéo, puis le Swap redessine la danseuse d'après la photo. */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'
import { V2Portal } from './bits'

interface Danse { slug: string; titre: string; secondes: number | null; v?: number }
interface Studio { id: string; nom: string }

export function DanseView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('danse')
  const [danses, setDanses] = useState<Danse[]>([])
  const [studios, setStudios] = useState<Studio[]>([])
  const [studio, setStudio] = useState('salon')
  const [choix, setChoix] = useState<string | null>(null)
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [survol, setSurvol] = useState<{ slug: string; v: number; titre: string; rect: DOMRect; studio?: boolean } | null>(null)
  const grilleStudios = useRef<HTMLDivElement | null>(null)
  const [occupe, setOccupe] = useState(false)
  const grille = useRef<HTMLDivElement | null>(null)
  const [suiviVisage, setSuiviVisage] = useState(false)
  useEffect(() => { void fetch('/api/danses').then(r => r.json()).then(d => { setDanses(d.danses ?? []); setStudios(d.studios ?? []) }).catch(() => {}) }, [])

  /* La danse est jouée en 3D dans le studio choisi (le décor bouge avec la caméra), puis la danseuse est
     redessinée d'après la photo : de la photo, seuls la personne et sa tenue comptent. */
  const lancer = async () => {
    if (!choix || !source?.asset) return
    setOccupe(true); setMsg(null)
    try {
      const r = await fetch('/api/danses/scene3d', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: choix, assetId: source.asset.id, decor: studio, suivi: suiviVisage }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.id) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      suivi.ajouter([d.id]); void s.adoptServerJob(d.id)
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  // le rendu en deux passes : la scène (danse3d-…) puis le Swap (danse3d-…-swap) ; seul le résultat final s'affiche
  const suiviDe = (id: string) => [...suivi.ids].some(x => id === x || id === `${x}-swap`)

  return (
    <OutilPage titre={t('Danse')} texte={t('Choisis une danse et une photo de ton personnage : il danse exactement comme la danse choisie, avec son visage, sa tenue et son décor.')}
      jobs={j => suiviDe(j.id)} assets={a => suivi.ids.has(String(a.jobId).replace(/-swap$/, '')) && String(a.jobId).endsWith('-swap')} onOpen={onOpen}
      etapes={[
        { titre: 'Photo, danse et studio', texte: 'Ton personnage en pied (seuls la personne et sa tenue comptent), une danse du catalogue et le lieu où elle danse.', image: '/vitrine/danse/etape1.webp' },
        { titre: 'La scène 3D', texte: 'La danse, en capture de mouvement, est jouée par un mannequin dans le studio en 3D ; la caméra l’accompagne.', image: '/vitrine/danse/etape2.webp' },
        { titre: 'Le rendu', texte: 'La scène devient une vraie vidéo, et ton personnage est repeint sur le mannequin d’après la photo.', image: '/vitrine/danse/etape3.webp' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!choix || !source?.asset || occupe} onClick={() => void lancer()}>
          {occupe ? '…' : t('Faire danser')} <small>~{t('{m} min', { m: 7 })} · 5 s</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <ZoneSource media="photo" valeur={source} onChoix={setSource} label={t('Photo du personnage (en pied)')} />
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={suiviVisage} onChange={e => setSuiviVisage(e.target.checked)} style={{ marginTop: 2 }} />
        <span><b>{t('Caméra verrouillée sur le visage')}</b><br /><small style={{ opacity: .7 }}>{t('Cadrage serré qui suit son visage, comme les vidéos de danse des réseaux sociaux.')}</small></span>
      </label>
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Studio')} · {t(studios.find(x => x.id === studio)?.nom ?? '')}</span>
        {/* chaque studio en vignette : sa maquette repeinte en photo, vide */}
        <div ref={grilleStudios} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 5, maxHeight: 300, overflowY: 'auto', alignContent: 'start' }}>
          {studios.map(x => (
            <button key={x.id} onClick={() => setStudio(x.id)} title={t(x.nom)}
              onMouseEnter={() => setSurvol({ slug: x.id, v: 0, titre: t(x.nom), studio: true, rect: (grilleStudios.current ?? document.body).getBoundingClientRect() })} onMouseLeave={() => setSurvol(null)}
              style={{ position: 'relative', display: 'block', width: '100%', height: 0, padding: 0, paddingTop: '177.8%', borderRadius: 9, overflow: 'hidden', cursor: 'pointer', background: 'var(--lv2)',
                border: `2px solid ${studio === x.id ? 'var(--accent)' : 'transparent'}` }}>
              <img src={`/danses/studio-${x.id}.webp`} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 4px 4px', fontSize: 10, lineHeight: 1.15, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.75))', textAlign: 'left' }}>{t(x.nom)}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Danse')}{choix ? ` · ${danses.find(d => d.slug === choix)?.titre ?? ''}` : ''}</span>
        {/* chaque vignette garde son format 9:16 (sa hauteur vient de sa largeur, la grille défile) ;
            au survol, l'aperçu s'ouvre en grand à droite du volet (jamais sur la grille) et joue */}
        <div ref={grille} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, maxHeight: 460, overflowY: 'auto', alignContent: 'start' }}>
          {danses.map(d => (
            <button key={d.slug} onClick={() => setChoix(d.slug)} title={d.titre}
              onMouseEnter={() => setSurvol({ slug: d.slug, v: d.v ?? 0, titre: d.titre, rect: (grille.current ?? document.body).getBoundingClientRect() })} onMouseLeave={() => setSurvol(null)}
              style={{ position: 'relative', display: 'block', width: '100%', height: 0, padding: 0, paddingTop: '177.8%', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: 'var(--lv2)',
                border: `2px solid ${choix === d.slug ? 'var(--accent)' : 'transparent'}` }}>
              <img src={`/danses/${d.slug}.webp?v=${d.v ?? 0}`} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 4px 4px', fontSize: 10.5, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.7))', textAlign: 'left' }}>{d.titre}</span>
            </button>
          ))}
        </div>
        {survol && <V2Portal>
          <div style={{ position: 'fixed', left: Math.min(window.innerWidth - 290, survol.rect.right + 28), top: Math.max(12, Math.min(window.innerHeight - 512, survol.rect.top + survol.rect.height / 2 - 250)),
            width: 270, height: 500, borderRadius: 14, overflow: 'hidden', background: '#000', boxShadow: '0 12px 40px rgba(0,0,0,.45)' }}>
            {survol.studio
              ? <img src={`/danses/studio-${survol.slug}-grand.webp`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : <video key={survol.slug} src={`/danses/${survol.slug}.mp4?v=${survol.v}`} poster={`/danses/${survol.slug}.webp?v=${survol.v}`} muted loop playsInline autoPlay
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            <b style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 10px 10px', fontSize: 13, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.75))' }}>{survol.titre}</b>
          </div>
        </V2Portal>}
      </div>
    </OutilPage>
  )
}
