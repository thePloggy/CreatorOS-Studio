/* Gabarit d'un outil : volet de réglages à gauche (source en haut, action en bas), résultats de
   l'outil à droite, rendus en cours compris. Sur téléphone, le volet passe au-dessus. */
import { useRef, useState, type ReactNode } from 'react'
import type { Asset, Job } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { AssetCard, BatchCard, JobCard, groupLotsPhotos } from './bits'
import { BatchViewer } from './popups'
import { FramePicker } from './popups'
import { HowItWorks, howto as fichiersHowto } from './HowItWorks'
import { useMouvementReduit } from './Galerie'

export type Etape = { titre: string; texte: string; image?: string }

/** « Comment ça marche » au gabarit de Dance : montage 16:9 (/danses/howto/<cle>-hero.mp4) et une vidéo par étape. */
export type HowtoPage = { cle: string; titre: string; texte: string; label: string; repli?: string }

export function OutilPage({ titre, texte, children, action, jobs, assets, vide, onOpen, etapes, resultat, howto, lots }: {
  titre: string
  texte?: string
  children: ReactNode
  /** le bouton principal, posé en bas du volet */
  action?: ReactNode
  /** les rendus de l'outil : en cours, puis livrés */
  jobs?: (j: Job) => boolean
  assets?: (a: Asset) => boolean
  vide?: ReactNode
  onOpen?: (a: Asset, list: Asset[]) => void
  /** « Comment ça marche » : affiché tant que l'outil n'a rien rendu, et dans son onglet */
  etapes?: Etape[]
  /** un résultat propre à l'outil, posé au-dessus de l'historique */
  resultat?: ReactNode
  /** section « Comment ça marche » en tête des résultats (les étapes sont celles de `etapes`) */
  howto?: HowtoPage
  /** les rendus d'un même lot (carrousel) tiennent sur une carte, comme sur la page Image */
  lots?: boolean
}) {
  const [lotOuvert, setLotOuvert] = useState<string | null>(null)
  const reduit = useMouvementReduit()
  const volet = useRef<HTMLElement | null>(null)
  const s = useAppStore()
  const enCours = jobs ? s.jobs.filter(j => jobs(j) && !['done', 'failed', 'cancelled', 'blocked'].includes(String(j.status))) : []
  const livres = assets ? s.assets.filter(assets).slice(0, 60) : []
  const rien = enCours.length === 0 && livres.length === 0 && !resultat
  const [onglet, setOnglet] = useState<'historique' | 'comment'>('historique')
  const voirComment = !!etapes && !howto && (onglet === 'comment' || rien)
  return (
    <div className="outil-page">
      <div className="vside-place fixe">
        <aside ref={volet} className="vside outil-volet">
          <div style={{ display: 'grid', gap: 4 }}>
            <h2 className="titre-outil" style={{ margin: 0 }}>{titre}</h2>
            {texte && <span className="texte-doux" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{texte}</span>}
          </div>
          {children}
          {action && <div className="outil-action">{action}</div>}
        </aside>
      </div>
      <div className="outil-resultats">
        {howto && (() => {
          const f = fichiersHowto(howto.cle), E = etapes ?? []
          return <HowItWorks cleMemoire={`hiw:${howto.cle}`} reduit={reduit} labelHero={t(howto.label)} titre={t(howto.titre)} texte={t(howto.texte)}
            hero={{ ...f.hero, repli: howto.repli }} labelCommencer={t('Commencer')}
            onCommencer={() => volet.current?.querySelector<HTMLElement>('button:not(:disabled), input, textarea, select')?.focus()}
            etapes={E.map((e, i) => ({ titre: t(e.titre), texte: t(e.texte), ...(i === E.length - 1 ? { ...f.hero, repli: howto.repli } : { ...f.etape(i + 1), repli: e.image }) }))} />
        })()}
        {etapes && !howto && <div className="outil-onglets" role="tablist">
          <button role="tab" aria-selected={!voirComment} className={!voirComment ? 'on' : ''} onClick={() => setOnglet('historique')}>{t('Historique')}</button>
          <button role="tab" aria-selected={voirComment} className={voirComment ? 'on' : ''} onClick={() => setOnglet('comment')}>{t('Comment ça marche')}</button>
        </div>}
        {voirComment
          ? <div className="outil-comment">
              <b>{t('Comment ça marche')}</b>
              <div className="outil-etapes">
                {etapes!.map((e, i) => (
                  <div key={e.titre} className="outil-etape">
                    {e.image ? <img src={e.image} alt="" loading="lazy" /> : <i>{i + 1}</i>}
                    <b>{t(e.titre)}</b>
                    <span>{t(e.texte)}</span>
                  </div>
                ))}
              </div>
              {rien && <span className="texte-faible">{vide ?? t('Tes rendus apparaîtront ici.')}</span>}
            </div>
          : <>
              {resultat}
              {rien ? <div className="outil-vide">{vide ?? t('Tes rendus apparaîtront ici.')}</div>
                : <div className="outil-grille">
                    {enCours.map(j => <JobCard key={j.id} j={j} />)}
                    {lots
                      ? groupLotsPhotos(livres).map(it => it.kind === 'batch'
                          ? <BatchCard key={`lot-${it.id}`} items={it.items} onOpen={() => setLotOuvert(it.id)} />
                          : <AssetCard key={it.a.id} a={it.a} onOpen={x => onOpen?.(x, livres)} />)
                      : livres.map(a => <AssetCard key={a.id} a={a} onOpen={x => onOpen?.(x, livres)} />)}
                  </div>}
            </>}
      </div>
      {lotOuvert && (() => {
        const items = livres.filter(a => a.batchId === lotOuvert || (a.batchIds ?? []).includes(lotOuvert))
        return items.length ? <BatchViewer items={items} onClose={() => setLotOuvert(null)} onOpenAsset={a => { setLotOuvert(null); onOpen?.(a, items) }} /> : null
      })()}
    </div>
  )
}

