/* Réglage « Propriétaire » : n'apparaît que si le serveur est verrouillé. */
import { useEffect, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { fmtDur } from '../../lib/progress'
import { ecrireCleProprietaire, lireCleProprietaire, useVerrou } from '../../lib/proprietaire'

export function CleProprietaire() {
  const v = useVerrou()
  const [saisie, setSaisie] = useState('')
  if (!v?.verrou) return null
  const enregistree = !!lireCleProprietaire()
  return (
    <div className="border border-border rounded-card bg-surface2 p-4 max-w-[720px] mt-4">
      <div className="font-semibold text-[13px] mb-1">{t('Propriétaire du studio')}</div>
      <p className="text-[12px] text-muted mb-3" style={{ lineHeight: 1.5 }}>
        {t('Ce studio est verrouillé : la page Créateur, les personnages, la garde-robe, les recettes et les prompts ne se modifient qu’avec la clé du propriétaire.')}
      </p>
      {v.proprietaire ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px]">🔓 {t('Clé du propriétaire reconnue dans ce navigateur')}</span>
          <button className="pill" onClick={() => ecrireCleProprietaire(null)}>{t('Oublier la clé')}</button>
          <Visites />
        </div>
      ) : (
        <form className="flex items-center gap-2 flex-wrap" onSubmit={e => { e.preventDefault(); const k = saisie.trim(); if (k) { ecrireCleProprietaire(k); setSaisie('') } }}>
          <input type="password" autoComplete="off" spellCheck={false} value={saisie} onChange={e => setSaisie(e.target.value)}
            className="bg-surface3 border border-border rounded px-2 py-1 text-[12px]" style={{ minWidth: 260 }} />
          <button className="pill" type="submit" disabled={!saisie.trim()}>{t('Déverrouiller')}</button>
          {enregistree && <span className="text-[12px] text-muted">{t('clé enregistrée refusée par le serveur')}</span>}
        </form>
      )}
    </div>
  )
}

/** Visiteurs par jour (comptés sans rien garder de personnel, cf. server/visites.js). */
function Visites() {
  const [d, setD] = useState<{
    jours: { jour: string; visiteurs: number; pages: number; rendus: number; rendusProprietaire?: number; refuses: number; tailnet: number }[]
    journal?: { at: number; job?: string; type: string; statut: string; dureeMs?: number; erreur?: string }[]
    enCours?: number
  } | null>(null)
  useEffect(() => { void fetch('/api/visites').then(r => r.ok ? r.json() : null).then(setD).catch(() => {}) }, [])
  if (!d) return null
  return (<>
    <table className="text-[12px] mt-3 w-full" style={{ borderCollapse: 'collapse' }}>
      <thead><tr className="text-muted text-left">
        <th>{t('Jour')}</th><th>{t('Visiteurs')}</th><th>{t('Pages vues')}</th><th>{t('Rendus visiteurs')}</th><th>{t('Rendus propriétaire')}</th><th>{t('Refusés (limite)')}</th><th>{t('Pages propriétaire / tailnet')}</th>
      </tr></thead>
      <tbody>{d.jours.slice(0, 14).map(j => (
        <tr key={j.jour}><td>{j.jour}</td><td><b>{j.visiteurs}</b></td><td>{j.pages}</td><td><b>{j.rendus}</b></td><td>{j.rendusProprietaire ?? '—'}</td><td>{j.refuses}</td><td>{j.tailnet}</td></tr>
      ))}</tbody>
    </table>
    <JournalVisiteurs journal={d.journal ?? []} enCours={d.enCours ?? 0} />
  </>)
}

/** Les derniers rendus lancés par des visiteurs d'Internet, et leur issue (cf. server/visites.js). */
function JournalVisiteurs({ journal, enCours }: { journal: { at: number; job?: string; type: string; statut: string; dureeMs?: number; erreur?: string }[]; enCours: number }) {
  const couleur: Record<string, string> = { 'terminé': '#5ec27a', 'échec': '#e06c6c', 'refusé': '#f0b43c', 'annulé': 'inherit' }
  return (
    <div className="mt-4">
      <div className="font-semibold text-[12.5px] mb-1">{t('Rendus des visiteurs')}
        <span className="text-muted font-normal"> · {enCours ? t('{n} en cours', { n: enCours }) : t('aucun en cours')}</span></div>
      {journal.length === 0 ? <div className="text-[12px] text-muted">{t('Aucun rendu de visiteur pour l’instant.')}</div> : (
        <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
          <thead><tr className="text-muted text-left"><th>{t('Quand')}</th><th>{t('Rendu')}</th><th>{t('Issue')}</th><th>{t('Durée')}</th><th>{t('Cause')}</th></tr></thead>
          <tbody>{journal.map((e, i) => (
            <tr key={i} style={{ verticalAlign: 'top' }}>
              <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              <td>{e.type}{e.job ? <span className="text-muted"> · #{e.job}</span> : null}</td>
              <td style={{ color: couleur[e.statut] }}>{t(e.statut)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{e.dureeMs ? fmtDur(e.dureeMs) : '—'}</td>
              <td style={{ wordBreak: 'break-word' }}>{e.erreur ? tServeur(e.erreur) : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}

/** Ligne affichée à la place d'un bouton d'édition, pour le visiteur. */
export function Verrouille({ style }: { style?: React.CSSProperties }) {
  return <div style={{ fontSize: 12, opacity: 0.6, ...style }}>🔒 {t('Réglé par le propriétaire du studio')}</div>
}
