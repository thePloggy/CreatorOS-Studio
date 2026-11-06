/* ============================================================
   Danses — un personnage reprend une danse du catalogue.

   Le catalogue : des danses en capture de mouvement, rendues en vidéo par
   scripts/rendre_danse.py (un mannequin gris neutre, en pied, sur fond clair,
   caméra fixe, 9:16). Aucune personne réelle n'y apparaît : le motion control
   n'en lit que la pose. Chaque danse est une vidéo du dossier `danses/` des
   données ; elle est copiée dans input/ de ComfyUI comme vidéo de mouvement.

   Le visiteur choisit une danse et une photo de son personnage ; le motion
   control (Wan Animate) anime la photo sur la danse.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'

export const DOSSIER = path.join(CONFIG.dataDir, 'danses')
const APERCUS = path.join(DOSSIER, 'apercus')
/* danses écartées du catalogue public : trop suggestive pour une démo tout public (twerk), ou qui
   traversent tant la scène qu'avec la caméra fixe le corps devient minuscule et le motion control
   le perd (acrobaties au sol, grands déplacements) */
const ECARTEES = new Set(['dancing-twerk', 'breakdance-1990', 'dancing-1', 'salsa-dancing-1'])
const nomDriver = slug => `crs_danse_${slug}.mp4`
const titre = slug => slug.replace(/-(\d+)$/, ' $1').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase())

function duree(f) {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8', timeout: 20_000 }).trim()) || null }
  catch { return null }
}

/* Au démarrage : chaque danse rendue est copiée dans input/ (vidéo de mouvement, origine « danse »)
   et reçoit son aperçu (vidéo réduite et vignette) pour la galerie. */
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
      if (!fs.existsSync(mini)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-an', '-vf', 'scale=240:-2', '-c:v', 'libx264', '-crf', '30', '-movflags', '+faststart', mini], { timeout: 60_000 })
      if (!fs.existsSync(vignette)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.5', '-i', src, '-frames:v', '1', '-vf', 'scale=240:-2', vignette], { timeout: 30_000 })
      liste.push({ slug, titre: titre(slug), secondes: duree(src) })
    } catch (e) { console.warn(`[danses] ${slug} : ${String(e.message || e).slice(0, 160)}`) }
  }
  console.log(`[danses] ${liste.length} danses prêtes`)
  catalogue = liste
  return liste
}
let catalogue = []
// la version de l'aperçu (date du fichier) : une vignette refaite n'est pas resservie depuis le cache du navigateur
const version = slug => { try { return Math.round(fs.statSync(path.join(APERCUS, `${slug}.webp`)).mtimeMs / 1000) } catch { return 0 } }
export const listeDanses = () => catalogue.map(d => ({ ...d, v: version(d.slug) }))
/** Version d'une vignette de studio (studio-<id>.webp) : même principe que les danses. */
export const versionStudio = id => version(`studio-${id}`)
/* Le fichier FBX d'une danse : danses/fbx des données, ou le dossier donné par CREATOROS_DANSES_FBX. */
const DOSSIER_FBX = process.env.CREATOROS_DANSES_FBX || path.join(CONFIG.dataDir, 'danses', 'fbx')
const slugDe = nom => nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export function fbxDe(slug) {
  try { const f = fs.readdirSync(DOSSIER_FBX).find(x => x.toLowerCase().endsWith('.fbx') && slugDe(x.replace(/\.fbx$/i, '')) === slug); return f ? path.join(DOSSIER_FBX, f) : null }
  catch { return null }
}
export const driverDe = slug => catalogue.some(d => d.slug === slug) ? nomDriver(slug) : null
