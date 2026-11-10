/* Ad pack. The product comes from a photo (library or upload) or a description,
   which Krea 2 turns into a packshot. Then: staging and a poster with a tagline (Qwen-Image-Edit 2511),
   the character presenting the product in the chosen scene (FLUX.2 Klein, product as
   reference), and a clip where they present it to the camera (LTX-2.5). */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue } from './jobs.js'
import { t0Hit } from './t0.js'

const FORMATS = { '9:16': [768, 1344], '1:1': [1024, 1024], '16:9': [1344, 768], '4:5': [896, 1120] }
const suivis = new Map()

const vers = asset => {
  const src = path.join(CONFIG.mediaDir, path.basename(asset.filename ?? asset.uri))
  const nom = `crs_still_${path.basename(src)}`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}
// at the pack format: without dimensions, the edit would take those of the product photo
/* The edit follows its source proportions: the product photo is first placed at the pack format, centered on a
   background derived from itself (enlarged and blurred); edits repaint that background, the product stays. */
function auFormat(source, W, H) {
  const nom = source.replace(/\.[^.]+$/, '') + `_${W}x${H}.png`
  if (fs.existsSync(path.join(CONFIG.comfyInput, nom))) return nom
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(CONFIG.comfyInput, source), '-filter_complex',
    `[0]split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2[f];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[p];[f][p]overlay=(W-w)/2:(H-h)/2`,
    '-frames:v', '1', path.join(CONFIG.comfyInput, nom)], { timeout: 60_000 })
  store.noterInput(nom)
  return nom
}
// keep the product as is: without this clause, Qwen-Edit invents a label
const TEL_QUEL = 'Keep the product exactly as it is: do not add any label, text, letters or logo on it.'
const edition = (source, consigne, personaId, W, H) => enqueue({ mode: 'photo', register: 'sfw', personaId, purpose: 'creative', op: 'edit', sourceImage: source,
  composedPositive: consigne, userPrompt: consigne, composedNegative: '', width: W, height: H }).id
/* The poster tagline is set in real typography since Qwen-Image-Edit renders text poorly.
   The model leaves the top of the image empty, the server writes the text there, and the image is replaced in place. */
