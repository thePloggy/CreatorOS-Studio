/* Croquis vers vidéo : le dessin, réduit à ses traits, sert de référence à FLUX.2 Klein qui
   en tire une image ; LTX-2.5 l'anime ensuite. Réduire le dessin à ses contours empêche
   qu'une vraie photo, envoyée à la place d'un croquis, transmette un visage. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue } from './jobs.js'
import { anatomieImage, anatomieVideo } from './anatomie.js'

const FORMATS = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] }
const suivis = new Map()

export function lancerCroquis({ image, scene, mouvement, format, secondes, personaId }) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!m) throw new Error('dessin absent ou illisible')
  const s = String(scene ?? '').trim().slice(0, 400)
  if (!s) throw new Error('dis ce que représente le dessin')
  const [w, h] = FORMATS[format] ?? FORMATS['16:9']
  const cle = Date.now().toString(36), brut = path.join(CONFIG.comfyInput, `CRQ_${cle}_brut.png`), nom = `CRQ_${cle}.png`
  fs.writeFileSync(brut, Buffer.from(m[1], 'base64'))
  try {
    /* Un vrai croquis (traits sur fond blanc, très peu de gris) garde ses traits pleins, épaissis :
       passé au détecteur de contours, chaque trait devenait un double liseré que le modèle
       dessinait en tubes ou en rambardes. Une image à demi-teintes (une photo envoyée à la place
       d'un dessin) n'est réduite qu'à ses contours, pour ne transmettre aucun visage. */
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
  const photo = enqueue({ mode: 'photo', register: 'sfw', personaId, purpose: 'creative', photoEngine: 'klein', references: [nom],
    composedPositive: `${s}. A photorealistic cinematic photograph. The reference image is a rough hand-drawn sketch that only sets the composition: where each subject is, how big it is, its pose and the camera angle. The sketch lines are not objects: never draw lines, wires, tubes, frames or outlines from it — each shape becomes the real thing it stands for (a box is a building, a stick figure is a real person with natural anatomy), fully detailed and textured.${anatomieImage(s)}`,
    userPrompt: s, composedNegative: '', width: w, height: h })
  const id = `crq-${cle}`
  suivis.set(id, { id, photoJob: photo.id, clipJob: null, mouvement: String(mouvement ?? '').trim().slice(0, 300) || 'gentle natural motion, slow cinematic camera move',
    scene: s, format: format in FORMATS ? format : '16:9', secondes: Math.min(8, Math.max(3, Number(secondes) || 5)), personaId, croquis: nom })
  return etatCroquis(id)
}

const premierAsset = id => store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full')) || null

export function etatCroquis(id) {
  const c = suivis.get(id)
  if (!c) return null
  const etat = j => (j ? store.getJob(j)?.status ?? 'absent' : null)
  return { id, photoJob: c.photoJob, photo: etat(c.photoJob), clipJob: c.clipJob, clip: etat(c.clipJob) }
}

function avancer(c) {
  if (c.clipJob) return
  const s = store.getJob(c.photoJob)?.status
  if (s !== 'done') { if (s === 'blocked') suivis.delete(c.id); return }
  const a = premierAsset(c.photoJob)
  if (!a) return
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  const j = enqueue({ mode: 'video', register: 'sfw', personaId: c.personaId, purpose: 'creative', videoEngine: 'ltx_hq', sourceImage: nom,
    composedPositive: `${c.mouvement}. single continuous shot.${anatomieVideo(`${c.scene ?? ''} ${c.mouvement}`)}`, userPrompt: c.mouvement, composedNegative: '', withAudio: true,
    videoSeconds: c.secondes, videoFps: 24, videoAspect: c.format, parentAssetId: a.id })
  c.clipJob = j.id
}

setInterval(() => { for (const c of suivis.values()) { try { avancer(c) } catch (e) { console.warn(`[croquis ${c.id}] ${e.message || e}`) } } }, 3000).unref()
