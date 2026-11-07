/* ============================================================
   Client ComfyUI — charge une recette au format API, y injecte
   le job CreatorOS, la poste, suit son exécution et récupère
   l'image produite.

   POINT CRITIQUE — ImpactWildcardProcessor :
   le mode « populate » est exécuté par le NAVIGATEUR avant l'envoi ;
   le nœud, lui, ne lit que `populated_text` (impact_pack.py, doit()).
   Injecter dans `wildcard_text` via l'API ne changerait donc RIEN :
   on écrit dans `populated_text` et on bascule `mode` sur « fixed ».
   ============================================================ */
import { definirClientStudio } from './gpu.js'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { CONFIG } from './config.js'
import { erreurExecution, erreurSoumission } from './erreurs.js'
import { personaLoraNames } from './persona.js'
import * as sdk from './transport-sdk.js'
import { alleger } from './allege.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- chargement des recettes ---------- */

export function loadWorkflow(file) {
  const full = path.join(CONFIG.workflowsDir, file)
  // Empêche toute sortie du dossier des workflows via un nom forgé.
  if (!full.startsWith(CONFIG.workflowsDir + path.sep)) throw new Error('workflow hors périmètre')
  const wf = JSON.parse(fs.readFileSync(full, 'utf8'))
  const bad = Object.entries(wf).filter(([, n]) => !n || typeof n !== 'object' || !n.class_type)
  if (bad.length) throw new Error(`${file} n'est pas au format API (nœud ${bad[0][0]} sans class_type)`)
  return wf
}

export const listWorkflows = () =>
  fs.readdirSync(CONFIG.workflowsDir).filter(f => f.endsWith('.json') && !f.endsWith('.pilotage.json')).sort()

/** Résumé lisible d'une recette : moteur, LoRA, échantillonnage.
 *  Calculé ici parce que le serveur lit déjà le fichier — le front n'a pas à
 *  télécharger 5 à 15 Ko de JSON par ligne de liste pour afficher un
 *  sous-titre. Tolérant : une recette exotique rend un résumé partiel plutôt
 *  qu'une erreur. */
export function summarize(file) {
  try {
    const wf = loadWorkflow(file)
    const n = Object.values(wf)
    const base = n.filter(x => x.class_type === 'UNETLoader' || x.class_type === 'CheckpointLoaderSimple')
      .map(x => (x.inputs.unet_name || x.inputs.ckpt_name || '').replace(/\.safetensors$/, ''))
    const loras = n.filter(x => /^LoraLoader/.test(x.class_type))
      .map(x => `${String(x.inputs.lora_name || '').replace(/^.*\//, '').replace(/\.safetensors$/, '')} @${x.inputs.strength_model}`)
    const ks = n.find(x => x.class_type === 'KSampler' || x.class_type === 'KSamplerAdvanced')
    const sampling = ks ? `${ks.inputs.steps} pas · cfg ${ks.inputs.cfg} · ${ks.inputs.sampler_name}` : null
    const outputs = n.filter(x => /^(SaveImage|PreviewImage)/.test(x.class_type)).length
    return { base, loras, sampling, nodes: n.length, outputs }
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) }
  }
}

/* ---------- édition des recettes depuis le Workbench ----------
   Le Workbench édite les fichiers SERVIS, pas une copie. `loadWorkflow` relit
   le disque à chaque job (aucun cache) : une écriture prend donc effet au job
   suivant, sans redémarrage. C'est le comportement voulu — c'est aussi ce qui
   rend la validation obligatoire ici plutôt qu'à l'exécution. */

/** Chemin absolu d'une recette, avec la garde de périmètre.
 *  Un nom nu uniquement : ni séparateur, ni `..`, ni chemin absolu. */
export function workflowPath(file) {
  if (typeof file !== 'string' || !file.endsWith('.json'))
    throw new Error('nom de recette invalide : un fichier .json est attendu')
  if (file.includes('/') || file.includes('\\') || file.includes('..'))
    throw new Error(`nom de recette invalide : « ${file} » n’est pas un nom de fichier nu`)
  const full = path.join(CONFIG.workflowsDir, file)
  if (!full.startsWith(CONFIG.workflowsDir + path.sep)) throw new Error('recette hors périmètre')
  return full
}

/** Contenu brut + horodatage. Le `mtimeMs` sert de jeton de concurrence :
 *  il permet de refuser une écriture basée sur une version périmée plutôt que
 *  d'écraser en silence une modification faite sur le disque. */
export function readWorkflowRaw(file) {
  const full = workflowPath(file)
  const st = fs.statSync(full)
  return { file, text: fs.readFileSync(full, 'utf8'), mtimeMs: st.mtimeMs, bytes: st.size }
}

/** Vérifie qu'un texte est une recette ComfyUI au format API jouable.
 *  Retourne un résumé, ou lève avec un message adressé à un humain. */
export function validateWorkflowText(text) {
  let wf
  try { wf = JSON.parse(text) }
  catch (e) { throw new Error(`JSON invalide : ${e.message}`) }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf))
    throw new Error('la racine doit être un objet { "id": { class_type, inputs } }')
  const ids = Object.keys(wf)
  if (!ids.length) throw new Error('recette vide : aucun nœud')

  for (const [id, n] of Object.entries(wf)) {
    if (!n || typeof n !== 'object' || Array.isArray(n))
      throw new Error(`nœud ${id} : objet attendu`)
    if (typeof n.class_type !== 'string' || !n.class_type)
      throw new Error(`nœud ${id} : « class_type » manquant — ce n’est pas le format API`)
    if (n.inputs != null && (typeof n.inputs !== 'object' || Array.isArray(n.inputs)))
      throw new Error(`nœud ${id} : « inputs » doit être un objet`)
    // Un lien vers un nœud absent passe la validation de ComfyUI puis casse à
    // l'exécution, plusieurs minutes plus tard, sur un job de l'opérateur.
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && !(String(v[0]) in wf))
        throw new Error(`nœud ${id}, entrée « ${k} » : lien vers le nœud ${v[0]}, qui n’existe pas`)
    }
  }
  const sinks = Object.values(wf).filter(n => /^(SaveImage|PreviewImage|SaveAnimated|SaveAudio)/.test(n.class_type))
  if (!sinks.length)
    throw new Error('aucun nœud de sortie (SaveImage…) : la recette ne produirait aucun asset')
  return { nodes: ids.length, outputs: sinks.length, classes: [...new Set(Object.values(wf).map(n => n.class_type))].length }
}

/** Écriture d'une recette. Trois garde-fous, dans cet ordre :
 *  1. validation — on n'écrit jamais une recette injouable ;
 *  2. concurrence — refus si le fichier a bougé depuis la lecture ;
 *  3. sauvegarde horodatée avant écrasement, puis écriture atomique. */
