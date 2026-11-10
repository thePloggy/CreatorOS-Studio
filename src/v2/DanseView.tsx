/* Dance: the person in a photo performs a catalog dance in a 3D studio.
   Layout: the gallery (dances, studios, renders) spans the width; a compact creation panel
   stays visible (left column on desktop, bottom bar on mobile) with the three choices, options
   and the button. The dance (motion capture) is played by a mannequin in the studio with a
   following camera; LTX turns it into a real video, then Swap redraws the dancer from the photo. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Job } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useSuiviOutil } from './OutilPage'
import { FailCard, Ic, JobCard, failedJobs } from './bits'
import { FramePicker } from './popups'
import { posterOf } from '../components/AssetMedia'
import { Aucun, BarreGalerie, Carte, EtapesPanneau, ImageFixe, Squelettes, useCarteAuCentre, useMouvementReduit, useSurvolPossible } from './Galerie'
import { HowItWorks } from './HowItWorks'

interface Danse { slug: string; titre: string; secondes: number | null; v?: number }
interface Studio { id: string; nom: string; v?: number }
type Onglet = 'danses' | 'studios' | 'rendus'
type Reglages = { slug: string; assetId: string; decor: string; suivi: boolean; scene?: string }

/* Dance styles, inferred from the dance name (first matching pattern wins). */
const STYLES_DANSE: { id: string; label: string; motif: RegExp }[] = [
  { id: 'hiphop', label: 'Hip-hop', motif: /hip.?hop|bboy|moonwalk|shuffl/i },
  { id: 'latin', label: 'Latino', motif: /salsa|samba|rumba/i },
  { id: 'retro', label: 'Jazz et rétro', motif: /jazz|swing|can.?can|twist|northern|maraschino/i },
  { id: 'orient', label: 'Danse orientale', motif: /belly/i },
  { id: 'fun', label: 'Pour rire', motif: /chicken|silly/i },
]
const styleDe = (d: Danse) => STYLES_DANSE.find(s => s.motif.test(d.titre))?.id ?? 'libre'
const LIBRE = { id: 'libre', label: 'Freestyle' }

/* Studio families, by id; an unknown studio stays visible under "All". */
const FAMILLES_STUDIO: { id: string; label: string; ids: string[] }[] = [
  { id: 'scene', label: 'Scènes', ids: ['opera', 'concert', 'cabaret', 'bal', 'studio-danse'] },
  { id: 'ville', label: 'Rue et ville', ids: ['ruelle', 'tokyo', 'paris', 'parking', 'basket', 'metro'] },
  { id: 'interieur', label: 'Intérieurs', ids: ['salon', 'loft', 'sport', 'cuisine', 'hotel'] },
  { id: 'dehors', label: 'Plein air', ids: ['toit', 'plage', 'jardin', 'desert'] },
]

const ETAPES = [
  { titre: 'Photo, danse et studio', texte: 'Ton personnage en pied (seuls la personne et sa tenue comptent), une danse du catalogue et le lieu où elle danse.', image: '/vitrine/danse/etape1.webp' },
  { titre: 'La scène 3D', texte: 'La danse, en capture de mouvement, est jouée par un mannequin dans le studio en 3D ; la caméra l’accompagne.', image: '/vitrine/danse/etape2.webp' },
  { titre: 'Le rendu', texte: 'La scène devient une vraie vidéo, et ton personnage est repeint sur le mannequin d’après la photo.', image: '/vitrine/danse/etape3.webp' },
]

