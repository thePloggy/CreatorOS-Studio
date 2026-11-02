/* ============================================================
   Masters : un clip de la bibliothèque part en HLG, en ProRes ou en
   EXR linéaire ACEScg, ou garde son alpha en ProRes 4444. Tout se fait sur le
   CPU avec ffmpeg, hors de la file GPU, un fichier à la fois. Le clip SDR est
   étendu dans le conteneur HDR : aucune information n'est inventée.
   Les fichiers restent 24 h dans media/.master.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'

const executer = promisify(execFile)
const DOSSIER = path.join(CONFIG.mediaDir, '.master')
const DUREE_VIE_MS = 24 * 3600_000
const DISQUE_MAX = 30 * 1024 ** 3   // les plus anciens partent au-delà
const VERS_HLG = 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=linear:npl=203,format=gbrpf32le,zscale=p=bt2020:t=arib-std-b67:m=bt2020nc:r=tv'
// sRGB/Rec.709 linéaire → AP1 (ACEScg), matrice de Bradford D65 → D60
const VERS_ACESCG = 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=linear:npl=100,format=gbrpf32le,'
  + 'colorchannelmixer=rr=0.6131:rg=0.3395:rb=0.0474:gr=0.0702:gg=0.9164:gb=0.0134:br=0.0206:bg=0.1096:bb=0.8698'
const TAGS_HLG = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']

export const FORMATS = {
  'hlg-hevc': { ext: 'mp4', args: src => ['-i', src, '-vf', `${VERS_HLG},format=yuv420p10le`, '-c:v', 'libx265', '-crf', '14', '-preset', 'medium', '-tag:v', 'hvc1',
    '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error', ...TAGS_HLG, '-c:a', 'aac', '-b:a', '256k'] },
  'hlg-prores': { ext: 'mov', args: src => ['-i', src, '-vf', `${VERS_HLG},format=yuv422p10le`, '-c:v', 'prores_ks', '-profile:v', '3', ...TAGS_HLG, '-c:a', 'pcm_s16le'] },
  'prores-alpha': { ext: 'mov', alpha: true, args: src => ['-c:v', 'libvpx-vp9', '-i', src, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', '-c:a', 'pcm_s16le'] },
  exr: { ext: 'zip', exr: true },
}

const fichierDe = (assetId, format) => path.join(DOSSIER, `${assetId.replace(/[^\w-]/g, '_')}-${format}.${FORMATS[format].ext}`)
const enCours = new Map()   // chemin → { etat, erreur }
let chaine = Promise.resolve()

function nettoyer() {
  const fichiers = (fs.existsSync(DOSSIER) ? fs.readdirSync(DOSSIER) : []).map(f => { const p = path.join(DOSSIER, f), st = fs.statSync(p); return { p, t: st.mtimeMs, o: st.size } }).sort((a, b) => b.t - a.t)
  let total = 0
  for (const f of fichiers) {
    total += f.o
    if (Date.now() - f.t > DUREE_VIE_MS || total > DISQUE_MAX) fs.rmSync(f.p, { recursive: true, force: true })
  }
}

async function fabriquer(src, format, sortie) {
  const f = FORMATS[format], part = `${sortie}.part`
  if (f.exr) {
    fs.rmSync(part, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true })
    await executer('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-vf', VERS_ACESCG, '-c:v', 'exr', '-compression', '3', '-format', 'half', '-f', 'image2', path.join(part, 'frame_%05d.exr')], { timeout: 900_000 })
    await executer('zip', ['-q', '-0', '-r', '-j', sortie, part], { timeout: 300_000 })
    fs.rmSync(part, { recursive: true, force: true })
    return
  }
  await executer('ffmpeg', ['-loglevel', 'error', '-y', ...f.args(src), '-f', f.ext === 'mp4' ? 'mp4' : 'mov', part], { timeout: 900_000 })
  fs.renameSync(part, sortie)
}

/** Demande ou relit un master : { etat: 'pret' | 'en_cours' | 'echec', erreur? }. */
export function master(assetId, src, format, lancer = true) {
  const f = FORMATS[format]
  if (!f) throw new Error('format inconnu')
  if (f.alpha && !/\.webm$/i.test(src)) throw new Error('ce format demande un clip avec fond transparent')
  fs.mkdirSync(DOSSIER, { recursive: true })
  const sortie = fichierDe(assetId, format)
  if (fs.existsSync(sortie)) return { etat: 'pret', fichier: sortie }
  const suivi = enCours.get(sortie)
  if (suivi) { if (suivi.etat === 'echec' && lancer) enCours.delete(sortie); else return suivi }
  if (!lancer) return { etat: 'absent' }
  const e = { etat: 'en_cours' }
  enCours.set(sortie, e)
  chaine = chaine.then(async () => {
    nettoyer()
    try { await fabriquer(src, format, sortie); enCours.delete(sortie) }
    catch (err) { e.etat = 'echec'; e.erreur = String(err.stderr || err.message || err).slice(0, 300) }
  })
  return e
}
