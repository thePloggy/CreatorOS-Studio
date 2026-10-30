/* ============================================================
   v2 — vue Vidéo : sidebar de création (100% de la zone sous header) + la
   bibliothèque vidéo. Onglets Créer (i2v) / Rejouer (motion control :
   une still rejoue le geste d'une vidéo) / Étendre.
   Tâches : i2v=Créer · motion_pure=Rejouer · extend=Étendre.
   ============================================================ */
import { LoraStacks, LoraSwitch, loraFamily } from '../components/LoraStacks'
import { useBriefHistory } from '../components/BriefHistory'
import { useEffect, useMemo, useState } from 'react'
import type { Asset, VideoAspect } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { engineInfo, moteurT2v, VIDEO_ENGINES } from '../features/console/video/engines'
import { Ic, rollingEta, fmtDur, SortBar, AssetCard, JobCard, FailCard, failedJobs, SeedPill, JustifiedGrid, ratioOf, MobileSheet, SelectionBar, applyFilters, useConfirm, V2Portal, useExclusiveMenu, type ReviewFilter, type DraftFilter } from './bits'
import { EnhancerPopup, FramePicker, TriagePopup } from './popups'
import { getLang, t, tp } from '../i18n'
import { useEdition } from '../lib/proprietaire'

/* Durées proposées, filtrées au rendu par le plafond du moteur choisi
   (`engineInfo().maxSeconds`, fourni par le serveur). Une liste figée
   masquait les durées qu'un moteur sait tenir : H3 est passé à 12 s le 21/09
   et le menu s'arrêtait toujours à 10. Même liste que le mobile. */
const DUR = [3, 4, 5, 6, 8, 10, 12, 16, 20]

/* Menu contextuel générique des pills vidéo (durée/fps/format) — même
   facture que les menus de l'îlot image : portal .v2, ancré bas, exclusif. */
