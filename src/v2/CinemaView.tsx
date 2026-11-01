/* ============================================================
   Studio ciné (21/10) — une fiche de plan au lieu d'un prompt.

   Caméra (boîtier, optique, focale, ouverture), plan, lumière, pellicule,
   look et étalonnage, une palette de couleurs : la fiche compose la phrase
   que lit le moteur photo (Krea 2 ou Klein), le personnage actif y met son
   visage. « Même plan, 4 lumières » rend la même graine sous quatre
   lumières. Les prises sont des rendus photo ordinaires : elles arrivent
   dans la bibliothèque et s'animent comme les autres.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { JobCard, PHOTO_SIZES } from './bits'
import { t } from '../i18n'
import {
  BALAYAGE, BOITIERS, DEPARTS, ETALONNAGES, FICHE_DEFAUT, FOCALES, LOOKS, LUMIERES, OPTIQUES, OUVERTURES, PELLICULES, PLANS,
  composerFiche, couleursDominantes, type Fiche, type Opt,
} from '../data/cinema'

const CLE_FICHE = 'creatoros.cinema.fiche'
const CLE_PRISES = 'creatoros.cinema.prises'
const lireJSON = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
const ecrireJSON = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* stockage indisponible */ } }
const FORMATS = ['9:16', '2:3', '1:1', '3:2', '16:9']

