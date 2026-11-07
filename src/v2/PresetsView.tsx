/* ============================================================
   Camera Moves et Effects : la galerie des presets occupe la largeur (cartes 9:16, aperçu au survol),
   un panneau de création compact reste visible (colonne à gauche sur bureau, barre en bas sur
   téléphone) : la photo, le mouvement ou l'effet, la durée, le bouton. Le clip part dans la file de
   rendu ordinaire et arrive dans l'onglet Rendus et la bibliothèque. Les presets vivent côté serveur
   (server/presets.js) ; ici on choisit et on lance.
   ============================================================ */
import { APERCUS, ApercuOutil } from './Apercus'
import type { IdOutil } from './OutilsDedies'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { getLang, t, tServeur } from '../i18n'
import { Ic, failedJobs } from './bits'
import { FramePicker } from './popups'
import { useSuiviOutil } from './OutilPage'
import { ActionPanneau, Aucun, BarreGalerie, Carte, EtapesPanneau, RendusGalerie, Squelettes, memoireReglages, useCarteAuCentre, useMouvementReduit, useSurvolPossible } from './Galerie'
import { HowItWorks, howto } from './HowItWorks'

interface Preset { id: string; famille: 'camera' | 'effet'; nom: string; nomEn: string; icone: string; lora: string | null; apercu: string | null; moteur: 'ltx_hq' | 'wan21' | 'wan21_hq' | 'wan_funcam'; deuxRendus?: boolean }
type Famille = 'camera' | 'effet'
type Onglet = Famille | 'clip' | 'rendus'
type Reglages = { presetId: string; assetId: string; detail: string; duree: number }
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

/* Familles de presets, par identifiant ; un preset inconnu reste visible sous « Tout ». */
const GROUPES: Record<Famille, { id: string; label: string; ids: string[] }[]> = {
  camera: [
    { id: 'pousser', label: 'Avant et arrière', ids: ['push-in', 'pull-out', 'crash-zoom', 'crash-zoom-out', 'dolly-zoom'] },
    { id: 'orbite', label: 'Autour du sujet', ids: ['orbite', 'arc', 'bullet-time'] },
    { id: 'grue', label: 'Grue et drone', ids: ['drone', 'jib-down', 'grue-haute'] },
    { id: 'suivi', label: 'Suivi et pano', ids: ['travelling-lateral', 'panoramique', 'epaule', 'fixe-vivant'] },
  ],
  effet: [
    { id: 'forme', label: 'Formes', ids: ['squish', 'inflate', 'deflate', 'crush', 'cakeify', 'rotate'] },
    { id: 'spectacle', label: 'Spectacle', ids: ['explode', 'electrify', 'robot', 'jaw-drop'] },
  ],
}

/* Aperçus de la galerie : image fixe et clip léger, préparés à côté des fichiers de la page Danse et
   nommés d'après la version de l'aperçu ; s'ils manquent, l'aperçu complet du serveur prend le relais. */
const version = (p: Preset) => p.apercu?.split('v=')[1] ?? '0'
const urlFixe = (p: Preset) => `/danses/presets/${p.id}-${version(p)}.webp`
const urlLeger = (p: Preset) => `/danses/presets/${p.id}-${version(p)}.mp4`
const duréesDe = (p: Preset) => p.moteur.startsWith('wan21') || p.moteur === 'wan_funcam' ? [3, 4, 5] : [4, 5, 6, 8]
const minutesDe = (p: Preset) => p.moteur === 'wan21_hq' ? 8 : p.moteur === 'wan_funcam' ? 5 : null
const moteurDe = (p: Preset) => p.moteur === 'wan_funcam' ? t('Wan 2.2 Fun Camera · trajectoire de caméra · muet · ~5 min') : p.moteur === 'wan21_hq' ? t('Wan 2.1 · LoRA dédiée · muet · ~8 min')
  : p.moteur === 'wan21' ? t('Wan 2.1 · LoRA dédiée · muet') : p.deuxRendus ? t('LTX-2.5 puis Wan 2.2 · deux rendus, le second finit sur ta photo') : `LTX-2.5 · ${t('avec le son')}${p.lora ? ' · LoRA' : ''}`

