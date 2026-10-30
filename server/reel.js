/* ============================================================
   Reel en un clic (21/10) — un brief, et l'app réalise le reel :
     1. RÉDACTION   le réalisateur (LLM local) écrit 4 à 6 plans d'une même
                    séance (même tenue, même lieu, même lumière), une accroche,
                    et pour chaque plan l'image fixe ET le mouvement ;
     2. PHOTOS      un rendu photo par plan, avec l'identité du personnage ;
     3. CLIPS       chaque photo animée en LTX-2.5 (image → vidéo, son
                    d'ambiance), avec la LoRA vidéo du personnage s'il en a ;
     4. MONTAGE     un projet de l'onglet Montage, monté tout seul (fondus,
                    accroche sur le premier plan, musique), puis exporté.
   Chaque étape passe par la file de rendu ordinaire : un plan raté se refait
   comme n'importe quel job, et le montage reste modifiable ensuite.

   L'état vit en base (table `reels`) : la boucle de suivi reprend après un
   redémarrage, sauf une rédaction interrompue (à relancer).
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { fetchOllama } from './gpu.js'
import * as composer from './composer.js'
import { persona } from './persona.js'
import { enqueue as enfiler, deposerAvecCle } from './jobs.js'
import * as montage from './montage.js'
import { t0Hit } from './t0.js'

store.db.exec(`CREATE TABLE IF NOT EXISTS reels (
  id TEXT PRIMARY KEY, persona_id TEXT, brief TEXT NOT NULL, etat TEXT NOT NULL,
  data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)

/* Clé Comfy Cloud du visiteur : les jobs d'un reel partent plus tard, depuis la
   boucle de suivi, hors de la requête qui la portait. Gardée EN MÉMOIRE seulement
   (jamais en base), le temps du reel ; perdue au redémarrage, comme partout ailleurs. */
const cles = new Map()
const enqueue = (reelId, job) => deposerAvecCle(cles.get(reelId) ?? null, () => enfiler(job))

const ligne = r => r && { id: r.id, personaId: r.persona_id, brief: r.brief, etat: r.etat, createdAt: r.created_at, updatedAt: r.updated_at, ...JSON.parse(r.data) }
export const lireReel = id => ligne(store.db.prepare('SELECT * FROM reels WHERE id = ?').get(id))
export const listerReels = personaId => store.db.prepare('SELECT * FROM reels WHERE persona_id IS ? ORDER BY created_at DESC LIMIT 30').all(personaId ?? null).map(ligne)
function ecrire(id, etat, patch) {
  const r = lireReel(id)
  if (!r) return null
  const { id: _i, personaId: _p, brief: _b, etat: _e, createdAt: _c, updatedAt: _u, ...data } = r
  store.db.prepare('UPDATE reels SET etat = ?, data = ?, updated_at = ? WHERE id = ?')
    .run(etat ?? r.etat, JSON.stringify({ ...data, ...patch }), Date.now(), id)
  return lireReel(id)
}

