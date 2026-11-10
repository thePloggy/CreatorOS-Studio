/* ============================================================
   Studio ciné — une fiche de plan au lieu d'un prompt.

   Caméra (boîtier, optique, focale, ouverture), plan, lumière, pellicule,
   look et étalonnage, une palette de couleurs : la fiche compose la phrase
   que lit le moteur photo (FLUX 3 Klein, Krea 2 ou Klein), le personnage actif y met son
   visage. « Même plan, 4 lumières » rend la même graine sous quatre
   lumières. Les prises sont des rendus photo ordinaires : elles arrivent
   dans la bibliothèque et s'animent comme les autres.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, JobCard, PHOTO_SIZES } from './bits'
import { FramePicker } from './popups'
import { t, getLang } from '../i18n'
import { ChoixPersonnage } from './ChoixPersonnage'
import { HowItWorks, VERSION_HOWTO, howto } from './HowItWorks'
import { useRef } from 'react'
import { TableMontage, ajouterALaTable, ouvrirDansTable, TABLE_VIDE, type Etat } from './TableMontage'
import { FilmsCinema, FILMS_DU_STUDIO, ajouterFilm, lireFilms, nomDeFilm, type Film, type StillFilm } from './FilmsCinema'
import {
  BALAYAGE, BOITIERS, DEPARTS, ETALONNAGES, FICHE_DEFAUT, FOCALES, LOOKS, LUMIERES, OPTIQUES, OUVERTURES, PELLICULES, PLANS,
  composerFiche, couleursDominantes, type Fiche, type Opt,
} from '../data/cinema'

/* Séquences phares de l'en-tête : une par thème, la première d'entre elles par défaut.
   Chaque séquence est une vraie chaîne du studio : trois plans fixes, un clip, un préquel, un séquel. */
const v = (f: string) => `/danses/howto/${f}?v=${VERSION_HOWTO}`
const SEQUENCES: { id: string; label: string; video: string; affiche: string }[] = [
  { id: 'phare', label: 'Gardien de phare', video: v('cinema-seq-phare.mp4'), affiche: v('cinema-seq-phare.jpg') },
  { id: 'superheros', label: 'Super-héros', video: v('cinema-seq-superheros.mp4'), affiche: v('cinema-seq-superheros.jpg') },
  { id: 'western', label: 'Western', video: v('cinema-seq-western.mp4'), affiche: v('cinema-seq-western.jpg') },
  { id: 'dragon', label: 'Dragon', video: v('cinema-seq-dragon.mp4'), affiche: v('cinema-seq-dragon.jpg') },
]
/* Les étapes : la démonstration de la table existe en français et en anglais (le texte de l'interface s'y lit). */
const enLangue = (f: string) => getLang() === 'en' ? f.replace(/\.(mp4|jpg)$/, '-en.$1') : f
const ETAPES_CINE: [string, string, string?][] = [
  ['Les images clés', 'La fiche de plan rend des images cohérentes entre elles : même personnage, même tenue, même lumière, même étalonnage.'],
  ['La table de montage', 'Chaque image se pose à son instant sur une frise de 16 s au plus, avec une ligne pour ce qui se passe entre deux images.', 'cinema-etape-2'],
  ['Un seul plan', 'LTX-2.5 tourne un plan continu qui passe par chaque image à son instant : ni coupe, ni fondu, et le son avec.'],
  ['La vitesse', 'Déplace une image clé : l’aperçu rejoue le plan plus vite ou plus lentement, en direct. Applique la vitesse, ou relance avec ces instants.', 'cinema-etape-4'],
]

/* En-tête : la moitié de l'écran, les séquences phares en fondu, un sélecteur de thème. */
function EnTeteCinema({ onCommencer, onComment }: { onCommencer: () => void; onComment: () => void }) {
  const [i, setI] = useState(0)
  const reduit = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return (
    <section className="cine-entete" aria-label="Movie Studio">
      {SEQUENCES.map((q, k) => (
        reduit ? <img key={q.id} src={q.affiche} alt="" className={k === i ? 'on' : ''} />
          // pas de boucle quand il y a plusieurs séquences : la fin de l'une lance la suivante
          : <video key={q.id} src={k === i ? q.video : undefined} poster={q.affiche} muted loop={SEQUENCES.length === 1} playsInline autoPlay className={k === i ? 'on' : ''}
            onEnded={() => setI(n => (n + 1) % SEQUENCES.length)} />
      ))}
      <div className="cine-entete-texte">
        <span className="dz-howto-surtitre">{t('Movie Studio')}</span>
        <h1>{t('Des images clés. Un seul plan.')}</h1>
        <p>{t('Règle tes images comme sur un tournage, pose-les sur une table de montage : un seul plan vidéo passe par chacune, à son instant.')}</p>
        <span className="puces-sous">{['FLUX 3', 'LTX-2.5', t('16 s'), t('Images clés minutées')].map(x => <em key={x}>{x}</em>)}</span>
        <div className="dz-howto-boutons">
          <button type="button" className="dz-howto-cta" onClick={onCommencer}>{t('Commencer')}<Ic n="chevron" s={14} /></button>
          <button type="button" className="dz-howto-cta2" onClick={onComment}><Ic n="help" s={14} />{t('Comment ça marche')}</button>
        </div>
      </div>
      {SEQUENCES.length > 1 && <div className="cine-entete-themes" role="tablist" aria-label={t('Séquences')}>
        {SEQUENCES.map((q, k) => <button key={q.id} type="button" role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => setI(k)}>{t(q.label)}</button>)}
      </div>}
    </section>
  )
}

