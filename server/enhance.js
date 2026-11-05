/* ============================================================
   Enhance — règles communes pour faire écrire un LLM proprement.

   Le LLM n'écrit que le CONTENU (qui, quoi, où, quel geste) ; le code tient
   le reste :
   - le rendu (lumière, grain, objectif, look) est une phrase fixe ajoutée par
     le code, la même pour tous les plans d'une série ;
   - les mots interdits sont listés en clair (un petit modèle suit mieux une
     liste qu'une règle), et retirés en code s'ils passent quand même ;
   - un rappel court suit le texte de l'utilisateur (le modèle suit mieux ce
     qui est proche de la demande que la consigne système) ;
   - la réponse est nettoyée (bloc de code, « Prompt: », guillemets autour).
   ============================================================ */

/* Mots de RENDU : jamais dans le contenu d'un plan, le code pose le rendu lui-même. */
export const MOTS_RENDU = ['cinematic', 'film still', 'film grain', 'color grade', 'colour grade', 'photorealistic', 'hyperrealistic',
  'shot on', 'lens', 'bokeh', 'depth of field', 'anamorphic', '35mm film', '16mm', 'golden hour', 'sunset light',
  'soft light', 'natural light', 'daylight', 'backlight', 'backlit', 'lighting', 'high contrast', 'vibrant colors', '8k', '4k', 'masterpiece']
/* Mots de CAMÉRA : le cadrage et le mouvement sont assignés par le code. */
export const MOTS_CAMERA = ['close-up', 'close up', 'medium shot', 'wide shot', 'full-body shot', 'eye level', 'low angle', 'high angle',
  'three-quarter view', 'profile view', 'over the shoulder', 'push-in', 'push in', 'panning', 'pans across', 'dolly', 'tracking shot',
  'orbit', 'handheld', 'zoom', 'zooms', 'static camera', 'the camera', 'slow motion', 'slowly']
/* Ce que les modèles d'image et de vidéo ratent ou que la démo refuse : listés au LLM, jamais retirés en
   aveugle (« sign » ou « text » ont d'autres sens) ; un plan qui en contient est relancé. */
export const MOTS_SCENE = ['pigeons', 'birds', 'seagulls', 'dogs', 'cats', 'horses', 'animals', 'waiter', 'waitress', 'vendor', 'friend',
  'crowd', 'people', 'neighbor', 'neighbour', 'someone', 'stranger', 'mirror', 'reflection', 'sign', 'logo', 'brand', 'text', 'menu board', 'poster']

const echapper = m => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const motif = mots => new RegExp(`\\b(?:${mots.map(echapper).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi')

/** Le rappel placé APRÈS la demande : la liste des mots à ne jamais écrire. */
export const rappel = (mots, quoi = 'the shots') => `(Reminder for ${quoi}: describe only the content — who, what, where, which gesture. Never write these words: ${mots.join(', ')}.)`

/** Retire d'un texte de contenu les morceaux de phrase (entre virgules) qui parlent de rendu ou de caméra :
 *  couper le seul mot laisse des restes (« at, shallow ») ; le morceau entier ne porte pas l'action. */
export function sansMots(texte, mots) {
  const re = motif(mots), mm = /\b\d+\s?mm\b|\bf\/\d+(\.\d+)?\b/i
  return String(texte ?? '').split(/(?<=[.!?])\s+/).map(ph => ph.replace(/[.!?]$/, '').split(/\s*,\s*/)
    .filter(m => { re.lastIndex = 0; return !re.test(m) && !mm.test(m) }).join(', ')).filter(Boolean).map(ph => ph + '.').join(' ').trim()
}

/** Les mots d'une liste présents dans un texte (pour une relance ciblée). */
export const motsPresents = (texte, mots) => [...new Set((String(texte ?? '').match(motif(mots)) ?? []).map(m => m.toLowerCase()))]

/** La réponse d'un LLM : sans bloc de code, sans « Prompt: », sans guillemets autour. */
export function nettoyer(texte) {
  let t = String(texte ?? '').trim()
  const bloc = t.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i)
  if (bloc) t = bloc[1].trim()
  t = t.replace(/^(enhanced|improved|rewritten)?\s*prompt\s*:\s*/i, '')
  for (const [a, b] of [['"', '"'], ['“', '”'], ['\'', '\'']]) if (t.startsWith(a) && t.endsWith(b) && !t.slice(1, -1).includes(a)) t = t.slice(1, -1).trim()
  return t
}

/** Une phrase propre : majuscule, point final, espaces simples. */
export const phrase = t => { const s = String(t ?? '').trim().replace(/\s{2,}/g, ' ').replace(/[\s,;]+$/, ''); return s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : '' }
