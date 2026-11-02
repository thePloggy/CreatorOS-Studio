/* Extensions : les fonctions ajoutées au studio sans code (cf. server/extensions.js), avec leur
   formulaire, et le catalogue d'où le propriétaire en installe de nouvelles. */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { FramePicker } from './popups'

type Entree = { id: string; type: 'texte' | 'nombre' | 'choix' | 'image'; label: string; defaut: unknown; options?: string[]; min?: number; max?: number; aide?: string }
type Extension = { id: string; nom: string; description: string; auteur: string; licence: string; version: string; sortie: 'image' | 'video' | 'audio'; source: 'livree' | 'installee'; entrees: Entree[]; manque: { noeuds: string[]; modeles: string[] } }
type Fiche = { id: string; nom: string; description: string; auteur: string; licence: string; installee: boolean }

const poster = async (url: string, corps?: object) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps ?? {}) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
  return d
}

function CarteExtension({ x, onRetirer }: { x: Extension; onRetirer: () => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const [valeurs, setValeurs] = useState<Record<string, unknown>>(() => Object.fromEntries(x.entrees.map(e => [e.id, e.defaut ?? (e.type === 'nombre' ? e.min ?? 0 : '')])))
  const [choix, setChoix] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; txt: string } | null>(null)
  const [occupe, setOccupe] = useState(false)
  const manque = [...x.manque.noeuds, ...x.manque.modeles]
  const bloquee = manque.length > 0 || (x.source === 'installee' && !edition)
  const maj = (k: string, v: unknown) => setValeurs(o => ({ ...o, [k]: v }))
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try {
      const d = await poster(`/api/extensions/${x.id}/lancer`, { valeurs }) as { id: string }
      await s.adoptServerJob(d.id)
      setMsg({ ok: true, txt: x.sortie === 'audio' ? t('en cours : le son arrive dans Musique et voix') : t('en cours : le résultat arrive dans la bibliothèque') })
    } catch (e) { setMsg({ ok: false, txt: String((e as Error).message) }) }
    setOccupe(false)
  }
  const photo = (id: string) => s.assets.find(a => a.id === id)
  return (
    <div className="guide-outil" style={{ alignContent: 'start' }}>
      <div className="flex gap-2 items-center flex-wrap">
        <b>{x.nom}</b>
        <span className="texte-faible">{x.source === 'livree' ? t('livrée avec le studio') : t('installée')} · v{x.version}</span>
      </div>
      <p>{x.description}</p>
      {x.entrees.map(e => (
        <label key={e.id} className="flex gap-2 items-center flex-wrap">
          <span className="texte-doux" style={{ minWidth: 90 }}>{e.label}</span>
          {e.type === 'texte' && <input className="champ" style={{ flex: 1, minWidth: 180 }} value={String(valeurs[e.id] ?? '')} maxLength={600} onChange={ev => maj(e.id, ev.target.value)} />}
          {e.type === 'nombre' && <input className="champ" type="number" style={{ width: 90 }} min={e.min} max={e.max} value={Number(valeurs[e.id] ?? 0)} onChange={ev => maj(e.id, Number(ev.target.value))} />}
          {e.type === 'choix' && <select className="champ" style={{ flex: 1, minWidth: 180 }} value={String(valeurs[e.id] ?? '')} onChange={ev => maj(e.id, ev.target.value)}>
            {e.options?.map(o => <option key={o} value={o}>{o}</option>)}</select>}
          {e.type === 'image' && <>
            {photo(String(valeurs[e.id] ?? '')) && <img src={photo(String(valeurs[e.id]))!.uri} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8 }} />}
            <button className="pill" onClick={() => setChoix(e.id)}>{valeurs[e.id] ? t('changer de photo') : t('choisir une photo')}</button>
          </>}
          {e.aide && <span className="texte-faible" style={{ flexBasis: '100%' }}>{e.aide}</span>}
        </label>
      ))}
      {manque.length > 0 && <span className="texte-erreur">{t('Il manque à ComfyUI : {x}', { x: manque.join(', ') })}</span>}
      <div className="flex gap-2 items-center flex-wrap">
        <button className="pill" disabled={bloquee || occupe || x.entrees.some(e => e.type === 'image' && !valeurs[e.id])} onClick={() => void lancer()}>{occupe ? '…' : t('Lancer')}</button>
        {x.source === 'installee' && edition && <button className="pill" onClick={onRetirer}>{t('Retirer')}</button>}
        <span className="texte-faible">{[x.auteur, x.licence].filter(Boolean).join(' · ')}</span>
      </div>
      {msg && <span className={msg.ok ? 'texte-doux' : 'texte-erreur'}>{msg.txt}</span>}
      <FramePicker open={!!choix} onClose={() => setChoix(null)} title={t('Photo')} media="photo" assets={s.assets.filter((a: Asset) => a.mediaType === 'photo')}
        onPickAsset={(a: Asset) => { if (choix) maj(choix, a.id); setChoix(null) }} onPickUpload={() => setChoix(null)} />
    </div>
  )
}

export function ExtensionsView() {
  const edition = useEdition()
  const [liste, setListe] = useState<Extension[] | null>(null)
  const [cat, setCat] = useState<Fiche[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const charger = () => void fetch('/api/extensions').then(r => r.json()).then((d: { extensions: Extension[]; catalogue: Fiche[] }) => { setListe(d.extensions); setCat(d.catalogue) }).catch(() => setListe([]))
  useEffect(charger, [])
  const agir = async (url: string) => { setMsg(null); try { await poster(url); charger() } catch (e) { setMsg(String((e as Error).message)) } }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px', display: 'grid', gap: 18 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <h2 className="titre-outil">{t('Extensions')}</h2>
          <span className="texte-doux" style={{ fontSize: 13 }}>{t('Des fonctions ajoutées au studio sans code : un workflow ComfyUI et un fichier app.json qui décrit le formulaire. Le studio vérifie que chaque nœud et chaque modèle existe déjà dans ComfyUI, rien n’est installé à sa place.')}</span>
          <a className="texte-doux" style={{ fontSize: 13, textDecoration: 'underline' }} href="https://github.com/thePloggy/CreatorOS-Studio/blob/main/docs/EXTENSIONS.md" target="_blank" rel="noreferrer">{t('Écrire une extension')}</a>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {liste?.map(x => <CarteExtension key={x.id} x={x} onRetirer={() => void agir(`/api/extensions/${x.id}/retirer`)} />)}
        </div>
        <b style={{ fontSize: 18 }}>{t('Catalogue')}</b>
        {cat.length === 0 && <span className="texte-doux">{t('Le catalogue est vide.')}</span>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {cat.map(f => (
            <div key={f.id} className="guide-outil" style={{ alignContent: 'start' }}>
              <b>{f.nom}</b>
              <p>{f.description}</p>
              <div className="flex gap-2 items-center flex-wrap">
                {f.installee ? <span className="texte-doux">{t('installée')}</span>
                  : edition ? <button className="pill" onClick={() => void agir(`/api/extensions/${f.id}/installer`)}>{t('Installer')}</button>
                  : <span className="texte-faible">{t('installation réservée au propriétaire')}</span>}
                <span className="texte-faible">{[f.auteur, f.licence].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
          ))}
        </div>
        {msg && <span className="texte-erreur">{msg}</span>}
      </div>
    </div>
  )
}
