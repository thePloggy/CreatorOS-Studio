/* ============================================================
   Montage: a small in-app reel editor. Library clips and photos are placed
   end to end, trimmed (start / end), joined by a hard cut, crossfade or dip
   to black, with one text per shot and a music track on top. Export is an
   ffmpeg render on CPU (the GPU stays with ComfyUI), delivered as a regular
   video asset (op 'montage').

   The project is a JSON stored in the database (table `montages`), per
   character like the library. It only references asset ids and music names:
   nothing is copied before export.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { ensurePoster } from './poster.js'

export const FORMATS = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] }
const FPS = 30
const MAX_CLIPS = 40
const MAX_DUREE = 180            // delivered seconds: a reel, not a film
export const MUSIQUES_DIR = path.join(CONFIG.dataDir, 'montage', 'musiques')
const TYPES_MUSIQUE = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }

/* ---------- projects ---------- */
store.db.exec(`CREATE TABLE IF NOT EXISTS montages (
  id TEXT PRIMARY KEY, persona_id TEXT, nom TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`)

export const projetVide = () => ({
  format: '9:16', cadrage: 'remplir', sonClips: true, volumeClips: 1,
  musique: null,                 // { fichier, volume, fonduEntree, fonduSortie }
  clips: [],                     // { assetId, debut, fin, duree?, texte, textePos, transition, transitionDuree }
})
const ligne = r => r && { id: r.id, nom: r.nom, personaId: r.persona_id, updatedAt: r.updated_at, data: JSON.parse(r.data) }
export const listerProjets = personaId => store.db.prepare(
  `SELECT id, nom, persona_id, updated_at, data FROM montages WHERE persona_id IS ? ORDER BY updated_at DESC`).all(personaId ?? null)
  .map(r => { const p = ligne(r); return { id: p.id, nom: p.nom, updatedAt: p.updatedAt, clips: p.data.clips?.length ?? 0 } })
