/* Entraînement d'un personnage : une LoRA apprise sur 8 à 30 images de la bibliothèque, avec
   ai-toolkit (ostris, MIT), pour FLUX.2 Klein 9B ou pour Krea 2. Réservé au propriétaire. Le GPU
   passe à l'entraînement : ComfyUI vide sa mémoire avant, la file attend la fin du job. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'

/* Un ai-toolkit par moteur : FLUX 3 demande une version récente (arch flux3), installée à part pour ne
   pas toucher celle qui entraîne Klein et Krea. */
export const dossierAiToolkit = (moteur) => moteur === 'flux3'
  ? (process.env.CREATOROS_AI_TOOLKIT_FLUX3 || path.join(os.homedir(), 'ai-toolkit-flux3'))
  : (process.env.CREATOROS_AI_TOOLKIT || path.join(os.homedir(), 'ai-toolkit'))
export const aiToolkitPret = (moteur) => fs.existsSync(path.join(dossierAiToolkit(moteur), 'run.py'))
/* Poids bruts de Krea 2 (l'entraînement ne se fait pas sur la version turbo) : variable
   CREATOROS_KREA2_RAW, sinon les dossiers de modèles de ComfyUI (extra_model_paths.yaml compris). */
function poidsKrea2() {
  if (process.env.CREATOROS_KREA2_RAW) return process.env.CREATOROS_KREA2_RAW
  const bases = [path.join(CONFIG.comfyDir, 'models')]
  try {
    for (const m of fs.readFileSync(path.join(CONFIG.comfyDir, 'extra_model_paths.yaml'), 'utf8').matchAll(/^\s*base_path:\s*(\S+)/gm)) bases.push(m[1].replace(/^~/, os.homedir()))
  } catch { /* pas de chemins supplémentaires */ }
  return bases.map(b => path.join(b, 'diffusion_models', '_krea2', 'krea2_raw_bf16.safetensors')).find(f => fs.existsSync(f)) ?? null
}

/** Moteurs pour lesquels le studio sait entraîner une LoRA, avec la durée observée par pas. */
export const MOTEURS_ENTRAINEMENT = {
  klein: { nom: 'FLUX.2 Klein', secParPas: 1.5, preparationS: 180, modele: () => ({ arch: 'flux2_klein_9b', chemin: 'black-forest-labs/FLUX.2-klein-base-9B' }) },
  krea: { nom: 'Krea 2', secParPas: 2.7, preparationS: 240, modele: () => { const f = poidsKrea2(); return f ? { arch: 'krea2', chemin: f } : null } },
  /* FLUX 3 Image Klein : appris sur Klein Base (licence FLUX Kommunity acceptée sur Hugging Face), appliqué
     au modèle distillé du studio. 5,6 milliards de paramètres : il tient en bf16, sans quantification. */
  flux3: { nom: 'FLUX 3 Klein', secParPas: 2, preparationS: 300, modele: () => ({ arch: 'flux3', chemin: 'black-forest-labs/flux-3-image-klein-base', sansQuantif: true }) },
}
export const moteurEntrainementPret = m => !!MOTEURS_ENTRAINEMENT[m] && aiToolkitPret(m) && !!MOTEURS_ENTRAINEMENT[m].modele()
export const dureeEstimeeMs = (moteur, pas) => { const m = MOTEURS_ENTRAINEMENT[moteur] ?? MOTEURS_ENTRAINEMENT.klein; return Math.round((pas * m.secParPas + m.preparationS) * 1000) }

const pythonAiToolkit = (moteur) => [path.join(dossierAiToolkit(moteur), 'venv', 'bin', 'python'), path.join(dossierAiToolkit(moteur), '.venv', 'bin', 'python')].find(f => fs.existsSync(f)) ?? 'python3'

