/* ============================================================
   Visionneuse mobile — média plein écran, actions de tri,
   reprise (cloner / animer / prolonger / HD) et informations.
   ============================================================ */
import { resumeControle } from '../lib/controle'
import { useEffect, useRef, useState } from 'react'
import type { LoraLigne } from '../v2/Viewer'
import { createPortal } from 'react-dom'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, Opt, Sheet, fmtDur, useConfirm } from './bits'
import { FolderSheet } from './MLibrary'
import { MCarousel } from './MCarousel'
import { getLang, t } from '../i18n'
import { lancerFinition } from '../v2/bits'
import { Pinceau } from '../components/Pinceau'
import { EditionVideo } from '../components/EditionVideo'
import { useEdition } from '../lib/proprietaire'

interface FolderInfo { id: string; name: string; createdAt: number; count: number }

export function MViewer({ asset, list, onGo, onClose, folders, onFoldersChanged, onTriage }: {
  asset: Asset; list: Asset[]; onGo: (a: Asset) => void; onClose: () => void
  folders: FolderInfo[]; onFoldersChanged: () => void; onTriage?: () => void
}) {
  const edition = useEdition()
  const s = useAppStore()
  const [sheet, setSheet] = useState<null | 'more' | 'info' | 'folders' | 'carousel'>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pinceau, setPinceau] = useState(false)
  const [editer, setEditer] = useState(false)
  const [armed, arm] = useConfirm()
  const [busy, setBusy] = useState('')
  /* Liste de navigation CAPTURÉE à l'entrée : changer un statut pendant le
     tri ne doit pas réordonner la liste sous le doigt (spec p. 5). */
  const navList = useRef(list.map(a => a.id))
  const idx = navList.current.indexOf(asset.id)
  const fresh = s.assets.find(a => a.id === asset.id) ?? asset
  const go = (d: 1 | -1) => {
    const i = idx + d
    if (i < 0 || i >= navList.current.length) return
    const next = s.assets.find(a => a.id === navList.current[i])
    if (next) onGo(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* Balayage horizontal = navigation, jamais validation (spec p. 5).
     Un geste vertical ou un pincement ne déclenchent rien : ils servent au
     défilement et au zoom. */
  const touch = useRef<{ x: number; y: number; multi: boolean } | null>(null)
  const onStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, multi: e.touches.length > 1 }
  }
  const onEnd = (e: React.TouchEvent) => {
    const t = touch.current; touch.current = null
    if (!t || t.multi || e.touches.length) return
    const dx = e.changedTouches[0].clientX - t.x
    const dy = e.changedTouches[0].clientY - t.y
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1)
  }

  const isVid = fresh.mediaType === 'video'
  const p = fresh.provenance
  /* Pile de LoRA du rendu : minuscule, rechargée à chaque asset. Le graphe
     complet, lui, reste hors de la galerie — trop lourd à transporter. */
  const [loras, setLoras] = useState<LoraLigne[] | null>(null)
  useEffect(() => {
    setLoras(null)
    let vivant = true
    void fetch(`/api/assets/${encodeURIComponent(fresh.id)}/loras`).then(r => r.json())
      .then(d => { if (vivant) setLoras(d.loras ?? []) }).catch(() => { if (vivant) setLoras([]) })
    return () => { vivant = false }
  }, [fresh.id])
  const folderNames = (fresh.folders ?? [])
    .map(id => folders.find(f => f.id === id)?.name).filter((n): n is string => !!n)

  const act = async (label: string, fn: () => Promise<unknown> | unknown) => {
    setBusy(label)
    try { await fn() } finally { setBusy('') }
  }

  return createPortal(
    <div className="m viewer">
      <div className="vtop">
        <button onClick={onClose} aria-label={t('fermer')}><Ic n="back" s={24} /></button>
        <span className="muted" style={{ fontSize: 14 }}>{idx + 1} / {navList.current.length}</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => setSheet('more')} aria-label={t('plus d’actions')}>
          <Ic n="more" s={24} />
        </button>
      </div>

      {/* `zoomable` : le pinch agrandit le MÉDIA (index.css le réserve à
          cette classe, l'interface elle-même ne zoome pas). */}
      <div className="stage zoomable" onTouchStart={onStart} onTouchEnd={onEnd}>
        {isVid
          ? <video src={fresh.uri} controls playsInline autoPlay loop muted={false} />
          : <img src={fresh.uri} alt="" />}
      </div>

      <div className="vbot">
        <button className={`act ok ${fresh.reviewStatus === 'approved' ? 'on' : ''}`}
          onClick={() => s.reviewAsset(fresh.id, fresh.reviewStatus === 'approved' ? 'pending' : 'approved')}>
          <Ic n="heart" s={20} />{t('Valider')}
        </button>
        <button className={`act ko ${fresh.reviewStatus === 'rejected' ? 'on' : ''}`}
          onClick={() => s.reviewAsset(fresh.id, fresh.reviewStatus === 'rejected' ? 'pending' : 'rejected')}>
          <Ic n="x" s={20} />{t('Refuser')}
        </button>
        <button className="act" onClick={() => void act('clone', () => { s.cloneFrom(fresh); onClose() })}>
          <Ic n="clone" s={20} />{t('Cloner')}
        </button>
        {!isVid && (
          <button className="act" onClick={() => void act('animer', async () => { await s.animateFrom(fresh); onClose() })}>
            <Ic n="camera" s={20} />{t('Animer')}
          </button>
        )}
        {!isVid && (
          <button className="act" onClick={() => void act('éditer', async () => { await s.retouchFrom(fresh); onClose() })}>
            <Ic n="brush" s={20} />{t('Éditer')}
          </button>
        )}
        {isVid && fresh.videoDraft && (
          <button className="act" onClick={() => void act('hd', async () => {
            await fetch(`/api/assets/${encodeURIComponent(fresh.id)}/upscale`, { method: 'POST' })
            await s.hydrate(); onClose()
          })}><Ic n="hd" s={20} />{t('Passer en HD')}</button>
        )}
        {/* « Plus » AUSSI en bas : le coin haut-droit est le point le plus
            difficile à atteindre au pouce sur un grand téléphone, et c'est
            là que le ⋯ se trouve. Les deux ouvrent la même feuille. */}
        <button className="act" onClick={() => setSheet('more')} aria-label={t('plus d’actions')}>
          <Ic n="more" s={20} />{t('Plus')}
        </button>
        {busy && <div className="muted" style={{ width: '100%', textAlign: 'center', fontSize: 13 }}>…{t(busy)}</div>}
        {msg && !busy && <div className="muted" style={{ width: '100%', textAlign: 'center', fontSize: 13 }}>{msg}</div>}
      </div>

      {pinceau && <Pinceau asset={fresh} onClose={() => setPinceau(false)} />}
      {editer && <EditionVideo asset={fresh} onClose={() => setEditer(false)} onPinceau={() => setPinceau(true)} />}
      {sheet === 'more' && (
        <Sheet title={t('Actions')} onClose={() => setSheet(null)}>
          <Opt label={t('Informations')} hint={t('prompt, seed, moteur, dossiers')} onClick={() => setSheet('info')} />
          {isVid
            ? <Opt label={t('✎ Éditer')} hint={t('au pinceau ou au prompt')} onClick={() => { setSheet(null); setEditer(true) }} />
            : <Opt label={t('🖌 Pinceau')} hint={t('peindre une zone et la refaire, le reste ne change pas')}
                onClick={() => { setSheet(null); setPinceau(true) }} />}
          <Opt label={t('Ranger dans un dossier')} onClick={() => setSheet('folders')} />
          {fresh.jobId && !fresh.postOp && (
            <Opt label={t('Encore une')} hint={t('mêmes réglages, nouvelle graine')}
              onClick={() => void act('encore une', async () => { const e = await s.encoreUne(fresh); setMsg(e ?? t('encore une : en file')); setSheet(null) })} />
          )}
          {isVid && !fresh.withAudio && (
            <Opt label={t('Ajouter le son')} hint={t('ambiance calée sur les images, sans voix ni musique')}
              onClick={() => void act('son', async () => { const e = await lancerFinition(fresh, 'foley'); setMsg(e ?? t('son en cours : un nouveau clip arrive dans la bibliothèque')); setSheet(null) })} />
          )}
          {isVid && fresh.postOp !== 'interpolate' && (
            <Opt label={t('Fluidité ×2 (48 i/s)')} hint={t('double les images, mouvement plus fluide')}
              onClick={() => void act('fluidité', async () => { const e = await lancerFinition(fresh, 'interpolate'); setMsg(e ?? t('fluidité en cours : un nouveau clip arrive dans la bibliothèque')); setSheet(null) })} />
          )}
          {!isVid && (
            <Opt label={t('Carrousel')} hint={t('huit variations de la même scène')}
              onClick={() => setSheet('carousel')} />
          )}
          {isVid && (
            <Opt label={t('Prolonger')} hint={t('ajouter une suite à ce clip')} onClick={() => {
              s.updateVideo({ task: 'extend' }); void s.pickExtendClip(fresh.id); onClose()
            }} />
          )}
          <Opt label={t('Télécharger')} onClick={() => {
            const l = document.createElement('a')
            l.href = fresh.uri; l.download = fresh.uri.split('/').pop() ?? fresh.id
            document.body.appendChild(l); l.click(); l.remove()
            setSheet(null)
          }} />
          <Opt label={t('Copier le lien')} onClick={() => {
            void navigator.clipboard?.writeText(window.location.origin + fresh.uri); setSheet(null)
          }} />
          {onTriage && fresh.reviewStatus === 'pending' && (
            <Opt label={t('Trier les médias en attente')} onClick={onTriage} />
          )}
          {edition && <Opt label={armed ? t('⚠ Confirmer la suppression') : t('Supprimer')} onClick={() => {
            if (arm()) { void s.removeAsset(fresh.id); setSheet(null); onClose() }
          }} />}
        </Sheet>
      )}

      {sheet === 'info' && (
        <Sheet title={t('Informations')} onClose={() => setSheet(null)}>
          {/* La chaîne du prompt dans l'ordre où elle s'est faite : brief →
              ce que le VLM a lu dans la still → prompt envoyé. Voir la vision
              séparément est ce qui permet de dire si un prompt surprenant
              vient d'une image mal lue ou d'une consigne mal suivie. */}
          {p?.initialBrief && p.initialBrief !== (p.composedPositive || p.userPrompt) && (
            <Info k={t('Brief initial')} v={p.initialBrief} wrap />
          )}
          {p?.promptVision && <Info k={t('👁 Vision VLM de la still')} v={p.promptVision} wrap />}
          <Info k={p?.promptVision || p?.initialBrief ? t('Prompt composé') : t('Prompt')}
            v={p?.composedPositive || p?.userPrompt || '—'} wrap copy />
          {p?.composedNegative && <Info k={t('Négatif')} v={p.composedNegative} wrap />}
          <Info k={t('Format')} v={fresh.aspect + (fresh.videoDraft ? t(' · brouillon') : '')} />
          <Info k={t('Dimensions')} v={fresh.width && fresh.height ? `${fresh.width} × ${fresh.height}` : '—'} />
          {isVid && <Info k={t('Moteur')} v={fresh.videoEngine ?? '—'} />}
          {isVid && <Info k={t('Contrôle')} wrap v={resumeControle(fresh.controle) ?? t('en cours ou indisponible')} />}
          <Info k={t('Seed')} copy v={p?.seed?.value != null
            ? `${p.seed.value} · ${(p.selections as { seed?: { mode?: string } } | undefined)?.seed?.mode === 'lock' ? t('fixe') : t('aléatoire')}`
            : t('aléatoire')} />
          <Info k={t('Recette')} v={p?.recipeId || '—'} />
          {/* La pile de LoRA telle qu'elle a tourné, lue dans le graphe : la
              recette n'en montre aucune, et `extra_loras` oublie l'identité. */}
          <Info k={t('LoRA appliquées')} wrap v={loras == null ? '…' : loras.length === 0 ? t('aucune')
            : loras.map(l => `${l.label} @ ${l.strength == null ? '—' : l.strength.toFixed(2).replace('.', getLang() === 'en' ? '.' : ',')}`).join('\n')} />
          <Info k={t('Rendu')} v={fresh.renderMs ? fmtDur(fresh.renderMs) : '—'} />
          <Info k={t('Dossiers')} v={folderNames.length ? folderNames.join(', ') : t('aucun')} />
          <Info k={t('Job')} v={`#${fresh.jobId}`} />
        </Sheet>
      )}

      {sheet === 'folders' && (
        <FolderSheet folders={folders} assetIds={[fresh.id]} onChanged={onFoldersChanged}
          onClose={() => setSheet(null)} />
      )}

      {sheet === 'carousel' && (
        <MCarousel asset={fresh} onClose={() => setSheet(null)}
          onSent={() => { setSheet(null); onClose() }} />
      )}

    </div>, document.body)
}

function Info({ k, v, wrap, copy }: { k: string; v: string; wrap?: boolean; copy?: boolean }) {
  return (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="muted" style={{ fontSize: 13, flex: 'none' }}>{k}</span>
        {copy && (
          <button className="tap-sm" style={{ marginLeft: 'auto', color: 'var(--acc)', fontSize: 13, minHeight: 32, padding: 0 }}
            onClick={() => void navigator.clipboard?.writeText(v)}>{t('copier')}</button>
        )}
      </div>
      <div style={{ fontSize: wrap ? 14 : 15, marginTop: 3, lineHeight: 1.45, whiteSpace: wrap ? 'pre-wrap' : undefined }}>{v}</div>
    </div>
  )
}
