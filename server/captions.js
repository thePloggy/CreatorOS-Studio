/* ============================================================
   Captions des reels — le texte gravé à l'écran.

   L'opérateur produit, trie, range ses vidéos dans un dossier, sélectionne
   tout, lance les captions. Rien n'est écrit à la génération : la plupart
   des vidéos finissent au déchet.

   Pour chaque vidéo :
   1. trois images (début, milieu, fin) accolées en UNE image → un seul appel
      VLM par vidéo (le VLM lit très bien une planche) ;
   2. le rédacteur reçoit la description, l'intention du prompt vidéo et les
      captions déjà prises (livrées + écrites dans le même lot), avec la
      consigne `caption.txt` du dossier des textes ;
   3. il propose 5 captions ; le code garde celles qui tiennent les règles
      dures (longueur, pas d'emoji ni de lien) et pose la première dans le
      champ, les autres restent proposées.

   Le lot entier prend la carte une fois (blocOllama, attendreCarte).

   Livraison : les vidéos captionnées sont gravées (server/graver.py) et
   écrites dans <données>/exports/<nom du dossier>/ sous un nom numéroté
   (reel-0001, reel-0002…). Le compteur vit dans <données>/reels_compteur.json
   et les captions livrées rejoignent <données>/captions_publiees.txt.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { blocOllama, fetchOllama } from './gpu.js'
import * as prompts from './prompts.js'
import { t0Hit } from './t0.js'

const run = promisify(execFile)
const PUBLIEES = path.join(CONFIG.dataDir, 'captions_publiees.txt')
const COMPTEUR = path.join(CONFIG.dataDir, 'reels_compteur.json')
const GRAVEUR = path.join(import.meta.dirname, 'graver.py')
const REDACTEUR = process.env.CREATOROS_LLM_CAPTION || CONFIG.composerModels.sfw

/* Une tâche à la fois (écriture OU livraison) : l'état est lu par le front. */
let tache = null
export const etat = () => tache

const fichierDe = a => path.join(CONFIG.mediaDir, path.basename(a.uri))

/* ---------- 1. ce que montre le clip ---------- */
async function planche(video) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])
  const d = Number(stdout) || 6
  const sortie = path.join(os.tmpdir(), `caption-${process.pid}-${Date.now()}.jpg`)
  const ts = [0.1, 0.5, 0.9].map(f => (d * f).toFixed(2))
  await run('ffmpeg', ['-v', 'error', '-y',
    ...ts.flatMap(t => ['-ss', t, '-i', video]),
    '-filter_complex', '[0:v]scale=-2:640[a];[1:v]scale=-2:640[b];[2:v]scale=-2:640[c];[a][b][c]hstack=inputs=3',
    '-frames:v', '1', '-q:v', '3', sortie])
  const b64 = fs.readFileSync(sortie).toString('base64')
  fs.unlinkSync(sortie)
  return b64
}

