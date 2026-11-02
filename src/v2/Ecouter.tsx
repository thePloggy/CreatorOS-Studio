import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

/** Lecture rapide d'un son (échantillon de voix, musique) : un clic lit, un second arrête. Un seul son à la fois. */
let courant: HTMLAudioElement | null = null

export function Ecouter({ src, titre }: { src: string | null; titre?: string }) {
  const [etat, setEtat] = useState<'arret' | 'charge' | 'lecture'>('arret')
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => { audio.current?.pause() }, [])
  useEffect(() => { audio.current?.pause(); audio.current = null; setEtat('arret') }, [src])
  if (!src) return null
  const basculer = () => {
    if (etat !== 'arret' && audio.current) { audio.current.pause(); audio.current = null; setEtat('arret'); return }
    courant?.pause()
    const a = new Audio(src); audio.current = a; courant = a; setEtat('charge')
    a.onplaying = () => setEtat('lecture')
    a.onended = a.onpause = a.onerror = () => { if (audio.current === a) { audio.current = null; setEtat('arret') } }
    void a.play().catch(() => setEtat('arret'))
  }
  const label = etat === 'arret' ? (titre ?? t('Écouter')) : t('Arrêter')
  return (
    <button type="button" className="wtab" onClick={basculer} aria-label={label} title={label}
      style={{ padding: '4px 9px', minWidth: 30 }}>
      {etat === 'charge' ? '…' : etat === 'lecture' ? '■' : '▶'}
    </button>
  )
}

export const urlEchantillonVoix = (id: string) => id ? `/api/voix/${encodeURIComponent(id)}/echantillon` : null
export const urlMusique = (nom: string) => nom ? `/api/montage/musiques/${encodeURIComponent(nom)}` : null
