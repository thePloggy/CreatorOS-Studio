/* ============================================================
   CreatorOS backend configuration.
   Everything can be overridden by environment variable: no
   machine-specific path is hard-coded.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vramGoSync } from './carteGraphique.js'

const home = os.homedir()
const repo = path.resolve(import.meta.dirname, '..')

/* Settings written by the installer (npm run setup, "Studio settings" step): <data>/studio.env, one
   KEY=value line per setting. A variable already set in the environment takes priority. */
export const FICHIER_REGLAGES = path.join(process.env.CREATOROS_DATA || path.join(home, 'creatoros-data'), 'studio.env')
try {
  for (const ligne of fs.readFileSync(FICHIER_REGLAGES, 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(ligne)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} catch { /* no settings file: defaults */ }
const comfyDir = process.env.COMFY_DIR || path.join(home, 'ComfyUI')
const dataDir = process.env.CREATOROS_DATA || path.join(home, 'creatoros-data')

/** VRAM of this machine's first card, in GB (0 if unknown); on a Mac, the planned share of the unified memory. Read once. */
let vramLue
function vramLocaleGo() {
  if (vramLue === undefined) {
    vramLue = vramGoSync()   // NVIDIA, AMD or Apple Silicon (carteGraphique.js)
  }
  return vramLue
}

export const CONFIG = {
  /* HTTP server, loopback by default. To expose it to the network, set
     CREATOROS_HOST=0.0.0.0 behind a proxy of your choice. */
  port: Number(process.env.CREATOROS_PORT || 8787),
  host: process.env.CREATOROS_HOST || '127.0.0.1',

  /* Local ComfyUI. `comfyDir` is used to find its folders and its Python. */
  comfyUrl: process.env.COMFY_URL || 'http://127.0.0.1:8188',
  comfyDir,
  comfyOutput: process.env.COMFY_OUTPUT || path.join(comfyDir, 'output'),
  /* ComfyUI `input/` folder: destination of images uploaded for an edit
     recipe. A LoadImage node can only read from there, hence a real file
     upload rather than an object URL. */
  comfyInput: process.env.COMFY_INPUT || path.join(comfyDir, 'input'),
  /* ComfyUI venv Python: used by helper scripts (caption burning) and
     the diagnostic. */
  comfyPython: process.env.COMFY_PYTHON || path.join(comfyDir, 'venv/bin/python'),

  /* LoRA folder: used to build the list offered to the front end and to
     classify each file by architecture (header read). */
  lorasDir: process.env.CREATOROS_LORAS || path.join(comfyDir, 'models/loras'),

  /* Z-Image ControlNet patch (Fun-CN Union), loaded by ModelPatchLoader.
     Lives in models/model_patches/, not models/controlnet/: it is a model
     patch, not a ControlNet in the standard node sense. */
  controlNetPatch: process.env.CREATOROS_CN_PATCH
    || 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors',

  /* Shaping texts: rewriter system prompts, engine layers. Kept outside the
     code on purpose so they can be edited without a deploy. Read on EVERY job. */
  promptsDir: process.env.CREATOROS_PROMPTS || path.join(repo, 'prompts'),

  /* API-format workflows: source of truth for recipes. */
  workflowsDir: process.env.CREATOROS_WORKFLOWS || path.join(repo, 'workflows'),
  // Wildcard *.txt files: source of the "🎲 random" items,
  // drawn server-side with the job seed (server/wildcards.js).
  wildcardsDir: process.env.CREATOROS_WILDCARDS || path.join(dataDir, 'wildcards'),
  defaultWorkflow: process.env.CREATOROS_WORKFLOW || 'PROD_gen_krea_sfw.json',
  /* Default photo engine: Krea 2 ('krea') or FLUX.2 Klein 9B ('klein').
     A job can request the other (job.photoEngine). Single source: the
     rewriter, the carousel and the recipes all read this value. */
  photoEngine: ['krea', 'klein'].includes((process.env.CREATOROS_PHOTO_ENGINE || '').trim().toLowerCase())
    ? process.env.CREATOROS_PHOTO_ENGINE.trim().toLowerCase()
    // Krea 2 weighs 13 GB: below 14 GB of VRAM, Klein (lightened to 4B, see allege.js) replaces it
    : vramLocaleGo() && vramLocaleGo() < 14 || [8, 12].includes(Number(process.env.CREATOROS_VRAM)) ? 'klein' : 'krea',

  /* Persistent data, OUTSIDE the git repo. */
  dataDir,
  /* Persona: `persona.json` in the data directory (see server/persona.js). */
  personaFile: process.env.CREATOROS_PERSONA_FILE || path.join(dataDir, 'persona.json'),
  /* Deliveries (videos with burned captions). */
  exportsDir: process.env.CREATOROS_EXPORTS || path.join(dataDir, 'exports'),

  /* Built front end (npm run build). */
  distDir: path.join(repo, 'dist'),

  /* Ollama rewrites the prompt BEFORE diffusion, on the same GPU. A ~20 GiB LLM
     and a ~20 GiB diffusion model resident together on a 32 GiB card = CUDA
     OOM, so keep_alive=0 is forced: the LLM unloads right after replying.
     CREATOROS_OLLAMA_UNLOAD=0 restores the default (keep_alive 5 min). */
  ollamaUnload: process.env.CREATOROS_OLLAMA_UNLOAD !== '0',

  /* Prompt rewriting via Ollama (see server/composer.js). */
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  /* DESCRIPTION VLM (describeScene / describeOutfit / carousel). Served on
     CPU by default: no VRAM contention with ComfyUI. */
  visionDescribeModel: process.env.CREATOROS_VLM_DESCRIBE || 'qwen2.5vl:7b',
  visionDescribeCpu: process.env.CREATOROS_VLM_DESCRIBE_GPU !== '1',
  /* A single register (SFW): a single writer. Key kept for /api/health,
     which exposes the table. */
  composerModels: {
    sfw: process.env.CREATOROS_LLM || 'mistral-small:latest',
  },
  /* On CPU a rewrite takes 20 to 60 s depending on the model. The margin
     covers a first call that must load the model from disk. */
  composerTimeoutMs: Number(process.env.CREATOROS_LLM_TIMEOUT || 240000),

  /* Safeguard: a job exceeding this is marked failed instead of hanging.
     120 min: a long motion render can legitimately exceed an hour. This is
     an INACTIVITY timeout (runs only while the prompt is neither running nor
     pending), so it can be generous. */
  jobTimeoutMs: Number(process.env.CREATOROS_JOB_TIMEOUT_MS || 120 * 60 * 1000),

  /* Owner key (public demo). When set, it locks what describes the studio
     (Creator page, characters and wardrobe, LoRAs, profile photos, recipes
     and prompts): without the exact X-Owner-Key header, these writes return
     403. When unset, nothing is locked (local single-user install). */
  cleProprietaire: (process.env.CREATOROS_OWNER_KEY || '').trim() || null,
  /* Adult mode (local single-user install): text-to-image generation is not filtered for sexual
     content. Never with an owner key (shared studio), never below the "minors" floor, never
     when a render starts from an imported photo (see jobs.js). */
  // never on the public demo: requires a local install, no owner key, listening on this machine only
  contenuAdulte: process.env.CREATOROS_CONTENU_ADULTE === '1' && !(process.env.CREATOROS_OWNER_KEY || '').trim()
    && ['127.0.0.1', 'localhost', '::1'].includes(process.env.CREATOROS_HOST || '127.0.0.1'),
}

CONFIG.mediaDir = path.join(CONFIG.dataDir, 'media')
CONFIG.dbFile = path.join(CONFIG.dataDir, 'db', 'creatoros.sqlite')