/* "How it works": the large montage, then the four steps (cursor videos in the real page). */
const urlHowto = (f: string) => `/danses/${f}?v=20261106`
const ETAPES_HOWTO = [
  { titre: 'Choisis ta photo', texte: 'Une photo en pied de ton personnage, prise dans ta bibliothèque.', fichier: 'howto-1-photo' },
  { titre: 'Choisis la danse', texte: 'Hip-hop, latino, rétro et plus : chaque aperçu montre les pas exacts.', fichier: 'howto-2-danse' },
  { titre: 'Choisis le studio', texte: 'Le lieu de la danse : une scène, une rue, un salon ou le plein air.', fichier: 'howto-3-studio' },
  { titre: 'Reçois ta vidéo de danse', texte: 'Environ 7 minutes plus tard, la vidéo arrive dans Rendus, prête à télécharger.', fichier: 'hero-montage' },
]

const urlDanse = (d: Danse, ext: 'webp' | 'mp4' | 'boucle') => ext === 'boucle' ? `/danses/${d.slug}-boucle.webp?v=${d.v ?? 0}` : `/danses/${d.slug}.${ext}?v=${d.v ?? 0}`
const urlStudio = (x: Studio, grand = false) => `/danses/studio-${x.id}${grand ? '-grand' : ''}.webp?v=${x.v ?? 0}`
const secondes = (d: Danse) => d.secondes ? t('{n} s', { n: Math.round(d.secondes) }) : ''

/* Settings of each launch, kept in the browser for "Redo" and the render caption. */
const CLE_REGLAGES = 'danse:reglages'
const lireReglages = (): Record<string, Reglages> => { try { return JSON.parse(localStorage.getItem(CLE_REGLAGES) ?? '{}') } catch { return {} } }
function noterReglages(id: string, r: Reglages) {
  const tout = lireReglages(); tout[id] = r
  const cles = Object.keys(tout); for (const k of cles.slice(0, Math.max(0, cles.length - 200))) delete tout[k]
  try { localStorage.setItem(CLE_REGLAGES, JSON.stringify(tout)) } catch { /* storage unavailable */ }
}
const CLE_CHOIX = 'danse:choix'
const lireChoix = (): { slug?: string; studio?: string } => { try { return JSON.parse(localStorage.getItem(CLE_CHOIX) ?? '{}') } catch { return {} } }

