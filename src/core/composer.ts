/* ============================================================
   Composeur de prompt — abstraction du LLM rewriter.

   Appel réel à POST /api/compose, qui fait tourner un LLM local
   (cf. server/composer.js).


   Aucun préfixe d'identité n'est ajouté ici : il est injecté par le
   serveur (cf. server/persona.js). Le LLM a d'ailleurs
   pour consigne de ne PAS décrire morphologie, carnation ni cheveux —
   ces traits viennent de la LoRA, les redire les dilue.
   ============================================================ */
import type { Register, MediaMode } from '../types'
import { t, tServeur } from '../i18n'

export interface ComposeInput {
  register: Register
  userPrompt: string
  userDirectives: string
  /** photo : réécriveur d'image · video : réécriveur de mouvement (garde
   *  gestes, regard, réplique, caméra ; n'invente pas de tenue). */
  mode?: MediaMode
  /** Moteur de diffusion visé (vidéo : wan | ltx | ltx_hq | minimax) — choisit
   *  le fichier « moteur » du system prompt. Photo : Klein, implicite. */
  engine?: string
  /** Couches rewriter additives (scaffold, défaut OFF). `soul` = nom de persona
   *  (→ soul_<nom>.txt) ; `mood` = preset de scène (→ mood_<nom>.txt). null =
   *  couche inactive → prompt composé strictement identique à sans. */
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

/* Le négatif de repli par registre vit côté serveur (server/composer.js) et
   revient dans la réponse de /api/compose. */

/** Composeur réel : le LLM tourne côté serveur, sur CPU.
 *
 *  Il ne se rabat PAS silencieusement sur le passthrough en cas de panne :
 *  un prompt brut renvoyé sans un mot ferait croire que le modèle écrit mal.
 *  L'erreur remonte, la console l'affiche. */
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
