/* ============================================================
   Studio son : une section de premier niveau, au rang d'Image et de Vidéo.
   Trois onglets (Musique, Dialogue et voix, Bruitages). À gauche le panneau
   de création (presets en cartes, champs essentiels, réglages avancés
   repliés, bouton collé en bas) ; à droite la zone des rendus avec trois
   vues : Résultats (file, progression, les deux prises côte à côte avec leur
   forme d'onde), Historique (tous les rendus passés du type, filtrables,
   avec leurs réglages) et Comment ça marche. Sur téléphone la zone des
   rendus passe au-dessus du formulaire.
   ============================================================ */
import { HowItWorks, howto } from './HowItWorks'
import { useMouvementReduit } from './Galerie'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLang, t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { useAppStore } from '../store/useAppStore'
import { LANGUES_CHANT, MESURES, VOIX_CHANTEES, codeTonalite } from '../data/presetsMusique'
import { useSuiviOutil } from './OutilPage'
import { LecteurOnde } from './Onde'
import { StudioBruitage, StudioMusique, corpsDe, type Lancer, type Recharge, type ReglagesAudio } from './StudioMusique'
import { StudioVoix, type RenduVoix } from './StudioVoix'

type Onglet = 'musique' | 'voix' | 'bruitage'
type Panneau = 'resultats' | 'historique' | 'comment'
type Son = { nom: string; duree: number }
type JobAudio = {
  id: string; createdAt: number; startedAt?: number | null; durationMs?: number | null; estimatedMs?: number | null
  status: string; error?: string | null; audio: ReglagesAudio
}
type JobBrut = Omit<JobAudio, 'audio'> & { audio?: ReglagesAudio; recipeId?: string; userPrompt?: string; composedPositive?: string }