function PickMenu<T extends string | number>({ at, onClose, options, current, fmt, onPick }: {
  at: { x: number; bottom: number }; onClose: () => void
  options: readonly T[]; current: T; fmt: (v: T) => string; onPick: (v: T) => void
}) {
  useExclusiveMenu(onClose)
  return (
    <V2Portal>
      <div className="menu" style={{ left: at.x, bottom: at.bottom, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        {options.map(o => (
          <button key={String(o)} style={o === current ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
            onClick={() => { onPick(o); onClose() }}>{fmt(o)}{o === current ? ' ✓' : ''}</button>
        ))}
      </div>
    </V2Portal>
  )
}
const ASPECTS: VideoAspect[] = ['origine', '9:16', '2:3', '3:4', '1:1', '16:9']

type VTab = 'creer' | 'ambiance' | 'rejouer' | 'etendre'

export function VideoView({ onOpen }: { onOpen: (a: Asset, list: Asset[]) => void }) {
  const edition = useEdition()
  const s = useAppStore()
  const [review, setReview] = useState<ReviewFilter>(null)
  const [cols, setCols] = useState(() => (window.innerWidth < 821 ? 2 : 5))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const picking = picked.size > 0
  const [enh, setEnh] = useState(false)
  const [triage, setTriage] = useState(false)
  const [elm, setElm] = useState(false)
  const [framePick, setFramePick] = useState<null | 'start' | 'end' | 'still'>(null)
  const [engOpen, setEngOpen] = useState(false)
  const [vMenu, setVMenu] = useState<{ kind: 'dur' | 'fps' | 'aspect'; x: number; bottom: number } | null>(null)
  const [purgeArmed, armPurge] = useConfirm()
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<DraftFilter>('all')
  const [loraOpen, setLoraOpen] = useState(false)
  const [selecting, setSelecting] = useState<null | 'start' | 'still'>(null)
  const isMobile = window.innerWidth < 821

  useEffect(() => { if (s.mode !== 'video') s.setMode('video') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const v = s.video
  const tab: VTab = v.task === 'extend' ? 'etendre' : v.task === 'motion_pure' ? 'rejouer' : v.task === 't2v' ? 'ambiance' : 'creer'
  const eng = engineInfo(v.task === 't2v' ? moteurT2v(Boolean(v.t2vPersonnage && s.personaVideo && s.personaVideoWan)) : v.engine)

  const shown = useMemo(() => applyFilters(s.assets, selecting ? 'photo' : 'video', review, q)
    .filter(a => selecting || draft === 'all' || (draft === 'draft' ? !!a.videoDraft : !a.videoDraft)),
  [s.assets, review, q, selecting, draft])
  const activeJobs = s.jobs.filter(j => j.mode === 'video' && STATUTS_ACTIFS.includes(j.status))
  const queueIds = activeJobs.filter(j => j.status === 'queued').map(j => j.id)
  const failed = failedJobs(s.jobs, true)
  const briefs = useBriefHistory('video', s.userPrompt, s.setUserPrompt)

  const startUri = v.startFrameUri
    || (v.startAssetId ? s.assets.find(a => a.id === v.startAssetId)?.uri : undefined)
  const endUri = v.endAssetId ? s.assets.find(a => a.id === v.endAssetId)?.uri
    : v.endFrameFile ? `/api/uploads/${encodeURIComponent(v.endFrameFile)}` : undefined

  const purge = async () => {
    if (!armPurge()) return
    const ids = s.assets.filter(a => a.mediaType === 'video' && a.reviewStatus === 'rejected').map(a => a.id)
    await s.removeAssets(ids)
  }

  const vidEtaMs = rollingEta(s.assets,
    a => a.mediaType === 'video' && a.videoEngine === eng.key && !!a.videoDraft === !!v.draft,
    (v.draft ? (eng.draft?.minutes ?? 2) : eng.minutes) * 60000)

  return (
    <div className="flex-1 min-h-0 flex layer1 vwrap2" style={{ overflow: 'hidden' }}>
      {briefs.panel}
      {/* ---------- création : sidebar (desktop) / sheet à crans (mobile) ---------- */}
      {(() => { const side = (<>
        <div className="flex gap-1 rounded-[11px] p-[3px]" style={{ background: 'var(--lv2)' }}>
          {(['creer', 'ambiance', 'rejouer', 'etendre'] as VTab[]).map(tb => (
            <button key={tb}
              className="flex-1 text-center text-[11px] leading-tight py-1.5 px-1 rounded-lg"
              style={{ background: tab === tb ? 'var(--lv4)' : 'transparent', color: tab === tb ? 'var(--text)' : 'var(--muted)', border: 0, cursor: 'pointer' }}
              onClick={() => s.updateVideo({ task: tb === 'creer' ? 'i2v' : tb === 'ambiance' ? 't2v' : tb === 'etendre' ? 'extend' : 'motion_pure' })}>
              {tb === 'creer' ? t('Depuis une image') : tb === 'ambiance' ? t('Depuis un texte') : tb === 'rejouer' ? t('Rejouer') : t('Étendre')}
            </button>
          ))}
        </div>

        {/* ============ CRÉER (i2v) ============ */}
        {tab === 'creer' && (<>
          <div className="flex gap-2">
            <button className={`slot ${startUri ? 'filled' : ''}`} onClick={() => (isMobile ? setSelecting('start') : setFramePick('start'))}>
              {startUri ? <img src={startUri} alt="" /> : <>＋<br />{t('Frame départ')}</>}
              {v.startFrameFile && <em>{v.startFrameFile.slice(0, 24)}</em>}
              {startUri && <RetirerFrame titre={t('retirer la frame de départ')}
                onRetirer={() => s.updateVideo({ startAssetId: null, startFrameFile: '', startFrameUri: '', startFrameError: '' })} />}
            </button>
            <button className={`slot ${endUri ? 'filled' : ''}`} onClick={() => setFramePick('end')}>
              <span className="opt">{t('optionnel')}</span>
              {endUri ? <img src={endUri} alt="" /> : <>＋<br />{t('Frame fin')}</>}
              {endUri && <RetirerFrame titre={t('retirer la frame de fin')} onRetirer={() => s.updateVideo({ endAssetId: null, endFrameFile: '', endFrameError: '' })} />}
            </button>
          </div>
          {v.startFrameError && <div className="text-[10.5px]" style={{ color: 'var(--danger)' }}>{v.startFrameError}</div>}
          {v.endFrameError && <div className="text-[10.5px]" style={{ color: 'var(--danger)' }}>{v.endFrameError}</div>}
          {endUri && v.engine !== 'minimax' && (
            <div className="text-[10.5px]" style={{ color: 'var(--attention)' }}>{t('frame de fin ignorée : seuls les moteurs MiniMax H3 savent arriver sur une image')}</div>
          )}
          <button className={`tgl ${v.multiShot ? 'on' : ''}`} onClick={() => s.updateVideo({ multiShot: !v.multiShot })}>
            <b>{t('Multi-plan')}</b> <span className="text-[9.5px]">{t('plans [Shot 1..n] chaînés')}</span><span className="sw" />
          </button>
          <div className="varea">
            <textarea placeholder={t('Mouvement — une action claire, temps réel…')}
              value={s.userPrompt} onChange={e => s.setUserPrompt(e.target.value)} onKeyDown={briefs.onKeyDown} />
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={() => setEnh(true)}>✦ Enhancer</button>
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={briefs.open} title={t('briefs récents et étoilés (↑ dans un champ vide)')}>↺ Briefs</button>
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={() => setElm(true)}>LoRA</button>
              <SeedPill />
              <button className={`pill tool ${v.withAudio ? 'used' : ''}`} style={{ fontSize: 10.5 }} onClick={() => s.updateVideo({ withAudio: !v.withAudio })}>🔊 {v.withAudio ? t('audio') : t('muet')}</button>
            </div>
          </div>
          <button className="engine" onClick={() => setEngOpen(o => !o)}>
            <span className="nm"><b>{eng.label}</b><span className="ml-auto" style={{ color: 'var(--faint)' }}>›</span></span>
            <span className="caps">
              <span className="cap">≤{eng.maxSeconds} s</span>
              {eng.audio && <span className="cap">{t('audio natif')}</span>}
              {eng.draft && <span className="cap">{t('brouillon dispo')}</span>}
            </span>
          </button>
          {engOpen && (
            <div className="flex flex-col gap-1">
              {VIDEO_ENGINES.map(e => (
                <button key={e.key} className="engine" style={v.engine === e.key ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.35)' } : undefined}
                  onClick={() => { s.updateVideo({ engine: e.key }); setEngOpen(false) }}>
                  <span className="nm">{e.label}<span className="ml-auto text-[9.5px]" style={{ color: 'var(--faint)' }}>~{e.minutes} min</span></span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5 flex-wrap">
            {([['dur', `${v.durationS} s`], ['fps', `${v.fps} fps`], ['aspect', v.aspect]] as const).map(([k, label]) => (
              <button key={k} className="pill" style={{ flex: 1, justifyContent: 'center' }}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  if (vMenu?.kind === k) { setVMenu(null); return }
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setVMenu({ kind: k, x: Math.min(r.left, window.innerWidth - 180), bottom: window.innerHeight - r.top + 6 })
                }}>{label}</button>
            ))}
          </div>
          {vMenu?.kind === 'dur' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={DUR.filter(d => d <= eng.maxSeconds)} current={v.durationS}
            fmt={o => `${o} s`} onPick={o => s.updateVideo({ durationS: o })} />}
          {vMenu?.kind === 'fps' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={[24, 30] as const} current={v.fps}
            fmt={o => `${o} fps`} onPick={o => s.updateVideo({ fps: o })} />}
          {vMenu?.kind === 'aspect' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={ASPECTS} current={v.aspect}
            fmt={o => o === 'origine' ? t('origine (still)') : o} onPick={o => s.updateVideo({ aspect: o })} />}
          <LoraFold open={loraOpen} setOpen={setLoraOpen} />
          <div className="flex gap-1.5 flex-wrap items-center">
            {eng.draft && (
              <button className={`pill tool ${v.draft ? 'used' : ''}`} onClick={() => s.updateVideo({ draft: !v.draft })}>
                {t('brouillon')} <small>{t(eng.draft.label)}</small>
              </button>
            )}
          </div>
        </>)}

        {/* ============ AMBIANCE (texte → vidéo, LTX-2.5) ============ */}
        {tab === 'ambiance' && (() => { const avecPerso = Boolean(v.t2vPersonnage && s.personaVideo); return (<>
          <div className="text-[10.5px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            {avecPerso
              ? t('Le personnage apparaît depuis le texte seul, grâce à sa LoRA vidéo : décris la scène, l’action et la caméra.')
              : t('Plan de coupe sans le personnage : un lieu, une lumière, un mouvement de caméra. Il part du texte seul, avec le son d’ambiance.')}
          </div>
          {s.personaVideo && (
            <div className="flex gap-1">
              {([[false, t('Ambiance seule')], [true, t('Avec {nom}', { nom: s.personaName })]] as const).map(([on, label]) => (
                <button key={String(on)} className={`pill ${avecPerso === on ? 'used' : ''}`} style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                  onClick={() => s.updateVideo({ t2vPersonnage: on })}>{label}</button>
              ))}
            </div>
          )}
          <div className="varea">
            <textarea placeholder={t('Ex. : vagues au coucher du soleil sur une plage déserte, lent travelling latéral, bruit des vagues')}
              value={s.userPrompt} onChange={e => s.setUserPrompt(e.target.value)} onKeyDown={briefs.onKeyDown} />
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={briefs.open} title={t('briefs récents et étoilés (↑ dans un champ vide)')}>↺ Briefs</button>
              <SeedPill />
              <button className={`pill tool ${v.withAudio ? 'used' : ''}`} style={{ fontSize: 10.5 }} onClick={() => s.updateVideo({ withAudio: !v.withAudio })}>🔊 {v.withAudio ? t('audio') : t('muet')}</button>
            </div>
          </div>
          <div className="engine">
            <span className="nm"><b>{eng.label}</b></span>
            <span className="caps">
              <span className="cap">{t('texte → vidéo')}</span>
              <span className="cap">≤{eng.maxSeconds} s</span>
              <span className="cap">{t('audio natif')}</span>
            </span>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {([['dur', `${v.durationS} s`], ['fps', `${v.fps} fps`], ['aspect', v.aspect === 'origine' ? '9:16' : v.aspect]] as const).map(([k, label]) => (
              <button key={k} className="pill" style={{ flex: 1, justifyContent: 'center' }}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  if (vMenu?.kind === k) { setVMenu(null); return }
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setVMenu({ kind: k, x: Math.min(r.left, window.innerWidth - 180), bottom: window.innerHeight - r.top + 6 })
                }}>{label}</button>
            ))}
          </div>
          {vMenu?.kind === 'dur' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={DUR.filter(d => d <= eng.maxSeconds)} current={v.durationS}
            fmt={o => `${o} s`} onPick={o => s.updateVideo({ durationS: o })} />}
          {vMenu?.kind === 'fps' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={[24, 30] as const} current={v.fps}
            fmt={o => `${o} fps`} onPick={o => s.updateVideo({ fps: o })} />}
          {vMenu?.kind === 'aspect' && <PickMenu at={vMenu} onClose={() => setVMenu(null)} options={ASPECTS.filter(a => a !== 'origine')} current={v.aspect}
            fmt={o => o} onPick={o => s.updateVideo({ aspect: o })} />}
          {eng.draft && (
            <div className="flex gap-1.5 flex-wrap items-center">
              <button className={`pill tool ${v.draft ? 'used' : ''}`} onClick={() => s.updateVideo({ draft: !v.draft })}>
                {t('brouillon')} <small>{t(eng.draft.label)}</small>
              </button>
            </div>
          )}
        </>) })()}

        {/* ============ REJOUER (motion control) ============ */}
        {tab === 'rejouer' && (<>
          <div className="modes">
            <button className={`mode ${v.motionMode !== 'replace' ? 'on' : ''}`} onClick={() => s.updateVideo({ motionMode: 'animate' })}>
              <b>Move</b><small>{t('la still bouge comme la vidéo')}</small>
            </button>
            <button className={`mode ${v.motionMode === 'replace' ? 'on' : ''}`} onClick={() => s.updateVideo({ motionMode: 'replace' })}>
              <b>Mix</b><small>{t('elle prend la place du personnage de la vidéo')}</small>
            </button>
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            {v.motionMode === 'replace'
              ? t('Le personnage actif prend la place de celui de la vidéo source, dans son décor et avec ses gestes. Il est d’abord rendu en pied dans la même tenue, puis son identité tient par sa LoRA vidéo Wan.')
              : t('La still bouge comme la vidéo source : seul le geste est transféré, le décor et le personnage viennent de la still.')}
          </div>
          <div className="flex gap-2">
            {!edition && <div className="text-[10.5px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{t('Sur la démo publique, on part d’une image générée par le studio : l’envoi de vidéos est réservé au propriétaire.')}</div>}
            {edition && <label className={`slot ${v.motionDriverFile ? 'filled' : ''}`}>
              <span className="opt">{v.motionMode === 'replace' ? (getLang() === 'fr' ? '3-9,6 s' : '3-9.6 s') : '3-30 s'}</span>
              {v.motionRefUri ? <video src={v.motionRefUri} muted /> : <>▶＋<br />{t('Vidéo driver')}</>}
              {v.motionDriverFile && <em>{v.motionDriverFile.slice(0, 22)}</em>}
              <input type="file" accept="video/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) void s.uploadMotionDriver(f) }} />
            </label>}
            {v.motionMode !== 'replace' && (
              <button className={`slot ${v.motionStillFile ? 'filled' : ''}`} onClick={() => setFramePick('still')}>
                {v.motionStillUri ? <img src={v.motionStillUri} alt="" /> : <>＋<br />{t('still de départ')}</>}
              </button>
            )}
          </div>
          {/* Mix borné à 153 images (server/jobs.js, MIX_MAX_IMAGES) : dit AVANT le lancement */}
          {v.motionMode === 'replace' && (
            <div className="text-[10.5px]" style={{ color: v.motionDriverSeconds > 9.6 ? 'var(--warn, #ffb648)' : 'var(--muted)', lineHeight: 1.5 }}>
              {v.motionDriverSeconds > 9.6
                ? t('Ta vidéo dure {s} s : le Mix n’en garde que les 9,6 premières secondes.', { s: v.motionDriverSeconds.toFixed(1).replace('.', getLang() === 'fr' ? ',' : '.') })
                : t('Mix : 9,6 s de vidéo au plus, au-delà la fin est coupée.')}
              {v.motionDriverSeconds > 9.6 && (
                <label className="flex items-center gap-2 mt-1" style={{ color: 'var(--muted)' }}>
                  {t('Commencer à {s} s', { s: v.mixDebut.toFixed(1) })}
                  <input type="range" min={0} max={Math.max(0, v.motionDriverSeconds - 3)} step={0.5} value={v.mixDebut} onChange={e => s.updateVideo({ mixDebut: Number(e.target.value) })} style={{ flex: 1 }} />
                </label>
              )}
            </div>
          )}
          {(v.motionDriverError || v.motionStillError) && (
            <div className="text-[10.5px]" style={{ color: 'var(--danger)' }}>{v.motionDriverError || v.motionStillError}</div>
          )}
          {/* Le texte PART au modèle : il doit être visible ici. Sans ce champ,
              le prompt resté dans « Créer » était envoyé à l'insu de l'opérateur. */}
          <div className="varea">
              <textarea placeholder={t('Facultatif — ce que montre la vidéo source : action, objets tenus. Vide = le geste seul.')}
                value={s.userPrompt} onChange={e => s.setUserPrompt(e.target.value)} />
              {s.userPrompt.trim() && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10.5px]" style={{ color: 'var(--warn, #ffb648)' }}>{t('ce texte sera envoyé au modèle')}</span>
                  <button className="pill" style={{ fontSize: 10, padding: '3px 9px', marginLeft: 'auto' }} onClick={() => s.setUserPrompt('')}>{t('vider')}</button>
                </div>
              )}
          </div>
          <div className="engine">
            <span className="nm"><b>WanAnimate 2.2</b></span>
            <span className="caps">
              <span className="cap">720p</span><span className="cap">{t('driver 16 fps')}</span><span className="cap">overlap 12</span>
            </span>
          </div>
          <button className={`pill tool ${v.motionPreview ? 'used' : ''}`} onClick={() => s.updateVideo({ motionPreview: !v.motionPreview })}>
              {t('prévisu 480p')} <small>{t('~2× plus rapide')}</small>
            </button>
        </>)}

        {/* ============ ÉTENDRE ============ */}
        {tab === 'etendre' && (<>
          {/* Prequel | Sequel (pattern Higgsfield « Edit video ») : sequel =
             dernière frame → frame de départ, le rendu suit le clip ; prequel =
             1re frame → frame de FIN, le rendu arrive sur le clip et passe devant
             (Wan : WanFirstLastFrameToVideo). */}
          <div className="wtabs" style={{ marginBottom: 2 }}>
            <button className={`wtab ${v.extendPrequel ? 'on' : ''}`} onClick={() => void s.setExtendPrequel(true)}
              title={t('le rendu arrive sur la 1re image du clip et se place devant lui')}>Prequel</button>
            <button className={`wtab ${v.extendPrequel ? '' : 'on'}`} onClick={() => void s.setExtendPrequel(false)}>Sequel</button>
          </div>
          <div className="flex gap-2">
            <button className={`slot ${v.extendVideoFile || v.extendAssetId ? 'filled' : ''}`} onClick={() => setFramePick('start')}>
              {v.extendVideoUri ? <video src={v.extendVideoUri} muted /> : <>▶＋<br />{t('vidéo à prolonger')}<br /><span className="text-[8.5px]">{t('bibliothèque (clic) ou dépôt')}</span></>}
            </button>
          </div>
          {edition && <label className="pill" style={{ fontSize: 10.5, justifyContent: 'center' }}>{t('⇪ déposer une vidéo')}
            <input type="file" accept="video/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void s.uploadExtendVideo(f) }} />
          </label>}
          <div className="text-[10px] rounded-[11px] p-2" style={{ color: 'var(--muted)', background: 'var(--lv2)', lineHeight: 1.5 }}>
            {v.extendPrequel
              ? t('Première frame extraite → frame de fin : le rendu arrive dessus et se place devant le clip. Moteur Wan.')
              : t('Dernière frame extraite → frame de départ. Couture : raccord couleur (luma + chroma) au harvest.')}
          </div>
          <div className="flex gap-1.5">
            {!v.extendPrequel && <button className={`pill tool ${v.extendPick === 'sharp' ? 'used' : ''}`} onClick={() => void s.setExtendPick(v.extendPick === 'last' ? 'sharp' : 'last')}>
              {v.extendPick === 'last' ? t('frame dernière') : t('frame plus nette')}
            </button>}
            <button className={`pill tool ${v.extendConcat ? 'used' : ''}`} onClick={() => s.updateVideo({ extendConcat: !v.extendConcat })}>
              + concat
            </button>
          </div>
          {v.extendError && <div className="text-[10.5px]" style={{ color: 'var(--danger)' }}>{v.extendError}</div>}
          {v.extendWarn && <div className="text-[10.5px]" style={{ color: 'var(--attention)' }}>{v.extendWarn}</div>}
          <div className="varea">
            <textarea placeholder={v.extendPrequel ? t('Ce qui se passe avant…') : t('Suite du mouvement…')} value={s.userPrompt} onChange={e => s.setUserPrompt(e.target.value)} onKeyDown={briefs.onKeyDown} />
            <div className="flex gap-1.5 mt-2">
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={() => setEnh(true)}>✦ Enhancer</button>
              <button className="pill tool" style={{ fontSize: 10.5 }} onClick={briefs.open} title={t('briefs récents et étoilés (↑ dans un champ vide)')}>↺ Briefs</button>
              <button className={`pill tool ${v.withAudio ? 'used' : ''}`} style={{ fontSize: 10.5 }} onClick={() => s.updateVideo({ withAudio: !v.withAudio })}>🔊</button>
            </div>
          </div>
        </>)}

        {s.t0Error && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{s.t0Error}</div>}
        {/* Nombre de rendus — COMMUN aux 3 onglets : cantonné à « Créer », un
            lot posé là restait actif en Rejouer/Étendre sans moyen de le
            corriger (le CTA annonçait « 4 jobs » sans stepper visible). */}
        <div className="flex items-center mt-auto mb-2">
          <span className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{t('nombre de rendus')}</span>
          <span className="stepper ml-auto">
            <button onClick={() => s.setBatchCount(Math.max(1, s.batchCount - 1))}>−</button>
            <span>× {s.batchCount}</span>
            <button onClick={() => s.setBatchCount(Math.min(10, s.batchCount + 1))}>+</button>
          </span>
        </div>
        <button className="cta" style={{ padding: isMobile ? '14px' : '26px 15px', flexDirection: 'row' }} onClick={() => void s.submitJob()}>
          {tab === 'etendre' ? t('Prolonger') : t('Générer')} <small>{s.batchCount} job{s.batchCount > 1 ? 's' : ''} · ~{fmtDur(s.batchCount * vidEtaMs)}</small>
        </button>
      </>)
      return isMobile
        ? <MobileSheet key={selecting ? 'sel' : 'norm'} initial={selecting ? 'mini' : 'half'}>{side}</MobileSheet>
        : <aside className="vside">{side}</aside> })()}

      {/* ---------- bibliothèque vidéo ---------- */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        <SortBar assets={s.assets.filter(a => a.mediaType === 'video')} draft={draft} setDraft={setDraft}
          review={review} setReview={setReview}
          cols={cols} setCols={setCols} picking={picking} setPicking={() => setPicked(new Set())}
          onPurge={purge} q={q} setQ={setQ} onTriage={() => setTriage(true)} />
        {purgeArmed && <div className="px-4 text-[11px]" style={{ color: 'var(--danger)' }}>{t('⚠ re-cliquer pour confirmer')}</div>}
        {picking && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6 }}>
          <SelectionBar ids={[...picked]} assets={s.assets} onClear={() => setPicked(new Set())} />
        </div>}
        <div className="scrollwrap"><div className="masonry"><JustifiedGrid cols={cols} items={[
          ...failed.map(j => ({ key: j.id, ratio: 9 / 16, node: <FailCard j={j} /> })),
          ...activeJobs.map(j => ({ key: j.id, ratio: 9 / 16, node: <JobCard j={j} queueIds={queueIds} /> })),
          ...shown.map(a => ({ key: a.id, ratio: ratioOf(a), node:
            <AssetCard a={a} onOpen={x => { if (selecting) { void (selecting === 'still' ? s.pickMotionStill(x.id) : s.pickStartFrame(x.id)); setSelecting(null) } else onOpen(x, shown) }}
              picking={picking} picked={picked.has(a.id)}
              onPick={id => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })}
              extra={<>
                <button className="fbtn" title={t('étendre (prolonger la vidéo)')} onClick={e => { e.stopPropagation(); s.updateVideo({ task: 'extend' }); void s.pickExtendClip(a.id) }}><Ic n="extend" /></button>
                {/* Upscale (brouillons seulement) : job serveur V2V refine —
                   le MÊME clip (mouvement conservé) réimprimé en ~1200p,
                   denoise 0.30 (seul réglage qui respecte l'expression). */}
                {a.videoDraft && (
                  <button className="fbtn" title={t('upscale : ce clip en haute résolution (mouvement conservé)')}
                    onClick={e => {
                      e.stopPropagation()
                      void fetch(`/api/assets/${encodeURIComponent(a.id)}/upscale`, { method: 'POST' })
                        .then(() => s.hydrate())
                    }}><Ic n="upscale" /></button>
                )}
              </>} /> })),
        ]} /></div></div>
      </div>

      {selecting && (
        <div className="selbar">
          <b>{selecting === 'still' ? t('Still de départ (Rejouer)') : t('Frame de départ')}</b> {t('— touche une vignette')}
          <button className="ml-auto b2" style={{ padding: '4px 10px' }} onClick={() => setSelecting(null)}>{t('annuler')}</button>
        </div>
      )}
      <TriagePopup open={triage} onClose={() => setTriage(false)} assets={s.assets.filter(a => a.mediaType === 'video')} />
      <EnhancerPopup open={enh} onClose={() => setEnh(false)}
        mode="video" engine={tab === 'rejouer' ? 'motion' : v.engine} userPrompt={s.userPrompt}
        /* La still que le rendu utilisera VRAIMENT comme première frame.
           Le choix suit `video.task`, EXACTEMENT comme la construction du job
           (motion_pure → motionRef, i2v → sourceImage). Une précédence
           aveugle `motionStillFile || startFrameFile` a fait décrire au VLM
           une still restée d'une sélection précédente pendant qu'un job i2v
           partait sur une autre image. */
        anchorFile={v.task === 'motion_pure' ? (v.motionStillFile || null) : (v.startFrameFile || null)}
        /* Étendre : le prompt du clip prolongé, relu dans sa provenance. Un
           clip déposé depuis le disque n'en a pas — la suite se fait alors
           sur la seule image. */
        previousPrompt={tab === 'etendre' && v.extendAssetId
          ? ((p => p?.composedPositive || p?.userPrompt || null)(s.assets.find(a => a.id === v.extendAssetId)?.provenance))
          : null}
        anchorUri={v.task === 'motion_pure' ? (v.motionStillUri || null)
          : (v.startFrameUri || s.assets.find(a => a.id === v.startAssetId)?.uri || null)}
        onReplace={(pos, vision) => {
          useAppStore.setState({ initialBrief: s.userPrompt, promptVision: vision })
          s.setUserPrompt(pos)
        }} />
      <VideoLoraPopup open={elm} onClose={() => setElm(false)} engine={v.engine} />
      <FramePicker open={framePick !== null} onClose={() => setFramePick(null)} assets={s.assets}
        title={framePick === 'end' ? t('Frame de fin (keyframe)') : framePick === 'still' ? t('Still de départ (Rejouer)') : tab === 'etendre' ? t('Vidéo à prolonger') : t('Frame de départ')}
        onPickAsset={a => {
          if (tab === 'etendre') { void s.pickExtendClip(a.id); return }
          if (framePick === 'end') { void s.pickEndFrame(a.id); return }
          if (framePick === 'still') { void s.pickMotionStill(a.id); return }
          void s.pickStartFrame(a.id)
        }}
        onPickUpload={name => {
          if (framePick === 'end') { s.updateVideo({ endAssetId: null, endFrameFile: name, endFrameError: '' }); return }
          if (framePick === 'still') { s.updateVideo({ motionStillFile: name, motionStillAssetId: null,
            motionStillUri: `/api/uploads/${encodeURIComponent(name)}`, motionStillError: '' }); return }
          s.updateVideo({ startFrameFile: name, startAssetId: null,
            startFrameUri: `/api/uploads/${encodeURIComponent(name)}`, startFrameError: '' })
        }}
        accept={tab === 'etendre' ? 'video/*' : 'image/*'}
        onUploadFile={f => {
          if (tab === 'etendre') { void s.uploadExtendVideo(f); return }
          if (framePick === 'still') { void s.uploadMotionStill(f); return }
          if (framePick === 'end') {
            void fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f })
              .then(r => r.json()).then(b => { if (b.filename) s.updateVideo({ endAssetId: null, endFrameFile: b.filename, endFrameError: '' }) })
            return
          }
          void s.uploadStartFrame(f)
        }} />
    </div>
  )
}

