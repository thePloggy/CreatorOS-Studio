/* Entraînement d'un personnage : une LoRA FLUX.2 Klein 9B apprise sur 8 à 30 images de la
   bibliothèque, avec ai-toolkit (ostris, MIT). Réservé au propriétaire. Le GPU passe à
   l'entraînement : ComfyUI vide sa mémoire avant, la file attend la fin du job. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'

export const dossierAiToolkit = () => process.env.CREATOROS_AI_TOOLKIT || path.join(os.homedir(), 'ai-toolkit')
export const aiToolkitPret = () => fs.existsSync(path.join(dossierAiToolkit(), 'run.py'))
const pythonAiToolkit = () => [path.join(dossierAiToolkit(), 'venv', 'bin', 'python'), path.join(dossierAiToolkit(), '.venv', 'bin', 'python')].find(f => fs.existsSync(f)) ?? 'python3'

/** Prépare le jeu d'images et la configuration ; renvoie le chemin du yaml. */
export function preparerEntrainement({ id, images, declencheur, pas }) {
  const racine = path.join(CONFIG.dataDir, 'entrainements', id)
  const ds = path.join(racine, 'images')
  fs.mkdirSync(ds, { recursive: true })
  images.forEach((f, i) => {
    const ext = path.extname(f) || '.png'
    fs.copyFileSync(f, path.join(ds, `${String(i).padStart(3, '0')}${ext}`))
    fs.writeFileSync(path.join(ds, `${String(i).padStart(3, '0')}.txt`), `${declencheur}, photo of ${declencheur}`)
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
        arch: flux2_klein_9b
        name_or_path: black-forest-labs/FLUX.2-klein-base-9B
        quantize: true
        quantize_te: true
        qtype: qfloat8
`
  const f = path.join(racine, 'config.yaml')
  fs.writeFileSync(f, yaml)
  return { config: f, sortie: path.join(racine, 'sortie', id) }
}

/** Lance ai-toolkit ; `progres(n, total)` suit les pas. Résout avec le chemin de la LoRA. */
export function entrainer({ config, sortie, pas }, progres) {
  return new Promise((ok, ko) => {
    const p = spawn(pythonAiToolkit(), ['run.py', config], { cwd: dossierAiToolkit(), env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    let reste = ''
    const lire = b => {
      const t = reste + b.toString(); const l = t.split(/[\r\n]/); reste = l.pop() ?? ''
      for (const x of l) { const m = /(\d+)\/(\d+) \[/.exec(x); if (m && Number(m[2]) === pas) progres(Number(m[1]), pas) }
    }
    p.stdout.on('data', lire); p.stderr.on('data', lire)
    p.on('error', ko)
    p.on('close', code => {
      if (code !== 0) return ko(new Error(`ai-toolkit s'est arrêté (code ${code})`))
      const f = fs.existsSync(sortie) ? fs.readdirSync(sortie).filter(x => x.endsWith('.safetensors')).sort().pop() : null
      f ? ok(path.join(sortie, f)) : ko(new Error('LoRA non produite'))
    })
  })
}