const POLICE = ['/usr/share/fonts/truetype/noto/NotoSerifDisplay-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'].find(f => fs.existsSync(f))
function coupeEquilibree(mots, budget) {
  const long = (a, b) => mots.slice(a, b).join(' ').length
  for (let n = 1; n <= 4; n++) {
    // cout[k][i]: best split of the first i words into k lines; the target is the average length
    const cible = mots.join(' ').length / n, cout = Array.from({ length: n + 1 }, () => Array(mots.length + 1).fill(Infinity)), dep = cout.map(r => r.map(() => 0))
    cout[0][0] = 0
    for (let k = 1; k <= n; k++) for (let i = 1; i <= mots.length; i++) for (let a = k - 1; a < i; a++) {
      const l = long(a, i); if (l > budget * 1.15 || cout[k - 1][a] === Infinity) continue
      const c = cout[k - 1][a] + (l - cible) ** 2
      if (c < cout[k][i]) { cout[k][i] = c; dep[k][i] = a }
    }
    if (cout[n][mots.length] === Infinity) continue
    const res = []; let i = mots.length
    for (let k = n; k > 0; k--) { const a = dep[k][i]; res.unshift(mots.slice(a, i).join(' ')); i = a }
    return res
  }
  return [mots.join(' ')]
}
function poserAccroche(p) {
  const a = premierMedia(p.jobs.affiche)
  if (!a || !POLICE) return
  const f = path.join(CONFIG.mediaDir, path.basename(a.filename)), tmp = `${f}.texte.png`
  const echap = t => t.replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%')
  // one or two lines, centered at the top of the image, with a soft shadow to read on any background
  // lines of at most ~26 chars in landscape, ~15 in portrait; font size bounded by width
  // actual dimensions of the rendered poster
  let W = p.W, H = p.H
  try { [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim().split(',').map(Number) } catch { /* pack format */ }
  // balanced lines: fewest lines that fit the width, split into similar lengths (no orphan word)
  const budget = W >= H ? 26 : 15, lignes = coupeEquilibree(p.slogan.split(/\s+/), budget)
  // dark text on a light image top (white sky), white otherwise
  let clair = false
  try {
    const y = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vf', 'crop=iw:ih*0.32:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
    clair = Number(/YAVG=([0-9.]+)/.exec(y)?.[1] ?? 0) > 150
  } catch { /* white by default */ }
  const encre = clair ? '0x1c1c20' : 'white', ombre = clair ? 'white@0.5' : 'black@0.45'
  // font size and line height in pixels, one derived from the other (size bounded by width in portrait)
  const L = lignes.slice(0, 3), corps = Math.round(Math.min(H * 0.062, W * 0.072)), pas = Math.round(corps * 1.28), haut = Math.round(H * 0.07)
  const filtres = L.map((l, i) => `drawtext=fontfile=${POLICE}:text='${echap(l)}':fontsize=${corps}:fontcolor=${encre}:shadowcolor=${ombre}:shadowx=0:shadowy=2:x=(w-tw)/2:y=${haut + i * pas}`)
    .concat([`drawtext=fontfile=${POLICE}:text='${echap(p.nom.split(',')[0])}':fontsize=${Math.round(corps * 0.48)}:fontcolor=${encre}:shadowcolor=${ombre}:shadowy=2:x=(w-tw)/2:y=${haut + L.length * pas + Math.round(corps * 0.3)}`])
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', f, '-vf', filtres.join(','), tmp], { timeout: 60_000 })
    fs.renameSync(tmp, f)
    fs.rmSync(path.join(CONFIG.mediaDir, '.posters', `${path.basename(f)}.jpg`), { force: true })
  } catch (e) { fs.rmSync(tmp, { force: true }); console.warn(`[pack ${p.id}] accroche non posée — ${e.message || e}`) }
}
const premierMedia = jobId => store.assetsOfJob(jobId).find(x => !String(x.id).endsWith('-full'))

export function lancerPack({ asset, fichier, description, produit, accroche, scene, format, personaId, admis }) {
  const desc = String(description ?? '').trim().slice(0, 200)
  const nom = String(produit ?? '').trim().slice(0, 60) || desc.slice(0, 60) || 'the product'
  const slogan = String(accroche ?? '').trim().slice(0, 50)
  const decor = String(scene ?? '').trim().slice(0, 200)
  if (t0Hit(`${nom} ${desc} ${slogan} ${decor}`)) throw new Error('terme bloqué dans le produit, la scène ou l’accroche')
  const [W, H] = FORMATS[format] ?? FORMATS['9:16']
  const p = { id: `pub-${Date.now().toString(36)}`, nom, slogan, decor, format: FORMATS[format] ? format : '9:16', W, H, personaId,
    source: null, genere: false, jobs: { produit: null, packshot: null, scene: null, affiche: null, personnage: null, clip: null } }
  if (asset) p.source = vers(asset)
  else if (fichier) {
    const f = path.basename(String(fichier))
    if (!admis(f) || !fs.existsSync(path.join(CONFIG.comfyInput, f))) throw new Error('photo du produit introuvable, ou dépôt refusé sur la démo publique')
    p.source = f
  } else if (desc) {
    // product alone, no person: the generated packshot is used directly as the source
    p.genere = true
    p.jobs.produit = enqueue({ mode: 'photo', register: 'sfw', personaId: 'aucun', purpose: 'creative', photoEngine: 'krea', width: 1024, height: 1024, composedNegative: '',
      composedPositive: `Professional e-commerce product photo of ${desc}, the product alone, centered on a seamless pure white background, soft even studio light, gentle contact shadow, sharp detail, no person, no people, no hands, no text`,
      userPrompt: `produit : ${desc}` }).id
  } else throw new Error('choisis une photo du produit ou décris-le')
  suivis.set(p.id, p)
  if (p.source) suite(p)
  return etatPack(p.id)
}

