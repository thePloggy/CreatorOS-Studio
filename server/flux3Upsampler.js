/* ============================================================
   Réécriveur de prompt FLUX 3 Image Klein.
   BFL : « Always run a prompt upsampler » — le modèle est entraîné sur des descriptions complètes,
   un prompt court donne une image générique. Le prompt système est celui des workflows officiels
   ComfyUI (image_flux3_klein_distilled_t2i), exécuté ici par le LLM local (Ollama) au lieu du
   Qwen3.5-9B dédié. Un personnage entraîné garde son visage : on demande au réécriveur de ne
   décrire ni cheveux, ni yeux, ni peau, ni origine pour lui.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'

const SYSTEME = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'flux3-upsampler-system.txt'), 'utf8')

/** Un prompt déjà long (plus de 120 mots) est pris pour une description complète et passe tel quel. */
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

/* Un LLM généraliste ajoute quand même une apparence (« fair skin, long brown hair ») ou cache le visage
   (« her face obscured by the hat ») : ces mots contredisent la LoRA du personnage, on les retire. */
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
