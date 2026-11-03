/* Musiques et bruitages de la bibliothèque : ceux générés ici et ceux déposés dans le montage. */
import { Ecouter, urlEchantillonVoix, urlMusique } from './Ecouter'
import { useEffect, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { GenererMusique } from './GenererMusique'
import { OutilPage } from './OutilPage'

type Mode = 'studio' | 'cloner' | 'changer'
const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')

function VoixOff({ surPret }: { surPret: () => void }) {
  const [voix, setVoix] = useState<{ id: string; nom: string }[]>([])
  const [dispo, setDispo] = useState(true)
  const [clone, setClone] = useState(false)
  const [mode, setMode] = useState<Mode>('studio')
  const [refs, setRefs] = useState<string[]>([])
  const [ref, setRef] = useState('')
  const [source, setSource] = useState('')
  const [accord, setAccord] = useState(false)
  const edition = useEdition()
  const [choix, setChoix] = useState('af_heart')
  const [texte, setTexte] = useState('')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void fetch('/api/voix').then(r => r.json()).then((d: { disponible: boolean; voix: { id: string; nom: string }[]; clone?: boolean }) => { setVoix(d.voix); setDispo(d.disponible); setClone(!!d.clone) }).catch(() => {})
    void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string }[] }) => { const l = (d.musiques ?? []).map(m => m.nom); setRefs(l); setRef(l[0] ?? ''); setSource(l[0] ?? '') }).catch(() => {}) }, [])
  // pour changer de voix, la cible est une voix du studio ou, avec accord, un extrait de la bibliothèque
  const cibleExtrait = mode === 'changer' && choix.startsWith('extrait:')
  const accordRequis = mode === 'cloner' || cibleExtrait
  const poster = (url: string, corps: object) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    const r = mode === 'cloner' ? await poster('/api/voix/clone', { texte, reference: ref, accord })
      : mode === 'changer' ? await poster('/api/voix/changer', cibleExtrait ? { audio: source, reference: choix.slice(8), accord } : { audio: source, voix: choix })
      : await poster('/api/voix', { texte, voix: choix })
    const d = await r.json().catch(() => ({}))
    setOccupe(false)
    if (!r.ok) setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); else { setTexte(''); surPret() }
  }
  const pret = mode === 'changer' ? !!source : !!texte.trim()
  return (
    <div className="musique" style={{ gap: 8 }}>
      <b>{t('Voix off')}</b>
      {!dispo ? <span className="texte-doux">{t('Voix non installée sur ce studio.')}</span> : (<>
        {clone && edition && <span className="flex gap-1 flex-wrap">
          <button className={`pill ${mode === 'studio' ? 'on' : ''}`} onClick={() => setMode('studio')}>{t('Voix du studio')}</button>
          <button className={`pill ${mode === 'cloner' ? 'on' : ''}`} onClick={() => setMode('cloner')}>{t('Cloner une voix')}</button>
          <button className={`pill ${mode === 'changer' ? 'on' : ''}`} onClick={() => setMode('changer')}>{t('Changer une voix')}</button>
        </span>}
        {mode === 'changer'
          ? <label className="flex gap-2 items-center flex-wrap">{t('Enregistrement à transformer')}
              <select className="champ" value={source} onChange={e => setSource(e.target.value)} style={{ maxWidth: 280 }}>
                {refs.map(n => <option key={n} value={n}>{nomCourt(n)}</option>)}
              </select></label>
          : <textarea className="champ" value={texte} onChange={e => setTexte(e.target.value)} maxLength={1200} rows={3} placeholder={t('Le texte à dire, en anglais')} />}
        <div className="flex gap-2 items-center flex-wrap">
          {mode === 'cloner'
            ? <select className="champ" value={ref} onChange={e => setRef(e.target.value)} aria-label={t('extrait de référence')} style={{ maxWidth: 260 }}>
                {refs.map(n => <option key={n} value={n}>{nomCourt(n)}</option>)}
              </select>
            : <select className="champ" value={choix} onChange={e => setChoix(e.target.value)} aria-label={t('voix')} style={{ maxWidth: 280 }}>
                {voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}
                {mode === 'changer' && refs.length > 0 && <optgroup label={t('Extrait de la bibliothèque (avec accord)')}>
                  {refs.map(n => <option key={n} value={`extrait:${n}`}>{nomCourt(n)}</option>)}
                </optgroup>}
              </select>}
          <Ecouter src={mode === 'cloner' ? urlMusique(ref) : choix.startsWith('extrait:') ? urlMusique(choix.slice(8)) : urlEchantillonVoix(choix)} titre={t('Écouter la voix')} />
          <button className="pill" disabled={!pret || occupe || (accordRequis && (!accord || (mode === 'cloner' && !ref)))} onClick={() => void lancer()}>
            {occupe ? t('synthèse…') : mode === 'cloner' ? t('Cloner et dire') : mode === 'changer' ? t('Changer la voix') : t('Générer la voix')}</button>
          <span className="texte-faible">{mode === 'studio' ? 'Kokoro-82M · Apache-2.0' : 'Chatterbox · MIT'}</span>
        </div>
        {mode === 'changer' && <span className="texte-doux">{t('Les mots, le rythme et les pauses restent ; seul le timbre change. Pour un clip, ouvre-le et choisis « Changer la voix ».')}</span>}
        {accordRequis && <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={accord} onChange={e => setAccord(e.target.checked)} /> {t('Cette voix est la mienne, ou la personne a donné son accord. L’extrait de référence (5 à 20 s) vient de la bibliothèque audio.')}
        </label>}
        {msg && <span className="texte-erreur">{msg}</span>}
      </>)}
    </div>
  )
}

export function Musiques() {
  const edition = useEdition()
  const [liste, setListe] = useState<{ nom: string; duree: number }[] | null>(null)
  const [aConfirmer, setAConfirmer] = useState<{ nom: string; usages: string[] } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const supprimer = async (nom: string, confirme = false) => {
    setErreur(null)
    const r = await fetch(`/api/montage/musiques/${encodeURIComponent(nom)}${confirme ? '?confirme=1' : ''}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (r.status === 409) { setAConfirmer({ nom, usages: d.usages ?? [] }); return }
    if (!r.ok) { setErreur(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    setAConfirmer(null); charger()
  }
  const [outil, setOutil] = useState<'voix' | 'musique'>('voix')
  const charger = () => void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string; duree: number }[] }) => setListe(d.musiques ?? [])).catch(() => setListe([]))
  useEffect(charger, [])
  return (
    <OutilPage titre={t('Musique et voix')} texte={t('Voix off, voix clonée ou changée, musique et bruitages : tout rejoint la bibliothèque audio, prêt pour le montage, le reel et le doublage.')}
      vide={t('Rien pour l’instant : génère ton premier morceau.')}
      resultat={liste && liste.length > 0 ? (
        <div className="audio-grille">
          {liste.map(m => (
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
      <div className="segmente">
        <button className={outil === 'voix' ? 'on' : ''} onClick={() => setOutil('voix')}>{t('Voix')}</button>
        <button className={outil === 'musique' ? 'on' : ''} onClick={() => setOutil('musique')}>{t('Musique et bruitages')}</button>
      </div>
      {outil === 'voix' ? <VoixOff surPret={charger} /> : <GenererMusique surPret={charger} />}
    </OutilPage>
  )
}
