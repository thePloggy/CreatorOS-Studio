/* ============================================================
   Dances: a character performs a dance from the catalog.

   Catalog: motion-capture dances rendered to video by
   scripts/rendre_danse.py (a neutral grey full-body mannequin on a light
   background, static camera, 9:16). No real person appears: motion control
   only reads the pose. Each dance is a video in the data `danses/` folder,
   copied into ComfyUI's input/ as the motion video.

   The visitor picks a dance and a photo of their character; motion control
   (Wan Animate) animates the photo on the dance.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'

export const DOSSIER = path.join(CONFIG.dataDir, 'danses')
const APERCUS = path.join(DOSSIER, 'apercus')
/* dances excluded from the public catalog: too suggestive for an all-audiences demo (twerk), or
   moving across the stage so much that with a static camera the body becomes tiny and motion
   control loses it (floor acrobatics, large moves) */
const ECARTEES = new Set(['dancing-twerk', 'breakdance-1990', 'dancing-1', 'salsa-dancing-1'])
const nomDriver = slug => `crs_danse_${slug}.mp4`
const titre = slug => slug.replace(/-(\d+)$/, ' $1').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase())

function duree(f) {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8', timeout: 20_000 }).trim()) || null }
  catch { return null }
}

/* At startup: each rendered dance is copied into input/ (motion video, origin "danse") and
   gets its preview (reduced video and thumbnail) for the gallery. */
export function preparerDanses() {
  if (!fs.existsSync(DOSSIER)) return []
  fs.mkdirSync(APERCUS, { recursive: true })
  const liste = []
  for (const f of fs.readdirSync(DOSSIER).filter(x => x.endsWith('.mp4')).sort()) {
    const slug = f.replace(/\.mp4$/, '')
    if (ECARTEES.has(slug)) continue
    const src = path.join(DOSSIER, f)
    const dst = path.join(CONFIG.comfyInput, nomDriver(slug))
    try {
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
      store.noterInput(nomDriver(slug), 'danse')
      const mini = path.join(APERCUS, `${slug}.mp4`), vignette = path.join(APERCUS, `${slug}.webp`)
      if (!fs.existsSync(mini)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-an', '-vf', 'scale=540:-2', '-c:v', 'libx264', '-crf', '27', '-preset', 'slow', '-movflags', '+faststart', mini], { timeout: 60_000 })
      if (!fs.existsSync(vignette)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.5', '-i', src, '-frames:v', '1', '-vf', 'scale=540:-2', '-quality', '86', vignette], { timeout: 30_000 })
      liste.push({ slug, titre: titre(slug), secondes: duree(src) })
    } catch (e) { console.warn(`[danses] ${slug} : ${String(e.message || e).slice(0, 160)}`) }
  }
  console.log(`[danses] ${liste.length} danses prêtes`)
  catalogue = liste
  return liste
}
let catalogue = []
// preview version (file date): a redone thumbnail is not served from the browser cache
const version = slug => { try { return Math.round(fs.statSync(path.join(APERCUS, `${slug}.webp`)).mtimeMs / 1000) } catch { return 0 } }
export const listeDanses = () => catalogue.map(d => ({ ...d, v: version(d.slug) }))
/** Version of a studio thumbnail (studio-<id>.webp): same principle as dances. */
export const versionStudio = id => version(`studio-${id}`)
/* A dance's FBX file: data danses/fbx, or the folder given by CREATOROS_DANSES_FBX. */
const DOSSIER_FBX = process.env.CREATOROS_DANSES_FBX || path.join(CONFIG.dataDir, 'danses', 'fbx')
const slugDe = nom => nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export function fbxDe(slug) {
  try { const f = fs.readdirSync(DOSSIER_FBX).find(x => x.toLowerCase().endsWith('.fbx') && slugDe(x.replace(/\.fbx$/i, '')) === slug); return f ? path.join(DOSSIER_FBX, f) : null }
  catch { return null }
}
export const driverDe = slug => catalogue.some(d => d.slug === slug) ? nomDriver(slug) : null
