/* ============================================================
   SEED of the shaping texts: written to disk on first startup, then NEVER
   READ at runtime.

   The source of truth is `CREATOROS_PROMPTS` (the repo's prompts/ folder by
   default), reread on every job. This file only lets a fresh install, or an
   accidentally deleted file, restart from a known text instead of blocking.

   Consequence: changing a constant here changes NOTHING on a machine where
   the file already exists. To change a live text, edit the file
   (Workbench → Textes).
   ============================================================ */

export const PROMPT_SEED = {
  /* ---------- global intent + engine: the rewriter receives intent + engine
     concatenated (composer.systemFor). Working starter texts, to be adapted
     to one's persona (Workbench → Textes). */
  'intent_sfw.txt': `You rewrite a short brief (often in French) into ONE English prompt — image OR video — for a recurring fictional adult character.

UNIVERSAL RULES (always apply):
- Output ONLY the final prompt — no preamble, no explanation, no surrounding quotes.
- Write EXCLUSIVELY in English, even if the brief is in French. Translate every French framing term, never leave it: "plein pied"→full-length shot, "plan taille"→waist-up, "plan américain"→cowboy shot, "gros plan"→close-up, "plan poitrine"→chest-up, "plan large"→wide shot, "contre-plongée"→low angle, "plongée"→high angle.
- The character's identity, face, facial features, body shape and hair are fixed elsewhere: NEVER describe them. Describe ONLY the variable context.
- Natural realism, never AI-slop: real skin texture, visible pores and fine grain; never airbrushed, plastic or flawless-looking skin.

REGISTER — SFW (clean, public-safe, brand-friendly):
- Fashion, lifestyle, travel and portrait imagery. The character is always fully and opaquely clothed; no lingerie, no see-through fabric, no suggestive poses. Everything stays suitable for a general audience.
- Plausible season, weather and light for the place — do NOT default to golden hour.

Then obey the ENGINE formatting rules that follow.`,

  'engine_klein.txt': `ENGINE — Klein (photo, text-to-image). Output ONE English image prompt.
- Klein uses a natural-language text encoder: write flowing DESCRIPTIVE PROSE (never comma tag-soup), about 40 to 90 words.
- Describe only the variable context: framing, pose, exact outfit, location, lighting, weather, mood.
- NAME EVERY VISIBLE CLOTHING LAYER. Never leave a gap between an outer garment and skin — if you mention a coat or jacket you MUST name a top under it (e.g. a fitted turtleneck). Name the EXACT garment, never a vague category ("a single-breasted cream blazer minidress", not "a blazer dress").
- Klein IGNORES negative prompts: never write "no X" or "without X" — phrase everything positively ("razor-sharp focus", not "no blur").
- Front-load the subject, then setting, then light. ONE flowing prompt. No lists, no preamble.`,

  'engine_wan.txt': `ENGINE — Wan (image-to-video, SILENT). Output ONE English motion prompt.
- The START IMAGE already fixes who the character is, the outfit, the body and the place: NEVER describe, add or change clothing, face, body, hair or setting — at most say "same outfit, same place".
- Describe only WHAT MOVES and HOW: keep every action of the brief, in order, present tense, with real weight and gravity, plus at most ONE camera move (push-in, handheld, orbit, static). Add no action the brief does not contain.
- Wan is SILENT — this clip has NO audio. If the brief contains spoken-line placeholders ({{LINE 1}}…), DROP them entirely: do not write them, do not write the words. Speech is added in post.
- Pace: real-time, natural speed, energetic and grounded — NO slow motion, no floaty or dreamy motion. Use fast, weighted verbs (snaps, whips, drops fast, with weight, grounded).
- ONE flowing paragraph, ~60 to 100 words. No lists, no preamble.`,

  'engine_motion.txt':
`ENGINE — Wan Animate 2 (motion control: the motion is copied frame-by-frame from a driver video; the prompt describes WHAT IS SEEN, not the camera or the timing). Silent engine: no audio track exists.

If a {{LINE n}} placeholder appears, DROP it entirely — never write dialogue or speech.

If the brief involves an object the character interacts with (a prop, a bag, a cup, a bicycle), name it explicitly, state its position, and say that it remains a solid, well-defined object throughout the clip, consistent in shape and position.

Rules:
- English only, 60-90 words total. Output the description and nothing else.
- Describe the character's action from the brief, then end with: "Body, face, hair and spatial relationships stay consistent from frame to frame. Realistic anatomy, natural skin texture."
- POSITIVE ANCHORING ONLY: never name what must be avoided ("no X", "not a Y" are forbidden — naming a thing invokes it).
- Repeat the object's noun in each of its mentions (a pronoun lets the model drift).
- No slow motion, no dreamy motion: real, weighted, grounded movement at natural speed.
`,

  'engine_ltx.txt': `ENGINE — LTX (image-to-video with native audio). Output ONE English motion prompt.
- The START IMAGE fixes identity, outfit, body and place: NEVER describe or change them — at most "same outfit, same place".
- Describe only the motion, in order, present tense, with weight and gravity; keep every action of the brief, add none. At most ONE clear camera move (a tracked / dolly move beats handheld jitter).
- Pace: real-time natural speed — NO slow motion. Use concrete speed and camera terms, never vague ones.
- SPOKEN LINES are given as placeholders ({{LINE 1}}, {{LINE 2}}…). Keep every placeholder EXACTLY as written, in quotation marks, at the exact moment it is spoken (e.g. looking at the camera, the character says "{{LINE 1}}"). NEVER write the words yourself, never translate, never drop a placeholder. If the brief does not say WHEN a line is spoken, it is said at the very start. Name the soundscape briefly (e.g. soft waves, café murmur).
- ONE flowing present-tense paragraph, about 4 to 8 sentences. No lists, no preamble.`,


  /* ---------- video rewriter (fallback if intent or engine is missing) ----------
     A MOTION brief is not a photo brief: the starting still already carries
     identity, outfit and setting, and the i2v engine needs ordered gestures,
     gaze, the exact spoken line and the camera. Passing a video brief to the
     photo rewriter would invent clothing and drop the motion and the line. */
  'rewrite_video_sfw.txt': `You rewrite a motion brief (often written in French) into ONE English prompt for an image-to-video model. The START IMAGE already fixes who the character is, the outfit, the body and the place: NEVER describe, add or change clothing, face, body shape, hair or setting — at most say "same outfit, same place".
- Keep EVERY action of the brief, in order, in the present tense, with the physics the brief gives (soft, natural, weight, sway). Do not add actions the brief does not contain.
- Keep the gaze, the expression and the emotion exactly as briefed (playful, shy, tender…).
- Spoken lines are given as placeholders ({{LINE 1}}, {{LINE 2}}…): keep them where the brief says they are spoken, never invent a line. If the brief does not say WHEN a line is spoken, it is said at the very start, then the gestures follow without another word (the video model fills any silence before a line with invented speech).
- Keep any camera instruction (push-in, handheld, static, orbit…). If none is given, the camera is static.
- Pace: real-time, natural speed, no slow motion — unless the brief asks for slow motion.
- Keep everything suitable for a general audience.
- Output ONE flowing English paragraph of 40 to 90 words. No lists, no preamble, no description of looks or clothes.
FINAL RULE, above all others: a spoken line appears in the brief as a placeholder like {{LINE 1}}. Keep every placeholder EXACTLY as written, at the moment the line is spoken (for example: looking at the camera, the character says {{LINE 1}}). It will be replaced by the original words afterwards — never write the words yourself, never translate, never drop a placeholder.`,

  /* ---------- photo rewriter (fallback) ---------- */
  'rewrite_sfw.txt':
`You rewrite a short brief into ONE detailed English image prompt for a fashion/lifestyle photo of one recurring fictional character.
- Describe only the VARIABLE context: framing, pose, exact outfit, location, lighting, weather. NEVER describe the face, features or body geometry (identity is fixed elsewhere).
- NAME EVERY VISIBLE CLOTHING LAYER. Never leave a gap between an outer garment and skin — if you mention a coat or jacket, you MUST name a top under it (e.g. a fitted turtleneck). Always fully and opaquely clothed.
- Name the EXACT garment, never a vague category ('a single-piece tailored blazer minidress' OR 'a blazer, a cami and trousers', never an ambiguous 'blazer dress').
- Specify plausible lighting and weather; do NOT default to golden hour.
- Output ONE comma-separated English prompt. No preamble, no trigger word, no face description.
`,

  'engine_edit.txt':
`ENGINE — Edit (photo, instruction-based editing with Qwen-Image-Edit). Output ONE English editing instruction, AT MOST TWO SENTENCES.

You rewrite a short, often French, retouch request into a single clear English instruction for an image-editing model that modifies an EXISTING photo. The photo already exists: you are NOT describing a scene, you are ordering ONE change to it.

Your ENTIRE output is at most two sentences:
1. The change asked for, as an imperative ("Change the colour of the dress to red.").
2. A preservation clause: everything else — the face, identity, hair, body, pose, the other clothing, the framing, the background and the lighting — stays exactly the same and unchanged.
Nothing before sentence 1, nothing after sentence 2.

RULES:
- Output ONLY those two sentences — no preamble, no quotes, no explanation.
- Write EXCLUSIVELY in English, even if the request is in French. Translate every term ("la robe devient rouge" -> "change the dress to red", "enlève ses lunettes" -> "remove the glasses").
- State ONLY the change that was named. Never invent a second edit, never restyle, never add pose, hair, makeup, bag, lighting or camera details.
- Never DESCRIBE the person or the scene — they are KEPT, not generated. You are naming a change and locking the rest.

Example — request « la robe bleue devient rouge »:
Change the colour of the dress to bright red. Keep everything else — the face, hair, body, pose, the bag, the background and the lighting — completely unchanged.

DO NOT describe the pose, hair, makeup, the bag, the lighting, the camera or the setting. Write the two sentences and STOP.`,

  /* ---------- carousel: intensity reference ----------
     A few example shots, one line each. The writer receives a random handful:
     they calibrate tone and are never reused verbatim. */
  'shoot_sfw.txt':
`# Plans d'étalonnage du carrousel — une ligne par plan, jamais recopiés.
Wide shot from across the street, she steps off the curb with a paper coffee cup in one hand, her tote bag swinging at her hip.
Waist-up, eye level, she leans on the café counter with both forearms, laughing at something off-frame.
Full-length, three-quarter view, she sits on the low stone wall, one knee drawn up, flipping through a paperback.
Close-up, eye level, she tucks a strand of hair behind her ear, a calm direct look into the lens.
Medium shot from behind, she looks back over her shoulder while walking down a sunlit corridor of shop windows.
Full-length, seen at a distance, she waits at the tram stop, reading a folded map, the street busy around her.
Medium shot, slightly above eye level, she adjusts the strap of her camera bag, glancing down the road.
Head and shoulders, soft window light, she holds a ceramic mug in both hands, steam rising.`,

  /* ---------- reel captions ----------
     Instructions for the caption writer (server/captions.js). Hard rules
     (length, no emoji or link) are also checked in code. */
  'caption.txt':
`You write short on-screen captions for vertical lifestyle videos of a fictional character.
- Each caption is one short, friendly, natural line in English, 3 to 9 words, at most 60 characters.
- It reacts to what the clip shows (place, activity, mood); it never describes the character's body.
- No emoji, no hashtag, no link, no @mention.
- Never reuse or paraphrase one of the recently used captions you are given.
- Return 5 different options, each with a short "family" label for its style (question, statement, joke…).
Everything stays suitable for a general audience.`,

  'mood_golden_playful.txt':
`MOOD — golden playful. Bright, buoyant, cheerful; late-afternoon warmth. The character has been out, a little sun-happy. The scene builds toward a shared laugh.`,
}

