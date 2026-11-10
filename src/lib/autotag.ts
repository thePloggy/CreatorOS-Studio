/* ============================================================
   Client-side auto-tagging for user ADDITIONS: an English prompt
   line → attributes (garment/material/color), autocomplete tags
   and French title.
   ============================================================ */

const COLORS: [string, string][] = [
  ['forest-green', 'vert forêt'], ['sage-green', 'vert sauge'], ['pale-yellow', 'jaune pâle'],
  ['sky-blue', 'bleu ciel'], ['royal-blue', 'bleu roi'], ['deep-red', 'rouge profond'],
  ['off-white', 'blanc cassé'], ['dusty-pink', 'vieux rose'], ['polka-dot', 'à pois'],
  ['white', 'blanc'], ['black', 'noir'], ['navy', 'marine'], ['beige', 'beige'], ['cream', 'crème'],
  ['ivory', 'ivoire'], ['red', 'rouge'], ['burgundy', 'bordeaux'], ['blush', 'rose poudré'],
  ['pink', 'rose'], ['mauve', 'mauve'], ['coral', 'corail'], ['terracotta', 'terracotta'],
  ['sage', 'sauge'], ['olive', 'olive'], ['green', 'vert'], ['blue', 'bleu'], ['lavender', 'lavande'],
  ['lilac', 'lilas'], ['purple', 'violet'], ['yellow', 'jaune'], ['gold', 'doré'], ['silver', 'argenté'],
  ['grey', 'gris'], ['gray', 'gris'], ['brown', 'marron'], ['tan', 'fauve'], ['camel', 'camel'],
  ['khaki', 'kaki'], ['emerald', 'émeraude'], ['turquoise', 'turquoise'], ['champagne', 'champagne'],
  ['charcoal', 'anthracite'], ['plum', 'prune'], ['pastel', 'pastel'],
  ['floral', 'fleuri'], ['striped', 'rayé'], ['gingham', 'vichy'], ['sequinned', 'à sequins'], ['denim', 'denim'],
]
const MATERIALS = ['broderie anglaise', 'ribbed knit', 'cotton', 'linen', 'silk', 'satin', 'denim',
  'knit', 'crochet', 'chiffon', 'tulle', 'leather', 'suede', 'velvet', 'cashmere',
  'wool', 'jersey', 'nylon', 'terry']
const GARMENTS: [string, string][] = [
  ['one-piece swimsuit', 'maillot une-pièce'],
  ['maxi dress', 'robe longue'], ['midi dress', 'robe midi'], ['mini dress', 'robe courte'],
  ['sundress', "robe d'été"], ['wrap dress', 'robe portefeuille'], ['halter dress', 'robe dos-nu'],
  ['shirt dress', 'robe chemise'], ['evening gown', 'robe de soirée'],
  ['tea dress', 'robe rétro'], ['gown', 'robe longue'], ['dress', 'robe'],
  ['swimsuit', 'maillot de bain'], ['raincoat', 'ciré'], ['jacket', 'veste'],
  ['shorts', 'short'], ['midi skirt', 'jupe midi'],
  ['mini skirt', 'mini-jupe'], ['skirt', 'jupe'], ['t-shirt', 't-shirt'], ['tank top', 'débardeur'],
  ['crop top', 'crop top'], ['tube top', 'bandeau'], ['bandeau top', 'bandeau'], ['halter top', 'top dos-nu'],
  ['blouse', 'blouse'], ['shirt', 'chemise'], ['sweater', 'pull'], ['cardigan', 'gilet'], ['jeans', 'jean'],
  ['trousers', 'pantalon'], ['jumpsuit', 'combinaison'], ['romper', 'combishort'], ['robe', 'peignoir'],
  ['kimono', 'kimono'], ['coat', 'manteau'], ['blazer', 'blazer'], ['overalls', 'salopette'],
  ['culottes', 'jupe-culotte'], ['sarong', 'paréo'], ['top', 'top'], ['scarf', 'foulard'],
]
const PLACES = ['Paris', 'Lyon', 'Marseille', 'Nice', 'Provence', 'Brittany', 'Alps',
  'Rome', 'Lisbon', 'Barcelona', 'London', 'Tokyo', 'New York']

function findFirst<T extends string | [string, string]>(text: string, cands: T[]): T | null {
  const low = text.toLowerCase()
  let best: T | null = null, pos = Infinity
  for (const c of cands) {
    const key = (Array.isArray(c) ? c[0] : (c as string)).toLowerCase()
    const i = low.indexOf(key)
    if (i >= 0 && i < pos) { best = c; pos = i }
  }
  return best
}

export function fitOf(text: string): string {
  const t = text.toLowerCase()
  if (/oversized|ample|loose/.test(t)) return 'ample'
  if (/flowing|fluid|relaxed|draped/.test(t)) return 'fluide'
  if (/fitted|bodycon|structured|high-cut/.test(t)) return 'ajustée'
  return ''
}

/** English outfit prompt line → attributes + tags + French title. */
export function autotagOutfit(prompt: string, context: string) {
  const gar = findFirst(prompt, GARMENTS)
  const color = findFirst(prompt, COLORS)
  const mat = findFirst(prompt, MATERIALS)
  const garment = gar?.[0] ?? ''
  const colorEn = color?.[0] ?? ''
  const labelFr = [(gar?.[1] ?? 'tenue'), color?.[1] ?? ''].filter(Boolean).join(' ')
    + (context && context !== 'général' ? ` · ${context}` : '')
  return {
    garment, material: mat ?? '', color: colorEn,
    fit: fitOf(prompt),
    label: [garment || 'tenue', colorEn].filter(Boolean).join(' '),
    labelFr,
    tags: [garment, mat ?? '', colorEn, context].filter(Boolean),
  }
}

/** English location prompt line → detected location + tags. */
export function autotagEnvironment(prompt: string, sceneType: string) {
  const place = findFirst(prompt, PLACES)
  return {
    location: place ?? '',
    tags: [place?.toLowerCase() ?? '', sceneType].filter(Boolean),
  }
}
