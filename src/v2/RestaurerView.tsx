/* Restaurer : une photo ou un clip abîmé ressort propre et en HD (cf. server/restauration.js).
   Photo : retouche (rayures, poussière, zones passées), couleur au choix, puis agrandissement SeedVR2.
   Clip : SeedVR2 vidéo. Au gabarit studio : réglages à gauche, avant / après puis historique à droite. */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'

type Source = { asset?: Asset; fichier?: string; apercu?: string } | null
type Etape = { etape: string; job: string | null; statut: string | null; uri: string | null }
type Etat = { id: string; media: 'photo' | 'video'; etapes: Etape[]; fini: boolean; uri: string | null; assetId: string | null; echec: boolean }

export function RestaurerView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const suivi = useSuiviOutil('restaurer')
  const [media, setMedia] = useState<'photo' | 'video'>('photo')
  const [source, setSource] = useState<Source>(null)
  const [nettoyer, setNettoyer] = useState(true)
  const [couleur, setCouleur] = useState(false)
  const [hd, setHd] = useState(true)
  const [etat, setEtat] = useState<Etat | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)
  const avant = source?.asset?.uri ?? source?.apercu ?? null

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
        body: JSON.stringify({ media, assetId: source?.asset?.id, fichier: source?.fichier, nettoyer, couleur, hd }) })
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
      {etat.media === 'photo' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <figure style={{ margin: 0, display: 'grid', gap: 4 }}>{avant && <img src={avant} alt="" style={{ width: '100%', borderRadius: 10 }} />}<figcaption className="texte-doux" style={{ fontSize: 12 }}>{t('Avant')}</figcaption></figure>
          <figure style={{ margin: 0, display: 'grid', gap: 4 }}>
            {(etat.uri ?? etat.etapes.findLast(e => e.uri)?.uri)
              ? <img src={(etat.uri ?? etat.etapes.findLast(e => e.uri)?.uri)!} alt="" style={{ width: '100%', borderRadius: 10 }} />
              : <div className="texte-faible" style={{ aspectRatio: '1', display: 'grid', placeItems: 'center', borderRadius: 10, background: 'var(--lv2)' }}>…</div>}
            <figcaption className="texte-doux" style={{ fontSize: 12 }}>{etat.fini ? t('Après') : t('en cours…')}</figcaption>
          </figure>
        </div>
      ) : etat.uri ? <video src={etat.uri} controls playsInline style={{ width: '100%', borderRadius: 10 }} /> : <span className="texte-doux">{t('Le clip se restaure (quelques minutes)…')}</span>}
      {etat.echec && <span className="texte-erreur">{t('Une étape a échoué : réessaie.')}</span>}
    </div>
  ) : undefined

  return (
    <OutilPage titre={t('Restaurer')} texte={t('Une vieille photo ou un clip abîmé ressort propre et en HD : rayures et bruit effacés, couleurs rendues si tu veux, détail reconstruit.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen} resultat={resultat}
      etapes={[
        { titre: 'La source', texte: 'Une photo ou un clip de la bibliothèque ; sur ton studio, aussi un fichier à toi (scan, vieille vidéo).' },
        { titre: 'La retouche', texte: 'Rayures, poussière, taches et zones passées sont réparées, sans changer les visages ni le cadrage. La couleur est en option.' },
        { titre: 'La HD', texte: 'SeedVR2, un modèle de restauration, reconstruit le détail fin et agrandit l’image (le clip jusqu’en 1080p).' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!(source?.asset || source?.fichier) || occupe || (media === 'photo' && !nettoyer && !couleur && !hd)}
          onClick={() => void lancer()}>{occupe ? '…' : t('Restaurer')} <small>{media === 'photo' ? '~1 min' : '~3-5 min'}</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <div className="segmente">
        <button className={media === 'photo' ? 'on' : ''} onClick={() => { setMedia('photo'); setSource(null) }}>{t('Photo')}</button>
        <button className={media === 'video' ? 'on' : ''} onClick={() => { setMedia('video'); setSource(null) }}>{t('Clip')}</button>
      </div>
      <ZoneSource media={media} valeur={source} onChoix={setSource} depot={edition && media === 'photo'} label={media === 'photo' ? t('Photo à restaurer') : t('Clip à restaurer')} />
      {media === 'photo' ? (
        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={nettoyer} onChange={e => setNettoyer(e.target.checked)} /> {t('Réparer : rayures, poussière, bruit, zones passées')}</label>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={couleur} onChange={e => setCouleur(e.target.checked)} /> {t('Coloriser une photo en noir et blanc')}</label>
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={hd} onChange={e => setHd(e.target.checked)} /> {t('HD : agrandir et reconstruire le détail')}</label>
        </div>
      ) : <span className="texte-doux" style={{ fontSize: 12.5 }}>{t('Clip de 12 s au plus, en dessous de 1080p : SeedVR2 le nettoie et le monte en 1080p, son conservé.')}</span>}
    </OutilPage>
  )
}