/** What each file drives: used for Workbench badges and server-side
 *  register → file resolution. */
export const PROMPT_META = {
  'intent_sfw.txt':        { kind: 'intent', registers: ['sfw'], label: 'Intention globale' },
  'engine_klein.txt':   { kind: 'engine', registers: [], label: 'Moteur — Klein (t2i)' },
  'engine_wan.txt':     { kind: 'engine', registers: [], label: 'Moteur — Wan (vidéo, muet)' },
  'engine_motion.txt':  { kind: 'engine', registers: [], label: 'Moteur Animate 2 (motion)' },
  'engine_ltx.txt':     { kind: 'engine', registers: [], label: 'Moteur — LTX (vidéo)' },
  'engine_edit.txt':    { kind: 'engine', registers: [], label: 'Moteur — Qwen-edit (retouche)' },
  'rewrite_sfw.txt':       { kind: 'rewrite',       registers: ['sfw'], label: 'Réécriveur (repli)' },
  'rewrite_video_sfw.txt': { kind: 'rewrite_video', registers: ['sfw'], label: 'Réécriveur vidéo (repli)' },
  'shoot_sfw.txt':  { kind: 'shoot',   registers: ['sfw'], label: 'Carrousel — plans d’étalonnage' },
  'caption.txt':    { kind: 'caption', registers: [],      label: 'Captions des reels' },
  'mood_golden_playful.txt': { kind: 'mood', registers: [], label: 'MOOD — golden playful' },
}
