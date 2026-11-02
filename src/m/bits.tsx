/* ============================================================
   CreatorOS mobile — briques partagées.
   Rien de métier ici : le métier vit dans le store partagé avec
   le desktop (src/store/useAppStore). Ce fichier ne porte que des
   composants de présentation tactile.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getLang, t } from '../i18n'

/* ---------- icônes (outline 1.7, jeu commun à toute l'app mobile) ---------- */
const P = {
  library: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /></>,
  create: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  jobs: <><path d="M3 6h11" /><path d="M3 12h7" /><path d="M3 18h11" /><path d="M16 10l5 4-5 4z" /></>,
  studio: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  filters: <><path d="M4 6h16" /><path d="M7 12h10" /><path d="M10 18h4" /></>,
  folder: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
  triage: <><path d="M2 12l4 4L14 8" /><path d="M10 16l2 2 8-10" /></>,
  heart: <><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1z" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  skip: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  clone: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  back: <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  wand: <><path d="m15 4 1.5 3L20 8.5 16.5 10 15 13l-1.5-3L10 8.5 13.5 7z" /><path d="m7 14 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /><path d="M4 21 14 11" /></>,
  at: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>,
  swap: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>,
  brush: <><path d="M9.06 11.9 16.5 4.5a2.1 2.1 0 1 1 3 3l-7.4 7.44" /><path d="M5 21c2 0 4-1 4-4a2.5 2.5 0 1 0-5 0c0 1.5-.5 2.5-2 3 .8.7 1.9 1 3 1z" /></>,
  film: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 4v16M17 4v16M2 12h20" /></>,
  replay: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>,
  extend: <><path d="M4 5v14" /><path d="M8 12h9" /><path d="m13 8 4 4-4 4" /><path d="M20 5v14" /></>,
  hd: <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /><path d="M4 21h16" /></>,
  play: <><path d="M7 4v16l13-8z" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  tag: <><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M7.5 7.5h.01" /></>,
}
export type IcName = keyof typeof P
export function Ic({ n, s = 20 }: { n: IcName; s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[n]}</svg>
  )
}

/* ---------- feuille modale ----------
   Un SEUL dialogue ouvert à la fois : le montage d'une
   feuille ferme la précédente.

   Le verrou est indexé par IDENTITÉ d'instance, pas par fonction. En
   développement React monte, démonte puis remonte chaque effet : un verrou
   naïf ferait fermer la feuille par son PROPRE remontage — elle ne
   s'ouvrirait jamais. Comparer les identités règle le cas sans dépendre du
   mode de rendu. */
let top: { id: symbol; close: () => void } | null = null

export function Sheet({ title, onClose, children, maxHeight }: {
  title: string; onClose: () => void; children: React.ReactNode; maxHeight?: string
}) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const idRef = useRef<symbol>(undefined as unknown as symbol)
  if (!idRef.current) idRef.current = Symbol('sheet')

  useEffect(() => {
    const id = idRef.current
    const onPop = () => onCloseRef.current()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    let armed = false

    /* Tout l'effet est DIFFÉRÉ d'un tour de boucle. En développement React
       monte, démonte puis remonte chaque effet : le `history.back()` du
       démontage produisait un `popstate` qui arrivait APRÈS le remontage et
       refermait aussitôt la feuille — elle ne s'ouvrait jamais. Différer
       laisse le cycle factice s'annuler avant d'avoir touché à quoi que ce
       soit. */
    const timer = window.setTimeout(() => {
      armed = true
      if (top && top.id !== id) top.close()
      top = { id, close: () => onCloseRef.current() }
      /* Retour matériel Android et geste de retour : une entrée d'historique
         à l'ouverture, consommée à la fermeture, pour que « Retour » ferme
         la feuille au lieu de quitter l'espace. */
      window.history.pushState({ sheet: id.toString() }, '')
      window.addEventListener('popstate', onPop)
      window.addEventListener('keydown', onKey)
    }, 0)

    return () => {
      window.clearTimeout(timer)
      if (!armed) return
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey)
      if (top?.id === id) top = null
      // on ne retire QUE notre propre entrée d'historique
      if (window.history.state?.sheet === id.toString()) window.history.back()
    }
  }, [])
  return createPortal(
    <div className="m sheetwrap" role="dialog" aria-modal="true" aria-label={title}>
      <div className="veil" onClick={onClose} />
      <div className="sheet" style={maxHeight ? { maxHeight } : undefined}>
        <div className="grab" />
        <h2>{title}</h2>
        <div className="body">{children}</div>
      </div>
    </div>, document.body)
}

/** Ligne d'option d'une feuille : libellé + coche si sélectionnée. */
export function Opt({ label, hint, on, onClick }: {
  label: string; hint?: string; on?: boolean; onClick: () => void
}) {
  return (
    <button className="opt" onClick={onClick} aria-pressed={on}>
      <span style={{ flex: 1 }}>
        {label}
        {hint && <small style={{ display: 'block', color: 'var(--tx2)', fontSize: 13 }}>{hint}</small>}
      </span>
      {on && <span className="ck"><Ic n="check" s={18} /></span>}
    </button>
  )
}

/* ---------- segment ---------- */
export function Seg<T extends string>({ value, options, onPick, accent }: {
  value: T; options: [T, string][]; onPick: (v: T) => void; accent?: boolean
}) {
  return (
    <div className={`seg ${accent ? 'acc' : ''}`} role="tablist">
      {options.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k}
          className={value === k ? 'on' : ''} onClick={() => onPick(k)}>{label}</button>
      ))}
    </div>
  )
}

/* ---------- stepper − N + ---------- */
export function Stepper({ value, min = 1, max = 10, onChange, label }: {
  value: number; min?: number; max?: number; onChange: (n: number) => void; label?: string
}) {
  return (
    <div className="stepper" role="group" aria-label={label ?? t('quantité')}>
      <button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={t('moins')}>−</button>
      <span aria-live="polite">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={t('plus')}>+</button>
    </div>
  )
}

/* ---------- interrupteur ---------- */
export function Toggle({ on, title, hint, onChange, disabledReason }: {
  on: boolean; title: string; hint?: string; onChange: (v: boolean) => void; disabledReason?: string
}) {
  return (
    <button className={`tgl ${on ? 'on' : ''}`} role="switch" aria-checked={on}
      onClick={() => { if (!disabledReason) onChange(!on) }}
      style={disabledReason ? { opacity: .5 } : undefined}>
      <span className="txt">
        <b>{title}</b>
        {/* La raison d'indisponibilité remplace l'aide : on n'a jamais un
            contrôle éteint sans explication. */}
        <small>{disabledReason ?? hint}</small>
      </span>
      <span className="sw" />
    </button>
  )
}

/* ---------- durées ---------- */
export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${m} min`
}

/** Libellé de jour lisible : aujourd'hui / hier / « vendredi 12 septembre ». */
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
export function dayLabel(ts: number, now = new Date()) {
  const d = new Date(ts)
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (key(d) === key(now)) return t("aujourd'hui")
  if (key(d) === key(y)) return t('hier')
  const sameYear = d.getFullYear() === now.getFullYear()
  if (getLang() === 'en') return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`
}

/* ---------- confirmation à deux temps ---------- */
export function useConfirm(delay = 3200): [boolean, () => boolean] {
  const [armed, setArmed] = useState(false)
  const t = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(t.current), [])
  return [armed, () => {
    if (armed) { window.clearTimeout(t.current); setArmed(false); return true }
    setArmed(true)
    t.current = window.setTimeout(() => setArmed(false), delay)
    return false
  }]
}
