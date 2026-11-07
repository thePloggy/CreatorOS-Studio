/* ============================================================
   Liste des personnages — choisir l'actif, en créer, dupliquer, supprimer.

   Le personnage ACTIF est celui des prochains rendus ; l'éditeur placé
   dessous modifie celui-là. Un rendu déjà en file garde le personnage qui
   était actif quand il a été lancé.
   Styles en ligne, couleurs héritées : partagé bureau et mobile.
   ============================================================ */
import { Ic } from '../v2/bits'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import type { PersonaCredit } from '../types'
import { CreditLigne } from './PersonaCredit'
import { personnageChoisi, SANS_PERSONNAGE } from '../lib/personnage'

export interface PersonaResume {
  id: string; name: string | null; trigger: string; avatar: string | null
  loras: { name: string }[]; videoLoras: { name: string }[]; active: boolean
  lorasKlein?: { name: string }[]; credit?: PersonaCredit | null
}

const bouton: React.CSSProperties = {
  padding: '6px 11px', borderRadius: 8, font: 'inherit', fontSize: 12, cursor: 'pointer',
  color: 'inherit', background: 'rgba(127,127,127,0.14)', border: '1px solid rgba(127,127,127,0.30)',
}

async function appel(url: string, init?: RequestInit) {
  const r = await fetch(url, init)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(tServeur((d as { error?: string }).error) ?? `HTTP ${r.status}`)
  return d
}

/** `onChange` : appelé avec l'id de l'actif après chaque changement, pour que
 *  l'éditeur se recharge sur le bon personnage. */
