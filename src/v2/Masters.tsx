/* Masters: HLG, ProRes, EXR ACEScg, and ProRes 4444 for a clip with a transparent background.
   Built on the CPU; the download link appears when the file is ready. */
import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'

const FORMATS = [
  { id: 'hlg-hevc', label: 'HLG HEVC', titre: 'H.265 10 bits, Rec.2020 HLG' },
  { id: 'hlg-prores', label: 'HLG ProRes', titre: 'ProRes 422 HQ, Rec.2020 HLG' },
  { id: 'exr', label: 'EXR ACEScg', titre: 'une image EXR linéaire par frame, dans un zip' },
  { id: 'hlg-etendu', label: 'HLG expanded', titre: 'HEVC 10 bits HLG, hautes lumières étendues au-delà du blanc (expansion SDR → HDR)' },
  { id: 'exr-etendu', label: 'EXR expanded', titre: 'EXR ACEScg linéaire, hautes lumières étendues jusqu’à ~5× le blanc, dans un zip' },
]
const ALPHA = { id: 'prores-alpha', label: 'ProRes 4444', titre: 'ProRes 4444 avec alpha, pour le montage' }

export function Masters({ asset }: { asset: Asset }) {
  const formats = /\.webm$/i.test(asset.uri ?? '') ? [ALPHA] : FORMATS
  const [etats, setEtats] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const url = (f: string) => `/api/assets/${encodeURIComponent(asset.id)}/master/${f}`
  const minuteries = useRef<number[]>([])
  useEffect(() => () => minuteries.current.forEach(clearInterval), [])
  const suivre = (f: string) => {
    const id = window.setInterval(() => {
      void fetch(url(f)).then(r => r.json()).then((d: { etat?: string; erreur?: string }) => {
        if (d.etat === 'en_cours') return
        clearInterval(id); setEtats(e => ({ ...e, [f]: d.etat ?? 'echec' }))
        if (d.etat === 'echec') setMsg(d.erreur ?? t('échec'))
      })
    }, 2500)
    minuteries.current.push(id)
  }
  const lancer = async (f: string) => {
    setMsg('')
    const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/master`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: f }) })
    const d = await r.json().catch(() => ({})) as { etat?: string; error?: string }
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setEtats(e => ({ ...e, [f]: d.etat ?? 'en_cours' }))
    if (d.etat === 'en_cours') suivre(f)
  }
  return (
    <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
      {t('Master')}
      {formats.map(f => etats[f.id] === 'pret'
        ? <a key={f.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} href={`${url(f.id)}?dl=1`} download>⬇ {f.label}</a>
        : <button key={f.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t(f.titre)} disabled={etats[f.id] === 'en_cours'} onClick={() => void lancer(f.id)}>
            {etats[f.id] === 'en_cours' ? `${f.label}…` : f.label}</button>)}
      {msg && <span style={{ color: 'var(--danger)' }}>{msg}</span>}
    </div>
  )
}
