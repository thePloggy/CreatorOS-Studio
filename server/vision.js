/* ============================================================
   Lecture d'image par VLM local (Ollama) : description de scène,
   décomposition en dimensions (carrousel) et relevé de la tenue.
   La description est toujours une ENTRÉE du réécriveur, jamais un
   prompt de diffusion : les gardes code en aval s'appliquent inchangées.
   ============================================================ */
import fs from 'node:fs'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'

/* Le VLM est déchargé après chaque appel en production — la RAM doit revenir
   à ComfyUI. Pendant une campagne de bench, des dizaines de rechargements
   coûtent cher : CREATOROS_VLM_KEEPALIVE='10m' le garde chaud sans toucher
   au défaut. */
const VLM_KEEPALIVE = process.env.CREATOROS_VLM_KEEPALIVE || 0

/* Options communes : le CPU évite toute concurrence VRAM avec ComfyUI (règle
   du composeur), la température 0 rend la description reproductible. */
const DESC_MODEL = () => CONFIG.visionDescribeModel
const DESC_OPTS = extra => ({ temperature: 0, ...(CONFIG.visionDescribeCpu ? { num_gpu: 0 } : {}), ...extra })

/* Next beat (31/10) : le moment qui suit cette photo, en une consigne de retouche. Même lieu,
   même tenue, un geste ordinaire ; le texte repasse par le filtre avant de servir. */
export async function momentSuivant(absPath) {
  const b64 = fs.readFileSync(absPath).toString('base64')
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: DESC_MODEL(), stream: false, images: [b64],
      prompt: 'This photo is one shot of a short film. In one English sentence of at most 18 words, describe what the person does a few seconds later: '
        + 'one ordinary, fully clothed action in the same place, for example turning, walking on, sitting down, looking at something. '
        + 'Start with a verb in the present tense, third person. Name nobody. No preamble.',
      options: DESC_OPTS({ num_predict: 60 }),
      keep_alive: VLM_KEEPALIVE,
    }),
  })
  if (!res.ok) throw new Error(`modèle de vision : HTTP ${res.status}`)
  return String((await res.json()).response ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
}

/* Description de SCÈNE complète : ce que montre l'image source — action,
   lieu, tenue, ambiance — pour que le LLM comprenne le concept même sur un
   prompt court. */
export async function describeScene(absPath) {
  let b64
  try { b64 = fs.readFileSync(absPath).toString('base64') } catch { return null }
  try {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model: DESC_MODEL(), stream: false, images: [b64],
        prompt: "Describe this photo factually in 2-3 short sentences for an image-prompt writer: "
          + "the person's action and pose, what they are wearing, "
          + "the location/background, the mood and camera angle. Be literal about what is visible. No preamble.",
        options: DESC_OPTS({ num_predict: 140 }),
        keep_alive: VLM_KEEPALIVE,
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    const out = String(d.response || '').trim()
    return out.length > 15 ? out : null
  } catch { return null }
}

/* ============================================================
   DÉCOMPOSITION EN DIMENSIONS — la base du carrousel « shooting ».

   Une image d'ancrage ne vaut pas comme description globale : ce qu'on veut,
   c'est pouvoir GARDER une dimension et faire varier les autres. Pose cochée
   et rien d'autre : « debout les bras en l'air » devient la constante, et le
   lot la décline à Chantilly nue, en cuisine en robe noire, en jogging dans un
   avion. Tenue et lieu cochés : la robe et la cuisine tiennent, le reste bouge.

   Deux étapes, parce qu'aucun modèle ne fait bien les deux : le VLM DÉCRIT,
   le rédacteur à température 0 TRIE (il classe sans dériver).
   ============================================================ */
