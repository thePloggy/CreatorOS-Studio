/* "How it works" header of a gallery page: a large 16:9 montage with title, text and button, then
   the steps as a carousel (one step video at a time, auto-advancing; a cursor clicks in the real
   UI). Collapsible, with the choice stored per page; videos load only once the section is on
   screen and pause off screen. Reduced motion: still images, nothing auto-advances.
   A missing file never shows a broken frame: the video falls back to its poster, the poster to
   the fallback image, and failing that a plain background keeps the layout. */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import { Ic } from './bits'

/** Version of the "How it works" files: changing it forces a reload after the videos are updated. */
export const VERSION_HOWTO = '20261108d'
/** A page's files: /danses/howto/<cle>-hero.mp4|jpg and /danses/howto/<cle>-etape-N.mp4|jpg. */
export const howto = (cle: string) => ({
  hero: { video: `/danses/howto/${cle}-hero.mp4?v=${VERSION_HOWTO}`, affiche: `/danses/howto/${cle}-hero.jpg?v=${VERSION_HOWTO}` },
  etape: (n: number) => ({ video: `/danses/howto/${cle}-etape-${n}.mp4?v=${VERSION_HOWTO}`, affiche: `/danses/howto/${cle}-etape-${n}.jpg?v=${VERSION_HOWTO}` }),
})

export type MediaHowto = { video: string; affiche: string; repli?: string }
/** A timeline segment: its real duration, whether it is generated at this step, its start and end markers. */
export type SegmentFrise = { label: string; duree: number; neuf?: boolean; debut?: string; fin?: string }
export type EtapeHowto = MediaHowto & { titre: string; texte: string; frise?: SegmentFrise[] }

/* Timeline under a step video: the sequence's pieces at their durations, the generated piece
   hatched (being generated) and filling up as the playhead crosses it. */
function Frise({ segments, temps }: { segments: SegmentFrise[]; temps: number }) {
  const total = segments.reduce((n, x) => n + x.duree, 0)
  let debut = 0
  return (
    <div className="frise" aria-hidden>
      <div className="frise-piste">
        {segments.map((x, k) => {
          const d0 = debut; debut += x.duree
          const rempli = Math.max(0, Math.min(1, (temps - d0) / x.duree))
          return (
            <div key={k} className={`frise-seg ${x.neuf ? 'neuf' : ''}`} style={{ flexGrow: x.duree }}>
              {x.neuf && <i className="frise-rempli" style={{ width: `${rempli * 100}%` }} />}
              <span>{x.label}</span>
              {x.debut && <em className="frise-repere g">{x.debut}</em>}
              {x.fin && <em className="frise-repere d">{x.fin}</em>}
            </div>
          )
        })}
        <b className="frise-tete" style={{ left: `${Math.min(100, (temps / total) * 100)}%` }} />
      </div>
    </div>
  )
}

/* A section media: video (loaded once `charger`, playing while `jouer`), else its poster,
   else the fallback, else a background. `fixe`: poster only (reduced motion). */
