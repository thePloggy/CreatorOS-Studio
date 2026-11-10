/* ============================================================
   Shaping texts: the layer that decides what the model renders.

   Several families, all read from disk ON EVERY JOB:
     intent_*      global intent of the LLM rewriter
     engine_*      writing instructions specific to each diffusion engine
     rewrite_*     fallback system prompts of the rewriter
     shoot_*, caption.txt, mood_*  carousel, captions, mood layers

   Kept outside the code because they change often and are judged on images.

   Same mechanics as recipes: read per job (no cache), validated write,
   timestamped backup before overwrite, concurrency token.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { PROMPT_SEED, PROMPT_META } from './prompts.seed.js'

export { PROMPT_META }

/** Writes missing files from the seed. Called once at startup so a fresh
 *  install works without manual copying and an accidentally deleted file does
 *  not block production. NEVER overwrites an existing file. */
export function seedPrompts() {
  fs.mkdirSync(CONFIG.promptsDir, { recursive: true })
  const created = []
  for (const [file, text] of Object.entries(PROMPT_SEED)) {
    const full = path.join(CONFIG.promptsDir, file)
    if (fs.existsSync(full)) continue
    fs.writeFileSync(full, text)
    created.push(file)
  }
  return created
}

export function promptPath(file) {
  if (typeof file !== 'string' || !file.endsWith('.txt'))
    throw new Error('nom de texte invalide : un fichier .txt est attendu')
  if (file.includes('/') || file.includes('\\') || file.includes('..'))
    throw new Error(`nom de texte invalide : « ${file} » n’est pas un nom de fichier nu`)
  const full = path.join(CONFIG.promptsDir, file)
  if (!full.startsWith(CONFIG.promptsDir + path.sep)) throw new Error('texte hors périmètre')
  return full
}

/** Read for production use. Throws if the file is missing: a missing shaping
 *  text would silently change the render, which is worse than a clear job failure. */
export function readPrompt(file) {
  const full = promptPath(file)
  let text
  try { text = fs.readFileSync(full, 'utf8') }
  catch { throw new Error(`texte de façonnage absent : ${full}`) }
  if (!text.trim()) throw new Error(`texte de façonnage vide : ${full}`)
  return text
}

/** Read for the editor: content + timestamp (concurrency token). */
export function readPromptRaw(file) {
  const full = promptPath(file)
  const st = fs.statSync(full)
  return { file, text: fs.readFileSync(full, 'utf8'), mtimeMs: st.mtimeMs, bytes: st.size }
}

export function listPrompts() {
  try {
    return fs.readdirSync(CONFIG.promptsDir).filter(f => f.endsWith('.txt')).sort()
  } catch { return [] }
}

/** Write. Deliberately LIGHT validation: these are free texts. The only
 *  rejection is empty content: an empty system prompt would make the LLM answer
 *  anything without notice. */
export function writePrompt(file, text, baseMtimeMs) {
  const full = promptPath(file)
  if (typeof text !== 'string' || !text.trim())
    throw new Error('texte vide : un texte de façonnage vide changerait le rendu sans le dire')

  const exists = fs.existsSync(full)
  if (exists && Number.isFinite(baseMtimeMs)) {
    const cur = fs.statSync(full).mtimeMs
    if (Math.abs(cur - baseMtimeMs) > 1) {
      const e = new Error('le texte a été modifié sur le disque depuis son ouverture')
      e.code = 'CONFLIT'
      e.currentMtimeMs = cur
      throw e
    }
  }

  let backup = null
  if (exists) {
    const dir = path.join(CONFIG.promptsDir, '.backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = path.join(dir, `${file.replace(/\.txt$/, '')}.${stamp}.txt`)
    fs.copyFileSync(full, backup)
  }
  const tmp = full + '.tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, full)
  const st = fs.statSync(full)
  return {
    file, mtimeMs: st.mtimeMs, bytes: st.size, backup: backup && path.basename(backup),
    words: text.trim().split(/\s+/).length,
  }
}

/* ---------- register → file resolution ---------- */

const byKind = kind => Object.entries(PROMPT_META)
  .filter(([, m]) => m.kind === kind)
  .map(([file, m]) => ({ file, ...m }))

/** File serving a (kind, register). The only register is SFW: any unknown
 *  register falls back to it. */
export function fileFor(kind, register) {
  const all = byKind(kind)
  return (all.find(x => x.registers.includes(register))
    ?? all.find(x => x.registers.includes('sfw')))?.file
}

export const promptFor = (kind, register) => readPrompt(fileFor(kind, register))