async function ollama(corps) {
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({ stream: false, think: false, keep_alive: '10m', ...corps }),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status} (${corps.model})`)
  return String((await res.json()).response || '').trim()
}

async function decrire(a) {
  const images = [await planche(fichierDe(a))]
  return ollama({ model: CONFIG.visionDescribeModel, images, options: { temperature: 0, num_predict: 160 },
    prompt: 'These are three frames (start, middle, end) of one short vertical video of the same person. '
      + 'In two short sentences, state literally: where they are, what they are wearing, what they do over the '
      + 'clip, and the time of day. No preamble.' })
}

/* Le prompt vidéo H3 est un script technique (plans, minutages) : on n'en
   garde que le texte, raccourci — il dit l'INTENTION du clip, que la planche
   ne montre pas toujours (un geste qui commence à peine). */
function intention(a) {
  const t = String(a.initial_brief || a.user_prompt || a.composed_positive || '')
    .replace(/\[[^\]]*\]/g, ' ').replace(/integrated_multimodal_description:/g, ' ').replace(/\s+/g, ' ').trim()
  return t.slice(0, 900)
}

/* ---------- 2. rédaction ---------- */
const SCHEMA = {
  type: 'object', required: ['options'],
  properties: { options: { type: 'array', minItems: 5, maxItems: 5, items: {
    type: 'object', required: ['caption', 'family'],
    properties: { caption: { type: 'string' }, family: { type: 'string' } } } } },
}

/** Règles dures vérifiées en code : ce qu'un paragraphe demande, le modèle
 *  l'oublie parfois ; ce que le code contrôle tient toujours. */
export function propre(brut) {
  const c = String(brut || '').trim().replace(/^["'“]+|["'”]+$/g, '').replace(/\s+/g, ' ')
  if (/\p{Extended_Pictographic}|#|@|https?:/u.test(c)) return null
  if (c.length > 60 || c.split(' ').length < 3 || c.split(' ').length > 12) return null
  return c
}

/* Une caption presque recopiée (« the water's perfect... coming in? » après
   « the water's warm... coming in? ») n'est pas une nouvelle caption. On
   compare les mots porteurs : deux en commun sur trois, c'est la même phrase.
   Les petits mots et les verbes de gabarit (too… for, come join…, share…)
   ne comptent pas. */
const VIDES = new Set(('a an the my your me you I i it is do does can will to with for in on of and or this that be are just so '
  + 'too come join want take walk share watch keep').split(' '))
const porteurs = c => new Set(c.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/)
  .map(m => m.replace(/'s$/, '')).filter(m => m && !VIDES.has(m)))
export function tropProche(c, recentes) {
  const a = porteurs(c)
  if (a.size === 0) return false
  return recentes.some(r => {
    const b = porteurs(r)
    if (!b.size) return false
    let n = 0; for (const m of a) if (b.has(m)) n++
    return n / Math.min(a.size, b.size) >= 0.66 && n >= 2
  })
}

export function captionsPubliees() {
  try {
    return fs.readFileSync(PUBLIEES, 'utf8').split('\n').filter(l => l.includes('|') && !l.startsWith('#'))
      .map(l => l.split('|').slice(1).join('|').trim())
  } catch { return [] }
}

async function rediger(a, description, recentes) {
  const dernieres = recentes.slice(-3).map(c => c.split(' ')[0])
  const prompt = `brief: ${description.replace(/\s+/g, ' ')}\n`
    + (intention(a) ? `director's intent for the clip (for context only, do not quote it): ${intention(a)}\n` : '')
    + `\nrecently used captions (do not reuse):\n${recentes.slice(-60).join('\n')}\n`
    + `first words of the last three: ${dernieres.join(', ') || '—'}\n`
  const brut = await ollama({ model: REDACTEUR, system: prompts.readPrompt('caption.txt'), prompt, format: SCHEMA,
    options: { temperature: 0.8, num_ctx: 8192, num_predict: 600 } })
  const deja = new Set(recentes.map(c => c.toLowerCase()))
  const options = []
  for (const o of JSON.parse(brut).options ?? []) {
    const c = propre(o.caption)
    if (c && !t0Hit(c) && !deja.has(c.toLowerCase()) && !tropProche(c, recentes) && !options.some(x => x.caption === c)) options.push({ caption: c, family: String(o.family || '') })
  }
  return options
}

/** Écrit les captions des assets donnés (vidéos). `tout` : réécrit aussi
 *  celles déjà remplies — sinon on ne touche jamais une caption existante,
 *  retouchée à la main ou non. */
