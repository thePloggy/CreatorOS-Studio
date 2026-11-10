/* ============================================================
   Creator page: who made CreatorOS — name, bio, website link,
   other links and some details. Read view first; "Modifier" opens
   the form. Stored on the server (createur.json).
   Title, bio and details exist in French and English: the page
   shows the interface language, falling back to the other if empty.
   Inline styles, inherited colors: shared by desktop and mobile.
   ============================================================ */
import { useEffect, useState } from 'react'
import { t, getLang, tServeur } from '../../i18n'
import { useEdition } from '../../lib/proprietaire'
import { Verrouille } from '../config/CleProprietaire'

interface Lien { label: string; url: string }
interface Info { k: string; v: string; kEn?: string; vEn?: string }
export interface Createur { nom: string; titre: string; titreEn?: string; bio: string; bioEn?: string; site: string; liens: Lien[]; infos: Info[] }
const VIDE: Createur = { nom: '', titre: '', titreEn: '', bio: '', bioEn: '', site: '', liens: [], infos: [] }
/* interface language, falling back to the other version */
const choisir = (fr: string, en?: string) => (getLang() === 'en' ? en || fr : fr || en || '')

const champ: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 9, font: 'inherit', fontSize: 13, color: 'inherit', width: '100%', minWidth: 0,
  background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.30)',
}
const bouton: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 9, font: 'inherit', fontSize: 12.5, cursor: 'pointer',
  color: 'inherit', background: 'rgba(127,127,127,0.14)', border: '1px solid rgba(127,127,127,0.30)',
}
const carte: React.CSSProperties = {
  borderRadius: 14, padding: 18, background: 'rgba(127,127,127,0.06)', border: '1px solid rgba(127,127,127,0.22)',
}
const hote = (u: string) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return u } }

