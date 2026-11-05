/* ============================================================
   Reels à preset — un format de réseau social tenu par le CODE.
   Le visiteur choisit un preset (saut de tenues, GRWM…) et écrit un brief ;
   le réalisateur (LLM) ne fait que REMPLIR les cases du preset (le décor,
   les tenues, l'accroche…). La structure — quelles images, quels clips entre
   quelles images, quel montage — est écrite ici et ne bouge pas :
     1. CASES    le LLM remplit un JSON au schéma du preset ;
     2. IMAGES   chaque image est générée (Klein) ou retouchée (Qwen-Image-Edit)
                 à partir d'une autre : même femme, même décor, même cadrage ;
     3. CLIPS    un clip va d'une image de départ à une image de fin (Wan 2.2,
                 first-last frame) ou part d'une image (LTX) ;
     4. MONTAGE  coupes franches dans l'ordre du preset, accroche sur le 1er plan.
   L'état vit dans la table `reels` (etat 'preset' puis 'export') : le suivi du
   reel ordinaire prend le relais pour l'export.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { fetchOllama } from './gpu.js'
import { persona } from './persona.js'
import { enqueue, enqueueMusique, deposerAvecCle, cancelJob } from './jobs.js'
import * as montage from './montage.js'
import { t0Hit } from './t0.js'

export const MODELE = process.env.CREATOROS_REALISATEUR || 'qwen3.5:35b'
const SEULE = 'She is the only person in the frame.'
const CADRE_SAUT = 'Full-body shot, camera at her eye level, straight on, static camera, 35mm lens, plenty of space above her head and below her feet.'
const GARDE = 'Keep exactly the same woman, the same face and hair, the same framing, the same camera position, the same background and the same light.'

/* Un gros plan ne nomme pas les chaussures : le modèle montre ce qu'on lui nomme, et des
   « sandales » dans un gros plan le font reculer en pied. */
const PIEDS = /\b(boots?|booties|heels?|heeled|stilettos?|pumps|shoes?|sneakers?|trainers|sandals?|espadrilles?|wedges?|flats|loafers?|mules|slippers?|socks?|stockings?|tights)\b/i
const sansPieds = tenue => String(tenue).split(/\s*,\s*|\s+and\s+|\s+with\s+|;\s*/).filter(m => m && !PIEDS.test(m)).join(', ')

