/* ============================================================
   Tirage des wildcards « au hasard » — côté serveur, avec la seed du job.

   Les items 🎲 des vocabulaires portent un TOKEN au lieu d'une ligne :
   `__tenues*__`, `{__a__|__b__}`. Aucune recette
   servie ne porte ImpactWildcardProcessor : le token partirait tel quel
   dans CLIPTextEncode, ou le LLM le paraphraserait. On tire donc ICI, avant
   l'injection, avec un générateur déterministe alimenté par la seed du job :
   même seed → même tirage, et la ligne tirée est journalisée dans
   `applied` (provenance). Le comportement est celui de l'Impact Pack :

     __fichier__            → une ligne du fichier
     __prefixe*__           → un fichier parmi ceux qui correspondent, puis une ligne
     {a|b|c}                → une option (qui peut elle-même contenir des tokens)
     __inexistant__         → laissé tel quel, signalé (échec visible)

   Les fichiers sont ceux de CONFIG.wildcardsDir (*.txt), relus quand
   leur mtime change. Les lignes vides et les commentaires `#` sont ignorés.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

const cache = new Map() // name → { mtimeMs, lines }

function fileNames() {
  try {
    return fs.readdirSync(CONFIG.wildcardsDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => f.slice(0, -4))
  } catch { return [] }
}

function linesOf(name) {
  const file = path.join(CONFIG.wildcardsDir, `${name}.txt`)
  let st
  try { st = fs.statSync(file) } catch { return null }
  const hit = cache.get(name)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.lines
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  cache.set(name, { mtimeMs: st.mtimeMs, lines })
  return lines
}

/** mulberry32 : petit, déterministe, largement suffisant pour choisir une
 *  ligne. La seed ComfyUI tient sur 53 bits ; on la replie sur 32. */
function rng(seed) {
  let a = (Number(seed) % 4294967296) ^ Math.floor(Number(seed) / 4294967296)
  a >>>= 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const globToRe = g => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

export const hasWildcards = text => /__[^_\s][^\s]*?__|\{[^{}]*\|[^{}]*\}/.test(String(text ?? ''))

/** Résout tous les tokens de `text`. Rend { text, draws, unknown } :
 *  draws = [{ token, value }] dans l'ordre du tirage, unknown = tokens
 *  laissés tels quels. Jamais d'exception : un fichier absent est un
 *  échec VISIBLE dans le prompt, pas un job perdu. */
export function resolve(text, seed) {
  let out = String(text ?? '')
  const draws = [], unknown = []
  if (!hasWildcards(out)) return { text: out, draws, unknown }
  const next = rng(seed)
  const pick = arr => arr[Math.floor(next() * arr.length)]
  const names = fileNames()

  for (let pass = 0; pass < 12; pass++) {
    let changed = false
    // 1. alternances {a|b|c}, les plus internes d'abord
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, body) => {
      const choice = pick(body.split('|').map(s => s.trim()).filter(Boolean))
      draws.push({ token: m, value: choice }); changed = true
      return choice
    })
    // 2. tokens __nom__ / __prefixe*__
    out = out.replace(/__([A-Za-z0-9_\-*.]+?)__/g, (m, name) => {
      if (unknown.includes(m)) return m
      const cands = name.includes('*') ? names.filter(n => globToRe(name).test(n)) : (names.includes(name) ? [name] : [])
      if (!cands.length) { unknown.push(m); return m }
      const lines = linesOf(pick(cands))
      if (!lines?.length) { unknown.push(m); return m }
      const line = pick(lines)
      draws.push({ token: m, value: line }); changed = true
      return line
    })
    if (!changed) break
  }
  return { text: out, draws, unknown }
}