const ONGLETS: [Onglet, string][] = [['musique', 'Musique'], ['voix', 'Dialogue et voix'], ['bruitage', 'Bruitages']]
const TEXTES: Record<Onglet, string> = {
  musique: 'Un morceau complet : style, instruments, tempo, tonalité, paroles et voix chantée. Deux prises à chaque fois.',
  voix: 'Fais parler une voix, clone ou change une voix, et donne sa voix à chaque personnage.',
  bruitage: 'Décris un son, c’est tout : il rejoint la bibliothèque audio, prêt pour le montage.',
}
const FINIS = ['done', 'failed', 'cancelled', 'blocked']
const urlSon = (n: string) => `/api/montage/musiques/${encodeURIComponent(n)}`
const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}(_\d)?\.\w+$/, '').replace(/\.\w+$/, '').replace(/^voix(clone|changee)?_/, '').replace(/_/g, ' ')
const quand = (ms: number) => !ms ? '' : new Date(ms).toLocaleString(getLang() === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const estMobile = () => window.innerWidth < 821

/** Serveur d'avant les réglages audio : le style vient du prompt, les prises de la bibliothèque (…_<6 car. de l'id>…). */
function deduire(j: JobBrut, sons: Son[]): ReglagesAudio {
  const marque = `_${String(j.id).slice(-6)}`
  const prises = j.status === 'done' ? sons.map(s => s.nom).filter(n => n.includes(`${marque}.`) || n.includes(`${marque}_`)).sort() : []
  const bruit = String(j.composedPositive ?? '').startsWith('sound effect, foley')
  return { genre: bruit ? 'bruitage' : 'musique', style: j.userPrompt ?? '', secondes: null, paroles: '', bpm: null, tonalite: null, mesure: null, langue: null, voix: null, instruments: [], prises }
}

/** Rendus musique et bruitage (GET /api/jobs?op=musique) et sons de la bibliothèque audio, suivis tant qu'un rendu tourne. */
function useDonneesSon() {
  const [jobs, setJobs] = useState<JobAudio[] | null>(null)
  const [biblio, setBiblio] = useState<Son[]>([])
  const charger = useCallback(async () => {
    const [dj, dm] = await Promise.all([
      fetch('/api/jobs?op=musique&limit=300').then(r => r.json()).catch(() => null) as Promise<{ jobs?: JobBrut[] } | null>,
      fetch('/api/montage/musiques').then(r => r.json()).catch(() => null) as Promise<{ musiques?: Son[] } | null>,
    ])
    const sons = dm?.musiques ?? []
    setBiblio(sons)
    if (dj) setJobs((dj.jobs ?? []).filter(j => j.audio || j.recipeId === 'musique@v1').map(j => ({ ...j, audio: j.audio ?? deduire(j, sons) })))
  }, [])
  const actifs = !!jobs?.some(j => !FINIS.includes(j.status))
  useEffect(() => { void charger() }, [charger])
  useEffect(() => {
    const iv = window.setInterval(() => void charger(), actifs ? 3000 : 20000)
    return () => window.clearInterval(iv)
  }, [actifs, charger])
  return { jobs, biblio, charger }
}

/** Répliques rendues depuis ce navigateur, avec leurs réglages (la synthèse est immédiate, sans job). */
function useVoixRendues() {
  const lire = (): RenduVoix[] => { try { return JSON.parse(localStorage.getItem('son:voix') ?? '[]') } catch { return [] } }
  const [liste, setListe] = useState<RenduVoix[]>(lire)
  const ajouter = (r: RenduVoix) => setListe(l => {
    const n = [r, ...l.filter(x => x.nom !== r.nom)].slice(0, 300)
    try { localStorage.setItem('son:voix', JSON.stringify(n)) } catch { /* stockage indisponible */ }
    return n
  })
  return { liste, ajouter }
}

/** Retire des sons de la bibliothèque ; un son employé au montage demande une confirmation (409). */
async function retirer(noms: string[], confirme: boolean): Promise<{ usages: string[]; erreur: string | null }> {
  const usages: string[] = []
  for (const nom of noms) {
    const r = await fetch(`${urlSon(nom)}${confirme ? '?confirme=1' : ''}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({})) as { usages?: string[]; error?: string }
    if (r.status === 409) { usages.push(...(d.usages ?? [])); continue }
    if (!r.ok) return { usages, erreur: tServeur(d.error ?? null) ?? `HTTP ${r.status}` }
  }
  return { usages: [...new Set(usages)], erreur: null }
}

/** Bouton Supprimer en deux temps (et un troisième si le son sert dans un montage). */
function Suppression({ noms, apres }: { noms: string[]; apres: () => void }) {
  const [etat, setEtat] = useState<null | 'confirmer' | { usages: string[] }>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const go = async (confirme: boolean) => {
    setErreur(null)
    const r = await retirer(noms, confirme)
    if (r.erreur) { setErreur(r.erreur); return }
    if (r.usages.length && !confirme) { setEtat({ usages: r.usages }); return }
    setEtat(null); apres()
  }
  if (!noms.length) return null
  if (!etat) return <button className="pill tool son-danger" onClick={() => setEtat('confirmer')}>{t('Supprimer')}</button>
  return (
    <span className="son-confirme">
      <span>{etat === 'confirmer' ? (noms.length > 1 ? t('Supprimer les {n} prises ?', { n: noms.length }) : t('Supprimer ce son ?')) : t('Employé par : {l}. Le retirer quand même ?', { l: etat.usages.join(', ') })}</span>
      <button className="pill tool son-danger" onClick={() => void go(etat !== 'confirmer')}>{t('Supprimer')}</button>
      <button className="pill tool" onClick={() => setEtat(null)}>{t('Annuler')}</button>
      {erreur && <span className="texte-erreur">{erreur}</span>}
    </span>
  )
}

/** Les réglages d'un rendu, en puces lisibles. */
function Reglages({ a }: { a: ReglagesAudio }) {
  const puces: string[] = []
  if (a.secondes) puces.push(`${a.secondes} s`)
  if (a.genre === 'musique') {
    const v = VOIX_CHANTEES.find(([x]) => x === a.voix)?.[1]
    puces.push(v ? t(v) : t('voix auto'))
    puces.push(a.bpm ? `${a.bpm} BPM` : t('tempo auto'))
    puces.push(a.tonalite ? codeTonalite(a.tonalite) : t('tonalité auto'))
    if (a.mesure) puces.push(MESURES.find(([m]) => m === a.mesure)?.[1] ?? a.mesure)
    if (a.langue) puces.push(LANGUES_CHANT.find(([c]) => c === a.langue)?.[1] ?? a.langue)
    puces.push(...(a.instruments ?? []))
  }
  return <span className="puces-sous">{puces.map((p, i) => <em key={`${p}-${i}`}>{p}</em>)}</span>
}

/** Rang dans la file ou avancement du rendu (progression ComfyUI, sinon le temps écoulé sur l'estimation). */
function Avancement({ j }: { j: JobAudio }) {
  const sj = useAppStore(st => st.jobs.find(x => x.id === j.id))
  const [, tic] = useState(0)
  useEffect(() => { const iv = window.setInterval(() => tic(n => n + 1), 1000); return () => window.clearInterval(iv) }, [])
  const statut = String(sj?.status ?? j.status)
  const enFile = statut === 'queued' || statut === 'queued-comfy'
  const debut = sj?.startedAt ?? j.startedAt
  const est = sj?.estimatedMs ?? j.estimatedMs ?? 60_000
  const parTemps = debut ? Math.min(0.95, (Date.now() - debut) / est) : 0
  const pct = enFile ? 0 : sj?.progress && sj.progress.max > 0 ? Math.max(parTemps, sj.progress.value / sj.progress.max) : parTemps
  const reste = debut ? Math.max(0, Math.round((est - (Date.now() - debut)) / 1000)) : Math.round(est / 1000)
  return (
    <div className="son-avancement">
      <span className="son-statut">
        <i className={enFile ? 'attente' : 'calcul'} />
        {enFile ? (sj?.file ? t('En file · position {n}', { n: sj.file.rang }) : t('En file')) : t('Rendu en cours · {p} %', { p: Math.round(pct * 100) })}
        <span className="texte-faible">{enFile ? t('environ {n} s une fois lancé', { n: Math.round(est / 1000) }) : reste > 0 ? t('encore environ {n} s', { n: reste }) : t('finition…')}</span>
      </span>
      <span className="son-barre"><span style={{ width: `${Math.round(pct * 100)}%` }} /></span>
    </div>
  )
}

type Actions = { onRegen: (a: ReglagesAudio) => void; onReprendre: (a: ReglagesAudio) => void; onMontage?: () => void; apres: () => void }

/** Un rendu musique ou bruitage : titre, réglages, état, les prises côte à côte, les actions. */
function CarteRendu({ j, durees, compact, actions }: { j: JobAudio; durees: Map<string, number>; compact?: boolean; actions: Actions }) {
  const edition = useEdition()
  const a = j.audio
  const actif = !FINIS.includes(j.status)
  const titre = a.style.trim() ? (a.style.length > 90 ? `${a.style.slice(0, 88)}…` : a.style) : a.genre === 'bruitage' ? t('Bruitage') : t('Morceau')
  return (
    <article className={`son-carte ${compact ? 'compacte' : ''} ${actif ? 'active' : ''}`}>
      <header>
        <span className="son-genre">{a.genre === 'bruitage' ? t('Bruitage') : t('Musique')}</span>
        <b className="son-titre" title={a.style}>{titre}</b>
        <span className="texte-faible son-date">{quand(j.createdAt)}</span>
      </header>
      <Reglages a={a} />
      {actif && <Avancement j={j} />}
      {!actif && j.status !== 'done' && <span className="texte-erreur">{j.status === 'cancelled' ? t('Rendu annulé.') : tServeur(j.error ?? null) ?? t('échec')}</span>}
      {j.status === 'done' && (a.prises.length
        ? <div className="son-prises">
            {a.prises.map((n, i) => (
              <div key={n} className="son-prise">
                <span className="son-prise-tete"><b>{t('Prise {n}', { n: i + 1 })}</b>
                  <a className="son-dl" href={urlSon(n)} download={n} title={t('Télécharger')} aria-label={t('Télécharger la prise {n}', { n: i + 1 })}>
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 2v8m0 0L4.5 6.5M8 10l3.5-3.5M3 13h10" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </a></span>
                <LecteurOnde src={urlSon(n)} duree={durees.get(n)} compact={compact} />
              </div>
            ))}
          </div>
        : <span className="texte-faible">{t('Prises retirées de la bibliothèque audio.')}</span>)}
      {a.paroles.trim() && <details className="son-paroles"><summary>{t('Paroles')}</summary><pre>{a.paroles}</pre></details>}
      {!actif && <footer>
        {j.status === 'done' && a.prises.length > 0 && actions.onMontage && <button className="pill tool" onClick={actions.onMontage} title={t('Les prises sont déjà dans les musiques du montage')}>{t('Utiliser au montage')}</button>}
        <button className="pill tool" onClick={() => actions.onRegen(a)} title={t('Relance avec exactement les mêmes réglages (nouvelles graines)')}>{t('Régénérer')}</button>
        <button className="pill tool" onClick={() => actions.onReprendre(a)}>{t('Reprendre les réglages')}</button>
        {edition && j.status === 'done' && <Suppression noms={a.prises} apres={actions.apres} />}
      </footer>}
    </article>
  )
}

/** Une réplique rendue (voix du studio, clonée ou changée). */
function CarteVoix({ r, durees, compact, onRedire, onMontage, apres }: { r: RenduVoix; durees: Map<string, number>; compact?: boolean; onRedire?: (r: RenduVoix) => void; onMontage?: () => void; apres: () => void }) {
  const edition = useEdition()
  const modes = { dire: 'Réplique', cloner: 'Voix clonée', changer: 'Voix changée' } as const
  return (
    <article className={`son-carte ${compact ? 'compacte' : ''}`}>
      <header>
        <span className="son-genre">{t(modes[r.mode])}</span>
        <b className="son-titre" title={r.texte}>{r.texte ? `“${r.texte.length > 120 ? `${r.texte.slice(0, 118)}…` : r.texte}”` : nomCourt(r.nom)}</b>
        <span className="texte-faible son-date">{quand(r.at)}</span>
      </header>
      {r.voixNom && <span className="puces-sous"><em>{r.voixNom}</em>{durees.get(r.nom) ? <em>{Math.round(durees.get(r.nom)!)} s</em> : null}</span>}
      <div className="son-prises une">
        <div className="son-prise">
          <span className="son-prise-tete"><b>{t('Voix')}</b>
            <a className="son-dl" href={urlSon(r.nom)} download={r.nom} title={t('Télécharger')} aria-label={t('Télécharger')}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 2v8m0 0L4.5 6.5M8 10l3.5-3.5M3 13h10" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </a></span>
          <LecteurOnde src={urlSon(r.nom)} duree={durees.get(r.nom)} compact={compact} />
        </div>
      </div>
      <footer>
        {onMontage && <button className="pill tool" onClick={onMontage}>{t('Utiliser au montage')}</button>}
        {onRedire && r.texte && r.mode !== 'changer' && r.voix && <button className="pill tool" onClick={() => onRedire(r)}>{t('Régénérer')}</button>}
        {edition && <Suppression noms={[r.nom]} apres={apres} />}
      </footer>
    </article>
  )
}

/** « Comment ça marche » : une courte explication par onglet. */
const AIDE: Record<Onglet, { titre: string; texte: string }[]> = {
  musique: [
    { titre: 'Ce que fait le modèle', texte: 'ACE-Step 1.5 compose un morceau complet d’après une description : instruments, structure, voix chantée et paroles, mixés ensemble.' },
    { titre: 'Écrire le style', texte: 'Quelques mots-clés en anglais, séparés par des virgules : genre, ambiance, instruments, époque. Ex. « warm lo-fi hip hop, mellow, rhodes piano, vinyl crackle ». Un preset remplit tout d’un clic.' },
    { titre: 'Écrire les paroles', texte: 'Une section par balise : [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro]. Des lignes courtes chantent mieux. Sans paroles, ou avec la voix « Aucune », le morceau est instrumental. La langue est reconnue d’après les paroles.' },
    { titre: 'Durée et temps de rendu', texte: 'De 10 à 120 s. Une fois lancées, les deux prises sortent en général en moins d’une minute ; le rendu attend d’abord son tour dans la file du studio, une seule carte graphique pour tous.' },
    { titre: 'Deux prises', texte: 'Chaque demande rend deux prises aux mêmes réglages, avec des graines différentes : garde la meilleure, supprime l’autre. « Régénérer » en relance deux nouvelles.' },
    { titre: 'Réglages avancés', texte: 'Tempo, tonalité, mesure et langue restent sur auto : le studio les déduit du style. Fixe-les pour caler un morceau sur un montage.' },
  ],
  voix: [
    { titre: 'Dire une réplique', texte: 'Kokoro-82M lit ton texte avec une voix du studio, en quelques secondes et sans file d’attente. Écris en anglais, avec la ponctuation que tu veux entendre.' },
    { titre: 'Cloner une voix', texte: 'Chatterbox reprend le timbre d’un extrait de 5 à 20 s de la bibliothèque audio. Seulement ta voix, ou celle d’une personne qui a donné son accord. Réservé au propriétaire du studio.' },
    { titre: 'Changer une voix', texte: 'Un enregistrement ou la piste d’un clip est redit par une autre voix : les mots, le rythme et les pauses restent, seul le timbre change.' },
    { titre: 'Voix des personnages', texte: 'Rattache une voix à chaque personnage : le reel (voix off) et l’avatar parlant la reprennent.' },
  ],
  bruitage: [
    { titre: 'Ce que fait le modèle', texte: 'ACE-Step 1.5 rend un bruitage seul, sans musique ni voix, d’après une description.' },
    { titre: 'Bien décrire un son', texte: 'Un seul son, concret : la source, la matière, le lieu, la distance. Ex. « a glass bottle shattering on a stone floor ». En anglais.' },
    { titre: 'Durée et prises', texte: 'De 2 à 20 s, deux prises à chaque fois, prêtes en moins d’une minute une fois lancées.' },
    { titre: 'Au montage', texte: 'Les bruitages rejoignent la bibliothèque audio : le montage et le reel les proposent avec les musiques.' },
  ],
}
const LICENCES: Record<Onglet, string> = {
  musique: 'ACE-Step 1.5 · licence MIT · poids ouverts, sur ta carte graphique.',
  voix: 'Kokoro-82M · licence Apache-2.0 · clonage et changement de voix : Chatterbox · licence MIT.',
  bruitage: 'ACE-Step 1.5 · licence MIT · poids ouverts, sur ta carte graphique.',
}

export function SonView({ goMontage }: { goMontage?: () => void }) {
  const onglet = useAppStore(st => st.ongletAudio)
  const reduitHowto = useMouvementReduit()
  const choisir = (o: Onglet) => useAppStore.setState({ ongletAudio: o })
  const [panneau, setPanneau] = useState<Panneau>('resultats')
  const { jobs, biblio, charger } = useDonneesSon()
  const suivi = useSuiviOutil('son')
  const voix = useVoixRendues()
  const [recharge, setRecharge] = useState<Recharge>(null)
  const zoneRendus = useRef<HTMLDivElement>(null)
  const zoneForm = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [filtre, setFiltre] = useState<'tout' | 'ok' | 'echec' | 'instru' | 'chant'>('tout')
  const [nbHisto, setNbHisto] = useState(30)
  const [erreurAction, setErreurAction] = useState<string | null>(null)
  useEffect(() => { setNbHisto(30) }, [onglet, q, filtre])

  const durees = useMemo(() => new Map(biblio.map(s => [s.nom, s.duree])), [biblio])
  const montrerRendus = () => { setPanneau('resultats'); if (estMobile()) requestAnimationFrame(() => zoneRendus.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }

  const lancer: Lancer = async corps => {
    const r = await fetch('/api/musique', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) return tServeur(d.error ?? null) ?? `HTTP ${r.status}`
    suivi.ajouter([d.jobId])
    // la carte « en cours » du studio suit aussi le rendu (îlot de rendu, onglet du navigateur)
    void useAppStore.getState().adoptServerJob(d.jobId)
    void charger(); montrerRendus()
    return null
  }
  const actions: Actions = {
    onRegen: a => { setErreurAction(null); void lancer(corpsDe(a)).then(e => setErreurAction(e)) },
    onReprendre: a => {
      choisir(a.genre); setRecharge(rc => ({ nonce: (rc?.nonce ?? 0) + 1, r: a }))
      if (estMobile()) requestAnimationFrame(() => zoneForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    },
    onMontage: goMontage,
    apres: () => void charger(),
  }
  const surVoix = (r?: RenduVoix) => { void charger(); if (r) { voix.ajouter(r); montrerRendus() } }
  const redire = async (r: RenduVoix) => {
    setErreurAction(null)
    const [url, corps] = r.voix.startsWith('clone:') ? ['/api/voix/clone', { texte: r.texte, reference: r.voix.slice(6), accord: true }] : ['/api/voix', { texte: r.texte, voix: r.voix }]
    const rep = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await rep.json().catch(() => ({})) as { nom?: string; error?: string }
    if (!rep.ok || !d.nom) { setErreurAction(tServeur(d.error ?? null) ?? `HTTP ${rep.status}`); return }
    surVoix({ ...r, nom: d.nom, at: Date.now() })
  }

  // musique et bruitages : la file (tous les rendus en cours), puis ceux lancés depuis ce navigateur
  const duGenre = (jobs ?? []).filter(j => j.audio.genre === onglet)
  const enCours = duGenre.filter(j => !FINIS.includes(j.status))
  const miens = duGenre.filter(j => FINIS.includes(j.status) && suivi.ids.has(j.id)).slice(0, 8)
  // sur téléphone la zone des rendus est au-dessus du formulaire : on y garde peu de cartes
  const derniers = (miens.length ? miens : duGenre.filter(j => j.status === 'done').slice(0, 4)).slice(0, estMobile() ? (miens.length ? 2 : 1) : 8)
  // voix : les répliques de ce navigateur, puis les autres voix de la bibliothèque (sans leurs réglages)
  const voixHisto = useMemo(() => {
    const presentes = new Set(biblio.map(s => s.nom))
    const connues = voix.liste.filter(r => presentes.has(r.nom))
    const vus = new Set(connues.map(r => r.nom))
    const autres: RenduVoix[] = biblio.filter(s => /^voix/.test(s.nom) && !vus.has(s.nom)).map(s => ({
      nom: s.nom, texte: '', voix: '', voixNom: '', at: 0,
      mode: s.nom.startsWith('voixclone') ? 'cloner' : s.nom.startsWith('voixchangee') ? 'changer' : 'dire',
    }))
    return [...connues, ...autres]
  }, [biblio, voix.liste])
  const voixRecentes = voixHisto.filter(r => r.at > 0).slice(0, estMobile() ? 2 : 8)

  const cherche = q.trim().toLowerCase()
  const histoJobs = duGenre.filter(j => {
    if (filtre === 'ok' && j.status !== 'done') return false
    if (filtre === 'echec' && (j.status === 'done' || !FINIS.includes(j.status))) return false
    if (filtre === 'instru' && !(j.audio.voix === 'none' || !j.audio.paroles.trim())) return false
    if (filtre === 'chant' && (j.audio.voix === 'none' || !j.audio.paroles.trim())) return false
    return !cherche || `${j.audio.style} ${j.audio.paroles} ${j.audio.instruments.join(' ')}`.toLowerCase().includes(cherche)
  })
  const histoVoix = voixHisto.filter(r => !cherche || `${r.texte} ${r.voixNom} ${r.nom}`.toLowerCase().includes(cherche))
  const nbHistorique = onglet === 'voix' ? histoVoix.length : histoJobs.length
  const filtres: [typeof filtre, string][] = onglet === 'musique'
    ? [['tout', 'Tout'], ['ok', 'Terminés'], ['echec', 'Échecs'], ['instru', 'Instrumentaux'], ['chant', 'Chantés']]
    : onglet === 'bruitage' ? [['tout', 'Tout'], ['ok', 'Terminés'], ['echec', 'Échecs']] : []

  const resultats = onglet === 'voix'
    ? (voixRecentes.length
        ? <div className="son-liste">{voixRecentes.map(r => <CarteVoix key={r.nom} r={r} durees={durees} onRedire={x => void redire(x)} onMontage={goMontage} apres={() => void charger()} />)}</div>
        : <div className="son-vide"><b>{t('Tes répliques apparaîtront ici.')}</b><span>{t('Tape une phrase, choisis une voix : la voix est prête en quelques secondes.')}</span></div>)
    : (enCours.length || derniers.length
        ? <div className="son-liste">
            {enCours.length > 0 && <div className="son-section">{t('File du studio')} <span>{enCours.length}</span></div>}
            {enCours.map(j => <CarteRendu key={j.id} j={j} durees={durees} actions={actions} />)}
            {derniers.length > 0 && <div className="son-section">{miens.length ? t('Tes derniers rendus') : t('Derniers rendus du studio')}</div>}
            {derniers.map(j => <CarteRendu key={j.id} j={j} durees={durees} actions={actions} />)}
          </div>
        : <div className="son-vide"><b>{jobs === null ? t('chargement…') : onglet === 'musique' ? t('Rien pour l’instant : génère ton premier morceau.') : t('Rien pour l’instant : décris ton premier bruitage.')}</b>
            <span>{t('Chaque demande rend deux prises, affichées ici avec leur forme d’onde.')}</span></div>)

  return (
    <div className="son-page">
      <div className="son-tete">
        <div className="son-titres">
          <h2>{t('Studio son')}</h2>
          <span className="texte-doux">{t(TEXTES[onglet])}</span>
        </div>
        <div className="segmente onglets-audio" role="tablist" aria-label={t('Studio audio')}>
          {ONGLETS.map(([o, l]) => <button key={o} role="tab" aria-selected={onglet === o} className={onglet === o ? 'on' : ''} onClick={() => choisir(o)}>{t(l)}</button>)}
        </div>
      </div>
      <div className="son-corps">
        <aside ref={zoneForm} className="son-volet" aria-label={t('Créer')}>
          {/* les trois studios restent montés : un formulaire garde sa saisie d'un onglet à l'autre */}
          <div hidden={onglet !== 'musique'}><StudioMusique lancer={lancer} aCharger={recharge} /></div>
          <div hidden={onglet !== 'voix'}><StudioVoix surPret={surVoix} /></div>
          <div hidden={onglet !== 'bruitage'}><StudioBruitage lancer={lancer} aCharger={recharge} /></div>
        </aside>
        <section ref={zoneRendus} className="son-resultats" aria-label={t('Rendus')}>
          {onglet === 'musique' && (() => {
            const f = howto('musique')
            return <HowItWorks cleMemoire="hiw:musique" reduit={reduitHowto} labelHero={t('Exemple de morceau généré')}
              titre={t('Ton morceau, du style à la piste finie')} texte={t('Décris le style, ajoute des paroles si tu veux : ACE-Step compose deux prises en moins d’une minute, chantées ou instrumentales.')}
              hero={f.hero} labelCommencer={t('Commencer')}
              onCommencer={() => zoneForm.current?.querySelector<HTMLElement>('textarea, input')?.focus()}
              etapes={[
                { titre: t('Décris le style'), texte: t('Genre, ambiance, instruments, en anglais : « epic cinematic orchestral trailer ».'), ...f.etape(1) },
                { titre: t('Ajoute des paroles'), texte: t('Facultatif : une section par balise, [Verse], [Chorus]. Sans paroles, le morceau est instrumental.'), ...f.etape(2) },
                { titre: t('Choisis ta prise'), texte: t('Deux prises aux mêmes réglages : garde la meilleure, elle rejoint le montage.'), ...f.hero },
              ]} />
          })()}
          <div className="outil-onglets" role="tablist">
            <button role="tab" aria-selected={panneau === 'resultats'} className={panneau === 'resultats' ? 'on' : ''} onClick={() => setPanneau('resultats')}>
              {t('Résultats')}{onglet !== 'voix' && enCours.length > 0 && <em className="son-compte">{enCours.length}</em>}</button>
            <button role="tab" aria-selected={panneau === 'historique'} className={panneau === 'historique' ? 'on' : ''} onClick={() => setPanneau('historique')}>
              {t('Historique')}<span className="son-nb">{nbHistorique}</span></button>
            <button role="tab" aria-selected={panneau === 'comment'} className={panneau === 'comment' ? 'on' : ''} onClick={() => setPanneau('comment')}>{t('Comment ça marche')}</button>
          </div>
          {erreurAction && <span className="texte-erreur">{erreurAction}</span>}
          {panneau === 'resultats' && resultats}
          {panneau === 'historique' && <>
            <div className="son-filtres">
              <input className="champ" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={onglet === 'voix' ? t('Chercher une réplique, une voix…') : t('Chercher un style, des paroles, un instrument…')} aria-label={t('Chercher')} />
              {filtres.length > 0 && <div className="puces">{filtres.map(([f, l]) => <button key={f} className={`puce ${filtre === f ? 'on' : ''}`} aria-pressed={filtre === f} onClick={() => setFiltre(f)}>{t(l)}</button>)}</div>}
            </div>
            {nbHistorique === 0
              ? <div className="son-vide"><b>{cherche || filtre !== 'tout' ? t('Aucun rendu ne correspond.') : t('Aucun rendu pour l’instant.')}</b></div>
              : <div className="son-liste">
                  {onglet === 'voix'
                    ? histoVoix.slice(0, nbHisto).map(r => <CarteVoix key={r.nom} r={r} durees={durees} compact onRedire={x => void redire(x)} onMontage={goMontage} apres={() => void charger()} />)
                    : histoJobs.slice(0, nbHisto).map(j => <CarteRendu key={j.id} j={j} durees={durees} compact actions={actions} />)}
                  {nbHistorique > nbHisto && <button className="pill tool" style={{ justifySelf: 'center' }} onClick={() => setNbHisto(n => n + 30)}>{t('Afficher plus ({n} restants)', { n: nbHistorique - nbHisto })}</button>}
                </div>}
          </>}
          {panneau === 'comment' && <div className="son-aide">
            <div className="outil-etapes">
              {AIDE[onglet].map((e, i) => (
                <div key={e.titre} className="outil-etape"><i>{i + 1}</i><b>{t(e.titre)}</b><span>{t(e.texte)}</span></div>
              ))}
            </div>
            <span className="texte-faible son-licence">{t(LICENCES[onglet])}</span>
          </div>}
        </section>
      </div>
    </div>
  )
}