/* ---------- les presets ---------- */
export const PRESETS = {
  'saut-tenues': {
    nom: 'Outfit jump',
    texte: 'Elle saute, et retombe dans une autre tenue : une transition à chaque saut, le look final et elle s’en va.',
    exemple: 'Trois looks d’été pour un premier rendez-vous',
    schema: {
      type: 'object', required: ['hook', 'room', 'outfits'],
      properties: {
        hook: { type: 'string' },
        room: { type: 'string' },
        outfits: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' } },
      },
    },
    consigne: (nom, langue) => `You fill the slots of an "outfit jump" reel (Instagram / TikTok) for ${nom}, a fictional adult woman. The system films it: she stands, jumps, and lands in the next outfit, jump after jump, then leaves in the final look. You only write:
- "hook": the on-screen opening text, 3 to 7 words, in ${langue}, specific to the brief (a question or a promise), never generic.
- "room": the place where she jumps, 15 to 30 words, English: a bright, tidy room or setting that fits the brief, with what stands behind her (a bed, a plant, a window, a rail of clothes…). NO mirror and nothing reflective behind her. Nobody else.
- "outfits": exactly 4 outfits, English, each 12 to 30 words, every garment with colour and fabric, shoes included:
  1. a simple comfortable home outfit (the "before");
  2. and 3. two COMPLETELY different outfits that fit the brief (different main garment, colour and style);
  4. the best outfit of the reel, complete with its accessories (bag, jewellery, sunglasses or hat, shoes).
Everything is safe for work: fully clothed, no lingerie, no swimwear unless the brief is about the beach, no brand names.`,
    graphe: ({ room, outfits, hook }) => {
      const tenue = k => `She wears ${outfits[k]}.`
      const base = `${CADRE_SAUT} She stands in ${room}`
      const SAUTE = `Make her jump: she is now high in the air in the middle of a joyful jump, both feet well off the floor with clear empty space under her feet, knees slightly bent, both arms raised above her head, hair flying upward, a big smile at the camera. Keep exactly the same clothes, shoes and accessories. ${GARDE}`
      const stills = [
        { id: 'sol1', faire: 'generer', prompt: `${base}, facing the camera, both feet flat on the floor, arms relaxed along her body, a playful smile at the camera. ${tenue(0)} No mirror in the frame. ${SEULE} Natural daylight, clean photo.` },
        { id: 'air1', faire: 'retoucher', depuis: 'sol1', prompt: SAUTE },
      ]
      for (const k of [1, 2, 3]) {
        stills.push({ id: `sol${k + 1}`, faire: 'retoucher', depuis: 'sol1', prompt: `Change only her clothes: she now wears ${outfits[k]}. Keep the same pose, standing with both feet on the floor. ${GARDE}` })
        // le saut est tiré de la photo AU SOL de la même tenue : changer de pose garde les vêtements, changer de vêtements sur une pose en l'air en laissait passer
        stills.push({ id: `air${k + 1}`, faire: 'retoucher', depuis: `sol${k + 1}`, prompt: SAUTE })
      }
      const SAUT = 'She springs straight up into a joyful jump in one quick move, her arms rising above her head, hair flying, her body staying upright. Static camera, real-time speed.'
      const ATT = 'She falls from the top of her jump and lands softly on both feet, arms coming down, then stands still smiling at the camera. Static camera, real-time speed.'
      const clips = [
        // Wan tient l'image de départ ~0,4 s avant de bouger : on la coupe ; l'atterrissage est fini à 1 s
        { id: 'p1', de: 'sol1', a: 'air1', prompt: SAUT, moteur: 'wan', secondes: 2, debut: 0.4 },
        { id: 'p2', de: 'air2', a: 'sol2', prompt: ATT, moteur: 'wan', secondes: 2, fin: 1.0 },
        { id: 'p3', de: 'sol2', a: 'air2', prompt: SAUT, moteur: 'wan', secondes: 2, debut: 0.4 },
        { id: 'p4', de: 'air3', a: 'sol3', prompt: ATT, moteur: 'wan', secondes: 2, fin: 1.0 },
        { id: 'p5', de: 'sol3', a: 'air3', prompt: SAUT, moteur: 'wan', secondes: 2, debut: 0.4 },
        { id: 'p6', de: 'air4', a: 'sol4', prompt: ATT, moteur: 'wan', secondes: 2, fin: 1.2 },
        { id: 'p7', de: 'sol4', prompt: 'She walks toward the camera with confident steps and a big smile, then walks past the camera out of the frame. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
      ]
      return { stills, clips, montage: { ordre: clips.map(c => c.id), accroche: hook } }
    },
  },
  grwm: {
    nom: 'Get ready with me',
    texte: 'Sa routine de maquillage devant sa coiffeuse : le teint, les yeux, les lèvres, chaque étape apparaît sur son visage, puis le résultat.',
    exemple: 'Un maquillage lumineux pour un dîner d’été',
    schema: {
      type: 'object', required: ['hook', 'vanity', 'robe', 'skin', 'eyes', 'lips', 'final'],
      properties: { hook: { type: 'string' }, vanity: { type: 'string' }, robe: { type: 'string' }, skin: { type: 'string' }, eyes: { type: 'string' }, lips: { type: 'string' }, final: { type: 'string' } },
    },
    consigne: (nom, langue) => `You fill the slots of a "get ready with me" makeup reel (Instagram / TikTok) for ${nom}, a fictional adult woman. The system films it at her vanity: skin, then eyes, then lips, then the finished look. You only write:
- "hook": the on-screen opening text, 3 to 7 words, in ${langue}, specific to the brief, never generic.
- "vanity": where she sits, 15 to 30 words, English: her vanity or bathroom counter and what is behind her (window light, plants, shelves). NO mirror visible. Nobody else.
- "robe": what she wears while getting ready, 6 to 15 words, closed and covering her shoulders.
Every step must be bold enough to be seen at a glance on a phone screen.
- "skin": the complexion makeup, 8 to 18 words, with a VISIBLE colour (a peach blush on the cheeks, a bronzed glow…). No "highlighter", "shimmer" or "glitter" (the image model paints them as white spots).
- "eyes": the eye makeup, 8 to 18 words, with a VISIBLE colour (a warm bronze eyeshadow, a black winged eyeliner, long mascara…).
- "lips": the lip colour, 4 to 12 words (a glossy coral lipstick…).
- "final": her hairstyle and jewellery for the finished look, 10 to 25 words (her hair down in soft waves, small gold hoops…) — the shape of her hair only, never its colour (her hair colour never changes).
Everything is safe for work, no brand names.`,
    graphe: ({ vanity, robe, skin, eyes, lips, final, hook }) => {
      const cadre = 'Medium close-up from the chest up, camera at her eye level, straight on, static camera, 50mm lens, soft flattering light.'
      const stills = [
        { id: 'e0', faire: 'generer', prompt: `${cadre} She sits at ${vanity}, facing the camera, a bare natural face with no makeup at all, her hair pulled back with a clip, her hands resting on the vanity with nothing in them, a calm smile. She wears ${robe}. No mirror in the frame. ${SEULE} Clean beauty photo.` },
        { id: 'e1', faire: 'retoucher', depuis: 'e0', prompt: `Add makeup to her face: ${skin}. The rest of her face stays without makeup. Keep her hair pulled back, the same expression and the same pose. ${GARDE}` },
        { id: 'e2', faire: 'retoucher', depuis: 'e1', prompt: `Add eye makeup: ${eyes}. Keep the rest of her makeup exactly as it is, her hair pulled back, the same expression and the same pose. ${GARDE}` },
        { id: 'e3', faire: 'retoucher', depuis: 'e2', prompt: `Add lipstick: ${lips}. Keep the rest of her makeup exactly as it is, her hair pulled back, the same pose. ${GARDE}` },
        { id: 'fin', faire: 'retoucher', depuis: 'e3', prompt: `Finish her look: ${final}. She smiles confidently at the camera. Keep exactly her own hair colour, her face, her makeup and the same pose. ${GARDE}` },
      ]
      const clips = [
        // chaque étape part de son résultat (le maquillage est déjà là) : un clip entre deux images où ses mains reposent faisait apparaître une main étrangère
        { id: 'p0', de: 'e0', prompt: 'She smiles at the camera with her bare face and gives a small wave, then lifts a makeup brush into view. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 2 },
        { id: 'p1', de: 'e1', prompt: 'She lifts a fluffy makeup brush with her own hand and sweeps it over her cheeks, then lowers it and looks at the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p2', de: 'e2', prompt: 'She lifts a mascara wand with her own hand and brushes her lashes, then lowers it and looks at the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p3', de: 'e3', prompt: 'She lifts a lipstick with her own hand, touches up her lips and presses them together, then smiles at the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p4', de: 'e3', a: 'fin', prompt: 'She unclips her hair and lets it fall, shakes it out with her hands, then smiles at the camera. Static camera, real-time speed.', moteur: 'wan', secondes: 3, debut: 0.3 },
        { id: 'p5', de: 'fin', prompt: 'She turns her face slightly left and right to show her makeup, then gives the camera a confident smile and a little wink. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
      ]
      return { stills, clips, montage: { ordre: clips.map(c => c.id), accroche: hook } }
    },
  },
  pepite: {
    nom: 'Food spot',
    texte: 'Elle a trouvé une pépite : elle arrive, le plat est servi, la première fourchette, son verdict à la caméra.',
    exemple: 'Une petite trattoria cachée et ses pâtes fraîches',
    schema: {
      type: 'object', required: ['hook', 'street', 'place', 'outfit', 'dish', 'drink'],
      properties: { hook: { type: 'string' }, street: { type: 'string' }, place: { type: 'string' }, outfit: { type: 'string' }, dish: { type: 'string' }, drink: { type: 'string' } },
    },
    consigne: (nom, langue) => `You fill the slots of a "food spot" reel (Instagram / TikTok) for ${nom}, a fictional adult woman who found a great little place to eat. The system films it: she arrives in the street, sits down, the dish served, her first taste, her verdict to the camera. You only write:
- "hook": the on-screen opening text, 3 to 7 words, in ${langue}, enthusiastic and specific to the dish (a promise or a question), never naming a real place, never a ranking.
- "street": the street she walks in before the place, 15 to 30 words, English, with its light; passers-by only far away and blurred.
- "place": where she sits, 15 to 30 words, English: the table, what is on it before the dish, the room or terrace behind her. No sign, no text, no logo.
- "outfit": her outfit, 12 to 25 words, every garment with colour and fabric.
- "dish": the dish served, 12 to 25 words, appetising and precise (pasta shape, sauce, garnish, plate).
- "drink": her drink on the table, 4 to 10 words.
Everything is safe for work, no brand names, no real business names.`,
    graphe: ({ street, place, outfit, dish, drink, hook }) => {
      const tenue = `She wears ${outfit}.`
      const calme = 'A quiet spot: nobody near her, no other diners at the nearby tables, at most one or two passers-by far away and blurred.'
      const stills = [
        { id: 'rue', faire: 'generer', prompt: `Medium-wide shot, camera at her eye level, she walks toward the camera in ${street}, a curious excited smile, her bag on her shoulder. ${tenue} ${calme} ${SEULE} Natural light, travel vlog photo.` },
        { id: 'plat', faire: 'generer', refs: ['rue'], prompt: `The same woman, in the same outfit as in the reference photo, a few minutes later. Medium shot, camera at her eye level across the table, she sits at ${place}, a plate of ${dish} in front of her and ${drink} beside it; she looks at the plate with wide delighted eyes, her hands joined near her chin. ${tenue} ${calme} No sign, no text. ${SEULE} Warm natural light.` },
        // gros plans sans référence : Klein recopierait le cadrage large de la photo de référence
        { id: 'gros', faire: 'generer', sansPersonnage: true, prompt: `Food close-up from slightly above: a plate of ${dish} on a wooden table, a woman's hand about to take some of it, with a fork if the dish is eaten with a fork, a glass of ${drink} softly blurred at the edge, shallow depth of field, appetising food photography, warm natural light. Only the hand is visible, no face, no person.` },
        { id: 'bouchee', faire: 'generer', prompt: `Tight close-up portrait: her face and shoulders fill the frame, camera at her eye level, 85mm lens, she tastes the ${dish} — a forkful or a piece of it at her lips, as you would eat this dish — eyes closed with delight; the plate stays on the table out of frame; the background is a soft warm blur with nobody in it. She wears ${sansPieds(outfit)}. ${SEULE} Warm natural light, shallow depth of field.` },
      ]
      stills.push({ id: 'verdict', faire: 'retoucher', depuis: 'bouchee', prompt: `She opens her eyes, looks straight at the camera with a big happy smile and gives a thumbs up, the fork lowered. ${GARDE}` })
      const clips = [
        { id: 'p1', de: 'rue', prompt: 'She walks toward the camera with a curious excited smile, looking around. Handheld follow, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p2', de: 'plat', prompt: 'She looks up from her plate at the camera with wide delighted eyes and rubs her hands together, smiling. Her face stays turned to the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p3', de: 'gros', prompt: 'Her hand takes a first generous piece of the dish, which looks fresh and delicious. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p4', de: 'bouchee', prompt: 'She savours it, eyes closed, and nods slowly with pleasure. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p5', de: 'verdict', prompt: 'She nods with a big smile at the camera, holds her thumbs up, then laughs. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
      ]
      return { stills, clips, montage: { ordre: clips.map(c => c.id), accroche: hook } }
    },
  },
  balade: {
    nom: 'City stroll',
    texte: 'Une balade dans une ville : elle marche, s’arrête devant une vitrine, repart avec sa trouvaille et finit sur une belle vue.',
    exemple: 'Un dimanche à Lisbonne',
    schema: {
      type: 'object', required: ['hook', 'street', 'shop', 'find', 'view', 'outfit', 'light'],
      properties: { hook: { type: 'string' }, street: { type: 'string' }, shop: { type: 'string' }, find: { type: 'string' }, view: { type: 'string' }, outfit: { type: 'string' }, light: { type: 'string' } },
    },
    consigne: (nom, langue) => `You fill the slots of a "city stroll" reel (Instagram / TikTok) for ${nom}, a fictional adult woman. The system films it: she walks down a street, stops at a shop window or stall, leaves with a small find, and ends at a beautiful view. You only write:
- "hook": the on-screen opening text, 3 to 7 words, in ${langue}, specific to the place of the brief (a promise or a question), never a ranking.
- "street": the street she walks down, 15 to 30 words, English, typical of the place of the brief.
- "shop": the shop window or market stall where she stops, 12 to 25 words, and what is displayed. No text, no sign, no logo.
- "find": the small thing she buys and carries away, 5 to 12 words — something she can hold in one hand while walking (flowers, a pastry in a paper bag, an ice cream cone, a small souvenir); never a glass, a cup or a bottle.
- "view": where the stroll ends, 12 to 25 words: a viewpoint, a quay, a terrace over the city.
- "outfit": her outfit, 12 to 25 words, every garment with colour and fabric.
- "light": the time of day and light, 5 to 12 words — the same for the whole stroll.
Everything is safe for work, no brand names, no real business names. Nobody else near her.`,
    graphe: ({ street, shop, find, view, outfit, light, hook }) => {
      const tenue = `She wears ${outfit}.`, lum = `${light}.`
      const calme = 'Nobody near her; at most a few passers-by far away and blurred.'
      const stills = [
        { id: 'rue', faire: 'generer', prompt: `Medium-wide shot, camera at her eye level, she walks toward the camera down ${street}, a happy relaxed smile. ${tenue} ${lum} ${calme} ${SEULE} Travel vlog photo, shot on a digital cinema camera.` },
        // sans référence : Klein recopierait le cadrage de la rue ; tenue et lumière tiennent par le texte
        { id: 'vitrine', faire: 'generer', prompt: `Medium shot, three-quarter front view, she has stopped at ${shop}, she points at something she likes and looks back at the camera with an excited smile, her face clearly visible. ${tenue} ${lum} ${calme} ${SEULE}` },
        { id: 'trouvaille', faire: 'generer', prompt: `Tight close-up portrait: her face, shoulders and one hand fill the frame, camera at her eye level, 85mm lens, shallow depth of field, she holds ${find} near her face and shows it to the camera with a delighted smile, the street a soft blur behind her. She wears ${sansPieds(outfit)}. ${lum} ${SEULE}` },
        { id: 'vue', faire: 'generer', prompt: `Medium-wide shot, camera at her eye level, she stands at ${view}, holding ${find}, facing the camera with a big smile, the view opening behind her. ${tenue} ${lum} ${calme} ${SEULE}` },
      ]
      const face = 'She keeps facing the camera, her face always visible.'
      const clips = [
        { id: 'p1', de: 'rue', prompt: `She walks toward the camera with an easy stride and a happy smile, glancing at the street around her. ${face} Handheld follow, real-time speed. Single continuous shot.`, moteur: 'ltx_hq', secondes: 3 },
        { id: 'p2', de: 'vitrine', prompt: `She points at the window display, laughs and nods at the camera. ${face} Static camera, real-time speed. Single continuous shot.`, moteur: 'ltx_hq', secondes: 3 },
        { id: 'p3', de: 'trouvaille', prompt: `She lifts her find toward the camera with a delighted smile, then brings it back near her face. ${face} Static camera, real-time speed. Single continuous shot.`, moteur: 'ltx_hq', secondes: 3 },
        { id: 'p4', de: 'vue', prompt: `She opens her free arm toward the view behind her and laughs at the camera, her hair moving in the breeze. ${face} Slow push-in, real-time speed. Single continuous shot.`, moteur: 'ltx_hq', secondes: 3 },
      ]
      return { stills, clips, montage: { ordre: clips.map(c => c.id), accroche: hook } }
    },
  },
  danse: {
    nom: 'Dance trend',
    texte: 'Une petite chorégraphie sur un morceau composé pour le reel : trois angles du même moment, une fin sur un clin d’œil.',
    exemple: 'Une danse joyeuse sur un toit au coucher du soleil',
    schema: {
      type: 'object', required: ['hook', 'place', 'outfit', 'music'],
      properties: { hook: { type: 'string' }, place: { type: 'string' }, outfit: { type: 'string' }, music: { type: 'string' } },
    },
    consigne: (nom, langue) => `You fill the slots of a short "dance trend" reel (Instagram / TikTok) for ${nom}, a fictional adult woman. The system films her dancing a simple upbeat choreography at one spot, from three angles, on a track composed for the reel. You only write:
- "hook": the on-screen opening text, 3 to 7 words, in ${langue}, playful, specific to the brief.
- "place": the spot where she dances, 15 to 30 words, English, with an open floor around her and its light. Nobody else.
- "outfit": her outfit, 12 to 25 words, easy to move in, every garment with colour and fabric, shoes included.
- "music": the track, 10 to 25 words, English: genre, mood, instruments and tempo in bpm (e.g. "upbeat funky pop, bright synth bass, handclaps, 118 bpm") — instrumental, no vocals.
Everything is safe for work, no brand names, no real song or artist names.`,
    musique: c => `${c.music}, instrumental, no vocals`,
    graphe: ({ place, outfit, hook }) => {
      const tenue = `She wears ${outfit}.`
      const stills = [
        { id: 'large', faire: 'generer', prompt: `Full-body shot, camera at her eye level, straight on, she stands at ${place}, in a playful ready-to-dance pose, one hip popped, a big smile at the camera. ${tenue} ${SEULE} Natural light, plenty of space around her.` },
        { id: 'trois', faire: 'generer', prompt: `Medium-wide shot from a three-quarter front angle, she dances at ${place}, arms up mid-move, laughing, her face toward the camera. ${tenue} ${SEULE} Natural light.` },
        { id: 'serre', faire: 'generer', prompt: `Tight close-up portrait: her face and shoulders fill the frame, camera at her eye level, 85mm lens, slightly out of breath after dancing, a big laugh at the camera, hair a little messy, ${place} a soft blur behind her. She wears ${sansPieds(outfit)}. ${SEULE} Shallow depth of field.` },
      ]
      const clips = [
        { id: 'p1', de: 'large', prompt: 'She dances a simple upbeat choreography on the spot: steps side to side, rolls her shoulders and claps on the beat, smiling at the camera. Her face stays toward the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p2', de: 'trois', prompt: 'She does a hair flip and a quick spin on the spot, lands facing the camera and points at it with a laugh. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p3', de: 'large', prompt: 'She bounces on the beat, swings her arms and hips in rhythm, then strikes a final pose with her hands on her hips. Her face stays toward the camera. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 3 },
        { id: 'p4', de: 'serre', prompt: 'She laughs, catches her breath, brushes her hair back and gives the camera a wink. Static camera, real-time speed. Single continuous shot.', moteur: 'ltx_hq', secondes: 2 },
      ]
      return { stills, clips, montage: { ordre: clips.map(c => c.id), accroche: hook } }
    },
  },
}
/* « Day in the life » : un parcours de lieux, écrit par le réalisateur du reel libre (2e manière, format journée) */
export const PRESETS_LIBRES = { journee: { nom: 'Day in the life', texte: 'Un moment de sa journée, lieu après lieu : une action par lieu, une petite histoire, une accroche.', exemple: 'Un dimanche à Lisbonne' } }
export const listePresets = () => [...Object.entries(PRESETS), ...Object.entries(PRESETS_LIBRES)].map(([id, p]) => ({ id, nom: p.nom, texte: p.texte, exemple: p.exemple }))

/* Les cases rendues par le LLM, nettoyées : pas de numérotation (« 2. A coral dress »),
   pas de sujet répété (« She wears … » : le gabarit l'écrit déjà), pas de point final. */
const net = x => String(x ?? '').trim().replace(/^\s*(\d+[.)]|[-•])\s*/, '').replace(/^(she|her)\s+(wears|is wearing)\s+/i, '').replace(/[.\s]+$/, '')
const nettoyer = v => Array.isArray(v) ? v.map(nettoyer) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nettoyer(x)])) : typeof v === 'string' ? net(v) : v

/* ---------- état ---------- */
const ligne = r => r && { id: r.id, personaId: r.persona_id, brief: r.brief, etat: r.etat, createdAt: r.created_at, updatedAt: r.updated_at, ...JSON.parse(r.data) }
const lire = id => ligne(store.db.prepare('SELECT * FROM reels WHERE id = ?').get(id))
function ecrire(id, etat, patch) {
  const r = lire(id)
  if (!r) return null
  const { id: _i, personaId: _p, brief: _b, etat: _e, createdAt: _c, updatedAt: _u, ...data } = r
  store.db.prepare('UPDATE reels SET etat = ?, data = ?, updated_at = ? WHERE id = ?').run(etat ?? r.etat, JSON.stringify({ ...data, ...patch }), Date.now(), id)
  return lire(id)
}
const etatJob = id => id ? store.getJob(id)?.status ?? 'absent' : null
const premierAsset = id => (id && store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full'))) || null
const RATE = new Set(['blocked', 'cancelled', 'failed', 'absent'])
function versInput(a) {
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}
const cles = new Map()
const filer = (id, job) => deposerAvecCle(cles.get(id) ?? null, () => enqueue(job))

/* ---------- 1. cases ---------- */
async function remplir(preset, brief, nom, langue, eviter = []) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(600000),
    body: JSON.stringify({ model: MODELE, system: preset.consigne(nom, langue), prompt: `Brief: ${brief}${eviter.length ? `\nNever use these words: ${eviter.join(', ')}.` : ''}`, format: preset.schema, stream: false, think: false, keep_alive: '10m',
      options: { num_gpu: 0, num_ctx: 8192, num_predict: 1500, temperature: 0.7 } }),
  })
  if (!res.ok) throw new Error(`le réalisateur (LLM) a refusé : HTTP ${res.status}`)
  return JSON.parse(String((await res.json()).response || '{}'))
}

