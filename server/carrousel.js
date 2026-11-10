/* ============================================================
   Carousel v2.
   Served by /api/carrousel and /api/carrousel/fiche.

   A carousel is ~8 photos from the SAME shoot as the source photo, which
   is #1 of the series. Six dimensions (outfit, pose, set, accessory,
   light, style), each locked (constant) or free.

   Principles:
   1. The writer gets the operator's ROOT PROMPT, found by walking up the
      batch lineage: the VLM paraphrase of the image loses detail
      ("a classic black car" for "1930s French coachbuilt convertible").
   2. A FICHE, in enforced JSON, merges root prompt and VLM description:
      for each dimension a long form and a short form (identifying
      attributes). The trunk is made of the short forms.
   3. Light is a separate dimension from set and style: a fixed look
      formula would say "natural daylight" on a night scene.
   4. FREE accessory: the grid draws a MODE per shot (none, original, an
      object from the place, a variant of the same family) and the writer
      picks the object. No object list: the writer knows more than a list.
   5. The writer fills FIELDS (action, appui, objet_exact, phrase) in
      enforced JSON; the code checks each shot and re-asks only faulty
      shots.
   6. No furniture list per place type: the support comes from the set
      and context.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'
import { db } from './db.js'
import * as prompts from './prompts.js'
import * as composer from './composer.js'
import { persona } from './persona.js'

const MOTEUR_PHOTO = CONFIG.photoEngine
const DIMS = ['outfit', 'pose', 'location', 'props', 'light', 'style']
const melange = a => [...a].sort(() => Math.random() - 0.5)
/* The identity preamble at the head of a composed prompt is not the operator's
   intent: it is stripped before re-reading a prompt. */
const sansPreambule = t => {
  const pre = [persona().trigger, persona().preamble].filter(Boolean).join(', ')
  const txt = String(t ?? '')
  return pre && txt.startsWith(pre) ? txt.slice(pre.length).replace(/^[,\s]+/, '') : txt
}
/** Subject name in the writer's instructions. */
/* The display name may carry a label in parentheses ("Jessica (KREA2)"):
   it is for the UI, not the prompt text. */
