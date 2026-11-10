/* ============================================================
   Masters: a library clip exported as HLG, ProRes or linear ACEScg EXR, or
   ProRes 4444 keeping its alpha. Done on CPU with ffmpeg, outside the GPU
   queue, one file at a time. The SDR clip is placed in the HDR container
   without inventing information.
   The "extended" variants (hlg-etendu, exr-etendu) also go through ComfyUI's
   ImageSDRToHDR: inverse expansion (Lottes curve) giving highlights headroom
   above diffuse white. No model, a few seconds; both files come out of the
   same pass.
   Files are kept 24 h in media/.master.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as comfy from './comfy.js'

const executer = promisify(execFile)
const DOSSIER = path.join(CONFIG.mediaDir, '.master')
const DUREE_VIE_MS = 24 * 3600_000
const DISQUE_MAX = 30 * 1024 ** 3   // oldest files are removed above this
const VERS_HLG = 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=linear:npl=203,format=gbrpf32le,zscale=p=bt2020:t=arib-std-b67:m=bt2020nc:r=tv'
// linear sRGB/Rec.709 → AP1 (ACEScg), Bradford matrix D65 → D60
const VERS_ACESCG = 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=linear:npl=100,format=gbrpf32le,'
  + 'colorchannelmixer=rr=0.6131:rg=0.3395:rb=0.0474:gr=0.0702:gg=0.9164:gb=0.0134:br=0.0206:bg=0.1096:bb=0.8698'
const TAGS_HLG = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']

export const FORMATS = {
  'hlg-hevc': { ext: 'mp4', args: src => ['-i', src, '-vf', `${VERS_HLG},format=yuv420p10le`, '-c:v', 'libx265', '-crf', '14', '-preset', 'medium', '-tag:v', 'hvc1',
    '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error', ...TAGS_HLG, '-c:a', 'aac', '-b:a', '256k'] },
  'hlg-prores': { ext: 'mov', args: src => ['-i', src, '-vf', `${VERS_HLG},format=yuv422p10le`, '-c:v', 'prores_ks', '-profile:v', '3', ...TAGS_HLG, '-c:a', 'pcm_s16le'] },
  'prores-alpha': { ext: 'mov', alpha: true, args: src => ['-c:v', 'libvpx-vp9', '-i', src, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', '-c:a', 'pcm_s16le'] },
  exr: { ext: 'zip', exr: true },
  'hlg-etendu': { ext: 'mp4', etendu: true },
  'exr-etendu': { ext: 'zip', etendu: true },
}

const fichierDe = (assetId, format) => path.join(DOSSIER, `${assetId.replace(/[^\w-]/g, '_')}-${format}.${FORMATS[format].ext}`)
const enCours = new Map()   // path → { etat, erreur }
let chaine = Promise.resolve()

function nettoyer() {
  const fichiers = (fs.existsSync(DOSSIER) ? fs.readdirSync(DOSSIER) : []).map(f => { const p = path.join(DOSSIER, f), st = fs.statSync(p); return { p, t: st.mtimeMs, o: st.size } }).sort((a, b) => b.t - a.t)
  let total = 0
  for (const f of fichiers) {
    total += f.o
    if (Date.now() - f.t > DUREE_VIE_MS || total > DISQUE_MAX) fs.rmSync(f.p, { recursive: true, force: true })
  }
}

/* SDR → HDR expansion in ComfyUI: one pass, two outputs (10-bit HLG in HEVC,
   linear ACEScg EXR in zip). ComfyUI's HLG (10-bit H.264) is re-encoded to HEVC
   for players and editors, without color conversion. */
async function fabriquerEtendu(src, assetId) {
  const id = `hdr-${assetId.replace(/[^\w-]/g, '_')}-${Date.now().toString(36)}`
  const entree = `${id}.mp4`
  fs.copyFileSync(src, path.join(CONFIG.comfyInput, entree))
  const g = {
    1: { class_type: 'LoadVideo', inputs: { file: entree } },
    2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    3: { class_type: 'ImageSDRToHDR', inputs: { image: ['2', 0], algorithm: 'lottes', 'algorithm.target_luminance': 1000 } },
    4: { class_type: 'CreateVideo', inputs: { images: ['3', 0], fps: ['2', 2], audio: ['2', 1], bit_depth: 10, color_space: 'HDR' } },
    5: { class_type: 'SaveVideo', inputs: { video: ['4', 0], filename_prefix: `creatoros/masters/${id}/hlg`, format: 'auto', codec: 'auto' } },
    6: { class_type: 'ImageColorSpace', inputs: { image: ['3', 0], source: 'HDR', destination: 'linear ACEScg' } },
    7: { class_type: 'SaveImageAdvanced', inputs: { images: ['6', 0], filename_prefix: `creatoros/masters/${id}/exr/frame`, format: 'exr',
      'format.bit_depth': '16-bit float', 'format.input_color_space': 'linear ACEScg' } },
  }
  const sansSon = !(await aDuSon(src))
  if (sansSon) delete g[4].inputs.audio
  try {
    const pid = await comfy.submitPrompt(g, 'creatoros-masters')
    const h = await comfy.waitForPrompt(pid, { timeoutMs: 900_000 })
    if (!h.status?.completed) throw new Error('expansion HDR : ComfyUI a échoué')
    const dossier = path.join(CONFIG.comfyOutput, 'creatoros', 'masters', id)
    const hlg = fs.readdirSync(dossier).find(f => f.endsWith('.mp4'))
    if (!hlg) throw new Error('expansion HDR : pas de vidéo en sortie')
    const sHlg = fichierDe(assetId, 'hlg-etendu'), sExr = fichierDe(assetId, 'exr-etendu')
    await executer('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dossier, hlg), '-c:v', 'libx265', '-crf', '14', '-preset', 'medium',
      '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
      ...TAGS_HLG, ...(sansSon ? ['-an'] : ['-c:a', 'aac', '-b:a', '256k']), '-f', 'mp4', `${sHlg}.part`], { timeout: 900_000 })
    fs.renameSync(`${sHlg}.part`, sHlg)
    await executer('zip', ['-q', '-0', '-r', '-j', `${sExr}.part`, path.join(dossier, 'exr')], { timeout: 300_000 })
    fs.renameSync(`${sExr}.part`, sExr)
    fs.rmSync(dossier, { recursive: true, force: true })
  } finally { fs.rmSync(path.join(CONFIG.comfyInput, entree), { force: true }) }
}
async function aDuSon(src) {
  try { const { stdout } = await executer('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', src]); return stdout.trim().length > 0 }
  catch { return false }
}

async function fabriquer(src, format, sortie, assetId) {
  const f = FORMATS[format], part = `${sortie}.part`
  if (f.etendu) return fabriquerEtendu(src, assetId)
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

/** Requests or reads back a master: { etat: 'pret' | 'en_cours' | 'echec', erreur? }. */
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
    try {
      // both extended variants come out of the same pass: the other may already exist
      if (!fs.existsSync(sortie)) await fabriquer(src, format, sortie, assetId)
      enCours.delete(sortie)
    }
    catch (err) { e.etat = 'echec'; e.erreur = String(err.stderr || err.message || err).slice(0, 300) }
  })
  return e
}
