/* ============================================================
   Langue de l'interface : français (source) ou anglais.

   Le texte français EST la clé : `t('Générer')` rend « Générer » en
   français et la traduction de src/i18n/en/ en anglais. Un texte sans
   traduction reste en français (jamais de clé vide à l'écran).

   Variables : `t('{n} images', { n: 3 })` — les accolades sont remplacées
   après traduction, dans les deux langues.

   Changer de langue recharge l'arbre React (clé sur la racine, cf. App.tsx) :
   `t()` lit la langue au rendu, sans abonnement par composant.
   ============================================================ */
import { useSyncExternalStore } from 'react'
import { EN } from './en'
import { MOTIFS_SERVEUR } from './en/serveur'

export type Lang = 'fr' | 'en'
const CLE = 'creatoros.lang'

function lire(): Lang {
  try {
    const v = localStorage.getItem(CLE)
    if (v === 'fr' || v === 'en') return v
  } catch { /* stockage indisponible */ }
  // Démo publique : l'anglais par défaut, le français au bouton FR (retenu ensuite)
  return 'en'
}

let langue: Lang = lire()
const abonnes = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = langue

export const getLang = () => langue
export function setLang(l: Lang) {
  if (l === langue) return
  langue = l
  try { localStorage.setItem(CLE, l) } catch { /* stockage indisponible */ }
  if (typeof document !== 'undefined') document.documentElement.lang = l
  abonnes.forEach(f => f())
}
export function useLang(): Lang {
  return useSyncExternalStore(f => { abonnes.add(f); return () => abonnes.delete(f) }, getLang, getLang)
}

/** Traduit un texte français de l'interface. */
export function t(fr: string, vars?: Record<string, string | number>): string {
  let s = langue === 'en' ? (EN[fr] ?? fr) : fr
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

/** Même texte français, sens différent selon l'endroit (« Annuler » = Cancel
 *  sur un bouton de formulaire, Undo après une suppression). La traduction est
 *  cherchée sous `contexte|texte`, puis sous le texte seul. */
export function tc(contexte: string, fr: string, vars?: Record<string, string | number>): string {
  const en = langue === 'en' ? EN[`${contexte}|${fr}`] : undefined
  if (en === undefined) return t(fr, vars)
  let s = en
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

/** Message renvoyé par le serveur (`{ error }` d'une requête, erreur d'un job).
 *  Le serveur parle français ; en anglais on traduit les messages connus —
 *  texte exact (src/i18n/en/serveur.ts), puis motifs à variables (`« X » existe
 *  déjà`, erreurs de nœud ComfyUI…), puis morceau par morceau autour des « — ».
 *  Inconnu → rendu tel quel. À appeler à l'AFFICHAGE quand le texte est aussi
 *  testé en français ailleurs (ex. erreur de job « annulé par… »). */
export function tServeur<T extends string | null | undefined>(msg: T): T {
  if (!msg || langue !== 'en') return msg
  return traduireServeur(msg) as T
}
function traduireServeur(s: string): string {
  const exact = EN[s]
  if (exact !== undefined) return exact
  for (const [re, en] of MOTIFS_SERVEUR) {
    const m = s.match(re)
    if (m) return en(m, traduireServeur)
  }
  const morceaux = s.split(' — ')
  if (morceaux.length > 1) return morceaux.map(traduireServeur).join(' — ')
  return s
}

/** Pluriel simple : `tp(n, '{n} image', '{n} images')`. */
export const tp = (n: number, un: string, plusieurs: string, vars?: Record<string, string | number>) =>
  t(n > 1 ? plusieurs : un, { n, ...vars })