/* ---------- 1. rédaction ---------- */
const SCHEMA = n => ({
  type: 'object', required: ['hook', 'outfit', 'location', 'light', 'shots'],
  properties: {
    hook: { type: 'string' }, outfit: { type: 'string' }, location: { type: 'string' }, light: { type: 'string' },
    shots: { type: 'array', minItems: n, maxItems: n, items: {
      type: 'object', required: ['still', 'motion'], properties: { still: { type: 'string' }, motion: { type: 'string' } } } },
  },
})
async function rediger({ brief, n, nom, langue }) {
  const system = `You are the director of a short vertical social-media reel (9:16), shot in ONE session with ONE woman named ${nom}.
From the creator's brief, plan exactly ${n} shots that tell a tiny story with a beginning, a middle and an end.
Rules:
- Same outfit, same location, same light in every shot: write them ONCE in "outfit", "location", "light" (concrete: garments with colour and fabric; a precise place; time of day and light quality).
- Vary the framing like a real editor: an establishing wide or medium-wide shot first, then medium shots, one close-up detail (hands, face, an object), one shot with clear action, a strong last shot.
- "still": the photograph that starts the shot. Start with the framing and the camera angle, then what ${nom} does, her expression, what is around her. 30 to 55 words. Do not repeat the outfit, location or light, they are added automatically. Never describe her face or body shape.
- "motion": what happens during the few seconds that follow, at natural real-time speed: ONE simple action that continues directly from the pose in "still", plus ONE camera move (slow push-in, gentle pan, handheld follow, slow orbit, tilt up…). 12 to 25 words. Never chain actions ("then", "and then", "before"): one gesture only. Good actions: a few steps, turning her head, a smile, a laugh, tucking her hair behind her ear, wind in her hair and clothes, looking around, a deep breath. Never: putting on, taking off or adjusting glasses, hats, jewellery or any clothing; getting in or out of a vehicle, starting an engine, driving off, opening doors, a vehicle starting to move; picking up, holding up or handing over objects; other people interacting with her. If she is in a vehicle in the still, she stays seated; if she stands, she stays on her feet. Each shot has a different action; do not repeat "looks at the viewer". Nobody else's face in close-up.
- Everything is safe for work: fully clothed, no nudity, no lingerie, no brand logos, no real celebrities.
- "hook": the on-screen opening text of the reel, 3 to 7 words, catchy, in ${langue}.
Write everything except the hook in English.`
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 480000)),
    body: JSON.stringify({ model: composer.modelFor(), system, prompt: `Brief: ${brief}`, format: SCHEMA(n), stream: false, think: false, keep_alive: '10m',
      options: { num_gpu: 0, num_ctx: 8192, num_predict: 2500, temperature: 0.7 } }),
  })
  if (!res.ok) throw new Error(`le réalisateur (LLM) a refusé : HTTP ${res.status}`)
  const out = JSON.parse(String((await res.json()).response || '{}'))
  if (!Array.isArray(out.shots) || out.shots.length < 2) throw new Error('le réalisateur n’a pas rendu de plans exploitables')
  return out
}

/* Le réalisateur (mistral-small) ne tient pas toujours les interdits du mouvement :
   « She puts the car in drive and begins to pull away », « she adjusts her
   sunglasses » (LTX ajoute alors une 2e paire sur son nez, 21/10). Les phrases
   fautives sont retirées ; s'il ne reste rien, un geste sûr les remplace. */
const INFAISABLE = /\b(put(s|ting)? on|take(s)? off|taking off|adjust(s|ing)?|sunglasses|glasses|hat\b|gets? (in|into|out)|climbs?|opens? the|closes? the|door|engine|ignition|drive(s|n)?\b|driving|pulls? (away|out|off)|gear|accelerat|speeds? (up|off)|starts? the car|picks? up|hands? (her|him|over)|holds? up)/i
const GESTE_SUR = 'Her hair and clothes move gently in the wind, she breathes naturally and smiles softly. The camera slowly pushes in.'
function geste(motion) {
  const phrases = String(motion ?? '').match(/[^.!?]+[.!?]*/g) ?? []
  const gardees = phrases.map(x => x.trim()).filter(x => x && !INFAISABLE.test(x))
  return gardees.length && gardees.join(' ').split(/\s+/).length >= 8 ? gardees.join(' ') : GESTE_SUR
}

/* ---------- contrôle des plans avant le rendu (27/10) ----------
   Des règles écrites dans le code, pas un modèle qui juge : ce qui donne en pratique un
   clip raté. Un plan fautif est réécrit UNE fois par le réalisateur ; ce qui reste
   fautif part quand même, avec un avertissement sur sa carte. */
const CONTROLES_PLAN = [
  { code: 'enchaine', test: pl => /\b(then|and then|before|after that|afterwards|finally|while also)\b/i.test(pl.motion),
    dit: 'several actions chained in one shot: keep ONE gesture', fr: 'plusieurs actions dans un seul plan' },
  { code: 'marche', test: pl => /\b(walk|walks|walking|stroll|strolls|strolling|steps?|stepping)\b/i.test(pl.motion)
      && !/\b(toward|towards|away from|left to right|right to left|from left|from right|to the left|to the right|forward|past the camera|closer)\b/i.test(pl.motion),
    dit: 'walking with no direction relative to the camera: say toward the camera, away, or left to right', fr: 'marche sans direction (risque de marche à reculons)' },
  { code: 'texte', test: pl => /\b(sign|signs|signboard|text|written|writing|lettering|letters|logo|neon sign|banner|poster|caption|label|menu board)\b/i.test(`${pl.still} ${pl.motion}`),
    dit: 'text, signs or lettering in the frame: the model draws them as gibberish, remove them', fr: 'texte ou panneau dans l’image' },
  { code: 'autrui', test: pl => /\b(another (person|woman|man)|a friend|her friend|boyfriend|girlfriend|partner|a stranger|someone|a man|the man|a waiter|people (come|walk|pass))\b/i.test(pl.motion),
    dit: 'another person acting in the shot: keep her alone in the action', fr: 'une autre personne agit dans le plan' },
  { code: 'long', test: pl => pl.motion.split(/\s+/).length > 32,
    dit: 'motion too long: 12 to 25 words', fr: 'mouvement trop long' },
]
export function controlerPlan(pl) { return CONTROLES_PLAN.filter(c => c.test(pl)) }