/* ---------- lancement ---------- */
export function lancerPreset({ presetId, brief, langue, cle, personaId }) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error('preset inconnu')
  const b = String(brief ?? '').trim().slice(0, 600) || preset.exemple
  if (t0Hit(b)) throw new Error('brief refusé (liste T0)')
  const p = persona(personaId)
  const id = `reel-${Date.now().toString(36)}`
  const data = { preset: presetId, n: 0, duree: 2, langue: langue === 'en' ? 'English' : 'French', graine: Math.floor(Math.random() * 2 ** 31), plans: [], erreur: null }
  store.db.prepare('INSERT INTO reels (id, persona_id, brief, etat, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.id ?? null, b, 'redaction', JSON.stringify(data), Date.now(), Date.now())
  if (cle) cles.set(id, cle)
  void (async () => {
    try {
      const nom = String(p.name || 'the model').replace(/\s*\([^)]*\)\s*$/, '').trim()
      // un mot de la liste T0 dans une case : le LLM réécrit en l'évitant, deux fois au plus
      const bloque = g => [...g.stills.map(s => s.prompt), ...g.clips.map(c => c.prompt), String(g.montage?.accroche ?? '')].map(t0Hit).find(Boolean)
      let cases = nettoyer(await remplir(preset, b, nom, data.langue)), g = preset.graphe(cases), mot = bloque(g)
      for (let essai = 0, eviter = []; mot && essai < 2; essai++) {
        eviter.push(mot); console.log(`[reel ${id}] case réécrite (terme bloqué)`)
        cases = nettoyer(await remplir(preset, b, nom, data.langue, eviter)); g = preset.graphe(cases); mot = bloque(g)
      }
      if (mot) throw new Error('une image rédigée contient un terme bloqué (liste T0) — relancer')
      const graphe = { stills: Object.fromEntries(g.stills.map(s => [s.id, { ...s, job: null, asset: null }])), clips: g.clips.map(c => ({ ...c, job: null, asset: null })), montage: g.montage }
      // les plans affichés dans la vue Reel : un par clip, l'image de départ en vignette
      const plans = graphe.clips.map(c => ({ still: graphe.stills[c.de].prompt, motion: c.prompt, photoJob: null, clipJob: null }))
      // un preset musical : le morceau est composé pendant que les images se font
      let musiqueJob = null
      if (preset.musique) {
        try { musiqueJob = enqueueMusique({ prompt: preset.musique(cases).slice(0, 380), paroles: '', secondes: 14, genre: 'musique', personaId: p.id }).id }
        catch (e) { console.warn(`[reel ${id}] musique : ${e.message || e}`) }
      }
      // une accroche se lit d'un coup d'œil : 8 mots au plus
      const accroche = String(cases.hook ?? '').trim().split(/\s+/).slice(0, 8).join(' ').replace(/[,;:]$/, '')
      ecrire(id, 'preset', { cases, graphe, plans, n: plans.length, accroche, musiqueJob })
      console.log(`[reel ${id}] preset ${presetId} : ${g.stills.length} images, ${g.clips.length} clips`)
    } catch (e) {
      ecrire(id, 'echec', { erreur: String(e.message || e).slice(0, 400) })
      console.warn(`[reel ${id}] preset : ${e.message || e}`)
    }
  })()
  return lire(id)
}