/** `onCreerDeZero` : ouvre le créateur de personnage (description → visages → planche → LoRA). */
export function PersonaListe({ onChange, onCreerDeZero }: { onChange: (actif: string | null) => void; onCreerDeZero?: () => void }) {
  const [liste, setListe] = useState<PersonaResume[] | null>(null)
  const [nouveau, setNouveau] = useState<string | null>(null)
  const [choix, setChoix] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const refresh = useAppStore(s => s.refreshPersona)
  const edition = useEdition()

  const charger = async () => {
    try {
      const d = await appel('/api/personas') as { active: string | null; personas: PersonaResume[] }
      // le personnage de ce navigateur prime sur l'actif du serveur : la fiche montre celui qu'on voit en haut
      const c = personnageChoisi()
      const actif = c && c !== SANS_PERSONNAGE && d.personas.some(p => p.id === c) ? c : d.active
      setListe(d.personas.map(p => ({ ...p, active: p.id === actif }))); onChange(actif)
    } catch (e) { setMsg(t('lecture impossible : {e}', { e: (e as Error).message })) }
  }
  // relu aussi quand le nom ou la photo de l'actif change (éditeur, dépôt de photo)
  const nomActif = useAppStore(s => s.personaName), photoActif = useAppStore(s => s.personaAvatar)
  useEffect(() => { void charger() }, [nomActif, photoActif])   // eslint-disable-line react-hooks/exhaustive-deps

  // actif du serveur ET choix de ce navigateur : les prochains rendus et la fiche suivent le même
  const activer = async (id: string) => {
    await appel(`/api/personas/${id}/activer`, { method: 'POST' })
    await useAppStore.getState().choisirPersonnage(id)
  }

  async function agir(f: () => Promise<unknown>) {
    setMsg(null)
    try { await f(); await charger(); await refresh() }
    catch (e) { setMsg((e as Error).message) }
  }

  const creer = (depuis?: string) => agir(() => appel('/api/personas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nouveau?.trim() || undefined, depuis }),
  }).then(() => setNouveau(null)))

  if (!liste) return <div style={{ fontSize: 13, opacity: 0.6 }}>{msg ?? t('chargement…')}</div>

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
        {liste.map(p => (
          <div key={p.id} role="button" tabIndex={0} aria-pressed={p.active}
            onClick={() => { if (!p.active) void agir(() => activer(p.id)) }}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !p.active) void agir(() => activer(p.id)) }}
            style={{
              padding: '10px 12px', borderRadius: 12, cursor: p.active ? 'default' : 'pointer',
              border: p.active ? '2px solid rgba(234,78,137,0.9)' : '1px solid rgba(127,127,127,0.30)',
              background: p.active ? 'rgba(234,78,137,0.10)' : 'rgba(127,127,127,0.06)',
              display: 'flex', alignItems: 'center', gap: 12, minWidth: 0,
            }}>
            {p.avatar
              ? <img src={p.avatar} alt="" draggable={false} style={{ flex: 'none', width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />
              : <span style={{ flex: 'none', width: 52, height: 52, borderRadius: '50%', background: 'linear-gradient(135deg,#3a4a5c,#232d38)' }} />}
            <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
              <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || t('sans nom')}</b>
              <span style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.active ? t('actif · ') : ''}{[p.loras.length && 'Krea', p.lorasKlein?.length && 'Klein', p.videoLoras.length && t('vidéo')].filter(Boolean).join(' · ') || t('sans LoRA')}
              </span>
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><CreditLigne credit={p.credit} /></span>
            </div>
            {edition && <div style={{ display: 'grid', gap: 4, flex: 'none' }} onClick={e => e.stopPropagation()}>
              <button style={{ ...bouton, padding: '2px 7px', fontSize: 11.5 }} title={t('Créer une copie de ce personnage')}
                onClick={() => void creer(p.id)}>{t('dupliquer')}</button>
              {liste.length > 1 && (
                <button style={{ ...bouton, padding: '2px 7px', fontSize: 11.5 }} aria-label={t('supprimer {nom}', { nom: p.name ?? p.id })}
                  onClick={() => { if (confirm(t('Supprimer « {nom} » ? Ses rendus restent dans la bibliothèque, ses LoRA dans le dossier.', { nom: p.name || p.id })))
                    void agir(() => appel(`/api/personas/${p.id}`, { method: 'DELETE' })) }}>✕</button>
              )}
            </div>}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {!edition ? null : nouveau === null
          ? choix
            ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, width: '100%' }}>
                {onCreerDeZero && <button style={{ ...bouton, padding: '12px 14px', textAlign: 'left', display: 'grid', gap: 4 }} onClick={() => { setChoix(false); onCreerDeZero() }}>
                  <b style={{ fontSize: 13 }}>✨ {t('Créer de zéro')}</b>
                  <span style={{ opacity: 0.7 }}>{t('Décris-le : 4 visages, une planche de référence, 12 images et sa LoRA.')}</span>
                </button>}
                <button style={{ ...bouton, padding: '12px 14px', textAlign: 'left', display: 'grid', gap: 4 }} onClick={() => { setChoix(false); setNouveau('') }}>
                  <b style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Ic n="upload" s={13} />{t('Importer une LoRA existante')}</b>
                  <span style={{ opacity: 0.7 }}>{t('Un personnage vide : tu ajoutes ensuite sa LoRA (déposée dans le dossier des LoRA) et son crédit.')}</span>
                </button>
                <button style={{ ...bouton, justifySelf: 'start' }} onClick={() => setChoix(false)}>{t('Annuler')}</button>
              </div>
            : <button style={bouton} onClick={() => setChoix(true)}>{t('+ Nouveau personnage')}</button>
          : <>
              <input autoFocus value={nouveau} placeholder={t('Nom')} maxLength={60}
                onChange={e => setNouveau(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void creer(); if (e.key === 'Escape') setNouveau(null) }}
                style={{ padding: '6px 10px', borderRadius: 8, font: 'inherit', fontSize: 13, color: 'inherit',
                  background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.30)' }} />
              <button style={bouton} onClick={() => void creer()}>{t('Créer')}</button>
              <button style={bouton} onClick={() => setNouveau(null)}>{t('Annuler')}</button>
            </>}
        {msg && <span style={{ fontSize: 12, opacity: 0.8 }}>{msg}</span>}
      </div>
    </div>
  )
}
