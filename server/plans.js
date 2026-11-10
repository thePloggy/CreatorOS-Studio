/* Shot splitting for a motion video.
   An EDITED source (several shots) rendered in one block smooths the cuts: a
   cut inside a context window blends two shots. Rendered shot by shot, each
   source cut stays a hard cut.
   This module detects cuts, writes one file per shot into ComfyUI's input/,
   and stitches the renders back when the last shot is delivered. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { CONFIG } from './config.js'

const run = (cmd, args, opts = {}) => new Promise((ok, ko) =>
  execFile(cmd, args, { timeout: 600_000, ...opts }, (e, out) => e ? ko(e) : ok(out)))

/* Shots shorter than this are not rendered separately: WanAnimate needs at least
   9 frames at 16 fps, and a half-second shot is usually a flash or fade
   detected as a cut. */
const PLAN_MIN_S = 1.0
/* Frozen padding frames added at the end of each shot: the chain rounds the length
   to 4n+1 and drops the first frame of the edit, so the render would come back
   short. The render thus covers the shot duration, and stitching trims to the exact length. */
const MARGE_S = 0.5
const L = 64, H = 112

const mediane = t => { const s = [...t].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0 }

/** Mean difference from one frame to the next, on a grayscale thumbnail. */
async function ecarts(fichier) {
  const brut = await run('ffmpeg', ['-v', 'error', '-i', fichier, '-vf', `scale=${L}:${H},format=gray`,
    '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 29 })
  const n = Math.floor(brut.length / (L * H)), d = []
  for (let i = 1; i < n; i++) {
    let s = 0
    const a = (i - 1) * L * H, b = i * L * H
    for (let k = 0; k < L * H; k++) s += Math.abs(brut[a + k] - brut[b + k])
    d.push(s / (L * H))
  }
  return { n, d }
}

/** Cuts of a video: first frame of each new shot, and frame rate.
 *  A cut is an isolated difference, strong in absolute terms AND relative to its
 *  neighbors: a fast pan gives strong but sustained differences, not a single peak. */
export async function detecterCoupes(fichier) {
  const info = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
    '-of', 'csv=p=0', fichier], { encoding: 'utf8' })).trim().split('/').map(Number)
  const fps = info[1] ? info[0] / info[1] : info[0]
  const { n, d } = await ecarts(fichier)
  const coupes = []
  let dernier = 0
  for (let i = 0; i < d.length; i++) {
    if (d[i] < 16) continue
    const voisins = [...d.slice(Math.max(0, i - 8), i), ...d.slice(i + 1, i + 9)]
    if (d[i] < 3 * Math.max(1, mediane(voisins))) continue
    if (voisins.some(v => v > d[i])) continue            // the peak, not its shoulder
    const image = i + 1
    if ((image - dernier) / fps < PLAN_MIN_S || (n - image) / fps < PLAN_MIN_S) continue
    coupes.push(image); dernier = image
  }
  return { coupes, images: n, fps }
}

/** Writes one file per shot into input/ and returns the list. A single-shot
 *  video returns `null`: nothing to split, the job runs as is. */
export async function decouper(driver) {
  const src = path.join(CONFIG.comfyInput, path.basename(driver))
  if (!fs.existsSync(src)) return null
  const { coupes, images, fps } = await detecterCoupes(src)
  if (!coupes.length) return null
  const bornes = [0, ...coupes, images], plans = []
  const base = path.basename(driver).replace(/\.\w+$/, '')
  for (let i = 0; i < bornes.length - 1; i++) {
    const fichier = `${base}_plan${String(i + 1).padStart(2, '0')}de${bornes.length - 1}.mp4`
    const cible = path.join(CONFIG.comfyInput, fichier)
    if (!fs.existsSync(cible)) {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf',
        `trim=start_frame=${bornes[i]}:end_frame=${bornes[i + 1]},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${MARGE_S}`,
        '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', cible + '.tmp.mp4'])
      fs.renameSync(cible + '.tmp.mp4', cible)
    }
    plans.push({ fichier, seconds: (bornes[i + 1] - bornes[i]) / fps })
  }
  return plans
}

const dureeDe = async f => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
  { encoding: 'utf8' })).trim())

/** Stitches rendered shots, each brought to the exact duration of its source shot
 *  (trimmed if too long, very slightly slowed if a few frames short).
 *  `plans`: [{ fichier (full path), seconds }] in edit order. */
export async function recoller(plans, sortie) {
  const args = ['-y', '-v', 'error'], f = []
  for (const [i, p] of plans.entries()) {
    args.push('-i', p.fichier)
    const reel = await dureeDe(p.fichier)
    const etire = Number.isFinite(reel) && reel > 0 && reel < p.seconds ? `setpts=PTS*${(p.seconds / reel).toFixed(5)},` : ''
    f.push(`[${i}:v]${etire}fps=32,scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,`
      + `trim=duration=${p.seconds.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`)
  }
  f.push(plans.map((_, i) => `[v${i}]`).join('') + `concat=n=${plans.length}:v=1:a=0[v]`)
  await run('ffmpeg', [...args, '-filter_complex', f.join(';'), '-map', '[v]', '-c:v', 'libx264', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sortie])
}
