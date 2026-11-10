/* ============================================================
   promptBuilder — builds the "image prompt" field live from the
   selections (auto-refresh, editable).
   Pure function: selections → text. No UI dependency.
   ============================================================ */
import type { PhotoSelections, VideoSelections } from '../types'
import { allOutfits, allEnvironments, allStyles, allTextPoses } from '../store/useVocabStore'

/** Photo: content sentence built from the selectors.
 *  Outfit/location carry a full prompt line (`prompt`) that takes precedence; user overrides are appended as
 *  clauses ("adjusted: …") so the line stays editable. */
export function buildPhotoPrompt(sel: PhotoSelections): string {
  const outfit = sel.outfitId ? allOutfits().find(o => o.id === sel.outfitId) : undefined
  const env = sel.environmentId ? allEnvironments().find(e => e.id === sel.environmentId) : undefined
  const style = sel.styleId ? allStyles().find(s => s.id === sel.styleId) : undefined
  const pose = sel.textPoseId ? allTextPoses().find(p => p.id === sel.textPoseId) : undefined
  // All empty → empty string: the operator writes the prompt.
  if (!outfit && !env && !style && !pose) return ''

  let outfitTxt = ''
  if (outfit) {
    // Hybrid: outfit default attributes + user overrides.
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

  // Without a location, the chosen weather is still used ("(golden hour), …"). The character
  // identity is not written here: the server injects it.
  const head = [envTxt, weather ? `(${weather})` : ''].filter(Boolean).join(' ')
  return [
    head,
    outfitTxt,
    poseTxt,
    styleTxt,
  ].filter(Boolean).join(', ')
}

/** Video: the prompt carries only the motion — identity comes from the frames. */
export function buildVideoPrompt(sel: VideoSelections): string {
  const parts: string[] = []
  if (sel.task === 'motion_pure') {
    /* This text is sent AS IS to the engine (261:222, the pose branch): the
       driver describes the gesture, the text only refines it. No debug
       text here: the encoder would treat it as an instruction. */
    return sel.motionText.trim()
  }

  /* i2v — this text is sent AS IS to the engine when the composer is not used.
     It is a brief, not a debug line: no source id, duration or format
     (those are in the recipe; repeating them dilutes the requested motion).

     The audio brief goes into the same text: LTX-2.5 and MiniMax H3 have a
     single prompt input shared by image and sound. */
  if (sel.motionText.trim()) parts.push(sel.motionText.trim())
  if (sel.cameraText.trim()) parts.push(`camera: ${sel.cameraText.trim()}`)
  if (sel.withAudio && sel.audioText.trim()) parts.push(`son : ${sel.audioText.trim()}`)
  /* nothing typed: a neutral instruction that extends the image, with no imposed gesture or camera move */
  if (!parts.length) return 'Natural, realistic motion that simply continues what the image shows, in real time; the camera keeps the framing of the image.'
  return parts.join('. ')
}
