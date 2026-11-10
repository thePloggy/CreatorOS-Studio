/* ============================================================
   Feature flags for what the production stack supports.
   A setting that does nothing is hidden rather than shown inert.
   ============================================================ */

/** ControlNet in Generation.
 *
 *  False: both generation recipes run on FLUX.2 Klein 9B, which has no
 *  ControlNet support in ComfyUI. The server-side plumbing (`injectJob`,
 *  `/api/upload`, `latentFor`) stays in place; setting this flag to true
 *  re-enables the accordion. */
export const CONTROLNET_AVAILABLE = false

/** Text shown instead, so the missing feature is explained. */
export const CONTROLNET_DORMANT_NOTE =
  'Indisponible sur la base Klein — aucun ControlNet n’existe pour FLUX.2 klein 9B. '
  + 'Pour imposer une pose, la décrire au prompt.'
