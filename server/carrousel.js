/* ============================================================
   Carrousel v2.
   Servi par /api/carrousel et /api/carrousel/fiche.

   Ce que fait un carrousel : ~8 photos
   qui sortent de la MÊME séance que la photo d'origine, qui est la n°1 de la
   série. Six dimensions — tenue, pose, décor, accessoire, lumière, style —
   chacune verrouillée (constante) ou libre.

   Principes :
   1. Le rédacteur reçoit le PROMPT RACINE de l'opérateur, retrouvé en
      remontant la lignée des lots : la paraphrase VLM de l'image perd le détail
      (« a classic black car » pour « 1930s French coachbuilt convertible »).
   2. Une FICHE, en JSON imposé, fusionne prompt racine et description VLM :
      pour chaque dimension une forme longue et une forme courte (attributs
      identifiants). Le tronc est fait des formes courtes, pas de 80 mots de
      description VLM.
   3. La lumière est une dimension à part, distincte du décor et du style :
      une formule de rendu fixe dirait « natural daylight » sur une scène de nuit.
   4. Accessoire LIBRE : la grille tire un MODE par plan — aucun, l'original,
      un objet du lieu, une variante de la même famille — et le rédacteur
      choisit l'objet. Pas de liste d'objets : on ne connaît pas les
      prochains contextes, et le rédacteur (35B) en sait plus qu'une liste.
   5. Le rédacteur remplit des CHAMPS (action, appui, objet_exact, phrase) en
      JSON imposé ; le code vérifie chaque plan et ne redemande que les
      plans fautifs.
   6. Pas de liste de mobilier par type de lieu : l'appui vient du décor et
      du contexte.
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
/* Le préambule d'identité en tête d'un prompt composé n'est pas l'intention
   de l'opérateur : on le retire avant de relire un prompt. */
const sansPreambule = t => {
  const pre = [persona().trigger, persona().preamble].filter(Boolean).join(', ')
  const txt = String(t ?? '')
  return pre && txt.startsWith(pre) ? txt.slice(pre.length).replace(/^[,\s]+/, '') : txt
}
/** Nom du sujet dans les consignes du rédacteur. */
/* Le nom affiché peut porter une étiquette entre parenthèses (« Jessica (KREA2) ») :
   elle sert à l'interface, pas au texte du prompt. */