export function writeWorkflow(file, text, baseMtimeMs) {
  const full = workflowPath(file)
  const summary = validateWorkflowText(text)

  const exists = fs.existsSync(full)
  if (exists && Number.isFinite(baseMtimeMs)) {
    const cur = fs.statSync(full).mtimeMs
    // Tolérance d'une milliseconde : certains systèmes de fichiers arrondissent.
    if (Math.abs(cur - baseMtimeMs) > 1) {
      const e = new Error('la recette a été modifiée sur le disque depuis son ouverture')
      e.code = 'CONFLIT'
      e.currentMtimeMs = cur
      throw e
    }
  }

  let backup = null
  if (exists) {
    const dir = path.join(CONFIG.workflowsDir, '.backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = path.join(dir, `${file.replace(/\.json$/, '')}.${stamp}.json`)
    fs.copyFileSync(full, backup)
  }
  const tmp = full + '.tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, full)
  const st = fs.statSync(full)
  return { file, mtimeMs: st.mtimeMs, bytes: st.size, backup: backup && path.basename(backup), ...summary }
}

const findByClass = (wf, cls) =>
  Object.entries(wf).filter(([, n]) => n.class_type === cls).map(([id]) => id)

/* ---------- injection ---------- */

/** Encodeurs de texte réellement câblés sur l'entrée POSITIVE d'un
 *  échantillonneur. Sans ça, une recette à deux CLIPTextEncode verrait
 *  le prompt atterrir au hasard — potentiellement dans le négatif. */
function positiveTextEncoders(out) {
  const ids = new Set()
  for (const n of Object.values(out)) {
    if (n.class_type !== 'KSampler' && n.class_type !== 'KSamplerAdvanced'
      && n.class_type !== 'LanPaint_KSampler') continue
    const p = n.inputs?.positive
    if (Array.isArray(p)) ids.add(String(p[0]))
  }
  return [...ids].filter(id =>
    out[id]?.class_type === 'CLIPTextEncode' && typeof out[id].inputs?.text === 'string')
}

/* ---------- où écrire le prompt, par le CÂBLAGE ----------
   `positiveTextEncoders` ne reconnaît qu'un encodeur branché DIRECTEMENT sur
   un KSampler. Les recettes vidéo n'ont ni l'un ni l'autre : LTX passe par un
   LTXVDualCFGGuider, MiniMax par un BasicGuider, Wan interpose un
   WanImageToVideo. Toutes tomberaient donc sur le repli « premier CLIPTextEncode
   littéral » — qui, sur LTX, est le NÉGATIF. Le prompt de mouvement partirait
   dans le négatif et le rendu aurait l'air simplement raté.

   On remonte donc le graphe depuis les échantillonneurs, en ne suivant que
   les entrées qui portent le conditionnement POSITIF. Traverser toutes les
   entrées en aveugle rattraperait le négatif : LTXVConditioning et
   WanImageToVideo portent les deux côtés. */
const POSITIVE_IN = {
  KSampler: ['positive'],
  KSamplerAdvanced: ['positive'],
  LanPaint_KSampler: ['positive'],
  SamplerCustomAdvanced: ['guider'],
  BasicGuider: ['conditioning'],
  CFGGuider: ['positive'],
  LTXVDualCFGGuider: ['positive'],
  WanImageToVideo: ['positive'],
  WanFirstLastFrameToVideo: ['positive'],
  WanCameraImageToVideo: ['positive'],
  FluxGuidance: ['conditioning'],
  ConditioningCombine: ['conditioning_1', 'conditioning_2'],
  ConditioningConcat: ['conditioning_to'],
  ConditioningSetTimestepRange: ['conditioning'],
}

/** Nœuds terminaux qui portent le texte, et le nom du champ à écrire. */
const TEXT_SLOT = {
  CLIPTextEncode: 'text',
  MiniMaxH3ImageToVideo: 'prompt',
  PrimitiveStringMultiline: 'value',
  PrimitiveString: 'value',
  String: 'value',
}

/** Emplacements d'écriture du prompt positif, sous la forme `id.champ`.
 *  Remonte depuis chaque échantillonneur ; suit le lien quand le texte d'un
 *  encodeur vient d'un nœud primitif (cas de LTX). */
function positiveTextSlots(out) {
  const slots = new Set()
  const seen = new Set()

  const visit = (id, outSlot) => {
    const key = `${id}:${outSlot}`
    if (seen.has(key)) return
    seen.add(key)
    const n = out[id]
    if (!n) return

    const field = TEXT_SLOT[n.class_type]
    if (field) {
      const v = n.inputs?.[field]
      if (typeof v === 'string') { slots.add(`${id}.${field}`); return }
      // Le texte est LIÉ : la vraie saisie est en amont (PrimitiveStringMultiline).
      if (Array.isArray(v)) { visit(String(v[0]), v[1]); return }
      return
    }
    // LTXVConditioning rend positif en 0 et négatif en 1 : on ne remonte que
    // le côté par lequel on est arrivé.
    const ins = n.class_type === 'LTXVConditioning'
      ? [outSlot === 1 ? 'negative' : 'positive']
      : POSITIVE_IN[n.class_type]
    if (!ins) return
    for (const k of ins) {
      const l = n.inputs?.[k]
      if (Array.isArray(l)) visit(String(l[0]), l[1])
    }
  }

  for (const [id, n] of Object.entries(out)) {
    if (!POSITIVE_IN[n.class_type]) continue
    if (!/^(KSampler|KSamplerAdvanced|SamplerCustomAdvanced|LanPaint_KSampler)$/.test(n.class_type)) continue
    visit(id, 0)
  }
  return [...slots]
}

/* ---------- durée et format ----------
   Les trois recettes n'exposent pas la durée au même endroit, et aucune ne
   l'expose de la même façon :

     Wan      WanImageToVideo.length — un NOMBRE D'IMAGES littéral
     LTX      EmptyLTXVLatentVideo.length ← ComfyMathExpression « a * b + 1 »
              où a = secondes et b = fps, tous deux des primitives
     MiniMax  MiniMaxH3ImageToVideo.length ← une expression qui quantifie sur
              17 (le pas temporel de son latent)

   D'où une remontée plutôt qu'une table de nœuds en dur : le Workbench permet
   d'éditer les recettes, et des identifiants figés ici se périmeraient en
   silence. On ne suit que `values.a` d'une expression — `values.b` porte les
   fps, l'écraser avec des secondes donnerait un clip de 9 images. */

/** Écrit la durée de GÉNÉRATION. Rend un compte rendu, ou null si la recette
 *  n'expose aucune durée reconnaissable — auquel cas on le dit plutôt que de
 *  laisser croire au réglage. */
function setVideoDuration(out, seconds) {
  const holders = Object.entries(out).filter(([, n]) =>
    'length' in (n.inputs ?? {}) && /ImageToVideo|LatentVideo/.test(n.class_type))
  if (!holders.length) return null

  for (const [id, n] of holders) {
    const len = n.inputs.length
    if (!Array.isArray(len)) {
      /* Compte d'images littéral (Wan). La cadence de lecture est celle du
         nœud d'assemblage — sur Wan c'est 24 alors que le modèle anime à 16,
         et c'est précisément ce décalage qui corrige la vitesse. On lit donc
         le fps réel du graphe au lieu de supposer 24. */
      const fps = Object.values(out).find(x => x.class_type === 'CreateVideo'
        && typeof x.inputs?.fps === 'number')?.inputs.fps ?? 24
      // Les modèles vidéo travaillent par blocs de 4 images + 1.
      const frames = Math.max(5, Math.round((seconds * fps - 1) / 4) * 4 + 1)
      out[id].inputs.length = frames
      return `#${id} ${n.class_type}.length = ${frames} images (${(frames / fps).toFixed(2)} s à ${fps} fps)`
    }
    // Durée en SECONDES, en amont d'une ou plusieurs expressions.
    let cur = String(len[0])
    for (let hop = 0; hop < 6; hop++) {
      const node = out[cur]
      if (!node) break
      const v = node.inputs?.value
      if (typeof v === 'number') {
        // PrimitiveInt n'accepte pas 8,75 : on arrondit, et la correction de
        // vitesse se fera sur la durée RÉELLE mesurée après rendu.
        out[cur].inputs.value = node.class_type === 'PrimitiveInt' ? Math.round(seconds) : seconds
        return `#${cur} ${node.class_type}.value = ${out[cur].inputs.value} s (génération)`
      }
      const a = node.inputs?.['values.a']
      if (!Array.isArray(a)) break
      cur = String(a[0])
    }
  }
  return null
}

/** Options du nœud ResolutionSelector, dans l'ordre de son COMBO. */
const ASPECT_LABEL = {
  '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
}

/** Écrit le format. Deux mécaniques selon la recette : un ResolutionSelector
 *  (LTX, MiniMax) ou des dimensions littérales (Wan). Dans le second cas on
 *  conserve la SURFACE de la recette — changer le format ne doit pas changer
 *  le coût du rendu. */
function setVideoAspect(out, ratio) {
  const label = ASPECT_LABEL[ratio]
  if (!label) return []
  const notes = []
  for (const [id, n] of Object.entries(out)) {
    if (n.class_type === 'ResolutionSelector') {
      out[id].inputs.aspect_ratio = label
      notes.push(`#${id} ResolutionSelector.aspect_ratio = ${label}`)
    }
    if (/ImageToVideo/.test(n.class_type)
      && typeof n.inputs?.width === 'number' && typeof n.inputs?.height === 'number') {
      const [rw, rh] = ratio.split(':').map(Number)
      const px = n.inputs.width * n.inputs.height
      const k = Math.sqrt(px / (rw * rh))
      const r = v => Math.max(256, Math.round((v * k) / 16) * 16)
      out[id].inputs.width = r(rw)
      out[id].inputs.height = r(rh)
      notes.push(`#${id} ${n.class_type} = ${out[id].inputs.width}×${out[id].inputs.height} (${ratio})`)
    }
  }
  return notes
}

/** Format « origine » : dimensions calées sur le ratio EXACT de la still.
 *  Le ResolutionSelector ne connaît que ses ratios ronds : snapper une still
 *  4:7 (768×1344) sur 9:16 puis arrondir aux multiples de 32 donnerait 480×864
 *  (5:9) — la still étirée de ~3 % en largeur. Ici on
 *  calcule des dimensions multiples de 32 à la surface visée, au plus près du
 *  ratio de la still, et on remplace les LIENS vers le sélecteur (et les
 *  dimensions littérales type Wan) par ces littéraux. `mp` (brouillon) est
 *  intégré au calcul : le bloc setVideoMegapixels ne doit PAS repasser derrière. */
function setVideoExactDims(out, srcW, srcH, mp) {
  const notes = []
  const target = srcW / srcH
  const selectors = Object.entries(out).filter(([, n]) => n.class_type === 'ResolutionSelector')
  const selIds = new Set(selectors.map(([id]) => id))
  const bestDims = surface => {
    const w0 = Math.sqrt(surface * target)
    const h0 = w0 / target
    let best = null
    for (const W of [Math.floor(w0 / 32) * 32, Math.ceil(w0 / 32) * 32])
      for (const H of [Math.floor(h0 / 32) * 32, Math.ceil(h0 / 32) * 32]) {
        if (W < 256 || H < 256) continue
        const d = Math.abs(Math.log((W / H) / target))
        if (!best || d < best.d - 1e-9
          || (d < best.d + 1e-9 && Math.abs(W * H - surface) < Math.abs(best.W * best.H - surface)))
          best = { W, H, d }
      }
    return best ?? {
      W: Math.max(256, Math.round(w0 / 32) * 32),
      H: Math.max(256, Math.round(h0 / 32) * 32),
    }
  }
  // Surface visée : le brouillon si demandé, sinon celle du sélecteur de la
  // recette (0,9 MP par défaut mesuré sur MiniMax/LTX).
  const selMp = selectors.length && typeof selectors[0][1].inputs?.megapixels === 'number'
    ? selectors[0][1].inputs.megapixels : 0.9
  const selBest = bestDims((Number.isFinite(mp) ? mp : selMp) * 1e6)
  for (const [id, n] of Object.entries(out)) {
    const ins = n.inputs ?? {}
    let touched = false
    for (const key of ['width', 'height']) {
      if (Array.isArray(ins[key]) && selIds.has(String(ins[key][0]))) {
        ins[key] = key === 'width' ? selBest.W : selBest.H
        touched = true
      }
    }
    // relais entier (PrimitiveInt) branché sur une sortie du sélecteur : 0 = largeur, 1 = hauteur
    if (Array.isArray(ins.value) && selIds.has(String(ins.value[0]))) {
      ins.value = ins.value[1] === 0 ? selBest.W : selBest.H
      notes.push(`#${id} ${n.class_type} = ${ins.value} (${ins.value === selBest.W ? 'largeur' : 'hauteur'}, origine ${srcW}×${srcH})`)
      continue
    }
    if (touched) {
      notes.push(`#${id} ${n.class_type} = ${ins.width}×${ins.height} (origine ${srcW}×${srcH}`
        + `${Number.isFinite(mp) ? `, brouillon ${mp} MP` : ''})`)
      continue
    }
    // Dimensions littérales (Wan) : même surface que la recette (ou brouillon),
    // ratio de la still.
    if (/ImageToVideo/.test(n.class_type)
      && typeof ins.width === 'number' && typeof ins.height === 'number') {
      const lit = bestDims(Number.isFinite(mp) ? mp * 1e6 : ins.width * ins.height)
      ins.width = lit.W
      ins.height = lit.H
      notes.push(`#${id} ${n.class_type} = ${lit.W}×${lit.H} (origine ${srcW}×${srcH}`
        + `${Number.isFinite(mp) ? `, brouillon ${mp} MP` : ''})`)
    }
  }
  return notes
}

/** Surface de rendu, en mégapixels, sur les recettes à ResolutionSelector
 *  (LTX, MiniMax). Le mode brouillon passe par là. On ne touche PAS aux
 *  autres nœuds qui portent un `megapixels` (ImageScaleToTotalPixels de la
 *  still, par exemple) : ils n'alimentent pas le modèle, et le premier plan
 *  gagne à rester net. */
function setVideoMegapixels(out, mp) {
  const notes = []
  for (const [id, n] of Object.entries(out)) {
    if (n.class_type === 'ResolutionSelector') {
      out[id].inputs.megapixels = mp
      notes.push(`#${id} ResolutionSelector.megapixels = ${mp} (brouillon)`)
    }
    // Dimensions littérales (Wan) : même ratio, surface ramenée à `mp`,
    // multiples de 16 — exactement ce que fait setVideoAspect pour le format.
    if (/ImageToVideo/.test(n.class_type)
      && typeof n.inputs?.width === 'number' && typeof n.inputs?.height === 'number') {
      const k = Math.sqrt((mp * 1e6) / (n.inputs.width * n.inputs.height))
      const r = v => Math.max(256, Math.round((v * k) / 16) * 16)
      out[id].inputs.width = r(n.inputs.width)
      out[id].inputs.height = r(n.inputs.height)
      notes.push(`#${id} ${n.class_type} = ${out[id].inputs.width}×${out[id].inputs.height} (brouillon ${mp} MP)`)
    }
  }
  return notes
}

/* ---------- rendu muet : on saute l'ÉTAGE DE DÉCODAGE audio ----------
   Précision qui compte, parce qu'elle borne le gain : dans LTX-2.5 comme dans
   MiniMax H3, l'audio est débruité DANS LE MÊME latent que l'image. Il n'y a
   pas de passe audio séparable à supprimer — seulement son décodage (VAE audio
   + LTXVAudioVAEDecode / VAEDecodeAudio). C'est ce qu'on retire ici, avec les
   nœuds qui n'alimentent plus rien. Le fichier livré n'a donc aucune piste
   audio, et le graphe ne charge plus le VAE audio.

   Élagage par ATTEIGNABILITÉ, pas par liste de classes : on part des nœuds de
   sortie (personne ne les référence) et on garde ce qui les alimente. Une
   liste en dur raterait le VAELoader devenu orphelin. */
function stripAudioStage(out) {
  const notes = []
  const orphans = []
  for (const [id, n] of Object.entries(out)) {
    if (n.class_type === 'CreateVideo' && Array.isArray(n.inputs?.audio)) {
      orphans.push(String(n.inputs.audio[0]))
      delete n.inputs.audio
      notes.push(`#${id} CreateVideo.audio détaché — rendu muet`)
    }
  }
  if (!orphans.length) return notes

  /* Remontée depuis le décodeur détaché uniquement. On ne part PAS des nœuds
     « que personne ne référence » : le décodeur audio vient justement d'entrer
     dans cette catégorie, il se serait pris lui-même pour une sortie. */
  const refCount = () => {
    const m = new Map()
    for (const n of Object.values(out))
      for (const v of Object.values(n.inputs || {}))
        if (Array.isArray(v)) m.set(String(v[0]), (m.get(String(v[0])) ?? 0) + 1)
    return m
  }
  while (orphans.length) {
    const id = orphans.shift()
    const n = out[id]
    if (!n) continue
    // Garde-fou : une sortie ne s'élague jamais, même sans consommateur — par
    // définition personne ne la référence.
    if (/^(Save|Preview)/.test(n.class_type)) continue
    if (refCount().get(id)) continue          // encore consommé ailleurs
    for (const v of Object.values(n.inputs || {}))
      if (Array.isArray(v)) orphans.push(String(v[0]))
    delete out[id]
    notes.push(`#${id} ${n.class_type} retiré — plus rien ne le consomme`)
  }
  return notes
}

/** Recettes à INSTRUCTION (Qwen-Image-Edit) : le texte n'y décrit pas une
 *  image à créer mais une ÉDITION à appliquer, et la recette en porte déjà la
 *  base figée — identité du sujet, cheveux, consigne de conservation. Le
 *  prompt de la console s'y AJOUTE, il ne la remplace pas.
 *
 *  Détection par le câblage, jamais par le nom de fichier : c'est ce qui
 *  distingue l'encodeur d'instruction (#30) de son jumeau négatif (#31), qui
 *  porte la même classe et les mêmes images. */
function instructionEncoders(out) {
  const ids = new Set()
  for (const n of Object.values(out)) {
    if (n.class_type !== 'KSampler' && n.class_type !== 'KSamplerAdvanced'
      && n.class_type !== 'LanPaint_KSampler') continue
    const p = n.inputs?.positive
    if (Array.isArray(p)) ids.add(String(p[0]))
  }
  /* Deux signatures de recette d'édition, avec leur champ d'écriture :
       1. Qwen : l'encodeur TextEncodeQwenImageEdit* porte `prompt`.
       2. Klein (édition par référence) : un CLIPTextEncode ordinaire (`text`), mais
          dont le conditionnement DESCEND vers l'échantillonneur à travers au
          moins un ReferenceLatent — la marque d'une édition guidée par
          images de référence. Un CLIPTextEncode branché en direct reste une
          recette de génération et n'est pas reconnu ici. */
  const found = []
  for (const start of ids) {
    let id = start, hops = 0
    while (out[id] && (out[id].class_type === 'FluxGuidance' || out[id].class_type === 'ReferenceLatent')) {
      if (out[id].class_type === 'ReferenceLatent') hops++
      const up = out[id].inputs?.conditioning
      if (!Array.isArray(up)) { id = null; break }
      id = String(up[0])
    }
    if (!id || !out[id]) continue
    if (/^TextEncodeQwenImageEdit/.test(out[id].class_type) && typeof out[id].inputs?.prompt === 'string')
      found.push({ id, field: 'prompt' })
    else if (hops > 0 && out[id].class_type === 'CLIPTextEncode' && typeof out[id].inputs?.text === 'string')
      found.push({ id, field: 'text' })
  }
  return found
}

/** Écrit prompt, négatif, seed, dimensions et LoRA additionnelles dans une
 *  COPIE de la recette. Retourne la recette injectée et le JOURNAL des
 *  injections : ce qui a été écrit, et ce qui n'a PAS pu l'être — signalé,
 *  jamais masqué. */
/* ---------- pilotage DÉCLARÉ d'une recette ----------
   L'injection suit le câblage du graphe (injectJob). Une recette d'essai ou un
   moteur nouveau peut en plus DÉCLARER, dans un fichier voisin
   `<recette>.pilotage.json`, quelle entrée de quel nœud reçoit chaque valeur :
     { "prompt": ["6", "text"], "negative": ["7", "text"], "seed": ["3", "seed"],
       "width": ["5", "width"], "height": ["5", "height"], "sourceImage": ["10", "image"] }
   La déclaration s'applique APRÈS le câblage et l'emporte. Sans fichier, rien
   ne change : aucune recette de production n'en a. */
export const CLES_PILOTAGE = ['prompt', 'negative', 'seed', 'width', 'height', 'sourceImage']
export function readPilotage(file) {
  const p = workflowPath(file).replace(/\.json$/i, '') + '.pilotage.json'
  if (!fs.existsSync(p)) return null
  try { return { fichier: path.basename(p), slots: JSON.parse(fs.readFileSync(p, 'utf8')) } }
  catch (e) { return { fichier: path.basename(p), slots: {}, erreur: `déclaration illisible : ${String(e.message).slice(0, 120)}` } }
}
export function appliquerPilotage(file, wf, valeurs, applied = [], skipped = []) {
  const d = readPilotage(file)
  if (!d) return wf
  if (d.erreur) { skipped.push(`${d.fichier} — ${d.erreur}`); return wf }
  for (const cle of CLES_PILOTAGE) {
    const cible = d.slots[cle]
    if (!cible || valeurs[cle] === undefined || valeurs[cle] === null) continue
    const [noeud, entree] = cible
    if (!wf[noeud]?.inputs) { skipped.push(`${d.fichier} : « ${cle} » vise le nœud ${noeud}, absent du graphe`); continue }
    wf[noeud].inputs[entree] = valeurs[cle]
    applied.push(`déclaré (${d.fichier}) : ${cle} → #${noeud}.${entree}`)
  }
  return wf
}

/** Insère des LoraLoaderModelOnly en fin de chaîne MODEL (après la dernière
 *  LoRA de la recette, sinon sur l'UNETLoader). Exportée pour les graphes
 *  construits en code (pinceau). Modifie `out` en place. */
export function empilerLoras(out, loras, applied = [], skipped = []) {
  // Ancre = dernière LoraLoaderModelOnly de la recette (turbo, accélération).
  // À défaut — recette sans aucune LoRA — on empile directement sur
  // l'UNETLoader (chaîne MODEL de départ). Ainsi les LoRA s'appliquent même
  // sur une recette nue.
  /* Paire Wan haut / bas bruit : une LoRA dont le NOM dit son étage
     (« …high_noise… », « …low_noise… ») va sur la chaîne de cet étage, une à la
     fois. Les autres gardent l'ancrage historique ci-dessous. */
  const etage = n => /high[_-]?noise/i.test(n) ? 'high' : /low[_-]?noise/i.test(n) ? 'low' : null
  // UNETLoader ou UnetLoaderGGUF : la recette T2V charge son étage bas bruit en GGUF Q8
  const unets = [...findByClass(out, 'UNETLoader'), ...findByClass(out, 'UnetLoaderGGUF')]
  const unetDe = e => unets.find(id => (e === 'high' ? /high[_-]?noise/i : /low[_-]?noise/i).test(String(out[id].inputs?.unet_name ?? '')))
  const nomDe = l => typeof l === 'string' ? l : l?.name
  if (unetDe('high') && unetDe('low') && loras.some(l => etage(String(nomDe(l) ?? '')))) {
    const parEtage = { high: [], low: [] }, communes = []
    for (const l of loras) { const e = etage(String(nomDe(l) ?? '')); (e ? parEtage[e] : communes).push(l) }
    for (const e of ['high', 'low']) {
      // bout de la chaîne MODEL de cet étage : on descend les LoraLoaderModelOnly
      let bout = unetDe(e)
      for (;;) {
        const suiv = Object.entries(out).find(([, n]) => n.class_type === 'LoraLoaderModelOnly'
          && Array.isArray(n.inputs?.model) && String(n.inputs.model[0]) === bout)
        if (!suiv) break
        bout = suiv[0]
      }
      empilerSur(out, bout, [...parEtage[e], ...communes], applied, skipped)
    }
    return { applied, skipped }
  }
  const idNodes = findByClass(out, 'LoraLoaderModelOnly')
  const anchor = idNodes.length ? idNodes[idNodes.length - 1] : findByClass(out, 'UNETLoader')[0]
  if (!anchor) {
    skipped.push(`${loras.length} LoRA additionnelle(s) NON injectée(s) : `
      + 'aucun nœud modèle (LoraLoaderModelOnly ni UNETLoader) où les empiler')
  } else empilerSur(out, anchor, loras, applied, skipped)
  return { applied, skipped }
}

function empilerSur(out, anchor, loras, applied, skipped) {
  {
    let upstream = anchor
    // Les recettes vidéo (minimax) portent des ids non numériques hérités
    // d'un sous-graphe : « 105:6 », « vbvr ». Number() les rend NaN, et un
    // seul NaN empoisonne Math.max → id « NaN » qui écrase. On ne garde que
    // les ids finis pour choisir le prochain entier libre (0 = plancher).
    let nextId = Math.max(0, ...Object.keys(out).map(Number).filter(Number.isFinite)) + 1
    for (const l of loras) {
      const name = typeof l === 'string' ? l : l?.name
      const strength = Number(typeof l === 'string' ? 1 : l?.strength)
      if (!name) { skipped.push('LoRA additionnelle sans nom — ignorée'); continue }
      const id = String(nextId++)
      // Rebrancher les consommateurs de `upstream` AVANT d'ajouter le nœud,
      // sinon on rebrancherait aussi sa propre entrée sur lui-même.
      for (const n of Object.values(out)) {
        for (const [k, v] of Object.entries(n.inputs || {}))
          if (Array.isArray(v) && String(v[0]) === upstream && v[1] === 0) n.inputs[k] = [id, 0]
      }
      out[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: [upstream, 0],
          lora_name: name,
          strength_model: Number.isFinite(strength) ? strength : 1,
        },
      }
      applied.push(`#${id} LoraLoaderModelOnly = ${name} @ ${out[id].inputs.strength_model} `
        + `(empilée après #${upstream})`)
      upstream = id
    }
  }
}

