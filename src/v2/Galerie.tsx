/* Briques des pages « galerie » (Danse, Camera Moves, Effects, Styles, Relight, effets vidéo…) : une grande
   galerie de cartes qui s'animent à la demande, à côté d'un panneau de création compact à étapes numérotées.
   Les classes `.dz-*` de v2.css portent la mise en page commune, née sur la page Danse. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Asset, Job } from '../types'
import { t } from '../i18n'
import { FailCard, Ic, JobCard } from './bits'
import { posterOf, vignetteOf } from '../components/AssetMedia'

/* Préférences du navigateur, suivies en direct : mouvement réduit, pointeur précis (survol possible). */
const media = (q: string) => typeof window !== 'undefined' && window.matchMedia(q).matches
export function usePreference(q: string) {
  const [v, setV] = useState(() => media(q))
  useEffect(() => {
    const mq = window.matchMedia(q); const f = () => setV(mq.matches)
    mq.addEventListener('change', f); return () => mq.removeEventListener('change', f)
  }, [q])
  return v
}
export const useMouvementReduit = () => usePreference('(prefers-reduced-motion: reduce)')
export const useSurvolPossible = () => usePreference('(hover: hover) and (pointer: fine)')

/* Image fixe : une image dessinée une fois sur un canevas (recadrage « cover »), chargée quand la carte
   approche de l'écran. Sans image (fichier absent), `secours` montre la première image d'une vidéo. */
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
export function ImageFixe({ src, largeur = 360, hauteur = 640, secours }: { src: string; largeur?: number; hauteur?: number; secours?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [prete, setPrete] = useState(false)
  const [rate, setRate] = useState(false)
  useEffect(() => {
    const c = ref.current; if (!c) return
    let fini = false
    setRate(false)
    const dessiner = () => void chargerImage(src).then(img => {
      if (fini) return
      const ctx = c.getContext('2d'); if (!ctx) return
      const r = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight)
      const w = img.naturalWidth * r, h = img.naturalHeight * r
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h)
      setPrete(true)
    }).catch(() => { if (!fini) setRate(true) })
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); dessiner() } }, { rootMargin: '400px' })
    io.observe(c)
    return () => { fini = true; io.disconnect() }
  }, [src])
  return <>
    <canvas ref={ref} width={largeur} height={hauteur} className={`dz-fixe ${prete ? 'prete' : ''}`} aria-hidden />
    {rate && secours && <video className="dz-fixe prete" src={`${secours}#t=0.1`} muted playsInline preload="metadata" aria-hidden />}
  </>
}

/* Une seule carte joue sur écran tactile : la plus proche du centre parmi celles bien visibles. */
export function useCarteAuCentre(actif: boolean, deps: unknown[]) {
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

/* Carte de la galerie (9:16, ou carrée) : image fixe au repos, aperçu animé au survol, au clavier ou au centre.
   `apres` : une seconde image (l'avant / après d'un style), montrée en fondu à la place de l'animation. */
export function Carte({ cle, titre, detail, fixe, anime, video, apres, secours, carree, paysage, badge, lettre, sansLegende, classe, choisie, auCentre, survolPossible, reduit, onChoisir }: {
  cle: string; titre: string; detail?: string; fixe?: string; anime?: string; video?: string; apres?: string; secours?: string
  carree?: boolean; paysage?: boolean; badge?: ReactNode
  /** classe en plus (la carte du vêtement d'un essayage, marquée autrement que la personne) */
  classe?: string
  /** le titre reste pour les lecteurs d'écran, l'image parle seule */
  sansLegende?: boolean
  /** sans image : une lettre (ou un format) sur un fond sobre */
  lettre?: string
  choisie: boolean; auCentre: boolean; survolPossible: boolean; reduit: boolean; onChoisir: () => void
}) {
  const [survol, setSurvol] = useState(false)
  const [joue, setJoue] = useState(false)
  const [videoRatee, setVideoRatee] = useState(false)
  const enMouvement = !reduit && ((survol && survolPossible) || auCentre)
  useEffect(() => { if (!enMouvement) setJoue(false) }, [enMouvement])
  const src = videoRatee ? secours : video
  return (
    <button type="button" data-cle={cle} className={`dz-carte ${carree ? 'carree' : ''} ${paysage ? 'paysage' : ''} ${choisie ? 'choisie' : ''} ${classe ?? ''}`} aria-pressed={choisie}
      aria-label={detail ? `${titre}, ${detail}` : titre} onClick={onChoisir}
      onMouseEnter={() => setSurvol(true)} onMouseLeave={() => setSurvol(false)} onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setSurvol(true) }} onBlur={() => setSurvol(false)}>
      {fixe ? <ImageFixe src={fixe} largeur={paysage ? 640 : carree ? 480 : 360} hauteur={paysage ? 360 : carree ? 480 : 640} secours={secours ?? video} />
        : <span className="dz-carte-lettre" aria-hidden>{lettre ?? titre.slice(0, 1)}</span>}
      {enMouvement && (src
        ? <video className={`dz-anime ${joue ? 'prete' : ''}`} src={src} muted loop playsInline autoPlay preload="none" onPlaying={() => setJoue(true)}
            onError={() => { if (!videoRatee && secours) setVideoRatee(true) }} aria-hidden />
        : (anime ?? apres) && <img className={`dz-anime ${joue ? 'prete' : ''}`} src={anime ?? apres} alt="" onLoad={() => setJoue(true)} />)}
      {badge && <span className="dz-badge">{badge}</span>}
      {choisie && <span className="dz-coche"><Ic n="check" s={14} /></span>}
      {!sansLegende && <span className="dz-legende"><b>{titre}</b>{detail && <small>{detail}</small>}</span>}
    </button>
  )
}

