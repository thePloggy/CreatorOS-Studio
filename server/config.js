/* ============================================================
   Configuration du backend CreatorOS.
   Tout est surchargeable par variable d'environnement : aucun chemin
   propre à une machine n'est écrit en dur.
   ============================================================ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = os.homedir()
const repo = path.resolve(import.meta.dirname, '..')

/* Réglages écrits par l'installeur (npm run setup, étape « Studio settings ») : <données>/studio.env, une ligne
   CLE=valeur par réglage. Une variable déjà définie dans l'environnement garde la priorité. */
export const FICHIER_REGLAGES = path.join(process.env.CREATOROS_DATA || path.join(home, 'creatoros-data'), 'studio.env')
try {
  for (const ligne of fs.readFileSync(FICHIER_REGLAGES, 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(ligne)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} catch { /* pas de fichier de réglages : les valeurs par défaut */ }
const comfyDir = process.env.COMFY_DIR || path.join(home, 'ComfyUI')
const dataDir = process.env.CREATOROS_DATA || path.join(home, 'creatoros-data')

/** VRAM de la première carte NVIDIA de cette machine, en Go (0 si inconnue). Lue une fois. */
let vramLue
function vramLocaleGo() {
  if (vramLue === undefined) {
    try {
      const mo = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, encoding: 'utf8' })
      vramLue = Math.round(Number(mo.split('\n')[0]) / 1024) || 0
    } catch { vramLue = 0 }
  }
  return vramLue
}