/* Outils sur un clip : la même vignette qu'à l'accueil (vrais rendus), un clic ouvre la page de l'outil. */
const OUTILS_CLIP: { label: string; texte: string; dedie?: IdOutil }[] = [
  { label: 'Remove Objects', texte: 'Retire une personne ou un objet du clip : le décor derrière est reconstitué.', dedie: 'remove-objects' },
  { label: 'Change Background', texte: 'Le sujet reste, le décor du clip change : décris le nouveau.', dedie: 'change-bg' },
  { label: 'Green Screen', texte: 'SAM3 garde le sujet, rien n’est redessiné.', dedie: 'green-screen' },
  { label: 'Add Sound', texte: 'Le clip reçoit son ambiance et ses bruitages, générés d’après l’image (LTX-2.5).', dedie: 'add-sound' },
  { label: 'Smooth Motion', texte: 'RIFE double les images : le mouvement passe à 48 i/s, plus fluide.', dedie: 'smooth' },
  { label: 'Upscale 1080p', texte: 'SeedVR2 monte le clip en 1080p.', dedie: 'upscale-1080' },
  { label: 'Extend Video', texte: 'Le clip continue : quelques secondes de plus, dans le même mouvement.' },
]

/* « Comment ça marche », par famille */
const HOWTO: Record<Famille, { cle: string; titre: string; texte: string; label: string; repli: string; etapes: [string, string][] }> = {
  camera: {
    cle: 'camera', repli: '/vitrine/camera-w.webp', label: 'Exemples de mouvements de caméra',
    titre: 'Un mouvement de cinéma sur n’importe quelle photo',
    texte: 'Une photo, un mouvement : dolly, orbite, crash zoom ou drone, tu reçois un vrai plan de cinéma.',
    etapes: [
      ['Choisis ta photo', 'Un personnage, un lieu ou un produit, pris dans ta bibliothèque.'],
      ['Choisis le mouvement', 'Chaque aperçu montre le mouvement exact de la caméra.'],
      ['Règle la durée', 'Quelques secondes, et si tu veux ce qui se passe pendant le plan.'],
      ['Reçois ton clip', 'Il arrive dans Rendus et dans ta bibliothèque, prêt à monter.'],
    ],
  },
  effet: {
    cle: 'effets', repli: '/vitrine/effets-z.webp', label: 'Exemples d’effets',
    titre: 'Un effet viral en un clic',
    texte: 'Une photo, un effet : elle gonfle, s’écrase, explose ou s’électrise, en un vrai clip.',
    etapes: [
      ['Choisis ta photo', 'Un personnage, un animal ou un objet, pris dans ta bibliothèque.'],
      ['Choisis l’effet', 'Chaque aperçu montre l’effet exact, du début à la fin.'],
      ['Règle la durée', 'Quelques secondes, et si tu veux ce qui se passe pendant le plan.'],
      ['Reçois ton clip', 'Il arrive dans Rendus et dans ta bibliothèque, prêt à publier.'],
    ],
  },
}

/* La famille à l'ouverture : demandée par le menu, sinon par l'adresse (?f=effet, sur téléphone aussi). */
const familleDemandee = (): Famille => {
  const f = useAppStore.getState().famillePresets ?? new URLSearchParams(window.location.search).get('f')
  return f === 'effet' ? 'effet' : 'camera'
}
const CLE_CHOIX = 'presets:choix'
const lireChoix = (): Partial<Record<Famille, string>> => { try { return JSON.parse(localStorage.getItem(CLE_CHOIX) ?? '{}') } catch { return {} } }
const REGLAGES = memoireReglages<Reglages>('presets:reglages')