/** Prépare le jeu d'images et la configuration ; renvoie le chemin du yaml. */
export function preparerEntrainement({ id, images, declencheur, pas, moteur = 'klein', legendes = null }) {
  const modele = MOTEURS_ENTRAINEMENT[moteur]?.modele()
  if (!modele) throw new Error(`entraînement ${moteur} indisponible sur ce studio`)
  const racine = path.join(CONFIG.dataDir, 'entrainements', id)
  const ds = path.join(racine, 'images')
  fs.mkdirSync(ds, { recursive: true })
  images.forEach((f, i) => {
    const ext = path.extname(f) || '.png'
    fs.copyFileSync(f, path.join(ds, `${String(i).padStart(3, '0')}${ext}`))
    // légende détaillée si fournie (le modèle sépare alors le visage du cadrage, de la tenue et de la lumière)
    const l = Array.isArray(legendes) && typeof legendes[i] === 'string' && legendes[i].trim() ? legendes[i].trim().slice(0, 600) : null
    fs.writeFileSync(path.join(ds, `${String(i).padStart(3, '0')}.txt`), l ? (l.toLowerCase().includes(declencheur) ? l : `${declencheur}, ${l}`) : `${declencheur}, photo of ${declencheur}`)
  })
  const yaml = `job: extension
config:
  name: "${id}"
  process:
    - type: 'sd_trainer'
      training_folder: "${path.join(racine, 'sortie')}"
      device: cuda:0
      trigger_word: "${declencheur}"
      network: { type: "lora", linear: 32, linear_alpha: 32 }
      save: { dtype: float16, save_every: ${pas}, max_step_saves_to_keep: 1, push_to_hub: false }
      datasets:
        - folder_path: "${ds}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          cache_latents_to_disk: true
          resolution: [ 512, 768, 1024 ]
      train:
        batch_size: 1
        steps: ${pas}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: "flowmatch"
        timestep_type: weighted
        optimizer: "adamw8bit"
        lr: 1e-4
        dtype: bf16
      model:
        arch: ${modele.arch}
        name_or_path: "${modele.chemin}"
        quantize: ${modele.sansQuantif ? 'false' : 'true'}
        quantize_te: true
        ${modele.sansQuantif ? 'qtype_te: qfloat8' : 'qtype: qfloat8'}
`
  const f = path.join(racine, 'config.yaml')
  fs.writeFileSync(f, yaml)
  return { config: f, sortie: path.join(racine, 'sortie', id), moteur }
}

/** Lance ai-toolkit ; `progres(n, total)` suit les pas. Résout avec le chemin de la LoRA. */
const processus = new Map()
/** Arrête un entraînement en cours (son groupe de processus) ; renvoie true s'il tournait. */
export function arreterEntrainement(id) {
  const p = processus.get(id)
  if (!p) return false
  try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch { /* déjà fini */ } }
  return true
}
export function entrainer({ id, config, sortie, pas, moteur }, progres) {
  return new Promise((ok, ko) => {
    const p = spawn(pythonAiToolkit(moteur), ['run.py', config], { cwd: dossierAiToolkit(moteur), env: { ...process.env, PYTHONUNBUFFERED: '1' }, detached: true })
    if (id) processus.set(id, p)
    let reste = ''
    const lire = b => {
      const t = reste + b.toString(); const l = t.split(/[\r\n]/); reste = l.pop() ?? ''
      for (const x of l) { const m = /(\d+)\/(\d+) \[/.exec(x); if (m && Number(m[2]) === pas) progres(Number(m[1]), pas) }
    }
    p.stdout.on('data', lire); p.stderr.on('data', lire)
    p.on('error', ko)
    p.on('close', code => {
      if (id) processus.delete(id)
      if (code !== 0) return ko(new Error(`ai-toolkit s'est arrêté (code ${code})`))
      const f = fs.existsSync(sortie) ? fs.readdirSync(sortie).filter(x => x.endsWith('.safetensors')).sort().pop() : null
      f ? ok(path.join(sortie, f)) : ko(new Error('LoRA non produite'))
    })
  })
}
