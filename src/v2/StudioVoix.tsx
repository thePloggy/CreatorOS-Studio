/* Studio dialogue et voix : faire dire une phrase (voix du studio, voix clonée, voix d'un
   personnage), cloner une voix, changer la voix d'un audio ou d'un clip, et rattacher une voix
   à chaque personnage CreatorOS (champ voix du personnage, repris par le reel et l'avatar parlant).
   Clonage, changement et rattachement sont réservés au propriétaire du studio. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { nomMedia } from '../lib/nomMedia'
import { useAppStore } from '../store/useAppStore'
import { Ic } from './bits'
import { Ecouter, urlEchantillonVoix, urlMusique } from './Ecouter'

type Mode = 'dire' | 'cloner' | 'changer' | 'personnages'
type Voix = { id: string; nom: string }
type Perso = { id: string; name: string; voix?: string | null }
const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')
const poster = (url: string, corps: object, methode = 'POST') => fetch(url, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })

/** Voix du studio, voix clonées possibles (propriétaire) et extraits de la bibliothèque audio. */
function useCatalogueVoix(cle: number) {
  const [etat, setEtat] = useState<{ voix: Voix[]; clones: Voix[]; disponible: boolean; clone: boolean }>({ voix: [], clones: [], disponible: true, clone: false })
  const [extraits, setExtraits] = useState<string[]>([])
  useEffect(() => {
    void fetch('/api/voix').then(r => r.json()).then((d: { disponible?: boolean; voix?: Voix[]; clones?: Voix[]; clone?: boolean }) =>
      setEtat({ voix: d.voix ?? [], clones: d.clones ?? [], disponible: !!d.disponible, clone: !!d.clone })).catch(() => {})
    void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string }[] }) => setExtraits((d.musiques ?? []).map(m => m.nom))).catch(() => {})
  }, [cle])
  return { ...etat, extraits }
}

/** Libellé d'une voix rattachable (studio ou clonée). */
const libelleVoix = (id: string | null | undefined, voix: Voix[]) =>
  !id ? t('aucune') : id.startsWith('clone:') ? `${t('voix clonée')} · ${nomCourt(id.slice(6))}` : voix.find(v => v.id === id)?.nom ?? id

/** Choix d'une voix : studio, puis voix clonées (propriétaire), puis voix des personnages. */
function SelectVoix({ valeur, onChange, voix, clones, persos }: { valeur: string; onChange: (v: string) => void; voix: Voix[]; clones: Voix[]; persos?: Perso[] }) {
  const avecVoix = (persos ?? []).filter(p => p.voix)
  // écouter la voix choisie : un échantillon court, rendu une fois par le serveur
  const ecoute = useRef<HTMLAudioElement | null>(null)
  const [joue, setJoue] = useState(false)
  const id = valeur.startsWith('perso:') ? (persos ?? []).find(p => `perso:${p.id}` === valeur)?.voix ?? '' : valeur
  const ecouter = () => {
    if (joue) { ecoute.current?.pause(); setJoue(false); return }
    if (!id || id.startsWith('clone:')) return
    const a = new Audio(`/api/voix/${encodeURIComponent(id)}/echantillon`); ecoute.current = a
    a.onended = () => setJoue(false); a.onerror = () => setJoue(false)
    setJoue(true); void a.play().catch(() => setJoue(false))
  }
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 1 }}>
    <select className="champ" value={valeur} onChange={e => onChange(e.target.value)} aria-label={t('Voix')} style={{ minWidth: 0, flex: 1 }}>
        <optgroup label={t('Voix du studio')}>{voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}</optgroup>
        {clones.length > 0 && <optgroup label={t('Voix clonée (extrait de ta bibliothèque audio)')}>{clones.map(v => <option key={v.id} value={v.id}>{nomCourt(v.nom)}</option>)}</optgroup>}
        {avecVoix.length > 0 && <optgroup label={t('Voix des personnages')}>{avecVoix.map(p => <option key={p.id} value={`perso:${p.id}`}>{p.name} ({libelleVoix(p.voix, voix)})</option>)}</optgroup>}
      </select>
        <button type="button" className={`pill ${joue ? 'used' : ''}`} onClick={ecouter} disabled={!id || id.startsWith('clone:')}
        title={t('écouter un court échantillon de cette voix')} aria-label={t('Écouter la voix')}><Ic n={joue ? 'x' : 'play'} s={12} /> {joue ? t('Stop') : t('Écouter')}</button>
    </span>
  )
}

