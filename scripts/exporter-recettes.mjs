// Exports as JSON (ComfyUI API format) the graphs the server builds in code
// instead of reading from workflows/: Re-shoot (two variants), talking avatar, 3D scene.
// Input files are placeholder names to replace (SOURCE.mp4, PHOTO.png, VOIX.wav).
//   node scripts/exporter-recettes.mjs
// The server is not started: data in a temp folder, ComfyUI never contacted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatoros-export-'))
process.env.CREATOROS_DATA = tmp
process.env.COMFY_URL = 'http://127.0.0.1:9'
const jobs = await import('../server/jobs.js')
const { CONFIG } = await import('../server/config.js')

const dossier = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'workflows')
const nettoyer = g => JSON.parse(JSON.stringify(g).split(CONFIG.mediaDir + path.sep).join(''))
// the description goes in workflows/README.md: an extra node would break the API format
const ecrire = (nom, g, note) => {
  fs.writeFileSync(path.join(dossier, nom), JSON.stringify(nettoyer(g), null, 1) + '\n')
  console.log('écrit', nom, '—', note)
}

const base = { id: 'exemple', seed: 42, composedPositive: '' }
ecrire('REF_reshoot_angle.json',
  jobs.grapheReshoot({ ...base, reshootSource: 'SOURCE.mp4', reshootImages: 97, reshootCamera: { az: 35, el: 0 } }, 704, 1280, true),
  'Re-shoot, plan fixe : MoGe-2 → CrossViewWarp (az 35°, él 0°) → LTX-2.5 22B + IC-LoRA CrossView-Warp v2, deux passes. Construit par grapheReshoot (server/jobs.js).')
ecrire('REF_reshoot_mouvement.json',
  jobs.grapheReshoot({ ...base, reshootSource: 'SOURCE.mp4', reshootImages: 97, reshootCamera: { cles: [{ f: 0, az: -35, el: 5 }, { f: -1, az: 35, el: 5 }] } }, 704, 1280, true),
  'Re-shoot, mouvement : la caméra va de az −35° à +35° sur toute la durée (images clés). Construit par grapheReshoot (server/jobs.js).')
ecrire('REF_parole.json',
  jobs.grapheParole({ ...base, sourceImage: 'PHOTO.png', paroleAudio: 'VOIX.wav', paroleBlocs: 1, paroleDuree: 5 }, 480, 832),
  'Avatar parlant : InfiniteTalk sur Wan 2.1 I2V 480p + lightx2v, une photo et une voix. Construit par grapheParole (server/jobs.js).')
ecrire('REF_scene3d.json', jobs.grapheScene('SOURCE.mp4', 352, 640, 'creatoros/scene_exemple'),
  'Scène 3D de la vue Re-shoot : MoGe-2 sur la 1re image, maillage texturé, GLB. Construit par grapheScene (server/jobs.js).')

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
