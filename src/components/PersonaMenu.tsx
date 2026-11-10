/* ============================================================
   Top-bar character picker: clicking the name lists all characters;
   clicking one makes it active (the library reloads with its renders).
   "Edit characters" opens the Character page. Shared desktop and mobile.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { PersonaResume } from './PersonaListe'
import { t } from '../i18n'

const rond = (url: string | null, size: number) => url
  ? <img src={url} alt="" draggable={false} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} />
  : <span style={{ width: size, height: size, borderRadius: '50%', flex: 'none', background: 'linear-gradient(135deg,#3a4a5c,#232d38)' }} />

export function PersonaMenu({ onEdit, className, style, alignDroite = false }: {
  onEdit: () => void; className?: string; style?: React.CSSProperties
  /** menu aligned to the button's right edge (button on the right of the screen) */
  alignDroite?: boolean
}) {
  const nom = useAppStore(s => s.personaName)
  const photo = useAppStore(s => s.personaAvatar)
  const choisi = useAppStore(s => s.personaId)
  const [ouvert, setOuvert] = useState(false)
  const [liste, setListe] = useState<PersonaResume[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const boite = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ouvert) return
    setMsg(null)
    void fetch('/api/personas').then(r => r.json())
      .then((d: { personas: PersonaResume[] }) => setListe(d.personas)).catch(() => setMsg(t('liste indisponible')))
    const dehors = (e: PointerEvent) => { if (!boite.current?.contains(e.target as Node)) setOuvert(false) }
    const echap = (e: KeyboardEvent) => { if (e.key === 'Escape') setOuvert(false) }
    window.addEventListener('pointerdown', dehors)
    window.addEventListener('keydown', echap)
    return () => { window.removeEventListener('pointerdown', dehors); window.removeEventListener('keydown', echap) }
  }, [ouvert])

  async function activer(p: PersonaResume) {
    if (p.id === useAppStore.getState().personaId) { setOuvert(false); return }
    await useAppStore.getState().choisirPersonnage(p.id)
    setOuvert(false)
  }

  return (
    <div ref={boite} style={{ position: 'relative' }}>
      <button type="button" className={className} style={style} aria-haspopup="menu" aria-expanded={ouvert}
        title={t('personnage {nom} — changer', { nom })} onClick={() => setOuvert(o => !o)}>
        {rond(photo, 20)}
        {nom}
        <span aria-hidden style={{ fontSize: 12, opacity: 0.6, marginLeft: 2 }}>▾</span>
      </button>
      {ouvert && (
        <div data-popup role="menu" style={{
          position: 'absolute', top: 'calc(100% + 6px)', ...(alignDroite ? { right: 0 } : { left: 0 }), maxWidth: 'calc(100vw - 32px)', zIndex: 1000, minWidth: 220, padding: 6,
          borderRadius: 12, background: '#16181c', color: '#e8e8ea', border: '1px solid rgba(127,127,127,0.3)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        }}>
          {!liste && <div style={{ padding: 8, fontSize: 12, opacity: 0.6 }}>{msg ?? t('chargement…')}</div>}
          {liste?.map(p => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === choisi} onClick={() => void activer(p)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 8px', borderRadius: 8,
                border: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit', fontSize: 13,
                background: p.id === choisi ? 'rgba(234,78,137,0.16)' : 'transparent',
              }}>
              {rond(p.avatar, 28)}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || t('sans nom')}</span>
              {p.id === choisi && <span aria-hidden style={{ fontSize: 12, opacity: 0.8 }}>✓</span>}
            </button>
          ))}
          {liste && msg && <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.7 }}>{msg}</div>}
          <div style={{ height: 1, background: 'rgba(127,127,127,0.25)', margin: '6px 2px' }} />
          <button type="button" role="menuitem" onClick={() => { setOuvert(false); onEdit() }}
            style={{ width: '100%', padding: '8px', borderRadius: 8, border: 0, cursor: 'pointer', textAlign: 'left',
              color: 'inherit', font: 'inherit', fontSize: 12.5, background: 'rgba(127,127,127,0.12)' }}>
            {t('Modifier les personnages…')}
          </button>
        </div>
      )}
    </div>
  )
}
