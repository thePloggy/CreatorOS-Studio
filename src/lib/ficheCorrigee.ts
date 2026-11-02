/* ============================================================
   Corrections de l'opérateur sur ce que le VLM a lu dans la 1re photo du
   carrousel (il reconnaît mal les véhicules). Une dimension
   corrigée remplace le texte court ET le texte long de la fiche ; la
   correction est aussi ajoutée à la description VLM, que le rédacteur lit
   en plus de la fiche — sinon l'ancienne lecture (« a red sedan ») y
   resterait et contredirait la fiche.
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