/* ---------- 2 et 3. images puis clips, au fil des rendus ---------- */
function avancerPreset(r) {
  const g = r.graphe
  let change = false
  for (const s of Object.values(g.stills)) {
    if (s.asset) continue
    if (!s.job) {
      const src = s.depuis ? g.stills[s.depuis] : null
      if (src && !src.asset) continue
      const refs = (s.refs ?? []).map(x => g.stills[x])
      if (refs.some(x => !x.asset)) continue
      const commun = { mode: 'photo', register: 'sfw', personaId: s.sansPersonnage ? 'aucun' : r.personaId, purpose: 'creative', userPrompt: s.prompt, composedPositive: s.prompt, composedNegative: '', batchId: `reel-${r.id}`, reelId: r.id }
      const j = s.faire === 'retoucher'
        ? filer(r.id, { ...commun, id: `${r.id}-${s.id}`, op: 'edit', sourceImage: versInput(store.getAsset(src.asset)) })
        : filer(r.id, { ...commun, id: `${r.id}-${s.id}`, photoEngine: 'klein', width: 768, height: 1344, seed: { mode: 'lock', value: r.graine },
          ...(refs.length ? { references: refs.map(x => versInput(store.getAsset(x.asset))) } : {}) })
      s.job = j.id; change = true
      continue
    }
    const st = etatJob(s.job)
    if (st === 'done') { const a = premierAsset(s.job); if (a) { s.asset = a.id; change = true } }
    else if (RATE.has(st)) return ecrire(r.id, 'echec', { graphe: g, erreur: `l’image « ${s.id} » a échoué — relancer le reel` })
  }
  g.clips.forEach((c, k) => {
    if (c.asset) return
    if (!c.job) {
      const de = g.stills[c.de], a = c.a ? g.stills[c.a] : null
      if (!de.asset || (a && !a.asset)) return
      const j = filer(r.id, { id: `${r.id}-${c.id}`, mode: 'video', register: 'sfw', personaId: r.personaId, purpose: 'creative', videoEngine: c.moteur,
        sourceImage: versInput(store.getAsset(de.asset)), ...(a ? { endImage: versInput(store.getAsset(a.asset)) } : {}),
        composedPositive: `${c.prompt} ${SEULE}`, userPrompt: c.prompt, composedNegative: '', videoSeconds: c.secondes, videoFps: 24, videoAspect: '9:16',
        withAudio: false, reelId: r.id })
      c.job = j.id; r.plans[k].photoJob = de.job; r.plans[k].photoAsset = de.asset; r.plans[k].clipJob = j.id; change = true
      return
    }
    const st = etatJob(c.job)
    if (st === 'done') { const a = premierAsset(c.job); if (a) { c.asset = a.id; r.plans[k].clipAsset = a.id; change = true } }
    else if (RATE.has(st)) c.rate = true
  })
  if (g.clips.some(c => c.rate)) return ecrire(r.id, 'echec', { graphe: g, plans: r.plans, erreur: 'un clip a échoué — relancer le reel' })
  // le montage attend le morceau s'il y en a un (au plus 10 min de plus)
  const ms = r.musiqueJob ? etatJob(r.musiqueJob) : null
  if (g.clips.every(c => c.asset) && (!r.musiqueJob || ms === 'done' || RATE.has(ms) || Date.now() - r.updatedAt > 600_000)) return monterPreset(r)
  if (change) ecrire(r.id, 'preset', { graphe: g, plans: r.plans })
}

