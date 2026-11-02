/* ============================================================
   Vignette (poster) d'une vidéo.

   iOS Safari n'affiche PAS la première image d'un <video> tant qu'il n'est
   pas lu — sans poster, une grille de clips est une grille de noirs, et on
   ne sait pas à quoi correspond chaque rendu (Safari macOS est
   capricieux aussi). Un JPEG extrait par ffmpeg,
   servi par /api/poster/<fichier>, règle les deux.

   Prise à 1 s plutôt qu'à 0 : l'image 0 d'un i2v EST la still de départ,
   elle ne dit rien du mouvement. Repli sur l'image 0 si le clip est plus
   court. Généré à la récolte, et à la demande pour l'existant.

   Même chose pour une photo : le PNG d'origine pèse jusqu'à 3,8 Mo et ~8 Mo
   une fois décodé, et une bibliothèque parcourue monterait l'onglet à 1 Go.
   La grille prend ce JPEG de 540 px,
   la grande vue garde l'original.
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

/** Rend le chemin du poster, en le générant s'il manque. null si la vidéo
 *  n'existe pas ou si ffmpeg échoue (l'appelant sert alors 404 : une
 *  vignette absente vaut mieux qu'une image cassée en cache). */
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
    } catch { /* on tente l'image 0 */ }
  }
  try { fs.unlinkSync(tmp) } catch { /* rien */ }
  return null
}