export function CinemaView({ onOpen, goVideo }: { onOpen: (a: Asset, list: Asset[]) => void; goVideo: () => void }) {
  const s = useAppStore()
  const [f, setF] = useState<Fiche>(() => ({ ...FICHE_DEFAUT, ...lireJSON<Partial<Fiche>>(CLE_FICHE, {}) }))
  const [ligne, setLigne] = useState<string | null>(null)
  const [prises, setPrises] = useState<number>(2)
  const [balayage, setBalayage] = useState(false)
  const [format, setFormat] = useState('9:16')
  const [ids, setIds] = useState<string[]>(() => lireJSON<string[]>(CLE_PRISES, []))
  const [envoi, setEnvoi] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [voirPrompt, setVoirPrompt] = useState(false)
  const [choixPalette, setChoixPalette] = useState(false)
  useEffect(() => { ecrireJSON(CLE_FICHE, f) }, [f])
  useEffect(() => { ecrireJSON(CLE_PRISES, ids.slice(0, 60)) }, [ids])
  const maj = (d: Partial<Fiche>) => setF(x => ({ ...x, ...d }))
  const prompt = composerFiche(f)

  /* Chaque prise passe par submitJob, réglée prise par prise (prompt, graine,
     format), puis le compositeur de la vue Image retrouve ce qu'il avait. */
  async function tourner() {
    if (!f.scene.trim()) { setErr(t('Décris la scène : où elle est, ce qu’elle fait.')); return }
    setEnvoi(true); setErr(null)
    const avant = useAppStore.getState()
    const garde = { mode: avant.mode, photo: avant.photo, userPrompt: avant.userPrompt, promptTouched: avant.promptTouched,
      composedPositive: avant.composedPositive, seedMode: avant.seedMode, seedValue: avant.seedValue, batchCount: avant.batchCount, photoSize: avant.photoSize }
    const graine = Math.floor(Math.random() * 2 ** 40)
    const textes = balayage ? BALAYAGE.map(l => composerFiche(f, l)) : Array.from({ length: prises }, () => prompt)
    const nouveaux: string[] = []
    try {
      for (let i = 0; i < textes.length; i++) {
        useAppStore.setState({
          mode: 'photo', photo: { ...avant.photo, task: 'generate' }, userPrompt: textes[i], promptTouched: true, composedPositive: '',
          batchCount: 1, photoSize: PHOTO_SIZES.find(p => p.label === format) ?? null,
          seedMode: 'lock', seedValue: balayage ? graine : graine + i,
        })
        await useAppStore.getState().submitJob()
        const e = useAppStore.getState().t0Error
        if (e) throw new Error(e)
        const j = useAppStore.getState().jobs[0]
        if (j) nouveaux.push(j.id)
      }
    } catch (e) { setErr((e as Error).message) }
    finally {
      useAppStore.setState(garde)
      setIds(x => [...nouveaux.reverse(), ...x])
      setEnvoi(false)
    }
  }

  const jobs = s.jobs.filter(j => ids.includes(j.id) && STATUTS_ACTIFS.includes(j.status))
  const rendues = useMemo(() => ids.flatMap(id => s.assets.filter(a => a.jobId === id && a.mediaType === 'photo')), [ids, s.assets])
  const queueIds = s.jobs.filter(j => j.status === 'queued').map(j => j.id)

  const Ligne = ({ k, titre, valeur, children }: { k: string; titre: string; valeur: string; children: React.ReactNode }) => (
    <div className="cine-ligne">
      <button className={`cine-tete ${ligne === k ? 'on' : ''}`} onClick={() => setLigne(ligne === k ? null : k)}>
        <span className="cine-titre">{titre}</span><span className="cine-valeur">{valeur}</span><span style={{ opacity: .5 }}>{ligne === k ? '▴' : '▾'}</span>
      </button>
      {ligne === k && <div className="cine-choix">{children}</div>}
    </div>
  )
  const puces = (liste: Opt[], cle: keyof Fiche) => liste.map(o => (
    <button key={o.id} className={`spill ${f[cle] === o.id ? 'on' : ''}`} onClick={() => maj({ [cle]: o.id } as Partial<Fiche>)}>{t(o.label)}</button>
  ))
  const lib = (l: Opt[], id: string) => t((l.find(o => o.id === id) ?? l[0]).label)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div className="cine" style={{ maxWidth: 1240, margin: '0 auto' }}>
        <div>
          <h2 className="titre-outil">{t('Studio ciné')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Règle le plan comme sur un tournage — caméra, optique, lumière, pellicule, étalonnage. {nom} joue la scène.', { nom: s.personaName })}</div>
        </div>

        <div className="cine-grille">
          <div className="carte-reel cine-fiche">
            <div className="flex gap-1.5 flex-wrap" style={{ marginBottom: 10 }}>
              <span className="text-[10.5px]" style={{ color: 'var(--faint)', alignSelf: 'center' }}>{t('Plans de départ')}</span>
              {DEPARTS.map(d => <button key={d.id} className="pill tool" onClick={() => setF(x => ({ ...x, ...d.fiche }))}>{t(d.label)}</button>)}
            </div>
            <textarea className="cine-scene" value={f.scene} onChange={e => maj({ scene: e.target.value })} rows={2}
              placeholder={t('La scène, en anglais : où elle est, ce qu’elle fait…')} />
            <div className="flex items-center gap-2 flex-wrap" style={{ margin: '10px 0 4px' }}>
              <span className="cine-perso">
                {s.personaAvatar ? <img src={s.personaAvatar} alt="" /> : <span />}
                <span><small>{t('Personnage')}</small><b>{s.personaName}</b></span>
              </span>
              <span className="cine-palette">
                <small>{t('Palette')}</small>
                {f.palette.map((c, i) => <button key={i} title={t('retirer')} style={{ background: c }} onClick={() => maj({ palette: f.palette.filter((_, j) => j !== i) })} />)}
                {f.palette.length < 8 && <label className="cine-plus" title={t('ajouter une couleur')}>＋<input type="color" hidden onChange={e => maj({ palette: [...f.palette, e.target.value].slice(0, 8) })} /></label>}
                <button className="pill tool" style={{ fontSize: 10.5, padding: '3px 8px' }} onClick={() => setChoixPalette(true)}>{t('depuis une photo')}</button>
              </span>
            </div>

            <Ligne k="camera" titre={t('Caméra')} valeur={`${lib(BOITIERS, f.boitier)} · ${f.focale} · ${lib(OUVERTURES, f.ouverture)}`}>
              <div className="cine-sous">{t('Boîtier')}</div>{puces(BOITIERS, 'boitier')}
              <div className="cine-sous">{t('Optique')}</div>{puces(OPTIQUES, 'optique')}
              <div className="cine-sous">{t('Focale')}</div>
              {FOCALES.map(x => <button key={x} className={`spill ${f.focale === x ? 'on' : ''}`} onClick={() => maj({ focale: x })}>{x}</button>)}
              <div className="cine-sous">{t('Ouverture')}</div>{puces(OUVERTURES, 'ouverture')}
            </Ligne>
            <Ligne k="plan" titre={t('Plan')} valeur={lib(PLANS, f.plan)}>{puces(PLANS, 'plan')}</Ligne>
            <Ligne k="lumiere" titre={t('Lumière')} valeur={balayage ? t('4 lumières') : lib(LUMIERES, f.lumiere)}>{puces(LUMIERES, 'lumiere')}</Ligne>
            <Ligne k="pellicule" titre={t('Pellicule')} valeur={lib(PELLICULES, f.pellicule)}>{puces(PELLICULES, 'pellicule')}</Ligne>
            <Ligne k="look" titre={t('Look')} valeur={lib(LOOKS, f.look)}>{puces(LOOKS, 'look')}</Ligne>
            <Ligne k="etalonnage" titre={t('Étalonnage')} valeur={lib(ETALONNAGES, f.etalonnage)}>{puces(ETALONNAGES, 'etalonnage')}</Ligne>

            <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              <span>{t('Format')}</span>
              {FORMATS.map(x => <button key={x} className={`wtab ${format === x ? 'on' : ''}`} onClick={() => setFormat(x)}>{x}</button>)}
              <span style={{ marginLeft: 8 }}>{t('Prises')}</span>
              {[1, 2, 3, 4].map(n => <button key={n} disabled={balayage} className={`wtab ${!balayage && prises === n ? 'on' : ''}`} onClick={() => setPrises(n)}>×{n}</button>)}
              <button className={`wtab ${balayage ? 'on' : ''}`} onClick={() => setBalayage(!balayage)} title={t('la même graine sous l’heure dorée, l’heure bleue, des néons et un clair-obscur')}>☀ {t('Même plan, 4 lumières')}</button>
              <span className="text-[10px]" style={{ marginLeft: 6 }}>
                <button className={`spill ${s.photoEngine === 'krea' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('krea')}>Krea 2</button>
                {s.personaKlein && <button className={`spill ${s.photoEngine === 'klein' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('klein')}>FLUX.2 Klein</button>}
              </span>
              <span style={{ flex: 1 }} />
              <button className="cta" style={{ padding: '10px 20px', flexDirection: 'row' }} disabled={envoi} onClick={() => void tourner()}>
                {envoi ? '…' : `🎬 ${t('Tourner')}`} <small style={{ marginLeft: 6 }}>{balayage ? 4 : prises} {t('prises')}</small>
              </button>
            </div>
            {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
            <button className="cine-voir" onClick={() => setVoirPrompt(!voirPrompt)}>{voirPrompt ? '▾' : '▸'} {t('Ce que lit le moteur')}</button>
            {voirPrompt && <div className="cine-prompt">{prompt}</div>}
          </div>

          <div className="cine-prises">
            <div className="text-[11px]" style={{ color: 'var(--faint)', marginBottom: 8, letterSpacing: '.08em', textTransform: 'uppercase' }}>{t('Prises')}</div>
            {!jobs.length && !rendues.length && <div style={{ color: 'var(--faint)', fontSize: 12, padding: '30px 6px' }}>{t('Les prises apparaissent ici. Choisis un plan de départ, puis « Tourner ».')}</div>}
            <div className="cine-pellicule">
              {jobs.map(j => <div key={j.id} className="cine-prise"><JobCard j={j} queueIds={queueIds} /></div>)}
              {rendues.map(a => (
                <div key={a.id} className="cine-prise">
                  <img src={a.uri} alt="" onClick={() => onOpen(a, rendues)} />
                  <div className="cine-actions">
                    <button className="pill" onClick={() => { void s.animateFrom(a); goVideo() }}>▶ {t('Animer')}</button>
                    <button className="pill tool" onClick={() => void couleursDominantes(a.uri).then(p => maj({ palette: p }))}>{t('palette')}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {choixPalette && (
        <div className="pop" onClick={() => setChoixPalette(false)}>
          <div className="pbox" style={{ width: 'min(860px,94%)' }} onClick={e => e.stopPropagation()}>
            <h3>{t('Palette depuis une photo')} <button className="x" onClick={() => setChoixPalette(false)}>✕</button></h3>
            <div className="pkgrid" style={{ maxHeight: 420 }}>
              {s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected').slice(0, 120).map(a => (
                <button key={a.id} className="pk" onClick={() => { void couleursDominantes(a.uri).then(p => maj({ palette: p })); setChoixPalette(false) }}>
                  <img src={a.uri} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
