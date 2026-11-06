/* Danse : la personne d'une photo danse une danse du catalogue dans un studio en 3D.
   Mise en page : la galerie (danses, studios, rendus) occupe la largeur ; un panneau de création compact
   reste visible (colonne à gauche sur bureau, barre en bas sur téléphone) avec les trois choix, les options
   et le bouton. La danse (capture de mouvement) est jouée par un mannequin dans le studio, caméra qui
   l'accompagne ; LTX en fait une vraie vidéo, puis le Swap redessine la danseuse d'après la photo. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Job } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useSuiviOutil } from './OutilPage'
import { FailCard, Ic, JobCard, failedJobs } from './bits'
import { FramePicker } from './popups'
import { posterOf } from '../components/AssetMedia'

interface Danse { slug: string; titre: string; secondes: number | null; v?: number }
interface Studio { id: string; nom: string; v?: number }
type Onglet = 'danses' | 'studios' | 'rendus'
type Reglages = { slug: string; assetId: string; decor: string; suivi: boolean; scene?: string }

/* Styles de danse, déduits du nom de la danse (le premier motif qui correspond l'emporte). */
const STYLES_DANSE: { id: string; label: string; motif: RegExp }[] = [
  { id: 'hiphop', label: 'Hip-hop', motif: /hip.?hop|bboy|moonwalk|shuffl/i },
  { id: 'latin', label: 'Latino', motif: /salsa|samba|rumba/i },
  { id: 'retro', label: 'Jazz et rétro', motif: /jazz|swing|can.?can|twist|northern|maraschino/i },
  { id: 'orient', label: 'Danse orientale', motif: /belly/i },
  { id: 'fun', label: 'Pour rire', motif: /chicken|silly/i },
]
const styleDe = (d: Danse) => STYLES_DANSE.find(s => s.motif.test(d.titre))?.id ?? 'libre'
const LIBRE = { id: 'libre', label: 'Freestyle' }

/* Familles de studios, par identifiant ; un studio inconnu reste visible sous « Tout ». */
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

const urlDanse = (d: Danse, ext: 'webp' | 'mp4') => `/danses/${d.slug}.${ext}?v=${d.v ?? 0}`
const urlStudio = (x: Studio, grand = false) => `/danses/studio-${x.id}${grand ? '-grand' : ''}.webp?v=${x.v ?? 0}`
const secondes = (d: Danse) => d.secondes ? t('{n} s', { n: Math.round(d.secondes) }) : ''

/* Préférences lues une fois : mouvement réduit, pointeur précis (survol possible). */
const media = (q: string) => typeof window !== 'undefined' && window.matchMedia(q).matches
function usePreference(q: string) {
  const [v, setV] = useState(() => media(q))
  useEffect(() => {
    const mq = window.matchMedia(q); const f = () => setV(mq.matches)
    mq.addEventListener('change', f); return () => mq.removeEventListener('change', f)
  }, [q])
  return v
}

/* Réglages de chaque lancement, gardés dans le navigateur pour « Refaire » et la légende du rendu. */
const CLE_REGLAGES = 'danse:reglages'
const lireReglages = (): Record<string, Reglages> => { try { return JSON.parse(localStorage.getItem(CLE_REGLAGES) ?? '{}') } catch { return {} } }
function noterReglages(id: string, r: Reglages) {
  const tout = lireReglages(); tout[id] = r
  const cles = Object.keys(tout); for (const k of cles.slice(0, Math.max(0, cles.length - 200))) delete tout[k]
  try { localStorage.setItem(CLE_REGLAGES, JSON.stringify(tout)) } catch { /* stockage indisponible */ }
}
const CLE_CHOIX = 'danse:choix'
const lireChoix = (): { slug?: string; studio?: string } => { try { return JSON.parse(localStorage.getItem(CLE_CHOIX) ?? '{}') } catch { return {} } }

/* Image fixe : la première image d'un aperçu animé, dessinée une fois sur un canevas, chargée quand la
   carte approche de l'écran. Les vignettes ne bougent qu'à la demande (survol, carte au centre). */