export function CreateurView() {
  const [c, setC] = useState<Createur | null>(null)
  const [edit, setEdit] = useState<Createur | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const edition = useEdition()

  useEffect(() => {
    void fetch('/api/createur').then(r => r.json()).then((d: Createur) => setC({ ...VIDE, ...d }))
      .catch(() => setMsg(t('lecture impossible')))
  }, [])

  const enregistrer = async () => {
    if (!edit) return
    setMsg(null)
    const r = await fetch('/api/createur', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) })
    const d = await r.json().catch(() => ({})) as Createur & { error?: string }
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    const ignores = edit.liens.filter(l => l.url.trim()).length - d.liens.length + (edit.site.trim() && !d.site ? 1 : 0)
    setC({ ...VIDE, ...d }); setEdit(null)
    if (ignores > 0) setMsg(t('{n} lien(s) ignoré(s) : https uniquement', { n: ignores }))
  }

  if (!c) return <div style={{ padding: 16, fontSize: 13, opacity: 0.6 }}>{msg ?? t('chargement…')}</div>

  if (edit) {
    const set = (p: Partial<Createur>) => setEdit({ ...edit, ...p })
    return (
      <div style={{ ...carte, display: 'grid', gap: 10 }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Nom')}<input style={champ} maxLength={80} value={edit.nom} onChange={e => set({ nom: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Titre (une ligne)')}<input style={champ} maxLength={140} value={edit.titre} placeholder={t('ex. développeur et créateur de contenu IA')} onChange={e => set({ titre: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Titre en anglais')}<input style={champ} maxLength={140} value={edit.titreEn ?? ''} onChange={e => set({ titreEn: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Présentation')}<textarea style={{ ...champ, minHeight: 110, resize: 'vertical' }} maxLength={2000} value={edit.bio} onChange={e => set({ bio: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Présentation en anglais')}<textarea style={{ ...champ, minHeight: 110, resize: 'vertical' }} maxLength={2000} value={edit.bioEn ?? ''} onChange={e => set({ bioEn: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{t('Site')}<input style={champ} maxLength={300} value={edit.site} placeholder="https://…" onChange={e => set({ site: e.target.value })} /></label>

        <div style={{ fontSize: 12, opacity: 0.7 }}>{t('Autres liens')}</div>
        {edit.liens.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <input style={{ ...champ, flex: '0 1 140px' }} maxLength={60} placeholder={t('Libellé')} value={l.label}
              onChange={e => set({ liens: edit.liens.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input style={{ ...champ, flex: 1 }} maxLength={300} placeholder="https://…" value={l.url}
              onChange={e => set({ liens: edit.liens.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
            <button style={bouton} aria-label={t('retirer')} onClick={() => set({ liens: edit.liens.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        {edit.liens.length < 12 && <button style={{ ...bouton, justifySelf: 'start' }} onClick={() => set({ liens: [...edit.liens, { label: '', url: '' }] })}>{t('+ Lien')}</button>}

        <div style={{ fontSize: 12, opacity: 0.7 }}>{t('Informations (ex. Lieu → Paris)')}</div>
        {edit.infos.map((x, i) => (
          <div key={i} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input style={{ ...champ, flex: '0 1 140px' }} maxLength={60} placeholder={t('Intitulé')} value={x.k}
              onChange={e => set({ infos: edit.infos.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)) })} />
            <input style={{ ...champ, flex: 1 }} maxLength={300} placeholder={t('Valeur')} value={x.v}
              onChange={e => set({ infos: edit.infos.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)) })} />
            <button style={bouton} aria-label={t('retirer')} onClick={() => set({ infos: edit.infos.filter((_, j) => j !== i) })}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: -4, paddingRight: 34 }}>
            <input style={{ ...champ, flex: '0 1 140px', fontSize: 12 }} maxLength={60} placeholder={t('en anglais')} value={x.kEn ?? ''}
              onChange={e => set({ infos: edit.infos.map((y, j) => (j === i ? { ...y, kEn: e.target.value } : y)) })} />
            <input style={{ ...champ, flex: 1, fontSize: 12 }} maxLength={300} placeholder={t('en anglais (vide = même valeur)')} value={x.vEn ?? ''}
              onChange={e => set({ infos: edit.infos.map((y, j) => (j === i ? { ...y, vEn: e.target.value } : y)) })} />
          </div>
          </div>
        ))}
        {edit.infos.length < 12 && <button style={{ ...bouton, justifySelf: 'start' }} onClick={() => set({ infos: [...edit.infos, { k: '', v: '' }] })}>{t('+ Information')}</button>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <button style={{ ...bouton, background: 'rgba(234,78,137,0.85)', color: '#fff', border: 0 }} onClick={() => void enregistrer()}>{t('Enregistrer')}</button>
          <button style={bouton} onClick={() => { setEdit(null); setMsg(null) }}>{t('Annuler')}</button>
          {msg && <span style={{ fontSize: 12, opacity: 0.8 }}>{msg}</span>}
        </div>
        <span style={{ fontSize: 12, opacity: 0.55 }}>{t('Cette page est visible de tous les visiteurs : n’y mets rien de privé.')}</span>
      </div>
    )
  }

  const vide = !c.nom && !c.bio && !c.bioEn && !c.site && !c.liens.length && !c.infos.length
  const titre = choisir(c.titre, c.titreEn), bio = choisir(c.bio, c.bioEn)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={carte}>
        {vide ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.65 }}>{t('Rien ici pour l’instant : ajoute ton nom, une présentation et le lien de ton site.')}</p>
        ) : (<>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>{c.nom}</div>
          {titre && <div style={{ fontSize: 13.5, opacity: 0.7, marginTop: 2 }}>{titre}</div>}
          {bio && <p style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: '12px 0 0' }}>{bio}</p>}
          {c.site && (
            <a href={c.site} target="_blank" rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '9px 14px', borderRadius: 10,
                background: 'linear-gradient(90deg,#f24d8a,#a855f7)', color: '#fff', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>
              {hote(c.site)} ↗
            </a>
          )}
        </>)}
      </div>
      {(c.liens.length > 0 || c.infos.length > 0) && (
        <div style={{ ...carte, display: 'grid', gap: 8 }}>
          {c.infos.map((x, i) => (
            <div key={`i${i}`} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <span style={{ opacity: 0.6, minWidth: 110 }}>{choisir(x.k, x.kEn)}</span><span>{choisir(x.v, x.vEn)}</span>
            </div>
          ))}
          {c.liens.map((l, i) => (
            <div key={`l${i}`} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <span style={{ opacity: 0.6, minWidth: 110 }}>{l.label || hote(l.url)}</span>
              <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hote(l.url)} ↗</a>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {edition
          ? <button style={bouton} onClick={() => setEdit({ ...c, liens: c.liens.map(l => ({ ...l })), infos: c.infos.map(x => ({ ...x })) })}>{t('Modifier')}</button>
          : <Verrouille />}
        {msg && <span style={{ fontSize: 12, opacity: 0.8 }}>{msg}</span>}
      </div>
    </div>
  )
}
