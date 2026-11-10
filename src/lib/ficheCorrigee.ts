/* ============================================================
   Operator corrections to what the VLM read in the carousel's first
   photo. A corrected dimension replaces both the short and long text
   of the sheet; the correction is also appended to the VLM description,
   which the writer reads alongside the sheet, so the original reading
   does not contradict the sheet.
   ============================================================ */

type Dim = { texte?: string; court?: string; nom?: string }
export type Corrections = Record<string, string>

export const NOMS_DIM: Record<string, string> = {
  outfit: 'outfit', pose: 'pose', location: 'location', props: 'props (main object)', light: 'light', style: 'photo style',
}

export function corrigerFiche(prep: { fiche: unknown; vlm: string | null } | null, corr: Corrections) {
  const actives = Object.entries(corr).filter(([, v]) => v.trim())
  if (!prep || !actives.length) return { fiche: prep?.fiche, vlm: prep?.vlm ?? undefined }
  const fiche = structuredClone(prep.fiche) as Record<string, Dim>
  for (const [k, v] of actives) {
    const t = v.trim()
    fiche[k] = { ...(fiche[k] ?? {}), texte: t, court: t }
    if (k === 'props') fiche[k].nom = t.split(/\s*,\s*/)[0].toLowerCase()
  }
  const note = actives.map(([k, v]) => `- ${NOMS_DIM[k] ?? k}: ${v.trim()}`).join('\n')
  const vlm = `${prep.vlm ?? ''}\n\nOPERATOR CORRECTION — these replace what the description above says, they are what the first photo really shows:\n${note}`.trim()
  return { fiche, vlm }
}
