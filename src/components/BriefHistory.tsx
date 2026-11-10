/* Recent and starred briefs, shared by the Image and Video views.
   ↑ in an EMPTY brief field opens the list; search, star, reuse with a
   click or ↑ ↓ Enter. The list comes from jobs already submitted
   (/api/briefs). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, getLang } from '../i18n'

interface Brief { texte: string; mode: string | null; register: string | null; at: number; n: number; star: boolean }

const quand = (ts: number) => {
  const j = Math.floor((Date.now() - ts) / 86400_000)
  return j <= 0 ? t("aujourd'hui") : j === 1 ? t('hier') : j < 30 ? t('il y a {j} j', { j }) : new Date(ts).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'fr-FR', { day: 'numeric', month: 'short' })
}

export function useBriefHistory(mode: 'photo' | 'video', value: string, onPick: (t: string) => void) {
  const [open, setOpen] = useState(false)
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' && !value.trim() && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setOpen(true) }
  }, [value])
  const panel = open ? <Panel mode={mode} onClose={() => setOpen(false)} onPick={t => { onPick(t); setOpen(false) }} /> : null
  return { onKeyDown, panel, open: () => setOpen(true) }
}

function Panel({ mode, onClose, onPick }: { mode: 'photo' | 'video'; onClose: () => void; onPick: (t: string) => void }) {
  const [briefs, setBriefs] = useState<Brief[] | null>(null)
  const [q, setQ] = useState('')
  const [tous, setTous] = useState(false)
  const [sel, setSel] = useState(0)
  const liste = useRef<HTMLDivElement>(null)
  useEffect(() => {
    fetch('/api/briefs').then(r => r.json()).then(d => setBriefs(d.briefs ?? [])).catch(() => setBriefs([]))
  }, [])
  const vus = useMemo(() => {
    const mots = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const l = (briefs ?? []).filter(b => (tous || !b.mode || b.mode === mode) && mots.every(m => b.texte.toLowerCase().includes(m)))
    return [...l.filter(b => b.star), ...l.filter(b => !b.star)].slice(0, 80)
  }, [briefs, q, tous, mode])
  useEffect(() => { setSel(0) }, [q, tous])
  useEffect(() => { liste.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const etoile = async (b: Brief) => {
    setBriefs(l => (l ?? []).map(x => x.texte === b.texte ? { ...x, star: !b.star } : x))
    await fetch('/api/briefs/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte: b.texte, mode: b.mode ?? mode, on: !b.star }) }).catch(() => {})
  }
  const touche = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(vus.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter' && vus[sel]) { e.preventDefault(); onPick(vus[sel].texte) }
  }
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 250, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0 16px 190px' }}>
      <div onMouseDown={e => e.stopPropagation()} onKeyDown={touche}
        style={{ width: 'min(760px, 100%)', maxHeight: '58vh', display: 'flex', flexDirection: 'column', borderRadius: 16, overflow: 'hidden',
          background: 'rgba(24, 25, 30, 0.98)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 24px 70px rgba(0,0,0,0.6)', color: '#ececf0' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('Chercher dans les briefs déjà envoyés…')}
            style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', color: 'inherit', fontSize: 14 }} />
          <button onClick={() => setTous(t => !t)} title={t("inclure les briefs de l'autre mode")}
            style={{ border: 0, borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, color: tous ? '#fff' : '#9a9ba3', background: tous ? 'rgba(234,78,137,0.35)' : 'rgba(255,255,255,0.07)' }}>
            {mode === 'photo' ? t('photo') : t('vidéo')}{tous ? t(' + autre mode') : t(' seulement')}
          </button>
        </div>
        <div ref={liste} style={{ overflowY: 'auto', padding: 6 }}>
          {briefs === null && <div style={{ padding: 16, fontSize: 12.5, color: '#9a9ba3' }}>{t('chargement…')}</div>}
          {briefs !== null && vus.length === 0 && <div style={{ padding: 16, fontSize: 12.5, color: '#9a9ba3' }}>{t('Aucun brief ne correspond.')}</div>}
          {vus.map((b, i) => (
            <div key={b.texte} data-sel={i === sel ? '1' : undefined} onMouseEnter={() => setSel(i)} onClick={() => onPick(b.texte)}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px', borderRadius: 10, cursor: 'pointer', background: i === sel ? 'rgba(255,255,255,0.07)' : 'transparent' }}>
              <button onClick={e => { e.stopPropagation(); void etoile(b) }} title={b.star ? t("retirer l'étoile") : t('étoiler ce brief')}
                style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 15, lineHeight: 1.2, padding: 0, color: b.star ? '#f6a961' : '#5d5e66' }}>{b.star ? '★' : '☆'}</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{b.texte}</div>
                <div style={{ fontSize: 12, color: '#84858d', marginTop: 3 }}>
                  {quand(b.at)}{b.n > 1 ? t(' · envoyé {n} fois', { n: b.n }) : ''}{b.mode ? ` · ${b.mode === 'video' ? t('vidéo') : t('photo')}` : ''}{b.register ? ` · ${b.register}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: '7px 14px', fontSize: 12, color: '#74757d', borderTop: '1px solid rgba(255,255,255,0.08)' }}>{t('↑ ↓ choisir · Entrée reprendre · Échap fermer · ☆ garder en tête de liste')}</div>
      </div>
    </div>
  )
}
