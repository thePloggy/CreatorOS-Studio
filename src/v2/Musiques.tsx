/* Audio library (Audio tab of the library): sounds generated in the sound studio and sounds
   dropped into the editor, with their waveform. Creation happens in the Sound studio section,
   opened from here on the right tab. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { useAppStore } from '../store/useAppStore'
import { LecteurOnde } from './Onde'

const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}(_\d)?\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')
type Onglet = 'musique' | 'voix' | 'bruitage'

/** Opens the Sound studio section on a given tab. */
export function ouvrirStudioSon(o: Onglet) {
  useAppStore.setState(st => ({ ongletAudio: o, ongletMusiques: false, navRequest: { section: 'son', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
}

export function Musiques() {
  const edition = useEdition()
  const [liste, setListe] = useState<{ nom: string; duree: number }[] | null>(null)
  const [aConfirmer, setAConfirmer] = useState<{ nom: string; usages: string[] } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const jobs = useAppStore(st => st.jobs)
  const nbEnCours = useMemo(() => jobs.filter(j => String(j.mode) === 'audio' && !['done', 'failed', 'cancelled', 'blocked'].includes(String(j.status))).length, [jobs])
  const charger = () => void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string; duree: number }[] }) => setListe(d.musiques ?? [])).catch(() => setListe([]))
  useEffect(() => { if (nbEnCours === 0) charger() }, [nbEnCours])
  const supprimer = async (nom: string, confirme = false) => {
    setErreur(null)
    const r = await fetch(`/api/montage/musiques/${encodeURIComponent(nom)}${confirme ? '?confirme=1' : ''}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (r.status === 409) { setAConfirmer({ nom, usages: d.usages ?? [] }); return }
    if (!r.ok) { setErreur(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setAConfirmer(null); charger()
  }
  const vus = (liste ?? []).filter(m => !q.trim() || m.nom.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="flex-1 min-w-0 overflow-y-auto biblio-audio">
      <div className="biblio-audio-tete">
        <div style={{ display: 'grid', gap: 3 }}>
          <h2 className="titre-outil" style={{ margin: 0 }}>{t('Bibliothèque audio')}</h2>
          <span className="texte-doux">{t('Musiques, voix et bruitages : tout ce que le montage et le reel peuvent employer.')}</span>
        </div>
        <span className="flex gap-1.5 flex-wrap">
          <button className="pill" onClick={() => ouvrirStudioSon('musique')}>{t('Studio son : musique')}</button>
          <button className="pill tool" onClick={() => ouvrirStudioSon('voix')}>{t('Voix')}</button>
          <button className="pill tool" onClick={() => ouvrirStudioSon('bruitage')}>{t('Bruitages')}</button>
        </span>
      </div>
      {nbEnCours > 0 && <button className="biblio-audio-encours" onClick={() => ouvrirStudioSon('musique')}>{t('{n} rendu(s) audio en cours : suivre dans le studio son ›', { n: nbEnCours })}</button>}
      <input className="champ" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Chercher un son…')} aria-label={t('Chercher un son…')} style={{ maxWidth: 360 }} />
      {liste && liste.length === 0 && <span className="texte-faible">{t('Rien pour l’instant : génère ton premier morceau.')}</span>}
      <div className="audio-grille">
        {vus.map(m => (
          <div key={m.nom} className="audio-carte">
            <b>{nomCourt(m.nom)}</b>
            <span className="texte-faible">{m.nom.startsWith('voix') ? t('voix') : t('musique ou son')}{m.duree ? ` · ${Math.round(m.duree)} s` : ''}</span>
            <LecteurOnde src={`/api/montage/musiques/${encodeURIComponent(m.nom)}`} duree={m.duree} compact />
            {edition && (aConfirmer?.nom === m.nom
              ? <span className="audio-confirme">
                  <span>{t('Employé par : {l}. Le retirer quand même ?', { l: aConfirmer.usages.join(', ') })}</span>
                  <button className="pill" onClick={() => void supprimer(m.nom, true)}>{t('Supprimer')}</button>
                  <button className="pill" onClick={() => setAConfirmer(null)}>{t('Annuler')}</button>
                </span>
              : <button className="audio-suppr" aria-label={t('supprimer {nom}', { nom: nomCourt(m.nom) })} title={t('Supprimer ce son')} onClick={() => void supprimer(m.nom)}>✕</button>)}
          </div>
        ))}
      </div>
      {erreur && <span className="texte-erreur">{erreur}</span>}
    </div>
  )
}