/* Petite croix d'une vignette de frame (au survol ; toujours visible au
   doigt). Un <span> et pas un <button> : elle vit DANS le bouton de la
   vignette, et le clic ne doit pas ouvrir le sélecteur. */
function RetirerFrame({ titre, onRetirer }: { titre: string; onRetirer: () => void }) {
  return (
    <span className="retirer" role="button" title={titre} aria-label={titre}
      onClick={e => { e.stopPropagation(); onRetirer() }}>✕</span>
  )
}

/* ---------- dépliant LoRA vidéo (comme le sélecteur de moteur) ----------
   Liste GET /api/loras via le store (loadLoras/loraCatalog). Masque les
   LoRAs déjà intégrées aux recettes MiniMax (turbo). */
/* Popup LoRA vidéo — prétriée par le moteur sélectionné :
   minimax → h3 ; wan → fichiers Wan ; ltx/ltx_hq → fichiers LTX.
   Empile dans videoLoras (le même store que le pli de la sidebar). */
const ENGINE_LORAS: Record<string, (l: { arch: string; name: string }) => boolean> = {
  minimax: l => l.arch === 'h3',
  wan: l => /wan/i.test(l.name),
  ltx: l => /ltx/i.test(l.name),
  ltx_hq: l => /ltx/i.test(l.name),
}
function VideoLoraPopup({ open, onClose, engine }: { open: boolean; onClose: () => void; engine: string }) {
  const catalog = useAppStore(st => st.loraCatalog)
  const loadLoras = useAppStore(st => st.loadLoras)
  const picks = useAppStore(st => st.video.videoLoras)
  const toggle = useAppStore(st => st.toggleVideoLora)
  const setStrength = useAppStore(st => st.setVideoLoraStrength)
  const [q, setQ] = useState('')
  useEffect(() => { if (open && !catalog.length) void loadLoras() }, [open, catalog.length, loadLoras])
  if (!open) return null
  const BAKED = ['h3_lightx2v_turbo_rank24.safetensors']
  const usable = catalog
    .filter(ENGINE_LORAS[engine] ?? (() => false))
    .filter(l => !BAKED.includes(l.name))
    .filter(l => !q.trim() || l.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="pop" onClick={onClose}>
      <div className="pbox" style={{ width: 'min(560px,94%)' }} onClick={e => e.stopPropagation()}>
        <h3>LoRA — {engine} <button className="x" onClick={onClose}>✕</button></h3>
        <input className="pin" style={{ marginTop: 8 }} placeholder={t('rechercher…')} value={q} onChange={e => setQ(e.target.value)} autoFocus />
        <LoraStacks cle={loraFamily(engine)} picks={picks} apply={items => useAppStore.getState().updateVideo({ videoLoras: items })} />
        <div className="flex flex-col gap-1 mt-2" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {usable.map(l => {
            const pick = picks.find(x => x.name === l.name)
            return (
              <div key={l.name} className="engine" style={pick ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.35)' } : undefined}>
                <span className="nm" style={{ cursor: 'pointer' }} onClick={() => toggle(l.name)}>
                  <span className="text-[11px] truncate">{l.name.replace(/\.safetensors$/, '')}</span>
                  <span className="ml-auto text-[10px]" style={{ color: pick ? 'var(--accent)' : 'var(--faint)' }}>{pick ? '✓' : '+'}</span>
                </span>
                {pick && (
                  <span className="flex items-center gap-2 mt-1.5 text-[10px]" style={{ color: 'var(--muted)', opacity: pick.off ? .5 : 1 }}>
                    <LoraSwitch off={pick.off} onToggle={() => useAppStore.getState().updateVideo({ videoLoras: picks.map(x => x.name === l.name ? { ...x, off: !x.off } : x) })} />
                    <input type="range" min={0} max={2} step={0.1} value={pick.strength}
                      style={{ flex: 1, accentColor: 'var(--accent)' }}
                      onChange={e => setStrength(l.name, Number(e.target.value))} />
                    <b style={{ color: 'var(--text)' }}>{pick.strength.toFixed(1)}</b>
                  </span>
                )}
              </div>
            )
          })}
          {usable.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 11, padding: 10 }}>{t('aucune LoRA pour ce moteur')}</div>}
        </div>
        <div className="prow"><button className="b2" onClick={onClose}>{t('Fermer')}</button></div>
      </div>
    </div>
  )
}