export const CONFIG = {
  /* Serveur HTTP — boucle locale par défaut. Pour l'ouvrir au réseau, poser
     CREATOROS_HOST=0.0.0.0 derrière un proxy de son choix. */
  port: Number(process.env.CREATOROS_PORT || 8787),
  host: process.env.CREATOROS_HOST || '127.0.0.1',

  /* ComfyUI local. `comfyDir` sert à retrouver ses dossiers et son Python. */
  comfyUrl: process.env.COMFY_URL || 'http://127.0.0.1:8188',
  comfyDir,
  comfyOutput: process.env.COMFY_OUTPUT || path.join(comfyDir, 'output'),
  /* Dossier `input/` de ComfyUI : destination des images déposées par
     l'opérateur pour une recette d'édition. Un nœud LoadImage ne sait lire
     que là — d'où un vrai dépôt de fichier, et pas une URL d'objet. */
  comfyInput: process.env.COMFY_INPUT || path.join(comfyDir, 'input'),
  /* Python du venv de ComfyUI : sert aux scripts annexes (gravure des
     captions) et au diagnostic. */
  comfyPython: process.env.COMFY_PYTHON || path.join(comfyDir, 'venv/bin/python'),

  /* Dossier des LoRA — sert à établir la liste offerte au front et à
     classer chaque fichier par architecture (lecture d'en-tête). */
  lorasDir: process.env.CREATOROS_LORAS || path.join(comfyDir, 'models/loras'),

  /* Patch ControlNet Z-Image (Fun-CN Union), chargé par ModelPatchLoader.
     Vit dans models/model_patches/ et non models/controlnet/ : c'est un
     patch de modèle, pas un ControlNet au sens des nœuds standards. */
  controlNetPatch: process.env.CREATOROS_CN_PATCH
    || 'Z-Image-Turbo-Fun-Controlnet-Union.safetensors',

  /* Textes de façonnage — system prompts du réécriveur, couches moteur.
     Hors du code À DESSEIN : ce sont eux qui décident de ce que le modèle
     rend, ils changent plus souvent qu'une recette et doivent être
     modifiables sans déploiement. Lus à CHAQUE job. */
  promptsDir: process.env.CREATOROS_PROMPTS || path.join(repo, 'prompts'),

  /* Workflows au format API — source de vérité des recettes. */
  workflowsDir: process.env.CREATOROS_WORKFLOWS || path.join(repo, 'workflows'),
  // Fichiers wildcard *.txt : la source des items « 🎲 au hasard »,
  // tirés côté serveur avec la seed du job (server/wildcards.js).
  wildcardsDir: process.env.CREATOROS_WILDCARDS || path.join(dataDir, 'wildcards'),
  defaultWorkflow: process.env.CREATOROS_WORKFLOW || 'PROD_gen_krea_sfw.json',
  /* Moteur photo par défaut : Krea 2 ('krea') ou FLUX.2 Klein 9B ('klein').
     Un job peut demander l'autre (job.photoEngine). Une seule source : le
     réécriveur, le carrousel et les recettes lisent tous cette valeur. */
  photoEngine: ['krea', 'klein'].includes((process.env.CREATOROS_PHOTO_ENGINE || '').trim().toLowerCase())
    ? process.env.CREATOROS_PHOTO_ENGINE.trim().toLowerCase()
    // Krea 2 pèse 13 Go : sous 14 Go de VRAM, Klein (allégé en 4B, cf. allege.js) le remplace
    : vramLocaleGo() && vramLocaleGo() < 14 || [8, 12].includes(Number(process.env.CREATOROS_VRAM)) ? 'klein' : 'krea',

  /* Données persistantes — HORS du dépôt git : ni images ni base n'ont à
     s'y trouver. */
  dataDir,
  /* Persona : `persona.json` dans le dossier de données (cf. server/persona.js). */
  personaFile: process.env.CREATOROS_PERSONA_FILE || path.join(dataDir, 'persona.json'),
  /* Livraisons (vidéos à caption gravée). */
  exportsDir: process.env.CREATOROS_EXPORTS || path.join(dataDir, 'exports'),

  /* Front compilé (npm run build). */
  distDir: path.join(repo, 'dist'),

  /* Ollama réécrit le prompt AVANT la diffusion, sur le même GPU.
     Un LLM de ~20 Gio et un modèle de diffusion de ~20 Gio résidents en même
     temps sur une carte de 32 Gio = CUDA OOM. On force donc keep_alive=0 :
     le LLM se décharge dès sa réponse. CREATOROS_OLLAMA_UNLOAD=0 pour
     retrouver le comportement du template (keep_alive 5 min). */
  ollamaUnload: process.env.CREATOROS_OLLAMA_UNLOAD !== '0',

  /* Réécriture de prompt — Ollama (cf. server/composer.js). */
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  /* VLM de DESCRIPTION (describeScene / describeOutfit / carrousel). Servi en
     CPU par défaut : aucune concurrence VRAM avec ComfyUI. */
  visionDescribeModel: process.env.CREATOROS_VLM_DESCRIBE || 'qwen2.5vl:7b',
  visionDescribeCpu: process.env.CREATOROS_VLM_DESCRIBE_GPU !== '1',
  /* Un seul registre (SFW) : un seul rédacteur. Clé conservée pour
     /api/health, qui expose la table. */
  composerModels: {
    sfw: process.env.CREATOROS_LLM || 'mistral-small:latest',
  },
  /* Sur CPU une réécriture prend 20 à 60 s selon le modèle. La marge couvre
     un premier appel qui doit charger le modèle depuis le disque. */
  composerTimeoutMs: Number(process.env.CREATOROS_LLM_TIMEOUT || 240000),

  /* Garde-fou : un job qui dépasse ça est marqué en échec, pas laissé pendre.
     120 min : un long rendu motion peut légitimement dépasser l'heure. Ce
     délai est un détecteur d'INACTIVITÉ (il ne court que prompt ni running
     ni pending), donc large sans risque. */
  jobTimeoutMs: Number(process.env.CREATOROS_JOB_TIMEOUT_MS || 120 * 60 * 1000),

  /* Clé du propriétaire (démo publique). Posée, elle verrouille ce qui décrit
     le studio — page Créateur, personnages et garde-robe, LoRA, photos de
     profil, recettes et prompts : sans l'en-tête X-Owner-Key exact, ces
     écritures répondent 403. Absente, rien n'est verrouillé (installation
     locale, un seul utilisateur). */
  cleProprietaire: (process.env.CREATOROS_OWNER_KEY || '').trim() || null,
}

CONFIG.mediaDir = path.join(CONFIG.dataDir, 'media')
CONFIG.dbFile = path.join(CONFIG.dataDir, 'db', 'creatoros.sqlite')