/** Une réplique rendue : le studio son la pose dans ses résultats et son historique. */
export type RenduVoix = { nom: string; texte: string; voix: string; voixNom: string; mode: 'dire' | 'cloner' | 'changer'; at: number }

export function StudioVoix({ surPret }: { surPret: (r?: RenduVoix) => void }) {
  const edition = useEdition()
  const [cle, setCle] = useState(0)
  const { voix, clones, disponible, clone, extraits } = useCatalogueVoix(cle)
  const [mode, setMode] = useState<Mode>(() => { const d = useAppStore.getState().demandeOutil; return d === 'cloner' || d === 'changer' ? d : 'dire' })
  // le menu Audio ouvre directement le clonage ou le changement de voix
  const demande = useAppStore(st => st.demandeOutil)
  useEffect(() => { if (demande === 'cloner' || demande === 'changer') { setMode(demande); useAppStore.setState({ demandeOutil: null }) } }, [demande])
  const [persos, setPersos] = useState<Perso[]>([])
  const chargerPersos = () => void fetch('/api/personas').then(r => r.json()).then((d: { personas?: Perso[] }) => setPersos(d.personas ?? [])).catch(() => {})
  useEffect(chargerPersos, [])

  const [texte, setTexte] = useState('')
  const [choix, setChoix] = useState('af_heart')
  const [ref, setRef] = useState('')
  const [accord, setAccord] = useState(false)
  const [source, setSource] = useState('')       // « audio:<nom> » ou « clip:<assetId> »
  const [cible, setCible] = useState('af_heart') // voix du studio ou « extrait:<nom> »
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [erreur, setErreur] = useState(false)
  useEffect(() => { if (!ref && extraits[0]) setRef(extraits[0]); if (!source && extraits[0]) setSource(`audio:${extraits[0]}`) }, [extraits]) // eslint-disable-line react-hooks/exhaustive-deps
  const assets = useAppStore(st => st.assets)
  const clips = useMemo(() => assets.filter(a => String(a.mediaType) === 'video').slice(0, 40), [assets])

  // « perso:<id> » se résout en la voix rattachée au personnage
  const voixReelle = (v: string) => v.startsWith('perso:') ? persos.find(p => p.id === v.slice(6))?.voix ?? '' : v
  const nomVoix = (v: string) => v.startsWith('clone:') ? `${t('voix clonée')} · ${nomCourt(v.slice(6))}` : v.startsWith('extrait:') ? `${t('voix clonée')} · ${nomCourt(v.slice(8))}` : voix.find(x => x.id === v)?.nom ?? v
  const fin = (r: Response, d: { error?: string; nom?: string }, info?: Omit<RenduVoix, 'nom' | 'at'>) => {
    setOccupe(false)
    if (!r.ok) { setErreur(true); setMsg(tServeur(d.error ?? null) ?? `HTTP ${r.status}`); return false }
    // le rendu s'affiche dans la zone des résultats du studio son
    surPret(d.nom && info ? { ...info, nom: d.nom, at: Date.now() } : undefined); setCle(c => c + 1); return true
  }
  const dire = async () => {
    setOccupe(true); setMsg(null); setErreur(false)
    const v = voixReelle(choix)
    const r = v.startsWith('clone:') ? await poster('/api/voix/clone', { texte, reference: v.slice(6), accord: true }) : await poster('/api/voix', { texte, voix: v })
    if (fin(r, await r.json().catch(() => ({})), { texte, voix: v, voixNom: nomVoix(v), mode: 'dire' })) setTexte('')
  }
  const cloner = async () => {
    setOccupe(true); setMsg(null); setErreur(false)
    const r = await poster('/api/voix/clone', { texte, reference: ref, accord })
    if (fin(r, await r.json().catch(() => ({})), { texte, voix: `clone:${ref}`, voixNom: nomVoix(`clone:${ref}`), mode: 'cloner' })) setTexte('')
  }
  const changer = async () => {
    setOccupe(true); setMsg(null); setErreur(false)
    const versCible = cible.startsWith('extrait:') ? { reference: cible.slice(8), accord } : { voix: cible }
    const corps = source.startsWith('clip:') ? { assetId: source.slice(5), ...versCible } : { audio: source.slice(6), ...versCible }
    const r = await poster('/api/voix/changer', corps)
    const d = await r.json().catch(() => ({})) as { error?: string; nom?: string; jobId?: string }
    // un clip revoisé devient un nouveau clip de la bibliothèque
    if (fin(r, d, { texte: source.startsWith('clip:') ? '' : nomCourt(source.slice(6)), voix: cible, voixNom: nomVoix(cible), mode: 'changer' }) && d.jobId) { void useAppStore.getState().adoptServerJob(d.jobId); setMsg(t('Nouveau clip dans la bibliothèque, avec la voix changée.')) }
  }

  const onglets: [Mode, string][] = [['dire', 'Dire une réplique'], ...(edition && clone ? [['cloner', 'Cloner une voix'], ['changer', 'Changer une voix']] as [Mode, string][] : []), ...(edition ? [['personnages', 'Voix des personnages']] as [Mode, string][] : [])]
  if (!disponible) return <span className="texte-doux">{t('Voix non installée sur ce studio.')}</span>
  const cibleExtrait = mode === 'changer' && cible.startsWith('extrait:')
  const accordRequis = mode === 'cloner' || cibleExtrait

  return (
    <div className="studio-audio">
      {onglets.length > 1 && <div className="flex gap-1.5 flex-wrap">
        {onglets.map(([m, l]) => <button key={m} className={`pill tool ${mode === m ? 'on' : ''}`} onClick={() => { setMode(m); setMsg(null) }}>{t(l)}</button>)}
      </div>}

      {mode === 'dire' && <>
        <label className="studio-champ"><span className="etiquette">{t('Réplique')}</span>
          <textarea className="champ" value={texte} onChange={e => setTexte(e.target.value)} maxLength={1200} rows={4} placeholder={t('Le texte à dire, en anglais')} /></label>
        <span className="flex gap-1.5 items-center">
          <SelectVoix valeur={choix} onChange={setChoix} voix={voix} clones={edition ? clones : []} persos={edition ? persos : persos.filter(p => p.voix && !p.voix.startsWith('clone:'))} />
          <Ecouter src={(() => { const v = voixReelle(choix); return v.startsWith('clone:') ? urlMusique(v.slice(6)) : urlEchantillonVoix(v) })()} titre={t('Écouter la voix')} />
        </span>
        <button className="pill" style={{ justifyContent: 'center' }} disabled={occupe || !texte.trim() || !voixReelle(choix)} onClick={() => void dire()}>{occupe ? t('synthèse…') : t('Générer la voix')}</button>
        <span className="texte-faible">Kokoro-82M · Apache-2.0{edition && clone ? ' · Chatterbox · MIT' : ''}</span>
      </>}

      {mode === 'cloner' && <>
        <label className="studio-champ"><span className="etiquette">{t('Extrait de référence (5 à 20 s)')}</span>
          <span className="flex gap-1.5 items-center">
            <select className="champ" value={ref} onChange={e => setRef(e.target.value)} style={{ minWidth: 0, flex: 1 }}>{extraits.map(n => <option key={n} value={n}>{nomCourt(n)}</option>)}</select>
            <Ecouter src={urlMusique(ref)} titre={t('Écouter la voix')} />
          </span></label>
        <label className="studio-champ"><span className="etiquette">{t('Réplique')}</span>
          <textarea className="champ" value={texte} onChange={e => setTexte(e.target.value)} maxLength={800} rows={3} placeholder={t('Le texte à dire, en anglais')} /></label>
      </>}

      {mode === 'changer' && <>
        <label className="studio-champ"><span className="etiquette">{t('Enregistrement à transformer')}</span>
          <select className="champ" value={source} onChange={e => setSource(e.target.value)}>
            <optgroup label={t('Bibliothèque audio')}>{extraits.map(n => <option key={n} value={`audio:${n}`}>{nomCourt(n)}</option>)}</optgroup>
            {clips.length > 0 && <optgroup label={t('Clips (la piste son est revoisée)')}>{clips.map(a => <option key={a.id} value={`clip:${a.id}`}>{nomMedia(a)}</option>)}</optgroup>}
          </select></label>
        <label className="studio-champ"><span className="etiquette">{t('Nouvelle voix')}</span>
          <span className="flex gap-1.5 items-center">
            <select className="champ" value={cible} onChange={e => setCible(e.target.value)} style={{ minWidth: 0, flex: 1 }}>
              <optgroup label={t('Voix du studio')}>{voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}</optgroup>
              {extraits.length > 0 && <optgroup label={t('Extrait de la bibliothèque (avec accord)')}>{extraits.map(n => <option key={n} value={`extrait:${n}`}>{nomCourt(n)}</option>)}</optgroup>}
            </select>
            <Ecouter src={cible.startsWith('extrait:') ? urlMusique(cible.slice(8)) : urlEchantillonVoix(cible)} titre={t('Écouter la voix')} />
          </span></label>
        <span className="texte-doux">{t('Les mots, le rythme et les pauses restent ; seul le timbre change.')}</span>
      </>}

      {accordRequis && <label className="flex gap-2 items-center" style={{ cursor: 'pointer', fontSize: 12 }}>
        <input type="checkbox" checked={accord} onChange={e => setAccord(e.target.checked)} /> {t('Cette voix est la mienne, ou la personne a donné son accord. L’extrait de référence (5 à 20 s) vient de la bibliothèque audio.')}
      </label>}
      {(mode === 'cloner' || mode === 'changer') && <>
        <button className="pill" style={{ justifyContent: 'center' }}
          disabled={occupe || (mode === 'cloner' ? !texte.trim() || !ref : !source) || (accordRequis && !accord)}
          onClick={() => void (mode === 'cloner' ? cloner() : changer())}>
          {occupe ? t('synthèse…') : mode === 'cloner' ? t('Cloner et dire') : t('Changer la voix')}</button>
        <span className="texte-faible">Chatterbox · MIT</span>
      </>}

      {mode === 'personnages' && <VoixPersonnages persos={persos} voix={voix} clones={clones} surChange={chargerPersos} />}

      {msg && <span className={erreur ? 'texte-erreur' : 'texte-doux'}>{msg}</span>}
    </div>
  )
}