function LoraFold({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const catalog = useAppStore(st => st.loraCatalog)
  const loadLoras = useAppStore(st => st.loadLoras)
  const picks = useAppStore(st => st.video.videoLoras)
  const toggle = useAppStore(st => st.toggleVideoLora)
  const setStrength = useAppStore(st => st.setVideoLoraStrength)
  useEffect(() => { if (!catalog.length) void loadLoras() }, [catalog.length, loadLoras])
  const BAKED = ['h3_lightx2v_turbo_rank24.safetensors']
  const usable = catalog.filter(l => l.arch === 'h3' && !BAKED.includes(l.name))
  return (
    <div className="flex flex-col gap-1">
      <button className="engine" onClick={() => setOpen(!open)}>
        <span className="nm"><b>LoRA</b>
          <span className="ml-auto text-[10px]" style={{ color: picks.length ? 'var(--text)' : 'var(--faint)' }}>
            {picks.length ? tp(picks.length, '{n} empilée', '{n} empilées') : t('aucune')} ›
          </span>
        </span>
      </button>
      {open && usable.map(l => {
        const pick = picks.find(x => x.name === l.name)
        return (
          <div key={l.name} className="engine" style={pick ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.35)' } : undefined}>
            <span className="nm" style={{ cursor: 'pointer' }} onClick={() => toggle(l.name)}>
              <span className="text-[11px] truncate">{l.name.replace(/\.safetensors$/, '')}</span>
              <span className="ml-auto text-[10px]" style={{ color: pick ? 'var(--accent)' : 'var(--faint)' }}>{pick ? '✓' : '+'}</span>
            </span>
            {pick && (
              <span className="flex items-center gap-2 mt-1.5 text-[10px]" style={{ color: 'var(--muted)' }}>
                <input type="range" min={0} max={2} step={0.1} value={pick.strength}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                  onChange={e => setStrength(l.name, Number(e.target.value))} />
                <b style={{ color: 'var(--text)' }}>{pick.strength.toFixed(1)}</b>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