const sujet = () => String(persona().name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'the model'

/* ---------- lignée : retrouver le prompt de l'opérateur ----------
   Un job de carrousel porte le batchId de son lot ; la photo d'origine est
   rattachée au lot par payload.batchIds. On remonte jusqu'au premier job qui
   n'est pas un plan de carrousel. `promptRacine` court-circuite quand un job
   récent l'a déjà enregistré. */
export function promptRacine(anchorUri) {
  if (typeof anchorUri !== 'string' || !anchorUri) return null
  const q = 'SELECT j.id, j.user_prompt u, j.payload p FROM jobs j'
  let job = db.prepare(`${q} JOIN assets a ON a.job_id = j.id WHERE a.uri = ? OR a.filename = ?`)
    .get(anchorUri, path.basename(anchorUri))
  for (let i = 0; job && i < 10; i++) {
    let p = {}
    try { p = JSON.parse(job.p || '{}') } catch { /* payload illisible */ }
    if (p.promptRacine) return p.promptRacine
    /* Passage en HD, upscale : le job n'a pas de prompt à lui, il dérive d'une
       image (parentAssetId). On remonte à elle. */
    if (p.parentAssetId && !(p.initialBrief || job.u)) {
      const parent = db.prepare(`${q} JOIN assets a ON a.job_id = j.id WHERE a.id = ?`).get(p.parentAssetId)
      if (parent) { job = parent; continue }
      /* Image source supprimée : le job HD a gardé le prompt qui l'avait
         produite (préambule d'identité en tête, qu'on retire — il n'est pas
         l'intention de l'opérateur). */
      const cp = sansPreambule(p.composedPositive).trim()
      return cp || null
    }
    if (!p.carouselLocks || !p.batchId) return (p.initialBrief || job.u || '').trim() || null
    job = db.prepare(`${q}, json_each(json_extract(j.payload, '$.batchIds')) b WHERE b.value = ? LIMIT 1`).get(p.batchId)
  }
  return null
}

/* ---------- appels Ollama ---------- */
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

/* 1) Description VLM — celle de vision.decomposeScene, avec la LUMIÈRE sortie
      du décor et du style. On ne la découpe pas ici : la fiche s'en charge. */
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

/* 2) Fiche — prompt racine + description VLM → six dimensions, longue et courte. */
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

/** Prompt FINAL qui a rendu l'image d'ancrage (après l'Enhancer). Le brief de
 *  l'opérateur peut taire ce que l'Enhancer a ajouté. */
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

/* Marque et modèle de l'accessoire principal. La règle « make and model »
   ne vise que les objets NOUVEAUX du rédacteur (objet_exact) ; verrouillé,
   l'objet est repris tel que la fiche le nomme, et « red classic car » laisserait la voiture changer d'un plan à l'autre.
   Dans la fiche, la consigne perd contre « never invent » :
   d'où cette question seule, posée à part. */
async function nommerObjet({ props, contexte, racine, vlm, model }) {
  // le modèle ne renomme que l'objet principal ; le reste de la liste est recollé en code
  const [tete, ...reste] = props.split(/\s*,\s*/)
  /* Des CHAMPS à remplir plutôt qu'une phrase libre : en texte libre, le modèle
     se dérobait 2 fois sur 3 (« red vintage Italian roadster »), et recopiait
     parfois la fiche en français (« Voiture rouge »). */
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

/* ---------- grille tirée en code ---------- */
/* Tailles de plan STANDARD, chacune avec ses LIMITES.
« tight portrait, her face fills the frame »
   est lu par Krea comme « photo portrait » et sort en plan taille, avec ou
   sans LoRA de persona ; « an extreme
   close-up… from the top of her head to her chin, nothing below her
   collarbones », dans une phrase de composition à part, resserre vraiment. Le cadrage est donc écrit en code à la fin du plan (cf. assemblage). */
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
/** Mode d'accessoire par plan. Verrouillé : l'original, utilisé, partout.
 *  Libre : les quatre modes de l'opérateur répartis sur la série. Sans
 *  accessoire d'origine, il n'y a ni « original » ni « même famille ». */
function modesAccessoire(n, verrouille, aUnAccessoire) {
  if (verrouille && aUnAccessoire) return Array(n).fill('verrou')
  /* Interaction RÉGULIÈRE avec l'accessoire :
     un seul plan sans accessoire, et seulement sur une série de 6 ou plus. */
  const base = aUnAccessoire ? ['famille', 'lieu', 'origine', 'famille', 'lieu'] : ['lieu']
  const modes = Array.from({ length: n }, (_, i) => base[i % base.length])
  if (n >= 6) modes[n - 1] = 'aucun'
  return melange(modes)
}
function ligneAccessoire(mode, props, serre = false) {
  /* Plan serré : un objet posé au sol ou une voiture font reculer la caméra ;
     un petit objet tenu près du visage garde le gros plan (bidon
     d'huile au sol → plan américain ; canette tenue près du visage → le plan
     le plus serré de la série). L'objet VERROUILLÉ n'est
     pas touché : c'est le choix de l'opérateur. */
  if (serre && mode === 'verrou')
    return `prop = « ${props.court} », the one from the first photo, softly blurred behind her or at the edge of the frame — she does not need to touch it`
  /* Portrait : AUCUN objet. Le gabarit de portrait suffit à serrer le plan, et
     un objet près du visage perturbe (clé à molette brandie, regard caméra = une
     menace). */
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

/* ---------- rédaction ---------- */
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
    /* Pas d'exemple de marque ici : un exemple donné (« a Hermès Kelly bag »)
       revient dans presque tous les plans. */
    + '- objet_exact: the object assigned to this shot, named as a precise real thing — its make and model when it has '
    + 'one, its colour and its material, the way the caption of a real photo would name it; never a generic word. '
    + 'When the line assigns the object from the first photo, objet_exact is that object and you add NO other object '
    + 'to the shot. "none" only when the line says none.\n'
    + '- phrase: the shot for the image model, 1-2 sentences, 60 words max, English. Start with the assigned framing and '
    + 'camera angle, then what her body does, her hands, her support, and the exact object with what she does WITH it '
    + '— she touches it, leans on it, sits on it, holds it, opens it. Never an object left in the background. '
    + 'Only what is visible.')
  // l'expression est ajoutée en code (tirage sans répétition) : le rédacteur n'en écrit pas
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
  // Une phrase impérative par dimension.
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

/** Vérifications en code, par plan. Ne vérifie que ce qui est vérifiable
 *  quel que soit le contexte ; la crédibilité d'un objet ne l'est pas. */
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
  /* L'objet doit apparaître dans la phrase : on cherche son dernier mot
     significatif (« … Ferrari 250 GTB » → « gtb »), pas un mot figé. */
  const tete = objet.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !['the', 'and', 'with', 'her'].includes(w)).pop()
  if (!vide && tete && !phrase.toLowerCase().includes(tete)) f.push('objet_exact is not named in the phrase')
  /* Accessoire d'origine : un des objets verrouillés doit être nommé (le
     décor peut en verrouiller plusieurs — canapé, lampe, fenêtre). */
  if (mode === 'verrou' || mode === 'origine') {
    /* nom de tête de chaque objet : « wooden floor lamp with beige shade » → « lamp » */
    const noms = String(fiche.props.court).toLowerCase().split(/\s*,\s*/)
      .map(x => x.split(/\s+(?:with|in|on|of)\s+/)[0].match(/[a-z]+/g)?.pop()).filter(Boolean)
    if (noms.length && !noms.some(x => new RegExp(`\\b${x}s?\\b`).test(phrase.toLowerCase())))
      f.push(`the phrase must name the original prop (« ${fiche.props.court} »)`)
  }
  return f
}

