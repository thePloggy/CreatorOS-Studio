/* ============================================================
   Ce que la stack de production sait faire — et ce qu'elle ne
   sait plus faire depuis qu'elle a changé de base.

   Un écran qui propose un réglage inopérant est pire qu'un écran
   qui ne le propose pas : l'opérateur croit avoir agi. D'où un
   drapeau explicite plutôt qu'un bloc commenté.
   ============================================================ */

/** ControlNet en Génération.
 *
 *  Faux : les deux recettes de génération tournent sur
 *  FLUX.2 Klein 9B, et **il n'existe aucun ControlNet pour cette
 *  architecture**. Vérifié plutôt que supposé — `comfy/controlnet.py` ne
 *  mentionne jamais `flux2`, et les deux seuls nœuds à `model_patch` d'image
 *  fixe des 2080 de `/object_info` (`QwenImageDiffsynthControlnet`,
 *  `ZImageFunControlnet`) sont Z-Image et rendent d'ailleurs des images
 *  identiques au pixel.
 *
 *  Le ControlNet qui existe côté FLUX.2 (`alibaba-pai/FLUX.2-dev-Fun-Controlnet-Union`)
 *  vise le 32B [dev], pas klein 9B, et n'a pas de nœud ComfyUI.
 *
 *  La plomberie côté serveur (`injectJob`, `/api/upload`, `latentFor`) reste
 *  en place et testée : le jour où un ControlNet Klein sort, ce booléen
 *  suffit à rallumer l'accordéon. */
export const CONTROLNET_AVAILABLE = false

/** Ce qu'on affiche à la place, pour que l'absence soit lisible. */
export const CONTROLNET_DORMANT_NOTE =
  'Indisponible sur la base Klein — aucun ControlNet n’existe pour FLUX.2 klein 9B. '
  + 'Pour imposer une pose, la décrire au prompt.'
