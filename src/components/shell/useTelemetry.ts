/* Télémétrie de la machine — GPU, CPU, RAM — sondée toutes les 5 s. Partagée
   entre l'en-tête desktop et l'onglet Jobs mobile : une seule source, mêmes
   seuils d'alerte. */
import { useEffect, useState } from 'react'
import { t as tr } from '../../i18n'

export type Telemetry = {
  gpu: { util: number; temp: number; vramUsedMb: number; vramTotalMb: number; nom?: string } | null
  cpu: { util: number | null; temp: number | null }
  ram: { usedMb: number; totalMb: number } | null
}

export function useTelemetry(everyMs = 5000) {
  const [t, setT] = useState<Telemetry | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch('/api/telemetry', { signal: AbortSignal.timeout(4000) })
        if (alive && r.ok) setT(await r.json())
      } catch { /* la dernière valeur reste affichée */ }
    }
    void tick()
    const iv = setInterval(tick, everyMs)
    return () => { alive = false; clearInterval(iv) }
  }, [everyMs])
  return t
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** Chaînes prêtes à afficher — null tant que rien n'est reçu. */
export function telemetryText(t: Telemetry | null) {
  if (!t?.gpu) return null
  return {
    gpu: `GPU ${t.gpu.util} % · ${t.gpu.temp}° · ${gb(t.gpu.vramUsedMb)}/${Math.round(t.gpu.vramTotalMb / 1024)} ${tr('Go')}`,
    cpu: `CPU ${t.cpu.util ?? '—'} % · ${t.cpu.temp ?? '—'}°`,
    ram: t.ram ? `RAM ${Math.round(t.ram.usedMb / 1024)}/${Math.round(t.ram.totalMb / 1024)} ${tr('Go')}` : 'RAM —',
    hot: t.gpu.temp >= 80 || (t.cpu.temp ?? 0) >= 85
      || (t.ram ? t.ram.usedMb / t.ram.totalMb > 0.92 : false),
  }
}
