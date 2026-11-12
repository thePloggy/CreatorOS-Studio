/* ============================================================
   Talking avatar: a photo + a voice (file or microphone): the
   character speaks the text, lips synced to the audio (LTX-2.5 audio to video, talking-head LoRA,
   or MiniMax H3 with an audio guide when it is installed).
   The render goes through the regular queue and lands in the Video tab.
   ============================================================ */
import { VoixOrbe } from './VoixOrbe'
import { Ic } from './bits'
import { nomMedia } from '../lib/nomMedia'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { ChoixVoix } from './ChoixVoix'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'

const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

export function ParoleView({ goVideo }: { goVideo: () => void }) {
  const edition = useEdition()
  const s = useAppStore()
  const [photo, setPhoto] = useState<Asset | null>(null)
  const [voix, setVoix] = useState<{ fichier: string; duree: number; url: string } | null>(null)
  const [texte, setTexte] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fait, setFait] = useState<string | null>(null)
  const [enreg, setEnreg] = useState<{ rec: MediaRecorder; t0: number; flux: MediaStream } | null>(null)
  const [envoiVoix, setEnvoiVoix] = useState(false)
  const [secondes, setSecondes] = useState(0)
  const morceaux = useRef<Blob[]>([])
  /* Written line: LTX-2.5 produces voice and lip sync in one pass, no audio file.
     Open to visitors (only a sentence is sent); the recorded voice
     (LTX talking-head) is owner-only. */
  const [source, setSource] = useState<'replique' | 'voix'>(edition ? 'voix' : 'replique')
  const [replique, setReplique] = useState('')
  // voice for the line: "ltx" (LTX generates the voice, single render) or a studio, character or cloned voice
  const [voixPhrase, setVoixPhrase] = useState<string>(() => (edition && useAppStore.getState().personaVoix ? 'perso' : 'ltx'))
  // engine that syncs the lips to a given voice: LTX talking-head, or MiniMax H3 when installed (never on the demo)
  const [moteur, setMoteur] = useState<'ltx' | 'h3'>('ltx')
  const moteurEffectif = s.h3?.disponible ? moteur : 'ltx'
  const lancerAvecVoix = async () => {
    if (!photo || !replique.trim()) return
    setBusy(true); setErr(null); setFait(null)
    try {
      const v = await json(await fetch('/api/parole/dire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte: replique.trim(), voix: voixPhrase }) }))
      const r = await json(await fetch('/api/parole', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: photo.id, voix: v.fichier, texte, moteur: moteurEffectif }) }))
      void s.adoptServerJob(r.id)
      setFait(t('clip parlant lancé pour {d} s de voix', { d: r.duree.toFixed(1) }))
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }
  // "Use in…" from the viewer: this face is preselected
  useEffect(() => { const a = useAppStore.getState().prendrePasserelle('parole'); if (a) setPhoto(a) }, [])

  const photos = useMemo(() => s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
    .sort((x, y) => Number(y.reviewStatus === 'approved') - Number(x.reviewStatus === 'approved') || y.createdAt - x.createdAt).slice(0, 120), [s.assets])

  useEffect(() => {
    if (!enreg) return
    const h = setInterval(() => {
      const sec = (Date.now() - enreg.t0) / 1000
      setSecondes(sec)
      if (sec >= 20) enreg.rec.stop()          // same cap as the server
    }, 200)
    return () => clearInterval(h)
  }, [enreg])

  const deposer = async (b: Blob, type: string) => {
    setErr(null); setEnvoiVoix(true)
    try {
      const r = await json(await fetch('/api/parole/voix', { method: 'POST', headers: { 'Content-Type': type }, body: b }))
      setVoix({ fichier: r.fichier, duree: r.duree, url: URL.createObjectURL(b) })
    } catch (e) { setErr(String((e as Error).message)) }
    setEnvoiVoix(false)
  }
  const micro = async () => {
    if (enreg) { enreg.rec.stop(); return }
    setErr(null)
    try {
      const flux = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(flux)
      morceaux.current = []
      rec.ondataavailable = e => { if (e.data.size) morceaux.current.push(e.data) }
      rec.onstop = () => {
        flux.getTracks().forEach(tr => tr.stop())
        setEnreg(null)
        const type = (rec.mimeType || 'audio/webm').split(';')[0]
        void deposer(new Blob(morceaux.current, { type }), type)
      }
      rec.start()
      setSecondes(0)
      setEnreg({ rec, t0: Date.now(), flux })
    } catch { setErr(t('micro indisponible : autorise-le dans le navigateur, ou dépose un fichier audio')) }
  }
  const lancer = async () => {
    if (!photo || !voix) return
    setBusy(true); setErr(null)
    try {
      const r = await json(await fetch('/api/parole', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: photo.id, voix: voix.fichier, texte, moteur: moteurEffectif }) }))
      void s.adoptServerJob(r.id)
      setFait(t('clip parlant lancé pour {d} s de voix', { d: r.duree.toFixed(1) }))
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }

  const lancerReplique = async () => {
    const r = replique.trim()
    if (!photo || !r) return
    setBusy(true); setErr(null)
    try {
      const { filename } = await json(await fetch(`/api/assets/${encodeURIComponent(photo.id)}/to-input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
      // ~2.5 words per second of speech, plus a breath; the engine bounds the duration
      const secondes = Math.max(4, Math.min(8, Math.ceil(r.split(/\s+/).length / 2.5 + 1.5)))
      const ligne = r.replace(/"/g, "'")
      const id = `say-${Date.now().toString(36)}`
      const j = await json(await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id, mode: 'video', register: 'sfw', purpose: 'creative', personaId: photo.personaId ?? undefined,
        videoEngine: 'ltx_hq', withAudio: true, sourceImage: filename, videoSeconds: secondes,
        userPrompt: r, composedNegative: '',
        composedPositive: `${texte.trim() ? `${texte.trim()}. ` : ''}She looks into the camera and says, in a natural clear voice: "${ligne}" Her lips move in sync with her words, small natural head movements, static camera, single continuous shot, no music.`,
      }) }))
      void s.adoptServerJob(j.id ?? id)
      setFait(t('{d} s de vidéo parlée', { d: secondes }))
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div>
          <h2 className="titre-outil">{t('Avatar parlant')}</h2>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t('Une photo, une voix : {nom} parle, les lèvres calées sur l’audio. Idéal pour une pub UGC face caméra.', { nom: s.personaName })}</div>
        </div>
        <div style={{ display: 'grid', gap: 8, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
          <b style={{ fontSize: 13 }}>{t('1. La photo')}</b>
          <span style={{ fontSize: 12, color: 'var(--faint)' }}>{t('Visage bien visible, de face ou de trois quarts, plan poitrine ou plus serré.')}</span>
          <div className="pkgrid" style={{ maxHeight: 260 }}>
            {photos.map(a => (
              <button key={a.id} className="pk" aria-label={nomMedia(a)} onClick={() => setPhoto(a)} style={{ outline: photo?.id === a.id ? '3px solid var(--accent)' : undefined }}>
                <img src={a.uri} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <b style={{ fontSize: 13 }}>{t('2. Ce qu’elle dit')}</b>
            <span className="wtabs" style={{ marginLeft: 'auto' }}>
              <button className={`wtab ${source === 'replique' ? 'on' : ''}`} onClick={() => setSource('replique')}>{t('Une phrase écrite')}</button>
              <button className={`wtab ${source === 'voix' ? 'on' : ''}`} onClick={() => setSource('voix')}>{t('Ta voix (20 s au plus)')}</button>
            </span>
          </div>
          {source === 'replique' && <>
            <textarea value={replique} onChange={e => setReplique(e.target.value)} maxLength={220} rows={2}
              placeholder={t('La phrase qu’elle dit, dans sa langue (ex. « Hi! This is my favourite café in Paris, you have to try the croissants. »)')}
              className="champ" style={{ fontSize: 13 }} />
            <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 12 }}>
              <span>{t('Voix')}</span>
              {edition
                ? <select value={voixPhrase === 'ltx' ? 'ltx' : 'choisie'} onChange={e => setVoixPhrase(e.target.value === 'ltx' ? 'ltx' : (useAppStore.getState().personaVoix ? 'perso' : 'af_heart'))} className="champ" style={{ fontSize: 12 }} aria-label={t('Voix')}>
                    <option value="ltx">{t('Voix inventée par LTX-2.5 (un seul rendu)')}</option>
                    <option value="choisie">{t('Une voix choisie (la même partout)')}</option>
                  </select>
                : <span style={{ color: 'var(--faint)' }}>{t('Voix inventée par LTX-2.5 (un seul rendu)')}</span>}
              {edition && voixPhrase !== 'ltx' && <ChoixVoix valeur={voixPhrase} onChange={setVoixPhrase} />}
            </div>
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{voixPhrase === 'ltx'
              ? t('LTX-2.5 fait la voix et le mouvement des lèvres en un seul rendu, 4 à 8 s selon la longueur de la phrase.')
              : t('La phrase est dite par cette voix, puis LTX cale les lèvres dessus : le personnage garde la même voix dans le reel et l’avatar.')}</span>
          </>}
          {source === 'voix' && <div className="flex items-center gap-2 flex-wrap">
            {!edition && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Sur la démo publique, la voix ne peut pas être envoyée : l’avatar parlant est réservé au propriétaire.')}</span>}
            {edition && <><button className={`pill ${enreg ? 'used' : ''}`} onClick={() => void micro()}>{enreg ? <><Ic n="x" s={13} /> {t('Arrêter')} · {secondes.toFixed(1)} s</> : <><Ic n="sound" s={13} /> {t('Enregistrer au micro')}</>}</button>
            {(enreg || envoiVoix) && <VoixOrbe flux={enreg?.flux ?? null} etat={enreg ? 'ecoute' : 'envoi'} />}
            <label className="pill tool" style={{ cursor: 'pointer' }}><Ic n="upload" s={13} /> {t('déposer un fichier audio')}
              <input type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void deposer(f, f.type || 'audio/mpeg'); e.target.value = '' }} />
            </label></>}
            {voix && <audio src={voix.url} controls style={{ height: 32 }} />}
            {voix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{voix.duree.toFixed(1)} s</span>}
          </div>}
          {s.h3?.disponible && (source === 'voix' || voixPhrase !== 'ltx') && <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 12 }}>
            <span>{t('Lèvres calées par')}</span>
            <span className="wtabs">
              <button className={`wtab ${moteur === 'ltx' ? 'on' : ''}`} onClick={() => setMoteur('ltx')}>LTX-2.5</button>
              <button className={`wtab ${moteur === 'h3' ? 'on' : ''}`} onClick={() => setMoteur('h3')}>MiniMax H3</button>
            </span>
            <span style={{ color: 'var(--faint)' }}>{moteur === 'h3'
              ? t('H3 : 768×1344, 12 s de voix au plus, environ 1 min 20 pour 7 s.')
              : t('LTX : jusqu’à 20 s de voix, 1088×1920, environ 1 min pour 7 s.')}</span>
          </div>}
          <input value={texte} onChange={e => setTexte(e.target.value)} maxLength={400} placeholder={t('Optionnel : son attitude pendant qu’elle parle (en anglais, ex. « smiling, enthusiastic, holding a coffee cup »)')}
            className="champ" style={{ fontSize: 12.5 }} />
        </div>
        <div className="flex items-center gap-3">
          <button className="cta" disabled={!photo || busy || (source === 'voix' ? !voix : !replique.trim())} onClick={() => void (source === 'voix' ? lancer() : voixPhrase === 'ltx' ? lancerReplique() : lancerAvecVoix())}>{busy ? '…' : `✨ ${t('Faire parler')}`}</button>
          {fait && <span style={{ fontSize: 12.5 }}>✓ {t('En file de rendu')} — {fait}. <button className="pill tool" onClick={goVideo}>{t('Aller à Vidéo')}</button></span>}
          {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
        </div>
      </div>
    </div>
  )
}
