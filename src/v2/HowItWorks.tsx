/* « Comment ça marche » en tête d'une page galerie : un grand montage 16:9 avec titre, texte et bouton, puis
   les étapes en carrousel (une vidéo d'étape à la fois, qui avance seule ; un curseur y clique dans la vraie
   interface). Repliable, et le choix est gardé par page ; les vidéos ne se chargent qu'une fois la section à
   l'écran et s'arrêtent hors écran. Mouvement réduit : des images fixes, rien n'avance seul.
   Un fichier absent n'affiche jamais de cadre cassé : la vidéo cède la place à son affiche, l'affiche à
   l'image de repli, et à défaut un fond sobre garde la mise en page. */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import { Ic } from './bits'

/** Version des fichiers « Comment ça marche » : la changer force le rechargement après une mise à jour des vidéos. */
export const VERSION_HOWTO = '20261107b'
/** Les fichiers d'une page : /danses/howto/<cle>-hero.mp4|jpg et /danses/howto/<cle>-etape-N.mp4|jpg. */
export const howto = (cle: string) => ({
  hero: { video: `/danses/howto/${cle}-hero.mp4?v=${VERSION_HOWTO}`, affiche: `/danses/howto/${cle}-hero.jpg?v=${VERSION_HOWTO}` },
  etape: (n: number) => ({ video: `/danses/howto/${cle}-etape-${n}.mp4?v=${VERSION_HOWTO}`, affiche: `/danses/howto/${cle}-etape-${n}.jpg?v=${VERSION_HOWTO}` }),
})

export type MediaHowto = { video: string; affiche: string; repli?: string }
export type EtapeHowto = MediaHowto & { titre: string; texte: string }

/* Un média de la section : vidéo (chargée une fois `charger`, jouée tant que `jouer`), sinon son affiche,
   sinon le repli, sinon un fond. `fixe` : l'affiche seule (mouvement réduit). */
function Media({ m, charger, jouer, fixe, label, reprendre, afficheToujours }: { m: MediaHowto; charger: boolean; jouer: boolean; fixe: boolean; label?: string; reprendre?: boolean; afficheToujours?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  // 0 : vidéo, 1 : affiche, 2 : repli, 3 : fond seul
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
      aria-label={label} aria-hidden={label ? undefined : true} onError={suivant} />
  )
  if (niveau === 1) return <img src={m.affiche} alt={alt} loading="lazy" onError={suivant} />
  if (niveau === 2 && m.repli) return <img src={m.repli} alt={alt} loading="lazy" onError={suivant} />
  return <span className="dz-howto-fond" role={label ? 'img' : undefined} aria-label={label} />
}

export function HowItWorks({ cleMemoire, reduit, hero, titre, texte, etapes, onCommencer, labelCommencer = 'Commencer', labelHero }: {
  /** clé localStorage du repli de la section, propre à la page */
  cleMemoire: string
  reduit: boolean
  hero: MediaHowto
  titre: string
  texte: string
  etapes: EtapeHowto[]
  onCommencer: () => void
  labelCommencer?: string
  /** description du montage pour les lecteurs d'écran */
  labelHero: string
}) {
  const [ouvert, setOuvert] = useState(() => { try { return localStorage.getItem(cleMemoire) !== '1' } catch { return true } })
  const basculer = (o: boolean) => {
    setOuvert(o)
    try { if (o) localStorage.removeItem(cleMemoire); else localStorage.setItem(cleMemoire, '1') } catch { /* stockage indisponible */ }
  }
  if (!ouvert) return (
    <div className="dz-howto-replie">
      <button type="button" onClick={() => basculer(true)}><Ic n="play" s={11} />{t('Voir comment ça marche')}</button>
    </div>
  )
  return <Section reduit={reduit} hero={hero} titre={titre} texte={texte} etapes={etapes} onCommencer={onCommencer}
    labelCommencer={labelCommencer} labelHero={labelHero} onMasquer={() => basculer(false)} />
}

