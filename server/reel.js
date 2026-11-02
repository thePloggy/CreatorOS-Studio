/* ============================================================
   Reel en un clic — un brief, et l'app réalise le reel :
     1. RÉDACTION   le réalisateur (LLM local) écrit 4 à 6 plans d'une même
                    séance (même tenue, même lieu, même lumière), une accroche,
                    et pour chaque plan l'image fixe ET le mouvement ;
     2. PHOTOS      un rendu photo par plan, avec l'identité du personnage ;
     3. CLIPS       chaque photo animée en LTX-2.5 (image → vidéo, son
                    d'ambiance), avec la LoRA vidéo du personnage s'il en a ;
     4. MONTAGE     un projet de l'onglet Montage, monté tout seul (fondus,
                    accroche sur le premier plan, musique), puis exporté.
   Chaque étape passe par la file de rendu ordinaire : un plan raté se refait
   comme n'importe quel job, et le montage reste modifiable ensuite.

   L'état vit en base (table `reels`) : la boucle de suivi reprend après un
   redémarrage, sauf une rédaction interrompue (à relancer).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { fetchOllama } from './gpu.js'
import * as composer from './composer.js'
import { persona } from './persona.js'
import { enqueue as enfiler, deposerAvecCle, cancelJob } from './jobs.js'
import * as montage from './montage.js'
import { t0Hit } from './t0.js'
import { synthetiser, VOIX } from './voix.js'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
const lancer = promisify(execFile)

/* Voix off du reel : une phrase par plan, écrite par le même LLM, dite par Kokoro (anglais).
   Une phrase doit finir avant la coupe : son nombre de mots est borné par la durée du plan
   (environ 2,3 mots par seconde), vérifié en code ; une phrase trop longue est réécrite une
   fois, puis coupée à sa dernière ponctuation, sinon le plan reste muet. */
export const motsMax = pas => Math.max(4, Math.floor(pas * 2.3) - 1)
const nbMots = l => String(l).trim().split(/\s+/).filter(Boolean).length
async function demanderLignes({ system, prompt }) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 480000)),
    body: JSON.stringify({ model: composer.modelFor(), stream: false, think: false, keep_alive: '10m', system, prompt,
      format: { type: 'object', required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } },
      options: { num_gpu: 0, num_ctx: 8192, num_predict: 600, temperature: 0.7 } }),
  })
  if (!res.ok) throw new Error(`voix off : HTTP ${res.status}`)
  return JSON.parse(String((await res.json()).response || '{}')).lines ?? []
}
export async function narrer({ brief, plans, nom, pas }) {
  const max = motsMax(pas)
  const system = `You write the voice-over of a short vertical reel about ${nom}. One line per shot, in English, spoken in the first person by ${nom}, warm and natural. `
    + `Together the lines tell ONE tiny story with a beginning, a middle and an end, and each line matches what we SEE in its shot. `
    + `HARD LIMIT: each line is ONE short sentence of at most ${max} words — it must be finished before the cut. Fewer words is better. `
    + 'No hashtags, no emojis, no brand names, nothing unsafe.'
  const prompt = `Brief: ${brief}\n${plans.map((p, k) => `Shot ${k + 1}: ${p.action || p.still}`).join('\n')}`
  let lignes = (await demanderLignes({ system, prompt })).map(l => String(l ?? '').trim())
  const longues = plans.map((_, k) => k).filter(k => nbMots(lignes[k] ?? '') > max)
  if (longues.length) {
    try {
      const refaites = await demanderLignes({ system, prompt: `${prompt}\n\nThese lines are too long, rewrite each in at most ${max} words, same meaning:\n`
        + longues.map(k => `Shot ${k + 1}: ${lignes[k]}`).join('\n') })
      longues.forEach((k, j) => { const l = String(refaites[j] ?? '').trim(); if (l && nbMots(l) <= max) lignes[k] = l })
    } catch { /* la coupe ci-dessous garde le reel sonorisé */ }
  }
  const tenir = l => {
    if (nbMots(l) <= max) return l
    const debut = l.split(/\s+/).slice(0, max).join(' ')
    const fin = Math.max(debut.lastIndexOf('.'), debut.lastIndexOf(','), debut.lastIndexOf('!'), debut.lastIndexOf('?'))
    return fin > 8 ? debut.slice(0, fin).replace(/,$/, '') + '.' : ''
  }
  return plans.map((_, k) => tenir(String(lignes[k] ?? '').slice(0, 160))).map(l => (t0Hit(l) ? '' : l))
}

