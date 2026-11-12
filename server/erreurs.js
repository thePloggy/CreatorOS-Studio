/* ============================================================
   ComfyUI errors in plain language.

   Raw ComfyUI JSON buries the cause; a failed job gets one sentence:
   "nœud N (type) : message", plus advice for known failures. The raw
   detail goes to the server log, in full, for diagnosis.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

/** Known failures -> what to do. First matching pattern wins. */
const CONSEILS = [
  [/out of memory|OutOfMemory|Allocation on device|CUDA error: out of memory/i,
    'mémoire vidéo insuffisante pour ce rendu : réduire la durée ou la résolution, ou relancer quand la carte est libre'],
  [/No CUDA GPUs are available|CUDA.*not available|Found no NVIDIA driver/i,
    'la carte graphique n\'est plus visible : lancer le diagnostic (pilote NVIDIA)'],
  [/Value not in list|not in \[|not in list/i,
    'un fichier de modèle nommé par la recette est absent de ComfyUI : lancer le diagnostic pour savoir lequel'],
  [/No such file or directory|FileNotFoundError|does not exist|Invalid (image|video|audio) file/i,
    'un fichier d\'entrée est introuvable (image source, vidéo driver ou modèle)'],
  [/No module named|ModuleNotFoundError|ImportError/i,
    'un paquet Python manque dans l\'environnement de ComfyUI : lancer le diagnostic'],
  [/Expected size \d+ but got size \d+|size mismatch|shapes? .* (cannot|not) (be )?(multiplied|broadcast)|channels?/i,
    'deux éléments incompatibles sont branchés ensemble (souvent un VAE ou une LoRA d\'un autre modèle)'],
  [/safetensors|HeaderTooLarge|invalid load key|PytorchStreamReader/i,
    'un fichier de modèle est corrompu ou incomplet : le retélécharger'],
  [/no kernel image is available|sm_\d+ is not compatible/i,
    'un module n\'est pas compilé pour cette carte graphique : lancer le diagnostic, ou choisir un autre outil'],
  [/Node '?[\w ]+'? not found|missing_node_type|custom node may not be installed/i,
    'un module de ComfyUI manque pour cette recette : lancer le diagnostic'],
  [/Connection refused|ECONNREFUSED|fetch failed/i,
    'ComfyUI ne répond plus : il a peut-être redémarré, le rendu sera repris'],
]
/* "No such file" on a LoRA that IS in the folder: safetensors reports an
   unreadable file that way. ComfyUI runs as another user and cannot read it;
   saying "missing" would send the operator to retrain or redownload. */
function conseilLoraIllisible(texte) {
  if (!/No such file or directory|FileNotFoundError|Permission denied|PermissionError/i.test(texte)) return null
  const m = /((?:\/[^\s:'"]+)+\.safetensors)/.exec(texte)
  if (!m) return null
  const f = path.resolve(m[1])
  if (!f.startsWith(path.resolve(CONFIG.lorasDir) + path.sep) || !fs.existsSync(f)) return null
  let mode = '?'
  try { mode = (fs.statSync(f).mode & 0o777).toString(8).padStart(4, '0') } catch { /* stat refused: still unreadable */ }
  return `la LoRA ${path.basename(f)} existe (mode ${mode}) mais ComfyUI, lancé sous un autre utilisateur, ne peut pas la lire : droits du fichier, pas un modèle manquant ni corrompu — lancer le diagnostic (contrôle « loras ») et réparer`
}
const conseilPour = texte => conseilLoraIllisible(texte) ?? CONSEILS.find(([re]) => re.test(texte))?.[1] ?? null
const court = (s, n = 260) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** EXECUTION failure, read from the ComfyUI history entry. */
export function erreurExecution(status = {}) {
  const msgs = status.messages || []
  const err = msgs.find(m => m[0] === 'execution_error')?.[1]
  const interrompu = msgs.find(m => m[0] === 'execution_interrupted')?.[1]
  if (err) {
    const cause = court(String(err.exception_message || err.exception_type || 'erreur inconnue').split('\n')[0], 170)   // first line only: the rest is a memory dump
    const ou = `nœud ${err.node_id ?? '?'} (${err.node_type ?? '?'})`
    const c = conseilPour(`${err.exception_type ?? ''} ${err.exception_message ?? ''}`)
    return `${ou} : ${cause}${c ? ` — ${c}` : ''}`
  }
  if (interrompu)
    return `rendu interrompu au nœud ${interrompu.node_id ?? '?'} (${interrompu.node_type ?? '?'}) — annulé, ou coupé par un autre rendu lancé par-dessus`
  return `exécution non terminée (${status.status_str || 'état inconnu'})`
}

/** REJECTION at submission (HTTP 400) or node errors returned with a 200. */
export function erreurSoumission(texte) {
  let j = null
  try { j = typeof texte === 'string' ? JSON.parse(texte) : texte } catch { /* not JSON: return the text */ }
  if (!j) return `refus de ComfyUI : ${court(texte)}`
  const lignes = []
  for (const [id, n] of Object.entries(j.node_errors ?? {})) {
    for (const e of n.errors ?? []) {
      const entree = e.extra_info?.input_name ? `.${e.extra_info.input_name}` : ''
      const valeur = e.extra_info?.received_value !== undefined ? ` (reçu : ${court(JSON.stringify(e.extra_info.received_value), 80)})` : ''
      lignes.push(`nœud ${id} (${n.class_type ?? '?'})${entree} : ${court(e.message, 120)}${valeur}`)
    }
  }
  const tete = j.error?.message ? court(j.error.message, 160) : null
  if (!lignes.length) return `refus de ComfyUI : ${tete ?? court(texte)}`
  const vus = lignes.slice(0, 4).join(' ; ') + (lignes.length > 4 ? ` ; … (${lignes.length - 4} de plus)` : '')
  const c = conseilPour(lignes.join(' '))
  return `recette refusée par ComfyUI — ${vus}${c ? ` — ${c}` : ''}`
}
