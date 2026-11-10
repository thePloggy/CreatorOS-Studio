/* ============================================================
   Active character's wardrobe: favourite outfits and places (★ star on
   vocabulary items) and free lines. Shown at the top of Elements: a click
   inserts the line into the prompt, like a regular element, which keeps
   an outfit identical across posts. Saved with the character (persona.json).
   ============================================================ */
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { allEnvironments, allOutfits } from '../store/useVocabStore'
import type { Garderobe } from '../types'
import { t } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { Verrouille } from '../features/config/CleProprietaire'

export type GKind = 'tenues' | 'lieux'
export interface GLigne { cle: string; kind: GKind | 'perso'; label: string; prompt: string; index?: number }

export function useGarderobe() {
  const g = useAppStore(s => s.personaGarderobe)
  const save = useAppStore(s => s.setGarderobe)
  const [err, setErr] = useState<string | null>(null)
  const maj = async (n: Garderobe) => { setErr(await save(n)) }
  const has = (kind: GKind, id: string) => g[kind].includes(id)
  const toggle = (kind: GKind, id: string) =>
    void maj({ ...g, [kind]: has(kind, id) ? g[kind].filter(x => x !== id) : [...g[kind], id] })
  const ajouter = (label: string, prompt: string) =>
    void maj({ ...g, perso: [...g.perso, { label: label.trim(), prompt: prompt.trim() }] })
  const retirer = (l: GLigne) => {
    if (l.kind === 'perso') void maj({ ...g, perso: g.perso.filter((_, i) => i !== l.index) })
    else toggle(l.kind, l.cle)
  }
  const tenues = allOutfits(), lieux = allEnvironments()
  const lignes: GLigne[] = [
    ...g.tenues.map(id => tenues.find(x => x.id === id)).filter(Boolean)
      .map(x => ({ cle: x!.id, kind: 'tenues' as const, label: x!.labelFr ?? x!.label, prompt: x!.prompt ?? '' })),
    ...g.lieux.map(id => lieux.find(x => x.id === id)).filter(Boolean)
      .map(x => ({ cle: x!.id, kind: 'lieux' as const, label: x!.labelFr ?? x!.label, prompt: x!.prompt ?? '' })),
    ...g.perso.map((x, i) => ({ cle: `perso-${i}`, kind: 'perso' as const, label: x.label || t('ligne libre'), prompt: x.prompt, index: i })),
  ].filter(l => l.prompt)
  return { lignes, has, toggle, ajouter, retirer, err }
}

const champ: React.CSSProperties = {
  padding: '7px 10px', borderRadius: 8, font: 'inherit', fontSize: 12.5, color: 'inherit',
  background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.30)', minWidth: 0,
}

/** "Wardrobe" tab of Elements (desktop and mobile). */
export function GarderobeTab({ onInsert, prompt }: { onInsert: (text: string) => void; prompt: string }) {
  const nom = useAppStore(s => s.personaName)
  const { lignes, ajouter, retirer, err } = useGarderobe()
  const edition = useEdition()
  const [label, setLabel] = useState('')
  const [texte, setTexte] = useState('')
  const KIND: Record<GLigne['kind'], string> = { tenues: t('tenue'), lieux: t('lieu'), perso: t('libre') }
  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ fontSize: 12, opacity: 0.7, margin: '0 0 8px' }}>
        {t('Les tenues et lieux de {nom}. Ajoute-les avec ★ dans Tenues et Environnements, ou écris une ligne ici.', { nom })}
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {lignes.map(l => (
          <div key={l.cle} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <button onClick={() => onInsert(l.prompt)}
              style={{ flex: 1, textAlign: 'left', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', font: 'inherit', fontSize: 12.5,
                color: 'inherit', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.22)' }}>
              {l.prompt}
              <small style={{ display: 'block', opacity: 0.6, marginTop: 2 }}>{KIND[l.kind]} · {t(l.label)}</small>
            </button>
            {edition && <button aria-label={t('retirer de la garde-robe')} title={t('retirer de la garde-robe')} onClick={() => retirer(l)}
              style={{ ...champ, cursor: 'pointer', padding: '0 10px' }}>✕</button>}
          </div>
        ))}
        {lignes.length === 0 && <div style={{ fontSize: 12, opacity: 0.55, padding: '6px 0' }}>{t('Garde-robe vide pour l’instant.')}</div>}
      </div>
      {!edition ? <Verrouille style={{ marginTop: 10 }} /> : <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <input style={{ ...champ, flex: '0 1 140px' }} placeholder={t('Nom (ex. robe du café)')} maxLength={60} value={label} onChange={e => setLabel(e.target.value)} />
        <input style={{ ...champ, flex: '1 1 200px' }} placeholder={t('Ligne de prompt (ex. cream knit sweater, gold hoops)')} maxLength={400} value={texte} onChange={e => setTexte(e.target.value)} />
        <button style={{ ...champ, cursor: 'pointer' }} disabled={!texte.trim()} onClick={() => { ajouter(label, texte); setLabel(''); setTexte('') }}>{t('+ Ajouter')}</button>
        {prompt.trim() && <button style={{ ...champ, cursor: 'pointer' }} title={t('ranger le prompt actuel comme ligne de garde-robe')}
          onClick={() => setTexte(prompt.trim().slice(0, 400))}>{t('↧ depuis le prompt')}</button>}
      </div>}
      {err && <div style={{ fontSize: 12, color: '#f05548', marginTop: 6 }}>{err}</div>}
    </div>
  )
}

/** ★ star on a vocabulary item (inside a clickable row: span, not button). */
export function Etoile({ kind, id }: { kind: GKind; id: string }) {
  const { has, toggle } = useGarderobe()
  const edition = useEdition()
  const on = has(kind, id)
  if (!edition) return on ? <span title={t('dans la garde-robe du personnage')} style={{ color: '#f2b84b', fontSize: 15, padding: '0 4px', lineHeight: 1 }}>★</span> : null
  return (
    <span role="button" tabIndex={0} aria-pressed={on}
      title={on ? t('retirer de la garde-robe') : t('ajouter à la garde-robe du personnage')}
      onClick={e => { e.stopPropagation(); toggle(kind, id) }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(kind, id) } }}
      style={{ cursor: 'pointer', color: on ? '#f2b84b' : 'rgba(127,127,127,0.7)', fontSize: 15, padding: '0 4px', lineHeight: 1 }}>{on ? '★' : '☆'}</span>
  )
}
