/* FR / EN UI language toggle (top bar, desktop and mobile). */
import { setLang, t, useLang } from '../i18n'

export function LangSwitch({ style }: { style?: React.CSSProperties }) {
  const lang = useLang()
  const bouton = (l: 'fr' | 'en', libelle: string) => (
    <button type="button" onClick={() => setLang(l)} aria-pressed={lang === l}
      style={{ padding: '3px 7px', borderRadius: 6, border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12,
        fontWeight: lang === l ? 700 : 400, color: 'inherit', opacity: lang === l ? 1 : 0.55,
        background: lang === l ? 'rgba(127,127,127,0.22)' : 'transparent' }}>{libelle}</button>
  )
  return (
    <span role="group" aria-label={t('Langue de l’interface')}
      style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: 'rgba(127,127,127,0.10)', ...style }}>
      {bouton('fr', 'FR')}{bouton('en', 'EN')}
    </span>
  )
}
