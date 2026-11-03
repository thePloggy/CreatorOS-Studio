/* Extensions : les fonctions ajoutées au studio sans code (cf. server/extensions.js), avec leur
   formulaire, et le catalogue d'où le propriétaire en installe de nouvelles. */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { FramePicker } from './popups'
import { AssetCard, JobCard } from './bits'
import { useSuiviOutil } from './OutilPage'

type Entree = { id: string; type: 'texte' | 'nombre' | 'choix' | 'image'; label: string; defaut: unknown; options?: string[]; min?: number; max?: number; aide?: string }
type Extension = { id: string; nom: string; description: string; auteur: string; licence: string; version: string; sortie: 'image' | 'video' | 'audio'; source: 'livree' | 'installee'; apercu?: string | null; entrees: Entree[]; manque: { noeuds: string[]; modeles: string[] } }
type Fiche = { id: string; nom: string; description: string; auteur: string; licence: string; sortie: string; installee: boolean; apercu?: string | null }

const poster = async (url: string, corps?: object) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps ?? {}) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
  return d
}

/* Page d'une extension, au gabarit app : formulaire à gauche, exemple puis résultats à droite. */
function AppExtension({ x, onRetour, onRetirer, onOpen }: { x: Extension; onRetour: () => void; onRetirer: () => void; onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const suivi = useSuiviOutil(`ext-${x.id}`)
  const [valeurs, setValeurs] = useState<Record<string, unknown>>(() => Object.fromEntries(x.entrees.map(e => [e.id, e.defaut ?? (e.type === 'nombre' ? e.min ?? 0 : '')])))
  const [choix, setChoix] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; txt: string } | null>(null)
  const [occupe, setOccupe] = useState(false)
  const bloquee = x.manque.noeuds.length + x.manque.modeles.length > 0 || (x.source === 'installee' && !edition)
  const maj = (k: string, v: unknown) => setValeurs(o => ({ ...o, [k]: v }))
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try {
      const d = await poster(`/api/extensions/${x.id}/lancer`, { valeurs }) as { id: string }
      suivi.ajouter([d.id]); await s.adoptServerJob(d.id)
      setMsg({ ok: true, txt: x.sortie === 'audio' ? t('en cours : le son arrive dans Musique et voix') : t('en cours : le résultat arrive ci-contre') })
    } catch (e) { setMsg({ ok: false, txt: String((e as Error).message) }) }
    setOccupe(false)
  }
  const photo = (id: string) => s.assets.find(a => a.id === id)
  const enCours = s.jobs.filter(j => suivi.ids.has(j.id) && !['done', 'failed', 'cancelled', 'blocked'].includes(String(j.status)))
  const livres = s.assets.filter(a => suivi.ids.has(a.jobId))
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="app-ariane"><button onClick={onRetour}>{t('Extensions')}</button> › <b>{x.nom}</b></div>
      <div className="app-page" style={{ paddingTop: 8 }}>
        <div className="app-carte">
          <div className="flex gap-2 items-center flex-wrap">
            <h2 className="titre-outil" style={{ margin: 0 }}>{x.nom}</h2>
            <span className="texte-faible">{x.source === 'livree' ? t('livrée avec le studio') : t('installée')} · v{x.version}</span>
          </div>
          <span className="texte-doux" style={{ fontSize: 13 }}>{x.description}</span>
          {x.entrees.map(e => (
            <div key={e.id} style={{ display: 'grid', gap: 6 }}>
              <span className="etiquette">{e.label}</span>
              {e.type === 'texte' && <textarea className="champ" rows={2} value={String(valeurs[e.id] ?? '')} maxLength={600} onChange={ev => maj(e.id, ev.target.value)} />}
              {e.type === 'nombre' && <input className="champ" type="number" style={{ width: 110 }} min={e.min} max={e.max} value={Number(valeurs[e.id] ?? 0)} onChange={ev => maj(e.id, Number(ev.target.value))} />}
              {e.type === 'choix' && <select className="champ" value={String(valeurs[e.id] ?? '')} onChange={ev => maj(e.id, ev.target.value)}>{e.options?.map(o => <option key={o} value={o}>{o}</option>)}</select>}
              {e.type === 'image' && <button className={`zone-source ${photo(String(valeurs[e.id] ?? '')) ? 'pleine' : ''}`} onClick={() => setChoix(e.id)}>
                {photo(String(valeurs[e.id] ?? '')) ? <img src={photo(String(valeurs[e.id]))!.uri} alt="" /> : <span>{t('Choisir une photo')}<small>{t('dans la bibliothèque')}</small></span>}
              </button>}
              {e.aide && <span className="texte-faible">{e.aide}</span>}
            </div>
          ))}
          {x.manque.modeles.length > 0 && <span className="texte-erreur">{t('Il manque à ComfyUI : {x}', { x: x.manque.modeles.join(', ') })}</span>}
          <NoeudsManquants classes={x.manque.noeuds} />
          <button className="cta" style={{ padding: '16px', flexDirection: 'row' }} disabled={bloquee || occupe || x.entrees.some(e => e.type === 'image' && !valeurs[e.id])} onClick={() => void lancer()}>{occupe ? '…' : t('Lancer')}</button>
          {msg && <span className={msg.ok ? 'texte-doux' : 'texte-erreur'}>{msg.txt}</span>}
          <div className="flex gap-2 items-center flex-wrap">
            <span className="texte-faible">{[x.auteur, x.licence].filter(Boolean).join(' · ')}</span>
            {x.source === 'installee' && edition && <button className="pill" onClick={onRetirer}>{t('Retirer')}</button>}
          </div>
        </div>
        <div className="app-carte">
          <span className="texte-faible">{livres.length || enCours.length ? t('Tes rendus') : t('Exemple')}</span>
          {livres.length || enCours.length
            ? <div className="outil-grille">{enCours.map(j => <JobCard key={j.id} j={j} />)}{livres.map(a => <AssetCard key={a.id} a={a} onOpen={y => onOpen?.(y, livres)} />)}</div>
            : x.apercu ? <img src={x.apercu} alt="" className="app-media" style={{ aspectRatio: '4 / 3' }} /> : <div className="outil-vide">{t('Tes rendus apparaîtront ici.')}</div>}
        </div>
      </div>
      <FramePicker open={!!choix} onClose={() => setChoix(null)} title={t('Photo')} media="photo" assets={s.assets.filter((a: Asset) => a.mediaType === 'photo')}
        onPickAsset={(a: Asset) => { if (choix) maj(choix, a.id); setChoix(null) }} onPickUpload={() => setChoix(null)} />
    </div>
  )
}

