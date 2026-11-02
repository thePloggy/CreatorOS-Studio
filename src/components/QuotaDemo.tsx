/* Images restantes pour l'heure sur la démo publique, dans l'en-tête à
   côté du voyant machine. Rien pour le propriétaire ni le tailnet (sans limite). */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'

type Quota = { illimite: boolean; limite: number; restants?: number; libreDansMs?: number; bloque?: boolean }

export function QuotaDemo({ style }: { style?: React.CSSProperties }) {
  const [q, setQ] = useState<Quota | null>(null)
  const nJobs = useAppStore(s => s.jobs.length)
  useEffect(() => {
    let vivant = true
    const lire = () => fetch('/api/quota').then(r => (r.ok ? r.json() : null)).then(d => { if (vivant && d) setQ(d) }).catch(() => {})
    void lire()
    const iv = setInterval(lire, 20_000)
    return () => { vivant = false; clearInterval(iv) }
  }, [nJobs])   // relu à chaque rendu lancé
  if (!q || q.illimite) return null
  const restants = q.restants ?? 0
  const minutes = Math.max(1, Math.ceil((q.libreDansMs ?? 0) / 60_000))
  const texte = q.bloque ? t('rendus bloqués')
    : restants > 0 ? t('{n}/{max} images', { n: restants, max: q.limite })
    : t('limite atteinte · {m} min', { m: minutes })
  const couleur = q.bloque || restants === 0 ? 'var(--danger, #ff6b6b)' : restants <= 3 ? 'var(--warn, #ffb648)' : 'inherit'
  return (
    <span title={t('Démo publique : {max} images ou clips par heure et par visiteur. Un ×4 compte 4, un reel environ 10.', { max: q.limite })}
      style={{ color: couleur, whiteSpace: 'nowrap', ...style }}>
      {texte}
    </span>
  )
}