export async function decomposeScene(absPath) {
  let b64
  try { b64 = fs.readFileSync(absPath).toString('base64') } catch { return null }
  /* 1) description RICHE — plus longue que describeScene, parce qu'on va la
        découper : ce qui manque ici manquera dans toutes les dimensions. */
  let brut = null
  try {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model: DESC_MODEL(), stream: false, images: [b64],
        prompt: 'Describe this photo factually and in detail for an image-prompt writer, in four parts, '
          + 'each on its own line:\n'
          + 'OUTFIT: every garment and accessory she wears, with cut, colour, pattern, fabric and how it sits '
          + 'on her.\n'
          + 'POSE: her body position and what she is doing — her weight, limbs, hands, head, gaze. '
          + 'Describe the GESTURE without naming the furniture or the place: say "leaning back against a '
          + 'waist-high surface", never "against the kitchen counter". The objects belong to PROPS. '
          + 'Name the overall gesture in one clause; do NOT enumerate each limb one by one — no "right arm '
          + 'here, left arm there, hands like this": a limb inventory makes the image model draw an extra one.\n'
          + 'LOCATION: where she is, the background, the light.\n'
          + 'PROPS: the objects, furniture or vehicles around her that she could touch or use.\n'
          + 'STYLE: the photographic treatment — the light, the mood, the colour, the grain, the lens feel.\n'
          + 'Be literal about what is visible. No preamble.',
        options: DESC_OPTS({ num_predict: 320 }),
        keep_alive: VLM_KEEPALIVE,
      }),
    })
    if (res.ok) brut = String((await res.json()).response || '').trim()
  } catch { brut = null }
  if (!brut || brut.length < 30) return null

  /* 2) tri en JSON. Le VLM respecte souvent le format demandé — on essaie
        d'abord de lire ses propres étiquettes, et on n'appelle le trieur que
        si elles manquent. Un appel LLM évité est 15 s de gagnées. */
  const direct = {}
  for (const [clef, mot] of [['outfit', 'OUTFIT'], ['pose', 'POSE'], ['location', 'LOCATION'], ['props', 'PROPS'], ['style', 'STYLE']]) {
    const m = brut.match(new RegExp(`${mot}\\s*:\\s*([^\\n]+)`, 'i'))
    if (m) direct[clef] = m[1].trim()
  }
  if (Object.keys(direct).length === 5) return { ...direct, brut }

  try {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CONFIG.composerTimeoutMs),
      body: JSON.stringify({
        model: CONFIG.composerModels.sfw, stream: false, keep_alive: VLM_KEEPALIVE, think: false,
        system: 'You sort a photo description into five fields. Output STRICT JSON '
          + '{"outfit":"","pose":"","location":"","props":"","style":""} and nothing else.\n'
          + 'outfit = every garment and accessory she wears, with cut, colour, fabric.\n'
          + 'pose = her body position, her limbs, what she is doing, her gaze — the GESTURE only, '
          + 'with the furniture and the place stripped out of it ("leaning back against a waist-high surface", '
          + 'not "against the kitchen counter").\n'
          + 'location = where she is, the background, the light.\n'
          + 'props = objects, furniture or vehicles around her she could touch or use.\n'
          + 'style = the photographic treatment: light, mood, colour, grain, lens feel.\n'
          + 'Copy the wording of the description; never invent what it does not say. '
          + 'A field with nothing to say is an empty string.',
        prompt: brut,
        options: { num_gpu: 0, num_ctx: 4096, num_predict: 500, temperature: 0 },
      }),
    })
    if (!res.ok) return null
    const m = String((await res.json()).response || '').match(/\{[\s\S]*\}/)
    if (!m) return null
    const o = JSON.parse(m[0])
    const net = x => (typeof x === 'string' ? x.trim() : '')
    return { outfit: net(o.outfit), pose: net(o.pose), location: net(o.location), props: net(o.props),
      style: net(o.style), brut }
  } catch { return null }
}

export async function describeOutfit(absPath) {
  let b64
  try { b64 = fs.readFileSync(absPath).toString('base64') } catch { return null }
  try {
    const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model: DESC_MODEL(), stream: false, images: [b64],
        /* Le VLM légende TOUT par défaut (cheveux, peau, décor) : laissé libre
           il rendait « …, black hair, braided hair, tiled floor, evening sky »,
           ce qui décrirait l'identité et figerait le décor dans les variantes
           du carrousel. D'où la consigne négative
           explicite — doublée d'un filtre code plus bas (une garde textuelle
           seule ne tient pas). */
        prompt: 'List ONLY the garments she is wearing, as a comma-separated list usable in an image prompt '
          + '(no sentence, no subject, no preamble): garment types with their exact colors and materials. '
          + 'Use the form: <colour> <material> <garment>, <colour> <material> <garment>. '
          /* « white shirt » est ambigu pour un modèle d'image : il rend un
             t-shirt. Une chemise doit se dire « button-up shirt ». Constaté
             sur un carrousel rendu en t-shirt alors que l'ancre disait
             « white shirt » — le VLM avait raison, le mot était trop vague. */
          + 'Name the PRECISE garment type, never a generic one: say "button-up shirt", "blouse", "t-shirt", '
          + '"tank top", "camisole", "crop top", "polo shirt" — never just "shirt" or "top". For each garment add '
          + 'the details that distinguish it: collar or no collar, buttons or no buttons, sleeve length, and how '
          + 'it is worn (tucked in, tied at the front, open, buttoned up). '
          /* AUCUN exemple concret ici : le VLM le recopie tel quel. Mesuré
             le 19/09 — avec « light-wash denim shorts » en exemple, il l'a
             rendu mot pour mot sur une photo N&B dont le short est blanc à
             cordon. Même piège que les MARKERS du composeur. */
          + 'Do NOT mention her hair, skin, body, jewellery, the background, the floor, the sky, the lighting or the camera. '
          + 'If no garment is visible, answer with the single word: none.',
        options: DESC_OPTS({ num_predict: 90 }),
        keep_alive: VLM_KEEPALIVE,
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    const out = String(d.response || '').trim()
    return filterOutfit(out)
  } catch { return null }
}

