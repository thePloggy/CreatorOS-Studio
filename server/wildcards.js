/* ============================================================
   "Random" wildcard drawing, server-side, seeded by the job seed.

   Vocabulary 🎲 items carry a TOKEN instead of a line:
   `__tenues*__`, `{__a__|__b__}`. No served recipe contains
   ImpactWildcardProcessor: the token would reach CLIPTextEncode as is, or
   the LLM would paraphrase it. So drawing happens HERE, before injection,
   with a deterministic generator seeded by the job seed: same seed → same
   draw, and the drawn line is logged in `applied` (provenance). Behavior
   matches the Impact Pack:

     __file__               → one line of the file
     __prefix*__            → one matching file, then one line
     {a|b|c}                → one option (which may itself contain tokens)
     __missing__            → left as is, reported (visible failure)

   Files come from CONFIG.wildcardsDir (*.txt), reread when their mtime
   changes. Empty lines and `#` comments are ignored.
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

/** mulberry32: small, deterministic, plenty to pick a line. The ComfyUI
 *  seed fits in 53 bits; it is folded to 32. */
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

/** Resolves all tokens in `text`. Returns { text, draws, unknown }:
 *  draws = [{ token, value }] in draw order, unknown = tokens left as is.
 *  Never throws: a missing file is a VISIBLE failure in the prompt, not a lost job. */
export function resolve(text, seed) {
  let out = String(text ?? '')
  const draws = [], unknown = []
  if (!hasWildcards(out)) return { text: out, draws, unknown }
  const next = rng(seed)
  const pick = arr => arr[Math.floor(next() * arr.length)]
  const names = fileNames()

  for (let pass = 0; pass < 12; pass++) {
    let changed = false
    // 1. alternations {a|b|c}, innermost first
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, body) => {
      const choice = pick(body.split('|').map(s => s.trim()).filter(Boolean))
      draws.push({ token: m, value: choice }); changed = true
      return choice
    })
    // 2. tokens __name__ / __prefix*__
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
