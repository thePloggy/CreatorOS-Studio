/* ============================================================
   Erreurs de ComfyUI dites en clair.

   Le JSON brut de ComfyUI noie la cause : un job « bloqué » porte une phrase.

   Forme : « nœud N (type) : message », et pour les pannes
   connues un conseil. Le détail brut part dans le journal du serveur, où il
   reste entier pour le diagnostic.
   ============================================================ */

/** Pannes reconnues → ce qu'il faut faire. Le premier motif qui correspond gagne. */
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
const conseilPour = texte => CONSEILS.find(([re]) => re.test(texte))?.[1] ?? null
const court = (s, n = 260) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** Échec d'EXÉCUTION, lu dans l'entrée d'historique de ComfyUI. */
export function erreurExecution(status = {}) {
  const msgs = status.messages || []
  const err = msgs.find(m => m[0] === 'execution_error')?.[1]
  const interrompu = msgs.find(m => m[0] === 'execution_interrupted')?.[1]
  if (err) {
    const cause = court(String(err.exception_message || err.exception_type || 'erreur inconnue').split('\n')[0], 170)   // 1re ligne : la suite est un relevé mémoire
    const ou = `nœud ${err.node_id ?? '?'} (${err.node_type ?? '?'})`
    const c = conseilPour(`${err.exception_type ?? ''} ${err.exception_message ?? ''}`)
    return `${ou} : ${cause}${c ? ` — ${c}` : ''}`
  }
  if (interrompu)
    return `rendu interrompu au nœud ${interrompu.node_id ?? '?'} (${interrompu.node_type ?? '?'}) — annulé, ou coupé par un autre rendu lancé par-dessus`
  return `exécution non terminée (${status.status_str || 'état inconnu'})`
}

/** REFUS à la soumission (HTTP 400) ou erreurs de nœuds renvoyées avec un 200. */
export function erreurSoumission(texte) {
  let j = null
  try { j = typeof texte === 'string' ? JSON.parse(texte) : texte } catch { /* pas du JSON : on rend le texte */ }
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
