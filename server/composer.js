/* ============================================================
   Prompt rewriting by a local LLM (Ollama), on CPU.

   Why CPU: the GPU path depends on the card being free (ComfyUI may hold
   most of the VRAM, see CONFIG.ollamaUnload); on CPU there is no contention
   with diffusion and system RAM absorbs the model. 70B models are too slow
   here (around 1 tok/s, minutes per rewrite).

   Why here and not in the recipe: an OllamaGenerateV2 node in the graph
   would rewrite the prompt DURING the job, so the text would only be seen
   afterwards and the queue would wait for the LLM. Here the rewrite lands
   in "Prompt composé" BEFORE submission: readable, editable, and the CPU
   time is spent while a human reads. It is also the only place where the
   console's "Directive au LLM" field means something.
   ============================================================ */
import crypto from 'node:crypto'
import * as wildcards from './wildcards.js'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'
import { promptFor, readPrompt } from './prompts.js'

/** Base negative. Klein recipes run at cfg 1.0 with ConditioningZeroOut, where
 *  this text has NO effect. It is produced for traceability and for cfg>1 recipes. */
const BASE_NEGATIVE = 'plastic smooth skin, perfect symmetry, blurry, extra fingers, watermark, nudity'

/* Rewriter system prompt = INTENT + ENGINE (diffusion): two files concatenated
   and READ FROM DISK on each call, so editable from the Workbench without a
   restart. The intent says what is wanted (subject, limits), the engine says
   how to write for it (order, language, length, speech).
   `engine`: 'wan' | 'ltx' | 'ltx_hq' | 'minimax' | 'motion' for video (HQ
   shares the LTX file); for photo the engine comes from
   CREATOROS_PHOTO_ENGINE. Falls back to rewrite_* if a file is missing. */
/** Photo diffusion engine: `klein` (default) or `krea`. */
export const PHOTO_ENGINE_DEFAUT = 'krea'
const PHOTO_ENGINE = CONFIG.photoEngine

export function systemFor(register, mode = 'photo', engine = null, opts = {}) {
  // SOUL (persona) + MOOD (scene): ADDITIVE layers, default OFF. `soul` and
  // `mood` are NAMES (-> soul_<name>.txt / mood_<name>.txt, read from disk).
  // Invariant: soul=null AND mood=null => result STRICTLY identical to
  // intent + engine. Order is intent + soul + mood + engine; a missing file
  // is ignored.
  const { soul = null, mood = null } = opts
  // Edit by instruction: the system prompt is SELF-CONTAINED (engine_edit.txt).
  // The intent says "write a prompt that DESCRIBES a scene", which contradicts
  // an edit instruction ("make the dress red").
  if (mode !== 'video' && engine === 'edit') {
    try { return readPrompt('engine_edit.txt') } catch { /* fallback below */ }
  }
  const engineKey = mode === 'video'
    ? ({ ltx_hq: 'ltx' }[engine] ?? engine ?? 'wan')
    : (engine && engine !== 'edit' ? engine : PHOTO_ENGINE)
  try {
    const layers = [readPrompt('intent_sfw.txt')]
    /* Few-shot examples of the TARGET STYLE, provided by the operator, photo
       only. Never in video: they would import their setting while the still
       fixes another place. */
    if (mode !== 'video') { try { layers.push(readPrompt('examples_sfw.txt')) } catch { /* no examples */ } }
    if (soul) { try { layers.push(readPrompt(`soul_${soul}.txt`)) } catch { /* missing layer, ignored */ } }
    if (mood) { try { layers.push(readPrompt(`mood_${mood}.txt`)) } catch { /* missing layer, ignored */ } }
    layers.push(readPrompt(`engine_${engineKey}.txt`))
    return layers.join('\n\n')
  } catch {
    return promptFor(mode === 'video' ? 'rewrite_video' : 'rewrite', 'sfw')
  }
}

