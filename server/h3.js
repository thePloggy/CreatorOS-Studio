/* MiniMax H3, moteur vidéo optionnel.
   La licence MiniMax H3 exclut l'Union européenne, le Royaume-Uni, la Corée du Sud
   et les États-Unis : le studio ne fournit pas les poids. Une installation locale
   les reçoit de son propriétaire, qui accepte la licence. La démo publique,
   hébergée dans l'UE, n'y donne jamais accès. */
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CONFIG } from './config.js'

export const H3_LICENCE = 'https://huggingface.co/MiniMaxAI/MiniMax-H3'
export const H3_TERRITOIRES_EXCLUS = ['UE', 'Royaume-Uni', 'Corée du Sud', 'États-Unis']

export const H3_FICHIERS = [
  { nom: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', dossier: 'diffusion_models', chargeur: 'UNETLoader', champ: 'unet_name', role: 'modèle vidéo' },
  { nom: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', dossier: 'text_encoders', chargeur: 'CLIPLoader', champ: 'clip_name', role: 'encodeur de texte' },
  { nom: 'minimax_h3_video_vae_fp16.safetensors', dossier: 'vae', chargeur: 'VAELoader', champ: 'vae_name', role: 'VAE vidéo' },
  { nom: 'minimax_h3_audio_vae_fp32.safetensors', dossier: 'vae', chargeur: 'VAELoader', champ: 'vae_name', role: 'VAE audio' },
  { nom: 'h3_lightx2v_turbo_rank24.safetensors', dossier: 'loras', chargeur: 'LoraLoaderModelOnly', champ: 'lora_name', role: 'LoRA turbo (8 pas)' },
]

/** Démo publique : un fichier témoin dans le dossier de données de l'instance. */
export const demoPublique = () => fs.existsSync(path.join(CONFIG.dataDir, 'demo-publique'))

let cache = { at: 0, presents: new Set() }
/** Fichiers que ComfyUI voit, quel que soit le dossier où ils sont rangés. */
async function fichiersVus() {
  if (Date.now() - cache.at < 30_000) return cache.presents
  const presents = new Set()
  for (const chargeur of new Set(H3_FICHIERS.map(f => f.chargeur))) {
    try {
      const r = await fetch(`${CONFIG.comfyUrl}/object_info/${chargeur}`, { signal: AbortSignal.timeout(5000) })
      const d = await r.json()
      for (const champ of Object.values(d?.[chargeur]?.input?.required ?? {})) {
        if (Array.isArray(champ?.[0])) champ[0].forEach(n => presents.add(n))
      }
    } catch { /* ComfyUI injoignable : rien n'est compté comme présent */ }
  }
  cache = { at: Date.now(), presents }
  return presents
}

export async function etatH3() {
  const vus = await fichiersVus()
  const fichiers = H3_FICHIERS.map(({ nom, dossier, role }) => ({ nom, dossier, role, present: vus.has(nom) }))
  const installe = fichiers.every(f => f.present)
  const demo = demoPublique()
  return { demo, installe, disponible: installe && !demo, fichiers, licence: H3_LICENCE, territoiresExclus: H3_TERRITOIRES_EXCLUS }
}

/** Range un fichier envoyé par le propriétaire dans le dossier de modèles de ComfyUI. */
export async function recevoirFichierH3(nom, flux) {
  const f = H3_FICHIERS.find(x => x.nom === nom)
  if (!f) throw Object.assign(new Error('fichier inattendu pour MiniMax H3'), { statusCode: 400 })
  const dossier = path.join(CONFIG.comfyDir, 'models', f.dossier)
  fs.mkdirSync(dossier, { recursive: true })
  const partiel = path.join(dossier, `${f.nom}.part`)
  await pipeline(flux, fs.createWriteStream(partiel))
  fs.renameSync(partiel, path.join(dossier, f.nom))
  cache.at = 0
  return { nom: f.nom, taille: fs.statSync(path.join(dossier, f.nom)).size }
}
