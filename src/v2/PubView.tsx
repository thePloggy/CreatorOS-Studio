/* Ad pack: the product (library photo, file, or plain description), then
   the staging with the character; six renders (see server/packPub.js). */
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { ChoixPersonnage } from './ChoixPersonnage'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'

const SCENES: [string, string][] = [
  ['Studio coloré', 'a bold colour-block studio set with a soft gradient backdrop'],
  ['Plage au coucher du soleil', 'on a sandy beach at golden hour, warm low sun, gentle waves'],
  ['Cuisine lumineuse', 'in a bright modern kitchen with morning window light'],
  ['Rue de nuit', 'on a city street at night with neon reflections on wet pavement'],
  ['Salle de sport', 'in a clean modern gym with soft daylight'],
  ['Bureau minimaliste', 'on a minimalist wooden desk in a calm home office'],
]
const FORMATS = ['9:16', '1:1', '4:5', '16:9']

export function PubView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const [demo, setDemo] = useState(false)
  useEffect(() => { void fetch('/api/comfy/maj').then(r => r.json()).then(d => setDemo(!!d.demo)).catch(() => {}) }, [])
  const [mode, setMode] = useState<'photo' | 'decrire'>('photo')
  const [source, setSource] = useState<{ asset?: Asset; fichier?: string; apercu?: string } | null>(null)
  const [description, setDescription] = useState('')
  const [produit, setProduit] = useState('')
  const [scene, setScene] = useState('')
  const [accroche, setAccroche] = useState('')
  const [format, setFormat] = useState('9:16')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const suivi = useSuiviOutil('pub')
  const [packs, setPacks] = useState<string[]>([])
  // the pack's renders arrive in stages: track their ids
  useEffect(() => {
    if (!packs.length) return
    const h = setInterval(() => {
      for (const id of packs) void fetch(`/api/pack-pub/${id}`).then(r => r.json()).then((d: { jobs?: Record<string, string | null> }) => {
        const l = Object.values(d.jobs ?? {}).filter((x): x is string => !!x)
        const nouveaux = l.filter(x => !suivi.ids.has(x))
        if (nouveaux.length) { suivi.ajouter(nouveaux); for (const j of nouveaux) void s.adoptServerJob(j) }
      }).catch(() => {})
    }, 4000)
    return () => clearInterval(h)
  }, [packs, suivi.ids]) // eslint-disable-line react-hooks/exhaustive-deps
  const pret = mode === 'decrire' ? description.trim().length > 2 : !!source
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    const corps = { ...(mode === 'decrire' ? { description } : source?.asset ? { assetId: source.asset.id } : { fichier: source?.fichier }), produit, scene, accroche, format }
    const r = await fetch('/api/pack-pub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({})) as { id?: string; jobs?: Record<string, string | null>; error?: string }
    setOccupe(false)
    if (!r.ok || !d.id) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return }
    const l = Object.values(d.jobs ?? {}).filter((x): x is string => !!x)
    suivi.ajouter(l); for (const j of l) void s.adoptServerJob(j)
    setPacks(p => [...p, d.id!])
  }
  return (
    <OutilPage
      howto={{ cle: 'pub', titre: 'Ton produit, toute une campagne', texte: 'Packshot sur fond blanc, mise en scène, affiche, ton personnage qui présente le produit et un clip : un pack complet en une fois.', label: 'Exemple de pack publicitaire', repli: '/vitrine/v2-pack.webp' }} titre={t('Pack publicitaire')} texte={t('Ton produit, ton personnage, une mise en scène : packshot, scène, affiche, ton personnage qui présente le produit et un clip.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen}
      etapes={[
        { titre: 'Le produit', texte: 'Une photo de la bibliothèque, un fichier, ou quelques mots : Krea en fait un packshot sur fond blanc.', image: '/vitrine/pack.webp' },
        { titre: 'La mise en scène', texte: 'Ton personnage, une scène prête ou la tienne, une accroche et le format.' },
        { titre: 'Six rendus', texte: 'Packshot, scène, affiche, ton personnage qui présente le produit, puis un clip où il le montre à la caméra.' },
      ]}
      vide={t('Le packshot, la scène, l’affiche, le visuel avec ton personnage et le clip apparaîtront ici.')}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!pret || occupe} onClick={() => void lancer()}>
          {occupe ? '…' : t('Générer le pack')} <small>{format} · {t('6 rendus, ~6 min')}</small>
        </button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <div className="segmente" role="tablist">
        <button className={mode === 'photo' ? 'on' : ''} onClick={() => setMode('photo')}>{t('Photo du produit')}</button>
        <button className={mode === 'decrire' ? 'on' : ''} onClick={() => setMode('decrire')}>{t('Décrire le produit')}</button>
      </div>
      {mode === 'photo'
        ? <>
            <ZoneSource media="photo" valeur={source} onChoix={setSource} depot label={t('Produit')} />
            {demo && !edition && <span className="texte-faible">{t('Sur la démo publique, tu peux déposer une photo du produit seul : une photo où l’on voit une personne est refusée.')}</span>}
          </>
        : <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Produit')}</span>
            <textarea className="champ" rows={3} value={description} maxLength={200} onChange={e => setDescription(e.target.value)} placeholder={t('en anglais : a matte black insulated water bottle with a bamboo cap')} /></label>}
      <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Nom du produit (facultatif)')}</span>
        <input className="champ" value={produit} maxLength={60} onChange={e => setProduit(e.target.value)} placeholder={t('en anglais : Aurora water bottle')} /></label>
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Personnage')}</span>
        <ChoixPersonnage />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Mise en scène')}</span>
        <div className="flex gap-1.5 flex-wrap">
          {SCENES.map(([l, v]) => <button key={l} className={`pill ${scene === v ? 'on' : ''}`} onClick={() => setScene(v)}>{t(l)}</button>)}
        </div>
        <textarea className="champ" rows={2} value={scene} maxLength={200} onChange={e => setScene(e.target.value)} placeholder={t('ou décris la scène, en anglais')} />
      </div>
      <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Accroche de l’affiche (facultatif)')}</span>
        <input className="champ" value={accroche} maxLength={50} onChange={e => setAccroche(e.target.value)} placeholder={t('en anglais : Stay cold all day')} /></label>
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Format')}</span>
        <div className="segmente">{FORMATS.map(f => <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f}</button>)}</div>
      </div>
    </OutilPage>
  )
}