/** Rattache une voix à chaque personnage : le reel et l'avatar parlant la reprennent. */
function VoixPersonnages({ persos, voix, clones, surChange }: { persos: Perso[]; voix: Voix[]; clones: Voix[]; surChange: () => void }) {
  const personaId = useAppStore(st => st.personaId)
  const [choix, setChoix] = useState<Record<string, string>>({})
  const [etat, setEtat] = useState<Record<string, string>>({})
  const rattacher = async (p: Perso, v: string | null) => {
    setEtat(e => ({ ...e, [p.id]: '…' }))
    const r = await poster(`/api/personas/${encodeURIComponent(p.id)}/voix`, { voix: v }, 'PUT')
    const d = await r.json().catch(() => ({})) as { error?: string }
    if (!r.ok) { setEtat(e => ({ ...e, [p.id]: tServeur(d.error ?? null) ?? `HTTP ${r.status}` })); return }
    setEtat(e => ({ ...e, [p.id]: v ? t('Voix rattachée.') : t('Voix détachée.') }))
    if (p.id === personaId) void useAppStore.getState().refreshPersona()
    surChange()
  }
  if (!persos.length) return <span className="texte-doux">{t('Aucun personnage pour l’instant.')}</span>
  return (
    <div className="voix-persos">
      <span className="texte-faible">{t('La voix d’un personnage sert au reel (voix off) et à l’avatar parlant (« Voix de … »).')}</span>
      {persos.map(p => {
        const v = choix[p.id] ?? p.voix ?? voix[0]?.id ?? ''
        return (
          <div key={p.id} className="musique">
            <span><b>{p.name || p.id}</b> <span className="texte-faible">· {libelleVoix(p.voix, voix)}</span></span>
            <span className="flex gap-1.5 items-center">
              <SelectVoix valeur={v} onChange={x => setChoix(c => ({ ...c, [p.id]: x }))} voix={voix} clones={clones} />
              <Ecouter src={v.startsWith('clone:') ? urlMusique(v.slice(6)) : urlEchantillonVoix(v)} titre={t('Écouter la voix')} />
            </span>
            <span className="flex gap-1.5 items-center flex-wrap">
              <button className="pill tool" disabled={!v || v === p.voix || etat[p.id] === '…'} onClick={() => void rattacher(p, v)}>{t('Rattacher cette voix')}</button>
              {p.voix && <button className="pill tool" disabled={etat[p.id] === '…'} onClick={() => void rattacher(p, null)}>{t('Détacher')}</button>}
              {etat[p.id] && etat[p.id] !== '…' && <span className="texte-faible">{etat[p.id]}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}