const images = new Map<string, Promise<HTMLImageElement>>()
function chargerImage(src: string) {
  let p = images.get(src)
  if (!p) {
    p = new Promise((ok, ko) => { const i = new Image(); i.decoding = 'async'; i.onload = () => ok(i); i.onerror = ko; i.src = src })
    p.catch(() => images.delete(src))
    images.set(src, p)
  }
  return p
}
function ImageFixe({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [prete, setPrete] = useState(false)
  useEffect(() => {
    const c = ref.current; if (!c) return
    let fini = false
    const dessiner = () => void chargerImage(src).then(img => {
      if (fini) return
      const ctx = c.getContext('2d'); if (!ctx) return
      // recadrage « cover » au format 9:16 du canevas
      const r = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight)
      const w = img.naturalWidth * r, h = img.naturalHeight * r
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h)
      setPrete(true)
    }).catch(() => {})
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); dessiner() } }, { rootMargin: '400px' })
    io.observe(c)
    return () => { fini = true; io.disconnect() }
  }, [src])
  return <canvas ref={ref} width={360} height={640} className={`dz-fixe ${prete ? 'prete' : ''}`} aria-hidden />
}

/* Une seule carte joue sur écran tactile : la plus proche du centre parmi celles bien visibles. */
function useCarteAuCentre(actif: boolean, deps: unknown[]) {
  const racine = useRef<HTMLDivElement | null>(null)
  const [cle, setCle] = useState<string | null>(null)
  useEffect(() => {
    if (!actif || !racine.current) { setCle(null); return }
    const visibles = new Set<HTMLElement>()
    const io = new IntersectionObserver(es => {
      for (const e of es) (e.intersectionRatio >= 0.7 ? visibles.add(e.target as HTMLElement) : visibles.delete(e.target as HTMLElement))
      const milieu = window.innerHeight / 2
      let meilleur: HTMLElement | null = null; let ecart = Infinity
      for (const el of visibles) {
        const r = el.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - milieu) + r.left / 10
        if (d < ecart) { ecart = d; meilleur = el }
      }
      setCle(meilleur?.dataset.cle ?? null)
    }, { threshold: [0, 0.7, 1] })
    racine.current.querySelectorAll<HTMLElement>('[data-cle]').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [actif, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return { racine, cle }
}

/* Carte de la galerie, au format 9:16 : image fixe au repos, aperçu animé au survol, au clavier ou au centre. */
function Carte({ cle, titre, detail, fixe, anime, video, choisie, auCentre, survolPossible, reduit, onChoisir }: {
  cle: string; titre: string; detail?: string; fixe: string; anime?: string; video?: string
  choisie: boolean; auCentre: boolean; survolPossible: boolean; reduit: boolean; onChoisir: () => void
}) {
  const [survol, setSurvol] = useState(false)
  const [joue, setJoue] = useState(false)
  const enMouvement = !reduit && ((survol && survolPossible) || auCentre)
  useEffect(() => { if (!enMouvement) setJoue(false) }, [enMouvement])
  return (
    <button type="button" data-cle={cle} className={`dz-carte ${choisie ? 'choisie' : ''}`} aria-pressed={choisie}
      aria-label={detail ? `${titre}, ${detail}` : titre} onClick={onChoisir}
      onMouseEnter={() => setSurvol(true)} onMouseLeave={() => setSurvol(false)} onFocus={() => setSurvol(true)} onBlur={() => setSurvol(false)}>
      <ImageFixe src={fixe} />
      {enMouvement && (video
        ? <video className={`dz-anime ${joue ? 'prete' : ''}`} src={video} muted loop playsInline autoPlay preload="none" onPlaying={() => setJoue(true)} aria-hidden />
        : anime && <img className={`dz-anime ${joue ? 'prete' : ''}`} src={anime} alt="" onLoad={() => setJoue(true)} />)}
      {choisie && <span className="dz-coche"><Ic n="check" s={14} /></span>}
      <span className="dz-legende"><b>{titre}</b>{detail && <small>{detail}</small>}</span>
    </button>
  )
}

function Squelettes({ n }: { n: number }) {
  return <>{Array.from({ length: n }, (_, i) => <div key={i} className="dz-carte dz-squelette" aria-hidden />)}</>
}

export function DanseView({ onOpen, goMontage }: { onOpen?: (a: Asset, list: Asset[]) => void; goMontage?: () => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('danse')
  const reduit = usePreference('(prefers-reduced-motion: reduce)')
  const survolPossible = usePreference('(hover: hover) and (pointer: fine)')
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

  const charger = () => {
    setEtat('charge')
    void fetch('/api/danses').then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(d => { setDanses(d.danses ?? []); setStudios(d.studios ?? []); setEtat('pret') })
      .catch(() => setEtat('erreur'))
  }
  useEffect(charger, [])
  useEffect(() => { try { localStorage.setItem(CLE_CHOIX, JSON.stringify({ slug: choix, studio })) } catch { /* stockage indisponible */ } }, [choix, studio])

  const danse = danses.find(d => d.slug === choix) ?? null
  const leStudio = studios.find(x => x.id === studio) ?? null
  const changerOnglet = (o: Onglet) => { setOnglet(o); setFiltre('tout'); setRecherche(''); galerie.current?.scrollTo({ top: 0 }) }

  /* La danse est jouée en 3D dans le studio choisi (le décor bouge avec la caméra), puis la danseuse est
     redessinée d'après la photo : de la photo, seuls la personne et sa tenue comptent. */
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

  // le rendu en deux passes : la scène (danse3d-…) puis le Swap (danse3d-…-swap) ; seul le résultat final s'affiche
  const baseDe = (id: string) => id.replace(/-swap$/, '')
  const suiviDe = (id: string) => suivi.ids.has(baseDe(id))
  const enCours = s.jobs.filter(j => suiviDe(j.id) && STATUTS_ACTIFS.includes(j.status))
  const echecs = failedJobs(s.jobs, true).filter(j => suiviDe(j.id))
  const livres = s.assets.filter(a => a.jobId && String(a.jobId).endsWith('-swap') && suiviDe(String(a.jobId))).slice(0, 60)
  const nbEnCours = new Set(enCours.map(j => baseDe(j.id))).size

  // la galerie de l'onglet, filtrée par style et par recherche
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
      vignette: source?.asset?.uri ?? source?.apercu, ouvrir: () => setPicker(true), courant: false },
    { n: 2, label: t('Danse'), valeur: danse ? `${danse.titre}${danse.secondes ? ` · ${secondes(danse)}` : ''}` : t('Choisir une danse'), fait: !!danse,
      vignette: danse ? urlDanse(danse, 'webp') : undefined, fixe: true, ouvrir: () => changerOnglet('danses'), courant: onglet === 'danses' },
    { n: 3, label: t('Studio'), valeur: leStudio ? t(leStudio.nom) : t('Choisir un studio'), fait: !!leStudio,
      vignette: leStudio ? urlStudio(leStudio) : undefined, fixe: true, ouvrir: () => changerOnglet('studios'), courant: onglet === 'studios' },
  ]

  return (
    <div className="dz">
      <aside className={`dz-panneau ${options ? 'options-ouvertes' : ''}`} aria-label={t('Créer une danse')}>
        <header className="dz-tete">
          <h2 className="titre-outil">{t('Danse')}</h2>
          <p>{t('Une photo, une danse, un studio : ton personnage danse avec son visage et sa tenue.')}</p>
        </header>

        <ol className="dz-etapes">
          {etapes.map(e => (
            <li key={e.n}>
              <button type="button" className={`dz-etape ${e.fait ? 'faite' : ''} ${prochaine === e.n ? 'prochaine' : ''} ${e.courant ? 'courante' : ''}`}
                onClick={e.ouvrir} aria-label={`${e.n}. ${e.label} : ${e.valeur}`}>
                <span className="dz-etape-vignette">
                  {e.vignette ? (e.fixe ? <ImageFixe src={e.vignette} /> : <img src={e.vignette} alt="" />) : <Ic n={e.n === 1 ? 'user' : 'play'} s={16} />}
                  <i className="dz-num">{e.fait ? <Ic n="check" s={10} /> : e.n}</i>
                </span>
                <span className="dz-etape-texte"><small>{e.label}</small><b>{e.valeur}</b></span>
                <span className="dz-etape-chevron"><Ic n="chevron" s={12} /></span>
              </button>
            </li>
          ))}
        </ol>

        {/* la danse et le studio choisis, en grand : la danse joue, le studio s'anime */}
        <div className="dz-apercu">
          <figure>
            {danse
              ? (reduit
                  ? <video key={danse.slug} src={urlDanse(danse, 'mp4')} poster={urlDanse(danse, 'webp')} muted loop playsInline controls preload="none" />
                  : <video key={danse.slug} src={urlDanse(danse, 'mp4')} poster={urlDanse(danse, 'webp')} muted loop playsInline autoPlay />)
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet('danses')}>{t('Choisir une danse')}</button>}
            <figcaption>{danse?.titre ?? t('Danse')}</figcaption>
          </figure>
          <figure>
            {leStudio
              ? (reduit ? <ImageFixe src={urlStudio(leStudio, true)} /> : <img key={leStudio.id} src={urlStudio(leStudio, true)} alt="" />)
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet('studios')}>{t('Choisir un studio')}</button>}
            <figcaption>{leStudio ? t(leStudio.nom) : t('Studio')}</figcaption>
          </figure>
        </div>

        <div className="dz-options" id="dz-options">
          {/* la description du pas reste repliée tant qu'elle est vide : le bouton garde sa place à l'écran */}
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
        <div className="dz-barre">
          <div className="dz-onglets" role="tablist" aria-label={t('Galerie')}>
            {([['danses', t('Danses'), danses.length], ['studios', t('Studios'), studios.length], ['rendus', t('Rendus'), livres.length + nbEnCours]] as [Onglet, string, number][]).map(([k, label, n]) => (
              <button key={k} type="button" role="tab" aria-selected={onglet === k} className={onglet === k ? 'on' : ''} onClick={() => changerOnglet(k)}>
                {label}{n > 0 && <small>{n}</small>}{k === 'rendus' && nbEnCours > 0 && <i className="dz-point" aria-label={t('{n} en cours', { n: nbEnCours })} />}
              </button>
            ))}
          </div>
          {onglet !== 'rendus' && (
            <label className="dz-recherche">
              <span className="dz-sr">{onglet === 'danses' ? t('Chercher une danse') : t('Chercher un studio')}</span>
              <input type="search" value={recherche} onChange={e => setRecherche(e.target.value)} placeholder={onglet === 'danses' ? t('Chercher une danse') : t('Chercher un studio')} />
            </label>
          )}
          {puces.length > 0 && (
            <div className="dz-puces" role="group" aria-label={t('Filtrer')}>
              <button type="button" aria-pressed={filtre === 'tout'} className={filtre === 'tout' ? 'on' : ''} onClick={() => setFiltre('tout')}>{t('Tout')}</button>
              {puces.map(p => (
                <button key={p.id} type="button" aria-pressed={filtre === p.id} className={filtre === p.id ? 'on' : ''} onClick={() => setFiltre(p.id)}>
                  {t(p.label)} <small>{p.n}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        {etat === 'erreur' && onglet !== 'rendus' ? (
          <div className="dz-etat">
            <b>{t('Le catalogue des danses ne répond pas.')}</b>
            <button type="button" className="pill" onClick={charger}>{t('Réessayer')}</button>
          </div>
        ) : onglet === 'danses' ? (
          <div className="dz-grille" ref={centre.racine}>
            {etat === 'charge' ? <Squelettes n={10} /> : dansesVues.map(d => (
              <Carte key={d.slug} cle={d.slug} titre={d.titre} detail={secondes(d)} fixe={urlDanse(d, 'webp')} video={urlDanse(d, 'mp4')}
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

function Aucun({ texte, onEffacer }: { texte: string; onEffacer: () => void }) {
  return (
    <div className="dz-etat dz-etat-grille">
      <b>{texte}</b>
      <button type="button" className="pill" onClick={onEffacer}>{t('Effacer la recherche')}</button>
    </div>
  )
}

/* Les rendus de la page : en cours (progression), en échec (reprise), puis livrés (lecture et gestes). */
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