export function lancerEcriture(ids, { tout = false } = {}) {
  if (tache && !tache.fini) throw new Error(`une tâche est déjà en cours (${tache.type})`)
  const cibles = ids.map(store.getAsset).filter(a => a && a.media_type === 'video' && (tout || !a.caption))
  tache = { type: 'captions', total: cibles.length, faits: 0, erreurs: [], fini: cibles.length === 0, debut: Date.now() }
  if (!cibles.length) return tache
  const t = tache
  void blocOllama(async () => {
    /* Déjà prises : les publiées, puis celles des autres vidéos du lot. */
    const recentes = [...captionsPubliees(),
      ...ids.map(store.getAsset).filter(a => a?.caption && !cibles.some(c => c.id === a.id)).map(a => a.caption)]
    for (const a of cibles) {
      t.enCours = a.id
      try {
        const desc = await decrire(a)
        let options = await rediger(a, desc || '', recentes)
        if (!options.length) options = await rediger(a, desc || '', recentes)   // une relance, pas plus
        if (!options.length) throw new Error('aucune proposition ne tient les règles')
        store.setCaptionProposee(a.id, options[0].caption, options)
        recentes.push(options[0].caption)
      } catch (e) { t.erreurs.push({ id: a.id, erreur: String(e.message || e) }) }
      t.faits++
    }
  }, { attendreCarte: true }).catch(e => t.erreurs.push({ id: null, erreur: String(e.message || e) }))
    .finally(() => { t.fini = true; t.enCours = null; t.duree = Date.now() - t.debut })
  return tache
}

/* ---------- 3. livraison ---------- */
export function prochainReel() {
  try { return JSON.parse(fs.readFileSync(COMPTEUR, 'utf8')).prochain } catch { return 'reel-0001' }
}
/** reel-0001 → reel-0002 : le dernier nombre du nom est incrémenté, préfixe
 *  et largeur conservés. */
export function reelSuivant(nom) {
  const m = /^([\w-]*?)(\d+)$/.exec(String(nom))
  if (!m) throw new Error(`nom de reel invalide : ${nom} (attendu un nom finissant par un nombre, ex. reel-0001)`)
  return `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}`
}

/** Grave et livre, dans l'ordre donné. Refuse s'il manque une caption :
 *  une vidéo livrée sans texte serait publiée telle quelle. */
export function lancerLivraison(ids, { debut, dossier } = {}) {
  if (tache && !tache.fini) throw new Error(`une tâche est déjà en cours (${tache.type})`)
  const assets = ids.map(store.getAsset).filter(a => a && a.media_type === 'video')
  const sans = assets.filter(a => !a.caption?.trim())
  if (sans.length) throw new Error(`${sans.length} vidéo(s) sans caption — à écrire avant de livrer : `
    + sans.slice(0, 6).map(a => `#${a.job_id}`).join(', ') + (sans.length > 6 ? '…' : ''))
  if (!assets.length) throw new Error('aucune vidéo dans la sélection')
  let nom = debut || prochainReel()
  reelSuivant(nom)   // valide le format avant de commencer
  const sortie = path.join(CONFIG.exportsDir, String(dossier || 'Reels').replace(/[/\\]|\.\./g, '-'))
  fs.mkdirSync(sortie, { recursive: true })
  tache = { type: 'livraison', total: assets.length, faits: 0, erreurs: [], fini: false, debut: Date.now(), dossier: sortie, livres: [] }
  const t = tache
  void (async () => {
    for (const a of assets) {
      t.enCours = a.id
      try {
        const dst = path.join(sortie, `${nom}.mp4`)
        const { stdout } = await run(CONFIG.comfyPython, [GRAVEUR, fichierDe(a), dst, a.caption.trim()], { timeout: 180_000 })
        const info = JSON.parse(stdout.trim().split('\n').pop())
        // la still du reel (1re image, bandeau compris), même nom en .jpg
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', dst, '-frames:v', '1', '-q:v', '2', path.join(sortie, `${nom}.jpg`)])
        fs.appendFileSync(PUBLIEES, `${nom} | ${a.caption.trim()}\n`)
        t.livres.push({ id: a.id, nom, zone: info.zone })
        nom = reelSuivant(nom)
        fs.writeFileSync(COMPTEUR, JSON.stringify({ prochain: nom }, null, 1) + '\n')
      } catch (e) { t.erreurs.push({ id: a.id, erreur: String(e.stderr || e.message || e).slice(-300) }) }
      t.faits++
    }
  })().finally(() => { t.fini = true; t.enCours = null; t.duree = Date.now() - t.debut })
  return tache
}
