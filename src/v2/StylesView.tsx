/* Mosaïques d'Image : Styles (looks en un clic), Relight (un autre éclairage) et Expand (la photo élargie à
   un format). La galerie des cartes occupe la largeur (au survol, la photo d'origine revient : l'avant /
   après), un panneau compact à étapes reste visible : la photo, la carte, le bouton. Le rendu suit le
   chemin ordinaire (retouche Qwen-Image-Edit, ou agrandissement) et arrive dans l'onglet Rendus. */
import { useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import LOOKS from '../data/looks.json'
import MANIFESTE from '../data/apercus-mosaiques.json'
import { LUMIERES, FORMATS } from '../data/lumieres'
import { getLang, t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { Ic, failedJobs } from './bits'
import { FramePicker } from './popups'
import { useSuiviOutil } from './OutilPage'
import { ActionPanneau, Aucun, BarreGalerie, Carte, EtapesPanneau, RendusGalerie, memoireReglages, useCarteAuCentre, useMouvementReduit, useSurvolPossible } from './Galerie'
import { HowItWorks, howto } from './HowItWorks'

export type Mosaique = 'styles' | 'relight' | 'expand'
type CarteMosaique = { id: string; nom: string; famille?: string; consigne?: string; format?: string; style?: string }
type Onglet = 'galerie' | 'rendus'
type Reglages = { carte: string; assetId: string }
const FAMILLES = ['Dessin et 3D', 'Peinture', 'Cinéma et mise en scène', 'Portrait et produit', 'Retouche et couleur']
// aperçus présents dans public/vitrine/<mosaïque>/<id>.webp (liste tenue à jour à la pose des vignettes)
const APERCUS: Record<Mosaique, Set<string>> = {
  styles: new Set(MANIFESTE.styles), relight: new Set(MANIFESTE.relight), expand: new Set(MANIFESTE.expand),
}
/* La photo d'origine d'une vignette de Styles ou Relight, qui revient au survol : le renard pour la plupart,
   le portrait pour les styles de portrait et de tenue ; aucune pour celles faites d'après une autre photo. */
const PORTRAIT = new Set(['cafe60', 'clair-obscur', 'cv', 'peau', 'pro', 'pub', 'renaissance'])
const SANS_ORIGINE = new Set(['nuages', 'packshot', 'panneau', 'vitrine'])
const origine = (id: string) => SANS_ORIGINE.has(id) ? undefined
  : PORTRAIT.has(id) || id.startsWith('tenue') ? '/vitrine/v2-edit-a.webp' : '/vitrine/v2-renard.webp'

const TEXTES: Record<Mosaique, { titre: string; texte: string; onglet: string; carte: string; choisir: string; manque: string; bouton: string; chercher: string }> = {
  styles: { titre: 'Styles', texte: 'Choisis un style, choisis une photo : elle est redessinée ou rééclairée en un clic, le sujet et le cadrage restent.',
    onglet: 'Styles', carte: 'Style', choisir: 'Choisir un style', manque: 'Choisis un style dans la galerie.', bouton: 'Appliquer le style', chercher: 'Chercher un style' },
  relight: { titre: 'Relight', texte: 'Choisis une lumière, choisis une photo : le même instant sous un autre éclairage, rien d’autre ne change.',
    onglet: 'Lumières', carte: 'Lumière', choisir: 'Choisir une lumière', manque: 'Choisis une lumière dans la galerie.', bouton: 'Rééclairer', chercher: 'Chercher une lumière' },
  expand: { titre: 'Expand', texte: 'Choisis un format, choisis une photo : le cadre s’élargit et les bords sont inventés dans la continuité de la scène.',
    onglet: 'Formats', carte: 'Format', choisir: 'Choisir un format', manque: 'Choisis un format dans la galerie.', bouton: 'Élargir la photo', chercher: '' },
}

/* « Comment ça marche » (Styles et Relight) */
const HOWTO: Partial<Record<Mosaique, { cle: string; titre: string; texte: string; label: string; repli: string; etapes: [string, string][] }>> = {
  styles: {
    cle: 'styles', repli: '/vitrine/v2-briques.webp', label: 'Exemples de styles',
    titre: 'Ta photo, dans un autre style',
    texte: 'BD, manga, pâte à modeler, pixel ou peinture : le sujet et le cadrage restent, le style change.',
    etapes: [
      ['Choisis ta photo', 'Un portrait, un lieu ou un produit, pris dans ta bibliothèque.'],
      ['Choisis le style', 'Chaque vignette montre le style appliqué ; au survol, la photo d’origine revient.'],
      ['Reçois ta photo', 'Elle arrive dans Rendus et dans ta bibliothèque, prête à animer.'],
    ],
  },
  relight: {
    cle: 'relight', repli: '/vitrine/v2-neon.webp', label: 'Exemples d’éclairages',
    titre: 'La même photo, sous une autre lumière',
    texte: 'Fenêtre, studio, néons ou bougie : le même instant, rééclairé, et rien d’autre ne bouge.',
    etapes: [
      ['Choisis ta photo', 'Un portrait, un lieu ou un produit, pris dans ta bibliothèque.'],
      ['Choisis la lumière', 'Chaque vignette montre l’éclairage ; au survol, la photo d’origine revient.'],
      ['Reçois ta photo', 'Elle arrive dans Rendus et dans ta bibliothèque, prête à animer.'],
    ],
  },
}

export function StylesView({ mode = 'styles', goImage, onOpen }: { mode?: Mosaique; goImage?: () => void; onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil(`mosaique-${mode}`)
  const reglagesMem = useMemo(() => memoireReglages<Reglages>(`mosaique:${mode}:reglages`), [mode])
  const reduit = useMouvementReduit()
  const survolPossible = useSurvolPossible()
  const [onglet, setOnglet] = useState<Onglet>('galerie')
  const [filtre, setFiltre] = useState('tout')
  const [recherche, setRecherche] = useState('')
  const [choisi, setChoisi] = useState<CarteMosaique | null>(null)
  const [photo, setPhoto] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [picker, setPicker] = useState(false)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [reglages, setReglages] = useState(reglagesMem.lire)
  const [appel, setAppel] = useState(false)
  const galerie = useRef<HTMLElement | null>(null)
  const ancre = useRef<HTMLDivElement | null>(null)
  const panneau = useRef<HTMLElement | null>(null)
  const en = getLang() === 'en'
  const tx = TEXTES[mode]

  const cartes = useMemo<CarteMosaique[]>(() => {
    const ap = APERCUS[mode]
    const tri = (l: CarteMosaique[]) => l.sort((a, b) => Number(ap.has(b.id)) - Number(ap.has(a.id)))
    if (mode === 'relight') return tri(LUMIERES.map(l => ({ id: l.id, nom: t(l.label), consigne: l.consigne })))
    if (mode === 'expand') return FORMATS.map(f => ({ id: f.replace(/[^0-9a-z]/gi, ''), nom: f, format: f }))
    return tri((LOOKS as { id: string; label: string; en: string; consigne: string; famille: string; style?: string }[])
      .map(l => ({ id: l.id, nom: en ? l.en : l.label, famille: l.famille, consigne: l.consigne, style: l.style })))
  }, [mode, en])

  const changerOnglet = (o: Onglet) => {
    setOnglet(o)
    const g = galerie.current; const haut = o === 'rendus' ? 0 : ancre.current?.offsetTop ?? 0
    if (g && g.scrollTop > haut) g.scrollTo({ top: haut })
  }
  const commencer = () => {
    ancre.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' })
    const cible = panneau.current?.querySelector<HTMLElement>('.dz-etape.prochaine') ?? panneau.current?.querySelector<HTMLElement>('.dz-action .cta:not(:disabled)')
    cible?.focus({ preventScroll: true })
    setAppel(true); window.setTimeout(() => setAppel(false), 1600)
  }

  /* Le même rendu qu'avant : agrandissement pour un format, sinon retouche avec la consigne (et la LoRA du style). */
  const lancer = async (c: CarteMosaique, a: Asset) => {
    setOccupe(true); setMsg(null)
    try {
      let job: string | null = null
      if (c.format) {
        const r = await fetch(`/api/assets/${encodeURIComponent(a.id)}/agrandir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: c.format }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
        job = d.jobId ?? null
        if (job) void s.adoptServerJob(job)
      } else {
        await s.retouchFrom(a)
        s.setUserPrompt(c.consigne ?? '')
        // un style à LoRA : le serveur la charge d'après cet id
        s.updatePhoto({ editStyle: c.style ?? null })
        useAppStore.setState({ promptTouched: true, composedPositive: '' })
        try { await s.submitJob() } finally { s.updatePhoto({ editStyle: null }) }
        job = useAppStore.getState().jobs[0]?.id ?? null
      }
      if (job) { reglagesMem.noter(job, { carte: c.id, assetId: a.id }); setReglages(reglagesMem.lire()); suivi.ajouter([job]) }
      changerOnglet('rendus')
    } catch (e) { setMsg(String((e as Error).message || e)) }
    setOccupe(false)
  }

  const enCours = s.jobs.filter(j => suivi.ids.has(j.id) && STATUTS_ACTIFS.includes(j.status))
  const echecs = failedJobs(s.jobs, false).filter(j => suivi.ids.has(j.id))
  const livres = s.assets.filter(a => a.jobId && suivi.ids.has(String(a.jobId))).slice(0, 60)

  const q = recherche.trim().toLowerCase()
  const vues = cartes.filter(c => (filtre === 'tout' || c.famille === filtre) && (!q || c.nom.toLowerCase().includes(q)))
  const puces = mode === 'styles' ? FAMILLES.map(f => ({ id: f, label: f, n: cartes.filter(c => c.famille === f).length })).filter(p => p.n > 0) : []
  // sur écran tactile, rien ne joue tout seul : la vignette au centre garderait la photo d'origine au lieu du style
  const centre = useCarteAuCentre(false, [onglet, filtre, q])
  const image = (c: CarteMosaique) => APERCUS[mode].has(c.id) ? `/vitrine/${mode}/${c.id}.webp` : undefined

  const pret = !!choisi && !!photo?.asset && !occupe
  const manque = !photo?.asset ? (photo?.fichier ? t('Choisis une photo de la bibliothèque.') : t('Choisis d’abord ta photo.')) : !choisi ? t(tx.manque) : null
  const prochaine = !photo?.asset ? 1 : !choisi ? 2 : 0
  const h = HOWTO[mode]
  const fichiers = h ? howto(h.cle) : null
  const photos = s.assets.filter(a => a.mediaType === 'photo' && !a.modele3d)
  const imageChoisie = choisi ? image(choisi) : undefined

  return (
    <div className="dz">
      <aside ref={panneau} className={`dz-panneau ${appel ? 'appel' : ''}`} aria-label={t(tx.titre)}>
        <header className="dz-tete">
          <h2 className="titre-outil">{tx.titre}</h2>
          <p>{t(tx.texte)}</p>
        </header>

        <EtapesPanneau prochaine={prochaine} etapes={[
          { n: 1, label: t('Photo'), valeur: photo?.asset ? t('Photo choisie') : t('Choisir une photo'), fait: !!photo?.asset, icone: 'image',
            vignette: photo?.asset?.uri ?? photo?.apercu, ouvrir: () => setPicker(true) },
          { n: 2, label: t(tx.carte), valeur: choisi ? choisi.nom : t(tx.choisir), fait: !!choisi, icone: 'grid',
            vignette: imageChoisie, fixe: true, carree: true, ouvrir: () => changerOnglet('galerie'), courant: onglet === 'galerie' },
        ]} />

        <div className="dz-apercu">
          <figure className="carree">
            {choisi
              ? (imageChoisie ? <img key={choisi.id} src={imageChoisie} alt="" /> : <span className="dz-carte-lettre" aria-hidden>{choisi.format ?? choisi.nom.slice(0, 1)}</span>)
              : <button type="button" className="dz-apercu-vide" onClick={() => changerOnglet('galerie')}><span className="vide-icone"><Ic n="grid" s={22} /></span>{t(tx.choisir)}</button>}
            <figcaption>{choisi ? choisi.nom : t(tx.carte)}</figcaption>
          </figure>
          <figure className="carree">
            {photo?.asset || photo?.apercu
              ? <img key={photo.asset?.id ?? photo.apercu} src={photo.asset?.uri ?? photo.apercu} alt="" />
              : <button type="button" className="dz-apercu-vide" onClick={() => setPicker(true)}><span className="vide-icone"><Ic n="image" s={22} /></span>{t('Choisir une photo')}</button>}
            <figcaption>{t('Ta photo')}</figcaption>
          </figure>
        </div>

        <ActionPanneau id={`mosaique-${mode}`} nbEnCours={enCours.length} onVoirRendus={onglet !== 'rendus' ? () => changerOnglet('rendus') : undefined}
          options={false} onOptions={() => {}} avecOptions={false} pret={pret} onLancer={() => { if (choisi && photo?.asset) void lancer(choisi, photo.asset) }}
          label={occupe ? t('Envoi…') : t(tx.bouton)} manque={manque} msg={msg} />
      </aside>

      <section className="dz-galerie" ref={galerie} aria-label={t('Galerie')}>
        {onglet === 'galerie' && h && fichiers && (
          <HowItWorks key={h.cle} cleMemoire={`hiw:${h.cle}`} reduit={reduit} onCommencer={commencer}
            hero={{ ...fichiers.hero, repli: h.repli }} labelHero={t(h.label)} titre={t(h.titre)} texte={t(h.texte)}
            etapes={h.etapes.map(([ti, te], i) => ({ titre: t(ti), texte: t(te), ...(i === h.etapes.length - 1 ? { ...fichiers.hero, repli: h.repli } : fichiers.etape(i + 1)) }))} />
        )}
        <div ref={ancre} className="dz-ancre" aria-hidden />
        <BarreGalerie<Onglet> onglet={onglet} onOnglet={changerOnglet}
          onglets={[{ cle: 'galerie', label: t(tx.onglet), n: cartes.length }, { cle: 'rendus', label: t('Rendus'), n: livres.length + enCours.length, enCours: enCours.length }]}
          recherche={recherche} onRecherche={onglet === 'galerie' && tx.chercher ? setRecherche : undefined} placeholder={t(tx.chercher)}
          puces={onglet === 'galerie' ? puces : []} filtre={filtre} onFiltre={setFiltre} />

        {onglet === 'rendus' ? (
          <RendusGalerie photo enCours={enCours} echecs={echecs} livres={livres} onOpen={onOpen}
            legende={a => { const r = reglages[String(a.jobId)]; const c = r && cartes.find(x => x.id === r.carte); return { titre: c ? c.nom : tx.titre } }}
            gestes={a => { const r = reglages[String(a.jobId)]; const c = r && cartes.find(x => x.id === r.carte); const src = r && s.assets.find(x => x.id === r.assetId); return <>
              {goImage && <button type="button" className="pill" onClick={goImage}>{t('Aller à Image')}</button>}
              {c && src && <button type="button" className="pill" disabled={occupe} onClick={() => void lancer(c, src)}><Ic n="refresh" s={13} />{t('Refaire')}</button>}
            </> }}
            vide={<div className="dz-etat"><b>{t('Tes rendus apparaîtront ici.')}</b>
              <button type="button" className="pill" onClick={() => changerOnglet('galerie')}>{t(tx.choisir)}</button></div>} />
        ) : (
          <div className="dz-grille dz-grille-carree" ref={centre.racine}>
            {vues.map(c => {
              const img = image(c)
              return <Carte key={c.id} cle={c.id} titre={c.nom} detail={mode === 'styles' && filtre === 'tout' && c.famille ? t(c.famille) : undefined}
                fixe={img} apres={img && mode !== 'expand' ? origine(c.id) : undefined} lettre={c.format ?? c.nom.slice(0, 1)} carree
                choisie={choisi?.id === c.id} auCentre={centre.cle === c.id} survolPossible={survolPossible} reduit={reduit} onChoisir={() => setChoisi(c)} />
            })}
            {vues.length === 0 && <Aucun onEffacer={() => { setRecherche(''); setFiltre('tout') }} texte={t('Aucun style ne correspond.')} />}
          </div>
        )}
      </section>

      <FramePicker open={picker} onClose={() => setPicker(false)} title={t('Choisis ta photo')} media="photo" assets={photos}
        onPickAsset={a => { setPhoto({ asset: a }); setPicker(false) }}
        onPickUpload={n => { setPhoto({ fichier: n, apercu: `/api/uploads/${encodeURIComponent(n)}` }); setPicker(false) }} />
    </div>
  )
}