async function reecrirePlans(plans, fautifs, nom) {
  const liste = fautifs.map(({ k, pb }) => `Shot ${k + 1}\nstill: ${plans[k].still}\nmotion: ${plans[k].motion}\nproblems: ${pb.map(c => c.dit).join('; ')}`).join('\n\n')
  const res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(CONFIG.composerTimeoutMs, 300000)),
    body: JSON.stringify({ model: composer.modelFor(), stream: false, think: false, keep_alive: '10m',
      system: `You fix shots of a short reel with one woman named ${nom}. Rewrite ONLY what the listed problems require, keep everything else (framing, place, mood). Same length limits: still 30 to 55 words, motion 12 to 25 words with ONE gesture and ONE camera move. Safe for work.`,
      prompt: liste,
      format: { type: 'object', required: ['shots'], properties: { shots: { type: 'array', items: { type: 'object', required: ['shot', 'still', 'motion'],
        properties: { shot: { type: 'integer' }, still: { type: 'string' }, motion: { type: 'string' } } } } } },
      options: { num_gpu: 0, num_ctx: 8192, num_predict: 1500, temperature: 0.4 } }),
  })
  if (!res.ok) return
  const out = JSON.parse(String((await res.json()).response || '{}'))
  for (const s of out.shots ?? []) {
    const k = Number(s.shot) - 1
    if (!fautifs.some(f => f.k === k) || !s.still || !s.motion) continue
    const neuf = { ...plans[k], still: String(s.still).trim(), motion: geste(s.motion) }
    if (t0Hit(`${neuf.still} ${neuf.motion}`)) continue     // une réécriture ne passe jamais le filtre de contenu
    plans[k] = neuf
  }
}

