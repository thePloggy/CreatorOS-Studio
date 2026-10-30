/* ============================================================
   @ dans le prompt (30/10) : taper « @jes » propose les personnages et les
   éléments (tenues, lieux, poses, styles). Un personnage devient le personnage
   actif et le mot disparaît ; un élément est remplacé par son texte.
   ============================================================ */
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { EL_GROUPS } from './popups'
import { t } from '../i18n'

interface Choix { id: string; label: string; groupe: string; texte: string | null; persona?: string }

/** Le mot en @ que l'on est en train de taper, juste avant le curseur. */
function motEnCours(valeur: string, curseur: number) {
  const m = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(valeur.slice(0, curseur))
  return m ? { debut: curseur - m[2].length - 1, q: m[2].toLowerCase() } : null
}

export function useMentions({ champ, valeur, surChange, surPersona }: {
  champ: RefObject<HTMLTextAreaElement | null>; valeur: string
  surChange: (v: string) => void; surPersona: (id: string) => Promise<void>
}) {
  const [mot, setMot] = useState<{ debut: number; q: string } | null>(null)
  const [i, setI] = useState(0)
  const [persos, setPersos] = useState<Choix[]>([])
  useEffect(() => {
    void fetch('/api/personas').then(r => r.json())
      .then((d: { personas?: { id: string; name?: string }[] }) => setPersos((d.personas ?? []).map(p => ({
        id: `p-${p.id}`, label: p.name || p.id, groupe: 'Personnage', texte: null, persona: p.id }))))
      .catch(() => { /* la liste reste vide : les éléments restent proposés */ })
  }, [])
  const liste = useMemo(() => {
    if (!mot) return []
    const elems = EL_GROUPS.flatMap(g => g.items().filter(x => x.prompt).map(x => ({
      id: `${g.key}-${x.id}`, label: x.label, groupe: g.label as string, texte: x.prompt })))
    return [...persos, ...elems].filter(c => c.label.toLowerCase().includes(mot.q)).slice(0, 8)
  }, [mot, persos])
  useEffect(() => { setI(0) }, [mot?.q])

  const lire = () => { const c = champ.current; setMot(c ? motEnCours(c.value, c.selectionStart) : null) }
  const choisir = (c: Choix) => {
    if (!mot) return
    const fin = mot.debut + 1 + mot.q.length
    surChange(`${valeur.slice(0, mot.debut)}${c.texte ?? ''}${valeur.slice(fin)}`.replace(/\s{2,}/g, ' '))
    setMot(null)
    if (c.persona) void surPersona(c.persona)
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
    <div className="flex flex-col mt-1" style={{ background: 'var(--panel, #15161a)', border: '1px solid var(--line, #2a2d35)', borderRadius: 10, overflow: 'hidden' }}>
      {liste.map((c, n) => (
        <button key={c.id} type="button" className="text-left text-[11.5px]" onMouseDown={e => { e.preventDefault(); choisir(c) }}
          style={{ padding: '6px 10px', background: n === i ? 'rgba(242,77,138,.16)' : 'transparent', color: 'var(--text)' }}>
          {c.label} <small style={{ color: 'var(--faint)' }}>{t(c.groupe)}</small>
        </button>
      ))}
    </div>
  )
  return { lire, touche, panneau }
}
