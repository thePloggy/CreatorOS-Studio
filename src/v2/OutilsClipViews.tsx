/* Clip tools in the studio layout: crop, dub; and social media analysis in the
   app layout (form on the left, example then result on the right). */
import { Ecouter, urlEchantillonVoix } from './Ecouter'
import { useEffect, useState } from 'react'
import type { Asset } from '../types'
import { getLang, t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { OutilPage, ZoneSource, useSuiviOutil } from './OutilPage'

type Source = { asset?: Asset; fichier?: string; apercu?: string } | null
const poster = async (url: string, corps: object) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
  return d
}
const nomCourt = (n: string) => n.replace(/_[a-z0-9]{6}\.\w+$/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')

export function RecadrerView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('recadrer')
  const [source, setSource] = useState<Source>(null)
  const [format, setFormat] = useState('9:16')
  const [prompt, setPrompt] = useState('')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try { const d = await poster(`/api/assets/${encodeURIComponent(source!.asset!.id)}/recadrer`, { format, prompt: prompt || undefined }) as { jobId: string }; suivi.ajouter([d.jobId]); await s.adoptServerJob(d.jobId) }
    catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  return (
    <OutilPage
      howto={{ cle: 'recadrer', titre: 'Un clip, tous les formats', texte: '9:16 pour TikTok et Reels, 16:9 pour YouTube, 1:1 pour le fil : les bords manquants sont générés, le clip d’origine reste intact au centre.', label: 'Exemple de recadrage', repli: '/vitrine/recadrer-b.webp' }} titre={t('Recadrer')} texte={t('Le clip passe dans un autre format : Wan VACE regarde le clip et génère les bords qui manquent, image par image.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen}
      etapes={[
        { titre: 'Le clip', texte: 'Choisis un clip de la bibliothèque, 10 s au plus.', image: '/vitrine/recadrer-a.webp' },
        { titre: 'Le format', texte: '9:16 pour TikTok et Reels, 16:9 pour YouTube, 1:1 ou 4:5 pour le fil.' },
        { titre: 'Les bords générés', texte: 'Le décor, la perspective et le mouvement continuent ; le clip d’origine reste intact au centre, avec son son.', image: '/vitrine/recadrer-b.webp' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!source?.asset || occupe} onClick={() => void lancer()}>{occupe ? '…' : t('Recadrer')} <small>{format} · ~10 min</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <ZoneSource media="video" valeur={source} onChoix={setSource} label={t('Clip')} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span className="etiquette">{t('Format')}</span>
        <div className="segmente">{['9:16', '16:9', '1:1', '4:5'].map(f => <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f}</button>)}</div>
      </div>
      <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Ce qu’il y a autour (facultatif)')}</span>
        <textarea className="champ" rows={3} value={prompt} maxLength={300} onChange={e => setPrompt(e.target.value)} placeholder={t('vide : le prompt d’origine du clip, en anglais')} /></label>
    </OutilPage>
  )
}

export function DoublageView({ onOpen }: { onOpen?: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const suivi = useSuiviOutil('doublage')
  const [source, setSource] = useState<Source>(null)
  const [mode, setMode] = useState<'texte' | 'audio'>('texte')
  const [texte, setTexte] = useState('')
  const [voixId, setVoixId] = useState('af_heart')
  const [voix, setVoix] = useState<{ id: string; nom: string }[]>([])
  const [audios, setAudios] = useState<string[]>([])
  const [audio, setAudio] = useState('')
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/voix').then(r => r.json()).then((d: { voix: { id: string; nom: string }[]; disponible: boolean }) => setVoix(d.disponible ? d.voix : [])).catch(() => {})
    void fetch('/api/montage/musiques').then(r => r.json()).then((d: { musiques?: { nom: string }[] }) => { const l = (d.musiques ?? []).map(m => m.nom).sort((a, b) => Number(b.startsWith('voix')) - Number(a.startsWith('voix'))); setAudios(l); setAudio(l[0] ?? '') }).catch(() => {})
  }, [])
  const pret = !!source?.asset && (mode === 'texte' ? !!texte.trim() && voix.length > 0 : !!audio)
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try {
      const fichier = mode === 'texte' ? (await poster('/api/voix', { texte, voix: voixId }) as { nom: string }).nom : audio
      const d = await poster(`/api/assets/${encodeURIComponent(source!.asset!.id)}/doubler`, { audio: fichier }) as { jobId: string }
      suivi.ajouter([d.jobId]); await s.adoptServerJob(d.jobId)
    } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  return (
    <OutilPage
      howto={{ cle: 'doublage', titre: 'Une nouvelle voix, les lèvres suivent', texte: 'Écris la réplique ou prends un audio : la bouche est refaite sur la nouvelle voix, la scène et les gestes restent.', label: 'Exemple de doublage', repli: '/vitrine/doublage-b.webp' }} titre={t('Doublage')} texte={t('Une nouvelle voix sur un clip : les lèvres suivent, la scène et les gestes restent.')}
      jobs={j => suivi.ids.has(j.id)} assets={a => suivi.ids.has(a.jobId)} onOpen={onOpen}
      etapes={[
        { titre: 'Le clip', texte: 'Un clip de la bibliothèque où l’on voit le visage.', image: '/vitrine/doublage-a.webp' },
        { titre: 'La voix', texte: 'Écris la réplique et choisis une voix, ou prends un audio de la bibliothèque.' },
        { titre: 'Les lèvres suivent', texte: 'InfiniteTalk refait la bouche sur la nouvelle voix ; les 3 premières secondes sont doublées.', image: '/vitrine/doublage-b.webp' },
      ]}
      action={<>
        <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!pret || occupe} onClick={() => void lancer()}>{occupe ? '…' : t('Doubler')} <small>~2 min</small></button>
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <ZoneSource media="video" valeur={source} onChoix={setSource} label={t('Clip')} />
      <div className="segmente">
        <button className={mode === 'texte' ? 'on' : ''} onClick={() => setMode('texte')}>{t('Écrire la réplique')}</button>
        <button className={mode === 'audio' ? 'on' : ''} onClick={() => setMode('audio')}>{t('Audio de la bibliothèque')}</button>
      </div>
      {mode === 'texte' ? <>
        <textarea className="champ" rows={3} value={texte} maxLength={300} onChange={e => setTexte(e.target.value)} placeholder={t('La réplique, en anglais')} />
        <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Voix')}</span>
          <select className="champ" value={voixId} onChange={e => setVoixId(e.target.value)}>{voix.map(v => <option key={v.id} value={v.id}>{v.nom}</option>)}</select><Ecouter src={urlEchantillonVoix(voixId)} titre={t('Écouter la voix')} /></label>
      </> : <label style={{ display: 'grid', gap: 6 }}><span className="etiquette">{t('Audio')}</span>
        <select className="champ" value={audio} onChange={e => setAudio(e.target.value)}>{audios.map(n => <option key={n} value={n}>{nomCourt(n)}</option>)}</select></label>}
    </OutilPage>
  )
}

type Analyse = { notes: Record<string, number>; global: number; mesures: { duree: number; format: string; son: boolean; coupes: number }; conseils: string[] }
const EXEMPLE: Analyse = { notes: { accroche: 8, sujet: 9, image: 9, histoire: 7 }, global: 8.2, mesures: { duree: 5, format: '16:9', son: true, coupes: 0 },
  conseils: ['Pour TikTok, Reels et Shorts, passe-le en 9:16 (outil Recadrer).', 'Un seul plan de plus de 4 s : une coupe ou un mouvement de caméra relance l’attention.'] }

export function AnalyseView() {
  const [source, setSource] = useState<Source>(null)
  const [r, setR] = useState<Analyse | null>(null)
  const [occupe, setOccupe] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const lancer = async () => {
    setOccupe(true); setMsg(null)
    try { setR(await poster(`/api/assets/${encodeURIComponent(source!.asset!.id)}/analyse`, { langue: getLang() }) as Analyse) } catch (e) { setMsg(String((e as Error).message)) }
    setOccupe(false)
  }
  const v = r ?? EXEMPLE
  const vignette = r ? source?.asset?.uri : '/vitrine/analyse.webp'
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="app-page">
        <div className="app-carte">
          <h2 className="titre-outil" style={{ margin: 0 }}>{t('Analyse pour les réseaux')}</h2>
          <span className="texte-doux" style={{ fontSize: 13 }}>{t('Le modèle de vision local regarde ton clip comme un éditeur réseaux : accroche, sujet, image, histoire. C’est une estimation de qualité, pas une prédiction de vues.')}</span>
          <ZoneSource media="video" valeur={source} onChoix={x => { setSource(x); setR(null) }} label={t('Clip')} />
          <button className="cta" style={{ padding: '16px', flexDirection: 'row' }} disabled={!source?.asset || occupe} onClick={() => void lancer()}>{occupe ? t('analyse…') : t('Analyser ce clip')} <small>~1 min</small></button>
          {msg && <span className="texte-erreur">{msg}</span>}
        </div>
        <div className="app-carte">
          <div className="flex items-center gap-2">
            <span className="texte-faible">{r ? t('Résultat') : t('Exemple')}</span>
            <b style={{ marginLeft: 'auto', fontSize: 28, fontWeight: 800 }}>{Math.round(v.global * 10)}<small style={{ fontSize: 14, color: 'var(--faint)' }}>/100</small></b>
          </div>
          {vignette && (source?.asset && r ? <video src={vignette} muted playsInline preload="metadata" className="app-media" /> : <img src={vignette} alt="" className="app-media" />)}
          <div className="app-stats">
            <div><b>{v.mesures.duree} s</b><span>{t('durée')}</span></div>
            <div><b>{v.mesures.format}</b><span>{t('format')}</span></div>
            <div><b>{v.mesures.coupes}</b><span>{t('coupes')}</span></div>
          </div>
          <div className="app-barres">
            {Object.entries(v.notes).map(([k, n]) => (
              <div key={k}><span>{t(k)}</span><b>{n}/10</b><i><em style={{ width: `${n * 10}%` }} /></i></div>
            ))}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'grid', gap: 4 }}>{v.conseils.map((c, i) => <li key={i}>{t(c)}</li>)}</ul>
        </div>
      </div>
    </div>
  )
}
