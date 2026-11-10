/* Persona profile picture: <img> if a photo was uploaded, otherwise a
   neutral circle. Single source (the store), used by the bar, the persona
   card, the Perso view and mobile. */
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { vignetteOf } from './AssetMedia'
import { cn } from '../lib/cn'
import { useEdition } from '../lib/proprietaire'
import { t, tServeur } from '../i18n'

export function Avatar({ size = 36, className }: { size?: number; className?: string }) {
  const url = useAppStore(s => s.personaAvatar)
  const style = { width: size, height: size }
  return url ? (
    <img src={url} alt="" style={style} draggable={false}
      className={cn('rounded-full border border-border2 object-cover shrink-0', className)} />
  ) : (
    <span style={style} className={cn('rounded-full border border-border2 bg-gradient-to-br from-[#3a4a5c] to-[#232d38] shrink-0', className)} />
  )
}

/** "change photo": a dialog with the active character's photos
 *  (the library holds no others); a click sets it as profile picture,
 *  cropped square on the server. */
export function AvatarUpload({ className }: { className?: string }) {
  const edition = useEdition()
  const [ouvert, setOuvert] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const photos = useAppStore(s => s.assets).filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
  const refresh = useAppStore(s => s.refreshPersona)

  async function choisir(id: string) {
    setMsg(t('recadrage…'))
    const r = await fetch('/api/persona/avatar/depuis-asset', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: id }) })
    const d = await r.json().catch(() => ({})) as { url?: string | null; error?: string }
    if (!r.ok) { setMsg(t('refusé : {e}', { e: tServeur(d.error) ?? r.status })); return }
    useAppStore.setState({ personaAvatar: d.url ?? null })
    await refresh()
    setMsg(null); setOuvert(false)
  }

  if (!edition) return null
  return (
    <>
      <button type="button" className={cn('text-[12px] text-accent cursor-pointer hover:underline', className)}
        onClick={() => { setMsg(null); setOuvert(true) }}>{t('changer la photo')}</button>
      {ouvert && (
        <div role="dialog" aria-modal="true" aria-label={t('Choisir la photo de profil')} onClick={() => setOuvert(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(720px, 100%)', maxHeight: '85vh', overflow: 'auto', borderRadius: 14, padding: 16,
              background: 'var(--surface2, #1b1d22)', color: 'inherit', border: '1px solid rgba(127,127,127,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <b style={{ fontSize: 14 }}>{t('Photo de profil — choisis une image du personnage')}</b>
              <button type="button" aria-label={t('fermer')} onClick={() => setOuvert(false)} style={{ marginLeft: 'auto', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            {photos.length === 0
              ? <div style={{ fontSize: 13, opacity: 0.6 }}>{t('Aucune photo de ce personnage pour l’instant : génère d’abord une image.')}</div>
              : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                  {photos.slice(0, 200).map(a => (
                    <button key={a.id} type="button" onClick={() => void choisir(a.id)} title={t('Prendre cette image')}
                      style={{ padding: 0, border: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', aspectRatio: '1', background: 'rgba(127,127,127,0.1)' }}>
                      <img src={vignetteOf(a)} alt="" loading="lazy" draggable={false}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
                    </button>
                  ))}
                </div>}
            {msg && <div style={{ fontSize: 12, marginTop: 10, opacity: 0.8 }}>{msg}</div>}
          </div>
        </div>
      )}
    </>
  )
}
