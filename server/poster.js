/* ============================================================
   Video thumbnail (poster).

   iOS Safari does NOT show the first frame of a <video> until it plays:
   without a poster, a clip grid is a grid of black boxes. A JPEG extracted
   by ffmpeg, served by /api/poster/<file>, fixes that.

   Taken at 1 s rather than 0: frame 0 of an i2v IS the starting still and
   says nothing about the motion. Falls back to frame 0 if the clip is
   shorter. Generated at harvest, and on demand for existing files.

   Same for a photo: the original PNG is heavy to decode in a grid, so the
   grid uses this 540 px JPEG and the full view keeps the original.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'

const run = promisify(execFile)
const posterDir = () => path.join(CONFIG.mediaDir, '.posters')
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export const isVideoFile = f => VIDEO_EXT.has(path.extname(f).toLowerCase())

export function posterPath(filename) {
  return path.join(posterDir(), `${path.basename(filename)}.jpg`)
}

/** Returns the poster path, generating it if missing. null if the video
 *  does not exist or ffmpeg fails (the caller then serves 404: a missing
 *  thumbnail is better than a broken cached image). */
export async function ensurePoster(filename) {
  const src = path.join(CONFIG.mediaDir, path.basename(filename))
  const image = IMAGE_EXT.has(path.extname(src).toLowerCase())
  if ((!image && !isVideoFile(src)) || !fs.existsSync(src)) return null
  const out = posterPath(filename)
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out
  fs.mkdirSync(posterDir(), { recursive: true })
  const tmp = `${out}.tmp.jpg`
  for (const ss of image ? ['0'] : ['1', '0']) {
    try {
      await run('ffmpeg', ['-y', '-v', 'error', ...(image ? [] : ['-ss', ss]), '-i', src, '-frames:v', '1',
        '-vf', 'scale=540:-2', '-q:v', '4', tmp], { timeout: 30000 })
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) { fs.renameSync(tmp, out); return out }
    } catch { /* try frame 0 */ }
  }
  try { fs.unlinkSync(tmp) } catch { /* nothing */ }
  return null
}
