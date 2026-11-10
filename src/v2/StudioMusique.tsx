/* Music studio (ACE-Step 1.5): a full track, free-form or from a written preset
   (style, sung voice, duration, lyrics; tempo, key, time signature, instruments and language in
   advanced settings), and the sound-effect studio (a description, a duration). The form only
   submits the request: queue, progress and both takes are shown in the results
   area of the sound studio (SonView). */
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import {
  BALISES_PAROLES, EXEMPLES_BRUITAGE, INSTRUMENTS_COURANTS, LANGUES_CHANT, MESURES, PRESETS_MUSIQUE, SQUELETTE_PAROLES,
  TONALITES_MAJEURES, TONALITES_MINEURES, VOIX_CHANTEES, codeTonalite, type Mesure, type VoixChantee,
} from '../data/presetsMusique'

/** Submits a request to /api/musique; returns the error message, or null if submitted. */
export type Lancer = (corps: Record<string, unknown>) => Promise<string | null>

/** Settings of a music or sound-effect render, as returned by the server with the job (GET /api/jobs?op=musique). */
export type ReglagesAudio = {
  genre: 'musique' | 'bruitage'; style: string; secondes: number | null; paroles: string
  bpm: number | null; tonalite: string | null; mesure: string | null; langue: string | null; voix: string | null
  instruments: string[]; prises: string[]
}
export type Recharge = { nonce: number; r: ReglagesAudio } | null

/** POST /api/musique body reproducing the same settings (key in short notation, see codeTonalite). */
export function corpsDe(r: ReglagesAudio): Record<string, unknown> {
  if (r.genre === 'bruitage') return { genre: 'bruitage', prompt: r.style, secondes: r.secondes ?? 6 }
  return {
    genre: 'musique', prompt: r.style, instruments: r.instruments, secondes: r.secondes ?? 60,
    bpm: r.bpm ?? undefined, tonalite: r.tonalite ? codeTonalite(r.tonalite) : undefined, mesure: r.mesure ?? undefined,
    voix: r.voix ?? undefined, langue: r.langue ?? undefined, paroles: r.voix === 'none' ? '' : r.paroles,
  }
}

/** Main button stuck to the bottom of the pane, and the submit error message. */
function BoutonLancer({ libelle, disabled, envoi, erreur, note }: { libelle: string; disabled: boolean; envoi: () => void; erreur: string | null; note?: string }) {
  return (
    <div className="outil-action">
      <button className="cta son-cta" disabled={disabled} onClick={envoi}>{libelle}</button>
      {erreur ? <span className="texte-erreur">{erreur}</span> : note && <span className="texte-faible">{note}</span>}
    </div>
  )
}
function useEnvoi(lancer: Lancer) {
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const go = async (corps: Record<string, unknown>) => {
    setEnvoi(true); setErreur(null)
    try { setErreur(await lancer(corps)) } finally { setEnvoi(false) }
  }
  return { envoi, erreur, go }
}