/* Carte de la galerie : média, badge, titre et une ligne de description. */
function CarteGalerie({ titre, texte, image, badge, onClick, pied }: { titre: string; texte: string; image?: string | null; badge?: string; onClick?: () => void; pied?: React.ReactNode }) {
  return (
    <div className="galerie-carte">
      <button className="galerie-media" onClick={onClick} disabled={!onClick} aria-label={titre}>
        {image ? <img src={image} alt="" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} /> : <span className="galerie-initiale">{titre.slice(0, 1)}</span>}
        {badge && <em>{badge}</em>}
      </button>
      <b>{titre}</b>
      <span>{texte}</span>
      {pied}
    </div>
  )
}

type Travail = { etat: string; etape: string | null; erreur: string | null; redemarrage: boolean; note?: string | null; avant?: string | null; apres?: string | null }
type EtatMaj = { demo: boolean; messageDemo: string; travaux: Record<string, Travail> }
let etatMaj: Promise<EtatMaj> | null = null
const lireMaj = (frais = false) => { if (frais || !etatMaj) etatMaj = fetch('/api/comfy/maj').then(r => r.json()); return etatMaj }

/* Nœuds absents : le dépôt qui les fournit, installé en un clic sur une installation locale ;
   la démo publique refuse le code tiers et le dit. */