export const lireProjet = id => ligne(store.db.prepare('SELECT * FROM montages WHERE id = ?').get(id))
export function creerProjet(nom, personaId) {
  const id = `mtg-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
  store.db.prepare('INSERT INTO montages (id, persona_id, nom, data, updated_at) VALUES (?,?,?,?,?)')
    .run(id, personaId ?? null, String(nom || 'Montage').trim().slice(0, 80) || 'Montage', JSON.stringify(projetVide()), Date.now())
  return lireProjet(id)
}
export function ecrireProjet(id, { nom, data }) {
  const p = lireProjet(id)
  if (!p) return null
  const propre = data === undefined ? p.data : nettoyer(data)
  store.db.prepare('UPDATE montages SET nom = ?, data = ?, updated_at = ? WHERE id = ?')
    .run(nom === undefined ? p.nom : (String(nom).trim().slice(0, 80) || p.nom), JSON.stringify(propre), Date.now(), id)
  return lireProjet(id)
}
export const supprimerProjet = id => store.db.prepare('DELETE FROM montages WHERE id = ?').run(id).changes > 0

/** Clamps a project coming from the browser to safe bounds (types, ranges). */
function nettoyer(d) {
  const n = (v, lo, hi, def) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def }
  const un = (v, liste, def) => liste.includes(v) ? v : def
  const m = d?.musique && typeof d.musique.fichier === 'string' && nomMusiqueValide(d.musique.fichier) ? {
    fichier: d.musique.fichier, volume: n(d.musique.volume, 0, 1.5, 0.8),
    fonduEntree: n(d.musique.fonduEntree, 0, 5, 0.5), fonduSortie: n(d.musique.fonduSortie, 0, 8, 1.5),
    decalage: n(d.musique.decalage, 0, 3600, 0),
    // a voice-over track does not loop: its end is silence, not the track start
    boucle: d.musique.boucle !== false,
  } : null
  return {
    format: un(d?.format, Object.keys(FORMATS), '9:16'),
    cadrage: un(d?.cadrage, ['remplir', 'flou'], 'remplir'),
    sonClips: d?.sonClips !== false,
    volumeClips: n(d?.volumeClips, 0, 1.5, 1),
    musique: m,
    clips: (Array.isArray(d?.clips) ? d.clips : []).slice(0, MAX_CLIPS).filter(c => typeof c?.assetId === 'string').map(c => ({
      assetId: c.assetId,
      debut: n(c.debut, 0, 3600, 0),
      fin: c.fin == null ? null : n(c.fin, 0, 3600, null),
      duree: n(c.duree, 0.5, 30, 3),                       // photos only
      texte: String(c.texte ?? '').slice(0, 220),
      textePos: un(c.textePos, ['haut', 'centre', 'bas'], 'bas'),
      transition: un(c.transition, ['coupe', 'fondu', 'noir'], 'coupe'),   // toward the NEXT shot
      transitionDuree: n(c.transitionDuree, 0.2, 1.5, 0.5),
      // crop within the source image, as fractions (0..1); absent = full image
      crop: c.crop && [c.crop.x, c.crop.y, c.crop.w, c.crop.h].every(v => Number.isFinite(Number(v))) ? (() => {
        const w = n(c.crop.w, 0.05, 1, 1), h = n(c.crop.h, 0.05, 1, 1)
        return { x: n(c.crop.x, 0, 1 - w, 0), y: n(c.crop.y, 0, 1 - h, 0), w, h }
      })() : null,
    })),
  }
}

/* ---------- music (studio folder, never ComfyUI's input folder) ---------- */
const nomMusiqueValide = nom => /^[\w.-]+$/.test(nom) && !nom.startsWith('.') && fs.existsSync(path.join(MUSIQUES_DIR, nom))
/** End of the audible part of a track: many tracks end with several seconds of
    silence, which would recur on every loop. */
const finsSonores = new Map()
export function finSonore(fichier) {
  if (finsSonores.has(fichier)) return finsSonores.get(fichier)
  let fin = null
  try {
    const duree = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fichier], { encoding: 'utf8' })) || 0
    const log = String(spawnSync('ffmpeg', ['-v', 'info', '-i', fichier, '-af', 'silencedetect=n=-45dB:d=0.4', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 }).stderr ?? '')
    fin = duree
    // silence running to the end of the file: its end is (roughly) the duration, or absent
    const debuts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map(x => Number(x[1]))
    const fins = [...log.matchAll(/silence_end: ([\d.]+)/g)].map(x => Number(x[1]))
    const dernierDebut = debuts.at(-1)
    if (dernierDebut > 1 && (debuts.length > fins.length || fins.at(-1) >= duree - 0.1)) fin = dernierDebut
  } catch { fin = null }
  finsSonores.set(fichier, fin)
  return fin
}
/** Filter that loops the audible part of a track from `depart`, over `longueur` seconds. */
export function boucleSonore(fichier, depart, longueur, boucle = true) {
  if (!boucle) return `aresample=48000,aformat=channel_layouts=stereo,atrim=${depart},asetpts=PTS-STARTPTS,apad=whole_dur=${longueur.toFixed(3)},atrim=0:${longueur.toFixed(3)}`
  const fin = finSonore(fichier)
  if (!fin || fin < 2) return `aresample=48000,aformat=channel_layouts=stereo,atrim=${depart}:${(depart + longueur).toFixed(3)},asetpts=PTS-STARTPTS`
  return `aresample=48000,aformat=channel_layouts=stereo,atrim=0:${fin.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=${Math.max(0, fin - 0.08).toFixed(3)}:d=0.08,`
    + `aloop=loop=-1:size=${Math.round(fin * 48000)},atrim=${depart}:${(depart + longueur).toFixed(3)},asetpts=PTS-STARTPTS`
}

// duration cached per file and mtime: listing does not rerun ffprobe each time
const durees = new Map()
function dureeEnCache(f, mtime) {
  const cle = `${f}:${mtime}`
  if (!durees.has(cle)) durees.set(cle, dureeDe(f))
  return durees.get(cle)
}
export function listerMusiques() {
  try {
    return fs.readdirSync(MUSIQUES_DIR).filter(f => !f.startsWith('.'))
      .map(f => { const st = fs.statSync(path.join(MUSIQUES_DIR, f)); return { nom: f, bytes: st.size, duree: dureeEnCache(path.join(MUSIQUES_DIR, f), st.mtimeMs) } })
  } catch { return [] }
}
export function deposerMusique(type, nomOrigine, buf) {
  const ext = TYPES_MUSIQUE[String(type).split(';')[0]]
  if (!ext) throw Object.assign(new Error('type non accepté (mp3, m4a, aac, wav, ogg, flac)'), { statusCode: 415 })
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('corps vide'), { statusCode: 400 })
  const stem = String(nomOrigine || 'musique').replace(/\.[^.]*$/, '').normalize('NFD').replace(/[^\w-]+/g, '_').slice(0, 40) || 'musique'
  fs.mkdirSync(MUSIQUES_DIR, { recursive: true })
  const nom = `${stem}_${Date.now().toString(36)}${ext}`
  fs.writeFileSync(path.join(MUSIQUES_DIR, nom), buf)
  if (!dureeDe(path.join(MUSIQUES_DIR, nom))) { fs.rmSync(path.join(MUSIQUES_DIR, nom), { force: true }); throw Object.assign(new Error('fichier audio illisible'), { statusCode: 422 }) }
  return { nom, duree: dureeDe(path.join(MUSIQUES_DIR, nom)) }
}
/** Removes a sound from the audio library: it goes to the folder's .corbeille, nothing is deleted. */
export function retirerMusique(nom) {
  if (!nomMusiqueValide(nom)) throw Object.assign(new Error('son inconnu'), { statusCode: 404 })
  const corbeille = path.join(MUSIQUES_DIR, '.corbeille')
  fs.mkdirSync(corbeille, { recursive: true })
  fs.renameSync(path.join(MUSIQUES_DIR, nom), path.join(corbeille, `${Date.now().toString(36)}_${nom}`))
  return { ok: true }
}
export const cheminMusique = nom => nomMusiqueValide(nom) ? path.join(MUSIQUES_DIR, nom) : null

/* ---------- export ---------- */
function dureeDe(f) {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) || 0 }
  catch { return 0 }
}
function aDuSon(f) {
  try { return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim() !== '' }
  catch { return false }
}
/** drawtext does not wrap lines: wrap here, to the frame width. */
function couper(texte, parLigne) {
  const lignes = []
  for (const para of texte.split(/\n/)) {
    let cur = ''
    for (const mot of para.split(/\s+/).filter(Boolean)) {
      if ((cur + ' ' + mot).trim().length > parLigne && cur) { lignes.push(cur); cur = mot } else cur = (cur + ' ' + mot).trim()
    }
    lignes.push(cur)
  }
  return lignes.join('\n').trim()
}

/** Edge frames for a generated transition: the last KEPT frame of shot A (its out point) and the first
 *  kept frame of shot B (its in point), with each shot's crop then the montage frame, as in export.
 *  Returns the two file names written to input/ and the format. */
export function cadresTransition({ format, a, b }) {
  const [W, H] = FORMATS[format] ?? FORMATS['9:16']
  const bord = (c, quelle) => {
    const asset = store.getAsset(String(c?.assetId ?? ''))
    if (!asset?.filename) throw new Error('plan introuvable dans la bibliothèque')
    const fichier = path.join(CONFIG.mediaDir, path.basename(asset.filename))
    if (!fs.existsSync(fichier)) throw new Error('fichier absent du disque')
    const video = asset.media_type === 'video'
    const total = video ? dureeDe(fichier) : 0
    const debut = video ? Math.min(Number(c.debut) || 0, Math.max(0, total - 0.2)) : 0
    const fin = video ? Math.min(total, c.fin ?? total) : 0
    // last kept frame: slightly before the cut, ffmpeg decodes nothing exactly at end of file
    const t = !video ? 0 : quelle === 'fin' ? Math.max(debut, fin - 1 / 24) : debut
    const k = c.crop
    const vf = [k && `crop=trunc(iw*${Number(k.w).toFixed(4)}/2)*2:trunc(ih*${Number(k.h).toFixed(4)}/2)*2:iw*${Number(k.x).toFixed(4)}:ih*${Number(k.y).toFixed(4)}`,
      `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`].filter(Boolean).join(',')
    const nom = `crs_trans_${quelle}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.png`
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...(video ? ['-ss', t.toFixed(3)] : []), '-i', fichier, '-frames:v', '1', '-vf', vf, path.join(CONFIG.comfyInput, nom)], { timeout: 60_000 })
    if (!fs.existsSync(path.join(CONFIG.comfyInput, nom))) throw new Error('image de bord non extraite')
    store.noterInput(nom)
    return nom
  }
  return { debut: bord(a, 'fin'), fin: bord(b, 'debut'), format: FORMATS[format] ? format : '9:16' }
}

/** Render plan: resolves assets, measures durations, computes the delivered
 *  length. Throws a readable error if something is missing. */
export function planDe(projet) {
  const d = projet.data
  if (!d.clips.length) throw new Error('montage vide : ajouter au moins un plan')
  const plans = d.clips.map((c, i) => {
    const a = store.getAsset(c.assetId)
    if (!a?.filename) throw new Error(`plan ${i + 1} : l’asset n’existe plus dans la bibliothèque`)
    const fichier = path.join(CONFIG.mediaDir, path.basename(a.filename))
    if (!fs.existsSync(fichier)) throw new Error(`plan ${i + 1} : fichier absent du disque`)
    const video = a.media_type === 'video'
    const total = video ? dureeDe(fichier) : 0
    const debut = video ? Math.min(c.debut, Math.max(0, total - 0.2)) : 0
    const fin = video ? Math.min(total, c.fin ?? total) : c.duree
    const duree = Math.max(0.2, fin - debut)
    return { ...c, fichier, video, debut, duree, son: video && d.sonClips && aDuSon(fichier) }
  })
  // a transition cannot take more than half of either shot
  let longueur = 0
  plans.forEach((p, i) => {
    const suiv = plans[i + 1]
    p.fondu = suiv && p.transition !== 'coupe' ? Math.min(p.transitionDuree, p.duree / 2, suiv.duree / 2) : 0
    longueur += p.duree - p.fondu
  })
  if (longueur > MAX_DUREE) throw new Error(`montage trop long (${longueur.toFixed(0)} s) : ${MAX_DUREE} s au plus`)
  return { plans, longueur, format: FORMATS[d.format], d }
}

function argsFfmpeg({ plans, longueur, format: [W, H], d }, sortie, tmp) {
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats']
  const f = []
  plans.forEach(p => {
    if (p.video) args.push('-ss', p.debut.toFixed(3), '-t', p.duree.toFixed(3), '-i', p.fichier)
    else args.push('-loop', '1', '-framerate', String(FPS), '-t', p.duree.toFixed(3), '-i', p.fichier)
  })
  const iMusique = d.musique ? plans.length : -1
  if (d.musique) args.push('-i', path.join(MUSIQUES_DIR, d.musique.fichier))

  const taille = Math.round(H * (H > W ? 0.042 : 0.058))
  const parLigne = Math.max(12, Math.floor(W / (taille * 0.56)))
  plans.forEach((p, i) => {
    const norme = `fps=${FPS},format=yuv420p,setsar=1,settb=AVTB,setpts=PTS-STARTPTS`
    // crop first: padding and blurred background start from the kept area
    const c = p.crop
    const entree = c ? `[${i}:v]crop=trunc(iw*${c.w.toFixed(4)}/2)*2:trunc(ih*${c.h.toFixed(4)}/2)*2:iw*${c.x.toFixed(4)}:ih*${c.y.toFixed(4)},` : `[${i}:v]`
    if (d.cadrage === 'flou') {
      f.push(`${entree}split[f${i}a][f${i}b]`,
        `[f${i}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.06[f${i}c]`,
        `[f${i}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[f${i}d]`,
        `[f${i}c][f${i}d]overlay=(W-w)/2:(H-h)/2,${norme}[p${i}]`)
    } else {
      f.push(`${entree}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${norme}[p${i}]`)
    }
    let v = `p${i}`
    if (p.texte.trim()) {
      /* One line = one drawtext: with a multiline file, ffmpeg 8 draws the
         newline as a missing glyph (a box). Text goes through a file: no
         escaping needed for drawtext. */
      const lignes = couper(p.texte.trim(), parLigne).split('\n')
      const pas = Math.round(taille * 1.28), bloc = pas * lignes.length
      const y0 = p.textePos === 'haut' ? Math.round(H * 0.11) : p.textePos === 'centre' ? Math.round((H - bloc) / 2) : Math.round(H * 0.80 - bloc)
      lignes.forEach((l, k) => {
        const tf = path.join(tmp, `texte_${i}_${k}.txt`)
        fs.writeFileSync(tf, l)
        const sortie = k === lignes.length - 1 ? `t${i}` : `t${i}_${k}`
        f.push(`[${v}]drawtext=textfile='${tf.replace(/'/g, "\\'")}':font='Sans\\:style=Bold':fontsize=${taille}:fontcolor=white`
          + `:borderw=${Math.max(2, Math.round(taille / 11))}:bordercolor=black@0.55:x=(w-text_w)/2:y=${y0 + k * pas}[${sortie}]`)
        v = sortie
      })
    }
    p.v = v
    // shot audio, or silence of the same length (audio fades follow the video)
    if (p.son) f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${p.duree.toFixed(3)},asetpts=PTS-STARTPTS,volume=${d.volumeClips}[a${i}]`)
    else f.push(`aevalsrc=0:c=stereo:s=48000:d=${p.duree.toFixed(3)}[a${i}]`)
  })

  // chain: cut = concat; fade / black = xfade + acrossfade of the same length
  let vc = plans[0].v, ac = 'a0', long = plans[0].duree
  for (let i = 1; i < plans.length; i++) {
    const prec = plans[i - 1], p = plans[i]
    const vo = `vc${i}`, ao = `ac${i}`
    if (prec.fondu > 0) {
      const tr = prec.transition === 'noir' ? 'fadeblack' : 'fade'
      f.push(`[${vc}][${p.v}]xfade=transition=${tr}:duration=${prec.fondu.toFixed(3)}:offset=${(long - prec.fondu).toFixed(3)}[${vo}]`,
        `[${ac}][a${i}]acrossfade=d=${prec.fondu.toFixed(3)}:c1=tri:c2=tri[${ao}]`)
      long += p.duree - prec.fondu
    } else {
      f.push(`[${vc}][${p.v}]concat=n=2:v=1:a=0[${vo}]`, `[${ac}][a${i}]concat=n=2:v=0:a=1[${ao}]`)
      long += p.duree
    }
    vc = vo; ac = ao
  }
  let aOut = ac
  if (d.musique) {
    const m = d.musique
    f.push(`[${iMusique}:a]${boucleSonore(path.join(MUSIQUES_DIR, m.fichier), Number(m.decalage) || 0, longueur, m.boucle !== false)},volume=${m.volume}`
      + (m.fonduEntree > 0 ? `,afade=t=in:d=${m.fonduEntree}` : '')
      + (m.fonduSortie > 0 ? `,afade=t=out:st=${Math.max(0, longueur - m.fonduSortie).toFixed(3)}:d=${m.fonduSortie}` : '') + '[mus]')
    // without shot audio, its chain is pure silence: mixed anyway so no output is left dangling.
    // Shot audio (voice, speech) sidechains a compressor on the music: it ducks 7 to 8 dB under a
    // normalized voice and comes back between sentences.
    f.push(`[${ac}]asplit=2[voix][cle]`,
      `[mus][cle]sidechaincompress=threshold=0.08:ratio=3:attack=15:release=350:makeup=1[musd]`,
      `[voix][musd]amix=inputs=2:duration=first:normalize=0[amx]`); aOut = 'amx'
  }
  const avecSon = d.sonClips || !!d.musique
  if (!avecSon) f.push(`[${ac}]anullsink`)
  // final level for short-video platforms: -14 LUFS integrated, peaks at -1 dBTP
  else { f.push(`[${aOut}]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[afin]`); aOut = 'afin' }
  args.push('-filter_complex', f.join(';'), '-map', `[${vc}]`)
  if (avecSon) args.push('-map', `[${aOut}]`, '-c:a', 'aac', '-b:a', '192k')
  else args.push('-an')
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', longueur.toFixed(3), '-movflags', '+faststart', sortie)
  return args
}

const progression = new Map()     // jobId → 0..1
export const progressionDe = jobId => progression.get(jobId)

/** Starts the export in the background; returns the job id immediately. */
export function exporter(projet) {
  const plan = planDe(projet)
  const jobId = `mtg-${Date.now().toString(36)}`
  const [W, H] = plan.format
  const job = {
    id: jobId, createdAt: Date.now(), status: 'rendering', personaId: projet.personaId, register: 'sfw',
    mode: 'video', purpose: 'creative', recipeId: 'montage@v1', workflowFile: null, seed: null,
    op: 'montage', videoEngine: null, userPrompt: projet.nom, composedPositive: null,
    montageId: projet.id, montage: plan.d, estimatedMs: Math.round(8000 + plan.longueur * 1500),
  }
  // everything that can fail happens BEFORE writing the job, otherwise it would stay "rendering"
  fs.mkdirSync(path.join(CONFIG.dataDir, 'montage'), { recursive: true })
  const tmp = fs.mkdtempSync(path.join(CONFIG.dataDir, 'montage', 'rendu-'))
  const nom = `${jobId}-0-${crypto.randomBytes(4).toString('hex')}.mp4`
  const sortie = path.join(CONFIG.mediaDir, nom)
  let args
  try { args = argsFfmpeg(plan, sortie, tmp) } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
  store.createJob(job)
  store.markStarted(jobId, null)
  progression.set(jobId, 0)
  const t0 = Date.now()
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  ff.stdout.on('data', b => {
    const m = /out_time_us=(\d+)/.exec(String(b))
    if (m) progression.set(jobId, Math.min(0.99, Number(m[1]) / 1e6 / plan.longueur))
  })
  ff.stderr.on('data', b => { err = (err + b).slice(-4000) })
  ff.on('close', code => {
    fs.rmSync(tmp, { recursive: true, force: true })
    progression.delete(jobId)
    if (code !== 0 || !fs.existsSync(sortie)) {
      fs.rmSync(sortie, { force: true })
      store.markFailed(jobId, Date.now() - t0, `montage : ffmpeg a échoué — ${err.trim().split('\n').slice(-3).join(' / ').slice(0, 600)}`)
      console.error(`[montage ${jobId}] échec : ${err.slice(-1500)}`)
      return
    }
    const applied = [
      `montage de ${plan.plans.length} plan(s), ${plan.longueur.toFixed(1)} s, ${W}×${H} à ${FPS} i/s, cadrage ${plan.d.cadrage}`,
      ...plan.plans.map((p, i) => `plan ${i + 1} : ${p.assetId}${p.video ? ` de ${p.debut.toFixed(2)} s à ${(p.debut + p.duree).toFixed(2)} s` : ` (photo, ${p.duree.toFixed(1)} s)`}`
        + (p.crop ? ` · recadré ${Math.round(p.crop.w * 100)}×${Math.round(p.crop.h * 100)} % en ${Math.round(p.crop.x * 100)},${Math.round(p.crop.y * 100)}` : '')
        + (p.texte.trim() ? ` · texte ${p.textePos}` : '') + (plan.plans[i + 1] ? ` · ${p.fondu > 0 ? `${p.transition} ${p.fondu.toFixed(2)} s` : 'coupe'}` : '')),
      ...(plan.d.musique ? [`musique « ${plan.d.musique.fichier} » à ${Math.round(plan.d.musique.volume * 100)} %`] : []),
      plan.d.sonClips ? `son des plans gardé (${Math.round(plan.d.volumeClips * 100)} %)` : 'son des plans coupé',
    ]
    store.createAsset(
      { id: `a-${jobId}-0`, jobId, createdAt: Date.now(), mediaType: 'video', uri: `/media/${nom}`, filename: nom,
        bytes: fs.statSync(sortie).size, width: W, height: H, aspect: plan.d.format, register: 'sfw', op: 'montage', videoEngine: null },
      { recipeId: 'montage@v1', workflowFile: null, comfyPromptId: null, seed: null, composedPositive: null, composedNegative: null,
        userPrompt: projet.nom, userDirectives: null, selections: null, resolvedText: null, identityPreamble: null, registerClause: null,
        sourceImage: null, extraLoras: null, injections: { applied, skipped: [] }, workflowJson: null })
    void ensurePoster(nom).catch(() => {})
    store.markFinished(jobId, Date.now() - t0)
    console.log(`[montage ${jobId}] livré : ${nom} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
  })
  return { jobId, longueur: plan.longueur }
}