/* Zone source : un média de la bibliothèque, ou un fichier déposé (propriétaire sur la démo). */
export function ZoneSource({ media, valeur, onChoix, depot, label }: {
  media: 'photo' | 'video'
  valeur: { asset?: Asset; fichier?: string; apercu?: string } | null
  onChoix: (v: { asset?: Asset; fichier?: string; apercu?: string } | null) => void
  /** dépôt d'un fichier autorisé ici */
  depot?: boolean
  label: string
}) {
  const assets = useAppStore(s => s.assets)
  const [ouvert, setOuvert] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const deposer = async (f: File) => {
    setMsg(null)
    const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    onChoix({ fichier: d.filename, apercu: URL.createObjectURL(f) })
  }
  const apercu = valeur?.asset?.uri ?? valeur?.apercu
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span className="etiquette">{label}</span>
      <button className={`zone-source ${apercu ? 'pleine' : ''}`} onClick={() => setOuvert(true)}>
        {apercu
          ? (media === 'video' ? <video src={apercu} muted playsInline preload="metadata" /> : <img src={apercu} alt="" />)
          : <span>{media === 'video' ? t('Choisir un clip') : t('Choisir une photo')}<small>{depot ? t('bibliothèque ou fichier') : t('dans la bibliothèque')}</small></span>}
      </button>
      {apercu && <button className="pill" style={{ justifySelf: 'start' }} onClick={() => onChoix(null)}>{t('Retirer')}</button>}
      {msg && <span className="texte-erreur">{msg}</span>}
      <FramePicker open={ouvert} onClose={() => setOuvert(false)} title={label} media={media} assets={assets.filter(a => a.mediaType === media && !a.modele3d)}
        onPickAsset={a => { onChoix({ asset: a }); setOuvert(false) }} onPickUpload={n => { onChoix({ fichier: n, apercu: `/api/uploads/${encodeURIComponent(n)}` }); setOuvert(false) }}
        onUploadFile={depot ? f => void deposer(f) : undefined} accept={media === 'video' ? 'video/*' : 'image/*'} />
    </div>
  )
}

/** Les rendus lancés depuis un outil, gardés par navigateur pour afficher ses résultats. */
export function useSuiviOutil(cle: string) {
  const lire = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(`outil:${cle}`) ?? '[]')) } catch { return new Set<string>() } }
  const [ids, setIds] = useState<Set<string>>(lire)
  // écrit tout de suite : un lancement qui fait changer de page (retouche, boucle) est suivi quand même
  const ajouter = (nouveaux: (string | null | undefined)[]) => {
    const n = lire(); for (const x of nouveaux) if (x) n.add(x)
    try { localStorage.setItem(`outil:${cle}`, JSON.stringify([...n].slice(-300))) } catch { /* stockage indisponible */ }
    setIds(n)
  }
  return { ids, ajouter }
}
