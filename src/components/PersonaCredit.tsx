/* ============================================================
   Character credit: the author of its LoRA, their page and the licence.
   Civitai licences often require crediting the author: the credit stays
   visible on the character card. Filled in once, then locked (the server
   refuses changes).
   Inline styles, inherited colours: shared desktop and mobile.
   ============================================================ */
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import type { PersonaCredit } from '../types'
import { t, tServeur } from '../i18n'

const champ: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 8, font: 'inherit', fontSize: 12.5, color: 'inherit', width: '100%',
  background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.30)',
}
const bouton: React.CSSProperties = {
  padding: '5px 10px', borderRadius: 8, font: 'inherit', fontSize: 12, cursor: 'pointer',
  color: 'inherit', background: 'rgba(127,127,127,0.14)', border: '1px solid rgba(127,127,127,0.30)',
}

/** Compact credit line (cards). */
export function CreditLigne({ credit }: { credit: PersonaCredit | null | undefined }) {
  if (!credit?.auteur && !credit?.url) return <span style={{ fontSize: 12, opacity: 0.45 }}>{t('crédit à renseigner')}</span>
  return (
    <span style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
      title={credit.licence || undefined}>
      {t('par')} {credit.url
        ? <a href={credit.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'inherit' }}>{credit.auteur || t('l’auteur')}</a>
        : credit.auteur}
    </span>
  )
}

/** Full block for the active character: editable while empty, locked afterwards. */
export function CreditPersonnage() {
  const id = useAppStore(s => s.personaId)
  const credit = useAppStore(s => s.personaCredit)
  const refresh = useAppStore(s => s.refreshPersona)
  const edition = useEdition()
  const [edit, setEdit] = useState<PersonaCredit | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const enregistrer = async () => {
    if (!id || !edit) return
    setMsg(null)
    const r = await fetch(`/api/personas/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credit: edit }) })
    if (!r.ok) { setMsg(tServeur(((await r.json().catch(() => ({}))) as { error?: string }).error) ?? `HTTP ${r.status}`); return }
    await refresh(); setEdit(null)
  }

  if (edit) return (
    <div style={{ display: 'grid', gap: 6 }}>
      <input style={champ} placeholder={t('Auteur de la LoRA')} maxLength={200} value={edit.auteur} onChange={e => setEdit({ ...edit, auteur: e.target.value })} />
      <input style={champ} placeholder="https://civitai.com/models/…" maxLength={200} value={edit.url} onChange={e => setEdit({ ...edit, url: e.target.value })} />
      <input style={champ} placeholder={t('Licence (ex. crédit requis · vente des images interdite)')} maxLength={200} value={edit.licence} onChange={e => setEdit({ ...edit, licence: e.target.value })} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button style={bouton} onClick={() => void enregistrer()}>{t('Enregistrer')}</button>
        <button style={bouton} onClick={() => setEdit(null)}>{t('Annuler')}</button>
        {msg && <span style={{ fontSize: 12, opacity: 0.8 }}>{msg}</span>}
      </div>
      <span style={{ fontSize: 12, opacity: 0.55 }}>{t('Lien en https uniquement. Une fois enregistré, le crédit est verrouillé.')}</span>
    </div>
  )
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.5 }}>
        {credit?.auteur || credit?.url ? (<>
          <div>{t('LoRA par')} <b>{credit.auteur || '—'}</b>
            {credit.url && <> · <a href={credit.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{t('page du modèle ↗')}</a></>}</div>
          {credit.licence && <div style={{ opacity: 0.7 }}>{t('Licence')} : {t(credit.licence)}</div>}
        </>) : <div style={{ opacity: 0.6 }}>{t('Aucun crédit renseigné pour ce personnage.')}</div>}
      </div>
      {credit
        ? <span style={{ fontSize: 12, opacity: 0.55 }} title={t('La provenance d’une LoRA ne change pas : le crédit ne se modifie plus.')}>🔒 {t('verrouillé')}</span>
        : edition && <button style={bouton} onClick={() => setEdit({ auteur: '', url: '', licence: '' })}>{t('Renseigner le crédit')}</button>}
    </div>
  )
}