function NoeudsManquants({ classes }: { classes: string[] }) {
  const edition = useEdition()
  const [maj, setMaj] = useState<EtatMaj | null>(null)
  const [depots, setDepots] = useState<{ depot: string; titre: string; classes: string[] }[] | null>(null)
  const [inconnus, setInconnus] = useState<string[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void lireMaj().then(setMaj).catch(() => {}) }, [])
  useEffect(() => {
    if (!depots?.some(d => maj?.travaux[d.depot]?.etat === 'en cours')) return
    const h = setInterval(() => void lireMaj(true).then(setMaj), 4000)
    return () => clearInterval(h)
  }, [depots, maj])
  if (!classes.length) return null
  const chercher = async () => { try { const d = await poster('/api/comfy/noeuds/chercher', { classes }) as { depots: typeof depots; inconnus: string[] }; setDepots(d.depots ?? []); setInconnus(d.inconnus) } catch (e) { setMsg(String((e as Error).message)) } }
  const installer = async (depot: string) => { setMsg(null); try { await poster('/api/comfy/noeuds', { depot }); setMaj(await lireMaj(true)) } catch (e) { setMsg(String((e as Error).message)) } }
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span className="texte-faible">{t('Nœuds absents : {x}', { x: classes.slice(0, 4).join(', ') + (classes.length > 4 ? '…' : '') })}</span>
      {maj?.demo && <span className="texte-erreur">{t('Démo publique : aucun code tiers n’est installé ici. Sur ton installation locale du studio, ces nœuds s’installent en un clic.')}</span>}
      {!maj?.demo && edition && !depots && <button className="pill" style={{ justifySelf: 'start' }} onClick={() => void chercher()}>{t('Trouver les nœuds')}</button>}
      {depots?.map(d => {
        const tr = maj?.travaux[d.depot]
        return (
          <div key={d.depot} className="flex gap-2 items-center flex-wrap">
            <a className="texte-doux" href={d.depot} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{d.titre}</a>
            {!tr && <button className="pill" onClick={() => void installer(d.depot)}>{t('Installer (code tiers)')}</button>}
            {tr && <span className={tr.etat === 'échec' ? 'texte-erreur' : 'texte-doux'}>{tr.etat === 'en cours' ? `${tr.etape ?? ''}…` : tr.etat === 'fini' ? t('installé : redémarre ComfyUI') : tr.erreur}</span>}
            {tr?.note && <span className="texte-faible" style={{ flexBasis: '100%' }}>{tr.note}</span>}
          </div>
        )
      })}
      {depots && inconnus.length > 0 && <span className="texte-faible">{t('Sans dépôt connu : {x}', { x: inconnus.join(', ') })}</span>}
      {depots && !depots.length && !inconnus.length && <span className="texte-faible">{t('aucun dépôt trouvé')}</span>}
      {msg && <span className="texte-erreur">{msg}</span>}
    </div>
  )
}

/* ComfyUI lui-même : mise à jour depuis son dépôt, puis redémarrage quand la file est vide. */
function MiseAJourComfy() {
  const edition = useEdition()
  const [maj, setMaj] = useState<EtatMaj | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { void lireMaj(true).then(setMaj).catch(() => {}) }, [])
  const enCours = maj && Object.values(maj.travaux).some(x => x.etat === 'en cours')
  useEffect(() => { if (!enCours) return; const h = setInterval(() => void lireMaj(true).then(setMaj), 4000); return () => clearInterval(h) }, [enCours])
  if (!edition) return null
  const c = maj?.travaux.comfyui
  const aRedemarrer = maj && Object.values(maj.travaux).some(x => x.redemarrage)
  const agir = async (url: string) => { setMsg(null); try { await poster(url); setMaj(await lireMaj(true)) } catch (e) { setMsg(String((e as Error).message)) } }
  return (
    <div className="flex gap-2 items-center flex-wrap">
      <button className="pill" disabled={c?.etat === 'en cours'} onClick={() => void agir('/api/comfy/maj')}>{c?.etat === 'en cours' ? t('mise à jour : {e}…', { e: c.etape ?? '' }) : t('Mettre à jour ComfyUI')}</button>
      {c?.etat === 'fini' && <span className="texte-doux">{c.avant === c.apres ? t('ComfyUI était déjà à jour') : t('ComfyUI mis à jour ({a} → {b})', { a: c.avant ?? '', b: c.apres ?? '' })}</span>}
      {c?.etat === 'échec' && <span className="texte-erreur">{c.erreur}</span>}
      {aRedemarrer && <button className="pill" onClick={() => void agir('/api/comfy/redemarrer')}>{t('Redémarrer ComfyUI')}</button>}
      {msg && <span className="texte-erreur">{msg}</span>}
    </div>
  )
}

type WorkflowComfy = { id: string; titre: string; description: string; categorie: string; tags: string[]; taille: number | null; tutoriel: string | null; modeles: number;
  manquants: { nom: string; dossier: string }[]; noeuds: string[]; majComfy: boolean; versionMin: string | null;
  telechargement: { etat: string; fait: number; total: number; fichier: string | null; erreur: string | null } | null }
const go = (o: number | null) => (o ? `${(o / 1e9).toFixed(o > 10e9 ? 0 : 1)} Go` : '')