export function StudioMusique({ lancer, aCharger }: { lancer: Lancer; aCharger?: Recharge }) {
  const [presetId, setPresetId] = useState('')
  const [style, setStyle] = useState('')
  const [instruments, setInstruments] = useState<string[]>([])
  const [instrumentLibre, setInstrumentLibre] = useState('')
  const [bpm, setBpm] = useState('')
  const [tonalite, setTonalite] = useState('')
  const [mesure, setMesure] = useState<Mesure>('')
  const [secondes, setSecondes] = useState(60)
  const [voix, setVoix] = useState<VoixChantee>('')
  const [langue, setLangue] = useState('')
  const [paroles, setParoles] = useState('')
  const [avances, setAvances] = useState(false)
  const [tousPresets, setTousPresets] = useState(false)
  const zoneParoles = useRef<HTMLTextAreaElement>(null)
  const { envoi, erreur, go } = useEnvoi(lancer)

  // "Reuse settings" from a past render: fills the form, everything stays editable
  useEffect(() => {
    const r = aCharger?.r
    if (!r || r.genre !== 'musique') return
    setPresetId(''); setStyle(r.style); setInstruments(r.instruments ?? []); setBpm(r.bpm ? String(r.bpm) : '')
    setTonalite(r.tonalite ?? ''); setMesure((r.mesure ?? '') as Mesure); setSecondes(r.secondes ?? 60)
    setVoix((r.voix ?? '') as VoixChantee); setLangue(r.langue ?? ''); setParoles(r.paroles ?? '')
    if (r.bpm || r.tonalite || r.mesure || r.langue || r.instruments?.length) setAvances(true)
  }, [aCharger?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const appliquer = (id: string) => {
    const p = PRESETS_MUSIQUE.find(x => x.id === id)
    if (!p) return
    if (presetId === id) { setPresetId(''); return }
    setPresetId(id)
    setStyle(p.style); setInstruments(p.instruments); setBpm(String(p.bpm)); setTonalite(p.tonalite); setMesure(p.mesure); setVoix(p.voix)
  }
  const basculer = (i: string) => setInstruments(l => l.includes(i) ? l.filter(x => x !== i) : [...l, i].slice(0, 12))
  const ajouterLibres = () => {
    const neufs = instrumentLibre.split(',').map(x => x.trim()).filter(Boolean)
    if (neufs.length) setInstruments(l => [...new Set([...l, ...neufs])].slice(0, 12))
    setInstrumentLibre('')
  }
  // a structure tag is inserted at the cursor, on its own line
  const inserer = (balise: string) => {
    const z = zoneParoles.current
    const debut = z?.selectionStart ?? paroles.length, fin = z?.selectionEnd ?? paroles.length
    const avant = paroles.slice(0, debut), apres = paroles.slice(fin)
    const bloc = `${avant && !avant.endsWith('\n') ? '\n' : ''}${avant ? '\n' : ''}${balise}\n`
    const texte = (avant + bloc + apres).slice(0, 3000)
    setParoles(texte)
    requestAnimationFrame(() => { if (z) { z.focus(); const pos = Math.min(texte.length, avant.length + bloc.length); z.setSelectionRange(pos, pos) } })
  }
  const instrumental = voix === 'none'
  const pret = !!style.trim() || instruments.length > 0
  const nbAvances = [bpm.trim(), tonalite, mesure, langue].filter(Boolean).length + (instruments.length ? 1 : 0)
  const generer = () => void go({
    genre: 'musique', prompt: style, instruments, secondes,
    bpm: bpm.trim() || undefined, tonalite: tonalite ? codeTonalite(tonalite) : undefined, mesure: mesure || undefined,
    voix: voix || undefined, langue: instrumental ? undefined : langue || undefined, paroles: instrumental ? '' : paroles,
  })

  return (
    <div className="studio-audio">
      <div className="studio-champ"><span className="etiquette">{t('Presets')}</span>
        <div className="presets-cartes" role="listbox" aria-label={t('Presets musicaux')}>
          {PRESETS_MUSIQUE.filter((p, i) => tousPresets || i < 5 || p.id === presetId).map(p => (
            <button key={p.id} role="option" aria-selected={presetId === p.id} className={`preset-carte ${presetId === p.id ? 'on' : ''}`} onClick={() => appliquer(p.id)} title={p.style}>
              <b>{t(p.nom)}</b>
              <span>{p.bpm} BPM · {codeTonalite(p.tonalite)} · {p.voix === 'none' ? t('Instrumental') : t(VOIX_CHANTEES.find(([v]) => v === p.voix)?.[1] ?? '')}</span>
            </button>
          ))}
          {!tousPresets && <button className="preset-carte plus" onClick={() => setTousPresets(true)}><b>{t('+{n} presets', { n: PRESETS_MUSIQUE.length - 5 })}</b><span>{t('voir tout')}</span></button>}
        </div>
        {presetId && <span className="texte-faible">{t('Le preset remplit les champs ; tout reste modifiable.')}</span>}
      </div>

      <label className="studio-champ"><span className="etiquette">{t('Style et ambiance')}</span>
        <textarea className="champ" rows={3} value={style} maxLength={400} onChange={e => setStyle(e.target.value)} placeholder={t('Style, instruments, ambiance : warm lo-fi, soft piano…')} /></label>

      <div className="studio-grille">
        <label className="studio-champ"><span className="etiquette">{t('Voix chantée')}</span>
          <select className="champ" value={voix} onChange={e => setVoix(e.target.value as VoixChantee)}>
            <option value="">{t('auto')}</option>
            {VOIX_CHANTEES.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select></label>
        <label className="studio-champ"><span className="etiquette">{t('Durée : {n} s', { n: secondes })}</span>
          <input type="range" min={10} max={120} step={5} value={secondes} onChange={e => setSecondes(Number(e.target.value))} /></label>
      </div>

      {!instrumental && <div className="studio-champ">
        <span className="etiquette">{t('Paroles (facultatif) : vide = instrumental')}</span>
        <div className="puces">
          {BALISES_PAROLES.map(b => <button key={b} className="puce" onClick={() => inserer(b)}>{b}</button>)}
          {!paroles.trim() && <button className="puce" onClick={() => setParoles(SQUELETTE_PAROLES)}>{t('Structure complète')}</button>}
        </div>
        <textarea ref={zoneParoles} className="champ" rows={7} value={paroles} maxLength={3000} onChange={e => setParoles(e.target.value)}
          placeholder={t('[Verse]\nTes paroles ici…\n\n[Chorus]\nLe refrain…')} />
        <span className="texte-faible">{t('Sans balise, les strophes séparées par une ligne vide deviennent couplets et refrains.')}</span>
      </div>}

      <details className="son-avances" open={avances} onToggle={e => setAvances((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>{t('Réglages avancés')}{nbAvances > 0 && <em>{nbAvances}</em>}<span className="texte-faible">{t('tempo, tonalité, mesure, instruments, langue')}</span></summary>
        <div className="studio-audio" style={{ paddingTop: 10 }}>
          <div className="studio-grille">
            <label className="studio-champ"><span className="etiquette">{t('Tempo (BPM)')}</span>
              <input className="champ" type="number" inputMode="numeric" min={40} max={220} value={bpm} onChange={e => setBpm(e.target.value)} placeholder={t('auto')} /></label>
            <label className="studio-champ"><span className="etiquette">{t('Tonalité')}</span>
              <select className="champ" value={tonalite} onChange={e => setTonalite(e.target.value)}>
                <option value="">{t('auto')}</option>
                <optgroup label={t('Majeur')}>{TONALITES_MAJEURES.map(k => <option key={k} value={k}>{k}</option>)}</optgroup>
                <optgroup label={t('Mineur')}>{TONALITES_MINEURES.map(k => <option key={k} value={k}>{k}</option>)}</optgroup>
              </select></label>
            <label className="studio-champ"><span className="etiquette">{t('Mesure')}</span>
              <select className="champ" value={mesure} onChange={e => setMesure(e.target.value as Mesure)}>
                <option value="">{t('auto')} (4/4)</option>
                {MESURES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            <label className="studio-champ"><span className="etiquette">{t('Langue chantée')}</span>
              <select className="champ" value={langue} disabled={instrumental} onChange={e => setLangue(e.target.value)}>
                <option value="">{t('auto (d’après les paroles)')}</option>
                {LANGUES_CHANT.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
              </select></label>
          </div>
          <div className="studio-champ"><span className="etiquette">{t('Instruments')}</span>
            <div className="puces">
              {[...new Set([...INSTRUMENTS_COURANTS, ...instruments])].map(i => (
                <button key={i} className={`puce ${instruments.includes(i) ? 'on' : ''}`} aria-pressed={instruments.includes(i)} onClick={() => basculer(i)}>{i}</button>
              ))}
            </div>
            <span className="flex gap-1.5">
              <input className="champ flex-1" value={instrumentLibre} maxLength={80} onChange={e => setInstrumentLibre(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); ajouterLibres() } }}
                placeholder={t('Autre instrument (ex. kalimba, sitar)')} aria-label={t('Ajouter un instrument')} />
              <button className="pill tool" disabled={!instrumentLibre.trim()} onClick={ajouterLibres}>{t('Ajouter')}</button>
            </span>
          </div>
        </div>
      </details>

      <BoutonLancer libelle={envoi ? t('envoi…') : t('Générer le morceau')} disabled={envoi || !pret} envoi={generer} erreur={erreur}
        note={t('Deux prises, rendues ensemble, rangées dans la bibliothèque audio.')} />
    </div>
  )
}

export function StudioBruitage({ lancer, aCharger }: { lancer: Lancer; aCharger?: Recharge }) {
  const [prompt, setPrompt] = useState('')
  const [secondes, setSecondes] = useState(6)
  const { envoi, erreur, go } = useEnvoi(lancer)
  useEffect(() => {
    const r = aCharger?.r
    if (!r || r.genre !== 'bruitage') return
    setPrompt(r.style); setSecondes(r.secondes ?? 6)
  }, [aCharger?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="studio-audio">
      <label className="studio-champ"><span className="etiquette">{t('Le son')}</span>
        <textarea className="champ" rows={3} value={prompt} maxLength={400} onChange={e => setPrompt(e.target.value)} placeholder={t('Le son : a heavy wooden door creaking open…')} /></label>
      <div className="studio-champ"><span className="etiquette">{t('Exemples')}</span>
        <div className="puces">{EXEMPLES_BRUITAGE.map(x => <button key={x} className={`puce ${prompt === x ? 'on' : ''}`} onClick={() => setPrompt(x)}>{x}</button>)}</div>
      </div>
      <label className="studio-champ"><span className="etiquette">{t('Durée : {n} s', { n: secondes })}</span>
        <input type="range" min={2} max={20} value={secondes} onChange={e => setSecondes(Number(e.target.value))} /></label>
      <span className="texte-faible">{t('Un bruitage seul, sans musique ni voix : pour habiller une vidéo au montage.')}</span>
      <BoutonLancer libelle={envoi ? t('envoi…') : t('Générer le bruitage')} disabled={envoi || !prompt.trim()} envoi={() => void go({ genre: 'bruitage', prompt, secondes })} erreur={erreur}
        note={t('Deux prises, rendues ensemble, rangées dans la bibliothèque audio.')} />
    </div>
  )
}