/** Appearance lint for SOUL/MOOD layers: they must describe ONLY behaviour
 *  and atmosphere, never appearance (which comes from the LoRA + preamble).
 *  Non-blocking: returns the appearance words found, as a Workbench signal. */
const APPEARANCE_RE = /\b(hair|eyes?|skin|freckled?|freckles?|body|figure|physique|face|facial|lips?|mouth|complexion|tanned?|tan|clothing|clothes|clothed|outfit|dress|shirt|shorts|blonde|brunette|hips?|waist|tall|slim|toned)\b/gi
export function lintAppearance(text) {
  return [...new Set((String(text).match(APPEARANCE_RE) || []).map(w => w.toLowerCase()))]
}

/** Writer model. A single register, so a single model; the signature keeps
 *  `register` for callers. */
export function modelFor() {
  return CONFIG.composerModels.sfw
}

/** Rewrites the prompt. Throws an explicit error rather than returning an
 *  approximate text: a composer failing silently would return the raw prompt. */
/* Below this threshold the response is a sentence, not an image prompt (an 8B
   model does this intermittently on the same input). One insisting word puts
   it back on track, and the retry only costs when needed. */
const MIN_WORDS = 60
const INSIST = '\n\nIMPORTANT: your previous answer was far too short. Write the '
  + 'FULL descriptive paragraph of 130-180 words, covering setting, pose, '
  + 'wardrobe, light, camera and skin. Do not answer with a single sentence.'

/* ---------- spoken lines: shielded from the LLM ----------
   A video brief carries what the character SAYS, often in French or mixed.
   An 8B model translates the line whatever the instruction says. So quoted
   segments are pulled out BEFORE the call, replaced by a {{LINE n}} token,
   and put back AFTER, character for character. A token lost by the model ->
   the line is appended at the end of the text instead of being lost.
   Recognized quotes: « … », "…", “…”. */
const QUOTE_RE = /«\s*([^»]+?)\s*»|"([^"\n]+?)"|“([^”]+?)”/g
export function shieldLines(text) {
  const lines = []
  const out = String(text).replace(QUOTE_RE, (m, a, b, c) => {
    lines.push((a ?? b ?? c).trim())
    return `{{LINE ${lines.length}}}`
  })
  return { out, lines }
}
export function unshieldLines(text, lines, { drop = false } = {}) {
  let out = String(text)
  lines.forEach((line, i) => {
    const re = new RegExp(`["“«]?\\{\\{\\s*LINE\\s*${i + 1}\\s*\\}\\}["”»]?`, 'g')
    if (drop) {
      /* SILENT engine (Wan): the engine instruction drops spoken lines; a leftover
         token is erased instead of refilled, and a missing line is never re-injected. */
      out = out.replace(re, '').replace(/\s{2,}/g, ' ')
    } else if (re.test(out)) {
      out = out.replace(re, `"${line}"`)
    } else {
      out = `${out.trim().replace(/[.\s]+$/, '')}. She says: "${line}"`
    }
  })
  return out
}