export function injectJob(wf, { cameraPose, positive, negative, seed, jobId, identityPreamble, width, height, loras, sourceImage, t2v, controlNet, withAudio, videoSeconds, videoAspect, videoSrcDims, videoMegapixels, endImage, videoSteps, opTag }) {
  const out = structuredClone(wf)
  const applied = []
  const skipped = []

  /* -- nombre de pas d'échantillonnage --
     Piloté par le moteur (et par le mode brouillon) plutôt que figé dans la
     recette, pour que brouillon et production ne soient pas deux fichiers à
     tenir synchronisés. On n'écrit QUE si l'appelant le demande : un moteur
     qui ne déclare rien garde la valeur de sa recette, inchangée.
     Toute écriture est journalisée — sur une recette à deux étages, le compte
     de nœuds touchés doit sauter aux yeux en provenance. */
  if (Number.isFinite(videoSteps) && videoSteps > 0) {
    const n = Math.max(1, Math.round(videoSteps))
    for (const [id, node] of Object.entries(out))
      if (node.inputs && typeof node.inputs.steps === 'number') {
        const avant = node.inputs.steps
        node.inputs.steps = n
        applied.push(`#${id} ${node.class_type}.steps = ${n} (recette : ${avant})`)
        /* Recette à deux étages (haut bruit puis bas bruit) : la frontière suit
           le compte de pas, sinon le second étage démarrerait hors de la plage. */
        for (const borne of ['start_at_step', 'end_at_step']) {
          const v = node.inputs[borne]
          if (typeof v === 'number' && v > 0 && v <= avant && avant > 0) {
            node.inputs[borne] = Math.round(v * n / avant)
            applied.push(`#${id} ${node.class_type}.${borne} = ${node.inputs[borne]} (recette : ${v})`)
          }
        }
      }
  }

  /* -- recette à instruction ? Décidé AVANT tout, parce que ça change la
        nature du prompt : ajout à une base figée, et non écriture. -- */
  const instruction = instructionEncoders(out)

  /* -- image source : la seule entrée obligatoire d'une recette d'édition --
     Un `LoadImage` unique lève l'ambiguïté ; s'il y en a plusieurs, écrire au
     hasard éditerait la mauvaise image, donc on refuse. */
  if (sourceImage) {
    const loaders = findByClass(out, 'LoadImage')
    if (loaders.length === 1) {
      out[loaders[0]].inputs.image = sourceImage
      applied.push(`#${loaders[0]} LoadImage.image = ${sourceImage}`)
    } else {
      skipped.push(`image source « ${sourceImage} » NON injectée : `
        + `${loaders.length} nœud(s) LoadImage dans la recette — emplacement ambigu`)
    }
  } else if (instruction.length) {
    skipped.push('recette d’édition SANS image source : le graphe éditera '
      + 'l’image littérale de la recette, pas celle de l’opérateur')
  }

  /* -- préambule d'identité : celui de la persona, jamais un littéral de recette --
     Deux emplacements possibles selon la recette :
       1. un StringConcatenate qui colle un texte LITTÉRAL (string_a) devant une
          entrée LIÉE (string_b, la sortie d'un réécriveur dans le graphe). On
          ne se contente pas de « le premier trouvé ».
       2. aucune : la recette encode le prompt directement. Le préambule est
          alors préfixé au texte positif, ce qui revient au même à l'arrivée.
     Voir server/persona.js. */
  let preambleInText = false
  if (instruction.length) {
    // Une instruction d'édition garde l'identité de l'image source. Lui
    // préfixer une description du sujet la transformerait en description de
    // scène — le modèle repeindrait le sujet au lieu de le conserver.
    if (identityPreamble)
      skipped.push(`préambule ${identityPreamble.key} non applicable : recette à `
        + 'instruction, l’identité y vient de l’image source')
  } else if (identityPreamble) {
    const slots = findByClass(out, 'StringConcatenate').filter(id => {
      const i = out[id].inputs || {}
      return typeof i.string_a === 'string' && Array.isArray(i.string_b)
    })
    if (slots.length === 1) {
      out[slots[0]].inputs.string_a = identityPreamble.text
      applied.push(`#${slots[0]} StringConcatenate.string_a = <préambule ${identityPreamble.key}>`)
    } else if (slots.length > 1) {
      // Plusieurs emplacements plausibles : injecter au hasard produirait un
      // prompt faux mais crédible. On préfère la recette telle quelle, signalée.
      skipped.push(`préambule ${identityPreamble.key} NON injecté : ${slots.length} `
        + `StringConcatenate candidats (#${slots.join(', #')}) — emplacement ambigu`)
    } else {
      preambleInText = true
    }
  } else if (identityPreamble === undefined) {
    // `null` est un choix (vidéo, édition, persona vide) et ne
    // mérite pas d'avertissement ; seul l'OUBLI (undefined) en mérite un —
    // la provenance de chaque vidéo portait ce faux « non injecté ».
    skipped.push('aucun préambule d’identité fourni — la recette garde son littéral')
  }

  const finalPositive = preambleInText ? identityPreamble.text + positive : positive

  /* -- prompt d'une recette à instruction : AJOUT à la base figée --
     On n'écrase jamais `prompt` : la base peut porter une consigne de
     conservation écrite dans la recette. Le prompt de la console s'y ajoute
     (« and change the red dress to blue ») dans la même passe ; une base vide
     reçoit l'instruction seule.

     Les autres CLIPTextEncode de la recette ne sont PAS touchés : sans cette
     garde, le repli générique ci-dessous y écrirait le prompt de la console
     sans rien signaler. */
  if (instruction.length) {
    const suffix = (positive || '').trim()
    for (const { id, field } of instruction) {
      const base = out[id].inputs[field] || ''
      if (suffix) {
        // La base se termine par un point ; un suffixe qui commence en
        // minuscule est une CONTINUATION (« and change the red dress to
        // blue »). Recoller tel quel donnerait « …background. and change… » :
        // l'encodeur de Qwen est un modèle de langage, la ponctuation cassée
        // lui coûte. On retire le point dans ce cas, jamais autrement.
        const joined = /^[a-z]/.test(suffix) ? base.replace(/\.\s*$/, '') : base
        out[id].inputs[field] = `${joined} ${suffix}`.trim()
        applied.push(`#${id} ${out[id].class_type}.${field} = <base figée> + <suffixe opérateur>`)
      } else {
        applied.push(`#${id} ${out[id].class_type}.${field} = <base figée> (aucun suffixe)`)
      }
    }
    const untouched = findByClass(out, 'CLIPTextEncode').filter(id => !instruction.some(e => e.id === id))
    if (untouched.length)
      applied.push(`autres encodeurs de texte préservés (#${untouched.join(', #')})`)
    if (negative)
      skipped.push('négatif ignoré : recette à instruction, le négatif y est un '
        + 'encodeur d’images à texte vide et doit le rester')
    if (width || height)
      skipped.push(`dimensions ${width}×${height} ignorées : le cadrage d’une `
        + 'recette d’édition vient de l’image source')
    // LoRA de style d'édition (choisies côté serveur dans une liste fermée)
    if (Array.isArray(loras) && loras.length) empilerLoras(out, loras, applied, skipped)

    // Seed et destination : le chemin générique est en aval du retour, il faut
    // donc les écrire ici. Sans ça le job enregistrerait sa seed tirée au sort
    // alors que le graphe garderait celle, figée, de la recette — la
    // provenance mentirait, et deux jobs « différents » rendraient la même
    // image. Un FaceDetailer éventuel a sa propre seed : elle suit.
    for (const id of [...findByClass(out, 'KSampler'), ...findByClass(out, 'KSamplerAdvanced'),
      ...findByClass(out, 'LanPaint_KSampler'),
      ...findByClass(out, 'FaceDetailer')]) {
      out[id].inputs.seed = seed
      applied.push(`#${id} ${out[id].class_type}.seed = ${seed}`)
    }
    const tag = opTag || 'edit'
    for (const id of findByClass(out, 'SaveImage')) {
      out[id].inputs.filename_prefix = `creatoros/${jobId}/${tag}`
      applied.push(`#${id} SaveImage.filename_prefix = creatoros/${jobId}/${tag}`)
    }
    return { workflow: out, applied, skipped }
  }

  /* -- prompt : là où la recette accepte du texte libre -- */
  const wildcards = findByClass(out, 'ImpactWildcardProcessor')
  for (const id of wildcards) {
    out[id].inputs.populated_text = finalPositive
    out[id].inputs.mode = 'fixed'
    out[id].inputs.seed = seed
    applied.push(`#${id} ImpactWildcardProcessor.populated_text = <prompt> (mode=fixed, seed=${seed})`)
  }
  if (!wildcards.length) {
    /* Trois niveaux, du plus sûr au plus approximatif :
         1. remontée du câblage depuis l'échantillonneur (couvre photo ET vidéo)
         2. encodeur branché en direct sur un KSampler
         3. premier CLIPTextEncode littéral — signalé, parce que c'est un pari.
       Le niveau 1 sert la vidéo : sans lui, LTX recevrait le prompt dans son
       encodeur NÉGATIF et rendrait une vidéo plausible mais sans rapport avec
       le brief. */
    const wired = positiveTextSlots(out)
    const encoders = positiveTextEncoders(out).map(id => `${id}.text`)
    const fallback = findByClass(out, 'CLIPTextEncode')
      .filter(id => typeof out[id].inputs?.text === 'string')
      .slice(0, 1).map(id => `${id}.text`)
    const targets = wired.length ? wired : encoders.length ? encoders : fallback
    if (!wired.length && !encoders.length && fallback.length)
      skipped.push('encodeur positif non identifiable depuis l’échantillonneur — '
        + `repli sur le premier CLIPTextEncode littéral (${fallback[0]})`)
    for (const slot of targets) {
      const i = slot.lastIndexOf('.')
      const id = slot.slice(0, i), field = slot.slice(i + 1)
      out[id].inputs[field] = finalPositive
      applied.push(`#${id} ${out[id].class_type}.${field} = <prompt>`
        + (preambleInText ? ` préfixé du préambule ${identityPreamble.key}` : ''))
    }
    if (!targets.length)
      skipped.push('aucun point d’entrée texte trouvé — le prompt n’a PAS été injecté')
  } else if (preambleInText) {
    applied.push(`préambule ${identityPreamble.key} préfixé au prompt (recette sans emplacement dédié)`)
  }

  /* -- dimensions : paramétrables par job, valeur de recette en défaut -- */
  if (width || height) {
    /* Reconnaissance par MOTIF, pas par liste fermée : chaque nouvelle
       architecture apporte son propre nœud de latent vide
       (EmptyFlux2LatentImage, EmptyHunyuanLatentVideo, EmptyLTXVLatentVideo…),
       et une liste en dur les rate en silence — le job rendrait alors la
       dimension de la recette en faisant croire que le réglage a porté. */
    const latents = Object.entries(out)
      .filter(([, n]) => /^Empty.*Latent/.test(n.class_type)
        && 'width' in (n.inputs ?? {}) && 'height' in (n.inputs ?? {}))
      .map(([id]) => id)
    for (const id of latents) {
      if (width) out[id].inputs.width = width
      if (height) out[id].inputs.height = height
      applied.push(`#${id} ${out[id].class_type} = ${out[id].inputs.width}×${out[id].inputs.height}`)
    }
    if (!latents.length)
      skipped.push(`dimensions ${width}×${height} NON injectées : aucun nœud de latent vide reconnu`)
  }

  /* -- négatif : injecté seulement si la recette a un encodeur qui l'écoute --
     Les recettes Turbo et ZiTC tournent à cfg 1.0 avec ConditioningZeroOut : le
     négatif y est structurellement inerte, on le dit plutôt que de l'écrire dans
     un nœud sans effet. Le code sait néanmoins alimenter un vrai encodeur
     négatif, si une recette à cfg>1 en présente un. */
  if (negative) {
    const sources = new Set()
    for (const n of Object.values(out)) {
      if (n.class_type !== 'KSampler' && n.class_type !== 'KSamplerAdvanced'
      && n.class_type !== 'LanPaint_KSampler') continue
      const g = n.inputs?.negative
      if (Array.isArray(g)) sources.add(String(g[0]))
    }
    const encoders = [...sources].filter(id =>
      out[id]?.class_type === 'CLIPTextEncode' && typeof out[id].inputs?.text === 'string')
    const zeroed = [...sources].filter(id => out[id]?.class_type === 'ConditioningZeroOut')

    for (const id of encoders) {
      out[id].inputs.text = negative
      applied.push(`#${id} CLIPTextEncode.text = <négatif>`)
    }
    if (!encoders.length) {
      skipped.push(zeroed.length
        ? `négatif ignoré : la recette annule le conditionnement négatif (ConditioningZeroOut #${zeroed.join(', #')})`
        : 'négatif ignoré : aucun encodeur négatif identifiable dans la recette')
    }
  }

  /* -- LoRA additionnelles (persona puis job) : empilées en fin de chaîne MODEL --
     Un nœud est INSÉRÉ dans le graphe plutôt que prévu à l'avance dans la
     recette : une LoraLoaderModelOnly présente mais à force 0 chargerait
     quand même le fichier, et exigerait un nom valide même sans sélection.

     Insertion : on reprend le dernier maillon de la chaîne MODEL partant de la
     LoRA d'identité, et on réécrit ses consommateurs vers le nouveau nœud.
     L'ordre compte — l'identité d'abord, le style/la pose ensuite. */
  if (Array.isArray(loras) && loras.length) empilerLoras(out, loras, applied, skipped)

  /* -- ControlNet Z-Image (Fun-CN) : INSÉRÉ, jamais prévu dans la recette --
     Comme pour les LoRA additionnelles, le nœud est ajouté à la volée : le
     laisser dans le fichier obligerait à fournir une image de référence à
     chaque job, y compris ceux qui n'en veulent pas.

     Le « type » n'est pas un paramètre du nœud — le modèle Union déduit la
     modalité de la carte reçue. Choisir depth ou openpose revient donc à
     choisir le PRÉPROCESSEUR. Et `control_context_scale` s'appelle
     `strength` ici : c'est le même curseur. */
  if (controlNet?.file) {
    const { file, type = 'depth', strength = 0.7 } = controlNet
    const samplers = [...findByClass(out, 'KSampler'), ...findByClass(out, 'KSamplerAdvanced')]
    // Le VAE est celui que la recette utilise déjà pour décoder : le nœud de
    // contrôle encode la carte, il doit parler le même espace latent.
    const decode = findByClass(out, 'VAEDecode')[0]
    const vae = decode ? out[decode].inputs.vae : null
    if (!samplers.length || !vae) {
      skipped.push('ControlNet NON injecté : échantillonneur ou VAE introuvable dans la recette')
    } else {
      let next = Math.max(...Object.keys(out).map(Number)) + 1
      const idLoad = String(next++), idPre = String(next++)
      const idPatch = String(next++), idCn = String(next++)
      out[idLoad] = { class_type: 'LoadImage', inputs: { image: file } }
      const PRE = {
        depth: { class_type: 'DepthAnythingV2Preprocessor',
                 inputs: { image: [idLoad, 0], ckpt_name: 'depth_anything_v2_vitl.pth', resolution: 1024 } },
        openpose: { class_type: 'DWPreprocessor',
                    inputs: { image: [idLoad, 0], detect_hand: 'enable', detect_body: 'enable',
                              detect_face: 'enable', resolution: 1024,
                              bbox_detector: 'yolox_l.onnx',
                              pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt' } },
        canny: { class_type: 'Canny',
                 inputs: { image: [idLoad, 0], low_threshold: 0.4, high_threshold: 0.8 } },
      }
      out[idPre] = PRE[type] ?? PRE.depth
      out[idPatch] = { class_type: 'ModelPatchLoader', inputs: { name: CONFIG.controlNetPatch } }

      // On s'intercale sur l'entrée `model` de CHAQUE échantillonneur, en
      // partant de ce qui l'alimentait — et pas du premier UNETLoader venu :
      // les LoRA et le ModelSamplingAuraFlow sont en amont, les
      // court-circuiter reviendrait à générer sans eux.
      const upstream = out[samplers[0]].inputs.model
      out[idCn] = {
        class_type: 'QwenImageDiffsynthControlnet',
        inputs: { model: upstream, model_patch: [idPatch, 0], vae,
                  image: [idPre, 0], strength: Number(strength) },
      }
      for (const sid of samplers) out[sid].inputs.model = [idCn, 0]
      applied.push(`#${idCn} QwenImageDiffsynthControlnet = ${type} @ ${strength} `
        + `(réf ${file}, inséré avant #${samplers.join(', #')})`)
    }
  }

  /* -- seed d'échantillonnage -- */
  const samplers = [
    ...findByClass(out, 'KSampler'),
    ...findByClass(out, 'KSamplerAdvanced'),
    ...findByClass(out, 'LanPaint_KSampler'),
    // RES4LYF — ClownsharKSampler_Beta (res_2m/beta57) porte aussi un `seed`.
    // Sans ça, la seed du job n'atteindrait pas le sampler et tous les rendus
    // partageraient la seed figée de la recette.
    ...findByClass(out, 'ClownsharKSampler_Beta'),
  ]
  for (const id of samplers) {
    /* KSamplerAdvanced lit `noise_seed`, pas `seed` : écrire `seed`
       laissait ComfyUI sur la graine figée de la recette — tous les rendus Wan
       partaient du même bruit, et la provenance affichait une graine qui
       n'avait pas servi. */
    const champ = 'noise_seed' in (out[id].inputs ?? {}) ? 'noise_seed' : 'seed'
    out[id].inputs[champ] = seed
    applied.push(`#${id} ${out[id].class_type}.${champ} = ${seed}`)
  }
  for (const id of findByClass(out, 'RandomNoise')) {
    out[id].inputs.noise_seed = seed
    applied.push(`#${id} RandomNoise.noise_seed = ${seed}`)
  }
  if (!samplers.length && !findByClass(out, 'RandomNoise').length)
    skipped.push('aucun échantillonneur reconnu — la seed n’a PAS été injectée')

  /* -- durée et format de la vidéo -- */
  if (Number.isFinite(videoSeconds)) {
    const note = setVideoDuration(out, videoSeconds)
    if (note) applied.push(note)
    else skipped.push(`durée ${videoSeconds} s NON injectée : aucune entrée de `
      + 'longueur reconnue dans la recette')
  }
  let exactDimsApplied = false
  if (videoAspect === 'origine' && videoSrcDims?.w && videoSrcDims?.h) {
    const notes = setVideoExactDims(out, videoSrcDims.w, videoSrcDims.h,
      Number.isFinite(videoMegapixels) ? videoMegapixels : undefined)
    if (notes.length) { applied.push(...notes); exactDimsApplied = true }
    else skipped.push('format origine NON injecté : ni consommateur de '
      + 'ResolutionSelector ni dimensions littérales dans la recette')
  } else if (videoAspect && videoAspect !== 'origine') {
    const notes = setVideoAspect(out, videoAspect)
    if (notes.length) applied.push(...notes)
    else skipped.push(`format ${videoAspect} NON injecté : ni ResolutionSelector `
      + 'ni dimensions littérales dans la recette')
  }
  let flfWan = null
  /* -- image de FIN (keyframe d'arrivée) --
     Seul MiniMax H3 expose une entrée `last_frame` ; la recette servie ne la
     câble pas (une seule LoadImage, sur `first_frame`). Quand le job fournit
     `endImage`, on INSÈRE une LoadImage et on la branche sur `last_frame` du
     nœud i2v — la recette sur disque ne change pas, l'insertion est
     journalisée. Wan et LTX n'ont pas d'entrée équivalente : signalé, pas
     inventé. */
  if (endImage) {
    const targets = Object.entries(out).filter(([, n]) => /ImageToVideo/.test(n.class_type)
      && (n.inputs && ('last_frame' in n.inputs || 'end_image' in n.inputs || n.class_type === 'MiniMaxH3ImageToVideo')))
    /* Wan 2.2 (Prequel) : WanImageToVideo n'a pas d'entrée de fin, mais
       le nœud cœur WanFirstLastFrameToVideo a les mêmes entrées PLUS end_image.
       La bascule de classe se fait en fin de patch (flfWan) : les réglages de
       durée et de format, plus bas, reconnaissent encore « ImageToVideo ». */
    const wanI2v = !targets.length ? findByClass(out, 'WanImageToVideo') : []
    if (wanI2v.length) {
      const tid = wanI2v[0]
      const idLoad = `${tid.replace(/[^A-Za-z0-9]/g, '_')}_end`
      out[idLoad] = { class_type: 'LoadImage', inputs: { image: endImage } }
      out[tid].inputs.end_image = [idLoad, 0]
      if (!sourceImage) delete out[tid].inputs.start_image
      flfWan = tid
      applied.push(`#${idLoad} LoadImage.image = ${endImage} → #${tid} end_image (keyframe de fin, nœud WanFirstLastFrameToVideo)`
        + (sourceImage ? '' : ' ; start_image débranché (frame de fin seule)'))
    } else if (!targets.length) {
      skipped.push(`image de fin « ${endImage} » NON injectée : aucune entrée last_frame/end_image dans la recette`)
    } else {
      const [tid, tn] = targets[0]
      const slot = 'end_image' in (tn.inputs || {}) ? 'end_image' : 'last_frame'
      const idLoad = `${tid.replace(/[^A-Za-z0-9]/g, '_')}_end`
      out[idLoad] = { class_type: 'LoadImage', inputs: { image: endImage } }
      out[tid].inputs[slot] = [idLoad, 0]
      applied.push(`#${idLoad} LoadImage.image = ${endImage} → #${tid} ${tn.class_type}.${slot} (keyframe de fin)`)
      /* Frame de fin SEULE : on débranche first_frame, sinon le graphe
         partirait de la still littérale de la recette. La LoadImage d'origine
         n'alimente plus rien et n'est pas exécutée. */
      if (!sourceImage && 'first_frame' in (out[tid].inputs || {})) {
        delete out[tid].inputs.first_frame
        applied.push(`#${tid} ${tn.class_type}.first_frame débranché (frame de fin seule)`)
      }
    }
  }

  // Format « origine » : le brouillon est déjà intégré aux dimensions exactes —
  // repasser setVideoMegapixels re-scalerait les littéraux qu'on vient d'écrire.
  if (Number.isFinite(videoMegapixels) && !exactDimsApplied) {
    const notes = setVideoMegapixels(out, videoMegapixels)
    if (notes.length) applied.push(...notes)
    else skipped.push(`brouillon ${videoMegapixels} MP NON injecté : aucun ResolutionSelector `
      + 'dans la recette — rendu à la résolution pleine')
  }

  /* -- texte → vidéo : l'interrupteur de la recette, trouvé par son titre --
     L'image de départ (neutre) reste câblée mais n'est plus lue. Une recette
     sans interrupteur ferait un i2v sur une image noire : on refuse. */
  if (t2v) {
    const ids = Object.entries(out).filter(([, n]) => n?.class_type === 'PrimitiveBoolean'
      && /text\s*to\s*video/i.test(n._meta?.title ?? '')).map(([id]) => id)
    if (!ids.length) throw new Error('recette sans interrupteur « Text to Video » : plan d’ambiance impossible')
    for (const id of ids) { out[id].inputs.value = true; applied.push(`#${id} « ${out[id]._meta.title} » = true (texte → vidéo)`) }
  }

  /* -- rendu muet sur un moteur sonore : l'étage de décodage audio saute --
     Voir stripAudioStage : la diffusion audio n'est PAS séparable, seul son
     décodage l'est. On ne le fait donc que si la recette a bien un étage
     audio ; sur Wan, qui n'en a pas, l'appel ne trouve rien et ne dit rien. */
  if (withAudio === false) {
    const notes = stripAudioStage(out)
    if (notes.length) applied.push(...notes)
  }

  if (flfWan) out[flfWan].class_type = 'WanFirstLastFrameToVideo'

  /* -- destination des fichiers : un dossier par job, traçable -- */
  for (const id of [...findByClass(out, 'SaveImage'), ...findByClass(out, 'Image Save'),
    ...findByClass(out, 'SaveVideo'), ...findByClass(out, 'SaveWEBM')]) {
    out[id].inputs.filename_prefix = `creatoros/${jobId}/out`
    applied.push(`#${id} ${out[id].class_type}.filename_prefix = creatoros/${jobId}/out`)
  }

  /* -- VRAM : décharge le LLM avant la diffusion (cf. CONFIG.ollamaUnload) -- */
  if (CONFIG.ollamaUnload) {
    for (const id of findByClass(out, 'OllamaConnectivityV2')) {
      out[id].inputs.keep_alive = 0
      applied.push(`#${id} OllamaConnectivityV2.keep_alive = 0 (décharge immédiate, anti-OOM)`)
    }
  }

  /* -- trajectoire de caméra (Wan Fun Camera) : mêmes dimensions et durée que la vidéo -- */
  for (const id of findByClass(out, 'WanCameraEmbedding')) {
    const v = Object.values(out).find(n => n.class_type === 'WanCameraImageToVideo')
    for (const k of ['width', 'height', 'length']) if (typeof v?.inputs?.[k] === 'number') out[id].inputs[k] = v.inputs[k]
    if (cameraPose) out[id].inputs.camera_pose = cameraPose
    applied.push(`#${id} WanCameraEmbedding = ${out[id].inputs.camera_pose} ${out[id].inputs.width}×${out[id].inputs.height}, ${out[id].inputs.length} images`)
  }

  return { workflow: out, applied, skipped }
}

/* ---------- rendu photo en 2 MP ----------
   Krea rend DIRECTEMENT en 2 MP : le latent est agrandi au ratio demandé,
   1088 de petit côté en portrait (recadré à 1080 de large — 1080 n'est pas
   un multiple de 16), 1920 de large en paysage (cadrage
   gardé). Ni doublon ni corps étiré, même cadrage qu'en 1 MP, ~14,6 s par
   image, plus rapide qu'une chaîne SeedVR2 + visage (~18,5 s). */
export function rendre2MP(out) {
  const lat = [...findByClass(out, 'EmptySD3LatentImage'), ...findByClass(out, 'EmptyLatentImage')][0]
  const save = findByClass(out, 'SaveImage')[0]
  if (!lat || !save) return { notes: [], manque: 'recette sans latent vide ni SaveImage reconnaissables' }
  const w = Number(out[lat].inputs.width), h = Number(out[lat].inputs.height)
  const portrait = h >= w
  const nw = portrait ? 1088 : 1920
  const nh = Math.round(nw * h / w / 16) * 16
  Object.assign(out[lat].inputs, { width: nw, height: nh })
  const notes = [`2 MP direct : latent ${w}×${h} → ${nw}×${nh}`]
  if (portrait) {
    out.recadre_1080 = { class_type: 'ImageCrop', inputs: { image: out[save].inputs.images, width: 1080, height: nh, x: 4, y: 0 } }
    out[save].inputs.images = ['recadre_1080', 0]
    notes.push(`recadré à 1080×${nh}`)
  }
  return { notes }
}

/* ---------- dialogue HTTP avec ComfyUI ---------- */

async function comfy(pathname, init) {
  const res = await fetch(CONFIG.comfyUrl + pathname, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ComfyUI ${pathname} → HTTP ${res.status} ${body.slice(0, 1200)}`)
  }
  return res
}

/** Retire un prompt encore en attente dans la file de ComfyUI. */
export async function deleteQueued(promptId) {
  if (String(promptId).startsWith('sdk:')) return sdk.annuler(promptId)
  await comfy('/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  })
}

/** Décharge les modèles résidents (VRAM) — avant un refine Wan, les modèles
 *  H3 encore chargés forcent l'offload CPU du refine (87 % offloadé mesuré,
 *  7 min au lieu de ~3). */
export async function freeMemory() {
  if (sdk.surSdk()) return   // la mémoire de la carte n'est pas la nôtre
  await comfy('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }) })
}

/** Interrompt un prompt précis s'il est en cours d'exécution. Avec un
 *  prompt_id, ComfyUI n'interrompt que lui : un ComfyUI partagé avec une autre
 *  application ne perd pas le rendu de celle-ci. */
export async function interrupt(promptId) {
  if (String(promptId).startsWith('sdk:')) return sdk.annuler(promptId)
  await comfy('/interrupt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
  })
}

/* ---------- progression en direct ----------
   ComfyUI pousse `progress` (value/max, par nœud) sur sa WebSocket. Ce n'est
   pas une estimation fiable de bout en bout — value/max ne couvrent que le
   nœud en cours — mais c'est exactement ce que l'interface de ComfyUI
   affiche.
   L'ETA est déduite du rythme observé sur le nœud courant. */
const progressByPrompt = new Map()
let ws = null
/* Aperçu en direct. ComfyUI n'envoie ses images d'aperçu qu'au client qui a
   soumis le rendu : l'écoute et les soumissions partagent donc le même identifiant.
   L'aperçu est demandé rendu par rendu (`preview_method` dans extra_data), sans
   toucher au lancement de ComfyUI. On garde la dernière image de chaque rendu. */
const CLIENT_WS = 'creatoros-' + Math.random().toString(36).slice(2, 12)
// l'arbitrage de la carte reconnaît ainsi les rendus du studio dans la file de ComfyUI (les autres = la production)
definirClientStudio(CLIENT_WS)
const apercus = new Map()              // prompt_id → { buf, mime, at }
let promptEnCours = null
function noteApercu(data) {
  const b = Buffer.from(data)
  if (b.length < 16) return
  const type = b.readUInt32BE(0)
  let id = promptEnCours, mime = 'image/jpeg', image = null
  if (type === 1) { mime = b.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'; image = b.subarray(8) }
  else if (type === 4) {
    const n = b.readUInt32BE(4)
    try { const meta = JSON.parse(b.subarray(8, 8 + n).toString('utf8')); id = meta.prompt_id ?? id; mime = meta.image_type ?? mime } catch { /* métadonnées illisibles */ }
    image = b.subarray(8 + n)
  }
  if (!id || !image?.length) return
  apercus.set(id, { buf: image, mime, at: Date.now() })
  if (apercus.size > 6) apercus.delete(apercus.keys().next().value)
}
/** Dernier aperçu d'un rendu, s'il a moins de deux minutes. */
export const getApercu = promptId => { const a = apercus.get(promptId); return a && Date.now() - a.at < 120_000 ? a : null }
/* Liaison avec ComfyUI : la WebSocket tombe quand il s'arrête et revient
   quand il a redémarré. On en tire un état « redémarre » distinct de « en panne »,
   et un signal de retour sur lequel le serveur relance le diagnostic. */
const liaison = { coupeLe: null, revenuLe: null, coupureMs: null }
const auRetour = []
export const onRetourComfy = cb => { auRetour.push(cb) }
/** 'ok' · 'redemarre' (coupé depuis moins de 3 min) · 'panne'. */
export const etatLiaison = () => ({
  etat: !liaison.coupeLe ? 'ok' : Date.now() - liaison.coupeLe < 180_000 ? 'redemarre' : 'panne',
  coupeLe: liaison.coupeLe, revenuLe: liaison.revenuLe, coupureMs: liaison.coupureMs,
})

function connectProgress() {
  try {
    ws = new WebSocket(CONFIG.comfyUrl.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_WS)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', ev => {
      try {
        if (typeof ev.data !== 'string') { noteApercu(ev.data); return }
        const m = JSON.parse(ev.data)
        if (m.data?.prompt_id) promptEnCours = m.data.prompt_id
        if (m.type === 'executing' && m.data?.prompt_id && m.data.node) { noteNoeud(m.data.prompt_id, m.data.node); return }
        if (m.type !== 'progress' || !m.data) return
        const id = m.data.prompt_id
        if (!id) return
        if (m.data.node) noteNoeud(id, m.data.node)
        const prev = progressByPrompt.get(id)
        const now = Date.now()
        const p = prev && prev.node === (m.data.node ?? null) ? prev
          : { node: m.data.node ?? null, t0: now, v0: m.data.value }
        p.value = m.data.value; p.max = m.data.max; p.at = now
        progressByPrompt.set(id, p)
        // Une entrée par rendu, purgée au fil de l'eau — pas de fuite.
        if (progressByPrompt.size > 50) {
          const oldest = [...progressByPrompt.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          progressByPrompt.delete(oldest[0])
        }
      } catch { /* trame illisible : ignorée */ }
    })
    ws.addEventListener('open', () => {
      if (!liaison.coupeLe) return
      liaison.revenuLe = Date.now(); liaison.coupureMs = liaison.revenuLe - liaison.coupeLe; liaison.coupeLe = null
      for (const cb of auRetour) Promise.resolve().then(cb).catch(() => {})
    })
    ws.addEventListener('close', () => { liaison.coupeLe ??= Date.now(); setTimeout(connectProgress, 2000) })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* déjà fermée */ } })
  } catch { setTimeout(connectProgress, 5000) }
}
connectProgress()

/* ---------- phase en clair ----------
   « rendu » ne dit rien sur une vidéo de 40 minutes : on nomme ce que fait le
   nœud en cours, d'après sa classe dans le graphe soumis. Tant qu'aucun nœud
   ne s'est signalé, les modèles se chargent. */
const classesByPrompt = new Map()      // prompt_id → { nœud: classe }
const noeudByPrompt = new Map()        // prompt_id → nœud en cours
function noteNoeud(id, node) {
  noeudByPrompt.set(id, String(node))
  if (noeudByPrompt.size > 50) noeudByPrompt.delete(noeudByPrompt.keys().next().value)
}
const PHASES = [
  [/sampler|ksampler|samplercustom/i, 'calcul des images'],
  [/vaedecode|decode/i, 'décodage'],
  [/vaeencode|encode(?!r)/i, 'encodage'],
  [/unetloader|checkpointloader|cliploader|vaeloader|loraloader|modelpatch|loader/i, 'chargement des modèles'],
  [/sam3|sam2|grounding|dwpose|sdpose|detect|track/i, 'détection'],
  [/rife|interp|film/i, 'fluidité'],
  [/upscale|seedvr/i, 'agrandissement'],
  [/save|createvideo|videocombine/i, 'enregistrement'],
]
export function getPhase(promptId) {
  const classes = classesByPrompt.get(promptId)
  if (!classes) return null
  const node = noeudByPrompt.get(promptId)
  if (!node) return 'chargement des modèles'
  const cl = classes[node] ?? classes[node.split('.').pop()] ?? ''
  return PHASES.find(([re]) => re.test(cl))?.[1] ?? 'calcul'
}

/** Progression du prompt : { value, max, etaS } ou null. */
export function getProgress(promptId) {
  const p = progressByPrompt.get(promptId)
  if (!p || !p.max) return null
  const done = p.value - p.v0
  const rate = done > 0 ? (p.at - p.t0) / done : null
  return {
    value: p.value, max: p.max,
    etaS: rate ? Math.round((p.max - p.value) * rate / 1000) : null,
  }
}

export async function ping() {
  const r = await comfy('/system_stats')
  return r.json()
}

/** Attend que ComfyUI réponde. Au boot de la machine, les deux services
 *  partent ensemble : `After=comfyui.service` ne garantit que l'ORDRE de
 *  lancement, pas que le serveur écoute — ComfyUI met ~10 s à charger ses
 *  nœuds, CreatorOS 2 s à se construire : une reprise trop tôt finit en
 *  « fetch failed ». */
export async function waitReady({ maxMs = 10 * 60 * 1000, everyMs = 2000 } = {}) {
  if (sdk.surSdk()) return 0
  const t0 = Date.now()
  let warned = false
  for (;;) {
    try { await ping(); return Date.now() - t0 } catch (e) {
      if (!warned) { warned = true; console.log(`[comfy] pas encore joignable (${e.message || e}) — attente`) }
      if (Date.now() - t0 > maxMs) throw new Error(`ComfyUI injoignable après ${Math.round(maxMs / 1000)} s`)
      await sleep(everyMs)
    }
  }
}

/** Le prompt est-il encore CONNU de ComfyUI (en file, en cours, ou dans
 *  l'historique) ? Après un redémarrage de ComfyUI lui-même — coupure,
 *  crash — sa file en mémoire est perdue : un prompt inconnu ne finira
 *  jamais, il faut le re-soumettre, pas l'attendre. */
export async function promptKnown(promptId) {
  if (String(promptId).startsWith('sdk:')) return null   // le handle ne survit pas à un redémarrage
  const hist = await (await comfy(`/history/${promptId}`)).json()
  if (hist[promptId]) return 'history'
  const q = await (await comfy('/queue')).json()
  if ((q.queue_running || []).some(e => e[1] === promptId)) return 'running'
  if ((q.queue_pending || []).some(e => e[1] === promptId)) return 'pending'
  return null
}

export async function submitPrompt(workflow, clientId) {
  if (sdk.surSdk()) return sdk.soumettre(workflow)
  // petite carte : chargeurs lourds remplacés par leurs variantes allégées (cf. allege.js)
  const a = await alleger(workflow)
  if (a.remplaces.length) {
    workflow = a.graphe
    console.log(`[allégé] ${a.remplaces.map(([de, vers]) => `${de} → ${vers}`).join(' ; ')}`)
  }
  const res = await fetch(CONFIG.comfyUrl + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // client_id = celui de l'écoute (aperçus) ; `clientId` de l'appelant n'a plus d'usage côté ComfyUI
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_WS, extra_data: { preview_method: 'latent2rgb' } }),
  })
  const text = await res.text()
  if (!res.ok) {
    // ComfyUI renvoie un 400 détaillé (node_errors) quand le graphe est invalide :
    // dit en clair pour l'opérateur, entier dans le journal (cf. erreurs.js).
    console.warn(`[comfy] refus HTTP ${res.status} : ${text.slice(0, 4000)}`)
    throw new Error(erreurSoumission(text))
  }
  const json = JSON.parse(text)
  if (json.node_errors && Object.keys(json.node_errors).length) {
    console.warn(`[comfy] erreurs de nœuds : ${JSON.stringify(json.node_errors).slice(0, 4000)}`)
    throw new Error(erreurSoumission(json))
  }
  // classes des nœuds du graphe, pour nommer la phase en cours (cf. getPhase)
  classesByPrompt.set(json.prompt_id, Object.fromEntries(Object.entries(workflow).map(([k, v]) => [k, v?.class_type ?? ''])))
  if (classesByPrompt.size > 50) classesByPrompt.delete(classesByPrompt.keys().next().value)
  return json.prompt_id
}

/** Attend la fin d'exécution. `onPhase` reçoit 'queued' puis 'rendering'. */
export async function waitForPrompt(promptId, { onPhase, timeoutMs = CONFIG.jobTimeoutMs } = {}) {
  if (String(promptId).startsWith('sdk:')) return sdk.attendreFin(promptId, { onPhase, timeoutMs })
  const t0 = Date.now()
  let phase = null
  for (;;) {
    const hist = await (await comfy(`/history/${promptId}`)).json()
    if (hist[promptId]) return hist[promptId]

    const q = await (await comfy('/queue')).json()
    const running = (q.queue_running || []).some(e => e[1] === promptId)
    const pending = (q.queue_pending || []).some(e => e[1] === promptId)
    const next = running ? 'rendering' : 'queued'
    if (next !== phase) { phase = next; onPhase?.(next) }

    /* Le délai ne s'applique qu'à un prompt DISPARU sans historique — un
       crash, pas un long rendu. Tant que ComfyUI le tient (en cours ou en
       attente), on attend : un long rendu motion ne doit pas passer pour
       « bloqué ». */
    if (!running && !pending && Date.now() - t0 > timeoutMs)
      throw new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s) sans résultat`)
    await sleep(1000)
  }
}

/** Extrait les images d'une entrée d'historique, et remonte l'échec
 *  d'exécution s'il y en a un (statut non « success »). */
export function outputsOf(history) {
  const status = history.status || {}
  const images = []
  for (const out of Object.values(history.outputs || {}))
    for (const img of out.images || [])
      // « temp » : aperçus ; « input » : le fichier d'entrée montré par un nœud de chargement, pas un rendu
      if (img.type !== 'temp' && img.type !== 'input') images.push(img)

  if (!status.completed) {
    const msgs = (status.messages || [])
      .filter(m => m[0] === 'execution_error' || m[0] === 'execution_interrupted')
      .map(m => JSON.stringify(m[1]).slice(0, 4000))
    if (msgs.length) console.warn(`[comfy] exécution non terminée (${status.status_str || 'inconnu'}) ${msgs.join(' | ')}`)
    throw new Error(erreurExecution(status))
  }
  return images
}

/** Textes renvoyés par le graphe (PreviewAny, ShowText…).
 *  Sur une recette qui réécrit le prompt dans le graphe, c'est le prompt
 *  final — donc la trace de ce qu'un token wildcard `__…__` a RÉELLEMENT donné.
 *  Sans ça, un tirage au hasard serait irreproductible à la lecture. */
export function textsOf(history) {
  const out = []
  for (const o of Object.values(history.outputs || {})) {
    const t = o.text
    if (!t) continue
    for (const v of (Array.isArray(t) ? t : [t]))
      if (typeof v === 'string' && v.trim()) out.push(v)
  }
  return out
}

/** Récupère les octets d'une image : disque local d'abord (même
 *  machine), endpoint /view en repli si l'arborescence diffère. */
export async function readImage(img) {
  if (img.__sdk) return sdk.lireSortie(img)
  const local = path.join(CONFIG.comfyOutput, img.subfolder || '', img.filename)
  if (fs.existsSync(local)) return fs.readFileSync(local)
  const qs = new URLSearchParams({
    filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
  })
  return Buffer.from(await (await comfy('/view?' + qs)).arrayBuffer())
}

/** Dimensions PNG lues dans l'IHDR (aucune dépendance image). */
export function pngSize(buf) {
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR')
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  return { width: null, height: null }
}

/* ---------- inventaire des LoRA ----------
   Le front doit pouvoir CHOISIR une LoRA, donc il lui faut la liste réelle.
   Deux pièges que cette fonction traite plutôt que de les laisser à l'appelant :

   1. Toutes les LoRA du dossier ne sont pas compatibles Z-Image. Une LoRA Flux
      ou Wan chargée sur un graphe Z-Image ne produit pas une erreur franche —
      ComfyUI applique ce qu'il peut et rend une image plausible mais fausse.
      On classe donc par ARCHITECTURE, en lisant l'en-tête safetensors :
        Z-Image : diffusion_model.layers.<n>.attention|feed_forward
        Flux 1  : lora_unet_double_blocks_*
        Flux 2  : diffusion_model.double_blocks.*
      Le nom de fichier ne prouve rien.

   2. Lire 150 en-têtes à chaque appel serait gâché : on mémorise par
      (taille, mtime), donc un fichier remplacé est reclassé, pas servi périmé. */

const loraCache = new Map()

/** Lit l'en-tête safetensors UNE fois et en tire deux choses : l'architecture
 *  (par les clés de tenseurs) et le mot déclencheur (par les métadonnées).
 *
 *  LE DÉCLENCHEUR EST LE POINT SENSIBLE. Sans lui dans le prompt, une LoRA de
 *  pose est chargée, consomme de la VRAM, et n'agit pas — l'image sort
 *  plausible et l'opérateur croit que la LoRA est faible. Trois sources, par
 *  ordre de fiabilité DÉCROISSANTE, et `triggerSource` dit toujours laquelle :
 *
 *    `tags`   ss_tag_frequency — ce que les légendes contenaient réellement à
 *             l'entraînement. C'est une preuve, pas une supposition.
 *    `nom`    ss_output_name / name — plausible mais NON VÉRIFIÉ : rien ne dit
 *             que le nom de sortie était le mot des légendes. À afficher comme
 *             une proposition que l'opérateur confirme.
 *    `aucun`  ni l'un ni l'autre (LoRA exportées par diffusers, par exemple).
 *             L'opérateur DOIT le saisir, sinon la LoRA restera inerte.
 *
 *  Mémorisé par (taille, mtime) : un fichier remplacé est relu, pas servi périmé. */
function loraProbe(file) {
  let st
  try { st = fs.statSync(file) } catch { return { arch: 'illisible', trigger: null, triggerSource: 'aucun' } }
  const key = `${file}:${st.size}:${st.mtimeMs}`
  const hit = loraCache.get(file)
  if (hit && hit.key === key) return hit.probe

  let probe = { arch: 'inconnue', trigger: null, triggerSource: 'aucun' }
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const len = Buffer.alloc(8)
      fs.readSync(fd, len, 0, 8, 0)
      const n = Number(len.readBigUInt64LE(0))
      // Garde-fou : un en-tête safetensors sain fait quelques centaines de Ko.
      if (n > 0 && n < 64 * 1024 * 1024) {
        const head = Buffer.alloc(n)
        fs.readSync(fd, head, 0, n, 8)
        const parsed = JSON.parse(head.toString('utf8'))
        const keys = Object.keys(parsed)

        /* Krea 2 et FLUX.2 Klein : d'abord ce que le fichier déclare
           (modelspec / kohya), puis les clés propres à Krea 2 (porte
           d'attention `attn.gate` + `wk`, tours `txtfusion`). */
        const meta = parsed.__metadata__ || {}
        const decl = `${meta['modelspec.architecture'] ?? ''} ${meta.ss_base_model_version ?? ''} ${meta.ss_sd_model_name ?? ''}`.toLowerCase()
        // FLUX 3 Image Klein (ai-toolkit : ss_base_model_version flux3, blocs content_mode_blocks)
        if (/flux[._-]?3/.test(decl) || keys.some(k => /content_mode_blocks\./.test(k))) probe.arch = 'flux3'
        else if (/krea/.test(decl) || keys.some(k => /(^|\.)txtfusion\.|blocks[._]\d+[._]attn[._]gate/.test(k))) probe.arch = 'krea2'
        else if (/klein|flux[._-]?2/.test(decl)) probe.arch = 'flux2'
        else if (keys.some(k => /^diffusion_model\.layers\.\d+\.(attention|feed_forward)/.test(k))) probe.arch = 'zimage'
        else if (keys.some(k => k.startsWith('lora_unet_double_blocks'))) probe.arch = 'flux1'
        else if (keys.some(k => k.startsWith('diffusion_model.double_blocks'))) probe.arch = 'flux2'
        // MiniMax H3 (vidéo). Deux marqueurs propres à H3, dont au moins un
        // suffit : attention à QKV FUSIONNÉ (`attn.qkv_proj` / `attn.out_proj`)
        // et MLP nommé `mlp.fc1/fc2` (certaines H3, comme l'AIO, n'entraînent
        // QUE les MLP). Discriminant face à Wan, qui partage le préfixe
        // `diffusion_model.blocks.N.…` mais sépare `self_attn.q/k/v`, ajoute
        // `cross_attn` et nomme son MLP `ffn.0/ffn.2` (jamais `attn.qkv_proj`
        // ni `mlp.fc`). Sans ce resserrement, les LoRA Wan passaient pour des
        // H3 et étaient proposées à l'empilage minimax — arch fausse, bruit.
        else if (keys.some(k =>
          /^diffusion_model\.(token_refiner\.)?blocks\.\d+\.(attn\.(qkv_proj|out_proj)|mlp\.fc)/.test(k)
          // Même arch H3 mais en nommage kohya/sd-scripts : `lora_unet_blocks_N_attn_qkv_proj`
          // (underscores). Le `qkv_proj` FUSIONNÉ reste le discriminant face à Wan,
          // et `blocks_` (non `double_blocks_`) le distingue de Flux.
          || /^lora_unet_blocks_\d+_(attn_(qkv_proj|out_proj)|mlp_fc)/.test(k)
        )) probe.arch = 'h3'

        const m = parsed.__metadata__ || {}
        // ss_tag_frequency : { "1_<tag>": { "<tag>": n } } — le préfixe « 1_ »
        // est le nombre de répétitions du dossier, pas une partie du mot.
        try {
          const tf = typeof m.ss_tag_frequency === 'string'
            ? JSON.parse(m.ss_tag_frequency) : m.ss_tag_frequency
          const bucket = tf && Object.keys(tf)[0]
          const tag = bucket && Object.keys(tf[bucket] || {})[0]
          if (tag) { probe.trigger = tag; probe.triggerSource = 'tags' }
        } catch { /* métadonnée illisible : on retombe sur le nom */ }

        if (!probe.trigger) {
          const named = m.ss_output_name || m.name
          /* identifiants de job d'entraînement (Civitai « training_<id>-<ts> »,
             « epoch_N ») : pas des déclencheurs — les injecter polluerait le
             prompt pour rien. Mieux vaut aucun trigger. */
          if (typeof named === 'string' && named.trim()
              && !/^(training_\d+|epoch_\d+|last|lora)\b/i.test(named.trim())) {
            probe.trigger = named.trim()
            probe.triggerSource = 'nom'
          }
        }
      }
    } finally { fs.closeSync(fd) }
  } catch { probe = { arch: 'illisible', trigger: null, triggerSource: 'aucun' } }

  loraCache.set(file, { key, probe })
  return probe
}

