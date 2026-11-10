/* ============================================================
   FLUX 3 Image Klein prompt rewriter.
   The model is trained on full descriptions; a short prompt gives a generic image.
   The system prompt is the one from the official ComfyUI workflows
   (image_flux3_klein_distilled_t2i), run by the local LLM (Ollama). For a trained
   character the rewriter is told not to describe hair, eyes, skin or ethnicity,
   so the LoRA keeps the face.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'

const SYSTEME = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'flux3-upsampler-system.txt'), 'utf8')

/** A prompt that is already long (over 120 words) is treated as a full description and passed through. */
export const aReecrire = texte => String(texte ?? '').trim().split(/\s+/).length < 120

export async function reecrireFlux3(texte, { largeur, hauteur, personnage = false } = {}) {
  const ratio = largeur && hauteur ? `TARGET CANVAS: ${largeur}:${hauteur}\n` : ''
  const identite = personnage
    ? '\n\nIDENTITY: the main woman is a trained character whose face and hair come from the model itself. Refer to her as "the woman" and describe her clothing, pose, expression and position, but never her hair colour or style, eye colour, skin tone, ethnicity or age.'
    : ''
  const consigne = personnage
    ? 'Rule for this request: the main woman is a trained character. Describe her clothing, pose, expression and position only; write no hair, eye colour, skin tone, ethnicity or age for her, and keep her face visible and turned toward the light.\n\n'
    : ''
  const r = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.composerModels.sfw, system: SYSTEME + identite, prompt: consigne + ratio + texte, stream: false,
      options: { temperature: 0, num_predict: 900 } }),
    signal: AbortSignal.timeout(CONFIG.composerTimeoutMs),
  })
  if (!r.ok) throw new Error(`réécriveur FLUX 3 : HTTP ${r.status}`)
  const d = await r.json()
  const sortie = String(d.response ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^["“]|["”]$/g, '')
  if (sortie.split(/\s+/).length < 40) throw new Error('réécriveur FLUX 3 : réponse trop courte')
  return personnage ? sansApparence(sortie) : sortie
}

/* A general-purpose LLM may still add appearance ("fair skin, long brown hair") or hide the face
   ("her face obscured by the hat"): these words contradict the character LoRA and are removed. */
const APPARENCE = [
  /,?\s*(with\s+)?(very\s+)?(fair|pale|light|olive|tan(?:ned)?|brown|dark|medium|warm|golden|sun-?kissed|bronzed)\s+(?:-\s*)?(?:skin(?:ned)?|complexion)/gi,
  /,?\s*(with\s+)?((long|short|shoulder-length|wavy|curly|straight|flowing|loose|tousled|windswept)\s+)*(blonde?|brown|black|red|auburn|dark|chestnut|copper|ginger|light|golden|raven)(-|\s)?(haired|hair)\b/gi,
  /,?\s*(caucasian|asian|african(?:-american)?|latina|hispanic|european|white|black|middle-eastern|east asian|south asian|mixed-race)\s+(woman|female|rider)/gi,
  /,?\s*(in her|aged?|around)\s+(early|mid|late)?-?\s*(twenties|thirties|forties|20s|30s|40s)/gi,
  /,?\s*(blue|green|brown|hazel|grey|gray|dark)\s+eyes/gi,
]
export function sansApparence(texte) {
  let t = texte
    .split(/(?<=[.!?])\s+/)
    .filter(ph => !/(face|features)\s+(is|are|remains?|stays?)?\s*(partly\s+|partially\s+)?(obscured|hidden|shadowed|covered|not visible)|obscured by (the|her) hat/i.test(ph))
    .join(' ')
  for (const re of APPARENCE) t = t.replace(re, '')
  return t.replace(/\s{2,}/g, ' ').replace(/\b(has|with)\s+and\s+/g, '$1 ').replace(/\b(woman|rider|girl),\s+and\s+(a|an)\s/g, '$1 in $2 ')
    .replace(/\s+,/g, ',').replace(/,\s*\./g, '.').trim()
}