export async function compose({ register = 'sfw', userPrompt = '', userDirectives = '', mode = 'photo', engine = null, soul = null, mood = null, sceneDesc = null, previousPrompt = null, outfitAnchor = null }) {
  const model = modelFor(register, mode)
  // A short motion brief ("she smiles, slow push-in") legitimately gives ~30
  // words; a higher floor would force the model to pad.
  // Edit: output MUST be short (2 sentences). A word floor would trigger the
  // INSIST "expand" retry, the opposite of what is wanted.
  const minWords = mode === 'video' ? 25 : engine === 'edit' ? 0 : MIN_WORDS
  /* A "🎲 random" item arrives here as a token: the LLM does not know what
     `__tenues*__` is and would invent it. It is drawn BEFORE rewriting with a
     throwaway seed (the job does not exist yet), so the composed text carries
     a concrete outfit that provenance keeps. Consequence: a composed batch
     shares the same draw; a batch sent WITHOUT composing draws one line per job. */
  const drawn = wildcards.resolve(userPrompt, crypto.randomInt(2 ** 31))
  // Spoken lines kept out of the LLM's reach in video (see shieldLines).
  const shielded = mode === 'video' ? shieldLines(drawn.text) : { out: drawn.text, lines: [] }
  const brief = userDirectives.trim()
    ? `${shielded.out.trim()}\n\nDIRECTIVES (priority over defaults): ${userDirectives.trim()}`
    : shielded.out.trim()
  if (!brief) throw new Error('rien à réécrire : le prompt est vide')

  /* ---------- visual context (VLM) ----------
     Without the still, the rewriter works BLIND and invents the starting outfit
     and pose. In video that breaks the rule "START IN THE IMAGE'S EXACT POSE",
     which requires describing the initial state.
  
     The VLM description is an INPUT like the brief and SUBORDINATE to it: the
     image says what IS, the brief says what must HAPPEN. The contract is
     spelled out in the message, otherwise the model treats the description as
     an instruction and paraphrases the image instead of executing the brief. */
  const desc = String(sceneDesc ?? '').trim()

  /* ---------- continuation (Extend tab) ----------
     The new clip starts on the LAST frame of the previous one: the VLM
     description above gives its visual state, not its intent. Without the
     previous shot's prompt, the rewriter would replay what was already played,
     change the pace, or lose the direction. That prompt is given as CONTEXT,
     with continuity rules and the same warning as for the description: read
     it, never copy it. */
  const prev = String(previousPrompt ?? '').trim().slice(0, 6000)
  const suite = prev
    ? '<previous_shot>\n' + prev + '\n</previous_shot>\n\n'
      + 'The block above is the prompt of the PREVIOUS clip. The new clip is its direct continuation: '
      + 'it starts exactly on the last frame of that clip' + (desc ? ', described in <source_image> below' : '')
      + '. Write the next beat of the same scene:\n'
      + '- keep the same spirit, tone, energy and rhythm; the first movement of the new clip starts at the '
      + 'pace the previous clip ended on — no sudden speed-up, no slow restart from stillness;\n'
      + '- never repeat an action the previous clip already completed; an action it left unfinished is '
      + 'carried to its end first;\n'
      + '- carry its intent forward toward what the brief asks;\n'
      + '- keep the same camera language (type of framing, camera behaviour) unless the brief changes it;\n'
      /* Without this rule the rewriter reuses the previous clip's START state
         ("cup filled to the brim") while that clip ends on an empty cup. The
         previous prompt tells a beginning; the last frame shows the end. */
      + '- the previous prompt describes how that clip STARTED, not how it ended: for the current state '
      + '(what she holds, what is full or empty, spilled or tidy, where things and people are) the '
      + 'last frame is the truth' + (desc ? ' — follow <source_image> wherever the two disagree' : '') + ';\n'
      + '- it is context, not text to reuse: do not copy its sentences.\n\n'
    : ''
  /* Locked outfit ("Tenue de l'image"): the text comes from a dedicated VLM call,
     filtered in code. The rewriter is told NOT to describe the outfit, because
     the code inserts it below. The lock overrides the brief: it is an explicit
     operator choice. */
  const tenue = String(outfitAnchor ?? '').trim()
  const verrouTenue = tenue && engine !== 'edit'
    ? `OUTFIT — fixed by the pipeline: she wears exactly "${tenue}". Do NOT describe, name, change or remove her `
      + 'clothing anywhere in your output, even if the brief mentions clothing: the pipeline inserts this exact '
      + 'outfit description itself. Write everything else as usual.\n\n'
    : ''
  const prompt = verrouTenue + suite + (desc
    /* The description is FRAMED and announced as data. Left as free prose, the
       model copies its sentences verbatim ("The mood is bright and sunny",
       "The camera angle is straight-on") although the engine forbids that meta
       vocabulary. What is shown gets copied, so the message says what to do with it. */
    ? '<source_image>\n' + desc + '\n</source_image>\n\n'
      + 'The block above is a CAPTION of the still, written by a vision model. It is reference '
      + 'DATA about the first frame — the starting pose, the outfit, the setting. Read it, do not '
      + 'reuse it: never copy its sentences or its vocabulary into your output, and carry over '
      + 'none of its statements about mood, camera angle or photo quality. Write the starting state '
      + 'in your own words, in the required format.\n\n'
      + 'TASK — write the brief below as motion starting from that first frame. The brief WINS on '
      + 'any conflict: where it asks for a change (a different outfit, a new location), '
      + 'follow the brief; the image informs only what the brief leaves unsaid.\n\n'
      + brief
    : brief)

  const t0 = Date.now()
  const ask = async text => {
  const ctl = AbortSignal.timeout(CONFIG.composerTimeoutMs)
  let res
  try {
    res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl,
      body: JSON.stringify({
        model, system: systemFor(register, mode, engine, { soul, mood }), prompt: text, stream: false,
        // qwen3: without this field "thinking" burns minutes of CPU;
        // ignored by non-thinking models.
        think: false,
        // keep_alive 0: the model leaves RAM right after replying.
        keep_alive: 0,
        // num_gpu 0: fallback value. fetchOllama (gpu.js) removes it when the card
        // is taken for Ollama, and keeps it when a long render occupies the card.
        // Edit: low temperature for a literal, stable instruction.
        options: { num_gpu: 0, num_ctx: 4096, temperature: engine === 'edit' ? 0.3 : 0.8 },
      }),
    })
  } catch (e) {
    throw new Error(e.name === 'TimeoutError'
      ? `délai dépassé (${CONFIG.composerTimeoutMs / 1000} s) sur ${model} — le CPU est lent, `
        + 'réessayer ou choisir un modèle plus léger'
      : `Ollama injoignable sur ${CONFIG.ollamaUrl} : ${e.message}`)
  }
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} pour ${model}`)
  const d = await res.json()
  return { text: String(d.response || '').trim(), tokens: d.eval_count ?? null }
  }

  let { text: positive, tokens } = await ask(prompt)
  let retried = false
  if (positive && positive.split(/\s+/).length < minWords) {
    retried = true
    const second = await ask(prompt + INSIST)
    // Keep the richer one: the retry can also fail, and returning the worse of
    // the two would be a regression.
    if (second.text.split(/\s+/).length > positive.split(/\s+/).length) {
      positive = second.text
      tokens = second.tokens
    }
  }
  if (!positive) throw new Error(`${model} n'a rien produit`)
  /* Anti-copy of few-shot EXAMPLES. The examples' signature markers can only
     appear if the brief contains them; otherwise a hard retry. */
  if (engine !== 'edit') {
    const MARKERS = ['beach condo', 'slider door', 'public library', 'bookshelves',
      'gray mini dress', 'knitted cardigan']
    const copied = MARKERS.filter(m => positive.toLowerCase().includes(m) && !prompt.toLowerCase().includes(m))
    if (copied.length) {
      retried = true
      const strict = await ask(prompt
        + `\n\nSTRICT RETRY: your previous rewrite copied these from the style EXAMPLE, which the brief never mentions: ${copied.join(', ')}. `
        + (mode === 'video' ? 'The provided image alone defines the setting and outfit — never invent or import either. '
          : 'Only the brief defines the setting, outfit and props. ')
        + 'Rewrite without them.')
      const still = MARKERS.filter(m => strict.text.toLowerCase().includes(m) && !prompt.toLowerCase().includes(m))
      if (strict.text && !still.length) { positive = strict.text; tokens = strict.tokens }
    }
  }
  positive = unshieldLines(positive, shielded.lines, { drop: mode === 'video' && ['wan', 'motion'].includes(engine ?? 'wan') })
  /* ORPHAN line templates. On a brief without a spoken line, the rewriter may
     invent a sentence AND copy the engine instruction template:
     `<d>[French] {{LINE 1}}</d>`. unshieldLines only fills templates of a real
     brief line, so this one would reach the engine, which would say "LINE".
     The empty <d> block (with its "X (S1) says:") and any leftover token are removed. */
  if (/\{\{\s*LINE\s*\d+\s*\}\}/i.test(positive)) {
    positive = positive
      .replace(/(?:[A-Z][\w ]{0,30}\(S\d\)\s*says(?: in an off-screen voiceover)?:\s*)?<d>\s*(?:\[[A-Za-z]+\]\s*)?["“«]?\{\{\s*LINE\s*\d+\s*\}\}["”»]?\s*<\/d>/gi, '')
      .replace(/["“«]?\{\{\s*LINE\s*\d+\s*\}\}["”»]?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
  }
  /* The writer sometimes wraps the H3 description in <p> tags. The MiniMax
     format does not accept them, so they are removed mechanically. The <d>
     tags of spoken lines are PART of the format and are kept. */
  if (mode === 'video') positive = positive.replace(/<\/?p>/g, '').replace(/[ \t]{2,}/g, ' ').trim()

  /* [Shot 1] marker: MECHANICAL guard, MiniMax engines only (only
     engine_minimax*.txt require it; WAN and LTX do not). The model writes it
     on a bare brief but drops it when given the image description; asking for
     it in the message makes it land BEFORE the field name, breaking the
     structure, so it is repaired in code. The marker forbids cuts; the
     timestamp that follows is legitimate and stays. */
  if (mode === 'video' && String(engine ?? '').startsWith('minimax') && !/\[Shot 1\]/.test(positive)) {
    positive = positive.replace(/(integrated_multimodal_description:\s*\n?)/i, '$1[Shot 1] ')
  }

  /* INVENTED shot markers: mechanical guard, MiniMax engines. On a single-shot
     brief the rewriter may produce "[Continue from Shot 1]" mid-description.
     The engine reads any marker as a cut, while the engine rule forbids
     inventing shots. So every marker other than [Shot 1] is removed, unless
     the BRIEF itself contains some (intended multi-shot). The text after the
     marker is kept: only the label goes. */
  if (mode === 'video' && String(engine ?? '').startsWith('minimax')
      && !/\[\s*shot\s*[2-9]/i.test(String(userPrompt ?? ''))) {
    const EXTRA = /\[\s*(?:continue[^\]]*|shot\s*(?:[2-9]|\d{2,})[^\]]*|cut[^\]]*|next shot[^\]]*)\]\s*/gi
    if (EXTRA.test(positive)) {
      positive = positive.replace(EXTRA, '').replace(/\n{3,}/g, '\n\n').trim()
    }
  }

  /* CODE insertion of the locked outfit: at the start of the scene for MiniMax
     (right after [Shot 1]), at the head of the text elsewhere. */
  if (verrouTenue) {
    /* "her" rather than an article: the VLM list is raw ("dark green dress",
       "black lace bra, white thigh-high stockings") and "her" reads correctly
       in front of either. */
    const phrase = `She is wearing her ${tenue}, exactly as in the provided image.`
    if (mode === 'video' && String(engine ?? '').startsWith('minimax') && /\[Shot 1\]/.test(positive))
      positive = positive.replace(/\[Shot 1\]\s*/, `[Shot 1] ${phrase} `)
    else
      positive = `${phrase} ${positive}`
  }

  /* Edit: MECHANICAL guard against padding. The format must end with the
     preservation clause "... unchanged."; everything after the FIRST occurrence
     is cut, since a CPU model does not reliably stop after two sentences.
     Fallback: if "unchanged" is absent, the text is kept as is. */
  if (engine === 'edit') {
    const m = positive.match(/^([\s\S]*?\bunchanged\b\.?)/i)
    if (m) positive = m[1].trim()
  }

  return {
    positive,
    retried,
    negative: BASE_NEGATIVE,
    model,
    device: 'cpu', draws: drawn.draws,
    ms: Date.now() - t0,
    tokens,
  }
}
