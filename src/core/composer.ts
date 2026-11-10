/* ============================================================
   Prompt composer — wrapper around the LLM rewriter.

   Calls POST /api/compose, which runs a local LLM
   (see server/composer.js).

   No identity prefix is added here: the server injects it
   (see server/persona.js). The LLM is instructed not to describe
   body shape, skin tone or hair — those traits come from the LoRA.
   ============================================================ */
import type { Register, MediaMode } from '../types'
import { t, tServeur } from '../i18n'

export interface ComposeInput {
  register: Register
  userPrompt: string
  userDirectives: string
  /** photo: image rewriter · video: motion rewriter (keeps gestures,
   *  gaze, dialogue line, camera; does not invent an outfit). */
  mode?: MediaMode
  /** Target diffusion engine (video: wan | ltx | ltx_hq | minimax) — selects
   *  the engine file of the system prompt. Photo: Klein, implicit. */
  engine?: string
  /** Additive rewriter layers (default OFF). `soul` = persona name
   *  (→ soul_<name>.txt); `mood` = scene preset (→ mood_<name>.txt). null =
   *  layer inactive → composed prompt is identical to having no layer. */
  soul?: string | null
  mood?: string | null
}
export interface ComposeOutput {
  positive: string
  negative: string
}

export interface PromptComposer {
  compose(input: ComposeInput): Promise<ComposeOutput>
}

/* The per-register fallback negative lives on the server (server/composer.js)
   and is returned in the /api/compose response. */

/** Composer: the LLM runs on the server, on CPU.
 *
 *  It does not silently fall back to passthrough on failure: errors are
 *  thrown and shown by the console. */
export class ApiComposer implements PromptComposer {
  async compose(input: ComposeInput): Promise<ComposeOutput> {
    const res = await fetch('/api/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(tServeur((body as { error?: string }).error) ?? `HTTP ${res.status}`)
    const out = body as ComposeOutput & { model?: string; ms?: number }
    if (!out.positive?.trim()) throw new Error(t('le modèle n’a rien produit'))
    return {
      positive: out.positive.trim(),
      negative: out.negative || '',
    }
  }
}

export const composer: PromptComposer = new ApiComposer()
