/* ============================================================
   Orbe de voix : réagit au volume du micro pendant l'enregistrement
   (API Web Audio, valeur RMS lue à chaque image), avec un vu-mètre en
   barres. Mouvement réduit : l'orbe ne pulse plus, le vu-mètre reste.
   ============================================================ */
import { useEffect, useRef } from 'react'
import { t } from '../i18n'

export function VoixOrbe({ flux, etat }: { flux: MediaStream | null; etat: 'ecoute' | 'envoi' }) {
  const orbe = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!flux) return
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(flux)
    const an = ctx.createAnalyser(); an.fftSize = 512
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    let raf = 0, lisse = 0
    const boucle = () => {
      an.getFloatTimeDomainData(buf)
      let s = 0; for (const v of buf) s += v * v
      const rms = Math.sqrt(s / buf.length)
      lisse = lisse * 0.8 + Math.min(1, rms * 6) * 0.2
      orbe.current?.style.setProperty('--niveau', lisse.toFixed(3))
      raf = requestAnimationFrame(boucle)
    }
    boucle()
    return () => { cancelAnimationFrame(raf); src.disconnect(); void ctx.close() }
  }, [flux])
  return (
    <div ref={orbe} className={`voix-orbe ${etat}`} role="status" aria-label={etat === 'ecoute' ? t('Écoute du micro') : t('Envoi de la voix')}>
      <span className="voix-orbe-coeur" />
      <span className="voix-metre" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i } as React.CSSProperties} />)}</span>
    </div>
  )
}