/* Table de triggers opérateur (<données>/loras_triggers.json) : PRIORITAIRE
   sur le header — les textes d'activation Civitai sont souvent absents du
   fichier ou trop longs pour ses métadonnées. Relue sur mtime. */
const TRIGGER_TABLE_FILE = path.join(CONFIG.dataDir, 'loras_triggers.json')
let _trigTable = { mtime: 0, data: {} }
function triggerTable() {
  try {
    const st = fs.statSync(TRIGGER_TABLE_FILE)
    if (st.mtimeMs !== _trigTable.mtime)
      _trigTable = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(TRIGGER_TABLE_FILE, 'utf8')) }
  } catch { _trigTable = { mtime: 0, data: {} } }
  return _trigTable.data
}
function withTable(name, probe) {
  const t = triggerTable()[name]
  return typeof t === 'string' && t.trim() ? { ...probe, trigger: t.trim(), triggerSource: 'table' } : probe
}

/** Rangement : une LoRA déclarée par la persona est son identité — elle n'a
 *  rien à faire dans un sélecteur de style, elle est déjà posée par le
 *  serveur. Tout le reste est offert sans restriction de registre. */
function loraTags(name) {
  if (personaLoraNames().has(name)) return { kind: 'identite', scope: 'identite' }
  return { kind: 'style', scope: 'all' }
}

