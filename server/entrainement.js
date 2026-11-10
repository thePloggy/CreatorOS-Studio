/* Character training: a LoRA learned from 8 to 30 library images with ai-toolkit (ostris, MIT),
   for FLUX.2 Klein 9B or Krea 2. Owner only. The GPU goes to training: ComfyUI frees its memory
   first, the queue waits for the job to finish. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'

/* One ai-toolkit per engine: FLUX 3 needs a recent version (flux3 arch), installed separately so
   the one training Klein and Krea is untouched. */
export const dossierAiToolkit = (moteur) => moteur === 'flux3'
  ? (process.env.CREATOROS_AI_TOOLKIT_FLUX3 || path.join(os.homedir(), 'ai-toolkit-flux3'))
  : (process.env.CREATOROS_AI_TOOLKIT || path.join(os.homedir(), 'ai-toolkit'))
export const aiToolkitPret = (moteur) => fs.existsSync(path.join(dossierAiToolkit(moteur), 'run.py'))
/* Raw Krea 2 weights (training does not use the turbo version): CREATOROS_KREA2_RAW,
   otherwise ComfyUI's model folders (extra_model_paths.yaml included). */
function poidsKrea2() {
  if (process.env.CREATOROS_KREA2_RAW) return process.env.CREATOROS_KREA2_RAW
  const bases = [path.join(CONFIG.comfyDir, 'models')]
  try {
    for (const m of fs.readFileSync(path.join(CONFIG.comfyDir, 'extra_model_paths.yaml'), 'utf8').matchAll(/^\s*base_path:\s*(\S+)/gm)) bases.push(m[1].replace(/^~/, os.homedir()))
  } catch { /* no extra paths */ }
  return bases.map(b => path.join(b, 'diffusion_models', '_krea2', 'krea2_raw_bf16.safetensors')).find(f => fs.existsSync(f)) ?? null
}

/** Engines the studio can train a LoRA for, with the measured duration per step. */
export const MOTEURS_ENTRAINEMENT = {
  klein: { nom: 'FLUX.2 Klein', secParPas: 1.5, preparationS: 180, modele: () => ({ arch: 'flux2_klein_9b', chemin: 'black-forest-labs/FLUX.2-klein-base-9B' }) },
  krea: { nom: 'Krea 2', secParPas: 2.7, preparationS: 240, modele: () => { const f = poidsKrea2(); return f ? { arch: 'krea2', chemin: f } : null } },
  /* FLUX 3 Image Klein: trained on Klein Base (FLUX Kommunity license accepted on Hugging Face), applied
     to the studio's distilled model. 5.6B parameters: fits in bf16 without quantization. */
  flux3: { nom: 'FLUX 3 Klein', secParPas: 2, preparationS: 300, modele: () => ({ arch: 'flux3', chemin: 'black-forest-labs/flux-3-image-klein-base', sansQuantif: true }) },
}
export const moteurEntrainementPret = m => !!MOTEURS_ENTRAINEMENT[m] && aiToolkitPret(m) && !!MOTEURS_ENTRAINEMENT[m].modele()
export const dureeEstimeeMs = (moteur, pas) => { const m = MOTEURS_ENTRAINEMENT[moteur] ?? MOTEURS_ENTRAINEMENT.klein; return Math.round((pas * m.secParPas + m.preparationS) * 1000) }

const pythonAiToolkit = (moteur) => [path.join(dossierAiToolkit(moteur), 'venv', 'bin', 'python'), path.join(dossierAiToolkit(moteur), '.venv', 'bin', 'python')].find(f => fs.existsSync(f)) ?? 'python3'

/** Prepares the image set and config; returns the yaml path. */
export function preparerEntrainement({ id, images, declencheur, pas, moteur = 'klein', legendes = null }) {
  const modele = MOTEURS_ENTRAINEMENT[moteur]?.modele()
  if (!modele) throw new Error(`entraînement ${moteur} indisponible sur ce studio`)
  const racine = path.join(CONFIG.dataDir, 'entrainements', id)
  const ds = path.join(racine, 'images')
  fs.mkdirSync(ds, { recursive: true })
  images.forEach((f, i) => {
    const ext = path.extname(f) || '.png'
    fs.copyFileSync(f, path.join(ds, `${String(i).padStart(3, '0')}${ext}`))
    // detailed caption if provided (the model then separates the face from framing, outfit and light)
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

/** Runs ai-toolkit; `progres(n, total)` tracks steps. Resolves with the LoRA path. */
const processus = new Map()
/** Stops a running training (its process group); returns true if it was running. */
export function arreterEntrainement(id) {
  const p = processus.get(id)
  if (!p) return false
  try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch { /* already finished */ } }
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