/* Les workflows officiels de ComfyUI : modèles présents ou à télécharger, nœuds absents. */
function WorkflowsComfy() {
  const edition = useEdition()
  const [liste, setListe] = useState<WorkflowComfy[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [cherche, setCherche] = useState('')
  const [cat, setCat] = useState('')
  const [n, setN] = useState(24)
  const charger = () => void fetch('/api/workflows-comfy').then(r => r.json()).then((d: { workflows?: WorkflowComfy[]; error?: string }) => { if (d.workflows) setListe(d.workflows); else setErreur(d.error ?? '…') }).catch(e => setErreur(String(e)))
  useEffect(charger, [])
  useEffect(() => {
    if (!liste?.some(w => w.telechargement?.etat === 'en cours')) return
    const h = setInterval(charger, 5000)
    return () => clearInterval(h)
  }, [liste])
  const telecharger = async (id: string) => { try { await poster(`/api/workflows-comfy/${id}/telecharger`); charger() } catch (e) { setErreur(String((e as Error).message)) } }
  const cats = [...new Set(liste?.map(w => w.categorie) ?? [])]
  const q = cherche.trim().toLowerCase()
  const vus = (liste ?? []).filter(w => (!cat || w.categorie === cat) && (!q || `${w.titre} ${w.description} ${w.tags.join(' ')}`.toLowerCase().includes(q)))
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="galerie-section"><b>{t('Workflows officiels de ComfyUI')}</b><span>{t('{n} workflows', { n: vus.length })}</span></div>
      <MiseAJourComfy />
      <span className="texte-doux" style={{ fontSize: 13 }}>{t('Les workflows open source livrés avec ComfyUI. Le studio dit quels modèles manquent et les télécharge depuis l’adresse officielle inscrite dans le workflow. Un nœud absent veut dire que ComfyUI doit être mis à jour : le studio ne le fait pas à ta place.')}</span>
      <div className="flex gap-2 items-center flex-wrap">
        <input className="champ" value={cherche} onChange={e => { setCherche(e.target.value); setN(24) }} placeholder={t('Chercher un workflow')} style={{ minWidth: 220 }} />
        <select className="champ" value={cat} onChange={e => { setCat(e.target.value); setN(24) }} aria-label={t('catégorie')}>
          <option value="">{t('Toutes les catégories')}</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="texte-faible">{t('{n} workflows', { n: vus.length })}</span>
      </div>
      {erreur && <span className="texte-erreur">{erreur}</span>}
      <div className="galerie-grille">
        {vus.slice(0, n).map(w => {
          const d = w.telechargement
          const pret = !w.manquants.length && !w.majComfy
          return (
            <CarteGalerie key={w.id} titre={w.titre} texte={w.description} image={`/api/workflows-comfy/vignette/${encodeURIComponent(w.id)}-1.webp`} badge={w.categorie}
              pied={<div style={{ display: 'grid', gap: 6 }}>
                <span className={pret ? 'texte-doux' : 'texte-faible'} style={{ fontSize: 12 }}>
                  {pret ? t('prêt : tous les modèles sont là') : w.majComfy ? t('ComfyUI à mettre à jour ({v})', { v: w.versionMin ?? w.noeuds.slice(0, 2).join(', ') }) : t('{n} modèle(s) à télécharger {g}', { n: w.manquants.length, g: go(w.taille) })}
                </span>
                <NoeudsManquants classes={w.noeuds} />
                {d && <span className={d.etat === 'échec' ? 'texte-erreur' : 'texte-doux'} style={{ fontSize: 12 }}>{d.etat === 'en cours' ? t('téléchargement {a}/{b} : {f}', { a: d.fait, b: d.total, f: d.fichier ?? '' }) : d.etat === 'fini' ? t('modèles téléchargés') : d.erreur}</span>}
                <div className="flex gap-1.5 flex-wrap">
                  {edition && w.manquants.length > 0 && d?.etat !== 'en cours' && <button className="pill" onClick={() => void telecharger(w.id)}>{t('Télécharger les modèles')}</button>}
                  {edition && <a className="pill" href={`${location.protocol}//${location.hostname}:8188/?template=${encodeURIComponent(w.id)}`} target="_blank" rel="noreferrer">{t('Ouvrir dans ComfyUI')}</a>}
                  {w.tutoriel && <a className="pill" href={w.tutoriel} target="_blank" rel="noreferrer">{t('Guide')}</a>}
                </div>
              </div>} />
          )
        })}
      </div>
      {vus.length > n && <button className="pill" style={{ justifySelf: 'center' }} onClick={() => setN(x => x + 24)}>{t('Voir plus')}</button>}
    </div>
  )
}

