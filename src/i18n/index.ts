/* ============================================================
   Interface language: French (source) or English.

   The French text IS the key: `t('Générer')` renders "Générer" in
   French and the translation from src/i18n/en/ in English. Untranslated
   text stays French (never an empty key on screen).

   Variables: `t('{n} images', { n: 3 })` — braces are replaced after
   translation, in both languages.

   Changing language remounts the React tree (key on the root, see App.tsx):
   `t()` reads the language at render time, without per-component subscription.
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
  } catch { /* storage unavailable */ }
  // Public demo: English by default, French via the FR button (then remembered)
  return 'en'
}

let langue: Lang = lire()
const abonnes = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = langue

export const getLang = () => langue
export function setLang(l: Lang) {
  if (l === langue) return
  langue = l
  try { localStorage.setItem(CLE, l) } catch { /* storage unavailable */ }
  if (typeof document !== 'undefined') document.documentElement.lang = l
  abonnes.forEach(f => f())
}
export function useLang(): Lang {
  return useSyncExternalStore(f => { abonnes.add(f); return () => abonnes.delete(f) }, getLang, getLang)
}

/** Translates a French interface text. */
export function t(fr: string, vars?: Record<string, string | number>): string {
  let s = langue === 'en' ? (EN[fr] ?? fr) : fr
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return sansEmoji(s)
}

/** Labels contain no emoji: an icon is an SVG, not a font character. */
const EMOJI = /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2728}\u{2B50}]\uFE0F?)\s?/gu
export const sansEmoji = (s: string) => s.replace(EMOJI, '').replace(/^\s+/, '').replace(/ [—–] /g, langue === 'en' ? ': ' : ' : ').replace(/[—–]/g, '-')

/** Same French text, different meaning by context ("Annuler" = Cancel
 *  on a form button, Undo after a deletion). The translation is looked up
 *  under `context|text`, then under the text alone. */
export function tc(contexte: string, fr: string, vars?: Record<string, string | number>): string {
  const en = langue === 'en' ? EN[`${contexte}|${fr}`] : undefined
  if (en === undefined) return t(fr, vars)
  let s = en
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return sansEmoji(s)
}

/** Message returned by the server (`{ error }` of a request, job error).
 *  The server speaks French; in English, known messages are translated —
 *  exact text (src/i18n/en/serveur.ts), then patterns with variables
 *  (`« X » existe déjà`, ComfyUI node errors…), then fragment by fragment around "—".
 *  Unknown → returned as is. Call at DISPLAY time when the text is also
 *  tested in French elsewhere (e.g. job error "annulé par…"). */
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

/** Simple plural: `tp(n, '{n} image', '{n} images')`. */
export const tp = (n: number, un: string, plusieurs: string, vars?: Record<string, string | number>) =>
  t(n > 1 ? plusieurs : un, { n, ...vars })