const sujet = () => String(persona().name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'the model'

/* ---------- lineage: finding the operator's prompt ----------
   A carousel job carries its batch's batchId; the source photo is linked
   to the batch via payload.batchIds. Walk up to the first job that is not
   a carousel shot. `promptRacine` short-circuits when a recent job has
   already stored it. */
export function promptRacine(anchorUri) {
  if (typeof anchorUri !== 'string' || !anchorUri) return null
  const q = 'SELECT j.id, j.user_prompt u, j.payload p FROM jobs j'
  let job = db.prepare(`${q} JOIN assets a ON a.job_id = j.id WHERE a.uri = ? OR a.filename = ?`)
    .get(anchorUri, path.basename(anchorUri))
  for (let i = 0; job && i < 10; i++) {
    let p = {}
    try { p = JSON.parse(job.p || '{}') } catch { /* unreadable payload */ }
    if (p.promptRacine) return p.promptRacine
    /* HD pass, upscale: the job has no prompt of its own, it derives from an
       image (parentAssetId). Walk up to it. */
    if (p.parentAssetId && !(p.initialBrief || job.u)) {
      const parent = db.prepare(`${q} JOIN assets a ON a.job_id = j.id WHERE a.id = ?`).get(p.parentAssetId)
      if (parent) { job = parent; continue }
      /* Source image deleted: the HD job kept the prompt that produced it
         (identity preamble at the head, stripped since it is not the operator's
         intent). */
      const cp = sansPreambule(p.composedPositive).trim()
      return cp || null
    }
    if (!p.carouselLocks || !p.batchId) return (p.initialBrief || job.u || '').trim() || null
    job = db.prepare(`${q}, json_each(json_extract(j.payload, '$.batchIds')) b WHERE b.value = ? LIMIT 1`).get(p.batchId)
  }
  return null
}

/* ---------- Ollama calls ---------- */
async function ollama({ model, system, prompt, images, format, temperature, predire = 3000 }) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 420000)),
    body: JSON.stringify({ model, system, prompt, images, format, stream: false, think: false, keep_alive: '10m',
      options: { num_gpu: 0, num_ctx: 8192, num_predict: predire, temperature } }),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status} (${model})`)
  return String((await res.json()).response || '').trim()
}

/* 1) VLM description: the one from vision.decomposeScene, with LIGHT split
   out of set and style. Not split here: the fiche does that. */
async function decrireImage(anchorUri) {
  if (typeof anchorUri !== 'string' || !anchorUri.startsWith('/media/')) return null
  let b64
  try { b64 = fs.readFileSync(path.join(CONFIG.mediaDir, path.basename(anchorUri))).toString('base64') } catch { return null }
  return ollama({ model: CONFIG.visionDescribeModel, images: [b64], temperature: 0, predire: 400,
    prompt: 'Describe this photo factually and in detail for an image-prompt writer, in six parts, '
      + 'each on its own line:\n'
      + 'OUTFIT: every garment and accessory she wears, with cut, colour, fabric.\n'
      + 'POSE: her body position and what she is doing, as one gesture, without naming the furniture or the place.\n'
      + 'LOCATION: where she is and the background — not the light.\n'
      + 'PROPS: the objects, furniture or vehicles around her that she could touch or use.\n'
      + 'LIGHT: the light only — its source, direction, quality, colour, the time of day.\n'
      + 'STYLE: the photographic treatment — lens feel, colour, grain — not the light.\n'
      + 'Be literal about what is visible. No preamble.' })
}

/* 2) Fiche: root prompt + VLM description -> six dimensions, long and short. */
const CHAMP = { type: 'object', properties: { texte: { type: 'string' }, court: { type: 'string' } }, required: ['texte', 'court'] }
const SCHEMA_FICHE = {
  type: 'object',
  properties: {
    contexte: { type: 'string' },
    outfit: CHAMP, pose: CHAMP, location: CHAMP, light: CHAMP, style: CHAMP,
    props: { type: 'object', properties: { texte: { type: 'string' }, court: { type: 'string' }, nom: { type: 'string' } }, required: ['texte', 'court', 'nom'] },
  },
  required: ['contexte', 'outfit', 'pose', 'location', 'props', 'light', 'style'],
}
const SYS_FICHE = 'You prepare the sheet of a photo shoot from two sources about the SAME photo: the OPERATOR PROMPT '
  + 'that generated it (the human intent) and a VISION DESCRIPTION of the actual image.\n'
  + 'The photo is the truth for what is visible: where the two disagree on something visible (a garment, an object, '
  + 'the light), follow the vision description. The operator prompt is the truth for what an image cannot say: '
  + 'the event, the name of the place, the era, the make of an object, the mood.\n'
  + 'For each dimension write `texte` (complete) and `court` (its identifying attributes only, a noun phrase of at '
  + 'most 20 words, no verb of posture — no "standing", no "falls to the ground").\n'
  + 'For the OUTFIT, `court` may reach 30 words and must keep EVERY attribute that distinguishes it: cut, neckline, '
  + 'straps or sleeves, slit, length, colour, fabric, each accessory — an image model given "white satin gown" '
  + 'invents a different dress.\n'
  + 'contexte: one sentence saying what this scene IS — event, place, era, mood.\n'
  + 'outfit: garments and accessories she wears.\n'
  + 'pose: her gesture only, without furniture or place.\n'
  + 'location: the place and background, without the light, and WITHOUT the objects listed in props.\n'
  + 'props: movable objects she could touch or use — a vehicle, furniture, a bag, a glass — never a building, a '
  + 'room, a garden or the place itself; the main one first. `nom` = the main object in one or two plain words '
  + '("car", "sofa"), empty if there is none.\n'
  + 'light: the light only — source, direction, quality, time of day.\n'
  + 'style: the photographic treatment (lens, colour), without the light.\n'
  + 'Never invent what neither source says. English.'

/** FINAL prompt that rendered the anchor image (after the Enhancer). The
 *  operator's brief may omit what the Enhancer added. */
function promptRendu(anchorUri) {
  if (typeof anchorUri !== 'string' || !anchorUri) return null
  const r = db.prepare('SELECT p.composed_positive c FROM assets a JOIN provenance p ON p.asset_id = a.id WHERE a.uri = ? OR a.filename = ?')
    .get(anchorUri, path.basename(anchorUri))
  return r?.c ? sansPreambule(r.c).slice(0, 1500) : null
}
async function etablirFiche({ racine, vlm, prompt, model, rendu }) {
  const src = (racine ? `OPERATOR PROMPT:\n${racine}\n\n` : `OPERATOR PROMPT: (unknown — this is the prompt of the photo itself)\n${prompt}\n\n`)
    + (rendu && rendu !== racine ? `PROMPT THAT RENDERED THIS PHOTO:\n${rendu}\n\n` : '')
    + `VISION DESCRIPTION:\n${vlm || '(no image description available — use the prompt alone)'}`
  const brut = await ollama({ model, system: SYS_FICHE, prompt: src, format: SCHEMA_FICHE, temperature: 0.2, predire: 1500 })
  const f = JSON.parse(brut)
  const net = x => String(x ?? '').trim().replace(/[,.\s]+$/, '')
  const out = { contexte: net(f.contexte).replace(/^(texte|contexte)\s*:\s*/i, ''), partner: 'none' }
  for (const k of DIMS) out[k] = { texte: net(f[k]?.texte), court: net(f[k]?.court) || net(f[k]?.texte) }
  out.props.nom = net(f.props?.nom).toLowerCase()
  if (/^(none|nothing|n\/a|-)$/i.test(out.props.court)) out.props = { texte: '', court: '', nom: '' }
  if (out.props.court) out.props.court = await nommerObjet({ props: out.props.court, contexte: out.contexte, racine, vlm, model })
  return out
}

/* Make and model of the main accessory. The "make and model" rule targets
   only the writer's NEW objects (objet_exact); when locked, the object is
   reused as the fiche names it, and "red classic car" would let the car
   change between shots. Inside the fiche the instruction loses against
   "never invent", hence this separate question. */
async function nommerObjet({ props, contexte, racine, vlm, model }) {
  // the model renames only the main object; the rest of the list is re-attached in code
  const [tete, ...reste] = props.split(/\s*,\s*/)
  /* FIELDS to fill rather than a free sentence: in free text the model dodges
     ("red vintage Italian roadster") and sometimes copies the fiche in French. */
  const sys = 'You identify the main object of a photo as a precise real product, the way the caption of a real '
    + 'photo would. Fill the fields in English:\n'
    + '- marque: the manufacturer. When the sources do not say it, CHOOSE the one that matches the description and '
    + 'fits the context (country, era, setting) — a choice is required for any manufactured object (car, motorbike, '
    + 'boat, bag, watch, bicycle, camera, furniture by a known maker). Empty only for an object no one makes as a '
    + 'brand (a rock, a tree trunk, a towel).\n'
    + '- modele: the model name (and generation), empty only when marque is empty.\n'
    + '- epoque: the decade when it helps ("1960s"), else empty.\n'
    + '- couleur: its colour as given, in English.\n'
    + '- type: what it is in one to three plain English words ("roadster", "leather tote", "bentwood chair").'
  const src = `CONTEXT: ${contexte}\n` + (racine ? `OPERATOR PROMPT: ${racine}\n` : '')
    + (vlm ? `VISION DESCRIPTION: ${String(vlm).slice(0, 800)}\n` : '') + `MAIN OBJECT: ${tete}`
  const champs = ['marque', 'modele', 'epoque', 'couleur', 'type']
  try {
    const brut = await ollama({ model, system: sys, prompt: src, temperature: 0.2, predire: 200,
      format: { type: 'object', properties: Object.fromEntries(champs.map(k => [k, { type: 'string' }])), required: champs } })
    const o = Object.fromEntries(champs.map(k => [k, String(JSON.parse(brut)[k] ?? '').trim().replace(/[.,]+$/, '')]))
    if (!o.marque || /^(none|unknown|n\/a|-|generic)$/i.test(o.marque)) return props
    const nomme = [o.couleur, o.epoque, o.marque, o.modele].filter(Boolean).join(' ').replace(/\s+/g, ' ')
    return nomme.split(/\s+/).length <= 15 ? [nomme, ...reste].join(', ') : props
  } catch { return props }
}

/* ---------- grid drawn in code ---------- */
/* STANDARD shot sizes, each with its LIMITS. "tight portrait, her face fills
   the frame" is read by Krea as "portrait photo" and comes out as a waist
   shot; "an extreme close-up... from the top of her head to her chin,
   nothing below her collarbones", in a separate composition sentence,
   actually tightens. Framing is therefore written in code at the end of
   the shot (see assembly). */
const CADRAGES = [
  'wide shot: she is small in the frame, the whole setting around her',
  'full-body shot: head to toe in the frame, a little space around her',
  'medium shot: framed from the waist up',
  'medium close-up: framed from the middle of her chest up',
  'extreme close-up: only her face fills the frame, from the top of her head to her chin',
  'full-body shot seen from a distance: the place around her fills most of the frame',
  'close-up: her head and shoulders fill the frame, cropped at the collarbones',
  'medium-long shot: framed from mid-thigh up',
]
const FAM = [
  'she is handling an object that belongs to this place',
  'she is touching or resting against something in the setting',
  'she is moving through the space: walking, arriving, stepping, turning',
  'she is attending to her own appearance — her hair, a sleeve, a hem, a strap',
  'she is absorbed in something outside the frame',
  'she is caught mid-gesture: reaching, adjusting, gathering, stretching',
  'she is settled somewhere — seated, perched, or leaning, at ease',
  'she is at rest, doing nothing but holding the lens',
]
const FAM_POSE_FIGEE = [
  'she holds the pose exactly as described, her expression softening',
  'she holds the pose, her gaze moving to the lens',
  'she holds the pose, her weight settling, the fabric falling into place',
  'she holds the pose, caught a breath later, her hair moved',
  'she holds the pose, her chin lifting slightly',
  'she holds the pose, her eyes closing for a moment',
  'she holds the pose, turned a few degrees on the spot',
  'she holds the pose, entirely still',
]
/** Accessory mode per shot. Locked: the original, in use, everywhere.
 *  Free: the operator's four modes spread over the series. Without a
 *  source accessory there is no "original" nor "same family". */
function modesAccessoire(n, verrouille, aUnAccessoire) {
  if (verrouille && aUnAccessoire) return Array(n).fill('verrou')
  /* REGULAR interaction with the accessory: a single shot without accessory,
     and only on a series of 6 or more. */
  const base = aUnAccessoire ? ['famille', 'lieu', 'origine', 'famille', 'lieu'] : ['lieu']
  const modes = Array.from({ length: n }, (_, i) => base[i % base.length])
  if (n >= 6) modes[n - 1] = 'aucun'
  return melange(modes)
}
function ligneAccessoire(mode, props, serre = false) {
  /* Tight shot: an object on the floor or a car makes the camera pull back;
     a small object held near the face keeps the close-up. The LOCKED object
     is not touched: it is the operator's choice. */
  if (serre && mode === 'verrou')
    return `prop = « ${props.court} », the one from the first photo, softly blurred behind her or at the edge of the frame — she does not need to touch it`
  /* Portrait: NO object. The portrait template is enough to tighten the shot,
     and an object near the face is disruptive (a wrench held up with a camera
     gaze reads as a threat). */
  if (serre) return 'prop = none — this is a portrait'
  const o = `« ${props.court} »`
  return {
    verrou: `prop = ${o}, the one from the first photo — she uses or touches it`,
    aucun: 'prop = none — nothing in her hands; her support comes from the setting itself',
    origine: `prop = ${o}, the one from the first photo — she uses or touches it`,
    lieu: 'prop = another object that truly belongs in this setting and this context — she uses or touches it',
    famille: `prop = another ${props.nom || 'object of the same kind as ' + o}, a different make and model from the original — she uses or touches it. `
      + `If another one makes no sense in this place (a second bed in the same bedroom), take another object that belongs here instead`,
  }[mode]
}

/* ---------- writing ---------- */
const SCHEMA_PLANS = n => ({
  type: 'object',
  properties: {
    shots: {
      type: 'array', minItems: n, maxItems: n,
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' }, appui: { type: 'string' }, objet_exact: { type: 'string' }, phrase: { type: 'string' },
        },
        required: ['action', 'appui', 'objet_exact', 'phrase'],
      },
    },
  },
  required: ['shots'],
})

function consigne({ n, fiche, keep, corpus }) {
  const L = []
  if (MOTEUR_PHOTO === 'krea') L.push('Never describe film grain, on-camera flash, motion blur or an analog snapshot look: the render style is added by the system.')
  L.push(`You are a photographer writing ${n} shots of ONE fashion and lifestyle photo shoot of ${sujet()}, a fictional adult. The first photo `
    + `of the shoot already exists; your ${n} shots are its siblings — same session, same world.`)
  L.push(`CONTEXT, for information — read it, never copy it: ${fiche.contexte}`)
  L.push('Each shot has an assignment line. For each shot fill, in this order:\n'
    + '- action: what her body does. The assigned action brief gives the KIND of movement — sitting, stretching, '
    + 'leaning, walking, lying. Adapt it to this woman, this outfit, this place and this mood: a woman in an evening '
    + 'gown at an elegant event does not crouch like an athlete or curl up in a ball. Keep the kind of movement, choose '
    + 'the version that is credible here. The brief may name furniture that is not in this setting: ignore it.\n'
    + '- appui: what her body rests on or is against, taken from this setting. The bare ground only when nothing else fits.\n'
    /* No brand example here: a given example ("a Hermès Kelly bag") comes back
       in almost every shot. */
    + '- objet_exact: the object assigned to this shot, named as a precise real thing — its make and model when it has '
    + 'one, its colour and its material, the way the caption of a real photo would name it; never a generic word. '
    + 'When the line assigns the object from the first photo, objet_exact is that object and you add NO other object '
    + 'to the shot. "none" only when the line says none.\n'
    + '- phrase: the shot for the image model, 1-2 sentences, 60 words max, English. Start with the assigned framing and '
    + 'camera angle, then what her body does, her hands, her support, and the exact object with what she does WITH it '
    + '— she touches it, leans on it, sits on it, holds it, opens it. Never an object left in the background. '
    + 'Only what is visible.')
  // the expression is added in code (drawn without repetition): the writer does not write one
  L.push('Except in a portrait, never describe her face, her expression or where she looks: the system adds it.')
  L.push('WHEN A LINE SAYS « action = PORTRAIT »: write a portrait, not a pose. The phrase is her expression and her '
    + 'gaze, and at most one hand near her face, her hair or her collar — never a posture, a stance, a support, her '
    + 'legs, her feet, or anything below her chest. appui is "none". Example of the SHAPE only (never copy its words): '
    + '"looking straight into the lens with a calm, confident expression, one hand resting at her collar".')
  L.push('DESCRIBE ONLY WHAT IS INSIDE THE ASSIGNED FRAME. In a close-up or extreme close-up: her face, her hands near '
    + 'it, her shoulders — never her legs, her feet, her shoes or how she stands. In a medium shot: nothing below the '
    + 'waist. Naming a body part that is out of frame pulls the camera back.')
  L.push('EVERY OBJECT IN THE SERIES IS DIFFERENT: never the same make, model or object in two shots, except the '
    + 'original where the line assigns it.')
  // One imperative sentence per dimension.
  const o = fiche.outfit.court, lieu = fiche.location.court
  if (keep.outfit) L.push(`OUTFIT — LOCKED: she wears « ${o} » in every shot. Never describe or change her clothes: the system adds them.`)
  else L.push('OUTFIT — FREE: you choose what she wears in each shot; she is always fully and opaquely dressed.')
  if (keep.pose) L.push(`POSE — LOCKED: « ${fiche.pose.texte} ». Her body and limbs stay exactly so; only framing and expression change. Do not re-describe her limbs.`)
  else L.push('POSE — FREE: a different thing done with the body in every shot, as assigned.')
  if (keep.location) L.push(`LOCATION — LOCKED: every shot is in « ${lieu} ». Do not describe the place again: the system adds it. Take her supports from it.`)
  else L.push('LOCATION — FREE: you may move her to another place of the same world, coherent with the context.')
  if (keep.props && fiche.props.court) L.push(`PROP — LOCKED: « ${fiche.props.court} » is in every shot and she uses or touches it.`)
  else L.push('PROP — FREE: follow the prop of each assignment line.')
  if (keep.light) L.push('LIGHT — LOCKED: never describe the light: the system adds it.')
  else L.push('LIGHT — FREE: you may change the light from one shot to the next, coherent with the place and the time — one short clause.')
  if (keep.style) L.push('STYLE — LOCKED: never describe the camera or the photographic treatment: the system adds it.')
  L.push('She is ALONE in every shot: never a second person, another hand, or a second face.')
  L.push('A reflection only happens in a mirror or in still water she faces — never in the glass of a vehicle.')
  L.push('EVERYTHING STAYS SAFE FOR WORK: fully and opaquely dressed, no lingerie, no suggestive pose.')
  L.push('Match the tone of these calibration shots — never reuse one:\n'
    + corpus.map(x => '- ' + x).join('\n'))
  return L.join('\n')
}

/** Checks in code, per shot. Only checks what is verifiable regardless of
 *  context; an object's plausibility is not. */
function fautes(s, mode, fiche, portrait = false) {
  const f = []
  const phrase = String(s?.phrase ?? '').trim()
  if (phrase.split(/\s+/).length < 8) f.push('the phrase is missing or too short')
  if (phrase.split(/\s+/).length > 90) f.push('the phrase is longer than 55 words')
  if (/\b(I|me|my|mine|we|us|our)\b/.test(phrase)) f.push('first person used: write in the third person — never I, me, my')
  if (!portrait && !String(s?.appui ?? '').trim()) f.push('appui is empty: say what her body rests on')
  const objet = String(s?.objet_exact ?? '').trim()
  const vide = /^(none|no|nothing|n\/a|-)?\.?$/i.test(objet)
  if ((mode === 'lieu' || mode === 'famille') && vide) f.push('a prop is assigned but objet_exact is empty')
  if (mode === 'aucun' && !vide) f.push('this shot has NO prop: objet_exact must be "none"')
  /* The object must appear in the sentence: look for its last significant
     word ("... Ferrari 250 GTB" -> "gtb"), not a fixed word. */
  const tete = objet.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !['the', 'and', 'with', 'her'].includes(w)).pop()
  if (!vide && tete && !phrase.toLowerCase().includes(tete)) f.push('objet_exact is not named in the phrase')
  /* Source accessory: one of the locked objects must be named (the set can
     lock several: sofa, lamp, window). */
  if (mode === 'verrou' || mode === 'origine') {
    /* head noun of each object: "wooden floor lamp with beige shade" -> "lamp" */
    const noms = String(fiche.props.court).toLowerCase().split(/\s*,\s*/)
      .map(x => x.split(/\s+(?:with|in|on|of)\s+/)[0].match(/[a-z]+/g)?.pop()).filter(Boolean)
    if (noms.length && !noms.some(x => new RegExp(`\\b${x}s?\\b`).test(phrase.toLowerCase())))
      f.push(`the phrase must name the original prop (« ${fiche.props.court} »)`)
  }
  return f
}

/** Preparation, shown to the operator BEFORE the locks: root prompt, VLM
 *  description and fiche. Writing reuses them (body.fiche, body.vlm,
 *  body.promptRacine) so the VLM runs only once. */
export async function preparer(body) {
  const { prompt = '', anchorUri, writerModel } = body || {}
  const model = typeof writerModel === 'string' && writerModel ? writerModel : composer.modelFor()
  const racine = (typeof body?.promptRacine === 'string' && body.promptRacine.trim()) || promptRacine(anchorUri)
  const vlm = await decrireImage(anchorUri)
  const fiche = await etablirFiche({ racine, vlm, prompt, model, rendu: promptRendu(anchorUri) })
  return { racine, vlm, fiche, dims: Object.fromEntries(DIMS.map(k => [k, fiche[k].court])) }
}

export async function ecrire(body) {
  const { prompt = '', n: nBrut, anchorUri, keep: keepBrut = {}, writerModel } = body || {}
  const n = Math.min(Math.max(Number(nBrut) || 8, 1), 12)
  const model = typeof writerModel === 'string' && writerModel ? writerModel : composer.modelFor()
  const keep = Object.fromEntries(DIMS.map(k => [k, !!keepBrut[k]]))
  const temps = {}
  let t = Date.now()

  const racine = (typeof body?.promptRacine === 'string' && body.promptRacine.trim()) || promptRacine(anchorUri)
  const vlm = body?.vlm ?? await decrireImage(anchorUri)
  temps.vlm = Date.now() - t; t = Date.now()
  const fiche = body?.fiche ?? await etablirFiche({ racine, vlm, prompt, model, rendu: promptRendu(anchorUri) })
  temps.fiche = Date.now() - t; t = Date.now()

  const lireCorpus = f => prompts.readPrompt(f).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const corpus = melange(lireCorpus('shoot_sfw.txt')).slice(0, 10)
  let positions = null
  if (!keep.pose) { try { const l = lireCorpus('poses_sfw.txt'); if (l.length >= n) positions = l } catch { /* families */ } }
  const familles = melange(keep.pose ? FAM_POSE_FIGEE : positions || FAM)
  const cadrages = melange(CADRAGES)
  const decor = `${fiche.location.texte} ${fiche.props.texte}`.toLowerCase()
  /* Angles matched to framing. A close-up with a top-down or ground-level
     angle forces the camera very close and steeply tilted: wide-angle look,
     enlarged head, curved background. Extreme angles go to medium and wide
     shots; tight shots get gentle angles. */
  const SERRE = /^(extreme close-up|close-up|medium close-up)/i
  const EXTREMES = melange(['from floor level, looking up', 'from high above, looking straight down', 'from just below her chin, looking up'])
  const LARGES = melange(['eye level, straight on', 'from behind, three-quarter rear view', 'three-quarter view from her side',
    'from across the space', ...(/\bmirror/.test(decor) ? ['in a mirror, shot over her shoulder into the glass'] : [])])
  const DOUX = melange(['eye level, straight on', 'slightly above eye level, looking a little down at her',
    'three-quarter view from her side', 'eye level, her face turned three-quarters to the lens'])
  const angles = (() => {
    const out = []; let e = 0, l = 0, d = 0
    for (let i = 0; i < n; i++) {
      if (SERRE.test(cadrages[i % cadrages.length])) out.push(DOUX[d++ % DOUX.length])
      else out.push(e < EXTREMES.length ? EXTREMES[e++] : LARGES[l++ % LARGES.length])
    }
    return out
  })()
  const modes = modesAccessoire(n, keep.props, !!fiche.props.court)
  /* Three candidate postures per shot when they come from the operator's
     list: the writer keeps the most plausible for the scene. A single imposed
     posture gives "mid-leap on the fountain rim" in an evening dress. All
     differ between shots: the list is drawn without replacement. */
  const parPlan = positions ? 3 : 1
  /* TIGHT SHOT = PORTRAIT. A posture alongside "head and shoulders" makes the
     model show the posture and pull back. A portrait prompt (subject and
     framing first, expression, blurred background, 85 mm) gives the right
     framing. Not in locked pose. */
  const portraitDe = i => !keep.pose && SERRE.test(cadrages[i % cadrages.length])
  // a portrait has no object (except the locked accessory, blurred behind her)
  for (let i = 0; i < n; i++) if (portraitDe(i) && modes[i] !== 'verrou') modes[i] = 'aucun'
  const actionDe = i => portraitDe(i)
    ? 'PORTRAIT — her expression and gaze, at most one hand near her face, hair or collar; no posture, no support, nothing below her chest'
    : parPlan === 1 ? familles[i % familles.length]
    : 'choose the most credible for this scene among: '
      + Array.from({ length: parPlan }, (_, k) => `(${k + 1}) ${familles[(i * parPlan + k) % familles.length]}`).join(' ')
  const ligneDe = i => `SHOT ${i + 1}: framing = ${cadrages[i % cadrages.length]}; `
    + `camera = ${angles[i % angles.length]}; action = ${actionDe(i)}; ${ligneAccessoire(modes[i], fiche.props, SERRE.test(cadrages[i % cadrages.length]))}`
  const lignes = Array.from({ length: n }, (_, i) => ligneDe(i))

  const system = consigne({ n, fiche, keep, corpus })
  const user = `Write exactly one shot for each line, in order:\n${lignes.join('\n')}`
  let shots = JSON.parse(await ollama({ model, system, prompt: user, format: SCHEMA_PLANS(n), temperature: 0.9 })).shots.slice(0, n)
  temps.redaction = Date.now() - t; t = Date.now()

  /* Per-shot check; faulty shots are re-asked together, once. */
  let erreurs = shots.map((s, i) => fautes(s, modes[i], fiche, portraitDe(i)))
  const aRefaire = erreurs.map((e, i) => (e.length ? i : -1)).filter(i => i >= 0)
  const relance = { plans: aRefaire.map(i => i + 1), avant: aRefaire.map(i => erreurs[i]) }
  if (aRefaire.length) {
    const u2 = 'Rewrite ONLY these shots. Each one failed a check, given after it:\n'
      + aRefaire.map(i => `${lignes[i]}\n  FAILED: ${erreurs[i].join('; ')}`).join('\n')
    const refaits = JSON.parse(await ollama({ model, system, prompt: u2, format: SCHEMA_PLANS(aRefaire.length), temperature: 0.7 })).shots
    aRefaire.forEach((i, j) => {
      if (refaits[j] && fautes(refaits[j], modes[i], fiche, portraitDe(i)).length < erreurs[i].length) shots[i] = refaits[j]
    })
    erreurs = shots.map((s, i) => fautes(s, modes[i], fiche, portraitDe(i)))
  }
  temps.relance = Date.now() - t

  /* Assembly: the shot (action and framing) first, then the short trunk of
     locked dimensions, then the look. */
  const RENDU_PRO = 'Clean professional photo, sharp focus, true-to-life colours, no grain, no filter, no retouching. '
    + 'Natural skin with visible pores.'
  const SMARTPHONE = 'Shot on a recent smartphone, clean HD photo, sharp focus, true-to-life colours, no grain, no filter, '
    + 'no retouching. Natural skin with visible pores.'
  /* Shoes and lower-leg items are kept OUT OF THE TRUNK when the shot does not
     show the feet: the model shows what it is told ("knee-high leather boots"
     gives a full-length shot). A garment is NEVER removed: what is not named
     does not exist, and a medium shot without written trousers renders bare
     legs. Only shoes, hosiery and a separately written length detail go. */
  const PIEDS = /\b(boots?|booties|heels?|heeled|stilettos?|pumps|shoes?|sneakers?|trainers|sandals?|espadrilles?|wedges?|platforms?|flats|flip-flops?|slippers?|clogs?|loafers?|mules|footwear|socks?|stockings?|tights|knee-high|thigh-high|slit|train|hem|hemline|floor-length|ankle-length|knee-length)\b/i
  const VETEMENT = /\b(dress|gown|skirt|jeans|trousers|pants|shorts|leggings|top|tank|shirt|blouse|jacket|coat|sweater|cardigan|hoodie|bodysuit|swimsuit|robe|camisole|jumpsuit|romper|overalls)\b/i
  const PLAN_SERRE = /^(extreme close-up|close-up|medium close-up|medium shot|medium-long shot)/i
  const tenueCadree = i => {
    const t = fiche.outfit.court.replace(/^(she\s+)?wear(s|ing)?\s+/i, '')
    if (!PLAN_SERRE.test(cadrages[i % cadrages.length])) return t
    /* PORTRAIT (close-up, extreme close-up): the outfit stops at the bust, since
       describing the lower part frames at the hips. Legs are out of frame:
       nothing is "undressed". The chest shot keeps the whole outfit. */
    if (portraitDe(i) && !/^medium close-up/i.test(cadrages[i % cadrages.length])) {
      const BAS = /\b(jeans|trousers|pants|shorts|skirt|leggings|joggers|culottes)\b/i
      return t.replace(/\s+tucked (?:in|into)\b[^,]*/gi, '')
        .split(/\s*,\s*/)
        /* A top garment carrying a length loses the length, not the garment;
           otherwise the whole dress would be dropped. */
        .map(seg => VETEMENT.test(seg) && !BAS.test(seg) ? seg.replace(/\b(knee|ankle|floor|mid-calf|calf|thigh|maxi|midi|mini)[- ]length\s*/gi, '').replace(/\b(maxi|midi|mini)\s+(?=dress|skirt)/gi, '') : seg)
        .filter(seg => !BAS.test(seg) && (!PIEDS.test(seg) || VETEMENT.test(seg))).join(', ')
    }
    return t.split(/\s*,\s*/).filter(seg => !PIEDS.test(seg) || VETEMENT.test(seg)).join(', ')
  }
  const tronc = i => [
    keep.outfit && tenueCadree(i) ? `She wears ${tenueCadree(i)}` : '',
    keep.pose ? fiche.pose.texte : '',
    /* Tight shot: describing the whole place asks to show the set, so to pull
       back. Reduced to its first element, blurred, the close-up holds. */
    keep.location ? (SERRE.test(cadrages[i % cadrages.length])
      ? `${fiche.location.court.split(/\s*,\s*/)[0].replace(/[.\s]+$/, '')}, softly blurred behind her`
      : fiche.location.court) : '',
    keep.light ? fiche.light.court : '',
    keep.style ? fiche.style.court : '',
  ].filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join('. ')
  /* EXPRESSION drawn in code, without repetition, so faces vary across the
     series. The portrait keeps its own (its sentence IS the expression). */
  const NATUREL = ['a relaxed, genuine smile', 'laughing, eyes crinkled', 'a thoughtful look, gazing off to the side',
    'a confident, direct gaze, lips closed', 'a playful grin', 'a soft, dreamy look', 'a quiet half-smile, eyes bright']
  const tirage = (l) => { let pile = []; return () => (pile.length ? pile : (pile = melange([...l]))).pop() }
  const tireNaturel = tirage(NATUREL)
  const expressions = shots.map((_, i) => portraitDe(i) ? '' : tireNaturel())
  const nom = sujet()
  const variants = shots.map((s, i) => {
    const phrase = String(s.phrase).trim().replace(/[.\s]+$/, '')
    /* Composition sentence written IN CODE, after the trunk. Tight shot: a 50 mm
       "portrait" lens spelled out, against the wide-angle effect of a close
       smartphone formula. */
    const serre = SERRE.test(cadrages[i % cadrages.length])
    const composition = ` Composition: ${cadrages[i % cadrages.length]}; camera ${angles[i % angles.length]}`
      + (serre ? '; shot on a full-frame camera with a 50mm lens at portrait distance, natural perspective, no wide-angle distortion.' : '.')
    const rendu = keep.style ? '' : MOTEUR_PHOTO !== 'krea' ? '' : serre ? RENDU_PRO : SMARTPHONE
    if (portraitDe(i)) {
      /* Prompt order: portrait type and limits FIRST, expression, outfit,
         blurred background, portrait lens, light. */
      const c = cadrages[i % cadrages.length]
      const tete = /^extreme close-up/i.test(c) ? `Extreme close-up of ${nom}'s face, from the forehead to the chin, filling the entire frame.`
        : /^close-up/i.test(c) ? `Close-up portrait of ${nom}, head and shoulders filling the frame, cropped at the collarbones.`
          : `Portrait of ${nom} framed from the middle of the chest up.`
      const objectif = /^extreme close-up/i.test(c) ? '100mm lens' : '85mm lens at f/1.8'
      const corps = phrase.replace(/^(an?\s+)?(extreme\s+|medium\s+)?(close-up|portrait)[^,.:;]*[,.:;]\s*/i, '')
      const texte = `${tete} ${corps.charAt(0).toUpperCase()}${corps.slice(1)}.${tronc(i) ? ' ' + tronc(i) + '.' : ''}`
        + ` Camera ${angles[i % angles.length]}, shot on a full-frame camera with a ${objectif}, natural perspective.`
        + `${rendu ? ' ' + rendu : ''}`
      return texte.replace(/\s{2,}/g, ' ').replace(/\.\./g, '.').trim()
    }
    /* Back view: a camera gaze makes her turn to face the lens. She looks
       over her shoulder. */
    const deDos = /from behind|rear view/i.test(`${phrase} ${angles[i % angles.length]}`)
    const expr = deDos && expressions[i]
      ? 'looking back over her shoulder, ' + expressions[i].replace(/,?\s*(?:straight into the lens|into the lens)/gi, '').replace(/^(a |an )/i, '')
      : expressions[i]
    const visage = expr ? ` Her face: ${expr}.` : ''
    return `${phrase}.${visage}${tronc(i) ? ' ' + tronc(i) + '.' : ''}${composition}${rendu ? ' ' + rendu : ''}`.replace(/\s{2,}/g, ' ').trim()
  })

  /* No per-shot LoRA: the persona is set by the server at render time. The
     array keeps its shape (one entry per shot) for the front end. */
  const loras = variants.map(() => null)
  return { variants, loras, model, v2: true, racine, vlm, fiche, keep, modes, lignes, shots, erreurs, relance,
    temps }
}
