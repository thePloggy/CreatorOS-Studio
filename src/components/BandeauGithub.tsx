/* Bandeau de la démo publique : invite à mettre une étoile au dépôt GitHub. Fermable ; le choix
   reste dans ce navigateur. */
import { useEffect, useState } from 'react'
import { t } from '../i18n'

const DEPOT = 'https://github.com/thePloggy/CreatorOS-Studio'
const CLE = 'bandeau-github-ferme'

export function BandeauGithub() {
  const [visible, setVisible] = useState(false)
  const [etoiles, setEtoiles] = useState<number | null>(null)
  useEffect(() => {
    let ferme = false
    try { ferme = localStorage.getItem(CLE) === '1' } catch { /* stockage indisponible */ }
    if (ferme) return
    void fetch('/api/comfy/maj').then(r => r.json()).then((d: { demo?: boolean }) => setVisible(!!d.demo)).catch(() => {})
    void fetch('https://api.github.com/repos/thePloggy/CreatorOS-Studio').then(r => (r.ok ? r.json() : null)).then((d: { stargazers_count?: number } | null) => { if (typeof d?.stargazers_count === 'number') setEtoiles(d.stargazers_count) }).catch(() => {})
  }, [])
  if (!visible) return null
  const fermer = () => { setVisible(false); try { localStorage.setItem(CLE, '1') } catch { /* stockage indisponible */ } }
  return (
    <div role="region" aria-label={t('Soutenir le projet')} style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap',
      padding: '7px 44px 7px 16px', position: 'relative', fontSize: 13, color: '#e8e7e3',
      background: 'linear-gradient(90deg, rgba(255,171,94,.16), rgba(242,77,138,.16) 50%, rgba(180,75,216,.16))', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
      <span>{t('CreatorOS Studio est open source et tourne sur ComfyUI. Une étoile sur GitHub nous aide beaucoup pour le concours Comfy.')}</span>
      <a href={DEPOT} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999,
        background: 'linear-gradient(135deg, #ffab5e 0%, #ff655b 38%, #f24d8a 68%, #b44bd8 100%)', color: '#fff', fontWeight: 700, textDecoration: 'none', minHeight: 28 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" /></svg>
        {t('Mettre une étoile sur GitHub')}{etoiles !== null && <span style={{ opacity: .85, fontWeight: 600 }}>· {etoiles}</span>}
      </a>
      <button onClick={fermer} aria-label={t('Fermer')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: 8,
        border: 0, background: 'transparent', color: '#9a9ca3', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
  )
}
