/* Danse : une photo du personnage reprend une danse du catalogue (motion control).
   Au gabarit studio : la photo, la danse et la durée à gauche, les danses rendues à droite.
   Les danses du catalogue sont des captures de mouvement jouées par un mannequin neutre :
   seule la pose est reprise, le personnage garde son visage, sa tenue et son décor. */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'
import { V2Portal } from './bits'

interface Danse { slug: string; titre: string; secondes: number | null }

export function DanseView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('danse')
  const [danses, setDanses] = useState<Danse[]>([])
  const [choix, setChoix] = useState<string | null>(null)
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [survol, setSurvol] = useState<{ slug: string; titre: string; rect: DOMRect } | null>(null)
  const [occupe, setOccupe] = useState(false)
  useEffect(() => { void fetch('/api/danses').then(r => r.json()).then(d => setDanses(d.danses ?? [])).catch(() => {}) }, [])

  const lancer = async () => {
    if (!choix || !source?.asset) return
    setOccupe(true); setMsg(null)
    try {
      const inp = await fetch(`/api/assets/${encodeURIComponent(source.asset.id)}/to-input`, { method: 'POST' }).then(r => r.json())
      if (!inp.filename) throw new Error(tServeur(inp.error) ?? 'photo indisponible')
      const p = 'She dances with energy and a big smile, following the rhythm, her whole body visible, real-time speed.'
      const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        mode: 'video', register: 'sfw', personaId: source.asset.personaId ?? s.personaId, purpose: 'creative',
        motionDriver: `crs_danse_${choix}.mp4`, motionRef: inp.filename, motionMode: 'animate',
        composedPositive: p, userPrompt: p, composedNegative: '' }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      const ids = [d.id, ...(d.ids ?? [])].filter(Boolean)
      suivi.ajouter(ids); for (const j of ids) void s.adoptServerJob(j)
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }

  return (
    <OutilPage titre={t('Danse')} texte={t('Choisis une danse et une photo de ton personnage : il danse exactement comme la danse choisie, avec son visage, sa tenue et son décor.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen}
      etapes={[
        { titre: 'La photo', texte: 'Une photo de ton personnage en pied, de face, les bras le long du corps : c’est elle qui va danser.' },
        { titre: 'La danse', texte: 'Une danse du catalogue, en capture de mouvement : hip-hop, salsa, swing, twist… Seul le mouvement est repris.' },
        { titre: 'Le rendu', texte: 'Le motion control fait danser la photo sur la danse, quelques minutes plus tard.' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!choix || !source?.asset || occupe} onClick={() => void lancer()}>
          {occupe ? '…' : t('Faire danser')} <small>~{t('{m} min', { m: 10 })}</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <ZoneSource media="photo" valeur={source} onChoix={setSource} label={t('Photo du personnage (en pied)')} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Danse')}{choix ? ` · ${danses.find(d => d.slug === choix)?.titre ?? ''}` : ''}</span>
        {/* chaque vignette garde son format 9:16 (sa hauteur vient de sa largeur, la grille défile) ;
            au survol, l'aperçu s'ouvre en grand à côté du volet et joue */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, maxHeight: 460, overflowY: 'auto', alignContent: 'start' }}>
          {danses.map(d => (
            <button key={d.slug} onClick={() => setChoix(d.slug)} title={d.titre}
              onMouseEnter={e => setSurvol({ slug: d.slug, titre: d.titre, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })} onMouseLeave={() => setSurvol(null)}
              style={{ position: 'relative', display: 'block', width: '100%', height: 0, padding: 0, paddingTop: '177.8%', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: 'var(--lv2)',
                border: `2px solid ${choix === d.slug ? 'var(--accent)' : 'transparent'}` }}>
              <img src={`/danses/${d.slug}.webp`} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 4px 4px', fontSize: 10.5, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.7))', textAlign: 'left' }}>{d.titre}</span>
            </button>
          ))}
        </div>
        {survol && <V2Portal>
          <div style={{ position: 'fixed', left: Math.min(window.innerWidth - 290, survol.rect.right + 12), top: Math.max(12, Math.min(window.innerHeight - 512, survol.rect.top - 140)),
            width: 270, height: 500, borderRadius: 14, overflow: 'hidden', background: '#000', boxShadow: '0 12px 40px rgba(0,0,0,.45)' }}>
            <video key={survol.slug} src={`/danses/${survol.slug}.mp4`} poster={`/danses/${survol.slug}.webp`} muted loop playsInline autoPlay
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <b style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 10px 10px', fontSize: 13, color: '#fff', background: 'linear-gradient(transparent, rgba(0,0,0,.75))' }}>{survol.titre}</b>
          </div>
        </V2Portal>}
      </div>
    </OutilPage>
  )
}
