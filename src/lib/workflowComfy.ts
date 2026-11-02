/** Télécharge le graphe API ComfyUI exact d'un rendu (à glisser dans ComfyUI). Renvoie les modèles qu'il utilise. */
export async function telechargerWorkflow(assetId: string): Promise<{ fichier: string; licence: string | null }[] | null> {
  const r = await fetch(`/api/assets/${encodeURIComponent(assetId)}/workflow`)
  if (!r.ok) return null
  const d = await r.json()
  const url = URL.createObjectURL(new Blob([JSON.stringify(d.workflow, null, 1)], { type: 'application/json' }))
  const lien = document.createElement('a'); lien.href = url; lien.download = `${assetId}-workflow-api.json`; lien.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return d.modeles ?? []
}