const CLE_FICHE = 'creatoros.cinema.fiche'
const CLE_PRISES = 'creatoros.cinema.prises'
/** les stills d'un film chargé depuis la liste (pas forcément parmi les assets chargés) */
const CLE_PRISES_FILM = 'creatoros.cinema.prisesFilm'
/* Movie Studio s'ouvre vide : à la 1re ouverture d'une session, la fiche, les prises et la table repartent de zéro
   (le travail reste là tant qu'on navigue dans le studio ; un film de la liste le recharge). */
function ouvertureVide() {
  try {
    if (sessionStorage.getItem('cine:ouvert')) return
    sessionStorage.setItem('cine:ouvert', '1')
    for (const k of [CLE_FICHE, CLE_PRISES, CLE_PRISES_FILM]) localStorage.removeItem(k)
    localStorage.setItem('cine:table', JSON.stringify(TABLE_VIDE))
  } catch { /* stockage indisponible */ }
}
const lireJSON = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } }
const ecrireJSON = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* stockage indisponible */ } }
const FORMATS = ['9:16', '2:3', '1:1', '3:2', '16:9']

export function CinemaView({ onOpen, goVideo }: { onOpen: (a: Asset, list: Asset[]) => void; goVideo: () => void }) {
  useState(ouvertureVide)   // avant tout lecteur d'état (la table se lit à son montage, après ce parent)
  const ficheRef = useRef<HTMLDivElement>(null)
  const [comment, setComment] = useState(false)
  const reduitCine = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const s = useAppStore()
  const [f, setF] = useState<Fiche>(() => ({ ...FICHE_DEFAUT, ...lireJSON<Partial<Fiche>>(CLE_FICHE, {}) }))
  const [ligne, setLigne] = useState<string | null>(null)
  const [prises, setPrises] = useState<number>(2)
  const [balayage, setBalayage] = useState(false)
  const [format, setFormat] = useState('16:9')
  const [ids, setIds] = useState<string[]>(() => lireJSON<string[]>(CLE_PRISES, []))
  const [prisesFilm, setPrisesFilm] = useState<StillFilm[]>(() => lireJSON<StillFilm[]>(CLE_PRISES_FILM, []))
  const [mesFilms, setMesFilms] = useState<Film[]>(lireFilms)
  const [envoi, setEnvoi] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [voirPrompt, setVoirPrompt] = useState(false)
  const [choixPalette, setChoixPalette] = useState(false)
  useEffect(() => { ecrireJSON(CLE_FICHE, f) }, [f])
  useEffect(() => { ecrireJSON(CLE_PRISES, ids.slice(0, 60)) }, [ids])
  useEffect(() => { ecrireJSON(CLE_PRISES_FILM, prisesFilm.slice(0, 40)) }, [prisesFilm])
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
  // les stills du film chargé qui ne sont pas déjà parmi les prises rendues
  const stillsFilm = prisesFilm.filter(p => !rendues.some(a => a.id === p.id))

  /* « Recommencer » (table), liste des films, et chaque plan envoyé depuis la table qui devient un film */
  const etatRef = useRef({ f, rendues, stillsFilm })
  etatRef.current = { f, rendues, stillsFilm }
  useEffect(() => {
    const recommencer = () => { setF({ ...FICHE_DEFAUT }); setIds([]); setPrisesFilm([]) }
    const films = () => setMesFilms(lireFilms())
    const envoye = (ev: Event) => {
      const d = (ev as CustomEvent<{ jobId: string; table: Etat }>).detail
      const { f: fiche, rendues: r, stillsFilm: sf } = etatRef.current
      ajouterFilm({ id: d.jobId, nom: nomDeFilm(d.table), fiche, date: Date.now(), table: d.table,
        prises: [...sf, ...r.map(a => ({ id: a.id, uri: a.uri }))] })
    }
    window.addEventListener('cine:recommencer', recommencer)
    window.addEventListener('cine:films', films)
    window.addEventListener('cine:film-envoye', envoye)
    return () => { window.removeEventListener('cine:recommencer', recommencer); window.removeEventListener('cine:films', films); window.removeEventListener('cine:film-envoye', envoye) }
  }, [])
  /** Charge un film : sa fiche, ses prises, sa table (images clés, actions, personnage, clip). */
  const chargerFilm = (film: Film) => {
    setF({ ...FICHE_DEFAUT, ...film.fiche })
    setIds([])
    setPrisesFilm(film.prises)
    ouvrirDansTable({ ...TABLE_VIDE, ...film.table })
    ficheRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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
      {comment ? (
        <div className="cine-entete cine-entete-comment maille">
          <button type="button" className="cine-retour" onClick={() => setComment(false)}><Ic n="x" s={14} />{t('Fermer')}</button>
          <HowItWorks etapesSeules cleMemoire="hiw:cinema-jamais" reduit={reduitCine} labelHero={t('Western, un seul plan de 16 s')}
            titre={t('Des images clés au plan vidéo')} texte={t('Six images clés du western, posées sur la table de montage : LTX-2.5 en a fait ce plan de 16 s, d’un seul tenant.')}
            hero={{ ...howto('cinema').hero, video: v('cinema-hero.mp4'), affiche: v('cinema-hero.jpg') }}
            etapes={ETAPES_CINE.map(([ti, te, f], k) => ({ titre: t(ti), texte: t(te), ...(f ? { video: v(enLangue(`${f}.mp4`)), affiche: v(enLangue(`${f}.jpg`)) } : howto('cinema').etape(k + 1)) }))}
            onCommencer={() => { setComment(false); ficheRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} />
        </div>
      ) : (
        <EnTeteCinema onCommencer={() => ficheRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} onComment={() => setComment(true)} />
      )}
      <FilmsCinema films={[...mesFilms, ...FILMS_DU_STUDIO]} onCharger={chargerFilm} reduit={reduitCine} />
      <div ref={ficheRef} className="cine" style={{ maxWidth: 1240, margin: '0 auto', scrollMarginTop: 16 }}>
        <div className="cine-etape-tete">
          <span className="cine-num" aria-hidden>1</span>
          <div>
            <h2 className="titre-outil">{t('Les images clés')}</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Règle le plan comme sur un tournage — caméra, optique, lumière, pellicule, étalonnage. {nom} joue la scène ; chaque prise peut partir sur la table de montage.', { nom: s.personaName })}</div>
          </div>
        </div>

        <div className="cine-grille">
          <div className="carte-reel cine-fiche">
            <div className="flex gap-1.5 flex-wrap" style={{ marginBottom: 10 }}>
              <span className="text-[12px]" style={{ color: 'var(--faint)', alignSelf: 'center' }}>{t('Plans de départ')}</span>
              {DEPARTS.map(d => <button key={d.id} className="pill tool" onClick={() => setF(x => ({ ...x, ...d.fiche }))}>{t(d.label)}</button>)}
            </div>
            <ChoixPersonnage />
            <textarea className="cine-scene" value={f.scene} onChange={e => maj({ scene: e.target.value })} rows={2}
              placeholder={t('Une image fixe, en anglais : où elle est, ce qu’elle fait à cet instant. Le mouvement se règle à l’étape 2.')} />
            {/* un script vidéo collé ici (minutage, « secondes », plusieurs actions) : on dit où il va */}
            {/(\d+\s*[–-]\s*\d+\s*(s|sec|secondes?|seconds?)\b|\bsecondes?\b|\bseconds?\b|\bthen\b|\bpuis\b)/i.test(f.scene) && (
              <div className="cine-alerte" role="note">{t('Ça ressemble à un script vidéo. Ici, on crée des images fixes : décris un seul instant. Le déroulé (ce qui se passe, seconde par seconde) se met dans la table de montage, à l’étape 2.')}</div>
            )}
            <div className="flex items-center gap-2 flex-wrap" style={{ margin: '10px 0 4px' }}>
              <span className="cine-perso">
                {s.personaAvatar ? <img src={s.personaAvatar} alt="" /> : <span />}
                <span><small>{t('Personnage')}</small><b>{s.personaName}</b></span>
              </span>
              <span className="cine-palette">
                <small>{t('Palette')}</small>
                {f.palette.map((c, i) => <button key={i} title={t('retirer')} style={{ background: c }} onClick={() => maj({ palette: f.palette.filter((_, j) => j !== i) })} />)}
                {f.palette.length < 8 && <label className="cine-plus" title={t('ajouter une couleur')}>＋<input type="color" hidden onChange={e => maj({ palette: [...f.palette, e.target.value].slice(0, 8) })} /></label>}
                <button className="pill tool" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => setChoixPalette(true)}>{t('depuis une photo')}</button>
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
              <span className="text-[12px]" style={{ marginLeft: 6 }}>
                <button className={`spill ${s.photoEngine === 'flux3' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('flux3')}
                  title={s.personaFlux3 ? t('FLUX 3 Klein : le rendu le plus réaliste, avec la LoRA de {nom}', { nom: s.personaName }) : t('FLUX 3 Klein : le rendu le plus réaliste ; {nom} n’a pas de LoRA FLUX 3, son visage n’est pas tenu', { nom: s.personaName })}>FLUX 3 Klein</button>
                <button className={`spill ${s.photoEngine === 'krea' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('krea')}>Krea 2</button>
                {s.personaKlein && <button className={`spill ${s.photoEngine === 'klein' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('klein')}>FLUX.2 Klein</button>}
              </span>
              <span style={{ flex: 1 }} />
              <button className="cta" style={{ padding: '10px 20px', flexDirection: 'row' }} disabled={envoi} onClick={() => void tourner()}>
                {envoi ? '…' : <><Ic n="image" s={15} /> {t('Créer les images')}</>} <small style={{ marginLeft: 6 }}>{balayage ? 4 : prises} {t('prises')}</small>
              </button>
            </div>
            {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
            <button className="cine-voir" onClick={() => setVoirPrompt(!voirPrompt)}>{voirPrompt ? '▾' : '▸'} {t('Ce que lit le moteur')}</button>
            {voirPrompt && <div className="cine-prompt">{prompt}</div>}
          </div>

          <div className="cine-prises">
            <div className="text-[12px]" style={{ color: 'var(--faint)', marginBottom: 8, letterSpacing: '.08em', textTransform: 'uppercase' }}>{t('Prises')}</div>
            {!jobs.length && !rendues.length && !stillsFilm.length && <div style={{ color: 'var(--faint)', fontSize: 12, padding: '30px 6px' }}>{t('Les images apparaissent ici. Choisis un plan de départ, puis « Créer les images » ; pose les meilleures sur la table de montage.')}</div>}
            <div className="cine-pellicule">
              {jobs.map(j => <div key={j.id} className="cine-prise"><JobCard j={j} queueIds={queueIds} /></div>)}
              {rendues.map(a => (
                <div key={a.id} className="cine-prise">
                  <img src={a.uri} alt="" onClick={() => onOpen(a, rendues)} />
                  <div className="cine-actions">
                    <button className="pill" onClick={() => ajouterALaTable(a)} title={t('poser cette image sur la table de montage')}><Ic n="film" s={12} /> {t('Sur la table')}</button>
                    <button className="pill tool" onClick={() => { void s.animateFrom(a); goVideo() }}>▶ {t('Animer')}</button>
                    <button className="pill tool" onClick={() => void couleursDominantes(a.uri).then(p => maj({ palette: p }))}>{t('palette')}</button>
                  </div>
                </div>
              ))}
              {/* les images du film chargé */}
              {stillsFilm.map(p => (
                <div key={p.id} className="cine-prise">
                  <img src={p.uri} alt="" onClick={() => { const a = s.assets.find(x => x.id === p.id); if (a) onOpen(a, rendues) }} />
                  <div className="cine-actions">
                    <button className="pill" onClick={() => ajouterALaTable(p)} title={t('poser cette image sur la table de montage')}><Ic n="film" s={12} /> {t('Sur la table')}</button>
                    <button className="pill tool" onClick={() => void couleursDominantes(p.uri).then(c => maj({ palette: c }))}>{t('palette')}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="cine-video">
        <div className="cine-etape-tete">
          <span className="cine-num" aria-hidden>2</span>
          <div>
            <h2 className="titre-outil">{t('Le plan vidéo')}</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Les images clés sur une frise : LTX-2.5 en fait un seul plan, jusqu’à 16 s, qui passe par chacune à son instant.')}</div>
          </div>
        </div>
        {/* la lumière, la caméra et l'étalonnage de la fiche, sans la scène : ils valent pour tout le plan */}
        {/* sans la scène ni le cadrage : ce sont les images clés qui cadrent ; restent l'optique, la lumière, la pellicule, le look */}
        <TableMontage style={composerFiche({ ...f, scene: '' }).replace(PLANS.find(x => x.id === f.plan)?.prompt ?? '\u0000', '').replace(/^[.\s]+/, '').replace(/\.\s*\./g, '.')} />
      </div>
      {/* toutes les photos de la bibliothèque, et les photos importées */}
      <FramePicker open={choixPalette} onClose={() => setChoixPalette(false)} assets={s.assets} title={t('Palette depuis une photo')}
        onPickAsset={a => { void couleursDominantes(a.uri).then(p => maj({ palette: p })) }}
        onPickUpload={n => { void couleursDominantes(`/api/uploads/${encodeURIComponent(n)}`).then(p => maj({ palette: p })) }} />
    </div>
  )
}
