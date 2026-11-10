/* "N deleted · undo" notice, shared by desktop and mobile.
   Deletion moves items to the server-side trash (30 days); this notice
   offers an immediate undo for 10 seconds. */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { t, tc, tp } from '../i18n'

const DUREE = 10_000

export function UndoDelete({ bottom = 24 }: { bottom?: number }) {
  const d = useAppStore(s => s.lastDeleted)
  const undo = useAppStore(s => s.undoDelete)
  const dismiss = useAppStore(s => s.dismissDeleted)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!d) return
    const t = window.setTimeout(dismiss, Math.max(500, d.at + DUREE - Date.now()))
    return () => window.clearTimeout(t)
  }, [d, dismiss])
  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 6000)
    return () => window.clearTimeout(t)
  }, [msg])
  if (!d && !msg) return null
  const n = d?.ids.length ?? 0
  return (
    <div role="status" style={{ position: 'fixed', left: '50%', bottom, transform: 'translateX(-50%)', zIndex: 300,
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px 10px 16px', borderRadius: 14,
      background: 'rgba(28, 29, 34, 0.96)', border: '1px solid rgba(255,255,255,0.12)', color: '#f2f2f4',
      boxShadow: '0 12px 40px rgba(0,0,0,0.55)', fontSize: 13, whiteSpace: 'nowrap' }}>
      {msg ?? <>{tp(n, '{n} élément supprimé', '{n} éléments supprimés')} <span style={{ opacity: .55 }}>{t('· en corbeille 30 jours')}</span></>}
      {d && !msg && (
        <button disabled={busy}
          onClick={async () => { setBusy(true); const e = await undo(); setBusy(false); if (e) setMsg(e) }}
          style={{ border: 0, borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            color: '#fff', background: 'linear-gradient(90deg, #f6a961, #ea4e89)' }}>
          {busy ? '…' : tc('undo', 'Annuler')}
        </button>
      )}
    </div>
  )
}