/* Garde CODE de l'ancre tenue : ne survivent que les segments qui nomment
   VRAIMENT un vêtement. Tout le reste (cheveux, peau, bijoux, décor, anatomie)
   est jeté — c'est ce que le VLM ajoute spontanément et c'est précisément ce
   que l'ancre ne doit pas figer. Nu ⇒ null : l'appelant garde alors la tenue
   textuelle du prompt plutôt qu'une liste anatomique. */
const GARMENT = new RegExp('\\b(' + [
  'top|shirt|blouse|t-shirt|tee|tank|camisole|crop|sweater|jumper|cardigan|hoodie|sweatshirt',
  'dress|gown|robe|kimono|kaftan|bodysuit|leotard|romper|jumpsuit|onesie',
  'skirt|shorts|pants|trousers|jeans|leggings|tights|stockings|pantyhose|joggers|sweatpants',
  'swimsuit|swimwear',
  'jacket|coat|blazer|parka|vest|waistcoat|poncho|shawl|cape',
  'boots|heels|sneakers|shoes|sandals|flats|loafers|socks',
  'belt|suspenders|apron|uniform|scrubs|costume',
].join('|') + ')\\b', 'i')
const AUCUN_VETEMENT = /^\s*(nothing|no clothing|none)\b/i

export function filterOutfit(raw) {
  const txt = String(raw || '').trim()
  if (!txt || AUCUN_VETEMENT.test(txt)) return null
  const kept = txt
    .replace(/^[^:]{0,40}:\s*/, '')          // « Outfit: … » éventuel
    .split(/\s*,\s*|\s*;\s*|\n+/)
    .map(x => x.trim().replace(/\.$/, ''))
    .filter(x => x && x.length < 60 && GARMENT.test(x)
      // « barefoot » matche 'foot' de rien, mais dit l'ABSENCE de chaussure
      && !/\bbarefoot\b/i.test(x))
  /* Dédup par SOUS-ENSEMBLE DE MOTS : le VLM répète souvent la même pièce en
     deux niveaux de détail (« white ribbed tank top » ET « white tank top »).
     L'inclusion de chaîne ne les rapproche pas (« ribbed » s'intercale) : on
     compare les mots. Le segment dont tous les mots sont déjà couverts par un
     autre, plus précis, est redondant. L'ordre d'origine est conservé. */
  const uniq = [...new Set(kept)]
  const words = x => new Set(x.toLowerCase().split(/\s+/).filter(Boolean))
  const final = uniq.filter((x, i) => {
    const wx = words(x)
    return !uniq.some((y, j) => {
      if (i === j) return false
      const wy = words(y)
      if (wy.size <= wx.size) return false       // y doit être plus précis
      return [...wx].every(w => wy.has(w))
    })
  })
  /* Une pièce par PARTIE DU CORPS. Raisonner par type de vêtement ne suffit
     pas : le VLM nomme la même chemise « button-up shirt », « blouse »,
     « camisole » et « crop top » (mesuré 22/09), qui sont quatre types mais
     un seul haut — le réécriveur en habillait le sujet de quatre couches.
     Pour chaque partie on garde la formulation la PLUS détaillée. */
  const PARTIES = [
    ['robe', /\b(dress|gown|jumpsuit|romper|bodysuit|swimsuit|robe|kimono)\b/i],
    ['haut', /\b(shirt|blouse|t-?shirt|tank|camisole|cami|top|sweater|hoodie|cardigan|jacket|coat|blazer)\b/i],
    ['bas', /\b(skirt|shorts|pants|trousers|jeans|leggings|tights)\b/i],
    /* Bas de jambe et chaussures séparés : des bas et des talons coexistent,
       les confondre en faisait perdre un. */
    ['jambes', /\b(socks|stockings|tights)\b/i],
    ['pieds', /\b(shoes|heels|boots|sneakers|sandals)\b/i],
    ['accessoire', /\b(scarf|belt|hat|cap|gloves)\b/i],
  ]
  const best = new Map()
  for (const seg of final) {
    const partie = PARTIES.find(([, re]) => re.test(seg))?.[0]
    if (!partie) continue
    const vu = best.get(partie)
    if (!vu || seg.split(/\s+/).length > vu.split(/\s+/).length) best.set(partie, seg)
  }
  /* Ordre stable et lisible : ce qu'on voit d'abord en premier. */
  const ordre = ['robe', 'haut', 'bas', 'jambes', 'pieds', 'accessoire']
  const out = ordre.filter(k => best.has(k)).map(k => best.get(k)).join(', ')
  return out.length > 8 ? out : null
}