const dureeAudio = f => { try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' })) || 0 } catch { return 0 } }

/** Une piste : chaque phrase posée au début de son plan, sous la musique (abaissée quand la voix parle). */
export async function pisteNarree(r, nbPlans, pasPlan) {
  const morceaux = []
  for (const [k, l] of (r.narration ?? []).entries()) {
    if (!l || k >= nbPlans) continue
    let { nom } = await synthetiser({ texte: l, voix: r.voix })
    const d = dureeAudio(path.join(montage.MUSIQUES_DIR, nom)), place = pasPlan - 0.4
    if (d > place) {
      fs.rmSync(path.join(montage.MUSIQUES_DIR, nom), { force: true })
      ;({ nom } = await synthetiser({ texte: l, voix: r.voix, vitesse: Math.min(1.25, d / place) }))
    }
    morceaux.push({ f: path.join(montage.MUSIQUES_DIR, nom), t: k * pasPlan + 0.25 })
  }
  if (!morceaux.length) return null
  const total = nbPlans * pasPlan + 1
  const nom = `reel_${r.id}_voix.wav`, sortie = path.join(montage.MUSIQUES_DIR, nom)
  const ins = morceaux.flatMap(m => ['-i', m.f])
  const voix = morceaux.map((m, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(m.t * 1000)}|${Math.round(m.t * 1000)}[v${i}]`).join(';')
  const mix = `${morceaux.map((_, i) => `[v${i}]`).join('')}amix=inputs=${morceaux.length}:normalize=0,apad=whole_dur=${total}`
  const musique = r.musique ? montage.cheminMusique(r.musique) : null
  const depart = r.grille?.debut ?? 0
  const fc = musique
    ? `${voix};${mix},asplit=2[vo][sc];[${morceaux.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=${depart}:${depart + total},asetpts=PTS-STARTPTS,volume=0.6[m];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];[md][vo]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5[a]`
    : `${voix};${mix},loudnorm=I=-14:TP=-1.5[a]`
  await lancer('ffmpeg', ['-v', 'error', '-y', ...ins, ...(musique ? ['-i', musique] : []), '-filter_complex', fc, '-map', '[a]', '-t', String(total), sortie], { timeout: 120_000 })
  for (const m of morceaux) fs.rmSync(m.f, { force: true })
  return nom
}

store.db.exec(`CREATE TABLE IF NOT EXISTS reels (
  id TEXT PRIMARY KEY, persona_id TEXT, brief TEXT NOT NULL, etat TEXT NOT NULL,
  data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)

/* Clé Comfy Cloud du visiteur : les jobs d'un reel partent plus tard, depuis la
   boucle de suivi, hors de la requête qui la portait. Gardée EN MÉMOIRE seulement
   (jamais en base), le temps du reel ; perdue au redémarrage, comme partout ailleurs. */
const cles = new Map()
const enqueue = (reelId, job) => deposerAvecCle(cles.get(reelId) ?? null, () => enfiler(job))

const ligne = r => r && { id: r.id, personaId: r.persona_id, brief: r.brief, etat: r.etat, createdAt: r.created_at, updatedAt: r.updated_at, ...JSON.parse(r.data) }
export const lireReel = id => ligne(store.db.prepare('SELECT * FROM reels WHERE id = ?').get(id))
export const listerReels = personaId => store.db.prepare('SELECT * FROM reels WHERE persona_id IS ? ORDER BY created_at DESC LIMIT 30').all(personaId ?? null).map(ligne)
function ecrire(id, etat, patch) {
  const r = lireReel(id)
  if (!r) return null
  const { id: _i, personaId: _p, brief: _b, etat: _e, createdAt: _c, updatedAt: _u, ...data } = r
  store.db.prepare('UPDATE reels SET etat = ?, data = ?, updated_at = ? WHERE id = ?')
    .run(etat ?? r.etat, JSON.stringify({ ...data, ...patch }), Date.now(), id)
  return lireReel(id)
}

/* ---------- 1. rédaction ----------
   Même méthode que le carrousel : le CODE distribue à chaque plan sa place dans le récit
   (cadrage, angle, geste, mouvement de caméra, accessoire), tirés sans répétition ; le
   réalisateur remplit des champs séparés (geste, appui, objet exact, image, mouvement) ;
   des contrôles écrits en code relèvent les fautes, et seuls les plans fautifs sont
   redemandés, avec la faute écrite à côté. */
const melange = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }
const ARCS = {
  3: ['wide establishing shot', 'medium shot', 'close-up'],
  4: ['wide establishing shot', 'medium shot', 'close-up detail', 'medium-wide closing shot'],
  5: ['wide establishing shot', 'medium-wide shot', 'close-up detail', 'medium shot', 'medium close-up closing shot'],
  6: ['wide establishing shot', 'medium-wide shot', 'medium shot', 'close-up detail', 'medium shot', 'wide closing shot'],
}
const SERRE = /close-up/i
const ANGLES = ['camera at her eye level', 'slightly low angle', 'from slightly above', 'three-quarter view from her side', 'side profile', 'from behind her, over her shoulder']
const CAMERA = [['slow push-in', /push(es|ing)?[- ]in|dolly in|moves? (in|closer)/i], ['gentle pan', /\bpan/i], ['handheld follow', /handheld|follows?/i],
  ['slow orbit around her', /orbit|arc(s|ing)? around|circles?/i], ['slow tilt up', /tilt/i], ['slow pull back', /pull(s|ing)? back|dolly out|moves? back/i]]
const GESTES = ['walking a few steps toward the camera', 'turning her head toward the view', 'a soft laugh', 'tucking her hair behind her ear',
  'leaning on something from the setting', 'a deep breath, her shoulders relax', 'running her hand along a surface of the setting',
  'looking around, taking the place in', 'settling into a seat of the setting', 'the wind moving her hair and clothes']
const PIEDS = /\b(boots?|booties|heels?|heeled|stilettos?|pumps|shoes?|sneakers?|trainers|sandals?|espadrilles?|wedges?|flats|loafers?|mules|socks?|stockings?|tights)\b/i

export function affectations(n) {
  const cadrages = ARCS[n] ?? ARCS[5]
  const angles = melange(ANGLES), cams = melange(CAMERA), gestes = melange(GESTES)
  return cadrages.map((cadrage, k) => {
    const detail = /detail/.test(cadrage)
    return {
      cadrage, angle: k === 0 ? 'camera at her eye level' : angles[k % angles.length],
      geste: detail ? 'her hands with the object' : `${gestes[(2 * k) % gestes.length]} — or ${gestes[(2 * k + 1) % gestes.length]}`,
      camera: cams[k % cams.length][0], cameraRe: cams[k % cams.length][1],
      objet: detail ? 'objet' : Math.random() < 0.5 ? 'aucun' : 'lieu',
    }
  })
}
const ligneDe = (a, k) => `SHOT ${k + 1}: framing = ${a.cadrage}; camera = ${a.angle}; action = ${a.geste}; camera move = ${a.camera}; `
  + ({ aucun: 'object = none — nothing in her hands, her support comes from the setting',
    lieu: 'object = one object that truly belongs in this place and this moment — she touches or uses it',
    objet: 'object = one precise object of this place, the subject of the detail shot — her hands touch or hold it' })[a.objet]

const SCHEMA = n => ({
  type: 'object', required: ['hook', 'outfit', 'location', 'light', 'shots'],
  properties: {
    hook: { type: 'string' }, outfit: { type: 'string' }, location: { type: 'string' }, light: { type: 'string' },
    shots: { type: 'array', minItems: n, maxItems: n, items: {
      type: 'object', required: ['action', 'support', 'object', 'still', 'motion'],
      properties: { action: { type: 'string' }, support: { type: 'string' }, object: { type: 'string' }, still: { type: 'string' }, motion: { type: 'string' } } } },
  },
})
const SCHEMA_PLANS = n => ({ type: 'object', required: ['shots'], properties: { shots: SCHEMA(n).properties.shots } })

function consigne(nom, n, langue) {
  return `You are the director of a short vertical social-media reel (9:16), shot in ONE session with ONE woman named ${nom}, a fictional adult.
Plan exactly ${n} shots that follow each other in time and tell a tiny story: a beginning that sets the place, a middle where something happens, an end that lands.
The events of the brief happen across the shots, IN ORDER (a brief "coffee on a terrace, then a walk to the tram" gives terrace shots first, then the walk, then the tram).
Write ONCE, for the whole reel: "outfit" (every garment with its colour and fabric), "location" (the area where the whole reel happens, with what is in it — a neighbourhood, a beach, a house), "light" (time of day and light quality). They are added to every shot by the system: never repeat them in a shot. When the story moves, each still names its exact spot within that area.
Never name a real business, café, shop or brand: describe the place instead.
Each shot has an assignment line. Follow it, and fill, in this order:
- action: what her body does, adapted to this woman, this outfit, this place and this mood. Keep the KIND of movement assigned, choose the version that is credible here.
- support: what her body rests on or is against, taken from this setting (a railing, a café chair, a stone step). "none" only in a close-up.
- object: ONLY the name of the assigned object, 2 to 8 words, with its colour and material ("a white porcelain espresso cup", "a folded paper city map") — no verb, no position, never a generic word, never a brand. "none" when the line says none. Every object of the reel is different, and belongs in this place.
- still: the photograph that opens the shot, 30 to 55 words, English. Start with the assigned framing and camera angle, then her action (the same as in "action" — the still SHOWS it), her hands, her support, the object named exactly as in "object" and what she does WITH it. Only what is visible. Never two things her hands do at once.
- motion: the next few seconds at natural speed, 12 to 25 words: ONE gesture that continues the pose of the still, plus the assigned camera move, named as given.
DESCRIBE ONLY WHAT IS INSIDE THE FRAME: in a close-up, her face, her hands and what they touch — never her legs, her feet, her shoes or how she stands. In a medium shot, nothing below the waist. Naming a body part that is out of frame pulls the camera back.
Never describe her face, her eye colour or her body shape: the system adds her identity.
She is ALONE: no other person acts in the reel, nobody else's face.
In motion, never: putting on, taking off or adjusting glasses, hats, jewellery or clothing; getting in or out of a vehicle, driving off, opening doors; picking up, holding up or handing over objects. If she sits in the still, she stays seated; if she stands, she stays on her feet.
No text, signs, logos or lettering anywhere in the frame.
Everything is safe for work: fully clothed, no nudity, no lingerie, no real celebrities.
"hook": the on-screen opening text of the reel, 3 to 7 words, catchy, in ${langue}.
Write everything except the hook in English.`
}

async function appeler({ system, prompt, format, temperature, predire }) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 480000)),
    body: JSON.stringify({ model: composer.modelFor(), system, prompt, format, stream: false, think: false, keep_alive: '10m',
      options: { num_gpu: 0, num_ctx: 8192, num_predict: predire, temperature } }),
  })
  if (!res.ok) throw new Error(`le réalisateur (LLM) a refusé : HTTP ${res.status}`)
  return JSON.parse(String((await res.json()).response || '{}'))
}

