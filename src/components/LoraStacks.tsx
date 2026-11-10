/* Named LoRA stacks, shared by the photo and video pickers.
   A stack = the chosen LoRAs with their strengths, saved under a name for
   an engine family (`cle`). A click reloads it. Stored in the browser
   (display preferences), not on the server. */
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { LoraPick } from '../types'
import { t } from '../i18n'

/** Engines that share the same LoRAs share their stacks. */
export const loraFamily = (engine: string) => engine.startsWith('minimax') ? 'h3' : engine.startsWith('ltx') ? 'ltx' : engine

export function LoraStacks({ cle, picks, apply }: { cle: string; picks: LoraPick[]; apply: (items: LoraPick[]) => void }) {
  const piles = useAppStore(s => s.loraStacks[cle]) ?? []
  const save = useAppStore(s => s.saveLoraStack)
  const del = useAppStore(s => s.deleteLoraStack)
  const [nom, setNom] = useState<string | null>(null)
  const memes = (a: LoraPick[], b: LoraPick[]) => a.length === b.length && a.every(x => b.some(y => y.name === x.name && y.strength === x.strength))
  return (
    <div className="flex gap-1.5 items-center flex-wrap" style={{ marginTop: 8 }}>
      <small style={{ color: 'var(--faint)', fontSize: 12 }}>{t('piles')}</small>
      {piles.map(p => (
        <span key={p.name} className="pill" style={{ fontSize: 12, padding: '3px 4px 3px 9px', display: 'inline-flex', gap: 5, alignItems: 'center',
          boxShadow: memes(p.items, picks) ? 'inset 0 0 0 1px rgba(242,77,138,.55)' : undefined }}>
          <span style={{ cursor: 'pointer' }} title={p.items.map(l => `${l.name.split('/').pop()?.replace(/\.safetensors$/, '')} ${l.strength}`).join(' · ')}
            onClick={() => apply(p.items.map(l => ({ ...l })))}>{p.name} <small style={{ opacity: .6 }}>{p.items.length}</small></span>
          <button title={t('oublier cette pile')} onClick={() => del(cle, p.name)}
            style={{ border: 0, background: 'none', color: 'var(--faint)', cursor: 'pointer', padding: '0 4px', fontSize: 12 }}>✕</button>
        </span>
      ))}
      {nom === null
        ? <button className="pill" style={{ fontSize: 12, padding: '3px 9px' }} disabled={!picks.length}
            title={picks.length ? t('enregistrer les LoRA choisies comme une pile') : t('choisis au moins une LoRA')} onClick={() => setNom('')}>{t('＋ enregistrer')}</button>
        : <form style={{ display: 'inline-flex', gap: 5 }} onSubmit={e => { e.preventDefault(); if (nom.trim()) { save(cle, nom.trim(), picks); setNom(null) } }}>
            <input autoFocus className="seedin" style={{ width: 130, fontFamily: 'inherit', fontSize: 12 }} placeholder={t('nom de la pile')} value={nom}
              onChange={e => setNom(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setNom(null) }} />
            <button className="pill" style={{ fontSize: 12, padding: '3px 9px' }} type="submit">ok</button>
          </form>}
      {picks.length > 0 && <button className="pill" style={{ fontSize: 12, padding: '3px 9px', marginLeft: 'auto' }} onClick={() => apply([])}>{t('vider')}</button>}
    </div>
  )
}

/** Toggle for a chosen LoRA: when off, it stays in the stack but is not sent to the render. */
export function LoraSwitch({ off, onToggle }: { off?: boolean; onToggle: () => void }) {
  return <button onClick={e => { e.stopPropagation(); onToggle() }} title={off ? t('coupée : ne part pas au rendu') : t('active — cliquer pour couper sans retirer')}
    style={{ border: 0, borderRadius: 99, width: 30, height: 16, padding: 2, cursor: 'pointer', background: off ? 'rgba(255,255,255,.14)' : 'var(--accent)', flex: 'none' }}>
    <i style={{ display: 'block', width: 12, height: 12, borderRadius: 99, background: '#fff', marginLeft: off ? 0 : 14, transition: 'margin .12s' }} />
  </button>
}
