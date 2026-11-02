/* ============================================================
   promptBuilder — construit le champ « prompt image » en temps
   réel à partir des sélections (comportement ↻ auto, éditable).
   Pure fonction : sélections → texte. Aucune dépendance UI.
   ============================================================ */
import type { PhotoSelections, VideoSelections } from '../types'
import { allOutfits, allEnvironments, allStyles, allTextPoses } from '../store/useVocabStore'

/** Photo : phrase de contenu générée depuis les sélecteurs.
 *  Tenue/lieu portent une ligne de prompt complète (`prompt`) — elle prime ; les overrides utilisateur s'ajoutent en
 *  clauses (« adjusted: … ») pour rester éditables sans casser la ligne. */
export function buildPhotoPrompt(sel: PhotoSelections): string {
  const outfit = sel.outfitId ? allOutfits().find(o => o.id === sel.outfitId) : undefined
  const env = sel.environmentId ? allEnvironments().find(e => e.id === sel.environmentId) : undefined
  const style = sel.styleId ? allStyles().find(s => s.id === sel.styleId) : undefined
  const pose = sel.textPoseId ? allTextPoses().find(p => p.id === sel.textPoseId) : undefined
  // Tout vide → chaîne vide : c'est l'opérateur qui écrit le prompt.
  if (!outfit && !env && !style && !pose) return ''

  let outfitTxt = ''
  if (outfit) {
    // Hybride : attributs par défaut de la tenue + overrides utilisateur.
    const material = sel.outfitOverrides.material ?? outfit.material
    const fit = sel.outfitOverrides.fit ?? outfit.fit
    const color = sel.outfitOverrides.color ?? outfit.color
    if (outfit.prompt) {
      outfitTxt = `wearing ${outfit.prompt}`
      const adj: string[] = []
      if (sel.outfitOverrides.color !== undefined) adj.push(color)
      if (sel.outfitOverrides.material !== undefined) adj.push(material)
      if (sel.outfitOverrides.fit !== undefined) adj.push(fit)
      if (adj.length) outfitTxt += ` (adjusted: ${adj.join(' ')})`
    } else {
      outfitTxt = `wearing ${[fit, color, outfit.garment].filter(Boolean).join(' ')}`
        + (material ? ` in ${material}` : '')
    }
  }

  const envTxt = env ? (env.prompt ?? `${env.sceneType}, ${env.location}`) : ''
  const weather = sel.weatherOverride ?? env?.weather
  const styleTxt = style ? [style.framing, style.lens && `${style.lens} look`].filter(Boolean).join(', ') : ''
  const poseTxt = pose?.prompt ?? ''

  // Sans lieu, la météo choisie reste utile (« (golden hour), … »). L'identité
  // du personnage n'est pas écrite ici : le serveur l'injecte.
  const head = [envTxt, weather ? `(${weather})` : ''].filter(Boolean).join(' ')
  return [
    head,
    outfitTxt,
    poseTxt,
    styleTxt,
  ].filter(Boolean).join(', ')
}

/** Vidéo : le prompt ne porte que le mouvement — l'identité vient des frames. */
export function buildVideoPrompt(sel: VideoSelections): string {
  const parts: string[] = []
  if (sel.task === 'motion_pure') {
    /* Ce texte part TEL QUEL au moteur (261:222, la branche pose) : c'est le
       driver qui décrit le geste, le texte ne fait que préciser. Pas de
       débogage ici : l'encodeur le prendrait pour une consigne. */
    return sel.motionText.trim()
  }

  /* i2v — ce texte part TEL QUEL au moteur quand l'opérateur ne passe pas par
     le composeur. On écrit donc un brief, pas une ligne de débogage : ni
     « from start #442 », ni durée, ni format (ils sont dans la recette,
     les répéter dans le prompt ne fait que diluer le mouvement demandé).

     Le brief audio rejoint le même texte : LTX-2.5 comme MiniMax H3 n'ont
     qu'une seule entrée de prompt, commune à l'image et au son. */
  if (sel.motionText.trim()) parts.push(sel.motionText.trim())
  if (sel.cameraText.trim()) parts.push(`caméra : ${sel.cameraText.trim()}`)
  if (sel.withAudio && sel.audioText.trim()) parts.push(`son : ${sel.audioText.trim()}`)
  return parts.join('. ')
}