/* ---------- 4. montage : coupes franches, clips entiers ---------- */
function monterPreset(r) {
  const g = r.graphe
  const proj = montage.creerProjet(`Reel — ${r.brief.slice(0, 50)}`, r.personaId)
  const clips = g.montage.ordre.map((id, i) => { const c = g.clips.find(x => x.id === id); return { assetId: c.asset, debut: c.debut ?? 0, fin: c.fin ?? null, duree: 3,
    texte: i === 0 ? r.accroche ?? '' : '', textePos: 'centre', transition: 'coupe', transitionDuree: 0.35, crop: null } })
  // le morceau composé pour le reel : son fichier porte la fin de l'id du job
  let musique = null
  if (r.musiqueJob && etatJob(r.musiqueJob) === 'done') {
    const f = montage.listerMusiques().map(m => m.nom).find(n => n.endsWith(`_${r.musiqueJob.slice(-6)}.mp3`))
    if (f) musique = { fichier: f, boucle: false, volume: 0.9, fonduEntree: 0, fonduSortie: 1.0, decalage: 0 }
  }
  const p2 = montage.ecrireProjet(proj.id, { data: { format: '9:16', cadrage: 'remplir', sonClips: false, volumeClips: 1, musique, clips } })
  try {
    const { jobId } = montage.exporter(p2)
    return ecrire(r.id, 'export', { graphe: g, plans: r.plans, montageId: proj.id, exportJob: jobId })
  } catch (e) {
    return ecrire(r.id, 'echec', { graphe: g, montageId: proj.id, erreur: `montage : ${String(e.message || e).slice(0, 300)}` })
  }
}

export function demarrerSuiviPresets() {
  setInterval(() => {
    for (const row of store.db.prepare(`SELECT id FROM reels WHERE etat = 'preset'`).all()) {
      try { avancerPreset(lire(row.id)) } catch (e) { console.warn(`[reel ${row.id}] preset : ${e.message || e}`) }
    }
  }, 4000).unref()
}
export { cancelJob }
