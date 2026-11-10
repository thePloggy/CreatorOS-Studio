/* ComfyUI client: loads an API-format recipe, injects the CreatorOS job,
   posts it, tracks its execution and fetches the output.

   ImpactWildcardProcessor: "populate" mode runs in the browser before
   submission; the node itself only reads `populated_text`. So we write
   `populated_text` and switch `mode` to "fixed". */
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

/* ---------- recipe loading ---------- */

export function loadWorkflow(file) {
  const full = path.join(CONFIG.workflowsDir, file)
  // Reject names that would escape the workflows directory.
  if (!full.startsWith(CONFIG.workflowsDir + path.sep)) throw new Error('workflow hors périmètre')
  const wf = JSON.parse(fs.readFileSync(full, 'utf8'))
  const bad = Object.entries(wf).filter(([, n]) => !n || typeof n !== 'object' || !n.class_type)
  if (bad.length) throw new Error(`${file} n'est pas au format API (nœud ${bad[0][0]} sans class_type)`)
  return wf
}

export const listWorkflows = () =>
  fs.readdirSync(CONFIG.workflowsDir).filter(f => f.endsWith('.json') && !f.endsWith('.pilotage.json')).sort()

/** Readable summary of a recipe: base model, LoRAs, sampling.
 *  Tolerant: an unusual recipe yields a partial summary rather than an error. */
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

/* ---------- recipe editing from the Workbench ----------
   The Workbench edits the served files directly. `loadWorkflow` rereads the
   disk on every job (no cache), so a write takes effect on the next job;
   hence validation is mandatory on write. */

/** Absolute path of a recipe, with the scope guard.
 *  Bare file name only: no separator, no `..`, no absolute path. */
export function workflowPath(file) {
  if (typeof file !== 'string' || !file.endsWith('.json'))
    throw new Error('nom de recette invalide : un fichier .json est attendu')
  if (file.includes('/') || file.includes('\\') || file.includes('..'))
    throw new Error(`nom de recette invalide : « ${file} » n’est pas un nom de fichier nu`)
  const full = path.join(CONFIG.workflowsDir, file)
  if (!full.startsWith(CONFIG.workflowsDir + path.sep)) throw new Error('recette hors périmètre')
  return full
}

/** Raw content + mtime. `mtimeMs` is a concurrency token used to reject a
 *  write based on a stale version. */
export function readWorkflowRaw(file) {
  const full = workflowPath(file)
  const st = fs.statSync(full)
  return { file, text: fs.readFileSync(full, 'utf8'), mtimeMs: st.mtimeMs, bytes: st.size }
}

/** Checks that a text is a playable ComfyUI API-format recipe.
 *  Returns a summary, or throws with a human-readable message. */
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
    // A link to a missing node passes ComfyUI validation but fails at execution.
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

/** Writes a recipe, in order:
 *  1. validation: never write an unplayable recipe;
 *  2. concurrency: refuse if the file changed since it was read;
 *  3. timestamped backup, then atomic write. */
