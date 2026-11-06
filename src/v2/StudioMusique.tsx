/* Studio musique (ACE-Step 1.5) : un morceau complet, en libre ou d'après un preset écrit
   (style, instruments, tempo, tonalité, mesure, durée, paroles, langue, voix chantée), et le
   studio de bruitage (une description, une durée). Chaque demande rend deux prises, listées
   avec leur lecteur ; elles rejoignent la bibliothèque audio. */
import { useRef, useState } from 'react'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import {
  BALISES_PAROLES, INSTRUMENTS_COURANTS, LANGUES_CHANT, MESURES, PRESETS_MUSIQUE, SQUELETTE_PAROLES,
  TONALITES_MAJEURES, TONALITES_MINEURES, VOIX_CHANTEES, type Mesure, type VoixChantee,
} from '../data/presetsMusique'

const nomCourt = (n: string) => n.replace(/\.\w+$/, '').replace(/_/g, ' ')
const FINIS = ['done', 'failed', 'cancelled', 'blocked']

/** Dépose une demande sur /api/musique, suit le job jusqu'au bout et rend les prises produites. */
function useRenduAudio(surPret: () => void) {
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState('')
  const [prises, setPrises] = useState<string[]>([])
  const lancer = async (corps: object) => {
    setOccupe(true); setMsg(''); setPrises([])
    const r = await fetch('/api/musique', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); setOccupe(false); return }
    const jobId = d.jobId
    // le rendu rejoint la file du studio : sa carte « en cours » s'affiche dans la bibliothèque audio
    void useAppStore.getState().adoptServerJob(jobId)
    for (;;) {
      await new Promise(p => setTimeout(p, 2000))
      // la route rend { job, assets } : l'état est dans job.status
      const rep = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`).then(x => x.json()).catch(() => null) as { job?: { status?: string; error?: string | null } } | null
      const st = String(rep?.job?.status ?? '')
      if (!FINIS.includes(st)) continue
      if (st !== 'done') {
        setMsg(st === 'cancelled' ? t('Rendu annulé.') : tServeur(rep?.job?.error ?? null) ?? t('échec'))
        setOccupe(false); return
      }
      // les prises portent la fin de l'id du job : …_<6 car.>.mp3, …_<6 car.>_2.mp3
      const liste = await fetch('/api/montage/musiques').then(x => x.json()).then((x: { musiques?: { nom: string }[] }) => x.musiques ?? []).catch(() => [])
      const marque = `_${jobId.slice(-6)}`
      setPrises(liste.map(m => m.nom).filter(n => n.includes(`${marque}.`) || n.includes(`${marque}_`)).sort())
      setMsg(t('Prêt : deux prises, garde la meilleure.'))
      setOccupe(false); surPret(); return
    }
  }
  return { lancer, occupe, msg, prises }
}

function Prises({ prises }: { prises: string[] }) {
  if (!prises.length) return null
  return (
    <div className="audio-prises">
      {prises.map((n, i) => (
        <div key={n} className="musique">
          <span><b>{t('Prise {n}', { n: i + 1 })}</b> <span className="texte-faible">{nomCourt(n)}</span></span>
          <audio controls preload="none" src={`/api/montage/musiques/${encodeURIComponent(n)}`} />
        </div>
      ))}
    </div>
  )
}

/* La tonalité part en notation courte (« Dm », « F# », « Bbm ») : le mot anglais « minor » ferait
   refuser la demande par le filtre de contenu de la démo. Le serveur la remet en toutes lettres pour ACE-Step. */
const codeTonalite = (k: string) => k.replace(/ minor$/, 'm').replace(/ major$/, '')

export function StudioMusique({ surPret }: { surPret: () => void }) {
  const [mode, setMode] = useState<'libre' | 'preset'>('libre')
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
  const zoneParoles = useRef<HTMLTextAreaElement>(null)
  const { lancer, occupe, msg, prises } = useRenduAudio(surPret)

  const appliquer = (id: string) => {
    setPresetId(id)
    const p = PRESETS_MUSIQUE.find(x => x.id === id)
    if (!p) return
    setStyle(p.style); setInstruments(p.instruments); setBpm(String(p.bpm)); setTonalite(p.tonalite); setMesure(p.mesure); setVoix(p.voix)
  }
  const basculer = (i: string) => setInstruments(l => l.includes(i) ? l.filter(x => x !== i) : [...l, i].slice(0, 12))
  const ajouterLibres = () => {
    const neufs = instrumentLibre.split(',').map(x => x.trim()).filter(Boolean)
    if (neufs.length) setInstruments(l => [...new Set([...l, ...neufs])].slice(0, 12))
    setInstrumentLibre('')
  }
  // une balise de structure s'insère au curseur, sur sa propre ligne
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
  const generer = () => void lancer({
    genre: 'musique', prompt: style, instruments, secondes,
    bpm: bpm.trim() || undefined, tonalite: tonalite ? codeTonalite(tonalite) : undefined, mesure: mesure || undefined,
    voix: voix || undefined, langue: instrumental ? undefined : langue || undefined, paroles: instrumental ? '' : paroles,
  })

  return (
    <div className="studio-audio">
      <div className="flex gap-1.5 flex-wrap">
        <button className={`pill tool ${mode === 'libre' ? 'on' : ''}`} onClick={() => setMode('libre')}>{t('Libre')}</button>
        <button className={`pill tool ${mode === 'preset' ? 'on' : ''}`} onClick={() => setMode('preset')}>{t('Depuis un preset')}</button>
      </div>
      {mode === 'preset' && <div className="presets-musique" role="listbox" aria-label={t('Presets musicaux')}>
        {PRESETS_MUSIQUE.map(p => (
          <button key={p.id} role="option" aria-selected={presetId === p.id} className={`pill tool ${presetId === p.id ? 'on' : ''}`} onClick={() => appliquer(p.id)}
            title={`${p.style} · ${p.bpm} BPM · ${p.tonalite}`}>{t(p.nom)}</button>
        ))}
      </div>}
      {mode === 'preset' && presetId && <span className="texte-faible">{t('Le preset remplit les champs ; tout reste modifiable.')}</span>}

      <label className="studio-champ"><span className="etiquette">{t('Style et ambiance')}</span>
        <textarea className="champ" rows={2} value={style} maxLength={400} onChange={e => setStyle(e.target.value)} placeholder={t('Style, instruments, ambiance : warm lo-fi, soft piano…')} /></label>

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
        <label className="studio-champ"><span className="etiquette">{t('Voix chantée')}</span>
          <select className="champ" value={voix} onChange={e => setVoix(e.target.value as VoixChantee)}>
            <option value="">{t('auto')}</option>
            {VOIX_CHANTEES.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select></label>
      </div>
      <label className="studio-champ"><span className="etiquette">{t('Durée : {n} s', { n: secondes })}</span>
        <input type="range" min={10} max={120} step={5} value={secondes} onChange={e => setSecondes(Number(e.target.value))} /></label>

      {!instrumental && <div className="studio-champ">
        <span className="etiquette">{t('Paroles (facultatif) : vide = instrumental')}</span>
        <div className="puces">
          {BALISES_PAROLES.map(b => <button key={b} className="puce" onClick={() => inserer(b)}>{b}</button>)}
          {!paroles.trim() && <button className="puce" onClick={() => setParoles(SQUELETTE_PAROLES)}>{t('Structure complète')}</button>}
        </div>
        <textarea ref={zoneParoles} className="champ" rows={8} value={paroles} maxLength={3000} onChange={e => setParoles(e.target.value)}
          placeholder={t('[Verse]\nTes paroles ici…\n\n[Chorus]\nLe refrain…')} />
        <span className="texte-faible">{t('Sans balise, les strophes séparées par une ligne vide deviennent couplets et refrains.')}</span>
        <label className="studio-champ"><span className="etiquette">{t('Langue chantée')}</span>
          <select className="champ" value={langue} onChange={e => setLangue(e.target.value)}>
            <option value="">{t('auto (d’après les paroles)')}</option>
            {LANGUES_CHANT.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
          </select></label>
      </div>}

      <div>
        <button className="pill" style={{ width: '100%', justifyContent: 'center' }} disabled={occupe || !pret} onClick={generer}>
          {occupe ? t('génération…') : t('Générer le morceau')}</button>
      </div>
      {msg && <span className="texte-doux">{msg}</span>}
      <Prises prises={prises} />
    </div>
  )
}

export function StudioBruitage({ surPret }: { surPret: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [secondes, setSecondes] = useState(6)
  const { lancer, occupe, msg, prises } = useRenduAudio(surPret)
  return (
    <div className="studio-audio">
      <label className="studio-champ"><span className="etiquette">{t('Le son')}</span>
        <textarea className="champ" rows={3} value={prompt} maxLength={400} onChange={e => setPrompt(e.target.value)} placeholder={t('Le son : a heavy wooden door creaking open…')} /></label>
      <label className="studio-champ"><span className="etiquette">{t('Durée : {n} s', { n: secondes })}</span>
        <input type="range" min={2} max={20} value={secondes} onChange={e => setSecondes(Number(e.target.value))} /></label>
      <span className="texte-faible">{t('Un bruitage seul, sans musique ni voix : pour habiller une vidéo au montage.')}</span>
      <div>
        <button className="pill" style={{ width: '100%', justifyContent: 'center' }} disabled={occupe || !prompt.trim()} onClick={() => void lancer({ genre: 'bruitage', prompt, secondes })}>
          {occupe ? t('génération…') : t('Générer le bruitage')}</button>
      </div>
      {msg && <span className="texte-doux">{msg}</span>}
      <Prises prises={prises} />
    </div>
  )
}