export function Squelettes({ n, carree }: { n: number; carree?: boolean }) {
  return <>{Array.from({ length: n }, (_, i) => <div key={i} className={`dz-carte dz-squelette ${carree ? 'carree' : ''}`} aria-hidden />)}</>
}

export function Aucun({ texte, onEffacer }: { texte: string; onEffacer: () => void }) {
  return (
    <div className="dz-etat dz-etat-grille">
      <b>{texte}</b>
      <button type="button" className="pill" onClick={onEffacer}>{t('Effacer la recherche')}</button>
    </div>
  )
}

/* Barre de la galerie : onglets (avec compteurs), recherche, puces de filtre. */
export type OngletGalerie<K extends string> = { cle: K; label: string; n?: number; enCours?: number }
/* une icône par onglet, devinée de sa clé : la galerie de l'outil, la bibliothèque, les rendus */
function iconeOnglet(cle: string): Parameters<typeof Ic>[0]['n'] {
  if (cle === 'rendus') return 'folder'
  if (cle === 'biblio') return 'image'
  if (/effet/.test(cle)) return 'sparkle'
  if (/danse|mouvement|move/.test(cle)) return 'play'
  if (/camera/.test(cle)) return 'camera'
  return 'grid'
}

export function BarreGalerie<K extends string>({ onglets, onglet, onOnglet, recherche, onRecherche, placeholder, puces, filtre, onFiltre }: {
  onglets: OngletGalerie<K>[]; onglet: K; onOnglet: (k: K) => void
  recherche?: string; onRecherche?: (v: string) => void; placeholder?: string
  puces?: { id: string; label: string; n: number }[]; filtre?: string; onFiltre?: (id: string) => void
}) {
  return (
    <div className="dz-barre">
      <div className="dz-onglets" role="tablist" aria-label={t('Galerie')}>
        {onglets.map(o => (
          <button key={o.cle} type="button" role="tab" aria-selected={onglet === o.cle} className={onglet === o.cle ? 'on' : ''} onClick={() => onOnglet(o.cle)}>
            <Ic n={iconeOnglet(String(o.cle))} s={14} />{o.label}{!!o.n && <small>{o.n}</small>}{!!o.enCours && <i className="dz-point" aria-label={t('{n} en cours', { n: o.enCours })} />}
          </button>
        ))}
      </div>
      {onRecherche && (
        <label className="dz-recherche">
          <span className="dz-sr">{placeholder}</span>
          <input type="search" value={recherche} onChange={e => onRecherche(e.target.value)} placeholder={placeholder} />
        </label>
      )}
      {puces && puces.length > 0 && onFiltre && (
        <div className="dz-puces" role="group" aria-label={t('Filtrer')}>
          <button type="button" aria-pressed={filtre === 'tout'} className={filtre === 'tout' ? 'on' : ''} onClick={() => onFiltre('tout')}>{t('Tout')}</button>
          {puces.map(p => (
            <button key={p.id} type="button" aria-pressed={filtre === p.id} className={filtre === p.id ? 'on' : ''} onClick={() => onFiltre(p.id)}>
              {t(p.label)} <small>{p.n}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* Étapes du panneau : chaque ligne ouvre son choix ; la prochaine à faire est soulignée. */
export type EtapePanneau = { n: number; label: string; valeur: string; fait: boolean; vignette?: string; fixe?: boolean; carree?: boolean
  icone?: 'user' | 'play' | 'image' | 'camera' | 'grid' | 'sound' | 'edit'; ouvrir: () => void; courant?: boolean }
export function EtapesPanneau({ etapes, prochaine }: { etapes: EtapePanneau[]; prochaine: number }) {
  return (
    <ol className="dz-etapes">
      {etapes.map(e => (
        <li key={e.n}>
          <button type="button" className={`dz-etape ${e.fait ? 'faite' : ''} ${prochaine === e.n ? 'prochaine' : ''} ${e.courant ? 'courante' : ''}`}
            onClick={e.ouvrir} aria-label={`${e.n}. ${e.label} : ${e.valeur}`}>
            <span className="dz-etape-vignette">
              {e.vignette ? (e.fixe ? <ImageFixe src={e.vignette} largeur={e.carree ? 480 : 360} hauteur={e.carree ? 480 : 640} /> : <img src={e.vignette} alt="" />) : <Ic n={e.icone ?? 'play'} s={16} />}
              <i className="dz-num">{e.fait ? <Ic n="check" s={10} /> : e.n}</i>
            </span>
            <span className="dz-etape-texte"><small>{e.label}</small><b>{e.valeur}</b></span>
            <span className="dz-etape-chevron"><Ic n="chevron" s={12} /></span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/* Onglet Rendus d'une page galerie : en cours (progression), en échec (reprise), puis livrés (lecture et gestes).
   Rien encore : `vide` (en général une phrase et un bouton vers la galerie). */
export function RendusGalerie({ enCours, echecs, livres, legende, onOpen, gestes, vide, photo }: {
  enCours: Job[]; echecs: Job[]; livres: Asset[]
  legende: (a: Asset) => { titre: string; detail?: string }
  onOpen?: (a: Asset, list: Asset[]) => void
  /** gestes propres à la page (Refaire…), après Télécharger */
  gestes?: (a: Asset) => ReactNode
  vide: ReactNode
  /** rendus photo : vignette fixe au format 4:5 */
  photo?: boolean
}) {
  if (enCours.length + echecs.length + livres.length === 0) return <div className="dz-rendus-vide">{vide}</div>
  return (
    <div className={`dz-grille dz-grille-rendus ${photo ? 'photos' : ''}`}>
      {enCours.map(j => <JobCard key={j.id} j={j} />)}
      {echecs.map(j => <FailCard key={j.id} j={j} />)}
      {livres.map(a => {
        const l = legende(a)
        const video = a.mediaType === 'video'
        return (
          <figure key={a.id} className="dz-rendu">
            <button type="button" className="dz-rendu-media" onClick={() => onOpen?.(a, livres)} aria-label={t('Ouvrir le rendu')}
              onMouseEnter={e => void e.currentTarget.querySelector('video')?.play().catch(() => {})}
              onMouseLeave={e => { const v = e.currentTarget.querySelector('video'); if (v) { v.pause(); v.currentTime = 0 } }}>
              {video ? <video src={a.uri} poster={posterOf(a)} muted loop playsInline preload="none" /> : <img src={vignetteOf(a)} alt="" loading="lazy" />}
              {video && <span className="playmark"><Ic n="play" s={13} /></span>}
            </button>
            <figcaption>
              <span className="dz-rendu-titre">{l.titre}{l.detail ? <small>{l.detail}</small> : null}</span>
              <span className="dz-rendu-gestes">
                <a className="pill" href={a.uri} download><Ic n="download" s={13} />{t('Télécharger')}</a>
                {gestes?.(a)}
              </span>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}

/* Bas du panneau : rendus en cours, bouton d'options (téléphone), bouton principal, ce qui manque encore. */
export function ActionPanneau({ id, nbEnCours, onVoirRendus, options, onOptions, pret, onLancer, label, detail, manque, msg, avecOptions = true }: {
  id: string
  nbEnCours: number; onVoirRendus?: () => void
  options: boolean; onOptions: () => void
  pret: boolean; onLancer: () => void
  label: string; detail?: string
  manque: string | null; msg: string | null
  avecOptions?: boolean
}) {
  return (
    <div className="dz-action">
      {nbEnCours > 0 && onVoirRendus && (
        <button type="button" className="dz-en-cours" onClick={onVoirRendus}>
          <i aria-hidden />{t('{n} en cours', { n: nbEnCours })}<span>{t('Voir les rendus')}</span>
        </button>
      )}
      <div className="dz-action-ligne">
        {onVoirRendus && <button type="button" className="dz-carre" onClick={onVoirRendus} title={t('Voir les rendus')} aria-label={t('Voir les rendus')}>
          <Ic n="folder" s={18} />{nbEnCours > 0 && <i>{nbEnCours}</i>}</button>}
        {avecOptions && <button type="button" className="dz-options-bouton" aria-expanded={options} aria-controls={`${id}-options`} aria-label={t('Options')} title={t('Options')}
          onClick={onOptions}><Ic n="dots" s={16} /></button>}
        <button type="button" className="cta" disabled={!pret} onClick={onLancer} aria-describedby={manque ? `${id}-manque` : undefined}>
          <span className="cta-libelle">{label}<Ic n="sparkle" s={15} /></span> {detail && <small>{detail}</small>}
        </button>
      </div>
      {msg ? <span className="texte-erreur" role="alert">{msg}</span>
        : manque && <span id={`${id}-manque`} className="dz-manque">{manque}</span>}
    </div>
  )
}

/* Réglages d'un lancement, gardés dans le navigateur pour « Refaire » et la légende du rendu. */
export function memoireReglages<R>(cle: string) {
  const lire = (): Record<string, R> => { try { return JSON.parse(localStorage.getItem(cle) ?? '{}') } catch { return {} } }
  const noter = (id: string, r: R) => {
    const tout = lire(); tout[id] = r
    const cles = Object.keys(tout); for (const k of cles.slice(0, Math.max(0, cles.length - 200))) delete tout[k]
    try { localStorage.setItem(cle, JSON.stringify(tout)) } catch { /* stockage indisponible */ }
  }
  return { lire, noter }
}
