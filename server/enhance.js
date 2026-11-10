/* ============================================================
   Enhance: shared rules for getting clean output from an LLM.

   The LLM writes only the CONTENT (who, what, where, which gesture); the
   code handles the rest:
   - the look (light, grain, lens) is a fixed sentence added by the code,
     the same for every shot of a series;
   - banned words are listed explicitly (a small model follows a list
     better than a rule), and removed in code if they still get through;
   - a short reminder follows the user's text (the model follows what is
     close to the request better than the system prompt);
   - the response is cleaned (code block, "Prompt:", surrounding quotes).
   ============================================================ */

/* LOOK words: never in shot content, the code sets the look itself. */
export const MOTS_RENDU = ['cinematic', 'film still', 'film grain', 'color grade', 'colour grade', 'photorealistic', 'hyperrealistic',
  'shot on', 'lens', 'bokeh', 'depth of field', 'anamorphic', '35mm film', '16mm', 'golden hour', 'sunset light',
  'soft light', 'natural light', 'daylight', 'backlight', 'backlit', 'lighting', 'high contrast', 'vibrant colors', '8k', '4k', 'masterpiece']
/* CAMERA words: framing and movement are assigned by the code. */
export const MOTS_CAMERA = ['close-up', 'close up', 'medium shot', 'wide shot', 'full-body shot', 'eye level', 'low angle', 'high angle',
  'three-quarter view', 'profile view', 'over the shoulder', 'push-in', 'push in', 'panning', 'pans across', 'dolly', 'tracking shot',
  'orbit', 'handheld', 'zoom', 'zooms', 'static camera', 'the camera', 'slow motion', 'slowly']
/* What image and video models get wrong or the demo refuses: listed to the LLM, never removed
   blindly ("sign" or "text" have other meanings); a shot containing one is retried. */
export const MOTS_SCENE = ['pigeons', 'birds', 'seagulls', 'dogs', 'cats', 'horses', 'animals', 'waiter', 'waitress', 'vendor', 'friend',
  'crowd', 'people', 'neighbor', 'neighbour', 'someone', 'stranger', 'mirror', 'reflection', 'sign', 'logo', 'brand', 'text', 'menu board', 'poster']

const echapper = m => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const motif = mots => new RegExp(`\\b(?:${mots.map(echapper).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi')

/** The reminder placed AFTER the request: the list of words never to write. */
export const rappel = (mots, quoi = 'the shots') => `(Reminder for ${quoi}: describe only the content — who, what, where, which gesture. Never write these words: ${mots.join(', ')}.)`

/** Removes from content text the phrase fragments (between commas) about look or camera:
 *  cutting just the word leaves debris ("at, shallow"); the whole fragment carries no action. */
export function sansMots(texte, mots) {
  const re = motif(mots), mm = /\b\d+\s?mm\b|\bf\/\d+(\.\d+)?\b/i
  return String(texte ?? '').split(/(?<=[.!?])\s+/).map(ph => ph.replace(/[.!?]$/, '').split(/\s*,\s*/)
    .filter(m => { re.lastIndex = 0; return !re.test(m) && !mm.test(m) }).join(', ')).filter(Boolean).map(ph => ph + '.').join(' ').trim()
}

/** Words from a list present in a text (for a targeted retry). */
export const motsPresents = (texte, mots) => [...new Set((String(texte ?? '').match(motif(mots)) ?? []).map(m => m.toLowerCase()))]

/** An LLM response without code block, "Prompt:" or surrounding quotes. */
export function nettoyer(texte) {
  let t = String(texte ?? '').trim()
  const bloc = t.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i)
  if (bloc) t = bloc[1].trim()
  t = t.replace(/^(enhanced|improved|rewritten)?\s*prompt\s*:\s*/i, '')
  for (const [a, b] of [['"', '"'], ['“', '”'], ['\'', '\'']]) if (t.startsWith(a) && t.endsWith(b) && !t.slice(1, -1).includes(a)) t = t.slice(1, -1).trim()
  return t
}

/** A clean sentence: capital letter, final period, single spaces. */
export const phrase = t => { const s = String(t ?? '').trim().replace(/\s{2,}/g, ' ').replace(/[\s,;]+$/, ''); return s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : '' }
