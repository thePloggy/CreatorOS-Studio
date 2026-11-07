/* ============================================================
   @ dans le prompt : taper « @jes » propose les personnages et les
   éléments (tenues, lieux, poses, styles). Un personnage devient le personnage
   actif et le mot disparaît ; un élément est remplacé par son texte.
   / en début de mot : les commandes de la page (préréglages, Enhancer, Éléments…).
   ============================================================ */
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { EL_GROUPS } from './popups'
import { t } from '../i18n'

interface Choix { id: string; label: string; groupe: string; texte: string | null; persona?: string; action?: () => void; aide?: string }
export interface Commande { id: string; label: string; aide?: string; texte?: string; action?: () => void; groupe?: string }

/** Le mot en @ que l'on est en train de taper, juste avant le curseur. */
function motEnCours(valeur: string, curseur: number) {
  const m = /(^|\s)([@/])([\p{L}\p{N}_-]*)$/u.exec(valeur.slice(0, curseur))
  return m ? { debut: curseur - m[3].length - 1, q: m[3].toLowerCase(), signe: m[2] as '@' | '/' } : null
}

export function useMentions({ champ, valeur, surChange, surPersona, commandes = [] }: {
  champ: RefObject<HTMLTextAreaElement | null>; valeur: string
  surChange: (v: string) => void; surPersona: (id: string) => Promise<void>
  /** commandes proposées après « / » */
  commandes?: Commande[]
}) {
  const [mot, setMot] = useState<{ debut: number; q: string; signe: '@' | '/' } | null>(null)
  const [i, setI] = useState(0)
  const [persos, setPersos] = useState<Choix[]>([])
  useEffect(() => {
    void fetch('/api/personas').then(r => r.json())
      .then((d: { personas?: { id: string; name?: string }[] }) => setPersos((d.personas ?? []).map(p => ({
        id: `p-${p.id}`, label: p.name || p.id, groupe: 'Personnage', texte: null, persona: p.id }))))
      .catch(() => { /* la liste reste vide : les éléments restent proposés */ })
  }, [])
  const liste = useMemo((): Choix[] => {
    if (!mot) return []
    if (mot.signe === '/') return commandes.filter(c => `${c.label} ${c.aide ?? ''}`.toLowerCase().includes(mot.q)).slice(0, 8)
      .map(c => ({ id: `c-${c.id}`, label: c.label, groupe: c.groupe ?? (c.action ? 'Action' : 'Préréglage'), texte: c.texte ?? null, action: c.action, aide: c.aide }))
    const elems = EL_GROUPS.flatMap(g => g.items().filter(x => x.prompt).map(x => ({
      id: `${g.key}-${x.id}`, label: x.label, groupe: g.label as string, texte: x.prompt })))
    return [...persos, ...elems].filter(c => c.label.toLowerCase().includes(mot.q)).slice(0, 8)
  }, [mot, persos, commandes])
  useEffect(() => { setI(0) }, [mot?.q])

  const lire = () => { const c = champ.current; setMot(c ? motEnCours(c.value, c.selectionStart) : null) }
  const choisir = (c: Choix) => {
    if (!mot) return
    const fin = mot.debut + 1 + mot.q.length
    surChange(`${valeur.slice(0, mot.debut)}${c.texte ?? ''}${valeur.slice(fin)}`.replace(/\s{2,}/g, ' '))
    setMot(null)
    if (c.persona) void surPersona(c.persona)
    c.action?.()
  }
  /** Rend true quand la touche a servi à la liste. */
  const touche = (e: KeyboardEvent) => {
    if (!liste.length) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(n => (n + 1) % liste.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setI(n => (n + liste.length - 1) % liste.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choisir(liste[i]); return true }
    if (e.key === 'Escape') { setMot(null); return true }
    return false
  }
  const panneau = liste.length > 0 && (
    <div className="mentions-menu" role="listbox" aria-label={mot?.signe === '/' ? t('Commandes') : t('Personnages et éléments')}>
      {liste.map((c, n) => (
        <button key={c.id} type="button" role="option" aria-selected={n === i} className={n === i ? 'on' : ''}
          onMouseDown={e => { e.preventDefault(); choisir(c) }} onMouseEnter={() => setI(n)}>
          <span className="mentions-signe">{mot?.signe}</span>
          <span className="mentions-nom">{c.label}{c.aide && <small>{c.aide}</small>}</span>
          <em>{t(c.groupe)}</em>
        </button>
      ))}
      <div className="mentions-aide">{t('↑ ↓ pour choisir · Entrée pour valider · Échap pour fermer')}</div>
    </div>
  )
  return { lire, touche, panneau }
}