const VIDES = new Set('her his she the a an with of in into on to from and it its is are as at toward towards'.split(' '))
const racinesAction = t => String(t ?? '').replace(/\b[A-Z][a-z]+'?s?\b/g, ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(m => m.length > 3 && !VIDES.has(m)).map(m => m.slice(0, 5))
const partage = (a, b) => { const r = racinesAction(a), p = new Set(racinesAction(b)); return r.length ? r.filter(m => p.has(m)).length / r.length : 1 }
const vide = x => /^(none|no|nothing|n\/a|-)?\.?$/i.test(String(x ?? '').trim())
const teteObjet = o => String(o).toLowerCase().match(/[a-z]+/g)?.filter(w => w.length > 2 && !['the', 'and', 'with', 'her', 'its'].includes(w)).pop()
/** Fautes d'un plan face à son affectation, en anglais pour le réalisateur. */
export function fautesPlan(s, a, autres = []) {
  const f = [], still = String(s?.still ?? '').trim(), motion = String(s?.motion ?? '').trim()
  const mots = still.split(/\s+/).filter(Boolean).length
  if (mots < 26) f.push('the still is missing or too short (30 to 55 words)')
  const objMots = String(s?.object ?? '').trim().split(/\s+/).length
  if (!vide(s?.object) && (objMots > 9 || /,|\b(lying|sitting|resting|placed|on the|she|her)\b/i.test(String(s.object))))
    f.push('object: only the name of the thing with its colour and material, 2 to 8 words, no verb and no position')
  else if (!vide(s?.object) && objMots < 2) f.push('object: name it precisely, with its colour and material')
  if (racinesAction(s?.action).length && partage(s?.action, still) < 0.34) f.push('the still does not show the action: write the action in the still')
  if (/\b(lettering|logo|sign|written|label)\b/i.test(String(s?.object ?? ''))) f.push('object: no text, lettering or logo on it')
  if (mots > 75) f.push('the still is too long (30 to 55 words)')
  if (!SERRE.test(a.cadrage) && vide(s?.support)) f.push('support is empty: say what her body rests on, from the setting')
  if (a.objet === 'aucun' && !vide(s?.object)) f.push('this shot has NO object: object must be "none" and her hands stay free')
  if (a.objet !== 'aucun' && vide(s?.object)) f.push('an object is assigned but object is empty')
  const tete = !vide(s?.object) && teteObjet(s.object)
  if (tete && !still.toLowerCase().includes(tete)) f.push('the object is not named in the still')
  if (tete && autres.some(o => teteObjet(o) === tete)) f.push('another shot already uses this object: choose a different one')
  if (SERRE.test(a.cadrage) && /\b(legs?|knees?|feet|foot|shoes?|boots?|sandals?|heels?|standing|stands|sits|sitting|seated)\b/i.test(still))
    f.push('close-up: describe only her face, her hands and what they touch — no legs, feet, shoes or posture')
  if (/\b(I|me|my|we|our)\b/.test(`${still} ${motion}`)) f.push('first person used: write she, her')
  if (!a.cameraRe.test(motion)) f.push(`the motion must use the assigned camera move: ${a.camera}`)
  for (const c of controlerPlan({ still, motion })) f.push(c.dit)
  return f
}

export async function rediger({ brief, n, nom, langue }) {
  const aff = affectations(n)
  const system = consigne(nom, n, langue)
  const lignes = aff.map(ligneDe)
  const out = await appeler({ system, prompt: `Brief: ${brief}\nWrite exactly one shot for each line, in order:\n${lignes.join('\n')}`, format: SCHEMA(n), temperature: 0.8, predire: 3000 })
  if (!Array.isArray(out.shots) || out.shots.length < 2) throw new Error('le réalisateur n’a pas rendu de plans exploitables')
  const shots = out.shots.slice(0, n)
  const objetsAvant = k => shots.slice(0, k).map(x => x.object).filter(o => !vide(o))
  let fautes = shots.map((x, k) => fautesPlan(x, aff[k], objetsAvant(k)))
  const aRefaire = fautes.map((f, k) => (f.length ? k : -1)).filter(k => k >= 0)
  if (aRefaire.length) {
    try {
      const u2 = `Brief: ${brief}\nThe reel: outfit = ${out.outfit}; location = ${out.location}; light = ${out.light}.\n`
        + `Rewrite ONLY these shots. Each one failed a check, given after it:\n`
        + aRefaire.map(k => `${lignes[k]}\n  your version: ${JSON.stringify(shots[k])}\n  FAILED: ${fautes[k].join('; ')}`).join('\n')
      const refaits = (await appeler({ system, prompt: u2, format: SCHEMA_PLANS(aRefaire.length), temperature: 0.5, predire: 2000 })).shots ?? []
      aRefaire.forEach((k, j) => {
        const neuf = refaits[j]
        if (neuf && !t0Hit(`${neuf.still} ${neuf.motion}`) && fautesPlan(neuf, aff[k], objetsAvant(k)).length < fautes[k].length) shots[k] = neuf
      })
    } catch (e) { console.warn(`réécriture des plans impossible — ${e.message || e}`) }
    fautes = shots.map((x, k) => fautesPlan(x, aff[k], objetsAvant(k)))
  }
  return { ...out, shots, affectations: aff, fautes }
}

/* Tenue cadrée : dans un gros plan, les chaussures et les bas ne sont pas nommés — le
   modèle montre ce qu'on lui nomme, et un gros plan avec « white sneakers » recule en pied.
   Le vêtement lui-même n'est jamais retiré : ce qui n'est pas nommé n'existe pas. */
export function tenueCadree(tenue, cadrage) {
  if (!SERRE.test(cadrage)) return tenue
  const morceaux = String(tenue).split(/\s*,\s*|\s+and\s+/).filter(m => m && !PIEDS.test(m))
  return morceaux.length ? morceaux.join(', ') : tenue
}

/* Le réalisateur (mistral-small) ne tient pas toujours les interdits du mouvement :
   « She puts the car in drive and begins to pull away », « she adjusts her
   sunglasses » (LTX ajoute alors une 2e paire sur son nez). Les phrases
   fautives sont retirées ; s'il ne reste rien, un geste sûr les remplace. */
const INFAISABLE = /\b(put(s|ting)? on|take(s)? off|taking off|adjust(s|ing)?|sunglasses|glasses|hat\b|gets? (in|into|out)|climbs?|opens? the|closes? the|door|engine|ignition|drive(s|n)?\b|driving|pulls? (away|out|off)|gear|accelerat|speeds? (up|off)|starts? the car|picks? up|hands? (her|him|over)|holds? up)/i
const GESTE_SUR = 'Her hair and clothes move gently in the wind, she breathes naturally and smiles softly. The camera slowly pushes in.'
function geste(motion) {
  const phrases = String(motion ?? '').match(/[^.!?]+[.!?]*/g) ?? []
  const gardees = phrases.map(x => x.trim()).filter(x => x && !INFAISABLE.test(x))
  return gardees.length && gardees.join(' ').split(/\s+/).length >= 8 ? gardees.join(' ') : GESTE_SUR
}

/* ---------- contrôle des plans avant le rendu ----------
   Des règles écrites dans le code, pas un modèle qui juge : ce qui donne en pratique un
   clip raté. Un plan fautif est réécrit UNE fois par le réalisateur ; ce qui reste
   fautif part quand même, avec un avertissement sur sa carte. */
const CONTROLES_PLAN = [
  { code: 'enchaine', test: pl => /\b(then|and then|before|after that|afterwards|finally|while also)\b/i.test(pl.motion),
    dit: 'several actions chained in one shot: keep ONE gesture', fr: 'plusieurs actions dans un seul plan' },
  { code: 'marche', test: pl => /\b(walk|walks|walking|stroll|strolls|strolling|steps?|stepping)\b/i.test(pl.motion)
      && !/\b(toward|towards|away from|left to right|right to left|from left|from right|to the left|to the right|forward|past the camera|closer)\b/i.test(pl.motion),
    dit: 'walking with no direction relative to the camera: say toward the camera, away, or left to right', fr: 'marche sans direction (risque de marche à reculons)' },
  { code: 'texte', test: pl => /\b(sign|signs|signboard|text|written|writing|lettering|letters|logo|neon sign|banner|poster|caption|label|menu board)\b/i.test(`${pl.still} ${pl.motion}`),
    dit: 'text, signs or lettering in the frame: the model draws them as gibberish, remove them', fr: 'texte ou panneau dans l’image' },
  { code: 'autrui', test: pl => /\b(another (person|woman|man)|a friend|her friend|boyfriend|girlfriend|partner|a stranger|someone|a man|the man|a waiter|people (come|walk|pass))\b/i.test(pl.motion),
    dit: 'another person acting in the shot: keep her alone in the action', fr: 'une autre personne agit dans le plan' },
  { code: 'long', test: pl => pl.motion.split(/\s+/).length > 32,
    dit: 'motion too long: 12 to 25 words', fr: 'mouvement trop long' },
]
export function controlerPlan(pl) { return CONTROLES_PLAN.filter(c => c.test(pl)) }

/* ---------- lancement ---------- */
export function realiser({ brief, n, duree, musique, langue, cle, personaId, voix, calerMusique }) {
  const b = String(brief ?? '').trim().slice(0, 600)
  if (!b) throw new Error('écris un brief : le lieu, l’ambiance, ce qui se passe')
  if (t0Hit(b)) throw new Error('brief refusé (liste T0)')
  const p = persona(personaId)
  const id = `reel-${Date.now().toString(36)}`
  const data = {
    n: Math.min(6, Math.max(3, Number(n) || 5)),
    duree: Math.min(6, Math.max(3, Number(duree) || 4)),
    musique: typeof musique === 'string' && montage.cheminMusique(musique) ? musique : null,
    langue: langue === 'en' ? 'English' : 'French',
    voix: VOIX.some(v => v.id === voix) ? voix : null, narration: null, calerMusique: calerMusique === true,
    plans: [], erreur: null,
  }
  store.db.prepare('INSERT INTO reels (id, persona_id, brief, etat, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.id ?? null, b, 'redaction', JSON.stringify(data), Date.now(), Date.now())
  if (cle) cles.set(id, cle)
  void (async () => {
    try {
      const nom = String(p.name || 'the model').replace(/\s*\([^)]*\)\s*$/, '').trim()
      const r = await rediger({ brief: b, n: data.n, nom, langue: data.langue })
      if (!enCours(id)) return
      // « She wears A white linen shirt » : le LLM ouvre souvent sur une majuscule
      // … ou répète le sujet (« She wears Mila wears a white blouse »)
      const sujet = new RegExp(`^(?:${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|She)\\s+(?:wears|is wearing)\\s+`, 'i')
      const bas = x => String(x ?? '').trim().replace(sujet, '').replace(/^(A|An|The)\b/, m => m.toLowerCase()).replace(/[.\s]+$/, '')
      const lieu = String(r.location).trim().replace(/[.\s]+$/, ''), lumiere = String(r.light).trim().replace(/[.\s]+$/, '')
      const plans = r.shots.slice(0, data.n).map((s, k) => {
        const a = r.affectations[k]
        const pl = { still: String(s.still).trim(), motion: geste(s.motion), action: String(s.action ?? '').trim(), objet: vide(s.object) ? null : String(s.object).trim(),
          cadrage: a.cadrage, photoJob: null, clipJob: null }
        if (r.fautes[k]?.length) {
          console.log(`[reel ${id}] plan ${k + 1} : ${r.fautes[k].join(' ; ')}`)
          const reste = controlerPlan(pl)
          if (reste.length) pl.avertissements = reste.map(c => c.fr)
        }
        pl.still = `${pl.still} She wears ${bas(tenueCadree(r.outfit, a.cadrage))}. ${lieu}. ${lumiere}.`
        return pl
      })
      for (const pl of plans) {
        if (t0Hit(`${pl.still} ${pl.motion}`)) throw new Error('un plan rédigé contient un terme bloqué (liste T0) — relancer')
      }
      // une photo par plan, toutes au même lot
      const lot = `reel-${id}`
      for (const [k, pl] of plans.entries()) {
        const j = enqueue(id, { id: `${id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: CONFIG.photoEngine,
          composedPositive: pl.still, userPrompt: pl.still, composedNegative: '', width: 768, height: 1344, batchId: lot, reelId: id })
        pl.photoJob = j.id
      }
      if (!enCours(id)) { for (const pl of plans) await cancelJob(pl.photoJob).catch(() => {}); return }
      let narration = null
      if (data.voix) { try { narration = await narrer({ brief: b, plans, nom, pas: data.duree - 0.35 }) } catch (e) { console.warn(`[reel ${id}] voix off : ${e.message || e}`) } }
      if (!enCours(id)) { for (const pl of plans) await cancelJob(pl.photoJob).catch(() => {}); return }
      ecrire(id, 'photos', { narration, accroche: r.hook.trim().replace(/^[«"']+|[»"']+$/g, '').replace(/\.$/, '').trim(), tenue: r.outfit, lieu: r.location, lumiere: r.light, plans })
      console.log(`[reel ${id}] ${plans.length} plans rédigés, photos en file`)
    } catch (e) {
      ecrire(id, 'echec', { erreur: String(e.message || e).slice(0, 400) })
      console.warn(`[reel ${id}] rédaction : ${e.message || e}`)
    }
  })()
  return lireReel(id)
}

/* ---------- suivi : photos → clips → montage → export ---------- */
const etatJob = id => id ? store.getJob(id)?.status ?? 'absent' : null
const premierAsset = id => (id && store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full'))) || null
const versInput = a => {
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}

function avancer(r) {
  if (r.etat === 'photos' || r.etat === 'clips') {
    let change = false, rates = 0
    for (const pl of r.plans) {
      if (!pl.clipJob) {
        const s = etatJob(pl.photoJob)
        if (s === 'done') {
          const a = premierAsset(pl.photoJob)
          if (!a) { rates++; continue }
          pl.photoAsset = a.id
          const j = enqueue(r.id, { id: `${r.id}-c${r.plans.indexOf(pl) + 1}${pl.refait ? `-r${pl.refait}` : ''}`, mode: 'video', register: 'sfw', personaId: r.personaId, purpose: 'creative', videoEngine: 'ltx_hq', withAudio: true,
            sourceImage: versInput(a), composedPositive: `${pl.motion}. single continuous shot, no cuts`, userPrompt: pl.motion, composedNegative: '',
            videoSeconds: r.duree, videoFps: 24, videoAspect: '9:16', reelId: r.id })
          pl.clipJob = j.id; change = true
        } else if (s === 'blocked' || s === 'cancelled' || s === 'absent') rates++
      } else if (!pl.clipAsset) {
        const s = etatJob(pl.clipJob)
        if (s === 'done') { const a = premierAsset(pl.clipJob); if (a) { pl.clipAsset = a.id; change = true } else rates++ }
        else if (s === 'blocked' || s === 'cancelled' || s === 'absent') rates++
      }
    }
    const prets = r.plans.filter(p => p.clipAsset)
    if (prets.length + rates === r.plans.length && prets.length >= 2) return monter(r, prets, rates)
    if (prets.length + rates === r.plans.length) return ecrire(r.id, 'echec', { plans: r.plans, erreur: 'trop de plans ratés pour monter un reel — relancer les jobs en échec ou un nouveau reel' })
    if (change || r.etat === 'photos' && r.plans.some(p => p.clipJob)) ecrire(r.id, r.plans.some(p => p.clipJob) ? 'clips' : 'photos', { plans: r.plans })
    return
  }
  if (r.etat === 'export') {
    const s = etatJob(r.exportJob)
    if (s === 'done') { cles.delete(r.id); ecrire(r.id, 'fini', { reelAsset: premierAsset(r.exportJob)?.id ?? null }) }
    else if (s === 'blocked' || s === 'absent') ecrire(r.id, 'echec', { erreur: 'export du montage en échec — ouvrir le montage et relancer l’export' })
  }
}

/* Clip musical : les temps forts du morceau (scripts/temps.py) donnent la longueur des plans,
   un nombre entier de temps, et les coupes tombent sur les temps. */
function grilleMusique(r) {
  if (!r.calerMusique || !r.musique) return null
  try {
    const py = fs.existsSync(CONFIG.comfyPython) ? CONFIG.comfyPython : 'python3'
    const g = JSON.parse(execFileSync(py, [path.join(import.meta.dirname, '..', 'scripts', 'temps.py'), montage.cheminMusique(r.musique)], { encoding: 'utf8', timeout: 60_000 }))
    if (!g.temps?.length || g.temps.length < 4) return null
    const p = (g.temps[g.temps.length - 1] - g.temps[0]) / (g.temps.length - 1)
    // le plus grand nombre entier de temps qui tient dans un clip : une coupe ne tombe jamais avant la fin du plan
    return { debut: g.temps[0], pas: p * Math.max(1, Math.floor((r.duree - 0.05) / p)), bpm: g.bpm }
  } catch (e) { console.warn(`[reel ${r.id}] tempo : ${e.message || e}`); return null }
}

function monter(r, prets, rates) {
  if (!enCours(r.id)) return
  if (r.grille === undefined) r = { ...r, grille: grilleMusique(r) }
  if (r.voix && r.narration?.some(Boolean) && !r.pisteVoix) {
    ecrire(r.id, 'montage', { plans: r.plans })
    void pisteNarree(r, prets.length, r.grille?.pas ?? (r.duree - 0.35)).then(nom => monter({ ...r, pisteVoix: nom || 'aucune' }, prets, rates))
      .catch(e => { console.warn(`[reel ${r.id}] voix off : ${e.message || e}`); monter({ ...r, pisteVoix: 'aucune' }, prets, rates) })
    return
  }
  const voixOff = r.pisteVoix && r.pisteVoix !== 'aucune' ? r.pisteVoix : null
  if (voixOff) r = { ...r, musique: voixOff }
  const proj = montage.creerProjet(`Reel — ${r.brief.slice(0, 50)}`, r.personaId)
  const g = r.grille
  const clips = prets.map((p, i) => ({ assetId: p.clipAsset, debut: 0, fin: null, duree: g ? Math.round(g.pas * 100) / 100 : r.duree, texte: i === 0 ? r.accroche ?? '' : '',
    textePos: 'centre', transition: g || i === prets.length - 1 ? 'coupe' : 'fondu', transitionDuree: 0.35, crop: null }))
  const p2 = montage.ecrireProjet(proj.id, { data: { format: '9:16', cadrage: 'remplir', sonClips: !(voixOff || r.musique), volumeClips: 1,
    musique: r.musique ? { fichier: r.musique, volume: voixOff ? 1 : 0.85, fonduEntree: g ? 0 : 0.3, fonduSortie: 1.2, decalage: g && !voixOff ? g.debut : 0 } : null, clips } })
  try {
    const { jobId } = montage.exporter(p2)
    return ecrire(r.id, 'export', { plans: r.plans, montageId: proj.id, exportJob: jobId, ratés: rates })
  } catch (e) {
    return ecrire(r.id, 'echec', { plans: r.plans, montageId: proj.id, erreur: `montage : ${String(e.message || e).slice(0, 300)}` })
  }
}

export function demarrerSuivi() {
  // une rédaction interrompue par un redémarrage ne reprendra pas toute seule
  for (const r of store.db.prepare(`SELECT id FROM reels WHERE etat = 'redaction'`).all())
    ecrire(r.id, 'echec', { erreur: 'rédaction interrompue par un redémarrage du service — relancer le reel' })
  setInterval(() => {
    for (const row of store.db.prepare(`SELECT id FROM reels WHERE etat IN ('photos','clips','export')`).all()) {
      try { avancer(lireReel(row.id)) } catch (e) { console.warn(`[reel ${row.id}] suivi : ${e.message || e}`) }
    }
  }, 4000).unref()
}

/** Refait un seul plan d'un reel fini : sa photo est gardée, son clip est rendu à nouveau
 *  (avec un nouveau mouvement si on en donne un), puis le reel est remonté. Les autres clips ne bougent pas. */
export function refairePlan(id, k, motion) {
  const r = lireReel(id)
  if (!r) throw new Error('reel inconnu')
  if (r.etat !== 'fini' && r.etat !== 'echec') throw new Error('attends la fin du reel pour refaire un plan')
  const pl = r.plans?.[Number(k)]
  if (!pl?.photoJob) throw new Error('plan inconnu')
  const m = String(motion ?? '').trim().slice(0, 300)
  if (m && t0Hit(m)) throw new Error('mouvement refusé (liste T0)')
  if (m) pl.motion = m
  pl.refait = (pl.refait ?? 0) + 1
  pl.clipJob = null; pl.clipAsset = null
  ecrire(id, 'clips', { plans: r.plans, reelAsset: null, exportJob: null, erreur: null })
  return lireReel(id)
}

/** Retire un reel de la liste (ses photos, clips et montage restent dans la bibliothèque). */
/** Annule un reel en cours : ses jobs encore en file ou en rendu sont arrêtés, la rédaction
 *  en vol s'arrête à son retour, et le suivi le laisse. Ce qui est déjà rendu reste en bibliothèque. */
export async function annulerReel(id) {
  const r = lireReel(id)
  if (!r) return null
  if (r.etat === 'fini' || r.etat === 'echec') return r
  ecrire(id, 'echec', { erreur: 'annulé' })
  cles.delete(id)
  const jobs = [...(r.plans ?? []).flatMap(p => [p.photoJob, p.clipJob]), r.exportJob].filter(Boolean)
  for (const j of jobs) await cancelJob(j).catch(() => {})
  return lireReel(id)
}
const enCours = id => ['redaction', 'photos', 'clips', 'montage', 'export'].includes(lireReel(id)?.etat)

export async function supprimerReel(id) {
  await annulerReel(id)
  cles.delete(id)
  return store.db.prepare('DELETE FROM reels WHERE id = ?').run(String(id)).changes > 0
}
