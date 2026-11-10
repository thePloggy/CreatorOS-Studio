/* Movie Studio films: below the hero, a row of already shot films. A click reloads the whole film: the step 1
   sheet, its takes (stills) and the timeline (keyframes at their time, actions, character, clip).
   The four studio films ship with it; each shot sent from the timeline is added before them
   (kept in this browser, like the rest of Movie Studio). */
import { useAppStore } from '../store/useAppStore'
import { STATUTS_ACTIFS } from '../types'
import { t } from '../i18n'
import { VERSION_HOWTO } from './HowItWorks'
import { Ic } from './bits'
import type { Etat } from './TableMontage'
import type { Fiche } from '../data/cinema'
import FILMS_STUDIO from './filmsCinema.json'

export type StillFilm = { id: string; uri: string }
export type Film = {
  id: string; nom: string; fiche: Partial<Fiche>; prises: StillFilm[]; table: Etat
  /** card background for studio films (short looping clips) */
  video?: string; affiche?: string
  /** films sent from the timeline: send date */
  date?: number
}

const CLE_FILMS = 'creatoros.cinema.films'
const v = (f: string) => `/danses/howto/${f}?v=${VERSION_HOWTO}`
export const FILMS_DU_STUDIO = FILMS_STUDIO as unknown as Film[]

export function lireFilms(): Film[] {
  try { const l = JSON.parse(localStorage.getItem(CLE_FILMS) ?? '[]'); return Array.isArray(l) ? l : [] } catch { return [] }
}
export function ajouterFilm(f: Film) {
  try {
    localStorage.setItem(CLE_FILMS, JSON.stringify([f, ...lireFilms().filter(x => x.id !== f.id)].slice(0, 24)))
    window.dispatchEvent(new Event('cine:films'))
  } catch { /* storage unavailable */ }
}
function retirerFilm(id: string) {
  localStorage.setItem(CLE_FILMS, JSON.stringify(lireFilms().filter(x => x.id !== id)))
  window.dispatchEvent(new Event('cine:films'))
}

/** Name of a sent film: the start of its first action, otherwise "New film". */
export function nomDeFilm(table: Etat): string {
  const a = (table.actions.find(x => x?.trim()) ?? '').trim().replace(/[.,;:].*$/, '')
  if (!a) return t('Nouveau film')
  const mots = a.split(/\s+/).slice(0, 6).join(' ')
  return mots.charAt(0).toUpperCase() + mots.slice(1) + (a.split(/\s+/).length > 6 ? '…' : '')
}

export function FilmsCinema({ films, onCharger, reduit }: { films: Film[]; onCharger: (f: Film) => void; reduit: boolean }) {
  const s = useAppStore()
  return (
    <section className="cine-films" aria-label={t('Films déjà tournés')}>
      <div className="cine-films-tete">
        <h2>{t('Films déjà tournés')}</h2>
        <span>{t('Clique sur un film pour le charger : sa fiche, ses images et sa table de montage.')}</span>
      </div>
      <div className="cine-films-rangee">
        {films.map(f => {
          // background: the studio's short clip, or the rendered shot, or failing that its first keyframe
          const clip = f.video ? v(f.video) : s.assets.find(a => a.jobId === f.table.rendu?.jobId && a.mediaType === 'video')?.uri ?? f.table.rendu?.uri
          const affiche = f.affiche ? v(f.affiche) : f.table.cles[0]?.uri
          const enCours = !f.video && s.jobs.some(j => j.id === f.table.rendu?.jobId && STATUTS_ACTIFS.includes(j.status))
          return (
            <div key={f.id} className="cine-film">
              <button type="button" className="cine-film-carte" onClick={() => onCharger(f)} title={t('Clique pour le charger dans la table')}>
                {clip && !reduit && !enCours
                  ? <video src={clip} poster={affiche} muted loop playsInline autoPlay preload="metadata" aria-hidden />
                  : affiche ? <img src={affiche} alt="" /> : null}
                <span className="cine-film-texte">
                  <b>{t(f.nom)}</b>
                  <small>{enCours ? t('En cours de rendu…') : t('Clique pour le charger dans la table')}</small>
                </span>
              </button>
              {f.date && <button type="button" className="cine-film-retirer" onClick={() => retirerFilm(f.id)}
                title={t('retirer de la liste')} aria-label={t('retirer de la liste')}><Ic n="x" s={11} /></button>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
