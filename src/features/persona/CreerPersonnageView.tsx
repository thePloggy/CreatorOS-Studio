/* Créer un personnage, au gabarit studio : les traits en accordéons de choix à gauche, les quatre
   visages proposés puis la création à droite (cf. server/createurPersonnage.js). */
import { useEffect, useMemo, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'
import { OutilPage, useSuiviOutil } from '../../v2/OutilPage'

const CHOIX: { cle: 'origine' | 'cheveux' | 'yeux' | 'style' | 'signes'; titre: string; options: string[]; multiple?: boolean }[] = [
  { cle: 'origine', titre: 'Origine du personnage', options: ['Portuguese', 'Japanese', 'Nigerian', 'Brazilian', 'Swedish', 'Indian', 'Moroccan', 'Korean', 'Mexican', 'Irish', 'Lebanese', 'Vietnamese'] },
  { cle: 'cheveux', titre: 'Cheveux', options: ['long straight black', 'short dark curly', 'shoulder-length auburn wavy', 'platinum blonde bob', 'long brown braids', 'buzz cut', 'messy copper bun'] },
  { cle: 'yeux', titre: 'Yeux', options: ['brown', 'hazel', 'green', 'blue', 'grey', 'dark brown'] },
  { cle: 'style', titre: 'Style', options: ['minimalist linen workwear', 'streetwear', 'bohemian', 'sporty athleisure', 'elegant evening', 'business casual', 'vintage 70s'] },
  { cle: 'signes', titre: 'Signes distinctifs', multiple: true, options: ['freckles', 'dimples', 'round glasses', 'small nose ring', 'beauty mark', 'gap-toothed smile', 'fine line tattoo on the forearm'] },
]
type Traits = { genre: string; age: number; origine: string; cheveux: string; yeux: string; style: string; signes: string }

/* Ce qui doit survivre à un changement de page : la dernière série de visages, le choix,
   le nom et la création en cours. Les visages vont aussi dans l'Historique de l'outil. */
const CLE = 'creatoros.creerPersonnage'
type Memo = { jobs?: string[]; choisi?: string | null; nom?: string; suiviId?: string | null }
const lireMemo = (): Memo => { try { return JSON.parse(localStorage.getItem(CLE) ?? '{}') } catch { return {} } }

export function CreerPersonnageView() {
  const edition = useEdition()
  const s = useAppStore()
  const [traits, setTraits] = useState<Traits>({ genre: 'woman', age: 28, origine: '', cheveux: '', yeux: '', style: '', signes: '' })
  const [ouvert, setOuvert] = useState<string>('origine')
  const memo = useMemo(lireMemo, [])
  const historique = useSuiviOutil('personnage')
  const [jobs, setJobs] = useState<string[]>(memo.jobs ?? [])
  const [choisi, setChoisi] = useState<string | null>(memo.choisi ?? null)
  const [nom, setNom] = useState(memo.nom ?? '')
  const [entrainer, setEntrainer] = useState(true)
  const [suivi, setSuivi] = useState<{ id: string; planche: string | null; images: string; entrainementEtat: string | null } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)
  useEffect(() => {
    try { localStorage.setItem(CLE, JSON.stringify({ jobs, choisi, nom, suiviId: suivi?.id ?? null })) } catch { /* stockage indisponible */ }
  }, [jobs, choisi, nom, suivi])
  // une création lancée avant de quitter la page reprend son suivi (le serveur l'oublie à son redémarrage)
  useEffect(() => {
    if (!memo.suiviId) return
    void fetch(`/api/personnages/creer/${encodeURIComponent(memo.suiviId)}`).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setSuivi(d) }).catch(() => {})
  }, [memo])
  const portraits = useMemo(() => s.assets.filter(a => a.jobId && jobs.includes(a.jobId) && a.mediaType === 'photo'), [s.assets, jobs])
  useEffect(() => {
    if (!suivi || suivi.entrainementEtat === 'done') return
    const h = setInterval(() => void fetch(`/api/personnages/creer/${suivi.id}`).then(r => r.json()).then(setSuivi).catch(() => {}), 4000)
    return () => clearInterval(h)
  }, [suivi])
  const poster = async (url: string, corps: object) => {
    setMsg(null)
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return null }
    return d
  }
  const choisir = (cle: keyof Traits, v: string, multiple?: boolean) => setTraits(x => {
    if (!multiple) return { ...x, [cle]: x[cle] === v ? '' : v }
    const l = String(x[cle]).split(', ').filter(Boolean)
    return { ...x, [cle]: (l.includes(v) ? l.filter(y => y !== v) : [...l, v]).join(', ') }
  })
  const proposer = async () => { setOccupe(true); const d = await poster('/api/personnages/propositions', { traits }); setOccupe(false); if (d) { setJobs(d.jobs); setChoisi(null); setSuivi(null); historique.ajouter(d.jobs); for (const j of d.jobs) void s.adoptServerJob(j) } }
  const creer = async () => { const d = await poster('/api/personnages/creer', { assetId: choisi, nom, traits, entrainer }); if (d) { setSuivi(d); await s.refreshPersona() } }
  if (!edition) return <div className="outil-vide" style={{ flex: 1 }}>{t('Créer un personnage est réservé au propriétaire du studio.')}</div>
  const resultat = jobs.length > 0 ? (
    <div style={{ display: 'grid', gap: 14 }}>
      <b>{t('Choisis un visage')}</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {jobs.map(j => { const a = portraits.find(x => x.jobId === j); return (
          <button key={j} disabled={!a} onClick={() => a && setChoisi(a.id)} aria-pressed={!!a && choisi === a.id} className={`carte-visage ${a && choisi === a.id ? 'on' : ''}`}>
            {a ? <img src={a.uri} alt="" /> : <span className="texte-faible">{t('en cours…')}</span>}
          </button>) })}
      </div>
      {choisi && !suivi && (
        <div className="flex gap-2 items-center flex-wrap">
          <input className="champ" value={nom} onChange={e => setNom(e.target.value)} placeholder={t('nom du personnage')} maxLength={40} />
          <label className="flex gap-2 items-center" style={{ cursor: 'pointer' }}><input type="checkbox" checked={entrainer} onChange={e => setEntrainer(e.target.checked)} /> {t('entraîner sa LoRA (~35 min)')}</label>
          <button className="pill" disabled={nom.trim().length < 2} onClick={() => void creer()}>{t('Créer le personnage')}</button>
        </div>
      )}
      {suivi && <span className="texte-doux">{t('Planche : {p} · images : {i}', { p: suivi.planche ?? '…', i: suivi.images })}{suivi.entrainementEtat ? ` · ${t('LoRA : {e}', { e: suivi.entrainementEtat })}` : ''}</span>}
    </div>
  ) : undefined
  return (
    <OutilPage titre={t('Créer un personnage')} texte={t('Décris-le : le studio propose 4 visages, tu choisis, il crée le personnage, sa planche de référence, 12 images et sa LoRA.')}
      resultat={resultat}
      jobs={j => historique.ids.has(j.id)} assets={a => !!a.jobId && historique.ids.has(a.jobId)}
      etapes={[
        { titre: 'Les traits', texte: 'Un adulte de 21 à 80 ans : origine, cheveux, yeux, style, signes distinctifs.' },
        { titre: 'Quatre visages', texte: 'Krea 2 propose quatre portraits en studio ; tu choisis et tu le nommes.' },
        { titre: 'Le personnage', texte: 'Planche de référence, 12 images variées avec FLUX.2 Klein, puis sa LoRA si tu veux.' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={occupe} onClick={() => void proposer()}>{occupe ? '…' : t('4 propositions')} <small>~1 min</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <div className="segmente">
        {[['woman', 'femme'], ['man', 'homme'], ['person', 'personne']].map(([v, l]) => <button key={v} className={traits.genre === v ? 'on' : ''} onClick={() => setTraits(x => ({ ...x, genre: v }))}>{t(l)}</button>)}
      </div>
      <label style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('âge')} · {traits.age}</span>
        <input type="range" min={21} max={80} value={traits.age} onChange={e => setTraits(x => ({ ...x, age: Number(e.target.value) }))} />
      </label>
      {CHOIX.map(c => (
        <div key={c.cle} className="accordeon">
          <button className="accordeon-tete" aria-expanded={ouvert === c.cle} onClick={() => setOuvert(o => (o === c.cle ? '' : c.cle))}>
            <span>{t(c.titre)}</span><small>{traits[c.cle] || t('au choix')}</small><i>{ouvert === c.cle ? '−' : '+'}</i>
          </button>
          {ouvert === c.cle && <div className="accordeon-corps">
            {c.options.map(o => <button key={o} className={`pill ${String(traits[c.cle]).split(', ').includes(o) ? 'on' : ''}`} onClick={() => choisir(c.cle, o, c.multiple)}>{o}</button>)}
            <input className="champ" style={{ flexBasis: '100%' }} value={traits[c.cle]} maxLength={c.cle === 'signes' ? 120 : 60} onChange={e => setTraits(x => ({ ...x, [c.cle]: e.target.value }))} placeholder={t('ou écris-le, en anglais')} />
          </div>}
        </div>
      ))}
    </OutilPage>
  )
}
