/* Page audio en trois onglets : studio musique (morceau, paroles, voix chantée), studio dialogue
   et voix (voix de synthèse, clonage, changement, voix des personnages) et bruitages. À droite,
   la bibliothèque audio : sons générés ici et ceux déposés dans le montage. Bureau et mobile. */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { OutilPage } from './OutilPage'
import { JobCard } from './bits'
import { useAppStore } from '../store/useAppStore'
import { StudioBruitage, StudioMusique } from './StudioMusique'
import { StudioVoix } from './StudioVoix'

const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}(_\d)?\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')
type Onglet = 'musique' | 'voix' | 'bruitage'
const ONGLETS: [Onglet, string][] = [['musique', 'Music Studio'], ['voix', 'Dialog & Voice Studio'], ['bruitage', 'Sound Effects']]
const TEXTES: Record<Onglet, string> = {
  musique: 'Un morceau complet : style, instruments, tempo, tonalité, paroles et voix chantée. Deux prises à chaque fois.',
  voix: 'Fais parler une voix, clone ou change une voix, et donne sa voix à chaque personnage.',
  bruitage: 'Décris un son, c’est tout : il rejoint la bibliothèque audio, prêt pour le montage.',
}

export function Musiques() {
  const edition = useEdition()
  const [liste, setListe] = useState<{ nom: string; duree: number }[] | null>(null)
  const [aConfirmer, setAConfirmer] = useState<{ nom: string; usages: string[] } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  // morceaux et bruitages en cours de rendu : même carte d'attente que les images et les vidéos
  const jobs = useAppStore(st => st.jobs)
  const enCours = useMemo(() => jobs.filter(j => (String(j.mode) === 'audio' || j.mode === 'son') && !['done', 'failed', 'cancelled', 'blocked'].includes(String(j.status))), [jobs])
  const nbEnCours = enCours.length
  useEffect(() => { if (nbEnCours === 0) charger() }, [nbEnCours]) // eslint-disable-line react-hooks/exhaustive-deps
  const supprimer = async (nom: string, confirme = false) => {
    setErreur(null)
    const r = await fetch(`/api/montage/musiques/${encodeURIComponent(nom)}${confirme ? '?confirme=1' : ''}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (r.status === 409) { setAConfirmer({ nom, usages: d.usages ?? [] }); return }
    if (!r.ok) { setErreur(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setAConfirmer(null); charger()
  }
  // l'onglet ouvert vient du menu Audio (Music Studio, Dialog & Voice Studio, Sound Effects…)
  const onglet = useAppStore(st => st.ongletAudio)
  const choisir = (o: Onglet) => useAppStore.setState({ ongletAudio: o })
  const charger = () => void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string; duree: number }[] }) => setListe(d.musiques ?? [])).catch(() => setListe([]))
  useEffect(charger, [])
  return (
    <OutilPage titre={t(ONGLETS.find(([o]) => o === onglet)?.[1] ?? 'Music Studio')} texte={t(TEXTES[onglet])}
      vide={t('Rien pour l’instant : génère ton premier morceau.')}
      resultat={(liste && liste.length > 0) || enCours.length > 0 ? (
        <div className="audio-grille">
          {enCours.map(j => <div key={j.id} className="audio-attente"><JobCard j={j} /></div>)}
          {(liste ?? []).map(m => (
            <div key={m.nom} className="audio-carte">
              <b>{nomCourt(m.nom)}</b>
              <span className="texte-faible">{m.nom.startsWith('voix') ? t('voix') : t('musique ou son')}{m.duree ? ` · ${Math.round(m.duree)} s` : ''}</span>
              <audio controls preload="none" src={`/api/montage/musiques/${encodeURIComponent(m.nom)}`} />
              {edition && (aConfirmer?.nom === m.nom
                ? <span className="audio-confirme">
                    <span>{t('Employé par : {l}. Le retirer quand même ?', { l: aConfirmer.usages.join(', ') })}</span>
                    <button className="pill" onClick={() => void supprimer(m.nom, true)}>{t('Supprimer')}</button>
                    <button className="pill" onClick={() => setAConfirmer(null)}>{t('Annuler')}</button>
                  </span>
                : <button className="audio-suppr" aria-label={t('supprimer {nom}', { nom: nomCourt(m.nom) })} title={t('Supprimer ce son')} onClick={() => void supprimer(m.nom)}>✕</button>)}
            </div>
          ))}
          {erreur && <span className="texte-erreur">{erreur}</span>}
        </div>) : undefined}>
      <div className="segmente onglets-audio" role="tablist" aria-label={t('Studio audio')}>
        {ONGLETS.map(([o, l]) => <button key={o} role="tab" aria-selected={onglet === o} className={onglet === o ? 'on' : ''} onClick={() => choisir(o)}>{t(l)}</button>)}
      </div>
      {/* les trois studios restent montés : un formulaire garde sa saisie et son rendu en cours d'un onglet à l'autre */}
      <div hidden={onglet !== 'musique'}><StudioMusique surPret={charger} /></div>
      <div hidden={onglet !== 'voix'}><StudioVoix surPret={charger} /></div>
      <div hidden={onglet !== 'bruitage'}><StudioBruitage surPret={charger} /></div>
    </OutilPage>
  )
}