export function writeWorkflow(file, text, baseMtimeMs) {
  const full = workflowPath(file)
  const summary = validateWorkflowText(text)

  const exists = fs.existsSync(full)
  if (exists && Number.isFinite(baseMtimeMs)) {
    const cur = fs.statSync(full).mtimeMs
    // 1 ms tolerance: some file systems round mtimes.
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

/** Text encoders wired directly to a sampler's POSITIVE input, so the prompt
 *  never lands in the negative encoder. */
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

/* ---------- locating the prompt by wiring ----------
   `positiveTextEncoders` only finds an encoder wired directly to a KSampler.
   Video recipes go through guiders (LTXVDualCFGGuider, BasicGuider) or
   WanImageToVideo, and the first literal CLIPTextEncode on LTX is the negative.
   So we walk the graph up from the samplers, following only the inputs that
   carry POSITIVE conditioning (LTXVConditioning and WanImageToVideo carry both). */
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

/** Terminal nodes that hold the text, and the field to write. */
const TEXT_SLOT = {
  CLIPTextEncode: 'text',
  MiniMaxH3ImageToVideo: 'prompt',
  PrimitiveStringMultiline: 'value',
  PrimitiveString: 'value',
  String: 'value',
}

/** Write targets for the positive prompt, as `id.field`.
 *  Walks up from each sampler; follows the link when an encoder's text comes
 *  from a primitive node (LTX). */
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
      // Linked text: the actual input is upstream (PrimitiveStringMultiline).
      if (Array.isArray(v)) { visit(String(v[0]), v[1]); return }
      return
    }
    // LTXVConditioning outputs positive on 0 and negative on 1: only follow the
    // side we came from.
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

/* ---------- duration and aspect ----------
   Each recipe exposes duration differently:

     Wan      WanImageToVideo.length: a literal FRAME COUNT
     LTX      EmptyLTXVLatentVideo.length <- ComfyMathExpression "a * b + 1"
              where a = seconds and b = fps, both primitives
     MiniMax  MiniMaxH3ImageToVideo.length <- an expression quantized to 17
              (its latent time step)

   Hence a graph walk rather than hard-coded node ids (recipes are editable).
   Only `values.a` of an expression is followed: `values.b` holds the fps. */

/** Sets the GENERATION duration. Returns a note, or null if the recipe exposes
 *  no recognizable duration. */
function setVideoDuration(out, seconds) {
  const holders = Object.entries(out).filter(([, n]) =>
    'length' in (n.inputs ?? {}) && /ImageToVideo|LatentVideo/.test(n.class_type))
  if (!holders.length) return null

  for (const [id, n] of holders) {
    const len = n.inputs.length
    if (!Array.isArray(len)) {
      /* Literal frame count (Wan). Playback fps is the one of the assembly node
         (24 on Wan while the model animates at 16, which corrects speed), so read
         the graph's actual fps instead of assuming 24. */
      const fps = Object.values(out).find(x => x.class_type === 'CreateVideo'
        && typeof x.inputs?.fps === 'number')?.inputs.fps ?? 24
      // Video models work in blocks of 4 frames + 1.
      const frames = Math.max(5, Math.round((seconds * fps - 1) / 4) * 4 + 1)
      out[id].inputs.length = frames
      return `#${id} ${n.class_type}.length = ${frames} images (${(frames / fps).toFixed(2)} s à ${fps} fps)`
    }
    // Duration in SECONDS, upstream of one or more expressions.
    let cur = String(len[0])
    for (let hop = 0; hop < 6; hop++) {
      const node = out[cur]
      if (!node) break
      const v = node.inputs?.value
      if (typeof v === 'number') {
        // PrimitiveInt rejects fractions: round; speed correction is applied later
        // on the actual measured duration.
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

/** ResolutionSelector node options, in its COMBO order. */
const ASPECT_LABEL = {
  '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
}

/** Sets the aspect ratio. Either via a ResolutionSelector (LTX, MiniMax) or
 *  literal dimensions (Wan); in the latter case the recipe's pixel AREA is kept
 *  so the render cost does not change. */
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

/** "Source" aspect: dimensions matching the still's EXACT ratio.
 *  ResolutionSelector only knows round ratios, which would stretch the still.
 *  Computes multiple-of-32 dimensions at the target area, closest to the still's
 *  ratio, and replaces LINKS to the selector (and Wan-style literal dimensions)
 *  with these literals. `mp` (draft) is included here: setVideoMegapixels must
 *  NOT run afterwards. */
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
  // Target area: the draft if requested, else the recipe selector's (0.9 MP default).
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
    // Integer relay (PrimitiveInt) wired to a selector output: 0 = width, 1 = height
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
    // Literal dimensions (Wan): same area as the recipe (or draft), still's ratio.
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

/** Render area in megapixels for ResolutionSelector recipes (LTX, MiniMax);
 *  used by draft mode. Other nodes with a `megapixels` input (e.g. the still's
 *  ImageScaleToTotalPixels) are left alone: they do not feed the model. */
function setVideoMegapixels(out, mp) {
  const notes = []
  for (const [id, n] of Object.entries(out)) {
    if (n.class_type === 'ResolutionSelector') {
      out[id].inputs.megapixels = mp
      notes.push(`#${id} ResolutionSelector.megapixels = ${mp} (brouillon)`)
    }
    // Literal dimensions (Wan): same ratio, area scaled to `mp`, multiples of 16.
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

/* ---------- silent render: drop the audio DECODE stage ----------
   In LTX-2.5 and MiniMax H3 audio is denoised in the same latent as the image,
   so only its decoding (audio VAE + LTXVAudioVAEDecode / VAEDecodeAudio) can be
   removed. This removes it plus the nodes that no longer feed anything; the
   output file has no audio track.

   Pruning is by REACHABILITY, not by class list, so orphaned loaders
   (e.g. the audio VAELoader) are caught too. */
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

  /* Walk up from the detached decoder only; starting from "unreferenced" nodes
     would treat the detached decoder itself as an output. */
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
    // Guard: output nodes are never pruned.
    if (/^(Save|Preview)/.test(n.class_type)) continue
    if (refCount().get(id)) continue          // still consumed elsewhere
    for (const v of Object.values(n.inputs || {}))
      if (Array.isArray(v)) orphans.push(String(v[0]))
    delete out[id]
    notes.push(`#${id} ${n.class_type} retiré — plus rien ne le consomme`)
  }
  return notes
}

/** INSTRUCTION recipes (Qwen-Image-Edit): the text describes an EDIT, and the
 *  recipe already holds a fixed base (subject identity, hair, preservation
 *  directive). The console prompt is APPENDED to it, not substituted.
 *
 *  Detected by wiring, never by file name: this distinguishes the instruction
 *  encoder from its negative twin, which has the same class and images. */
function instructionEncoders(out) {
  const ids = new Set()
  for (const n of Object.values(out)) {
    if (n.class_type !== 'KSampler' && n.class_type !== 'KSamplerAdvanced'
      && n.class_type !== 'LanPaint_KSampler') continue
    const p = n.inputs?.positive
    if (Array.isArray(p)) ids.add(String(p[0]))
  }
  /* Two edit-recipe signatures, with their write field:
       1. Qwen: the TextEncodeQwenImageEdit* encoder holds `prompt`.
       2. Klein (reference edit): a plain CLIPTextEncode (`text`) whose
          conditioning reaches the sampler through at least one ReferenceLatent.
          A CLIPTextEncode wired directly is a generation recipe, not matched here. */
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

/** Writes prompt, negative, seed, dimensions and extra LoRAs into a COPY of the
 *  recipe. Returns the injected recipe and the injection log: what was written,
 *  and what could NOT be written (reported, never hidden). */
/* ---------- DECLARED recipe control ----------
   Besides wiring-based injection (injectJob), a recipe may DECLARE in a sibling
   file `<recipe>.pilotage.json` which node input receives each value:
     { "prompt": ["6", "text"], "negative": ["7", "text"], "seed": ["3", "seed"],
       "width": ["5", "width"], "height": ["5", "height"], "sourceImage": ["10", "image"] }
   The declaration is applied AFTER the wiring and wins. Without the file,
   nothing changes. */
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

/** Inserts LoraLoaderModelOnly nodes at the end of the MODEL chain (after the
 *  recipe's last LoRA, else on the UNETLoader). Exported for graphs built in code
 *  (brush). Mutates `out` in place. */
export function empilerLoras(out, loras, applied = [], skipped = []) {
  // Anchor = the recipe's last LoraLoaderModelOnly; if the recipe has none,
  // stack directly on the UNETLoader so LoRAs apply to a bare recipe too.
  /* Wan high/low noise pair: a LoRA whose NAME states its stage
     ("...high_noise...", "...low_noise...") goes on that stage's chain.
     Others use the default anchoring below. */
  const etage = n => /high[_-]?noise/i.test(n) ? 'high' : /low[_-]?noise/i.test(n) ? 'low' : null
  // UNETLoader or UnetLoaderGGUF (the T2V recipe loads its low-noise stage as GGUF Q8)
  const unets = [...findByClass(out, 'UNETLoader'), ...findByClass(out, 'UnetLoaderGGUF')]
  const unetDe = e => unets.find(id => (e === 'high' ? /high[_-]?noise/i : /low[_-]?noise/i).test(String(out[id].inputs?.unet_name ?? '')))
  const nomDe = l => typeof l === 'string' ? l : l?.name
  if (unetDe('high') && unetDe('low') && loras.some(l => etage(String(nomDe(l) ?? '')))) {
    const parEtage = { high: [], low: [] }, communes = []
    for (const l of loras) { const e = etage(String(nomDe(l) ?? '')); (e ? parEtage[e] : communes).push(l) }
    for (const e of ['high', 'low']) {
      // end of this stage's MODEL chain: follow the LoraLoaderModelOnly nodes down
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
    // Some recipes carry non-numeric ids from subgraphs ("105:6", "vbvr");
    // Number() makes them NaN and a single NaN poisons Math.max. Only finite ids
    // are used to pick the next free integer (floor 0).
    let nextId = Math.max(0, ...Object.keys(out).map(Number).filter(Number.isFinite)) + 1
    for (const l of loras) {
      const name = typeof l === 'string' ? l : l?.name
      const strength = Number(typeof l === 'string' ? 1 : l?.strength)
      if (!name) { skipped.push('LoRA additionnelle sans nom — ignorée'); continue }
      const id = String(nextId++)
      // Rewire the consumers of `upstream` BEFORE adding the node, otherwise its own
      // input would be rewired to itself.
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

/* LTX sampling stages: LTXVImgToVideoInplace -> LTXVConcatAVLatent -> SamplerCustomAdvanced (LTXVDualCFGGuider guider). */
function ltxEtages(out) {
  const r = []
  for (const [sampler, n] of Object.entries(out)) {
    if (n.class_type !== 'SamplerCustomAdvanced') continue
    const concat = out[n.inputs.latent_image?.[0]], guider = out[n.inputs.guider?.[0]]
    if (concat?.class_type !== 'LTXVConcatAVLatent' || !guider?.inputs?.positive) continue
    const i2vId = concat.inputs.video_latent?.[0]
    if (out[i2vId]?.class_type !== 'LTXVImgToVideoInplace') continue
    r.push({ sampler, concat, guider, i2vId, i2v: out[i2vId] })
  }
  return r
}

/* LTX keyframes (LTX-2.5 first/last frame pattern): each image enters through LTXVAddGuide at its
   index (multiple of 8, -1 = last frame), including the start still (LTXVImgToVideoInplace bypassed).
   Strengths 0.7 on stage 1, 1 on refinement; compression 18. Guide latents are removed
   (LTXVCropGuides) before the next stage and decoding. */
function ltxImagesCles(out, cles, secondes) {
  const etages = ltxEtages(out)
  const total = Math.round((Number(secondes) || 5) * 24 / 8) * 8   // last frame = index total
  const liste = cles.map(k => {
    const t = Number(k.t)
    const idx = !Number.isFinite(t) || t * 24 >= total - 4 ? -1 : Math.max(0, Math.min(total - 8, Math.round(t * 24 / 8) * 8))
    return { image: String(k.image), idx }
  }).sort((a, b) => (a.idx === -1 ? 1e9 : a.idx) - (b.idx === -1 ? 1e9 : b.idx))
  const i2v = etages[0].i2v
  const prep = i2v.inputs.image?.[0]
  const redim = prep && out[prep]?.class_type === 'LTXVPreprocess' ? out[prep].inputs.image?.[0] : null
  if (prep && out[prep]?.class_type === 'LTXVPreprocess') out[prep].inputs.img_compression = 18
  liste.forEach((k, i) => {
    out[`kf_load_${i}`] = { class_type: 'LoadImage', inputs: { image: k.image } }
    let img = [`kf_load_${i}`, 0]
    if (redim && out[redim]) { out[`kf_redim_${i}`] = { class_type: out[redim].class_type, inputs: { ...out[redim].inputs, input: img } }; img = [`kf_redim_${i}`, 0] }
    out[`kf_prep_${i}`] = { class_type: 'LTXVPreprocess', inputs: { img_compression: 18, image: img } }
    k.img = [`kf_prep_${i}`, 0]
  })
  etages.forEach(({ i2v: e, concat, guider, sampler }, k) => {
    const by = e.inputs.bypass
    if (Array.isArray(by) && out[by[0]]?.inputs && 'value' in out[by[0]].inputs) out[by[0]].inputs.value = true
    else e.inputs.bypass = true
    let pos = guider.inputs.positive, neg = guider.inputs.negative, lat = concat.inputs.video_latent
    liste.forEach((c, i) => {
      const id = `kf_g${k}_${i}`
      /* First and last frames: 0.7 then 1 (they hold the frame). Intermediate frames are softer,
         0.5 then 0.3, so LTX does not cross-fade into them when it finds no motion. */
      const bord = c.idx === 0 || c.idx === -1
      out[id] = { class_type: 'LTXVAddGuide', inputs: { positive: pos, negative: neg, vae: e.inputs.vae, latent: lat, image: c.img, frame_idx: c.idx, strength: bord ? (k === 0 ? 0.7 : 1) : (k === 0 ? 0.5 : 0.3) } }
      pos = [id, 0]; neg = [id, 1]; lat = [id, 2]
    })
    guider.inputs.positive = pos; guider.inputs.negative = neg; concat.inputs.video_latent = lat
    const sep = Object.entries(out).find(([, n]) => n.class_type === 'LTXVSeparateAVLatent' && n.inputs.av_latent?.[0] === sampler)?.[0]
    if (!sep) return
    const crop = `kf_crop_${k}`
    out[crop] = { class_type: 'LTXVCropGuides', inputs: { positive: pos, negative: neg, latent: [sep, 0] } }
    for (const [id, n] of Object.entries(out)) {
      if (id === crop) continue
      for (const [c2, v] of Object.entries(n.inputs ?? {})) if (Array.isArray(v) && v[0] === sep && v[1] === 0) n.inputs[c2] = [crop, 2]
    }
  })
  return liste
}

export function injectJob(wf, { cameraPose, positive, negative, seed, jobId, identityPreamble, width, height, loras, sourceImage, t2v, controlNet, withAudio, videoSeconds, videoAspect, videoSrcDims, videoMegapixels, endImage, contexteVideo, keyframes, videoSteps, opTag }) {
  const out = structuredClone(wf)
  const applied = []
  const skipped = []

  /* -- sampling step count --
     Driven by the engine (and draft mode) rather than fixed in the recipe, so
     draft and production share one file. Written ONLY when the caller asks;
     otherwise the recipe value is kept. Every write is logged. */
  if (Number.isFinite(videoSteps) && videoSteps > 0) {
    const n = Math.max(1, Math.round(videoSteps))
    for (const [id, node] of Object.entries(out))
      if (node.inputs && typeof node.inputs.steps === 'number') {
        const avant = node.inputs.steps
        node.inputs.steps = n
        applied.push(`#${id} ${node.class_type}.steps = ${n} (recette : ${avant})`)
        /* Two-stage recipe (high noise then low noise): the stage boundary scales with
           the step count so the second stage starts within range. */
        for (const borne of ['start_at_step', 'end_at_step']) {
          const v = node.inputs[borne]
          if (typeof v === 'number' && v > 0 && v <= avant && avant > 0) {
            node.inputs[borne] = Math.round(v * n / avant)
            applied.push(`#${id} ${node.class_type}.${borne} = ${node.inputs[borne]} (recette : ${v})`)
          }
        }
      }
  }

  /* -- instruction recipe? Decided first, since it changes how the prompt is
        applied: appended to a fixed base rather than written. -- */
  const instruction = instructionEncoders(out)

  /* -- source image: the only required input of an edit recipe --
     A single `LoadImage` is unambiguous; with several, writing would risk
     editing the wrong image, so it is refused. */
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

  /* -- identity preamble: always the persona's, never a recipe literal --
     Two possible locations depending on the recipe:
       1. a StringConcatenate joining a LITERAL text (string_a) in front of a
          LINKED input (string_b, the output of an in-graph rewriter).
       2. none: the recipe encodes the prompt directly, so the preamble is
          prefixed to the positive text.
     See server/persona.js. */
  let preambleInText = false
  if (instruction.length) {
    // An edit instruction keeps the source image's identity; prefixing a subject
    // description would make the model repaint the subject.
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
      // Several plausible locations: injecting at random would produce a wrong but
      // credible prompt. Keep the recipe as is and report it.
      skipped.push(`préambule ${identityPreamble.key} NON injecté : ${slots.length} `
        + `StringConcatenate candidats (#${slots.join(', #')}) — emplacement ambigu`)
    } else {
      preambleInText = true
    }
  } else if (identityPreamble === undefined) {
    // `null` is a deliberate choice (video, edit, empty persona) and gets no
    // warning; only a missing value (undefined) does.
    skipped.push('aucun préambule d’identité fourni — la recette garde son littéral')
  }

  const finalPositive = preambleInText ? identityPreamble.text + positive : positive

  /* -- instruction recipe prompt: APPENDED to the fixed base --
     `prompt` is never overwritten: the base may hold a preservation directive.
     The console prompt is appended ("and change the red dress to blue"); an
     empty base receives the instruction alone.

     The recipe's other CLIPTextEncode nodes are NOT touched (the generic
     fallback below would otherwise write the prompt into them). */
  if (instruction.length) {
    const suffix = (positive || '').trim()
    for (const { id, field } of instruction) {
      const base = out[id].inputs[field] || ''
      if (suffix) {
        // The base ends with a period; a suffix starting lowercase is a CONTINUATION
        // ("and change the red dress to blue"). Drop the period in that case only,
        // since Qwen's encoder is a language model and broken punctuation hurts it.
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
    // Edit style LoRAs (picked server-side from a closed list)
    if (Array.isArray(loras) && loras.length) empilerLoras(out, loras, applied, skipped)

    // Seed and output prefix: the generic path is after this return, so write them
    // here; otherwise the graph would keep the recipe's fixed seed and provenance
    // would be wrong. A FaceDetailer's own seed follows too.
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

  /* -- prompt: wherever the recipe accepts free text -- */
  const wildcards = findByClass(out, 'ImpactWildcardProcessor')
  for (const id of wildcards) {
    out[id].inputs.populated_text = finalPositive
    out[id].inputs.mode = 'fixed'
    out[id].inputs.seed = seed
    applied.push(`#${id} ImpactWildcardProcessor.populated_text = <prompt> (mode=fixed, seed=${seed})`)
  }
  if (!wildcards.length) {
    /* Three levels, from safest to most approximate:
         1. walk up the wiring from the sampler (covers photo AND video)
         2. encoder wired directly to a KSampler
         3. first literal CLIPTextEncode (reported, since it is a guess).
       Level 1 is required for video: on LTX the first encoder is the NEGATIVE. */
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

  /* -- dimensions: per job, recipe value as default -- */
  if (width || height) {
    /* Matched by PATTERN, not a closed list: each architecture brings its own
       empty latent node (EmptyFlux2LatentImage, EmptyHunyuanLatentVideo,
       EmptyLTXVLatentVideo...). */
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

  /* -- negative: injected only if the recipe has an encoder that reads it --
     Turbo and ZiTC recipes run at cfg 1.0 with ConditioningZeroOut, where the
     negative is inert; this is reported instead of writing it into a no-op node.
     A real negative encoder (cfg > 1 recipes) is fed. */
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

  /* -- extra LoRAs (persona then job): stacked at the end of the MODEL chain --
     Nodes are INSERTED rather than pre-placed in the recipe: a LoraLoaderModelOnly
     at strength 0 would still load the file and require a valid name.

     Insertion takes the last link of the MODEL chain from the identity LoRA and
     rewires its consumers to the new node. Order matters: identity first, then
     style/pose. */
  if (Array.isArray(loras) && loras.length) empilerLoras(out, loras, applied, skipped)

  /* -- Z-Image ControlNet (Fun-CN): INSERTED, never pre-placed in the recipe --
     Like extra LoRAs, the node is added on the fly so jobs without a reference
     image need none.

     The "type" is not a node parameter: the Union model infers the modality from
     the map it receives, so choosing depth or openpose means choosing the
     PREPROCESSOR. `control_context_scale` is called `strength` here. */
  if (controlNet?.file) {
    const { file, type = 'depth', strength = 0.7 } = controlNet
    const samplers = [...findByClass(out, 'KSampler'), ...findByClass(out, 'KSamplerAdvanced')]
    // Use the VAE the recipe already decodes with: the control node encodes the map
    // and must use the same latent space.
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

      // Insert on the `model` input of EACH sampler, starting from what fed it (not
      // the first UNETLoader), so upstream LoRAs and ModelSamplingAuraFlow are kept.
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

  /* -- sampling seed -- */
  const samplers = [
    ...findByClass(out, 'KSampler'),
    ...findByClass(out, 'KSamplerAdvanced'),
    ...findByClass(out, 'LanPaint_KSampler'),
    // RES4LYF ClownsharKSampler_Beta also has a `seed` input.
    ...findByClass(out, 'ClownsharKSampler_Beta'),
  ]
  for (const id of samplers) {
    /* KSamplerAdvanced reads `noise_seed`, not `seed`. */
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

  /* -- video duration and aspect -- */
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
  /* LTX keyframes: [{ image, t (s) }]. Provided by the job (Movie Studio timeline), or
     derived from the first image and the end image. */
  let ltxCles = Array.isArray(keyframes) && keyframes.length ? keyframes : null
  /* -- END image (arrival keyframe) --
     Only MiniMax H3 exposes a `last_frame` input; the served recipe does not wire
     it (single LoadImage on `first_frame`). When the job provides `endImage`, a
     LoadImage is INSERTED and wired to the i2v node's `last_frame`; the insertion
     is logged. Other engines without an equivalent input are reported. */
  if (endImage) {
    const targets = Object.entries(out).filter(([, n]) => /ImageToVideo/.test(n.class_type)
      && (n.inputs && ('last_frame' in n.inputs || 'end_image' in n.inputs || n.class_type === 'MiniMaxH3ImageToVideo')))
    /* Wan 2.2: WanImageToVideo has no end input, but the core node
       WanFirstLastFrameToVideo has the same inputs PLUS end_image. The class switch
       happens at the end of the patch (flfWan) so the duration and aspect settings
       below still match "ImageToVideo". */
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
    } else if (!targets.length && ltxEtages(out).length) {
      // LTX: handled below with keyframes (first and end images as guides)
      ltxCles = [{ image: sourceImage, t: 0 }, { image: endImage, t: Infinity }].filter(k => k.image)
    } else if (!targets.length) {
      skipped.push(`image de fin « ${endImage} » NON injectée : aucune entrée last_frame/end_image dans la recette`)
    } else {
      const [tid, tn] = targets[0]
      const slot = 'end_image' in (tn.inputs || {}) ? 'end_image' : 'last_frame'
      const idLoad = `${tid.replace(/[^A-Za-z0-9]/g, '_')}_end`
      out[idLoad] = { class_type: 'LoadImage', inputs: { image: endImage } }
      out[tid].inputs[slot] = [idLoad, 0]
      applied.push(`#${idLoad} LoadImage.image = ${endImage} → #${tid} ${tn.class_type}.${slot} (keyframe de fin)`)
      /* End frame ONLY: unwire first_frame, otherwise the graph would start from the
         recipe's literal still. The original LoadImage then feeds nothing and is not run. */
      if (!sourceImage && 'first_frame' in (out[tid].inputs || {})) {
        delete out[tid].inputs.first_frame
        applied.push(`#${tid} ${tn.class_type}.first_frame débranché (frame de fin seule)`)
      }
    }
  }
  if (ltxCles && ltxEtages(out).length) {
    const n = ltxImagesCles(out, ltxCles, videoSeconds)
    applied.push(`LTX : ${n.length} image(s) clé(s) en guides (${n.map(k => `${k.image} @ ${k.idx === -1 ? 'fin' : `image ${k.idx}`}`).join(', ')}), forces 0,7 puis 1 aux bords, 0,5 puis 0,3 entre les deux, still de départ en guide`)
  }
  /* -- video context (continuation): LTX --
     The last frames of the previous shot (a video file of 8n+1 frames in input/) enter as a guide at
     frame 0 of each stage, so the shot continues the previous one's motion, speed and camera (the
     regenerated context frames are trimmed at edit time). The start still is then not enforced
     (LTXVImgToVideoInplace bypassed). */
  if (contexteVideo) {
    const etages = ltxEtages(out)
    if (!etages.length) skipped.push(`contexte vidéo « ${contexteVideo} » NON injecté : recette sans étage LTX`)
    else {
      out.ctx_load = { class_type: 'LoadVideo', inputs: { file: contexteVideo } }
      out.ctx_img = { class_type: 'GetVideoComponents', inputs: { video: ['ctx_load', 0] } }
      const prep = etages[0].i2v.inputs.image?.[0]
      let img = ['ctx_img', 0]
      if (prep && out[prep]?.class_type === 'LTXVPreprocess') { out.ctx_prep = { class_type: 'LTXVPreprocess', inputs: { ...out[prep].inputs, image: img } }; img = ['ctx_prep', 0] }
      etages.forEach(({ i2vId, i2v, concat, guider, sampler }, k) => {
        const g = `ctx_guide_${k}`
        out[g] = { class_type: 'LTXVAddGuide', inputs: { positive: guider.inputs.positive, negative: guider.inputs.negative, vae: i2v.inputs.vae, latent: concat.inputs.video_latent, image: img, frame_idx: 0, strength: 1 } }
        guider.inputs.positive = [g, 0]; guider.inputs.negative = [g, 1]; concat.inputs.video_latent = [g, 2]
        const by = i2v.inputs.bypass
        if (Array.isArray(by) && out[by[0]]?.inputs && 'value' in out[by[0]].inputs) out[by[0]].inputs.value = true
        else i2v.inputs.bypass = true
        const crop = out[`kf_crop_${k}`]
        if (crop) { crop.inputs.positive = [g, 0]; crop.inputs.negative = [g, 1] }
        else {
          const sep = Object.entries(out).find(([, n]) => n.class_type === 'LTXVSeparateAVLatent' && n.inputs.av_latent?.[0] === sampler)?.[0]
          if (!sep) return
          const c = `ctx_crop_${k}`
          out[c] = { class_type: 'LTXVCropGuides', inputs: { positive: [g, 0], negative: [g, 1], latent: [sep, 0] } }
          for (const [id, n] of Object.entries(out)) {
            if (id === c) continue
            for (const [cle, v] of Object.entries(n.inputs ?? {})) if (Array.isArray(v) && v[0] === sep && v[1] === 0) n.inputs[cle] = [c, 2]
          }
        }
      })
      applied.push(`#ctx_load LoadVideo.file = ${contexteVideo} → LTXVAddGuide (image 0, contexte du plan précédent) sur ${etages.length} étage(s), still de départ contournée`)
    }
  }


  // "Source" aspect: the draft is already included in the exact dimensions;
  // setVideoMegapixels would rescale the literals just written.
  if (Number.isFinite(videoMegapixels) && !exactDimsApplied) {
    const notes = setVideoMegapixels(out, videoMegapixels)
    if (notes.length) applied.push(...notes)
    else skipped.push(`brouillon ${videoMegapixels} MP NON injecté : aucun ResolutionSelector `
      + 'dans la recette — rendu à la résolution pleine')
  }

  /* -- text to video: the recipe's switch, found by its title --
     The (neutral) start image stays wired but is not read. A recipe without the
     switch would do i2v on a black image, so it is refused. */
  if (t2v) {
    const ids = Object.entries(out).filter(([, n]) => n?.class_type === 'PrimitiveBoolean'
      && /text\s*to\s*video/i.test(n._meta?.title ?? '')).map(([id]) => id)
    if (!ids.length) throw new Error('recette sans interrupteur « Text to Video » : plan d’ambiance impossible')
    for (const id of ids) { out[id].inputs.value = true; applied.push(`#${id} « ${out[id]._meta.title} » = true (texte → vidéo)`) }
  }

  /* -- silent render on an audio-capable engine: skip the audio decode stage --
     See stripAudioStage. On recipes without an audio stage (Wan) this is a no-op. */
  if (withAudio === false) {
    const notes = stripAudioStage(out)
    if (notes.length) applied.push(...notes)
  }

  if (flfWan) out[flfWan].class_type = 'WanFirstLastFrameToVideo'

  /* -- output location: one folder per job -- */
  for (const id of [...findByClass(out, 'SaveImage'), ...findByClass(out, 'Image Save'),
    ...findByClass(out, 'SaveVideo'), ...findByClass(out, 'SaveWEBM')]) {
    out[id].inputs.filename_prefix = `creatoros/${jobId}/out`
    applied.push(`#${id} ${out[id].class_type}.filename_prefix = creatoros/${jobId}/out`)
  }

  /* -- VRAM: unload the LLM before diffusion (see CONFIG.ollamaUnload) -- */
  if (CONFIG.ollamaUnload) {
    for (const id of findByClass(out, 'OllamaConnectivityV2')) {
      out[id].inputs.keep_alive = 0
      applied.push(`#${id} OllamaConnectivityV2.keep_alive = 0 (décharge immédiate, anti-OOM)`)
    }
  }

  /* -- camera trajectory (Wan Fun Camera): same dimensions and length as the video -- */
  for (const id of findByClass(out, 'WanCameraEmbedding')) {
    const v = Object.values(out).find(n => n.class_type === 'WanCameraImageToVideo')
    for (const k of ['width', 'height', 'length']) if (typeof v?.inputs?.[k] === 'number') out[id].inputs[k] = v.inputs[k]
    if (cameraPose) out[id].inputs.camera_pose = cameraPose
    applied.push(`#${id} WanCameraEmbedding = ${out[id].inputs.camera_pose} ${out[id].inputs.width}×${out[id].inputs.height}, ${out[id].inputs.length} images`)
  }

  return { workflow: out, applied, skipped }
}

/* ---------- 2 MP photo render ----------
   Krea renders DIRECTLY at 2 MP: the latent is enlarged to the requested ratio,
   short side 1088 in portrait (cropped to 1080 wide, since 1080 is not a
   multiple of 16), 1920 wide in landscape (framing kept). */
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

/* ---------- HTTP calls to ComfyUI ---------- */

async function comfy(pathname, init) {
  const res = await fetch(CONFIG.comfyUrl + pathname, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ComfyUI ${pathname} → HTTP ${res.status} ${body.slice(0, 1200)}`)
  }
  return res
}

/** Removes a prompt still pending in ComfyUI's queue. */
export async function deleteQueued(promptId) {
  if (String(promptId).startsWith('sdk:')) return sdk.annuler(promptId)
  await comfy('/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  })
}

/** Unloads resident models (VRAM), e.g. before a Wan refine, so leftover models
 *  do not force CPU offload. */
export async function freeMemory() {
  if (sdk.surSdk()) return   // the card's memory is not ours to manage
  await comfy('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }) })
}

/** Interrupts a specific prompt if it is running. With a prompt_id ComfyUI
 *  interrupts only that one, so another app sharing ComfyUI keeps its render. */
export async function interrupt(promptId) {
  if (String(promptId).startsWith('sdk:')) return sdk.annuler(promptId)
  await comfy('/interrupt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
  })
}

/* ---------- live progress ----------
   ComfyUI pushes `progress` (value/max, per node) on its WebSocket. value/max
   only cover the current node, matching what the ComfyUI UI shows.
   The ETA is derived from the pace observed on the current node. */
const progressByPrompt = new Map()
let ws = null
/* Live preview. ComfyUI only sends preview images to the client that submitted
   the render, so listening and submissions share the same client id.
   Preview is requested per render (`preview_method` in extra_data). The latest
   image of each render is kept. */
const CLIENT_WS = 'creatoros-' + Math.random().toString(36).slice(2, 12)
// lets GPU arbitration recognize the studio's renders in ComfyUI's queue (others = production)
definirClientStudio(CLIENT_WS)
const apercus = new Map()              // prompt_id -> { buf, mime, at }
let promptEnCours = null
function noteApercu(data) {
  const b = Buffer.from(data)
  if (b.length < 16) return
  const type = b.readUInt32BE(0)
  let id = promptEnCours, mime = 'image/jpeg', image = null
  if (type === 1) { mime = b.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'; image = b.subarray(8) }
  else if (type === 4) {
    const n = b.readUInt32BE(4)
    try { const meta = JSON.parse(b.subarray(8, 8 + n).toString('utf8')); id = meta.prompt_id ?? id; mime = meta.image_type ?? mime } catch { /* unreadable metadata */ }
    image = b.subarray(8 + n)
  }
  if (!id || !image?.length) return
  apercus.set(id, { buf: image, mime, at: Date.now() })
  if (apercus.size > 6) apercus.delete(apercus.keys().next().value)
}
/** Latest preview of a render, if under two minutes old. */
export const getApercu = promptId => { const a = apercus.get(promptId); return a && Date.now() - a.at < 120_000 ? a : null }
/* ComfyUI link state: the WebSocket drops when ComfyUI stops and reconnects when it
   restarts. This yields a "restarting" state distinct from "down", and a
   reconnect signal on which the server reruns diagnostics. */
const liaison = { coupeLe: null, revenuLe: null, coupureMs: null }
const auRetour = []
export const onRetourComfy = cb => { auRetour.push(cb) }
/** 'ok' | 'redemarre' (down for under 3 min) | 'panne'. */
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
        // One entry per render, pruned as we go.
        if (progressByPrompt.size > 50) {
          const oldest = [...progressByPrompt.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          progressByPrompt.delete(oldest[0])
        }
      } catch { /* unreadable frame: ignored */ }
    })
    ws.addEventListener('open', () => {
      if (!liaison.coupeLe) return
      liaison.revenuLe = Date.now(); liaison.coupureMs = liaison.revenuLe - liaison.coupeLe; liaison.coupeLe = null
      for (const cb of auRetour) Promise.resolve().then(cb).catch(() => {})
    })
    ws.addEventListener('close', () => { liaison.coupeLe ??= Date.now(); setTimeout(connectProgress, 2000) })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* already closed */ } })
  } catch { setTimeout(connectProgress, 5000) }
}
connectProgress()

/* ---------- human-readable phase ----------
   Names what the current node is doing, from its class in the submitted graph.
   Until a node reports, models are loading. */
const classesByPrompt = new Map()      // prompt_id -> { node: class }
const noeudByPrompt = new Map()        // prompt_id -> current node
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

/** Prompt progress: { value, max, etaS } or null. */
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

/** Waits for ComfyUI to answer. At boot both services start together and
 *  `After=comfyui.service` only guarantees start ORDER, not that the server
 *  listens; ComfyUI takes a while to load its nodes. */
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

/** Is the prompt still KNOWN to ComfyUI (queued, running, or in history)?
 *  After a ComfyUI restart its in-memory queue is lost: an unknown prompt will
 *  never finish and must be resubmitted. */
export async function promptKnown(promptId) {
  if (String(promptId).startsWith('sdk:')) return null   // the handle does not survive a restart
  const hist = await (await comfy(`/history/${promptId}`)).json()
  if (hist[promptId]) return 'history'
  const q = await (await comfy('/queue')).json()
  if ((q.queue_running || []).some(e => e[1] === promptId)) return 'running'
  if ((q.queue_pending || []).some(e => e[1] === promptId)) return 'pending'
  return null
}

export async function submitPrompt(workflow, clientId) {
  if (sdk.surSdk()) return sdk.soumettre(workflow)
  // small GPU: heavy loaders replaced by their lightweight variants (see allege.js)
  const a = await alleger(workflow)
  if (a.remplaces.length) {
    workflow = a.graphe
    console.log(`[allégé] ${a.remplaces.map(([de, vers]) => `${de} → ${vers}`).join(' ; ')}`)
  }
  const res = await fetch(CONFIG.comfyUrl + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // client_id = the listener's (previews); the caller's `clientId` is not used by ComfyUI
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_WS, extra_data: { preview_method: 'latent2rgb' } }),
  })
  const text = await res.text()
  if (!res.ok) {
    // ComfyUI returns a detailed 400 (node_errors) when the graph is invalid:
    // summarized for the operator, logged in full (see erreurs.js).
    console.warn(`[comfy] refus HTTP ${res.status} : ${text.slice(0, 4000)}`)
    throw new Error(erreurSoumission(text))
  }
  const json = JSON.parse(text)
  if (json.node_errors && Object.keys(json.node_errors).length) {
    console.warn(`[comfy] erreurs de nœuds : ${JSON.stringify(json.node_errors).slice(0, 4000)}`)
    throw new Error(erreurSoumission(json))
  }
  // graph node classes, used to name the current phase (see getPhase)
  classesByPrompt.set(json.prompt_id, Object.fromEntries(Object.entries(workflow).map(([k, v]) => [k, v?.class_type ?? ''])))
  if (classesByPrompt.size > 50) classesByPrompt.delete(classesByPrompt.keys().next().value)
  return json.prompt_id
}

/** Waits for execution to finish. `onPhase` receives 'queued' then 'rendering'. */
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

    /* The timeout only applies to a prompt that VANISHED without history (a crash,
       not a long render). While ComfyUI holds it (running or pending), keep waiting. */
    if (!running && !pending && Date.now() - t0 > timeoutMs)
      throw new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s) sans résultat`)
    await sleep(1000)
  }
}

/** Extracts the images of a history entry, and throws on execution failure
 *  (status not "success"). */
export function outputsOf(history) {
  const status = history.status || {}
  const images = []
  for (const out of Object.values(history.outputs || {}))
    for (const img of out.images || [])
      // "temp": previews; "input": the input file shown by a loader node, not a render
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

/** Texts returned by the graph (PreviewAny, ShowText...).
 *  On recipes that rewrite the prompt in-graph, this is the final prompt, i.e.
 *  what a `__...__` wildcard token actually resolved to. */
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

/** Fetches an image's bytes: local disk first (same machine), /view endpoint
 *  as fallback if the layout differs. */
export async function readImage(img) {
  if (img.__sdk) return sdk.lireSortie(img)
  const local = path.join(CONFIG.comfyOutput, img.subfolder || '', img.filename)
  if (fs.existsSync(local)) return fs.readFileSync(local)
  const qs = new URLSearchParams({
    filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
  })
  return Buffer.from(await (await comfy('/view?' + qs)).arrayBuffer())
}

/** PNG dimensions read from the IHDR chunk (no image dependency). */
export function pngSize(buf) {
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR')
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  return { width: null, height: null }
}

/* ---------- LoRA inventory ----------
   The front end needs the real list to pick a LoRA. Two concerns handled here:

   1. Not every LoRA in the folder matches the recipe's architecture. A
      mismatched LoRA does not fail; ComfyUI applies what it can and renders a
      plausible but wrong image. So LoRAs are classified by ARCHITECTURE from
      the safetensors header:
        Z-Image : diffusion_model.layers.<n>.attention|feed_forward
        Flux 1  : lora_unet_double_blocks_*
        Flux 2  : diffusion_model.double_blocks.*
      The file name proves nothing.

   2. Headers are cached by (size, mtime), so a replaced file is reclassified. */

const loraCache = new Map()

/** Reads the safetensors header ONCE and extracts the architecture (from tensor
 *  keys) and the trigger word (from metadata).
 *
 *  Without its trigger in the prompt, a LoRA loads but has no effect. Three
 *  sources, by DECREASING reliability; `triggerSource` says which:
 *
 *    `tags`   ss_tag_frequency: what the training captions actually contained.
 *    `nom`    ss_output_name / name: plausible but UNVERIFIED; shown as a
 *             suggestion for the operator to confirm.
 *    `aucun`  neither (e.g. diffusers-exported LoRAs). The operator MUST enter
 *             it, otherwise the LoRA stays inert.
 *
 *  Cached by (size, mtime). */
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
      // Guard: a sane safetensors header is a few hundred KB.
      if (n > 0 && n < 64 * 1024 * 1024) {
        const head = Buffer.alloc(n)
        fs.readSync(fd, head, 0, n, 8)
        const parsed = JSON.parse(head.toString('utf8'))
        const keys = Object.keys(parsed)

        /* Krea 2 and FLUX.2 Klein: first what the file declares (modelspec / kohya),
           then Krea 2 specific keys (attention gate `attn.gate` + `wk`, `txtfusion` towers). */
        const meta = parsed.__metadata__ || {}
        const decl = `${meta['modelspec.architecture'] ?? ''} ${meta.ss_base_model_version ?? ''} ${meta.ss_sd_model_name ?? ''}`.toLowerCase()
        // FLUX 3 Image Klein (ai-toolkit: ss_base_model_version flux3, content_mode_blocks)
        if (/flux[._-]?3/.test(decl) || keys.some(k => /content_mode_blocks\./.test(k))) probe.arch = 'flux3'
        else if (/krea/.test(decl) || keys.some(k => /(^|\.)txtfusion\.|blocks[._]\d+[._]attn[._]gate/.test(k))) probe.arch = 'krea2'
        else if (/klein|flux[._-]?2/.test(decl)) probe.arch = 'flux2'
        else if (keys.some(k => /^diffusion_model\.layers\.\d+\.(attention|feed_forward)/.test(k))) probe.arch = 'zimage'
        else if (keys.some(k => k.startsWith('lora_unet_double_blocks'))) probe.arch = 'flux1'
        else if (keys.some(k => k.startsWith('diffusion_model.double_blocks'))) probe.arch = 'flux2'
        // MiniMax H3 (video). Either of two H3-specific markers is enough: FUSED QKV
        // attention (`attn.qkv_proj` / `attn.out_proj`) and MLP named `mlp.fc1/fc2`
        // (some H3 LoRAs train only the MLPs). This tells it apart from Wan, which
        // shares the `diffusion_model.blocks.N.` prefix but has separate
        // `self_attn.q/k/v`, `cross_attn`, and `ffn.0/ffn.2`.
        else if (keys.some(k =>
          /^diffusion_model\.(token_refiner\.)?blocks\.\d+\.(attn\.(qkv_proj|out_proj)|mlp\.fc)/.test(k)
          // Same H3 arch with kohya/sd-scripts naming: `lora_unet_blocks_N_attn_qkv_proj`.
          // FUSED `qkv_proj` distinguishes it from Wan, and `blocks_` (not
          // `double_blocks_`) from Flux.
          || /^lora_unet_blocks_\d+_(attn_(qkv_proj|out_proj)|mlp_fc)/.test(k)
        )) probe.arch = 'h3'

        const m = parsed.__metadata__ || {}
        // ss_tag_frequency: { "1_<tag>": { "<tag>": n } }; the "1_" prefix is the
        // folder's repeat count, not part of the word.
        try {
          const tf = typeof m.ss_tag_frequency === 'string'
            ? JSON.parse(m.ss_tag_frequency) : m.ss_tag_frequency
          const bucket = tf && Object.keys(tf)[0]
          const tag = bucket && Object.keys(tf[bucket] || {})[0]
          if (tag) { probe.trigger = tag; probe.triggerSource = 'tags' }
        } catch { /* unreadable metadata: fall back to the name */ }

        if (!probe.trigger) {
          const named = m.ss_output_name || m.name
          /* training job identifiers ("training_<id>-<ts>", "epoch_N") are not triggers;
             no trigger is better than a polluted prompt. */
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

/* Operator trigger table (<data>/loras_triggers.json): takes PRIORITY over the
   header, since activation texts are often missing from the file or too long
   for its metadata. Reloaded on mtime change. */
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

/** Classification: a LoRA declared by a persona is its identity, set by the
 *  server, and is excluded from style pickers. Everything else is offered. */
function loraTags(name) {
  if (personaLoraNames().has(name)) return { kind: 'identite', scope: 'identite' }
  return { kind: 'style', scope: 'all' }
}

/** Info for ONE LoRA by file name. The server resolves the trigger itself
 *  rather than trusting what the front end sends. */
export function loraInfo(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) return null
  const full = path.join(CONFIG.lorasDir, name)
  if (!full.startsWith(CONFIG.lorasDir + path.sep) || !fs.existsSync(full)) return null
  return { name, ...withTable(name, loraProbe(full)), ...loraTags(name) }
}

/** Lists the folder's LoRAs, classified. `arch` says what is actually loadable;
 *  the rest is returned too, flagged, so the UI can show it greyed out. */
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
    try { bytes = fs.statSync(full).size } catch { /* broken link: reported via arch */ }
    return { name, ...withTable(name, loraProbe(full)), ...loraTags(name), bytes }
  })
  return { dir: CONFIG.lorasDir, loras }
}

/** Neutral image for recipes that keep a LoadImage wired in text-to-video mode:
 *  written once to input/ (flat grey 896x1600 PNG). */
export function imageVideT2v() {
  const nom = 'creatoros_t2v_neutre.png'
  const f = path.join(CONFIG.comfyInput, nom)
  if (!fs.existsSync(f)) {
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=896x1600', '-frames:v', '1', f])
    if (r.status !== 0 || !fs.existsSync(f)) throw new Error('image neutre du texte → vidéo non écrite (ffmpeg)')
  }
  return nom
}