/** Fiche d'UNE LoRA par son nom de fichier. Le serveur résout ainsi le
 *  déclencheur lui-même plutôt que de faire confiance à ce que le front
 *  envoie — un front périmé enverrait un mot obsolète et la LoRA serait
 *  chargée pour rien. */
export function loraInfo(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) return null
  const full = path.join(CONFIG.lorasDir, name)
  if (!full.startsWith(CONFIG.lorasDir + path.sep) || !fs.existsSync(full)) return null
  return { name, ...withTable(name, loraProbe(full)), ...loraTags(name) }
}

/** Liste des LoRA du dossier, classées. `arch` dit ce qui est réellement
 *  chargeable sur les recettes Z-Image ; le reste est renvoyé quand même,
 *  marqué, pour que l'interface puisse l'afficher grisé plutôt que de le
 *  faire disparaître sans explication. */
export function listLoras() {
  let files = []
  try {
    files = fs.readdirSync(CONFIG.lorasDir).filter(f => f.endsWith('.safetensors'))
  } catch (e) {
    return { dir: CONFIG.lorasDir, error: String(e.message || e), loras: [] }
  }
  const loras = files.sort().map(name => {
    const full = path.join(CONFIG.lorasDir, name)
    let bytes = null
    try { bytes = fs.statSync(full).size } catch { /* lien cassé : signalé par arch */ }
    return { name, ...withTable(name, loraProbe(full)), ...loraTags(name), bytes }
  })
  return { dir: CONFIG.lorasDir, loras }
}

/** Image neutre pour les recettes qui gardent un LoadImage câblé en texte →
 *  vidéo : écrite une fois dans input/ (gris uni 896×1600, PNG). */
export function imageVideT2v() {
  const nom = 'creatoros_t2v_neutre.png'
  const f = path.join(CONFIG.comfyInput, nom)
  if (!fs.existsSync(f)) {
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=896x1600', '-frames:v', '1', f])
    if (r.status !== 0 || !fs.existsSync(f)) throw new Error('image neutre du texte → vidéo non écrite (ffmpeg)')
  }
  return nom
}