function Media({ m, charger, jouer, fixe, label, reprendre, afficheToujours, onTemps }: { m: MediaHowto; charger: boolean; jouer: boolean; fixe: boolean; label?: string; reprendre?: boolean; afficheToujours?: boolean; onTemps?: (t: number) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  // 0: video, 1: poster, 2: fallback, 3: background only
  const [niveau, setNiveau] = useState(fixe ? 1 : 0)
  useEffect(() => { setNiveau(fixe ? 1 : 0) }, [fixe, m.video])
  useEffect(() => {
    const v = ref.current; if (!v || niveau !== 0 || !charger) return
    if (jouer) { if (v.paused) { if (reprendre) v.currentTime = 0; void v.play().catch(() => {}) } }
    else v.pause()
  }, [jouer, charger, niveau, reprendre])
  const suivant = () => setNiveau(n => (n === 1 && !m.repli ? 3 : n + 1))
  const alt = label ?? ''
  if (niveau === 0) return (
    <video ref={ref} src={charger ? m.video : undefined} poster={charger || afficheToujours ? m.affiche : undefined} muted loop playsInline preload="none"
      aria-label={label} aria-hidden={label ? undefined : true} onError={suivant} onTimeUpdate={onTemps ? e => onTemps(e.currentTarget.currentTime) : undefined} />
  )
  if (niveau === 1) return <img src={m.affiche} alt={alt} loading="lazy" onError={suivant} />
  if (niveau === 2 && m.repli) return <img src={m.repli} alt={alt} loading="lazy" onError={suivant} />
  return <span className="dz-howto-fond" role={label ? 'img' : undefined} aria-label={label} />
}

export function HowItWorks({ cleMemoire, reduit, hero, titre, texte, etapes, onCommencer, labelCommencer = 'Commencer', labelHero, etapesSeules = false }: {
  /** localStorage key for the section's collapsed state, per page */
  cleMemoire: string
  reduit: boolean
  hero: MediaHowto
  titre: string
  texte: string
  etapes: EtapeHowto[]
  onCommencer: () => void
  labelCommencer?: string
  /** montage description for screen readers */
  labelHero: string
  /** no tab or hero: title, text and button on the left, steps on the right (the page already has its header) */
  etapesSeules?: boolean
}) {
  const [ouvert, setOuvert] = useState(() => { try { return localStorage.getItem(cleMemoire) !== '1' } catch { return true } })
  const basculer = (o: boolean) => {
    setOuvert(o)
    try { if (o) localStorage.removeItem(cleMemoire); else localStorage.setItem(cleMemoire, '1') } catch { /* storage unavailable */ }
  }
  if (!ouvert) return (
    <div className="dz-howto-replie">
      <button type="button" onClick={() => basculer(true)}><Ic n="play" s={11} />{t('Voir comment ça marche')}</button>
    </div>
  )
  return <Section reduit={reduit} hero={hero} titre={titre} texte={texte} etapes={etapes} onCommencer={onCommencer}
    labelCommencer={labelCommencer} labelHero={labelHero} onMasquer={() => basculer(false)} etapesSeules={etapesSeules} />
}

function Section({ reduit, hero, titre, texte, etapes, onCommencer, labelCommencer, labelHero, onMasquer, etapesSeules }: {
  reduit: boolean; hero: MediaHowto; titre: string; texte: string; etapes: EtapeHowto[]
  onCommencer: () => void; labelCommencer: string; labelHero: string; onMasquer: () => void; etapesSeules?: boolean
}) {
  const uid = useId().replace(/:/g, '')
  const racine = useRef<HTMLElement | null>(null)
  const piste = useRef<HTMLDivElement | null>(null)
  const points = useRef<HTMLDivElement | null>(null)
  const pilote = useRef(0)
  const [vu, setVu] = useState(false)
  const [visible, setVisible] = useState(false)
  const [actif, setActif] = useState(0)
  const [pause, setPause] = useState(false)

  // on screen: media load (once) and play; off screen, everything pauses
  useEffect(() => {
    const el = racine.current; if (!el) return
    const io = new IntersectionObserver(([e]) => { setVisible(e.isIntersecting); if (e.isIntersecting) setVu(true) }, { threshold: 0.15 })
    io.observe(el); return () => io.disconnect()
  }, [])

  // scroll the active step into the track (click, keyboard or auto-advance)
  useEffect(() => {
    const p = piste.current; const sl = p?.children[actif] as HTMLElement | undefined
    if (!p || !sl) return // (track not mounted: no-op)
    pilote.current = Date.now()
    p.scrollTo({ left: sl.offsetLeft - parseFloat(getComputedStyle(p).paddingLeft || '0'), behavior: reduit ? 'auto' : 'smooth' })
  }, [actif, reduit])

  // touch swipe: the most visible step becomes the active step
  useEffect(() => {
    const p = piste.current; if (!p) return
    const io = new IntersectionObserver(es => {
      if (Date.now() - pilote.current < 900) return
      const e = es.filter(x => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (e) setActif(Number((e.target as HTMLElement).dataset.i))
    }, { root: p, threshold: 0.6 })
    Array.from(p.children).forEach(c => io.observe(c))
    return () => io.disconnect()
  }, [])

  const aller = (i: number, focus = false) => {
    const n = (i + etapes.length) % etapes.length
    setActif(n)
    if (focus) points.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[n]?.focus()
  }
  const clavier = (e: KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowRight') aller(actif + 1, true)
    else if (k === 'ArrowLeft') aller(actif - 1, true)
    else if (k === 'Home') aller(0, true)
    else if (k === 'End') aller(etapes.length - 1, true)
    else return
    e.preventDefault()
  }
  const arrete = pause || !visible
  const charger = vu && !reduit

  const [vue, setVue] = useState<'apercu' | 'etapes'>(etapesSeules ? 'etapes' : 'apercu')
  const [temps, setTemps] = useState(0)
  useEffect(() => { setTemps(0) }, [actif])
  const e = etapes[actif]

  const blocEtapes = (
        <div className="dz-howto-etapes2" role="region" aria-roledescription={t('carrousel')} aria-label={t('Comment ça marche')}
          onMouseEnter={() => setPause(true)} onMouseLeave={() => setPause(false)} onKeyDown={clavier}>
          <div className="dz-howto-video">
            <Media key={e.video} m={e} charger={vu && !reduit} jouer={visible} fixe={reduit} reprendre onTemps={e.frise ? setTemps : undefined} />
          </div>
          {e.frise && <Frise segments={e.frise} temps={temps} />}
          <div className="dz-howto-legende">
            <span className="dz-howto-surtitre">{t('Comment ça marche')} · {actif + 1}/{etapes.length}</span>
            <h3 id={`${uid}-titre`}>{e.titre}</h3>
            <p>{e.texte}</p>
          </div>
          <div className="dz-howto-nav" role="tablist" aria-label={t('Étapes')} ref={points}>
            <button type="button" className="dz-howto-fleche" aria-label={t('Étape précédente')} onClick={() => aller(actif - 1)}><Ic n="chevron" s={15} /></button>
            {etapes.map((x, i) => (
              <button key={x.video} type="button" role="tab" aria-selected={i === actif} tabIndex={i === actif ? 0 : -1}
                aria-label={`${i + 1}. ${x.titre}`} className={`dz-howto-mini ${i === actif ? 'on' : ''}`} onClick={() => aller(i)}>
                <img src={x.affiche} alt="" loading="lazy" onError={ev => { (ev.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                <b>{i + 1}</b>
                {i === actif && <i key={actif} className={reduit ? 'fixe' : ''} style={{ animationPlayState: arrete ? 'paused' : 'running', animationDuration: x.frise ? `${x.frise.reduce((m, q) => m + q.duree, 0) + 0.4}s` : undefined }}
                  onAnimationEnd={() => aller(actif + 1)} />}
              </button>
            ))}
            <button type="button" className="dz-howto-fleche suiv" aria-label={t('Étape suivante')} onClick={() => aller(actif + 1)}><Ic n="chevron" s={15} /></button>
          </div>
        </div>
  )

  if (etapesSeules) return (
    <section ref={racine} className="dz-howto dz-howto-duo" aria-labelledby={`${uid}-titre-duo`}>
      <div className="dz-howto-duo-texte">
        <span className="dz-howto-surtitre">{t('Comment ça marche')}</span>
        <h2 id={`${uid}-titre-duo`}>{titre}</h2>
        <p>{texte}</p>
        <button type="button" className="cta dz-howto-duo-cta" onClick={onCommencer}><span className="cta-libelle">{t(labelCommencer)}<Ic n="sparkle" s={15} /></span></button>
        <button type="button" className="dz-howto-masquer" onClick={onMasquer}>{t('Masquer')}</button>
      </div>
      {blocEtapes}
    </section>
  )

  return (
    <section ref={racine} className="dz-howto" aria-labelledby={`${uid}-titre`}>
      {/* tabs above the hero: the tool preview, or its steps one by one */}
      <div className="dz-howto-onglets" role="tablist" aria-label={t('Comment ça marche')}>
        <button type="button" role="tab" aria-selected={vue === 'apercu'} className={vue === 'apercu' ? 'on' : ''} onClick={() => setVue('apercu')}>
          <Ic n="sparkle" s={14} />{t('Aperçu')}</button>
        <button type="button" role="tab" aria-selected={vue === 'etapes'} className={vue === 'etapes' ? 'on' : ''} onClick={() => setVue('etapes')}>
          <Ic n="help" s={14} />{t('Comment ça marche')}</button>
        <button type="button" className="dz-howto-masquer" onClick={onMasquer}>{t('Masquer')}</button>
      </div>

      {vue === 'apercu' ? (
        <div className="dz-howto-hero dz-howto-large">
          <div className="dz-howto-media">
            <Media m={hero} charger={charger} jouer={visible} fixe={reduit} label={labelHero} afficheToujours />
          </div>
          <div className="dz-howto-texte">
            <h2 id={`${uid}-titre`}>{titre}</h2>
            <p>{texte}</p>
            <div className="dz-howto-boutons">
              <button type="button" className="dz-howto-cta" onClick={onCommencer}>{t(labelCommencer)}<Ic n="chevron" s={14} /></button>
              <button type="button" className="dz-howto-cta2" onClick={() => { setActif(0); setVue('etapes') }}><Ic n="help" s={14} />{t('Comment ça marche')}</button>
            </div>
          </div>
        </div>
      ) : blocEtapes}
    </section>
  )
}
