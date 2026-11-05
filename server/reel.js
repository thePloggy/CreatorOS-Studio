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
import { FORMATS, reglesFormat, consigneChoix, SCHEMA_CHOIX } from './formatsReel.js'
import { anatomieImage, anatomieVideo } from './anatomie.js'
import { dire, voixAcceptee } from './voix.js'
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
    let { nom } = await dire({ texte: l, voix: r.voix, proprietaire: true })
    const d = dureeAudio(path.join(montage.MUSIQUES_DIR, nom)), place = pasPlan - 0.4
    if (d > place) {
      fs.rmSync(path.join(montage.MUSIQUES_DIR, nom), { force: true })
      ;({ nom } = await dire({ texte: l, voix: r.voix, vitesse: Math.min(1.25, d / place), proprietaire: true }))
    }
    morceaux.push({ f: path.join(montage.MUSIQUES_DIR, nom), t: k * pasPlan + 0.25 })
  }
  if (!morceaux.length) return null
  const total = nbPlans * pasPlan + 2
  const nom = `reel_${r.id}_voix.wav`, sortie = path.join(montage.MUSIQUES_DIR, nom)
  const ins = morceaux.flatMap(m => ['-i', m.f])
  const voix = morceaux.map((m, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(m.t * 1000)}|${Math.round(m.t * 1000)}[v${i}]`).join(';')
  const mix = `${morceaux.map((_, i) => `[v${i}]`).join('')}amix=inputs=${morceaux.length}:normalize=0,apad=whole_dur=${total}`
  const musique = r.musique ? montage.cheminMusique(r.musique) : null
  const depart = r.grille?.debut ?? 0
  const fc = musique
    ? `${voix};${mix},asplit=2[vo][sc];[${morceaux.length}:a]${montage.boucleSonore(musique, depart, total)},volume=0.6[m];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];[md][vo]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5,apad=whole_dur=${total}[a]`
    : `${voix};${mix},loudnorm=I=-14:TP=-1.5,apad=whole_dur=${total}[a]`
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
// toujours le visage dans le champ : l'identité du clip vient du visage de la photo de départ
const ANGLES = ['camera at her eye level', 'slightly low angle', 'from slightly above', 'three-quarter front view', 'three-quarter view from her side, her face toward the camera']
const DOS = /\b(from behind|her back (is )?(to|toward)|back to the camera|facing away|seen from behind|over her shoulder|turn(s|ing|ed)? away|walk(s|ing)? away|looks? away from the camera|her face (is )?(hidden|out of frame|not visible)|only her hands|hands only|silhouette)\b/i
const CAMERA = [['subtle slow push-in, the framing tightens only slightly', /push(es|ing)?[- ]in|dolly in|moves? (in|closer)/i], ['gentle pan', /\bpan/i], ['handheld follow', /handheld|follows?/i],
  ['slow orbit around her', /orbit|arc(s|ing)? around|circles?/i], ['slow tilt up', /tilt/i], ['slow pull back', /pull(s|ing)? back|dolly out|moves? back/i]]
const GESTES = ['walking a few steps toward the camera', 'a glance toward the view, then back to the camera', 'a soft laugh', 'tucking her hair behind her ear',
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
      geste: detail ? 'her hands with the object, close to her face' : `${gestes[(2 * k) % gestes.length]} — or ${gestes[(2 * k + 1) % gestes.length]}`,
      camera: cams[k % cams.length][0], cameraRe: cams[k % cams.length][1],
      objet: detail ? 'objet' : Math.random() < 0.5 ? 'aucun' : 'lieu',
    }
  })
}
const ligneDe = (a, k) => `SHOT ${k + 1}: framing = ${a.cadrage}; camera = ${a.angle}; action = ${a.geste}; camera move = ${a.camera}; `
  + ({ aucun: 'object = none — nothing in her hands, her support comes from the setting',
    lieu: 'object = an object the brief names (her cocktail, her book…) if there is one, otherwise one object that truly belongs in this place and this moment — she touches or uses it',
    objet: 'object = the subject of the detail shot: an object the brief names if there is one, otherwise one precise object of this place — her hands touch or hold it' })[a.objet]

const SCHEMA = n => ({
  type: 'object', required: ['brief_objects', 'hook', 'outfit', 'location', 'light', 'shots'],
  properties: {
    brief_objects: { type: 'array', items: { type: 'string' } }, hook: { type: 'string' }, outfit: { type: 'string' }, location: { type: 'string' }, light: { type: 'string' },
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
"brief_objects": the objects the brief itself names for her (a cocktail, a guitar, a coffee), each with its colour and material; [] if it names none. They are HER objects: they come back across the shots where an object is assigned, and they are the subject of the detail shot. Never replace them with unrelated props.
Keep the mood, the moment and the activity of the brief in every shot: a cocktail at sunset is an adult evening moment — no children's toys, buckets, spades or games, and "location" lists only what this mood calls for.
Each shot has an assignment line. Follow it, and fill, in this order:
- action: what her body does, adapted to this woman, this outfit, this place and this mood. Keep the KIND of movement assigned, choose the version that is credible here.
- support: what her body rests on or is against, taken from this setting (a railing, a café chair, a stone step). "none" only in a close-up.
- object: ONLY the name of the assigned object, 2 to 8 words, with its colour and material ("a white porcelain espresso cup", "a folded paper city map") — no verb, no position, never a generic word, never a brand. "none" when the line says none. Every object of the reel is different, and belongs in this place.
- still: the photograph that opens the shot, 30 to 55 words, English. Start with the assigned framing and camera angle, then her action (the same as in "action" — the still SHOWS it), her hands, her support, the object named exactly as in "object" and what she does WITH it. Only what is visible. Never two things her hands do at once.
- motion: the next few seconds at natural speed, 12 to 25 words: ONE gesture that continues the pose of the still, plus the assigned camera move, named as given.
DESCRIBE ONLY WHAT IS INSIDE THE FRAME: in a close-up, her face, her hands and what they touch — never her legs, her feet, her shoes or how she stands. In a medium shot, nothing below the waist. Naming a body part that is out of frame pulls the camera back.
HER FACE IS IN EVERY SHOT: in every still and every motion her face is visible, turned toward the camera or three-quarters at most — never from behind, never her back to the camera, never a profile that hides her eyes, never a shot of her hands alone (a detail shot frames her face AND her hands with the object). In motion she never turns or walks away from the camera. Without her face, the clip loses who she is.
Never describe her face, her eye colour or her body shape: the system adds her identity.
She is the ONLY person in focus: nobody near her, nobody she talks to, no waiter or vendor in the shot (the image model would give any visible person her face). Other people may appear only far in the background, small and blurred, faces not visible.
In motion, never: putting on, taking off or adjusting glasses, hats, jewellery or clothing; getting in or out of a vehicle, driving off, opening doors; picking up, holding up or handing over objects. If she sits in the still, she stays seated; if she stands, she stays on her feet.
In motion, the camera stays gentle: the framing changes by one step at most (a wide shot ends as a medium-wide, a medium shot never ends as a close-up of her face).
In motion, what she holds in the still stays in the same hand for the whole shot, no new object appears (no bag, no phone, no cup that was not there), and she never turns around or turns her back.
Vehicles in the frame (tram, funicular, car, boat) stay on their rails, road or water, move slowly in a straight line at real speed or stay still; nothing floats, lifts off or flies.
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
export function fautesPlan(s, a, autres = [], duBrief = []) {
  const f = [], still = String(s?.still ?? '').trim(), motion = String(s?.motion ?? '').trim()
  const mots = still.split(/\s+/).filter(Boolean).length
  if (mots < 26) f.push('the still is missing or too short (30 to 55 words)')
  const objMots = String(s?.object ?? '').trim().split(/\s+/).length
  if (!vide(s?.object) && (objMots > 9 || /\b(lying|sitting|resting|placed|on the|she|her)\b/i.test(String(s.object))))
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
  const tetesBrief = duBrief.map(teteObjet).filter(Boolean)
  const objetBrief = tete && tetesBrief.some(b => b === tete || String(s.object).toLowerCase().includes(b))
  if (tete && !objetBrief && autres.some(o => teteObjet(o) === tete)) f.push('another shot already uses this object: choose a different one')
  if (tete && tetesBrief.length && !objetBrief) f.push(`the brief names ${duBrief.join(', ')}: use it as her object instead of an unrelated prop`)
  if (/\b(toys?|bucket|spade|shovel|sandcastle|kite|beach ball)\b/i.test(`${s?.object ?? ''} ${still}`) && tetesBrief.length) f.push('no children\'s toys or games: keep the adult mood of the brief')
  if (SERRE.test(a.cadrage) && /\b(legs?|knees?|feet|foot|shoes?|boots?|sandals?|heels?|standing|stands|sits|sitting|seated)\b/i.test(still))
    f.push('close-up: describe only her face, her hands and what they touch — no legs, feet, shoes or posture')
  if (DOS.test(still)) f.push('her face must be visible in the still, turned toward the camera or three-quarters: never from behind, facing away or hands only')
  if (DOS.test(motion)) f.push('in motion she never turns or walks away from the camera: her face stays visible')
  if (/\b(turns? around|spins? around|turns? her back)\b/i.test(motion)) f.push('in motion she never turns around: she keeps facing the camera')
  if (/\b(close-up|close up|extreme close|fills the frame|right up to her face)\b/i.test(motion) && !SERRE.test(a.cadrage)) f.push('the camera move must stay gentle: it never ends on a close-up of her face')
  if (/\b(flies|flying|lifts? off|takes? off|floats?|floating|rises into the (air|sky))\b/i.test(motion)) f.push('nothing flies or floats: vehicles stay on their rails or road')
  if (/\bdetail\b/i.test(a.cadrage) && !/\b(face|smil|eyes|lips|gaze|looks?)\w*/i.test(still)) f.push('detail shot: frame her face AND her hands with the object')
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
  const duBrief = (out.brief_objects ?? []).map(String).filter(x => x.trim()).slice(0, 4)
  let fautes = shots.map((x, k) => fautesPlan(x, aff[k], objetsAvant(k), duBrief))
  const aRefaire = fautes.map((f, k) => (f.length ? k : -1)).filter(k => k >= 0)
  if (aRefaire.length) {
    try {
      const u2 = `Brief: ${brief}\nThe reel: outfit = ${out.outfit}; location = ${out.location}; light = ${out.light}.\n`
        + `Rewrite ONLY these shots. Each one failed a check, given after it:\n`
        + aRefaire.map(k => `${lignes[k]}\n  your version: ${JSON.stringify(shots[k])}\n  FAILED: ${fautes[k].join('; ')}`).join('\n')
      const refaits = (await appeler({ system, prompt: u2, format: SCHEMA_PLANS(aRefaire.length), temperature: 0.5, predire: 2000 })).shots ?? []
      aRefaire.forEach((k, j) => {
        const neuf = refaits[j]
        if (neuf && !t0Hit(`${neuf.still} ${neuf.motion}`) && fautesPlan(neuf, aff[k], objetsAvant(k), duBrief).length < fautes[k].length) shots[k] = neuf
      })
    } catch (e) { console.warn(`réécriture des plans impossible — ${e.message || e}`) }
    fautes = shots.map((x, k) => fautesPlan(x, aff[k], objetsAvant(k), duBrief))
  }
  return { ...out, shots, affectations: aff, fautes }
}

/* ---------- rédaction, 2e manière ----------
   Le reel raconte une petite histoire : le réalisateur (modèle plus fort) écrit d'abord le
   récit en temps forts (accroche, moment fort, chute), puis un plan par temps fort, chacun
   à un ENDROIT différent du lieu, avec une échelle et un angle différents, et un look de
   cinéma commun (boîtier, optique, pellicule, étalonnage) choisi pour l'ambiance.
   Un découpage déjà écrit dans le brief (« [Shot 1] … ») est suivi plan par plan. */
export const MODELE_REALISATEUR = process.env.CREATOROS_REALISATEUR || 'qwen3.5:35b'
const LOOKS_REEL = {
  'golden-hour': 'shot on a large-format digital cinema camera with a spherical prime lens, warm golden hour sunlight, low sun, long soft shadows, gentle film grain, warm amber color grade',
  'natural-day': 'shot on a large-format digital cinema camera with a spherical prime lens, soft natural daylight, true-to-life colors, clean film look',
  'night-city': 'shot on a digital cinema camera with an anamorphic lens, night city lights, neon reflections on wet surfaces, rich contrast, teal and orange color grade',
  'moody-interior': 'shot on 35mm film with a vintage lens, soft window light and deep shadows, film grain, slightly desaturated grade',
  'action': 'shot on a large-format digital cinema camera with a wide lens, dynamic light, high contrast, blockbuster action film still, teal and orange color grade',
  'summer-16mm': 'shot on 16mm film, backlight, light leaks and grain, pastel summer color grade',
}
const FOCALE = { wide: '24mm lens', 'medium-wide': '35mm lens', medium: '50mm lens', 'medium close-up': '85mm lens', 'close-up': '85mm lens at f/1.4, shallow depth of field' }
const focaleDe = c => FOCALE[Object.keys(FOCALE).sort((a, b) => b.length - a.length).find(k => c.includes(k)) ?? 'medium']
const ANGLES2 = ['camera at her eye level', 'slightly low angle', 'from slightly above', 'three-quarter front view', 'three-quarter view from her side, her face toward the camera',
  'profile view with her face clearly visible', 'over the shoulder toward what she looks at, then her face in three-quarter']
const CAMERA2 = [['subtle push-in, the framing tightens only slightly', /push(es|ing)?[- ]in|dolly in|moves? (in|closer)/i], ['gentle pan', /\bpan/i], ['handheld follow', /handheld|follows?/i],
  ['orbit around her', /orbit|arc(s|ing)? around|circles?/i], ['pull back', /pull(s|ing)? back|dolly out|moves? back/i], ['tracking shot alongside her', /track(s|ing)?|alongside/i]]
export function affectations2(n, format = 'journee') {
  if (FORMATS[format]?.cadrageFixe) return Array.from({ length: n }, () => ({
    cadrage: 'medium-wide full-body shot, the same framing in every shot', angle: 'camera at her eye level, straight on, the same position in every shot',
    geste: 'the transition gesture', camera: 'static camera', cameraRe: /static|locked|fixed|still camera|does not move|doesn't move/i, objet: 'aucun',
  }))
  const cadrages = ARCS[n] ?? ARCS[5]
  const angles = melange(ANGLES2), cams = melange(CAMERA2)
  return cadrages.map((cadrage, k) => ({
    cadrage, angle: k === 0 ? 'camera at her eye level' : angles[k % angles.length],
    geste: 'the action of this beat of the story', camera: cams[k % cams.length][0], cameraRe: cams[k % cams.length][1],
    objet: /detail/.test(cadrage) ? 'objet' : k % 2 ? 'lieu' : 'aucun',
  }))
}
const ligneDe2 = (a, k) => `SHOT ${k + 1}: framing = ${a.cadrage}; camera = ${a.angle}; camera move = ${a.camera}; `
  + ({ aucun: 'object = none — her hands are free or rest on the setting', lieu: 'object = the object she really has at this moment of the story and at this spot (see OBJECTS), or one that belongs to this spot — she uses it', objet: 'object = the subject of the detail shot: the object she really has at this moment and at this spot (see OBJECTS) — her hands touch or hold it' })[a.objet]
const SCHEMA2 = (n, tenueParPlan = false) => ({
  type: 'object', required: ['situation', 'places', 'actions', 'story', 'hook', 'brief_objects', 'outfit', 'location', 'light', 'look', 'shots'],
  properties: {
    situation: { type: 'string' },
    places: { type: 'array', minItems: n, maxItems: n, items: { type: 'string' } },
    actions: { type: 'array', minItems: n, maxItems: n, items: { type: 'string' } },
    story: { type: 'string' }, hook: { type: 'string' },
    brief_objects: { type: 'array', items: { type: 'string' } }, outfit: { type: 'string' }, location: { type: 'string' }, light: { type: 'string' },
    look: { type: 'string', enum: Object.keys(LOOKS_REEL) },
    shots: { type: 'array', minItems: n, maxItems: n, items: {
      type: 'object', required: ['spot', 'action', 'support', 'object', ...(tenueParPlan ? ['outfit'] : []), 'motion', 'still'],
      properties: { spot: { type: 'string' }, action: { type: 'string' }, support: { type: 'string' }, object: { type: 'string' }, ...(tenueParPlan ? { outfit: { type: 'string' } } : {}), motion: { type: 'string' }, still: { type: 'string' } } } },
  },
})
function consigne2(nom, n, langue, format = 'journee') {
  const f = FORMATS[format] ?? FORMATS.journee
  const parcours = !f.cadrageFixe && (format === 'journee' || format === 'voyage')
  return `You are the director of a short vertical Instagram / TikTok reel (9:16): ${n} shots of ONE woman named ${nom}, a fictional adult content creator, filmed in one continuous session, that must make a viewer stop scrolling.