export function DanseView({ onOpen, goMontage }: { onOpen?: (a: Asset, list: Asset[]) => void; goMontage?: () => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('danse')
  const reduit = useMouvementReduit()
  const survolPossible = useSurvolPossible()
  const [danses, setDanses] = useState<Danse[]>([])
  const [studios, setStudios] = useState<Studio[]>([])
  const [etat, setEtat] = useState<'charge' | 'pret' | 'erreur'>('charge')
  const [studio, setStudio] = useState(() => lireChoix().studio ?? 'salon')
  const [choix, setChoix] = useState<string | null>(() => lireChoix().slug ?? null)
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [picker, setPicker] = useState(false)
  const [scene, setScene] = useState('')
  const [suiviVisage, setSuiviVisage] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)
  const [onglet, setOnglet] = useState<Onglet>('danses')
  const [filtre, setFiltre] = useState('tout')
  const [recherche, setRecherche] = useState('')
  const [options, setOptions] = useState(false)
  const [reglages, setReglages] = useState(lireReglages)
  const galerie = useRef<HTMLDivElement | null>(null)
  const ancre = useRef<HTMLDivElement | null>(null)
  const panneau = useRef<HTMLElement | null>(null)
  const [appel, setAppel] = useState(false)

  const charger = () => {
    setEtat('charge')
    void fetch('/api/danses').then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(d => { setDanses(d.danses ?? []); setStudios(d.studios ?? []); setEtat('pret') })
      .catch(() => setEtat('erreur'))
  }
  useEffect(charger, [])
  useEffect(() => { try { localStorage.setItem(CLE_CHOIX, JSON.stringify({ slug: choix, studio })) } catch { /* storage unavailable */ } }, [choix, studio])

  const danse = danses.find(d => d.slug === choix) ?? null
  const leStudio = studios.find(x => x.id === studio) ?? null
  // switching tab scrolls to the top of the gallery, below "How it works" (never above)
  const changerOnglet = (o: Onglet) => {
    setOnglet(o); setFiltre('tout'); setRecherche('')
    const g = galerie.current; const haut = o === 'rendus' ? 0 : ancre.current?.offsetTop ?? 0
    if (g && g.scrollTop > haut) g.scrollTo({ top: haut })
  }
  // "Start": gallery and creation panel on screen, next step to do highlighted
  const commencer = () => {
    ancre.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' })
    const cible = panneau.current?.querySelector<HTMLElement>('.dz-etape.prochaine') ?? panneau.current?.querySelector<HTMLElement>('.dz-action .cta:not(:disabled)')
    cible?.focus({ preventScroll: true })
    setAppel(true); window.setTimeout(() => setAppel(false), 1600)
  }

  /* The dance is played in 3D in the chosen studio (the set moves with the camera), then the dancer is
     redrawn from the photo: only the person and their outfit are taken from the photo. */
  const lancer = async (r: Reglages) => {
    setOccupe(true); setMsg(null)
    try {
      const rep = await fetch('/api/danses/scene3d', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: r.slug, assetId: r.assetId, decor: r.decor, suivi: r.suivi, ...(r.scene ? { scene: r.scene } : {}) }) })
      const d = await rep.json().catch(() => ({}))
      if (!rep.ok || !d.id) throw new Error(tServeur(d.error) ?? `HTTP ${rep.status}`)
      noterReglages(d.id, r); setReglages(lireReglages())
      suivi.ajouter([d.id]); void s.adoptServerJob(d.id)
      changerOnglet('rendus')
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  const pret = !!choix && !!source?.asset && !occupe
  const generer = () => { if (choix && source?.asset) void lancer({ slug: choix, assetId: source.asset.id, decor: studio, suivi: suiviVisage, scene: scene.trim() || undefined }) }

  // two-pass render: the scene (danse3d-…) then the Swap (danse3d-…-swap); only the final result is shown
  const baseDe = (id: string) => id.replace(/-swap$/, '')
  const suiviDe = (id: string) => suivi.ids.has(baseDe(id))
  const enCours = s.jobs.filter(j => suiviDe(j.id) && STATUTS_ACTIFS.includes(j.status))
  const echecs = failedJobs(s.jobs, true).filter(j => suiviDe(j.id))
  const livres = s.assets.filter(a => a.jobId && String(a.jobId).endsWith('-swap') && suiviDe(String(a.jobId))).slice(0, 60)
  const nbEnCours = new Set(enCours.map(j => baseDe(j.id))).size

  // the tab's gallery, filtered by style and search
  const q = recherche.trim().toLowerCase()
  const dansesVues = useMemo(() => danses.filter(d => (filtre === 'tout' || styleDe(d) === filtre) && (!q || d.titre.toLowerCase().includes(q))), [danses, filtre, q])
  const studiosVus = useMemo(() => studios.filter(x => (filtre === 'tout' || FAMILLES_STUDIO.find(f => f.id === filtre)?.ids.includes(x.id))
    && (!q || t(x.nom).toLowerCase().includes(q) || x.nom.toLowerCase().includes(q))), [studios, filtre, q])
  const puces = onglet === 'danses'
    ? [...STYLES_DANSE, LIBRE].map(p => ({ id: p.id, label: p.label, n: danses.filter(d => styleDe(d) === p.id).length })).filter(p => p.n > 0)
    : onglet === 'studios' ? FAMILLES_STUDIO.map(f => ({ id: f.id, label: f.label, n: studios.filter(x => f.ids.includes(x.id)).length })).filter(p => p.n > 0) : []
  const centre = useCarteAuCentre(!survolPossible && !reduit && onglet !== 'rendus', [onglet, filtre, q, etat])

  const manque = !source?.asset ? (source?.fichier ? t('Choisis une photo de la bibliothèque.') : t('Choisis d’abord la photo du personnage.'))
    : !choix ? t('Choisis une danse dans la galerie.') : null
  const prochaine = !source?.asset ? 1 : !choix ? 2 : 0

  const etapes = [
    { n: 1, label: t('Personnage'), valeur: source?.asset ? t('Photo en pied choisie') : t('Choisir une photo en pied'), fait: !!source?.asset,
      vignette: source?.asset?.uri ?? source?.apercu, icone: 'user' as const, ouvrir: () => setPicker(true), courant: false },
    { n: 2, label: t('Danse'), valeur: danse ? `${danse.titre}${danse.secondes ? ` · ${secondes(danse)}` : ''}` : t('Choisir une danse'), fait: !!danse,
      vignette: danse ? urlDanse(danse, 'webp') : undefined, fixe: true, ouvrir: () => changerOnglet('danses'), courant: onglet === 'danses' },
    { n: 3, label: t('Studio'), valeur: leStudio ? t(leStudio.nom) : t('Choisir un studio'), fait: !!leStudio,
      vignette: leStudio ? urlStudio(leStudio) : undefined, fixe: true, ouvrir: () => changerOnglet('studios'), courant: onglet === 'studios' },
  ]

  return (
    <div className="dz">
      <aside ref={panneau} className={`dz-panneau ${options ? 'options-ouvertes' : ''} ${appel ? 'appel' : ''}`} aria-label={t('Créer une danse')}>
        <header className="dz-tete">
          <h2 className="titre-outil">{t('Danse')}</h2>
          <p>{t('Une photo, une danse, un studio : ton personnage danse avec son visage et sa tenue.')}</p>
        </header>

        <EtapesPanneau etapes={etapes} prochaine={prochaine} />

        {/* the chosen dance and studio, large: the dance plays, the studio animates */}
        <div className="dz-apercu">
          <figure>
            {danse
              ? (reduit
                  ? <video key={danse.slug} src={urlDanse(danse, 'mp4')} poster={urlDanse(danse, 'webp')} muted loop playsInline controls preload="none" />
                  : <video key={danse.slug} src={urlDanse(danse, 'mp4')} poster={urlDanse(danse, 'webp')} muted loop playsInline autoPlay />)
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet('danses')}><span className="vide-icone"><Ic n="play" s={22} /></span>{t('Choisir une danse')}</button>}
            <figcaption>{danse?.titre ?? t('Danse')}</figcaption>
          </figure>
          <figure>
            {leStudio
              ? (reduit ? <ImageFixe src={urlStudio(leStudio, true)} /> : <img key={leStudio.id} src={urlStudio(leStudio, true)} alt="" />)
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet('studios')}><span className="vide-icone"><Ic n="grid" s={22} /></span>{t('Choisir un studio')}</button>}
            <figcaption>{leStudio ? t(leStudio.nom) : t('Studio')}</figcaption>
          </figure>
        </div>

        <div className="dz-options" id="dz-options">
          {/* the step description stays collapsed while empty so the button keeps its position */}
          {options || scene
            ? <label className="dz-champ">
                <span>{t('Le pas, en quelques mots (facultatif, en anglais)')}</span>
                <textarea rows={2} value={scene} maxLength={300} onChange={e => setScene(e.target.value)} placeholder={t('ex. : grand sourire, regard caméra')} />
              </label>
            : <button type="button" className="dz-ajout" onClick={() => setOptions(true)}>+ {t('Le pas, en quelques mots (facultatif, en anglais)')}</button>}
          <label className="dz-bascule">
            <input type="checkbox" checked={suiviVisage} onChange={e => setSuiviVisage(e.target.checked)} />
            <span><b>{t('Caméra verrouillée sur le visage')}</b><small>{t('Cadrage serré qui suit son visage, comme les vidéos de danse des réseaux sociaux.')}</small></span>
          </label>
        </div>

        <div className="dz-action">
          {nbEnCours > 0 && onglet !== 'rendus' && (
            <button type="button" className="dz-en-cours" onClick={() => changerOnglet('rendus')}>
              <i aria-hidden />{t('{n} en cours', { n: nbEnCours })}<span>{t('Voir les rendus')}</span>
            </button>
          )}
          <div className="dz-action-ligne">
            <button type="button" className="dz-options-bouton" aria-expanded={options} aria-controls="dz-options" aria-label={t('Options')} title={t('Options')}
              onClick={() => setOptions(o => !o)}><Ic n="dots" s={16} /></button>
            <button type="button" className="cta" disabled={!pret} onClick={generer} aria-describedby={manque ? 'dz-manque' : undefined}>
              {occupe ? t('Envoi…') : t('Faire danser')} <small>~{t('{m} min', { m: 7 })} · 5 s</small>
            </button>
          </div>
          {msg ? <span className="texte-erreur" role="alert">{msg}</span>
            : manque && <span id="dz-manque" className="dz-manque">{manque}</span>}
        </div>
      </aside>

      <section className="dz-galerie" ref={galerie} aria-label={t('Galerie')}>
        {onglet !== 'rendus' && (
          <HowItWorks cleMemoire="danse:howto-masque" reduit={reduit} onCommencer={commencer}
            hero={{ video: urlHowto('hero-montage.mp4'), affiche: urlHowto('hero-montage.jpg') }} labelHero={t('Exemples de vidéos de danse')}
            titre={t('Fais danser ton personnage')} texte={t('Une photo, une danse, un studio : tu reçois une vraie vidéo de danse, avec son visage et sa tenue.')}
            etapes={ETAPES_HOWTO.map(e => ({ titre: t(e.titre), texte: t(e.texte), video: urlHowto(`${e.fichier}.mp4`), affiche: urlHowto(`${e.fichier}.jpg`) }))} />
        )}
        <div ref={ancre} className="dz-ancre" aria-hidden />
        <BarreGalerie<Onglet> onglet={onglet} onOnglet={changerOnglet}
          onglets={[{ cle: 'danses', label: t('Danses'), n: danses.length }, { cle: 'studios', label: t('Studios'), n: studios.length },
            { cle: 'rendus', label: t('Rendus'), n: livres.length + nbEnCours, enCours: nbEnCours }]}
          recherche={recherche} onRecherche={onglet !== 'rendus' ? setRecherche : undefined}
          placeholder={onglet === 'danses' ? t('Chercher une danse') : t('Chercher un studio')}
          puces={puces} filtre={filtre} onFiltre={setFiltre} />

        {etat === 'erreur' && onglet !== 'rendus' ? (
          <div className="dz-etat">
            <b>{t('Le catalogue des danses ne répond pas.')}</b>
            <button type="button" className="pill" onClick={charger}>{t('Réessayer')}</button>
          </div>
        ) : onglet === 'danses' ? (
          <div className="dz-grille" ref={centre.racine}>
            {etat === 'charge' ? <Squelettes n={10} /> : dansesVues.map(d => (
              <Carte key={d.slug} cle={d.slug} titre={d.titre} detail={secondes(d)} fixe={urlDanse(d, 'webp')} boucle={urlDanse(d, 'boucle')} video={urlDanse(d, 'mp4')}
                choisie={choix === d.slug} auCentre={centre.cle === d.slug} survolPossible={survolPossible} reduit={reduit} onChoisir={() => setChoix(d.slug)} />
            ))}
            {etat === 'pret' && dansesVues.length === 0 && <Aucun onEffacer={() => { setRecherche(''); setFiltre('tout') }} texte={t('Aucune danse ne correspond.')} />}
          </div>
        ) : onglet === 'studios' ? (
          <div className="dz-grille" ref={centre.racine}>
            {etat === 'charge' ? <Squelettes n={10} /> : studiosVus.map(x => (
              <Carte key={x.id} cle={x.id} titre={t(x.nom)} fixe={urlStudio(x)} anime={urlStudio(x)}
                choisie={studio === x.id} auCentre={centre.cle === x.id} survolPossible={survolPossible} reduit={reduit} onChoisir={() => setStudio(x.id)} />
            ))}
            {etat === 'pret' && studiosVus.length === 0 && <Aucun onEffacer={() => { setRecherche(''); setFiltre('tout') }} texte={t('Aucun studio ne correspond.')} />}
          </div>
        ) : (
          <Rendus enCours={enCours} echecs={echecs} livres={livres} reglages={reglages} danses={danses} studios={studios} occupe={occupe}
            onOpen={onOpen} goMontage={goMontage} refaire={r => void lancer(r)} />
        )}
      </section>

      <FramePicker open={picker} onClose={() => setPicker(false)} title={t('Photo du personnage (en pied)')} media="photo"
        assets={s.assets.filter(a => a.mediaType === 'photo' && !a.modele3d)}
        onPickAsset={a => { setSource({ asset: a }); setPicker(false) }}
        onPickUpload={n => { setSource({ fichier: n, apercu: `/api/uploads/${encodeURIComponent(n)}` }); setPicker(false) }} />
    </div>
  )
}