export function ExtensionsView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void } = {}) {
  const edition = useEdition()
  const [liste, setListe] = useState<Extension[] | null>(null)
  const [cat, setCat] = useState<Fiche[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [ouverte, setOuverte] = useState<string | null>(null)
  const [cherche, setCherche] = useState('')
  const [filtre, setFiltre] = useState<'tout' | 'image' | 'video' | 'audio' | 'comfy'>(() => useAppStore.getState().ongletExtensions ?? 'tout')
  // le menu ouvre Extensions ou le catalogue officiel de ComfyUI, à l'ouverture comme page déjà ouverte
  const demande = useAppStore(st => st.ongletExtensions)
  useEffect(() => { if (demande) { setFiltre(demande); useAppStore.setState({ ongletExtensions: null }) } }, [demande])
  const charger = () => void fetch('/api/extensions').then(r => r.json()).then((d: { extensions: Extension[]; catalogue: Fiche[] }) => { setListe(d.extensions); setCat(d.catalogue) }).catch(() => setListe([]))
  useEffect(charger, [])
  const agir = async (url: string) => { setMsg(null); try { await poster(url); charger() } catch (e) { setMsg(String((e as Error).message)) } }
  const x = liste?.find(e => e.id === ouverte)
  if (x) return <AppExtension x={x} onRetour={() => setOuverte(null)} onOpen={onOpen} onRetirer={() => { setOuverte(null); void agir(`/api/extensions/${x.id}/retirer`) }} />
  const q = cherche.trim().toLowerCase()
  const garde = (nom: string, desc: string, sortie: string) => (filtre === 'tout' || filtre === sortie) && (!q || `${nom} ${desc}`.toLowerCase().includes(q))
  const badge = (sortie: string) => ({ image: t('Image'), video: t('Vidéo'), audio: t('Audio') } as Record<string, string>)[sortie] ?? sortie
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="galerie-page">
        <div style={{ display: 'grid', gap: 6 }}>
          <h2 className="titre-outil" style={{ margin: 0 }}>{t('Extensions')}</h2>
          <span className="texte-doux" style={{ fontSize: 13 }}>{t('Des fonctions ajoutées au studio sans code : un workflow ComfyUI et un fichier app.json qui décrit le formulaire. Le studio vérifie que chaque nœud et chaque modèle existe déjà dans ComfyUI, rien n’est installé à sa place.')}</span>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input className="champ" value={cherche} onChange={e => setCherche(e.target.value)} placeholder={t('Chercher une extension')} style={{ minWidth: 240 }} />
          {([['tout', 'Tout'], ['image', 'Image'], ['video', 'Vidéo'], ['audio', 'Audio'], ['comfy', 'Workflows ComfyUI']] as const).map(([k, l]) => (
            <button key={k} className={`wtab ${filtre === k ? 'on' : ''}`} onClick={() => setFiltre(k)}>{t(l)}</button>
          ))}
          <a className="texte-doux" style={{ marginLeft: 'auto', fontSize: 13, textDecoration: 'underline' }} href="https://github.com/thePloggy/CreatorOS-Studio/blob/main/docs/EXTENSIONS.md" target="_blank" rel="noreferrer">{t('Écrire une extension')}</a>
        </div>
        {filtre !== 'comfy' && <>
          <div className="galerie-section"><b>{t('Installées')}</b><span>{t('Prêtes à lancer')}</span></div>
          <div className="galerie-grille">
            {liste?.filter(e => garde(e.nom, e.description, e.sortie)).map(e => (
              <CarteGalerie key={e.id} titre={e.nom} texte={e.description} image={e.apercu} badge={badge(e.sortie)} onClick={() => setOuverte(e.id)} />
            ))}
          </div>
          <div className="galerie-section"><b>{t('Catalogue')}</b><span>{t('À installer depuis GitHub')}</span></div>
          {cat.length === 0 && <span className="texte-doux">{t('Le catalogue est vide.')}</span>}
          <div className="galerie-grille">
            {cat.filter(f => garde(f.nom, f.description, f.sortie)).map(f => (
              <CarteGalerie key={f.id} titre={f.nom} texte={f.description} image={f.apercu} badge={badge(f.sortie)} onClick={f.installee ? () => setOuverte(f.id) : undefined}
                pied={f.installee ? <span className="texte-doux">{t('installée')}</span>
                  : edition ? <button className="pill" style={{ justifySelf: 'start' }} onClick={() => void agir(`/api/extensions/${f.id}/installer`)}>{t('Installer')}</button>
                  : <span className="texte-faible">{t('installation réservée au propriétaire')}</span>} />
            ))}
          </div>
        </>}
        {msg && <span className="texte-erreur">{msg}</span>}
        {(filtre === 'tout' || filtre === 'comfy') && <WorkflowsComfy />}
      </div>
    </div>
  )
}