/* ---------- lancement ---------- */
export function realiser({ brief, n, duree, musique, langue, cle }) {
  const b = String(brief ?? '').trim().slice(0, 600)
  if (!b) throw new Error('écris un brief : le lieu, l’ambiance, ce qui se passe')
  if (t0Hit(b)) throw new Error('brief refusé (liste T0)')
  const p = persona()
  const id = `reel-${Date.now().toString(36)}`
  const data = {
    n: Math.min(6, Math.max(3, Number(n) || 5)),
    duree: Math.min(6, Math.max(3, Number(duree) || 4)),
    musique: typeof musique === 'string' && montage.cheminMusique(musique) ? musique : null,
    langue: langue === 'en' ? 'English' : 'French',
    plans: [], erreur: null,
  }
  store.db.prepare('INSERT INTO reels (id, persona_id, brief, etat, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.id ?? null, b, 'redaction', JSON.stringify(data), Date.now(), Date.now())
  if (cle) cles.set(id, cle)
  void (async () => {
    try {
      const nom = String(p.name || 'the model').replace(/\s*\([^)]*\)\s*$/, '').trim()
      const r = await rediger({ brief: b, n: data.n, nom, langue: data.langue })
      // « She wears A white linen shirt » : le LLM ouvre souvent sur une majuscule
      // … ou répète le sujet (« She wears Mila wears a white blouse »)
      const sujet = new RegExp(`^(?:${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|She)\\s+(?:wears|is wearing)\\s+`, 'i')
      const bas = x => String(x ?? '').trim().replace(sujet, '').replace(/^(A|An|The)\b/, m => m.toLowerCase()).replace(/[.\s]+$/, '')
      const tronc = `She wears ${bas(r.outfit)}. ${String(r.location).trim().replace(/[.\s]+$/, '')}. ${String(r.light).trim().replace(/[.\s]+$/, '')}.`
      const plans = r.shots.slice(0, data.n).map(s => ({ still: s.still.trim(), motion: geste(s.motion), photoJob: null, clipJob: null }))
      // contrôle avant le rendu : une réécriture des plans fautifs, puis avertissement pour ce qui reste
      const fautifs = plans.map((pl, k) => ({ k, pb: controlerPlan(pl) })).filter(f => f.pb.length)
      if (fautifs.length) {
        console.log(`[reel ${id}] contrôle des plans : ${fautifs.map(f => `plan ${f.k + 1} (${f.pb.map(c => c.code).join(', ')})`).join(' ; ')} → réécriture`)
        try { await reecrirePlans(plans, fautifs, nom) } catch (e) { console.warn(`[reel ${id}] réécriture impossible — ${e.message || e}`) }
      }
      for (const pl of plans) {
        const reste = controlerPlan(pl)
        if (reste.length) pl.avertissements = reste.map(c => c.fr)
        pl.still = `${pl.still} ${tronc}`
      }
      for (const pl of plans) {
        if (t0Hit(`${pl.still} ${pl.motion}`)) throw new Error('un plan rédigé contient un terme bloqué (liste T0) — relancer')
      }
      // une photo par plan, toutes au même lot
      const lot = `reel-${id}`
      for (const [k, pl] of plans.entries()) {
        const j = enqueue(id, { id: `${id}-p${k + 1}`, mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: CONFIG.photoEngine,
          composedPositive: pl.still, userPrompt: pl.still, composedNegative: '', width: 768, height: 1344, batchId: lot, reelId: id })
        pl.photoJob = j.id
      }
      ecrire(id, 'photos', { accroche: r.hook.trim().replace(/^[«"']+|[»"']+$/g, '').replace(/\.$/, '').trim(), tenue: r.outfit, lieu: r.location, lumiere: r.light, plans })
      console.log(`[reel ${id}] ${plans.length} plans rédigés, photos en file`)
    } catch (e) {
      ecrire(id, 'echec', { erreur: String(e.message || e).slice(0, 400) })
      console.warn(`[reel ${id}] rédaction : ${e.message || e}`)
    }
  })()
  return lireReel(id)
}

/* ---------- suivi : photos → clips → montage → export ---------- */
const etatJob = id => id ? store.getJob(id)?.status ?? 'absent' : null
const premierAsset = id => (id && store.assetsOfJob(id).find(a => !String(a.id).endsWith('-full'))) || null
const versInput = a => {
  const nom = `crs_still_${path.basename(a.filename)}`
  fs.copyFileSync(path.join(CONFIG.mediaDir, path.basename(a.filename)), path.join(CONFIG.comfyInput, nom))
  store.noterInput(nom)
  return nom
}

function avancer(r) {
  if (r.etat === 'photos' || r.etat === 'clips') {
    let change = false, rates = 0
    for (const pl of r.plans) {
      if (!pl.clipJob) {
        const s = etatJob(pl.photoJob)
        if (s === 'done') {
          const a = premierAsset(pl.photoJob)
          if (!a) { rates++; continue }
          pl.photoAsset = a.id
          const j = enqueue(r.id, { id: `${r.id}-c${r.plans.indexOf(pl) + 1}${pl.refait ? `-r${pl.refait}` : ''}`, mode: 'video', register: 'sfw', personaId: r.personaId, purpose: 'creative', videoEngine: 'ltx_hq', withAudio: true,
            sourceImage: versInput(a), composedPositive: `${pl.motion}. single continuous shot, no cuts`, userPrompt: pl.motion, composedNegative: '',
            videoSeconds: r.duree, videoFps: 24, videoAspect: '9:16', reelId: r.id })
          pl.clipJob = j.id; change = true
        } else if (s === 'blocked' || s === 'cancelled' || s === 'absent') rates++
      } else if (!pl.clipAsset) {
        const s = etatJob(pl.clipJob)
        if (s === 'done') { const a = premierAsset(pl.clipJob); if (a) { pl.clipAsset = a.id; change = true } else rates++ }
        else if (s === 'blocked' || s === 'cancelled' || s === 'absent') rates++
      }
    }
    const prets = r.plans.filter(p => p.clipAsset)
    if (prets.length + rates === r.plans.length && prets.length >= 2) return monter(r, prets, rates)
    if (prets.length + rates === r.plans.length) return ecrire(r.id, 'echec', { plans: r.plans, erreur: 'trop de plans ratés pour monter un reel — relancer les jobs en échec ou un nouveau reel' })
    if (change || r.etat === 'photos' && r.plans.some(p => p.clipJob)) ecrire(r.id, r.plans.some(p => p.clipJob) ? 'clips' : 'photos', { plans: r.plans })
    return
  }
  if (r.etat === 'export') {
    const s = etatJob(r.exportJob)
    if (s === 'done') { cles.delete(r.id); ecrire(r.id, 'fini', { reelAsset: premierAsset(r.exportJob)?.id ?? null }) }
    else if (s === 'blocked' || s === 'absent') ecrire(r.id, 'echec', { erreur: 'export du montage en échec — ouvrir le montage et relancer l’export' })
  }
}

function monter(r, prets, rates) {
  const proj = montage.creerProjet(`Reel — ${r.brief.slice(0, 50)}`, r.personaId)
  const clips = prets.map((p, i) => ({ assetId: p.clipAsset, debut: 0, fin: null, duree: 3, texte: i === 0 ? r.accroche ?? '' : '',
    textePos: 'centre', transition: i === prets.length - 1 ? 'coupe' : 'fondu', transitionDuree: 0.35, crop: null }))
  const p2 = montage.ecrireProjet(proj.id, { data: { format: '9:16', cadrage: 'remplir', sonClips: true, volumeClips: r.musique ? 0.35 : 1,
    musique: r.musique ? { fichier: r.musique, volume: 0.85, fonduEntree: 0.3, fonduSortie: 1.2, decalage: 0 } : null, clips } })
  try {
    const { jobId } = montage.exporter(p2)
    return ecrire(r.id, 'export', { plans: r.plans, montageId: proj.id, exportJob: jobId, ratés: rates })
  } catch (e) {
    return ecrire(r.id, 'echec', { plans: r.plans, montageId: proj.id, erreur: `montage : ${String(e.message || e).slice(0, 300)}` })
  }
}

export function demarrerSuivi() {
  // une rédaction interrompue par un redémarrage ne reprendra pas toute seule
  for (const r of store.db.prepare(`SELECT id FROM reels WHERE etat = 'redaction'`).all())
    ecrire(r.id, 'echec', { erreur: 'rédaction interrompue par un redémarrage du service — relancer le reel' })
  setInterval(() => {
    for (const row of store.db.prepare(`SELECT id FROM reels WHERE etat IN ('photos','clips','export')`).all()) {
      try { avancer(lireReel(row.id)) } catch (e) { console.warn(`[reel ${row.id}] suivi : ${e.message || e}`) }
    }
  }, 4000).unref()
}

/** Refait un seul plan d'un reel fini (30/10) : sa photo est gardée, son clip est rendu à nouveau
 *  (avec un nouveau mouvement si on en donne un), puis le reel est remonté. Les autres clips ne bougent pas. */
export function refairePlan(id, k, motion) {
  const r = lireReel(id)
  if (!r) throw new Error('reel inconnu')
  if (r.etat !== 'fini' && r.etat !== 'echec') throw new Error('attends la fin du reel pour refaire un plan')
  const pl = r.plans?.[Number(k)]
  if (!pl?.photoJob) throw new Error('plan inconnu')
  const m = String(motion ?? '').trim().slice(0, 300)
  if (m && t0Hit(m)) throw new Error('mouvement refusé (liste T0)')
  if (m) pl.motion = m
  pl.refait = (pl.refait ?? 0) + 1
  pl.clipJob = null; pl.clipAsset = null
  ecrire(id, 'clips', { plans: r.plans, reelAsset: null, exportJob: null, erreur: null })
  return lireReel(id)
}

/** Retire un reel de la liste (ses photos, clips et montage restent dans la bibliothèque). */
export function supprimerReel(id) {
  cles.delete(id)
  return store.db.prepare('DELETE FROM reels WHERE id = ?').run(String(id)).changes > 0
}