export function PresetsView({ goVideo, onOpen }: { goVideo: () => void; onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('presets')
  const reduit = useMouvementReduit()
  const survolPossible = useSurvolPossible()
  const [presets, setPresets] = useState<Preset[]>([])
  const [etat, setEtat] = useState<'charge' | 'pret' | 'erreur'>('charge')
  const [onglet, setOnglet] = useState<Onglet>(familleDemandee)
  const [famille, setFamille] = useState<Famille>(familleDemandee)
  const [choix, setChoix] = useState<Partial<Record<Famille, string>>>(lireChoix)
  const [photo, setPhoto] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [picker, setPicker] = useState(false)
  const [detail, setDetail] = useState('')
  const [duree, setDuree] = useState(5)
  const [options, setOptions] = useState(false)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [filtre, setFiltre] = useState('tout')
  const [recherche, setRecherche] = useState('')
  const [reglages, setReglages] = useState(REGLAGES.lire)
  const [appel, setAppel] = useState(false)
  const galerie = useRef<HTMLElement | null>(null)
  const ancre = useRef<HTMLDivElement | null>(null)
  const panneau = useRef<HTMLElement | null>(null)

  const charger = () => {
    setEtat('charge')
    void fetch('/api/presets').then(json).then(d => { setPresets(d.presets ?? []); setEtat('pret') }).catch(() => setEtat('erreur'))
  }
  useEffect(charger, [])
  // « Utiliser dans… » depuis la visionneuse : la photo est déjà choisie, il reste le mouvement
  useEffect(() => { const a = useAppStore.getState().prendrePasserelle('presets'); if (a) setPhoto({ asset: a }) }, [])
  useEffect(() => { try { localStorage.setItem(CLE_CHOIX, JSON.stringify(choix)) } catch { /* stockage indisponible */ } }, [choix])

  // changer d'onglet ramène en haut de la galerie, sous « Comment ça marche » (jamais au-dessus)
  const changerOnglet = (o: Onglet) => {
    setOnglet(o); setFiltre('tout'); setRecherche('')
    if (o === 'camera' || o === 'effet') setFamille(o)
    const g = galerie.current; const haut = o === 'rendus' || o === 'clip' ? 0 : ancre.current?.offsetTop ?? 0
    if (g && g.scrollTop > haut) g.scrollTo({ top: haut })
  }
  // le menu ouvre Camera Moves ou Effects : la galerie suit, à l'ouverture comme déjà ouverte
  const demandee = useAppStore(st => st.famillePresets)
  useEffect(() => { if (demandee) { changerOnglet(demandee); useAppStore.setState({ famillePresets: null }) } }, [demandee]) // eslint-disable-line react-hooks/exhaustive-deps

  const nom = (p: Preset) => getLang() === 'en' ? p.nomEn : p.nom
  const preset = presets.find(p => p.id === choix[famille] && p.famille === famille) ?? null
  const durees = preset ? duréesDe(preset) : [3, 4, 5]
  useEffect(() => { if (preset && !duréesDe(preset).includes(duree)) setDuree(5) }, [preset, duree])

  const commencer = () => {
    ancre.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' })
    const cible = panneau.current?.querySelector<HTMLElement>('.dz-etape.prochaine') ?? panneau.current?.querySelector<HTMLElement>('.dz-action .cta:not(:disabled)')
    cible?.focus({ preventScroll: true })
    setAppel(true); window.setTimeout(() => setAppel(false), 1600)
  }

  const lancer = async (r: Reglages) => {
    setOccupe(true); setMsg(null)
    try {
      const d = await json(await fetch(`/api/presets/${r.presetId}/lancer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: r.assetId, detail: r.detail, duree: r.duree }) }))
      REGLAGES.noter(d.jobId, r); setReglages(REGLAGES.lire())
      suivi.ajouter([d.jobId]); void s.adoptServerJob(d.jobId)
      changerOnglet('rendus')
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  const pret = !!preset && !!photo?.asset && !occupe
  const generer = () => { if (preset && photo?.asset) void lancer({ presetId: preset.id, assetId: photo.asset.id, detail, duree }) }

  // les rendus de la page (un preset à deux passes livre sous un id dérivé du premier)
  const suiviDe = (id: string) => suivi.ids.has(id) || [...suivi.ids].some(x => id.startsWith(`${x}-`))
  const enCours = s.jobs.filter(j => suiviDe(j.id) && STATUTS_ACTIFS.includes(j.status))
  const echecs = failedJobs(s.jobs, true).filter(j => suiviDe(j.id))
  const livres = s.assets.filter(a => a.jobId && suiviDe(String(a.jobId))).slice(0, 60)
  const reglagesDe = (a: Asset) => reglages[String(a.jobId)] ?? Object.entries(reglages).find(([k]) => String(a.jobId).startsWith(`${k}-`))?.[1]

  // la galerie de l'onglet, filtrée par groupe et par recherche
  const q = recherche.trim().toLowerCase()
  const liste = presets.filter(p => p.famille === famille)
  const vus = useMemo(() => liste.filter(p => (filtre === 'tout' || GROUPES[famille].find(g => g.id === filtre)?.ids.includes(p.id))
    && (!q || p.nom.toLowerCase().includes(q) || p.nomEn.toLowerCase().includes(q))), [liste, filtre, q, famille])
  const puces = onglet === 'camera' || onglet === 'effet'
    ? GROUPES[famille].map(g => ({ id: g.id, label: g.label, n: liste.filter(p => g.ids.includes(p.id)).length })).filter(p => p.n > 0) : []
  const centre = useCarteAuCentre(!survolPossible && !reduit && (onglet === 'camera' || onglet === 'effet'), [onglet, filtre, q, etat])

  const manque = !photo?.asset ? (photo?.fichier ? t('Choisis une photo de la bibliothèque.') : t('Choisis d’abord la photo à animer.'))
    : !preset ? (famille === 'effet' ? t('Choisis un effet dans la galerie.') : t('Choisis un mouvement dans la galerie.')) : null
  const prochaine = !photo?.asset ? 1 : !preset ? 2 : 0
  const h = HOWTO[famille]
  const fichiers = howto(h.cle)
  const titre = famille === 'effet' ? 'Effects' : 'Camera Moves'
  const minutes = preset ? minutesDe(preset) : null

  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected' && !a.modele3d)
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt).slice(0, 120), [s.assets])

  return (
    <div className="dz">
      <aside ref={panneau} className={`dz-panneau ${options ? 'options-ouvertes' : ''} ${appel ? 'appel' : ''}`} aria-label={famille === 'effet' ? t('Créer un effet') : t('Créer un mouvement de caméra')}>
        <header className="dz-tete">
          <h2 className="titre-outil">{titre}</h2>
          <p>{famille === 'effet' ? t('Une photo, un effet : elle s’anime en un clip viral.') : t('Une photo, un mouvement de caméra : elle devient un plan de cinéma.')}</p>
        </header>

        <EtapesPanneau prochaine={prochaine} etapes={[
          { n: 1, label: t('Photo'), valeur: photo?.asset ? t('Photo choisie') : t('Choisir une photo'), fait: !!photo?.asset, icone: 'image',
            vignette: photo?.asset?.uri ?? photo?.apercu, ouvrir: () => setPicker(true) },
          { n: 2, label: famille === 'effet' ? t('Effet') : t('Mouvement'), valeur: preset ? nom(preset) : famille === 'effet' ? t('Choisir un effet') : t('Choisir un mouvement'),
            fait: !!preset, vignette: preset ? urlFixe(preset) : undefined, fixe: true, ouvrir: () => changerOnglet(famille), courant: onglet === famille },
        ]} />

        {/* le preset et la photo choisis, en grand : l'aperçu joue */}
        <div className="dz-apercu">
          <figure>
            {preset?.apercu
              ? <video key={preset.id} src={preset.apercu} poster={urlFixe(preset)} muted loop playsInline {...(reduit ? { controls: true, preload: 'none' } : { autoPlay: true })} />
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet(famille)}>{famille === 'effet' ? t('Choisir un effet') : t('Choisir un mouvement')}</button>}
            <figcaption>{preset ? nom(preset) : famille === 'effet' ? t('Effet') : t('Mouvement')}</figcaption>
          </figure>
          <figure>
            {photo?.asset || photo?.apercu
              ? <img key={photo.asset?.id ?? photo.apercu} src={photo.asset?.uri ?? photo.apercu} alt="" />
              : <button type="button" className="dz-apercu-vide" onClick={() => setPicker(true)}>{t('Choisir une photo')}</button>}
            <figcaption>{t('Ta photo')}</figcaption>
          </figure>
        </div>

        <div className="dz-options" id="presets-options">
          {options || detail
            ? <label className="dz-champ">
                <span>{t('Ce qui se passe pendant le plan (facultatif, en anglais)')}</span>
                <textarea rows={2} value={detail} maxLength={300} onChange={e => setDetail(e.target.value)} placeholder={t('ex. : elle sourit et remet ses cheveux en place')} />
              </label>
            : <button type="button" className="dz-ajout" onClick={() => setOptions(true)}>+ {t('Ce qui se passe pendant le plan (facultatif, en anglais)')}</button>}
          <div className="dz-champ">
            <span>{t('Durée')}</span>
            <div className="dz-segments" role="group" aria-label={t('Durée')}>
              {durees.map(k => <button key={k} type="button" aria-pressed={duree === k} className={duree === k ? 'on' : ''} onClick={() => setDuree(k)}>{t('{n} s', { n: k })}</button>)}
            </div>
            {preset && <small className="dz-note">{moteurDe(preset)}</small>}
          </div>
        </div>

        <ActionPanneau id="presets" nbEnCours={new Set(enCours.map(j => j.id)).size} onVoirRendus={onglet !== 'rendus' ? () => changerOnglet('rendus') : undefined}
          options={options} onOptions={() => setOptions(o => !o)} pret={pret} onLancer={generer}
          label={occupe ? t('Envoi…') : t('Animer')} detail={`${minutes ? `~${t('{m} min', { m: minutes })} · ` : ''}${t('{n} s', { n: duree })}`}
          manque={manque} msg={msg} />
      </aside>

      <section className="dz-galerie" ref={galerie} aria-label={t('Galerie')}>
        {(onglet === 'camera' || onglet === 'effet') && (
          <HowItWorks key={h.cle} cleMemoire={`hiw:${h.cle}`} reduit={reduit} onCommencer={commencer}
            hero={{ ...fichiers.hero, repli: h.repli }} labelHero={t(h.label)} titre={t(h.titre)} texte={t(h.texte)}
            etapes={h.etapes.map(([ti, tx], i) => ({ titre: t(ti), texte: t(tx), ...(i === 3 ? { ...fichiers.hero, repli: h.repli } : fichiers.etape(i + 1)) }))} />
        )}
        <div ref={ancre} className="dz-ancre" aria-hidden />
        <BarreGalerie<Onglet> onglet={onglet} onOnglet={changerOnglet}
          onglets={[
            { cle: 'camera', label: t('Mouvements de caméra'), n: presets.filter(p => p.famille === 'camera').length },
            ...(presets.some(p => p.famille === 'effet') || etat !== 'pret' ? [{ cle: 'effet' as const, label: t('Effets'), n: presets.filter(p => p.famille === 'effet').length }] : []),
            { cle: 'clip', label: t('Sur un clip') },
            { cle: 'rendus', label: t('Rendus'), n: livres.length + enCours.length, enCours: enCours.length },
          ]}
          recherche={recherche} onRecherche={onglet === 'camera' || onglet === 'effet' ? setRecherche : undefined}
          placeholder={onglet === 'effet' ? t('Chercher un effet') : t('Chercher un mouvement')}
          puces={puces} filtre={filtre} onFiltre={setFiltre} />

        {onglet === 'clip' ? (
          <div className="dz-grille-outils">
            {OUTILS_CLIP.map(o => (
              <button key={o.label} type="button" className="dz-outil" onClick={() => {
                if (!o.dedie) { useAppStore.getState().updateVideo({ task: 'extend' }); goVideo(); return }
                useAppStore.setState(st => ({ outilDedie: o.dedie!, navRequest: { section: 'outil', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))
              }}>
                <span className="dz-outil-media"><ApercuOutil apercu={APERCUS[o.label]} /></span>
                <span className="dz-outil-texte"><b>{o.label}</b><span>{t(o.texte)}</span></span>
              </button>
            ))}
          </div>
        ) : onglet === 'rendus' ? (
          <RendusGalerie enCours={enCours} echecs={echecs} livres={livres} onOpen={onOpen}
            legende={a => { const r = reglagesDe(a); const p = r && presets.find(x => x.id === r.presetId); return { titre: p ? nom(p) : titre, detail: r ? t('{n} s', { n: r.duree }) : undefined } }}
            gestes={a => { const r = reglagesDe(a); return <>
              <button type="button" className="pill" onClick={goVideo}>{t('Aller à Vidéo')}</button>
              {r && <button type="button" className="pill" disabled={occupe} onClick={() => void lancer(r)}><Ic n="refresh" s={13} />{t('Refaire')}</button>}
            </> }}
            vide={<div className="dz-etat"><b>{t('Tes rendus apparaîtront ici.')}</b>
              <button type="button" className="pill" onClick={() => changerOnglet(famille)}>{famille === 'effet' ? t('Choisir un effet') : t('Choisir un mouvement')}</button></div>} />
        ) : etat === 'erreur' ? (
          <div className="dz-etat">
            <b>{t('Le catalogue des presets ne répond pas.')}</b>
            <button type="button" className="pill" onClick={charger}>{t('Réessayer')}</button>
          </div>
        ) : (
          <div className="dz-grille" ref={centre.racine}>
            {etat === 'charge' ? <Squelettes n={10} /> : vus.map(p => (
              <Carte key={p.id} cle={p.id} titre={nom(p)} detail={p.moteur === 'ltx_hq' ? t('avec le son') : undefined}
                fixe={urlFixe(p)} video={urlLeger(p)} secours={p.apercu ?? undefined}
                choisie={preset?.id === p.id} auCentre={centre.cle === p.id} survolPossible={survolPossible} reduit={reduit}
                onChoisir={() => setChoix(c => ({ ...c, [famille]: p.id }))} />
            ))}
            {etat === 'pret' && vus.length === 0 && <Aucun onEffacer={() => { setRecherche(''); setFiltre('tout') }} texte={t('Aucun preset ne correspond.')} />}
          </div>
        )}
      </section>

      <FramePicker open={picker} onClose={() => setPicker(false)} title={t('Choisis la photo à animer')} media="photo" assets={photos}
        onPickAsset={a => { setPhoto({ asset: a }); setPicker(false) }}
        onPickUpload={n => { setPhoto({ fichier: n, apercu: `/api/uploads/${encodeURIComponent(n)}` }); setPicker(false) }} />
    </div>
  )
}
