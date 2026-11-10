/* ============================================================
   Image reading by local VLM (Ollama): scene description, breakdown into
   dimensions (carousel) and outfit extraction.
   The description is always an INPUT to the rewriter, never a diffusion
   prompt: downstream code guards apply unchanged.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'

/* The VLM is unloaded after each call in production so RAM returns to
   ComfyUI. CREATOROS_VLM_KEEPALIVE='10m' keeps it warm (e.g. during test
   runs) without changing the default. */
const VLM_KEEPALIVE = process.env.CREATOROS_VLM_KEEPALIVE || 0

/* Shared options: CPU avoids any VRAM contention with ComfyUI (composer
   rule), temperature 0 makes the description reproducible. */
const DESC_MODEL = () => CONFIG.visionDescribeModel
const DESC_OPTS = extra => ({ temperature: 0, ...(CONFIG.visionDescribeCpu ? { num_gpu: 0 } : {}), ...extra })

/* Next beat: the moment after this photo, as one edit instruction. Same place,
   same outfit, an ordinary gesture; the text goes through the filter again before use. */
export async function momentSuivant(absPath) {
  const b64 = fs.readFileSync(absPath).toString('base64')
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: DESC_MODEL(), stream: false, images: [b64],
      /* the NEXT shot, not the same image: a clearly different action or expression, and a different framing. */
      prompt: 'This photo is one shot of a short film. Write the NEXT shot, a few seconds later, in one English sentence of at most 30 words: '
        + 'what the same person does now (a clearly different, ordinary, fully clothed action or expression) and how the camera frames it '
        + '(closer or wider, or another angle). It must look clearly different from this frame. Start with the shot size, e.g. "Close-up:" or "Wide shot:". Name nobody. No preamble.',
      options: DESC_OPTS({ num_predict: 80, temperature: 0.4 }),
      keep_alive: VLM_KEEPALIVE,
    }),
  })
  if (!res.ok) throw new Error(`modèle de vision : HTTP ${res.status}`)
  return String((await res.json()).response ?? '').trim().replace(/\s+/g, ' ').slice(0, 260)
}

/* Full SCENE description: what the source image shows (action, place,
   outfit, mood) so the LLM grasps the concept even from a short prompt. */
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
   BREAKDOWN INTO DIMENSIONS: the basis of the "shooting" carousel.

   The goal is to KEEP one dimension and vary the others. Only pose checked:
   the pose is the constant and the batch varies place and outfit. Outfit and
   place checked: those hold, the rest varies.

   Two steps, because no model does both well: the VLM DESCRIBES, the
   writer at temperature 0 SORTS (classifies without drifting).
   ============================================================ */