/** Préparation, montrée à l'opérateur AVANT les cadenas : prompt racine,
 *  description VLM et fiche. La rédaction les réutilise (body.fiche,
 *  body.vlm, body.promptRacine) : le VLM ne tourne qu'une fois. */
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
  if (!keep.pose) { try { const l = lireCorpus('poses_sfw.txt'); if (l.length >= n) positions = l } catch { /* familles */ } }
  const familles = melange(keep.pose ? FAM_POSE_FIGEE : positions || FAM)
  const cadrages = melange(CADRAGES)
  const decor = `${fiche.location.texte} ${fiche.props.texte}`.toLowerCase()
  /* Angles appariés au cadrage. Un gros plan tiré avec une plongée verticale
     ou une contre-plongée depuis le sol oblige la caméra à être tout près et
     très inclinée : rendu grand-angle, tête grossie, fond courbé. Les angles
     extrêmes vont donc aux plans moyens et larges et les plans serrés
     prennent des angles doux. */
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
  /* Trois postures candidates par plan quand elles viennent de la liste de
     l'opérateur : le rédacteur retient la plus crédible pour cette scène. Une
     posture imposée seule donne « mid-leap on the fountain rim » en robe du
     soir. Toutes différentes d'un plan à l'autre : la liste est parcourue
     sans remise. */
  const parPlan = positions ? 3 : 1
  /* PLAN SERRÉ = PORTRAIT. La grille lui assignait une posture en même temps
     que « head and shoulders » : le modèle montrait la posture et reculait.
     Un prompt de portrait écrit à la main (sujet et cadrage en tête,
     expression, fond flou, 85 mm) sort le bon cadrage. Pas en pose verrouillée. */
  const portraitDe = i => !keep.pose && SERRE.test(cadrages[i % cadrages.length])
  // un portrait n'a pas d'objet (sauf l'accessoire verrouillé, flou derrière elle)
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

  /* Vérification plan par plan ; les fautifs sont redemandés ensemble, une fois. */
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

  /* Assemblage : le plan (action et cadrage) en tête, puis le tronc court des
     dimensions verrouillées, puis le rendu. */
  const RENDU_PRO = 'Clean professional photo, sharp focus, true-to-life colours, no grain, no filter, no retouching. '
    + 'Natural skin with visible pores.'
  const SMARTPHONE = 'Shot on a recent smartphone, clean HD photo, sharp focus, true-to-life colours, no grain, no filter, '
    + 'no retouching. Natural skin with visible pores.'
  /* Chaussures et bas de jambe HORS DU TRONC quand le plan ne montre pas les
     pieds : le modèle montre ce qu'on lui nomme — « knee-high leather boots »
     dans le tronc faisait sortir un très gros plan en pied. On ne retire
     JAMAIS un vêtement : ce qui n'est pas nommé n'existe pas, et un plan moyen
     sans pantalon écrit rendait des jambes nues. Seuls partent les
     chaussures, les bas, et un détail de longueur écrit À PART. */
  const PIEDS = /\b(boots?|booties|heels?|heeled|stilettos?|pumps|shoes?|sneakers?|trainers|sandals?|espadrilles?|wedges?|platforms?|flats|flip-flops?|slippers?|clogs?|loafers?|mules|footwear|socks?|stockings?|tights|knee-high|thigh-high|slit|train|hem|hemline|floor-length|ankle-length|knee-length)\b/i
  const VETEMENT = /\b(dress|gown|skirt|jeans|trousers|pants|shorts|leggings|top|tank|shirt|blouse|jacket|coat|sweater|cardigan|hoodie|bodysuit|swimsuit|robe|camisole|jumpsuit|romper|overalls)\b/i
  const PLAN_SERRE = /^(extreme close-up|close-up|medium close-up|medium shot|medium-long shot)/i
  const tenueCadree = i => {
    const t = fiche.outfit.court.replace(/^(she\s+)?wear(s|ing)?\s+/i, '')
    if (!PLAN_SERRE.test(cadrages[i % cadrages.length])) return t
    /* PORTRAIT (gros plan, très gros plan) : la tenue s'arrête au buste — le
       bas décrit la taille et faisait cadrer aux hanches. Les jambes sont hors
       cadre : rien n'est « déshabillé ». Le plan poitrine garde la tenue entière. */
    if (portraitDe(i) && !/^medium close-up/i.test(cadrages[i % cadrages.length])) {
      const BAS = /\b(jeans|trousers|pants|shorts|skirt|leggings|joggers|culottes)\b/i
      return t.replace(/\s+tucked (?:in|into)\b[^,]*/gi, '')
        .split(/\s*,\s*/)
        /* Un vêtement du haut qui porte une longueur perd la longueur, pas le
           vêtement : sinon la robe entière partait. */
        .map(seg => VETEMENT.test(seg) && !BAS.test(seg) ? seg.replace(/\b(knee|ankle|floor|mid-calf|calf|thigh|maxi|midi|mini)[- ]length\s*/gi, '').replace(/\b(maxi|midi|mini)\s+(?=dress|skirt)/gi, '') : seg)
        .filter(seg => !BAS.test(seg) && (!PIEDS.test(seg) || VETEMENT.test(seg))).join(', ')
    }
    return t.split(/\s*,\s*/).filter(seg => !PIEDS.test(seg) || VETEMENT.test(seg)).join(', ')
  }
  const tronc = i => [
    keep.outfit && tenueCadree(i) ? `She wears ${tenueCadree(i)}` : '',
    keep.pose ? fiche.pose.texte : '',
    /* Plan serré : le lieu décrit en entier demande de montrer le décor, donc
       de reculer. Réduit à son premier élément flouté, le gros plan tient. */
    keep.location ? (SERRE.test(cadrages[i % cadrages.length])
      ? `${fiche.location.court.split(/\s*,\s*/)[0].replace(/[.\s]+$/, '')}, softly blurred behind her`
      : fiche.location.court) : '',
    keep.light ? fiche.light.court : '',
    keep.style ? fiche.style.court : '',
  ].filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join('. ')
  /* EXPRESSION tirée en code, sans répétition : aucun plan ne disait quelle
     tête elle fait, et le modèle rendait huit fois le même visage calme. Le
     portrait garde la sienne (sa phrase EST l'expression). */
  const NATUREL = ['a relaxed, genuine smile', 'laughing, eyes crinkled', 'a thoughtful look, gazing off to the side',
    'a confident, direct gaze, lips closed', 'a playful grin', 'a soft, dreamy look', 'a quiet half-smile, eyes bright']
  const tirage = (l) => { let pile = []; return () => (pile.length ? pile : (pile = melange([...l]))).pop() }
  const tireNaturel = tirage(NATUREL)
  const expressions = shots.map((_, i) => portraitDe(i) ? '' : tireNaturel())
  const nom = sujet()
  const variants = shots.map((s, i) => {
    const phrase = String(s.phrase).trim().replace(/[.\s]+$/, '')
    /* Phrase de composition écrite EN CODE, après le tronc. Plan serré :
       objectif 50 mm « portrait » écrit en toutes lettres, contre l'effet
       grand-angle d'une formule smartphone de près. */
    const serre = SERRE.test(cadrages[i % cadrages.length])
    const composition = ` Composition: ${cadrages[i % cadrages.length]}; camera ${angles[i % angles.length]}`
      + (serre ? '; shot on a full-frame camera with a 50mm lens at portrait distance, natural perspective, no wide-angle distortion.' : '.')
    const rendu = keep.style ? '' : MOTEUR_PHOTO !== 'krea' ? '' : serre ? RENDU_PRO : SMARTPHONE
    if (portraitDe(i)) {
      /* Ordre du prompt qui marche : type de portrait et limites EN TÊTE,
         expression, tenue, fond flou, objectif de portrait, lumière. */
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
    /* Vue de dos : un regard caméra la fait retourner face à l'objectif. Elle
       regarde par-dessus l'épaule. */
    const deDos = /from behind|rear view/i.test(`${phrase} ${angles[i % angles.length]}`)
    const expr = deDos && expressions[i]
      ? 'looking back over her shoulder, ' + expressions[i].replace(/,?\s*(?:straight into the lens|into the lens)/gi, '').replace(/^(a |an )/i, '')
      : expressions[i]
    const visage = expr ? ` Her face: ${expr}.` : ''
    return `${phrase}.${visage}${tronc(i) ? ' ' + tronc(i) + '.' : ''}${composition}${rendu ? ' ' + rendu : ''}`.replace(/\s{2,}/g, ' ').trim()
  })

  /* Pas de LoRA par plan : la persona est posée par le serveur au rendu. Le
     tableau garde sa forme (une entrée par plan) pour le front. */
  const loras = variants.map(() => null)
  return { variants, loras, model, v2: true, racine, vlm, fiche, keep, modes, lignes, shots, erreurs, relance,
    temps }
}
