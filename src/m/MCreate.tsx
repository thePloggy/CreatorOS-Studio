/* ============================================================
   Create: image and video, all operations.

   Image: Generate · Retouch
   Video: Animate · Replay (motion control) · Extend

   The draft is kept per operation: switching tabs never loses work in progress,
   since everything lives in the store shared with desktop.
   ============================================================ */
import { Inspirations } from '../components/Inspirations'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { VideoAspect } from '../types'
import { useAppStore } from '../store/useAppStore'
import { engineInfo, moteurT2v, VIDEO_ENGINES } from '../features/console/video/engines'
import { Ic, Opt, Seg, Sheet, Stepper, Toggle, fmtDur } from './bits'
import { MSourcePicker } from './MSourcePicker'
import { MEnhance, MElements } from './MPrompt'
import { storageAvailable } from './draft'
import { t, tp } from '../i18n'
import { lienMobile } from './lien'
import '../v2/v2.css'
/* Sound studio: the desktop view, lazy-loaded in a `.v2` container for its styles. */
const SonView = lazy(() => import('../v2/SonView').then(m => ({ default: m.SonView })))

type ImgOp = 'generate' | 'edit'
type VidOp = 'animate' | 'ambiance' | 'replay' | 'extend'

export function MCreate({ goJobs, goMontage }: { goJobs: () => void; goMontage?: () => void }) {
  // arriving without an image passed by a click: empty slots (start, end, edit source…)
  useEffect(() => { useAppStore.getState().viderImagesSiArriveeLibre() }, [])
  const s = useAppStore()
  // Image, Video or Sound: sound has its own studio (music, voice, sound effects)
  const [son, setSon] = useState(() => !!lienMobile()?.son)
  const v = s.video
  const mode = s.mode === 'video' ? 'video' : 'photo'

  /* The operation is DERIVED from the store state (single source of truth,
     shared with desktop) rather than duplicated here. */
  const imgOp: ImgOp = s.photo.task === 'edit' ? 'edit' : 'generate'
  const vidOp: VidOp = v.task === 'extend' ? 'extend' : v.task === 'motion_pure' ? 'replay' : v.task === 't2v' ? 'ambiance' : 'animate'

  const [sheet, setSheet] = useState<null | 'format' | 'engine' | 'lora' | 'duration' | 'audio'>(null)
  const [picker, setPicker] = useState<null | { role: 'start' | 'end' | 'driver' | 'still' | 'extend' | 'editsrc' }>(null)
  const [enhance, setEnhance] = useState(false)
  const [elements, setElements] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<null | string>(null)
  /* Offline: submission is BLOCKED and the user is told, rather than
     sending a request that will fail. The draft stays intact, and
     nothing is resubmitted automatically when the network returns:
     the operator decides, since submitting costs GPU time. */
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  const eng = engineInfo(v.task === 't2v' ? moteurT2v(Boolean(v.t2vPersonnage && s.personaVideo && s.personaVideoWan)) : v.engine)

  /* Estimate BEFORE submitting, so the button is honest. */
  const rates = s.serverInfo?.renderRates
  const perJob = mode === 'photo'
    ? (rates?.photoMs ?? 16000)
    : (() => {
      const secs = Math.min(v.durationS, eng.maxSeconds)
      const rate = v.draft
        ? (rates?.draftSecPerSec?.[v.engine] ?? 27)
        : (rates?.videoSecPerSec?.[v.engine] ?? 105)
      return secs * rate * 1000
    })()
  const total = s.batchCount * perJob

  const send = async () => {
    // `sending` also blocks double taps while waiting for the acknowledgement.
    if (sending || !online) return
    setSending(true); setSent(null)
    try {
      await s.submitJob()
      // The form STAYS as is: no forced switch to Jobs.
      if (!useAppStore.getState().t0Error) setSent(tp(s.batchCount, '{n} rendu accepté', '{n} rendus acceptés'))
    } finally { setSending(false) }
  }

  // media chosen in the viewer ("Animate") prefills the slot
  const startUri = v.startFrameUri || (v.startAssetId ? s.assets.find(a => a.id === v.startAssetId)?.uri : '')
  const label = mode === 'photo'
    ? (imgOp === 'generate' ? tp(s.batchCount, 'Générer {n} image', 'Générer {n} images')
      : (s.batchCount > 1 ? t('Retoucher {n} fois', { n: s.batchCount }) : t('Retoucher')))
    : (vidOp === 'extend' ? t('Prolonger de {n} s', { n: v.durationS }) : (s.batchCount > 1 ? t('Générer {n} vidéos', { n: s.batchCount }) : t('Générer la vidéo')))

  const choixMode = (m: string) => { if (m === 'son') { setSon(true); return } setSon(false); s.setMode(m as 'photo' | 'video') }
  if (son) return (
    <>
      <div className="htitle">
        <h1>{t('Créer')}</h1>
        <p>{t('Musique, voix et bruitages, en deux prises.')}</p>
      </div>
      <div className="scroll">
        <Seg value="son" onPick={choixMode} options={[['photo', t('Image')], ['video', t('Vidéo')], ['son', t('Son')]]} />
        <div className="v2 m-son"><Suspense fallback={null}><SonView goMontage={goMontage} /></Suspense></div>
      </div>
    </>
  )

  return (
    <>
      <div className="htitle">
        <h1>{t('Créer')}</h1>
        <p>{t('Le prochain rendu commence ici.')}</p>
      </div>

      <div className="scroll">
        <Seg value={mode} onPick={choixMode}
          options={[['photo', t('Image')], ['video', t('Vidéo')], ['son', t('Son')]]} />

        <div className="ops" style={{ marginTop: 12 }}>
          {mode === 'photo' ? (<>
            <OpBtn on={imgOp === 'generate'} icon="wand" label={t('Générer')} onClick={() => s.updatePhoto({ task: 'generate' })} />
            <OpBtn on={imgOp === 'edit'} icon="brush" label={t('Retoucher')} onClick={() => s.updatePhoto({ task: 'edit' })} />
          </>) : (<>
            <OpBtn on={vidOp === 'animate'} icon="film" label={t('Depuis une image')} onClick={() => s.updateVideo({ task: 'i2v' })} />
            <OpBtn on={vidOp === 'ambiance'} icon="wand" label={t('Depuis un texte')} onClick={() => s.updateVideo({ task: 't2v' })} />
            <OpBtn on={vidOp === 'replay'} icon="replay" label={t('Rejouer')} onClick={() => s.updateVideo({ task: 'motion_pure' })} />
            <OpBtn on={vidOp === 'extend'} icon="extend" label={t('Prolonger')} onClick={() => s.updateVideo({ task: 'extend' })} />
          </>)}
        </div>
        <p className="ophint">{hintOf(mode, imgOp, vidOp)}</p>
        {((mode === 'photo' && imgOp === 'generate') || (mode === 'video' && vidOp === 'animate')) && <Inspirations mode={mode} mobile />}
        {mode === 'video' && vidOp === 'ambiance' && s.personaVideo && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
            {([[false, t('Ambiance seule')], [true, t('Avec {nom}', { nom: s.personaName })]] as const).map(([on, label]) => (
              <button key={String(on)} className={`chip ${Boolean(s.video.t2vPersonnage) === on ? 'on' : ''}`}
                onClick={() => s.updateVideo({ t2vPersonnage: on })}>{label}</button>
            ))}
          </div>
        )}
        {mode === 'photo' && imgOp === 'generate' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
            <small className="muted">{t('Recette')}</small>
            {(['krea', 'klein', 'flux3'] as const).map(e => (
              <button key={e} className={`chip ${s.photoEngine === e ? 'on' : ''}`} onClick={() => s.setPhotoEngine(e)}
                disabled={e === 'klein' && !s.personaKlein} style={e === 'klein' && !s.personaKlein ? { opacity: 0.4 } : undefined}>
                {e === 'krea' ? 'Krea 2' : e === 'klein' ? 'FLUX.2 Klein' : 'FLUX 3'}
              </button>
            ))}
          </div>
        )}

        {/* ---- sources ---- */}
        {mode === 'photo' && imgOp === 'edit' && (
          <SourceRow label={t('Image à retoucher')}
            uri={s.photo.editSourceUri || ''}
            name={s.photo.editSourceName || ''}
            onPick={() => setPicker({ role: 'editsrc' })} />
        )}
        {mode === 'video' && vidOp === 'animate' && (<>
          <SourceRow label={t('Image de départ')} required uri={startUri} name={v.startFrameFile}
            onPick={() => setPicker({ role: 'start' })} />
          {/* end keyframe: MiniMax H3 (last_frame), Wan (FirstLastFrame), LTX (last-frame guide) */}
          {['minimax', 'wan', 'ltx', 'ltx_hq'].includes(v.engine) && (
            <SourceRow label={t('Image de fin')} hint={t('facultative — le clip arrive sur cette image')}
              uri={v.endAssetId ? s.assets.find(a => a.id === v.endAssetId)?.uri : v.endFrameFile ? `/api/uploads/${encodeURIComponent(v.endFrameFile)}` : ''}
              onPick={() => setPicker({ role: 'end' })} />
          )}
        </>)}
        {mode === 'video' && vidOp === 'replay' && (<>
          <SourceRow label={t('Vidéo de mouvement')} required uri={v.motionRefUri} name={v.motionDriverFile}
            onPick={() => setPicker({ role: 'driver' })} />
          {/* The still is animated by the source video's motion. */}
          <SourceRow label={t('Image du sujet')} required uri={v.motionStillUri} name={v.motionStillFile}
            onPick={() => setPicker({ role: 'still' })} />
        </>)}
        {mode === 'video' && vidOp === 'extend' && (
          <SourceRow label={t('Clip à prolonger')} required uri={v.extendVideoUri} name={v.extendVideoFile}
            onPick={() => setPicker({ role: 'extend' })} />
        )}

        {/* ---- prompt ---- */}
        <div className="label">
          {mode === 'photo'
            ? (imgOp === 'edit' ? t('Décris la modification') : t('Décris ton image'))
            : vidOp === 'replay' ? t('Décris le mouvement') : vidOp === 'ambiance' ? t('Décris le lieu et la caméra') : vidOp === 'extend' ? t('Décris la suite') : t('Décris l’animation')}
        </div>
        <textarea className="field" value={s.userPrompt} onChange={e => s.setUserPrompt(e.target.value)}
          placeholder={mode === 'photo' ? t('Portrait naturel, lumière douce…') : t('Un léger sourire, les cheveux bougent dans le vent…')} />
        {!storageAvailable() && (
          <p className="err">{t('Le brouillon ne peut pas être conservé sur cet appareil — pense à copier ton prompt.')}</p>
        )}

        <div className="tools" style={{ marginTop: 12 }}>
          <button onClick={() => setEnhance(true)}><Ic n="wand" s={18} /> {t('Améliorer')}</button>
          <button onClick={() => setElements(true)}><Ic n="at" s={18} /> {t('Éléments')}</button>
        </div>

        {/* ---- direct controls ---- */}
        {mode === 'video' && vidOp !== 'replay' && (<>
          <div className="label">{t('Moteur')}</div>
          <button className="rowbtn" onClick={() => setSheet('engine')} disabled={vidOp === 'ambiance'}>
            <span style={{ flex: 1 }}><b>{eng.label}</b><small style={{ display: 'block' }}>{t(eng.force)}</small></span>
            <Ic n="skip" s={18} />
          </button>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="chip" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSheet('duration')}>{v.durationS} s</button>
            <button className="chip" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSheet('format')}>{v.aspect}</button>
            <button className={`chip ${v.withAudio ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => s.updateVideo({ withAudio: !v.withAudio })}
              disabled={!eng.audio}>{eng.audio ? (v.withAudio ? t('🔊 audio') : t('muet')) : t('muet')}</button>
          </div>
        </>)}

        {mode === 'photo' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
            <button className="chip" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSheet('format')}>
              {s.photoSize ? `${s.photoSize.w}×${s.photoSize.h}` : t('Format')}
            </button>
            <SeedControl />
          </div>
        )}
        {mode === 'video' && <div style={{ marginTop: 16 }}><SeedControl /></div>}

        {/* ---- draft & multi-shot: TWO independent toggles ---- */}
        {mode === 'video' && vidOp !== 'replay' && (
          <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
            <Toggle on={!!v.draft} title={t('Brouillon')} hint={eng.draft ? t(eng.draft.label) : undefined}
              disabledReason={eng.draft ? undefined : t('Indisponible sur {engine}', { engine: v.engine })}
              onChange={d => s.updateVideo({ draft: d })} />
            <Toggle on={!!v.multiShot} title={t('MultiPlan')} hint={t('plans enchaînés dans un seul clip')}
              onChange={m => s.updateVideo({ multiShot: m })} />
          </div>
        )}
        {mode === 'video' && vidOp === 'replay' && (
          <div style={{ marginTop: 16 }}>
            <Toggle on={!!v.motionPreview} title={t('Prévisu 480p')} hint={t('environ deux fois plus rapide')}
              onChange={p => s.updateVideo({ motionPreview: p })} />
          </div>
        )}

        {/* ---- quantity ---- */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <span className="label" style={{ margin: 0, flex: 1 }}>{t('Nombre de rendus')}</span>
          <Stepper value={s.batchCount} onChange={s.setBatchCount} label={t('nombre de rendus')} />
        </div>

        {s.t0Error && <p className="err">{s.t0Error}</p>}
        {!online && (
          <p className="err">
            {t('Hors ligne. Ton brouillon est conservé ; l’envoi repartira quand tu le décideras, une fois la connexion revenue.')}
          </p>
        )}

        <div className="ctawrap">
          <button className="cta" onClick={() => void send()} disabled={sending || !online}>
            {sending ? t('Envoi…') : !online ? t('Hors ligne') : label}
            <small>&nbsp;· ~{fmtDur(total)}</small>
          </button>
          {sent && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }} role="status">
              <span className="muted" style={{ flex: 1, fontSize: 14 }}>{sent}</span>
              <button className="chip on" onClick={goJobs}>{t('Voir les jobs')}</button>
            </div>
          )}
        </div>
      </div>

      {/* ---------- sheets ---------- */}
      {sheet === 'engine' && (
        <Sheet title={t('Moteur vidéo')} onClose={() => setSheet(null)}>
          {VIDEO_ENGINES.filter(e => !e.optionnel || s.h3?.disponible).map(e => (
            <Opt key={e.key} label={t(e.label)} on={v.engine === e.key}
              hint={[e.force && t(e.force), e.audio ? t('audio') : t('muet'), `${e.maxSeconds} s max`].filter(Boolean).join(' · ')}
              onClick={() => { s.updateVideo({ engine: e.key }); setSheet(null) }} />
          ))}
        </Sheet>
      )}
      {sheet === 'duration' && (
        <Sheet title={t('Durée')} onClose={() => setSheet(null)}>
          {[3, 4, 5, 6, 8, 10, 12, 16, 20].filter(n => n <= eng.maxSeconds).map(n => (
            <Opt key={n} label={t('{n} secondes', { n })} on={v.durationS === n}
              onClick={() => { s.updateVideo({ durationS: n }); setSheet(null) }} />
          ))}
        </Sheet>
      )}
      {sheet === 'format' && (
        mode === 'video'
          ? <Sheet title={t('Format')} onClose={() => setSheet(null)}>
            {(['origine', '9:16', '2:3', '3:4', '1:1', '16:9'] as VideoAspect[]).map(f => (
              <Opt key={f} label={f === 'origine' ? t('Origine (ratio exact de la source)') : f} on={v.aspect === f}
                onClick={() => { s.updateVideo({ aspect: f }); setSheet(null) }} />
            ))}
          </Sheet>
          : <Sheet title={t('Format')} onClose={() => setSheet(null)}>
            {[[768, 1344, '9:16 portrait'], [896, 1152, '3:4 portrait'], [1024, 1024, '1:1 carré'],
              [1152, 896, '4:3 paysage'], [1344, 768, '16:9 paysage']].map(([w, h, lab]) => (
              <Opt key={lab as string} label={t(lab as string)} hint={`${w} × ${h}`}
                on={s.photoSize?.w === w && s.photoSize?.h === h}
                onClick={() => { s.setPhotoSize({ w: w as number, h: h as number, label: lab as string }); setSheet(null) }} />
            ))}
          </Sheet>
      )}

      {picker && (
        <MSourcePicker role={picker.role} onClose={() => setPicker(null)} />
      )}
      {enhance && <MEnhance onClose={() => setEnhance(false)} />}
      {elements && <MElements onClose={() => setElements(false)} />}
    </>
  )
}

function OpBtn({ on, icon, label, onClick }: { on: boolean; icon: 'wand' | 'brush' | 'film' | 'replay' | 'extend'; label: string; onClick: () => void }) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick} aria-pressed={on}>
      <Ic n={icon} s={22} />{label}
    </button>
  )
}

function hintOf(mode: string, img: ImgOp, vid: VidOp) {
  if (mode === 'photo') {
    return img === 'generate' ? t('Créer une image à partir d’un texte.')
      : t('Appliquer une instruction à une image existante.')
  }
  if (vid === 'animate') return t('Animer une image fixe.')
  if (vid === 'ambiance') return t('Plan d’ambiance sans le personnage, à partir du texte (LTX-2.5, avec le son).')
  if (vid === 'extend') return t('Ajouter une suite à un clip existant.')
  return t('Animer une image avec le mouvement d’une vidéo.')
}

/* ---------- source ---------- */
function SourceRow({ label, hint, uri, name, required, onPick }: {
  label: string; hint?: string; uri?: string; name?: string; required?: boolean; onPick: () => void
}) {
  const isVid = /\.(mp4|webm|mov)$/i.test(name ?? '') || /\.(mp4|webm|mov)$/i.test(uri ?? '')
  return (<>
    <div className="label">{label}{required && <span style={{ color: 'var(--acc)' }}> *</span>}</div>
    <button className="rowbtn" onClick={onPick}>
      {uri
        ? (isVid ? <video className="thumb" src={uri} muted playsInline /> : <img className="thumb" src={uri} alt="" />)
        : <span className="thumb" style={{ display: 'grid', placeItems: 'center', color: 'var(--tx3)', fontSize: 24 }}>＋</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{uri ? (name ? name.slice(0, 26) : t('Média choisi')) : t('Choisir')}</b>
        <small style={{ display: 'block' }}>{uri ? t('Bibliothèque ou téléphone') : (hint ?? t('Bibliothèque ou téléphone'))}</small>
      </span>
      <Ic n={uri ? 'refresh' : 'skip'} s={18} />
    </button>
  </>)
}

/* ---------- seed ---------- */
function SeedControl() {
  const s = useAppStore()
  const fixed = s.seedMode === 'lock'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
      <button className={`chip ${fixed ? 'on' : ''}`} onClick={s.toggleSeedMode}
        style={{ flex: 'none' }} aria-pressed={fixed}>
        {fixed ? t('Seed fixe') : t('🎲 Aléatoire')}
      </button>
      {fixed && (
        <input className="field" style={{ flex: 1, padding: '10px 12px' }} inputMode="numeric"
          value={String(s.seedValue ?? '')} aria-label={t('valeur de la seed')}
          onChange={e => {
            // numeric string: beyond 2^53 a seed would lose digits
            const digits = e.target.value.replace(/\D/g, '').slice(0, 15)
            if (digits) s.setSeedValue(Number(digits))
          }} />
      )}
    </div>
  )
}