export async function decomposeScene(absPath) {
  let b64
  try { b64 = fs.readFileSync(absPath).toString('base64') } catch { return null }
  /* 1) RICH description, longer than describeScene because it gets split:
        what is missing here will be missing from every dimension. */
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

  /* 2) sort into JSON. The VLM often follows the requested format, so its
        own labels are read first, and the sorter is only called if they are
        missing (saves an LLM call). */
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
        /* By default the VLM captions EVERYTHING (hair, skin, setting), which would
           describe identity and freeze the setting in carousel variants. Hence the
           explicit negative instruction, backed by a code filter below (a text
           guard alone does not hold). */
        prompt: 'List ONLY the garments she is wearing, as a comma-separated list usable in an image prompt '
          + '(no sentence, no subject, no preamble): garment types with their exact colors and materials. '
          + 'Use the form: <colour> <material> <garment>, <colour> <material> <garment>. '
          /* "white shirt" is ambiguous for an image model: it renders a t-shirt.
             A shirt must be called "button-up shirt". */
          + 'Name the PRECISE garment type, never a generic one: say "button-up shirt", "blouse", "t-shirt", '
          + '"tank top", "camisole", "crop top", "polo shirt" — never just "shirt" or "top". For each garment add '
          + 'the details that distinguish it: collar or no collar, buttons or no buttons, sleeve length, and how '
          + 'it is worn (tucked in, tied at the front, open, buttoned up). '
          /* NO concrete example here: the VLM copies it verbatim into its output.
             Same trap as the composer's MARKERS. */
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

/* CODE guard for the outfit anchor: only segments that REALLY name a garment
   survive. Everything else (hair, skin, jewelry, setting, anatomy) is dropped,
   since that is what the VLM adds and what the anchor must not freeze.
   Nude ⇒ null: the caller then keeps the prompt's text outfit. */
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
    .replace(/^[^:]{0,40}:\s*/, '')          // optional "Outfit: …"
    .split(/\s*,\s*|\s*;\s*|\n+/)
    .map(x => x.trim().replace(/\.$/, ''))
    .filter(x => x && x.length < 60 && GARMENT.test(x)
      // "barefoot" matches 'foot' but expresses the ABSENCE of shoes
      && !/\bbarefoot\b/i.test(x))
  /* Dedup by WORD SUBSET: the VLM often repeats the same piece at two levels
     of detail ("white ribbed tank top" AND "white tank top"). String inclusion
     misses them ("ribbed" sits in between), so words are compared. A segment
     whose words are all covered by another, more precise one is redundant.
     Original order is preserved. */
  const uniq = [...new Set(kept)]
  const words = x => new Set(x.toLowerCase().split(/\s+/).filter(Boolean))
  const final = uniq.filter((x, i) => {
    const wx = words(x)
    return !uniq.some((y, j) => {
      if (i === j) return false
      const wy = words(y)
      if (wy.size <= wx.size) return false       // y must be more precise
      return [...wx].every(w => wy.has(w))
    })
  })
  /* One piece per BODY PART. Reasoning by garment type is not enough: the VLM
     names the same shirt "button-up shirt", "blouse", "camisole" and "crop top",
     four types but one top, and the rewriter would dress the subject in four
     layers. For each part, the MOST detailed wording is kept. */
  const PARTIES = [
    ['robe', /\b(dress|gown|jumpsuit|romper|bodysuit|swimsuit|robe|kimono)\b/i],
    ['haut', /\b(shirt|blouse|t-?shirt|tank|camisole|cami|top|sweater|hoodie|cardigan|jacket|coat|blazer)\b/i],
    ['bas', /\b(skirt|shorts|pants|trousers|jeans|leggings|tights)\b/i],
    /* Legwear and shoes are separate: stockings and heels coexist, merging
       them would drop one. */
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
  /* Stable, readable order: what is seen first comes first. */
  const ordre = ['robe', 'haut', 'bas', 'jambes', 'pieds', 'accessoire']
  const out = ordre.filter(k => best.has(k)).map(k => best.get(k)).join(', ')
  return out.length > 8 ? out : null
}

/* Clip analysis for social media: measurements (duration, format, audio, cuts, sharpness
   of the opening) and a vision-model read of 4 frames (hook, subject, readability).
   A quality estimate, not a view-count prediction. */
export async function analyserClip(absPath, langue = 'fr') {
  const sonde = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', absPath], { encoding: 'utf8' }))
  const duree = Number(sonde.format?.duration) || 0
  const v = sonde.streams?.find(s => s.codec_type === 'video') ?? {}
  const son = sonde.streams?.some(s => s.codec_type === 'audio')
  let coupes = 0
  try {
    const o = execFileSync('ffmpeg', ['-hide_banner', '-i', absPath, '-vf', "select='gt(scene,0.35)',showinfo", '-an', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    coupes = (o.match(/pts_time/g) ?? []).length
  } catch (e) { coupes = (String(e.stderr ?? '').match(/pts_time/g) ?? []).length }
  // objective measurements: sharpness (blurdetect, higher = blurrier), mean motion between frames, brightness and contrast
  const objectif = { flou: null, mouvement: null, lumiere: null, contraste: null }
  try {
    const o = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', absPath, '-vf', "fps=4,scale=640:-2,blurdetect,signalstats,metadata=print:file=-", '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    const moy = re => { const v = [...o.matchAll(re)].map(m => Number(m[1])).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
    objectif.flou = moy(/lavfi\.blur=([0-9.]+)/g)
    objectif.lumiere = moy(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)
    const hi = moy(/lavfi\.signalstats\.YHIGH=([0-9.]+)/g), lo = moy(/lavfi\.signalstats\.YLOW=([0-9.]+)/g)
    objectif.contraste = hi != null && lo != null ? hi - lo : null
    objectif.mouvement = moy(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)
  } catch { /* measurements unavailable: the model's opinion alone */ }
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'analyse-'))
  const instants = [0.3, 1.2, duree * 0.5, Math.max(0.3, duree - 0.4)]
  const images = instants.map((t, i) => { const f = path.join(dossier, `${i}.jpg`); execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', absPath, '-frames:v', '1', '-vf', 'scale=512:-2', f]); return fs.readFileSync(f).toString('base64') })
  fs.rmSync(dossier, { recursive: true, force: true })
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(240000),
    body: JSON.stringify({ model: DESC_MODEL(), stream: false, images, options: DESC_OPTS({ num_predict: 500 }),
      prompt: `These are 4 frames of a short social video, in order: at 0.3 s, 1.2 s, the middle and the end. You are a demanding social media editor who rejects most posts. First describe in one sentence what you actually see in "seen". Then score from 1 to 10 with this scale: 3 = a random snapshot nobody would stop for, 5 = an ordinary amateur post, 7 = a good post above most of the feed, 9 = top 1 % professional work, 10 = almost never. Most clips score between 3 and 6; give 8 or more only with a concrete reason. "hook": would the first two frames make a stranger stop scrolling? "subject": is the main subject instantly clear? "visual": light, sharpness, composition, colour. "story": does something visibly change or happen between the first and the last frame? Identical frames score 1 or 2 for story. Then give exactly 3 short, concrete tips to improve it, written in ${langue === 'en' ? 'English' : 'French'}. Answer in JSON only: {"seen":"...","hook":n,"subject":n,"visual":n,"story":n,"tips":["...","...","..."]}`,
      format: { type: 'object', required: ['seen', 'hook', 'subject', 'visual', 'story', 'tips'], properties: { seen: { type: 'string' }, hook: { type: 'integer' }, subject: { type: 'integer' }, visual: { type: 'integer' }, story: { type: 'integer' }, tips: { type: 'array', items: { type: 'string' } } } } }),
  })
  if (!res.ok) throw new Error(`modèle de vision : HTTP ${res.status}`)
  const brut = String((await res.json()).response || '{}')
  if (process.env.CREATOROS_DEBUG_ANALYSE) console.error('[analyse]', brut.slice(0, 600))
  const lu = JSON.parse(brut)
  const note = k => Math.min(10, Math.max(1, Math.round(Number(lu[k]) || 5)))
  const ratio = v.width && v.height ? v.width / v.height : 1
  const mesures = {
    duree: Math.round(duree * 10) / 10, format: ratio < 0.7 ? '9:16' : ratio > 1.4 ? '16:9' : 'carré', son: !!son, coupes,
    rythme: duree ? Math.round((coupes / duree) * 60) : 0,
    flou: objectif.flou != null ? Math.round(objectif.flou * 10) / 10 : null, mouvement: objectif.mouvement != null ? Math.round(objectif.mouvement * 10) / 10 : null,
  }
  const conseilsMesures = [
    ...(mesures.format !== '9:16' ? ['Pour TikTok, Reels et Shorts, passe-le en 9:16 (outil Recadrer).'] : []),
    ...(!son ? ['Il est muet : ajoute un son ou une musique, la plupart des vidéos sont regardées avec le son au moins une fois.'] : []),
    ...(duree > 4 && coupes === 0 ? ['Un seul plan de plus de 4 s : une coupe ou un mouvement de caméra relance l’attention.'] : []),
  ]
  const notes = { accroche: note('hook'), sujet: note('subject'), image: note('visual'), histoire: note('story') }
  // measurements cap the model's score: a blurry, dark, dull or static clip cannot score well
  const plafond = (k, max) => { notes[k] = Math.max(1, Math.min(notes[k], max)) }
  if (objectif.flou != null && objectif.flou > 8) plafond('image', objectif.flou > 11 ? 4 : 6)
  if (objectif.lumiere != null && (objectif.lumiere < 35 || objectif.lumiere > 215)) plafond('image', 5)
  if (objectif.contraste != null && objectif.contraste < 60) plafond('image', 5)
  if (objectif.mouvement != null && objectif.mouvement < 2) { plafond('histoire', 3); plafond('accroche', 5) }
  if (!son) plafond('accroche', 7)
  return { notes, global: Math.round((notes.accroche * 2 + notes.sujet + notes.image + notes.histoire) / 5 * 10) / 10, mesures,
    conseils: [...conseilsMesures, ...(Array.isArray(lu.tips) ? lu.tips.slice(0, 3).map(x => String(x).slice(0, 200)) : [])] }
}