/* The rest, once the product source is ready. */
function suite(p) {
  let s = p.source
  try { s = auFormat(p.source, p.W, p.H) } catch (e) { console.warn(`[pack ${p.id}] source non mise au format — ${e.message || e}`) }
  if (!p.genere) p.jobs.packshot = edition(s, `Turn this into a clean e-commerce packshot of ${p.nom} only: product centred on a seamless pure white background, soft studio light, gentle contact shadow, sharp detail, no person, no text. ${TEL_QUEL}`, p.personaId, p.W, p.H)
  p.jobs.scene = edition(s, `Place ${p.nom} ${p.decor ? `in this setting: ${p.decor}` : 'in an elegant lifestyle scene on a marble counter with soft window light'}, shallow depth of field; no text, no person. ${TEL_QUEL}`, p.personaId, p.W, p.H)
  // the product name is not given here: with it, the model writes it on the poster despite "no text"
  p.jobs.affiche = edition(s, `Turn this into a clean modern advertising poster for this product: the product unchanged as the hero in the lower middle, ${p.decor ? `background inspired by ${p.decor}, ` : 'minimal harmonious background, '}the top third of the image left calm and empty for a headline, generous margins, absolutely no text, no letters, no logo anywhere. ${TEL_QUEL}`, p.personaId, p.W, p.H)
  p.jobs.personnage = enqueue({ mode: 'photo', register: 'sfw', personaId: p.personaId, purpose: 'creative', photoEngine: 'klein', references: [p.source], composedNegative: '', width: p.W, height: p.H,
    composedPositive: `Advertising photo of the main character holding ${p.nom} from the reference image in both hands at chest height and presenting it to the camera, ${p.decor || 'in a bright, clean lifestyle setting'}. The product is in the hands, sharp, exactly unchanged and clearly visible, natural smile, soft flattering light. ${TEL_QUEL}`,
    userPrompt: `présente ${p.nom}${p.decor ? ` : ${p.decor}` : ''}` }).id
}

export function etatPack(id) {
  const p = suivis.get(id)
  if (!p) return null
  return { id, jobs: p.jobs, etats: Object.fromEntries(Object.entries(p.jobs).map(([k, j]) => [k, j ? store.getJob(j)?.status ?? null : null])) }
}

setInterval(() => {
  for (const p of suivis.values()) {
    if (p.slogan && p.jobs.affiche && !p.accrochePosee && store.getJob(p.jobs.affiche)?.status === 'done') { p.accrochePosee = true; poserAccroche(p) }
    if (!p.source && p.jobs.produit && store.getJob(p.jobs.produit)?.status === 'done') {
      const a = premierMedia(p.jobs.produit)
      if (a) { p.source = vers(a); p.jobs.packshot = p.jobs.produit; suite(p) }
    }
    if (p.jobs.clip || !p.jobs.personnage || store.getJob(p.jobs.personnage)?.status !== 'done') continue
    const a = premierMedia(p.jobs.personnage)
    if (!a) continue
    p.jobs.clip = enqueue({ mode: 'video', register: 'sfw', personaId: p.personaId, purpose: 'creative', videoEngine: 'ltx_hq', sourceImage: vers(a), withAudio: false,
      // product held still: rotating it deforms it
      composedPositive: `The person smiles warmly at the camera, holding ${p.nom} steady in both hands at chest height; the product stays rigid, sharp and exactly unchanged. Natural real-time pace, gentle breathing and a soft smile. Slow push-in. single continuous shot`,
      userPrompt: 'clip pub', composedNegative: '', videoSeconds: 5, videoFps: 24, videoAspect: p.format === '4:5' ? '9:16' : p.format, parentAssetId: a.id }).id
  }
}, 4000).unref()