/* The page's renders: in progress (progress), failed (retry), then delivered (playback and actions). */
function Rendus({ enCours, echecs, livres, reglages, danses, studios, occupe, onOpen, goMontage, refaire }: {
  enCours: Job[]
  echecs: Job[]
  livres: Asset[]
  reglages: Record<string, Reglages>
  danses: Danse[]; studios: Studio[]; occupe: boolean
  onOpen?: (a: Asset, list: Asset[]) => void
  goMontage?: () => void
  refaire: (r: Reglages) => void
}) {
  if (enCours.length + echecs.length + livres.length === 0) {
    return (
      <div className="dz-comment">
        <b>{t('Comment ça marche')}</b>
        <div className="outil-etapes">
          {ETAPES.map(e => (
            <div key={e.titre} className="outil-etape">
              <img src={e.image} alt="" loading="lazy" />
              <b>{t(e.titre)}</b>
              <span>{t(e.texte)}</span>
            </div>
          ))}
        </div>
        <span className="texte-faible">{t('Tes rendus apparaîtront ici.')}</span>
      </div>
    )
  }
  return (
    <div className="dz-grille dz-grille-rendus">
      {enCours.map(j => <JobCard key={j.id} j={j} />)}
      {echecs.map(j => <FailCard key={j.id} j={j} />)}
      {livres.map(a => {
        const r = reglages[String(a.jobId).replace(/-swap$/, '')]
        const d = r && danses.find(x => x.slug === r.slug)
        const st = r && studios.find(x => x.id === r.decor)
        return (
          <figure key={a.id} className="dz-rendu">
            <button type="button" className="dz-rendu-media" onClick={() => onOpen?.(a, livres)} aria-label={t('Ouvrir le rendu')}
              onMouseEnter={e => void e.currentTarget.querySelector('video')?.play().catch(() => {})}
              onMouseLeave={e => { const v = e.currentTarget.querySelector('video'); if (v) { v.pause(); v.currentTime = 0 } }}>
              <video src={a.uri} poster={posterOf(a)} muted loop playsInline preload="none" />
              <span className="playmark"><Ic n="play" s={13} /></span>
            </button>
            <figcaption>
              <span className="dz-rendu-titre">{d ? d.titre : t('Danse')}{st ? <small>{t(st.nom)}</small> : null}</span>
              <span className="dz-rendu-gestes">
                <a className="pill" href={a.uri} download><Ic n="download" s={13} />{t('Télécharger')}</a>
                {goMontage && <button type="button" className="pill" onClick={goMontage}>{t('Ouvrir le montage')}</button>}
                {r && <button type="button" className="pill" disabled={occupe} onClick={() => refaire(r)}><Ic n="refresh" s={13} />{t('Refaire')}</button>}
              </span>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}
