/* Sketch to video: the drawing, reduced to its lines, is a reference for FLUX.2 Klein which
   renders an image from it; LTX-2.5 then animates it. Reducing the drawing to its outlines
   prevents a real photo, sent instead of a sketch, from passing on a face. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue } from './jobs.js'
import { anatomieImage, anatomieVideo } from './anatomie.js'
import { persona, SANS_PERSONNAGE } from './persona.js'

const FORMATS = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] }
const suivis = new Map()
const PROPOSITIONS = 3

/* A person appears only if the description mentions one (or names the character); otherwise
   the sketch is a place, objects, animals. Without this rule the model puts the character
   into landscapes and reads "V"-shaped birds as legs. */
const HUMAIN = /\b(she|he|her|hers|his|him|they|them|woman|women|man|men|girl|girls|boy|boys|person|persons|people|someone|somebody|child|children|kid|kids|baby|babies|teen|teens|teenager|lady|ladies|guy|guys|hero|heroes|superhero|heroine|character|figure|crowd|couple|family|dancer|runner|player|rider|driver|worker|mum|mom|dad|mother|father|friend|friends|body|face|faces|hand|hands|selfie|portrait|human|humans|elle|il|femme|homme|fille|garçon|personne|enfant|bébé)\b/i
export function decritUnePersonne(scene, personaId) {
  if (HUMAIN.test(scene)) return true
  const p = personaId && personaId !== SANS_PERSONNAGE ? persona(personaId) : null
  // the full name, its first word ("Breezy" for "Breezy L.") and the trigger word
  const nom = String(p?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
  const noms = [nom, nom.split(/\s+/)[0], String(p?.trigger ?? '').toLowerCase()].filter(x => x.length >= 3)
  return noms.some(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(scene))
}
/* Common drawing conventions: what a simple line most often represents. */
const CONVENTIONS = 'Usual sketch conventions: a small V, M or wave shape in the sky is a flying bird; a circle with rays is the sun; a fluffy outline is a cloud or a tree crown; wavy horizontal lines are water; a long line across the frame is the horizon or the ground.'

export function lancerCroquis({ image, scene, mouvement, format, secondes, personaId }) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!m) throw new Error('dessin absent ou illisible')
  const s = String(scene ?? '').trim().slice(0, 400)
  if (!s) throw new Error('dis ce que représente le dessin')
  const [w, h] = FORMATS[format] ?? FORMATS['16:9']
  const cle = Date.now().toString(36), brut = path.join(CONFIG.comfyInput, `CRQ_${cle}_brut.png`), nom = `CRQ_${cle}.png`
  fs.writeFileSync(brut, Buffer.from(m[1], 'base64'))
  try {
    /* A real sketch (lines on white, very little grey) keeps its lines solid and thickened, since
       an edge detector turns each line into a double outline the model draws as tubes or railings.
       A halftone image (a photo sent instead of a drawing) is reduced to its outlines only, so no
       face is passed on. */
    const cadre = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,format=gray`
    const gris = execFileSync('ffmpeg', ['-v', 'error', '-i', brut, '-vf', 'scale=160:-2,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 })
    let milieu = 0
    for (const v of gris) if (v > 40 && v < 215) milieu++
    const demiTeintes = milieu / gris.length > 0.12
    const filtre = demiTeintes ? `${cadre},edgedetect=low=0.08:high=0.3,negate,format=rgb24` : `${cadre},lut=y='if(lt(val,200),0,255)',erosion,format=rgb24`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', brut, '-vf', filtre, '-frames:v', '1', path.join(CONFIG.comfyInput, nom)])
  } catch {
    throw new Error('dessin illisible : redessine puis relance')
  } finally {
    fs.rmSync(brut, { force: true })
  }
  store.noterInput(nom, 'croquis')
  /* Three images with different seeds; the user picks the one to animate. A sketch can be read
     several ways (a cape taken for a third leg); animating a bad image costs a whole clip,
     redoing it costs about twenty seconds. */
  const humain = decritUnePersonne(`${s} ${String(mouvement ?? '')}`, personaId)
  // what moves often names subjects of the drawing ("birds"): the image must show them too
  const bouge = String(mouvement ?? '').trim().slice(0, 300)
  const commun = `${s}.${bouge ? ` The clip made from this image will show: ${bouge} — so these subjects are already in the image.` : ''} A photorealistic cinematic photograph. The reference image is a rough hand-drawn sketch that only sets the composition: where each subject is, how big it is, its pose and the camera angle. The sketch lines are not objects: never draw lines, wires, tubes, frames or outlines from it — each shape becomes the real thing it stands for, fully detailed and textured. ${CONVENTIONS}`
  const positif = humain
    ? `${commun} A stick figure is a real person with natural anatomy.${anatomieImage(s)}`
    : `${commun} There are no people in this image: no person, no body, no limbs, no face — every shape is a place, an object, an animal or nature.`
  // with no person described, no character is injected (the text above excludes any human)
  const qui = humain ? personaId : SANS_PERSONNAGE
  const photoJobs = Array.from({ length: PROPOSITIONS }, () => enqueue({ mode: 'photo', register: 'sfw', personaId: qui, purpose: 'creative', photoEngine: 'klein', references: [nom],
    composedPositive: positif, userPrompt: s, composedNegative: '', width: w, height: h }).id)
  const id = `crq-${cle}`
  suivis.set(id, { id, photoJobs, choix: null, clipJob: null, mouvement: String(mouvement ?? '').trim().slice(0, 300) || 'gentle natural motion, slow cinematic camera move',
    scene: s, humain, format: format in FORMATS ? format : '16:9', secondes: Math.min(8, Math.max(3, Number(secondes) || 5)), personaId: qui, croquis: nom, debut: Date.now() })
  return etatCroquis(id)
}

const premierAsset = id => store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full')) || null

export function etatCroquis(id) {
  const c = suivis.get(id)
  if (!c) return null
  const etat = j => (j ? store.getJob(j)?.status ?? 'absent' : null)
  const photos = c.photoJobs.map(j => { const a = etat(j) === 'done' ? premierAsset(j) : null; return { job: j, statut: etat(j), assetId: a?.id ?? null, uri: a?.uri ?? null } })
  const statuts = photos.map(p => p.statut)
  const photo = statuts.some(x => x === 'done') ? 'done' : statuts.every(x => x === 'blocked' || x === 'absent' || x === 'failed') ? 'blocked' : 'rendering'
  return { id, photos, choix: c.choix, photo, clipJob: c.clipJob, clip: etat(c.clipJob), avecPersonnage: c.humain !== false }
}

/** Animates the image chosen among the sketch proposals. */
export function choisirCroquis(id, assetId) {
  const c = suivis.get(id)
  if (!c) throw new Error('croquis inconnu : relance-le')
  if (c.clipJob) throw new Error('ce croquis est déjà animé')
  const a = c.photoJobs.map(premierAsset).find(x => x && x.id === String(assetId ?? ''))
  if (!a) throw new Error('choisis l’une des images proposées')
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  const j = enqueue({ mode: 'video', register: 'sfw', personaId: c.personaId, purpose: 'creative', videoEngine: 'ltx_hq', sourceImage: nom,
    composedPositive: `${c.mouvement}. single continuous shot.${c.humain === false ? ' No people appear.' : anatomieVideo(`${c.scene ?? ''} ${c.mouvement}`)}`, userPrompt: c.mouvement, composedNegative: '', withAudio: true,
    videoSeconds: c.secondes, videoFps: 24, videoAspect: c.format, parentAssetId: a.id })
  c.choix = a.id; c.clipJob = j.id
  return etatCroquis(id)
}

// a sketch never chosen is dropped from tracking after a day
setInterval(() => { for (const c of suivis.values()) if (Date.now() - (c.debut ?? 0) > 86400_000) suivis.delete(c.id) }, 600_000).unref()
