/* Corbeille — ce qui a été supprimé depuis moins de 30 jours, à restaurer d'un clic.
   La suppression déplace le fichier côté serveur (media/.corbeille) ; ici on liste,
   on regarde, on restaure. Passé 30 jours le serveur efface pour de bon. */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import { fetchAssets } from '../worker/apiWorker'
import { t, tp, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'

interface Item { id: string; deletedAt: number; filename: string | null }

export function CorbeilleButton({ className = 'spill purge' }: { className?: string }) {
  const [n, setN] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  // le compteur suit les suppressions et les annulations faites ailleurs dans l'app
  const marque = useAppStore(s => `${s.assets.length}-${s.lastDeleted?.at ?? 0}`)
  const edition = useEdition()
  useEffect(() => {
    if (!edition) return
    fetch('/api/corbeille').then(r => r.json()).then(d => setN(d.count ?? 0)).catch(() => setN(null))
  }, [marque, open, edition])
  if (!edition || (n === null && !open)) return null
  return (<>
    <button className={className} onClick={() => setOpen(true)} title={t('éléments supprimés, récupérables pendant 30 jours')}>{t('♻ corbeille ({n})', { n: n ?? 0 })}</button>
    {open && createPortal(<Panneau onClose={() => setOpen(false)} />, document.body)}
  </>)
}

/** Vignette réservée au propriétaire : une balise img n'envoie pas la clé, on passe par fetch. */
function Vignette({ filename }: { filename: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null, annule = false
    fetch(`/api/corbeille/vue/${encodeURIComponent(filename)}`).then(r => r.ok ? r.blob() : null).then(b => {
      if (!b || annule) return
      url = URL.createObjectURL(b); setSrc(url)
    }).catch(() => {})
    return () => { annule = true; if (url) URL.revokeObjectURL(url) }
  }, [filename])
  return src ? <img alt="" src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : null
}

function Panneau({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [jours, setJours] = useState(30)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const edition = useEdition()
  // « Vider » en deux clics : le premier arme, le second efface pour de bon
  const [arme, setArme] = useState(false)
  const charger = useCallback(() => {
    fetch('/api/corbeille').then(r => r.json())
      .then(d => { setItems([...(d.items ?? [])].sort((a: Item, b: Item) => b.deletedAt - a.deletedAt)); setJours(d.days ?? 30) })
      .catch(() => setItems([]))
  }, [])
  useEffect(charger, [charger])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const restaurer = async (ids: string[]) => {
    setBusy(ids.length === 1 ? ids[0] : 'tous'); setMsg(null)
    try {
      const r = await fetch('/api/assets/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      const b = await r.json() as { restored?: string[]; failed?: { id: string; error: string }[] }
      if (b.failed?.length) setMsg(t('{n} non restauré(s) : {e}', { n: b.failed.length, e: tServeur(b.failed[0].error) }))
      useAppStore.setState({ assets: await fetchAssets() })
    } catch (e) { setMsg(t('restauration impossible : {e}', { e: String((e as Error).message ?? e) })) }
    setBusy(null); charger()
  }
  const vider = async () => {
    if (!arme) { setArme(true); return }
    setArme(false); setBusy('vider'); setMsg(null)
    try {
      const r = await fetch('/api/corbeille/vider', { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    } catch (e) { setMsg(t('vidage impossible : {e}', { e: String((e as Error).message ?? e) })) }
    setBusy(null); charger()
  }
  const reste = (t: number) => Math.max(0, Math.ceil(jours - (Date.now() - t) / 86400_000))
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 'min(980px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
        background: '#17181c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 18, color: '#f2f2f4', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <b style={{ fontSize: 14 }}>{t('Corbeille')}</b>
          <span style={{ fontSize: 12, opacity: .55 }}>{items ? tp(items.length, '{n} élément', '{n} éléments') : '…'}{t(' · effacés pour de bon après {n} jours', { n: jours })}</span>
          {msg && <span style={{ fontSize: 12, color: '#f08a7e' }}>{msg}</span>}
          <span style={{ flex: 1 }} />
          {!!items?.length && (
            <button disabled={!!busy} onClick={() => void restaurer(items.map(i => i.id))}
              style={{ border: 0, borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12, color: '#f2f2f4', background: 'rgba(255,255,255,0.1)' }}>
              {busy === 'tous' ? '…' : t('tout restaurer')}
            </button>
          )}
          {!!items?.length && edition && (
            <button disabled={!!busy} onClick={() => void vider()} onMouseLeave={() => setArme(false)}
              title={t('efface définitivement tous les éléments de la corbeille')}
              style={{ border: 0, borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12, color: '#fff',
                background: arme ? '#c43d3d' : 'rgba(196,61,61,0.35)' }}>
              {busy === 'vider' ? '…' : arme ? t('re-cliquer : effacer pour de bon') : t('vider la corbeille')}
            </button>
          )}
          <button onClick={onClose} aria-label={t('fermer')} style={{ border: 0, background: 'none', color: '#f2f2f4', fontSize: 18, cursor: 'pointer', opacity: .6 }}>×</button>
        </div>
        {/* Hauteurs forcées : dans ce conteneur flex limité à 86vh, la grille se faisait
            écraser et les vignettes (aspect-ratio seul) devenaient de fines lamelles. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
          gridAutoRows: 'max-content', alignContent: 'start', gap: 10 }}>
          {items?.length === 0 && <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', opacity: .5, fontSize: 13 }}>{t('La corbeille est vide.')}</div>}
          {items?.map(i => (
            <div key={i.id} style={{ borderRadius: 12, overflow: 'hidden', background: '#0f1013', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              <div style={{ height: 230, flexShrink: 0, background: '#0b0c0e', position: 'relative' }}>
                {i.filename && <Vignette filename={i.filename} />}
                {i.filename?.endsWith('.mp4') && <span style={{ position: 'absolute', left: 6, top: 6, fontSize: 9, padding: '2px 6px', borderRadius: 6, background: 'rgba(0,0,0,0.7)' }}>{t('VIDÉO')}</span>}
              </div>
              <div style={{ padding: '7px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10.5, opacity: .55, flex: 1 }}>{t('encore {n} j', { n: reste(i.deletedAt) })}</span>
                <button disabled={!!busy} onClick={() => void restaurer([i.id])}
                  style={{ border: 0, borderRadius: 8, padding: '5px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#fff', background: 'linear-gradient(90deg, #f6a961, #ea4e89)' }}>
                  {busy === i.id ? '…' : t('restaurer')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
