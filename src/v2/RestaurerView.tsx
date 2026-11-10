/* Restore: a damaged photo or clip comes out clean and in HD (see server/restauration.js).
   Photo: retouch (scratches, dust, faded areas), optional color, then SeedVR2 upscale.
   Clip: SeedVR2 video; colorize: first frame colorized, clip colorized by VACE, then SeedVR2. Studio layout: settings on the left, before / after then history on the right. */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'
import { AvantApres } from '../components/AvantApres'

type Source = { asset?: Asset; fichier?: string; apercu?: string } | null
type Etape = { etape: string; job: string | null; statut: string | null; uri: string | null }
type Etat = { id: string; media: 'photo' | 'video'; avant?: string | null; etapes: Etape[]; fini: boolean; uri: string | null; assetId: string | null; echec: boolean }

export function RestaurerView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const suivi = useSuiviOutil('restaurer')
  const [media, setMedia] = useState<'photo' | 'video'>('photo')
  const [source, setSource] = useState<Source>(null)
  const [nettoyer, setNettoyer] = useState(true)
  const [couleur, setCouleur] = useState(false)
  const [stabilite, setStabilite] = useState(true)
  const [hd, setHd] = useState(true)
  const [etat, setEtat] = useState<Etat | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // menu's Upscale Image: HD photo only, no repair or color
  const demande = useAppStore(st => st.demandeOutil)
  useEffect(() => { if (demande === 'hd') { setMedia('photo'); setNettoyer(false); setCouleur(false); setHd(true); useAppStore.setState({ demandeOutil: null }) } }, [demande])
  const [occupe, setOccupe] = useState(false)
  const avant = etat?.avant ?? source?.asset?.uri ?? source?.apercu ?? null

  // the last restoration stays displayed when returning to the page
  useEffect(() => {
    let id: string | null = null
    try { id = localStorage.getItem('restaurer:dernier') } catch { /* storage unavailable */ }
    if (id) void fetch(`/api/restauration/${id}`).then(r => (r.ok ? r.json() : null)).then((d: Etat | null) => { if (d) { setEtat(e => e ?? d); setMedia(d.media) } }).catch(() => {})
  }, [])
  useEffect(() => { if (etat) try { localStorage.setItem('restaurer:dernier', etat.id) } catch { /* storage unavailable */ } }, [etat?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!etat || etat.fini || etat.echec) return
    const h = setInterval(() => void fetch(`/api/restauration/${etat.id}`).then(r => (r.ok ? r.json() : null)).then((d: Etat | null) => {
      if (!d) return
      setEtat(d)
      const nouveaux = d.etapes.map(e => e.job).filter((j): j is string => !!j && !suivi.ids.has(j))
      if (nouveaux.length) { suivi.ajouter(nouveaux); for (const j of nouveaux) void s.adoptServerJob(j) }
    }).catch(() => {}), 3000)
    return () => clearInterval(h)
  }, [etat]) // eslint-disable-line react-hooks/exhaustive-deps

  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try {
      const r = await fetch('/api/restauration', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media, assetId: source?.asset?.id, fichier: source?.fichier, nettoyer, couleur, hd, stabilite: media === 'video' && stabilite }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      setEtat(d)
      const ids = (d.etapes as Etape[]).map(e => e.job).filter((j): j is string => !!j)
      suivi.ajouter(ids); for (const j of ids) void s.adoptServerJob(j)
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }

  const libelle = (e: Etape) => e.statut === 'done' ? '✓' : e.statut === 'blocked' || e.statut === 'failed' ? t('échec') : e.statut === 'en attente' ? t('en attente') : '…'
  const resultat = etat ? (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="flex gap-2 flex-wrap" style={{ fontSize: 12 }}>
        {etat.etapes.map((e, k) => <span key={k} className="pill">{t(e.etape)} {libelle(e)}</span>)}
      </div>
      {(() => {
        const apres = etat.uri ?? etat.etapes.findLast(e => e.uri)?.uri ?? null
        const type = etat.media === 'video' ? 'video' as const : 'photo' as const
        if (apres && avant) return <AvantApres avant={{ id: `${etat.id}-avant`, uri: avant, mediaType: type }} apres={{ id: `${etat.id}-apres`, uri: apres, mediaType: type }}
          style={{ justifySelf: 'center', maxWidth: '100%', borderRadius: 10, overflow: 'hidden' }} className="comparateur-restau" />
        if (apres) return type === 'video' ? <video src={apres} controls playsInline style={{ width: '100%', borderRadius: 10 }} /> : <img src={apres} alt="" style={{ width: '100%', borderRadius: 10 }} />
        return <div style={{ position: 'relative' }}>
          {avant && (type === 'video' ? <video src={avant} muted playsInline preload="metadata" style={{ width: '100%', borderRadius: 10, opacity: .45 }} /> : <img src={avant} alt="" style={{ width: '100%', borderRadius: 10, opacity: .45 }} />)}
          <span className="texte-doux" style={{ position: avant ? 'absolute' : 'static', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13 }}>{type === 'video' ? t('Le clip se restaure (quelques minutes)…') : t('en cours…')}</span>
        </div>
      })()}
      {etat.fini && <span className="texte-faible" style={{ fontSize: 12 }}>{t('Glisse la barre pour comparer avant et après.')}</span>}
      {etat.echec && <span className="texte-erreur">{t('Une étape a échoué : réessaie.')}</span>}
    </div>
  ) : undefined

  return (
    <OutilPage
      howto={{ cle: 'restaurer', titre: 'Une vieille photo ou un clip abîmé, restauré', texte: 'Rayures, bruit et compression effacés, couleurs rendues, détail reconstruit : en HD, avec le comparateur avant / après.', label: 'Exemple de restauration', repli: '/vitrine/restaurer-b2.webp' }} titre={t('Restaurer')} texte={t('Une vieille photo ou un clip abîmé ressort propre et en HD : rayures et bruit effacés, couleurs rendues si tu veux, détail reconstruit.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen} resultat={resultat}
      etapes={[
        { titre: 'La source', texte: 'Une photo ou un clip de la bibliothèque ; sur ton studio, aussi un fichier à toi (scan, vieille vidéo, 12 s au plus).' },
        { titre: 'La retouche', texte: 'Rayures, poussière, taches et zones passées sont réparées, sans changer les visages ni le cadrage. La couleur est en option.' },
        { titre: 'La HD', texte: 'SeedVR2, un modèle de restauration, reconstruit le détail fin et agrandit l’image (le clip jusqu’en 1080p).' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!(source?.asset || source?.fichier) || occupe || (media === 'photo' && !nettoyer && !couleur && !hd)}
          onClick={() => void lancer()}>{occupe ? '…' : t('Restaurer')} <small>{media === 'photo' ? '~1 min' : couleur ? '~10 min' : '~3-5 min'}</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <div className="segmente">
        <button className={media === 'photo' ? 'on' : ''} onClick={() => { setMedia('photo'); setSource(null) }}>{t('Photo')}</button>
        <button className={media === 'video' ? 'on' : ''} onClick={() => { setMedia('video'); setSource(null) }}>{t('Clip')}</button>
      </div>
      <ZoneSource media={media} valeur={source} onChoix={setSource} depot={edition} label={media === 'photo' ? t('Photo à restaurer') : t('Clip à restaurer')} />
      {media === 'photo' ? (
        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={nettoyer} onChange={e => setNettoyer(e.target.checked)} /> {t('Réparer : rayures, poussière, bruit, zones passées')}</label>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={couleur} onChange={e => setCouleur(e.target.checked)} /> {t('Coloriser une photo en noir et blanc')}</label>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={hd} onChange={e => setHd(e.target.checked)} /> {t('HD : agrandir et reconstruire le détail')}</label>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={stabilite} onChange={e => setStabilite(e.target.checked)} /> {t('Stabiliser : retirer les tremblements de la caméra')}</label>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={couleur} onChange={e => setCouleur(e.target.checked)} /> {t('Coloriser un clip en noir et blanc (10 s au plus, ~10 min)')}</label>
          <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Clip de 12 s au plus, en dessous de 1080p : SeedVR2 le nettoie et le monte en 1080p, bandes noires retirées, son conservé. Une source minuscule ou très floue gagne en netteté, mais un détail effacé ne revient pas.')}</span>
        </div>
      )}
    </OutilPage>
  )
}