It is an everyday creator reel, not a movie: a walk on holiday, getting ready, trying outfits, a mirror check, sunbathing, a little dance, a playful pointless challenge — light, relatable, charming. Even when the brief sounds dramatic, keep this register: she lives the moment, she does not perform stunts.
THE FORMAT OF THIS REEL — follow it, it overrides any rule below that contradicts it:
${reglesFormat(format, n)}
Think in this order, one field after the other — each field builds on the ones before:
- "situation": one sentence — what this moment is for her, according to the brief (where she is in her life and her day, what she wants from this moment).
- "places": exactly ${n} places, in order, coherent with the brief, the situation and the format${parcours ? ', connected the way they would be in real life, all different' : ' (the format says whether the place changes or stays the same)'}. Invented for THIS brief.
- "actions": exactly ${n} actions, one per place, in the same order: what she really does there — a concrete action a viewer recognises, not "she enjoys the view". The first action hooks (an intriguing image), the middle ones build up, one is the strongest moment (an emotion, a reveal, a funny moment), the last one lands (a payoff, a smile, a look to camera).
Then:
- "story": two sentences: what happens, from the hook to the payoff. A real little story with a turn: something she wants, discovers, feels or does — not "a moment in her day".
- "hook": written now, from the story (see below).
Then one shot per place, in order: shot k is places[k] with actions[k]; for each shot write the video (motion) first, then its still (the first frame of that video). Rules for the steps:
${parcours ? `- A JOURNEY OF STEPS: each beat is a DIFFERENT step of her moment, in the order real life would have it, invented for THIS brief. Never two beats of the same situation (never the same kind of place or the same activity twice, unless the brief is only about that one activity — then each beat is a different stage of it). Each beat starts where the previous one ended, and the places connect the way they would in real life. Physical actions happen in their logical order (she climbs onto something BEFORE she stands on it; she sits down BEFORE she is seated).
` : `- Physical actions happen in their logical order; each shot starts where the previous one ended.
`}- If the brief already lists shots ("[Shot 1]", "Shot 2", timecodes), FOLLOW them: one beat per listed shot, same content, same order.
- The events of the brief happen IN ORDER across the beats.
Write ONCE for the whole reel: "outfit" (every garment with colour and fabric${f.tenueParPlan ? '; here: her outfit in shot 1 — each shot also has its own "outfit"' : ''}), "location" (the town, neighbourhood, beach or house where all the steps happen), "light" (the time of day and light quality; it follows the order of the steps and never jumps back — no night then day). They are added to every shot by the system: never repeat them in a shot.
"look": the film look that fits the mood, one of: ${Object.keys(LOOKS_REEL).join(', ')}.
"brief_objects": the objects the brief names for her, each with colour and material; [] if none.
OBJECTS FOLLOW REAL LIFE: an object appears only where it really is. Things that belong to a place stay there (a café's cup and saucer, a restaurant plate, a shop's clothes rail): she uses them while she is at that place and leaves them when she leaves — she never walks off with them. What she carries from one place to the next is only what is hers (her bag, her phone, a takeaway cup she bought, something she just bought). Once she holds something, she keeps it in the following shots until a shot shows her putting it down; nothing appears or vanishes between two shots.
${parcours ? 'PLACES FOLLOW REAL LIFE: she is at ONE café, ONE shop, ONE beach spot at a time, and a place she has left never comes back.' : ''}
Each shot follows its beat and its assignment line, and fills, in this order:
- spot: the EXACT place of this step, 4 to 12 words${parcours ? ', always moving forward through her moment. The last shot is the end of her journey — never back at the first place.' : ', as the format says.'}${f.tenueParPlan ? `
- outfit: her complete outfit in THIS shot, every garment and accessory with colour and fabric.` : ''}
- action: what her body does in this beat, specific to this story — never a generic filler (no "takes a deep breath", "tucks her hair", "looks around" unless the story needs it).
- support: what her body rests on or is against at this spot. "none" only in a close-up.
- object: ONLY the name of the assigned object, 2 to 8 words, with colour and material; "none" when the line says none. Never a brand.
- motion: the video of this shot, the next few seconds at real-time speed (never slow motion, never "slowly"), 12 to 25 words: ONE action that carries the beat, plus the assigned camera move, named as given.
- still: the FIRST FRAME of that video, 35 to 60 words, English: the exact instant the motion starts, not a random moment of the shot. Start with the assigned framing and camera angle, then the spot, her pose at that instant, her expression (an emotion that fits the beat: curious, amused, moved, determined, delighted…), her hands, the object and what she does with it. Only what is visible.
DESCRIBE ONLY WHAT IS INSIDE THE FRAME: in a close-up, her face, her hands and what they touch — never legs, feet or shoes. In a medium shot, nothing below the waist. The motion never names a body part that the still does not show, and the camera never moves to reveal one ("tilts up from her legs" makes the video model invent legs).
HER FACE IS IN EVERY SHOT, visible: front, three-quarter or profile with her eyes visible — never from behind, never her back to the camera, never her hands alone. In motion she never walks away from the camera.
Never describe her face, eye colour or body shape: the system adds her identity. She is the ONLY person in focus: nobody near her, nobody beside her, nobody she talks to — no waiter, vendor or friend in the shot (the image model would give any visible person her face). Other people may appear only far in the background, small and blurred, their faces not visible — passers-by out of focus.
In motion, never: putting on, taking off or adjusting clothing or glasses (an outfit change happens on the CUT between two shots, never inside a shot); getting in or out of a vehicle; picking up or handing over objects. What she holds stays in the same hand; no new object appears.
Vehicles stay on their road, rails or water. No text, signs, logos or lettering anywhere. Never name a real business or brand.
NO ANIMALS in any shot (no pigeons, birds, dogs, cats, horses): the video model freezes them or melts them. Every action is one she does alone with her own body and what she holds — never an action whose result depends on something else moving (throwing bread to birds, feeding an animal, catching something, splashing someone).
Everything is safe for work: fully clothed, no nudity, no lingerie, no real celebrities.
"hook": the on-screen opening text, 3 to 7 words, in ${langue}, specific to THIS story and intriguing (a question, a promise, a twist) — never generic ("a moment in her day", "my day", "vibes"), never a ranking or a claim about a place ("best café", "top spot").
Write everything except the hook in English.`
}
async function appeler2({ system, prompt, format, temperature, predire }) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 600000)),
    body: JSON.stringify({ model: MODELE_REALISATEUR, system, prompt, format, stream: false, think: false, keep_alive: '10m',
      options: { num_gpu: 0, num_ctx: 12288, num_predict: predire, temperature } }),
  })
  if (!res.ok) throw new Error(`le réalisateur (LLM) a refusé : HTTP ${res.status}`)
  return JSON.parse(String((await res.json()).response || '{}'))
}
/* Ce que le modèle vidéo rate ou que la vraie vie n'autorise pas, relevé en code :
   un animal (figé ou fondu), la vaisselle d'un café hors d'un café. */
const ANIMAUX = /\b(pigeons?|birds?|seagulls?|gulls?|doves?|ducks?|swans?|dogs?|puppy|puppies|cats?|kittens?|horses?|animals?|squirrels?)\b/i
const VAISSELLE = /\b(ceramic|porcelain|china)\b[^.]{0,30}\b(cups?|mugs?|saucers?|plates?)\b|\bsaucers?\b/i
const LIEU_CAFE = /\b(caf[eé]s?|coffee (shop|bar)|bistro|bar|restaurant|terrace|kitchen|table)\b/i
const JAMBES = /\b(legs?|knees?|feet|foot|toes|ankles?|thighs?)\b/i
function fautesVraieVie(x) {
  const f = [], txt = `${x?.still ?? ''} ${x?.motion ?? ''} ${x?.object ?? ''}`
  if (JAMBES.test(String(x?.motion ?? '')) && !JAMBES.test(String(x?.still ?? ''))) f.push('the motion names legs or feet that the still does not show: the video model invents them — keep the motion on what is in the frame')
  if (ANIMAUX.test(txt)) f.push('no animals in the shot: remove them and give her an action she does alone')
  if (VAISSELLE.test(txt) && !LIEU_CAFE.test(String(x?.spot ?? ''))) f.push('café crockery (ceramic cup, saucer, plate) outside a café: she cannot carry it away — use a takeaway paper cup or nothing')
  return f
}
export async function choisirFormat(brief) {
  try {
    const r = await appeler2({ system: consigneChoix(), prompt: `Brief: ${brief}`, format: SCHEMA_CHOIX, temperature: 0.1, predire: 40 })
    return FORMATS[r.format] ? r.format : 'journee'
  } catch { return 'journee' }
}
export async function rediger2({ brief, n, nom, langue, formatImpose }) {
  const format = FORMATS[formatImpose] ? formatImpose : await choisirFormat(brief)
  const aff = affectations2(n, format)
  const system = consigne2(nom, n, langue, format)
  const lignes = aff.map(ligneDe2)
  const out = await appeler2({ system, prompt: `Brief: ${brief}\nWrite the situation, the places, the actions, the story, the hook, then exactly one shot per line, in order:\n${lignes.join('\n')}`, format: SCHEMA2(n, FORMATS[format].tenueParPlan), temperature: 0.8, predire: 4500 })
  if (!Array.isArray(out.shots) || out.shots.length < 2) throw new Error('le réalisateur n’a pas rendu de plans exploitables')
  const shots = out.shots.slice(0, n)
  const objetsAvant = k => shots.slice(0, k).map(x => x.object).filter(o => !vide(o))
  const duBrief = (out.brief_objects ?? []).map(String).filter(x => x.trim()).slice(0, 4)
  // les contrôles du geste assigné ne s'appliquent pas : le geste vient du récit
  const controles = (x, k) => [...fautesPlan(x, aff[k], objetsAvant(k), duBrief).filter(f => !/does not show the action|the brief names|another shot already uses this object/.test(f)), ...fautesVraieVie(x)]
  let fautes = shots.map(controles)
  const aRefaire = fautes.map((f, k) => (f.length ? k : -1)).filter(k => k >= 0)
  if (aRefaire.length) {
    try {
      const u2 = `Brief: ${brief}\nThe story: ${out.story}\nThe reel: outfit = ${out.outfit}; location = ${out.location}; light = ${out.light}.\n`
        + `Rewrite ONLY these shots. Each one failed a check, given after it:\n`
        + aRefaire.map(k => `${lignes[k]} (place: ${out.places?.[k] ?? ''}; action: ${out.actions?.[k] ?? ''})\n  your version: ${JSON.stringify(shots[k])}\n  FAILED: ${fautes[k].join('; ')}`).join('\n')
      const refaits = (await appeler2({ system, prompt: u2, format: { type: 'object', required: ['shots'], properties: { shots: SCHEMA2(aRefaire.length, FORMATS[format].tenueParPlan).properties.shots } }, temperature: 0.5, predire: 2500 })).shots ?? []
      aRefaire.forEach((k, j) => { const neuf = refaits[j]; if (neuf && !t0Hit(`${neuf.still} ${neuf.motion}`) && controles(neuf, k).length < fautes[k].length) shots[k] = neuf })
    } catch (e) { console.warn(`réécriture des plans impossible — ${e.message || e}`) }
    fautes = shots.map(controles)
  }
  return { ...out, format, shots, affectations: aff, fautes, look: LOOKS_REEL[out.look] ?? LOOKS_REEL['natural-day'] }
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
  { code: 'foule', test: pl => /\b(people|crowd|passers?-?by|pedestrians|locals|tourists|vendors?|waiters?|waitress|customers|shoppers|friends?|couples?|a man|children|kids)\b/i.test(`${pl.still} ${pl.motion}`)
      && !/\b(blurr(ed|y)|out of focus|far (in the )?background|in the distance|distant)\b/i.test(`${pl.still} ${pl.motion}`),
    dit: 'other people near her: she is the only person in focus, others only far in the background, blurred, faces not visible', fr: 'd’autres personnes nettes dans l’image' },
  { code: 'horschamp', test: pl => JAMBES.test(pl.motion) && !JAMBES.test(pl.still),
    dit: 'the motion names legs or feet that the still does not show: keep the motion on what is in the frame', fr: 'le mouvement fait apparaître des jambes hors champ' },
  { code: 'animal', test: pl => ANIMAUX.test(`${pl.still} ${pl.motion}`),
    dit: 'no animals in the shot: the video model freezes them; give her an action she does alone', fr: 'un animal dans le plan (il reste figé)' },
  { code: 'long', test: pl => pl.motion.split(/\s+/).length > 32,
    dit: 'motion too long: 12 to 25 words', fr: 'mouvement trop long' },
]
// toute autre personne dans le cadre prend le visage du personnage : elle est seule à l'image
const SEULE = ' She is the only person in focus; any other people are far in the background, small and blurred, their faces not visible.'
export function controlerPlan(pl) { return CONTROLES_PLAN.filter(c => c.test(pl)) }

/* ---------- lancement ---------- */
export function realiser({ brief, n, duree, musique, langue, cle, personaId, voix, calerMusique, proprietaire, ecriture, format }) {
  const v2 = ecriture === 2
  const b = String(brief ?? '').trim().slice(0, v2 ? 1500 : 600)
  if (!b) throw new Error('écris un brief : le lieu, l’ambiance, ce qui se passe')
  if (t0Hit(b)) throw new Error('brief refusé (liste T0)')
  const p = persona(personaId)
  const id = `reel-${Date.now().toString(36)}`
  const data = {
    n: Math.min(6, Math.max(3, Number(n) || 5)),
    duree: Math.min(6, Math.max(3, Number(duree) || 4)),
    musique: typeof musique === 'string' && montage.cheminMusique(musique) ? musique : null,
    langue: langue === 'en' ? 'English' : 'French',
    voix: voixAcceptee(voix, proprietaire), narration: null, calerMusique: calerMusique === true,
    plans: [], erreur: null, ecriture: v2 ? 2 : 1,
    // un seul moteur pour toutes les photos du reel : Klein, qui part de la photo du plan
    // précédent (même tenue, mêmes accessoires, même décor) avec la LoRA Klein du personnage
    // ou sa photo de profil ; une graine commune tient le rendu
    moteurPhoto: 'klein', graine: Math.floor(Math.random() * 2 ** 31),
  }
  store.db.prepare('INSERT INTO reels (id, persona_id, brief, etat, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.id ?? null, b, 'redaction', JSON.stringify(data), Date.now(), Date.now())
  if (cle) cles.set(id, cle)
  void (async () => {
    try {
      const nom = String(p.name || 'the model').replace(/\s*\([^)]*\)\s*$/, '').trim()
      const r = v2 ? await rediger2({ brief: b, n: data.n, nom, langue: data.langue, formatImpose: format }) : await rediger({ brief: b, n: data.n, nom, langue: data.langue })
      if (!enCours(id)) return
      // « She wears A white linen shirt » : le LLM ouvre souvent sur une majuscule
      // … ou répète le sujet (« She wears Mila wears a white blouse »)
      const sujet = new RegExp(`^(?:${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|She)\\s+(?:wears|is wearing)\\s+`, 'i')
      const bas = x => String(x ?? '').trim().replace(sujet, '').replace(/^(A|An|The)\b/, m => m.toLowerCase()).replace(/[.\s]+$/, '')
      const lieu = String(r.location).trim().replace(/[.\s]+$/, ''), lumiere = String(r.light).trim().replace(/[.\s]+$/, '')
      const plans = r.shots.slice(0, data.n).map((s, k) => {
        const a = r.affectations[k]
        const fixe = v2 ? FORMATS[r.format]?.plan?.(k, data.n) : null
        if (fixe) s = { ...s, still: `${a.cadrage}, ${a.angle}. ${fixe.still}`, motion: fixe.motion }
        const pl = { still: String(s.still).trim(), motion: v2 ? `${geste(s.motion).replace(/\b(slowly|slow[- ]motion|in slow motion)\b\s*/gi, '')} Real-time speed, natural pace, no slow motion.` : geste(s.motion), action: String(s.action ?? '').trim(), objet: vide(s.object) ? null : String(s.object).trim(),
          cadrage: a.cadrage, photoJob: null, clipJob: null }
        if (r.fautes[k]?.length) {
          console.log(`[reel ${id}] plan ${k + 1} : ${r.fautes[k].join(' ; ')}`)
          // contrôle sur le mouvement écrit, pas sur la mention de vitesse ajoutée par le studio
          const reste = controlerPlan({ still: pl.still, motion: geste(s.motion) })
          if (reste.length) pl.avertissements = reste.map(c => c.fr)
        }
        if (v2) {
          // chaque plan à son endroit, le look de cinéma commun, l'optique selon le cadrage
          pl.endroit = String(s.spot ?? '').trim().replace(/[.\s]+$/, '')
          const tenue = FORMATS[r.format]?.tenueParPlan && String(s.outfit ?? '').trim() ? s.outfit : r.outfit
          pl.still = `${pl.still} She wears ${bas(tenueCadree(tenue, a.cadrage))}. ${pl.endroit ? `${pl.endroit}, ` : ''}${lieu}. ${lumiere}. ${r.look}, ${focaleDe(a.cadrage)}.${SEULE}${anatomieImage(b)}`
        } else pl.still = `${pl.still} She wears ${bas(tenueCadree(r.outfit, a.cadrage))}. ${lieu}. ${lumiere}.${SEULE}${anatomieImage(b)}`
        return pl
      })
      for (const pl of plans) {
        if (t0Hit(`${pl.still} ${pl.motion}`)) throw new Error('un plan rédigé contient un terme bloqué (liste T0) — relancer')
      }
      // la photo du plan 1 d'abord : c'est l'ancrage de la séance, les autres plans en sont tirés (cf. avancer).
      const j = enqueue(id, { id: `${id}-p1`, mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: data.moteurPhoto, seed: { mode: 'lock', value: data.graine },
        composedPositive: plans[0].still, userPrompt: plans[0].still, composedNegative: '', width: 768, height: 1344, batchId: `reel-${id}`, reelId: id })
      plans[0].photoJob = j.id
      if (!enCours(id)) { await cancelJob(j.id).catch(() => {}); return }
      let narration = null
      if (data.voix) { try { narration = await narrer({ brief: b, plans, nom, pas: data.duree - 0.35 }) } catch (e) { console.warn(`[reel ${id}] voix off : ${e.message || e}`) } }
      if (!enCours(id)) { await cancelJob(j.id).catch(() => {}); return }
      ecrire(id, 'photos', { histoire: r.story ?? null, format: r.format ?? null, narration, accroche: r.hook.trim().replace(/^[«"']+|[»"']+$/g, '').replace(/\.$/, '').trim(), tenue: r.outfit, lieu: r.location, lumiere: r.light, plans })
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

/* Les plans 2 à n sortent de la même séance que le plan 1 : sa photo leur sert de référence
   (même femme, même tenue, même lieu, même lumière), seuls le cadrage et le geste changent. */
const SOEUR = 'The same woman, in the same outfit, in the same place and under the same light as in the reference photo, a few seconds later in the same continuous shoot; the background, the colours and the time of day stay identical. '
/* 2e manière : les photos se suivent de proche en proche. Le plan k prend pour référence
   la photo du plan k-1 (où elle se trouve, le décor, la lumière) et celle du plan 1 (sa
   tenue) : la balade avance au lieu de revenir sans cesse au décor du premier plan. */
function lancerSuivante(r, a0) {
  const k = r.plans.findIndex(pl => !pl.photoJob)
  if (k < 1) return false
  const avant = r.plans[k - 1], s = etatJob(avant.photoJob)
  if (s === 'blocked' || s === 'cancelled' || s === 'absent') {
    ecrire(r.id, 'echec', { plans: r.plans, erreur: `la photo du plan ${k}, qui ancre la suite, a échoué — relancer le reel` })
    return true
  }
  if (s !== 'done') return false
  const aPrec = premierAsset(avant.photoJob)
  if (!aPrec) return false
  const pl = r.plans[k]
  /* transition de tenues, à partir du 3e plan : la photo du 2e plan (elle en l'air) est
     retouchée — seule la tenue change, la pose, le décor et la lumière restent identiques.
     Klein, lui, recopie les vêtements de sa référence. */
  if (FORMATS[r.format]?.tenueParPlan && k >= 2) {
    const base = premierAsset(r.plans[1].photoJob)
    if (!base) return false
    const tenue = (pl.still.match(/She wears ([^.]+)\./) ?? [])[1] ?? ''
    const consigne = `Change only her clothes: she now wears ${tenue}. Keep exactly the same woman, the same face and hair, the same pose in mid-air, the same body position, the same framing, the same background and the same light. No mirror and no reflection in the frame.`
    const j = enqueue(r.id, { id: `${r.id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: r.personaId, purpose: 'creative', op: 'edit', sourceImage: versInput(base),
      composedPositive: consigne, userPrompt: consigne, composedNegative: '', batchId: `reel-${r.id}`, reelId: r.id })
    pl.photoJob = j.id
    return true
  }
  const refs = k === 1 || FORMATS[r.format]?.tenueParPlan ? [versInput(k === 1 ? a0 : aPrec)] : [versInput(aPrec), versInput(a0)]
  const lien = k === 1 ? 'the reference photo' : 'the first reference photo (where she was a moment ago) — her outfit as in the second reference photo'
  // transition de tenues : même femme, même endroit, même cadrage — seule la tenue change
  const neuve = FORMATS[r.format]?.tenueParPlan
    ? `The same woman, at exactly the same spot, with the same framing, background and light as in the reference photo, a moment later — but she now wears a completely different outfit, described below; ignore the clothes of the reference photo. `
    : null
  const j = enqueue(r.id, { id: `${r.id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: r.personaId, purpose: 'creative', photoEngine: 'klein', seed: { mode: 'lock', value: r.graine }, references: refs,
    composedPositive: (neuve ?? `The same woman, in the same outfit, under exactly the same light and time of day as in ${lien}, a few moments later, having moved a few steps on: ${pl.endroit || 'the next spot of her walk'}. The surroundings continue those of the previous moment. `) + pl.still,
    userPrompt: pl.still, composedNegative: '', width: 768, height: 1344, batchId: `reel-${r.id}`, reelId: r.id })
  pl.photoJob = j.id
  return true
}
function lancerSoeurs(r) {
  const p0 = r.plans[0], attente = r.plans.filter(pl => !pl.photoJob)
  if (!attente.length) return false
  const s0 = etatJob(p0.photoJob)
  if (s0 === 'blocked' || s0 === 'cancelled' || s0 === 'absent') {
    ecrire(r.id, 'echec', { plans: r.plans, erreur: 'la photo du plan 1, qui ancre la séance, a échoué — relancer le reel' })
    return true
  }
  if (s0 !== 'done') return false
  const a0 = premierAsset(p0.photoJob)
  if (!a0) return false
  if (r.moteurPhoto === 'krea') {
    // Krea ne prend pas de référence : la continuité tient au texte (tenue, lieu, lumière répétés) et à la graine commune
    for (const pl of attente) {
      const k = r.plans.indexOf(pl)
      const j = enqueue(r.id, { id: `${r.id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: r.personaId, purpose: 'creative', photoEngine: 'krea', seed: { mode: 'lock', value: r.graine },
        composedPositive: pl.still, userPrompt: pl.still, composedNegative: '', width: 768, height: 1344, batchId: `reel-${r.id}`, reelId: r.id })
      pl.photoJob = j.id
    }
    return true
  }
  if (r.ecriture === 2) return lancerSuivante(r, a0)
  const ref = versInput(a0)
  for (const pl of attente) {
    const k = r.plans.indexOf(pl)
    const j = enqueue(r.id, { id: `${r.id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: r.personaId, purpose: 'creative', references: [ref],
      composedPositive: (r.ecriture === 2 && pl.endroit
        ? `The same woman, in the same outfit, in the same place and under exactly the same light and time of day as in the reference photo, a few moments later, a few steps away: ${pl.endroit}. The same surroundings stay in the background. `
        : SOEUR) + pl.still, userPrompt: pl.still, composedNegative: '', width: 768, height: 1344, batchId: `reel-${r.id}`, reelId: r.id })
    pl.photoJob = j.id
  }
  return true
}

function avancer(r) {
  if (r.etat === 'photos' || r.etat === 'clips') {
    let change = lancerSoeurs(r), rates = 0
    if (lireReel(r.id)?.etat === 'echec') return
    for (const pl of r.plans) {
      if (!pl.clipJob) {
        const s = etatJob(pl.photoJob)
        if (s === 'done') {
          const a = premierAsset(pl.photoJob)
          if (!a) { rates++; continue }
          pl.photoAsset = a.id
          const j = enqueue(r.id, { id: `${r.id}-c${r.plans.indexOf(pl) + 1}${pl.refait ? `-r${pl.refait}` : ''}`, mode: 'video', register: 'sfw', personaId: r.personaId, purpose: 'creative', videoEngine: 'ltx_hq', withAudio: true,
            sourceImage: versInput(a), composedPositive: `${pl.motion}. single continuous shot, no cuts, she is the only person in focus, anyone else stays far in the background, blurred.${anatomieVideo(r.brief)}`, userPrompt: pl.motion, composedNegative: '',
            videoSeconds: FORMATS[r.format]?.secondesClip ?? r.duree, videoFps: 24, videoAspect: '9:16', reelId: r.id })
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
  // le format fixe le rythme : plans courts et coupes franches pour une transition de tenues, etc. ; le dernier plan garde sa durée
  const f = FORMATS[r.format]
  const dureeDe = i => g ? Math.round(g.pas * 100) / 100
    : f?.dureePlan && i < prets.length - 1 ? Math.min(i === 0 && f.dureePremier ? f.dureePremier : f.dureePlan, f.secondesClip ?? r.duree)
    : f?.secondesClip ?? r.duree
  // pour un clip, le montage coupe à `fin` (la durée ne vaut que pour une photo)
  const clips = prets.map((p, i) => ({ assetId: p.clipAsset, debut: 0, fin: dureeDe(i), duree: dureeDe(i), texte: i === 0 ? r.accroche ?? '' : '',
    textePos: 'centre', transition: g || i === prets.length - 1 || f?.coupe === 'coupe' ? 'coupe' : 'fondu', transitionDuree: 0.35, crop: null }))
  const p2 = montage.ecrireProjet(proj.id, { data: { format: '9:16', cadrage: 'remplir', sonClips: !(voixOff || r.musique), volumeClips: 1,
    musique: r.musique ? { fichier: r.musique, boucle: !voixOff, volume: voixOff ? 1 : 0.85, fonduEntree: g ? 0 : 0.3, fonduSortie: 1.2, decalage: g && !voixOff ? g.debut : 0 } : null, clips } })
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
  // un montage interrompu (voix off en cours) repart de l'étape des clips, qui le relance
  for (const r of store.db.prepare(`SELECT id FROM reels WHERE etat = 'montage'`).all()) ecrire(r.id, 'clips', {})
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