function Section({ reduit, hero, titre, texte, etapes, onCommencer, labelCommencer, labelHero, onMasquer }: {
  reduit: boolean; hero: MediaHowto; titre: string; texte: string; etapes: EtapeHowto[]
  onCommencer: () => void; labelCommencer: string; labelHero: string; onMasquer: () => void
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

  // à l'écran : les médias se chargent (une fois pour toutes) et jouent ; hors écran, tout s'arrête
  useEffect(() => {
    const el = racine.current; if (!el) return
    const io = new IntersectionObserver(([e]) => { setVisible(e.isIntersecting); if (e.isIntersecting) setVu(true) }, { threshold: 0.15 })
    io.observe(el); return () => io.disconnect()
  }, [])

  // l'étape active vient se placer dans la piste (clic, clavier ou avance automatique)
  useEffect(() => {
    const p = piste.current; const sl = p?.children[actif] as HTMLElement | undefined
    if (!p || !sl) return
    pilote.current = Date.now()
    p.scrollTo({ left: sl.offsetLeft - parseFloat(getComputedStyle(p).paddingLeft || '0'), behavior: reduit ? 'auto' : 'smooth' })
  }, [actif, reduit])

  // glisser au doigt : l'étape la plus visible devient l'étape active
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

  return (
    <section ref={racine} className="dz-howto" aria-labelledby={`${uid}-titre`}>
      <div className="dz-howto-grille">
        <div className="dz-howto-hero">
          <div className="dz-howto-media">
            <Media m={hero} charger={charger} jouer={visible} fixe={reduit} label={labelHero} afficheToujours />
          </div>
          <div className="dz-howto-texte">
            <h2 id={`${uid}-titre`}>{titre}</h2>
            <p>{texte}</p>
            <button type="button" className="dz-howto-cta" onClick={onCommencer}>{t(labelCommencer)}<Ic n="chevron" s={14} /></button>
          </div>
        </div>

        <div className="dz-howto-etapes" role="region" aria-roledescription={t('carrousel')} aria-label={t('Comment ça marche')}
          onMouseEnter={() => setPause(true)} onMouseLeave={() => setPause(false)}
          onFocus={() => setPause(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPause(false) }}
          onTouchStart={() => setPause(true)} onTouchEnd={() => setPause(false)} onKeyDown={clavier}>
          <div className="dz-howto-tete">
            <h3>{t('Comment ça marche')}</h3>
            <button type="button" className="dz-howto-masquer" onClick={onMasquer}>{t('Masquer « Comment ça marche »')}</button>
          </div>
          <div className="dz-howto-piste" ref={piste}>
            {etapes.map((e, i) => (
              <figure key={e.video} id={`${uid}-etape-${i}`} data-i={i} className={i === actif ? 'on' : ''}
                role="tabpanel" aria-roledescription={t('étape')} aria-label={t('{n} sur {total}', { n: i + 1, total: etapes.length })}>
                <div className="dz-howto-video">
                  <Media m={e} charger={charger} jouer={i === actif && visible} fixe={reduit} reprendre />
                </div>
                <figcaption><b><i>{i + 1}</i>{e.titre}</b><span>{e.texte}</span></figcaption>
              </figure>
            ))}
          </div>
          <div className="dz-howto-points" role="tablist" aria-label={t('Étapes')} ref={points} style={{ gridTemplateColumns: `repeat(${etapes.length}, minmax(0, 1fr))` }}>
            {etapes.map((e, i) => (
              <button key={e.video} type="button" role="tab" aria-selected={i === actif} aria-controls={`${uid}-etape-${i}`}
                tabIndex={i === actif ? 0 : -1} aria-label={`${i + 1}. ${e.titre}`} className={i === actif ? 'on' : i < actif ? 'passe' : ''}
                onClick={() => aller(i)}>
                <span className="dz-howto-num">{i + 1}</span>
                <span className="dz-howto-barre">
                  {i === actif && <i key={actif} className={reduit ? 'fixe' : ''} style={{ animationPlayState: arrete ? 'paused' : 'running' }}
                    onAnimationEnd={() => aller(actif + 1)} />}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
