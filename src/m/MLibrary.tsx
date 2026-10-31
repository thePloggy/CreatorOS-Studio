/* ============================================================
   Bibliothèque mobile — grille, filtres combinés, sélection,
   dossiers, tri rapide, visionneuse.
   ============================================================ */
import { badgesOf, matchSearch } from '../v2/bits'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { vignetteOf } from '../components/AssetMedia'
import { STATUTS_EN_CALCUL } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, Opt, Seg, Sheet, dayLabel, useConfirm } from './bits'
import { CorbeilleButton } from '../components/Corbeille'
import { FOLDER_SORTS, trierDossiers, type FolderSort } from '../lib/folders'
import { MViewer } from './MViewer'
import { MTriage } from './MTriage'
import { t, tp } from '../i18n'
import { Comparer } from '../components/Comparer'
import { useEdition } from '../lib/proprietaire'

type TypeFilter = 'all' | 'photo' | 'video'
type Status = 'all' | 'pending' | 'approved' | 'rejected'
interface FolderInfo { id: string; name: string; createdAt: number; count: number }
/** Pseudo-dossier : les médias qui n'appartiennent à AUCUN dossier. C'est
 *  l'outil qui rend le rangement faisable — sans lui, impossible de savoir
 *  ce qui reste à classer. */
const ORPHANS = '__sans_dossier__'

export function MLibrary({ goCreate, goJobs }: { goCreate: () => void; goJobs: () => void }) {
  const s = useAppStore()
  const [menu, setMenu] = useState<Asset | null>(null)
  const [type, setType] = useState<TypeFilter>('all')
  const [status, setStatus] = useState<Status>('all')
  const [folder, setFolder] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<'all' | 'draft' | 'full'>('all')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState(false)
  const [sheet, setSheet] = useState<null | 'filters' | 'folders'>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Asset | null>(null)
  const [triage, setTriage] = useState(false)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const loadFolders = () => void fetch('/api/folders').then(r => r.json())
    .then(d => setFolders(d.folders ?? [])).catch(() => {})
  const personaId = useAppStore(st => st.personaId)
  useEffect(() => { loadFolders(); setFolder(null) }, [personaId])   // dossiers cloisonnés par personnage

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return s.assets.filter(a => {
      if (type !== 'all' && a.mediaType !== type) return false
      if (status !== 'all' && a.reviewStatus !== status) return false
      if (folder === ORPHANS) { if ((a.folders ?? []).length) return false }
      else if (folder && !(a.folders ?? []).includes(folder)) return false
      if (drafts !== 'all') {
        if (a.mediaType !== 'video') return false
        if (drafts === 'draft' ? !a.videoDraft : !!a.videoDraft) return false
      }
      if (needle && !matchSearch(a, needle)) return false
      return true
    }).sort((a, b) => b.createdAt - a.createdAt)
  }, [s.assets, type, status, folder, drafts, q])

  /* Groupes JOURNALIERS : au rythme de production actuel, un mois entasse
     des centaines de rendus sous un seul titre. */
  const groups = useMemo(() => {
    const out: { label: string; items: Asset[] }[] = []
    const now = new Date()
    for (const a of shown) {
      const label = dayLabel(a.createdAt, now)
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] })
      out[out.length - 1].items.push(a)
    }
    return out
  }, [shown])

  const orphanCount = useMemo(() => s.assets.filter(a => !(a.folders ?? []).length).length, [s.assets])
  const activeFilters = (status !== 'all' ? 1 : 0) + (folder ? 1 : 0) + (drafts !== 'all' ? 1 : 0)
  const running = s.jobs.filter(j => STATUTS_EN_CALCUL.includes(j.status)).length
  const queued = s.jobs.filter(j => j.status === 'queued').length
  const pendingCount = s.assets.filter(a => a.reviewStatus === 'pending').length

  const toggle = (id: string) => setPicked(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const clearPick = () => { setPicked(new Set()); setPicking(false) }
  const resetFilters = () => { setStatus('all'); setFolder(null); setDrafts('all'); setQ('') }

  const title = folder === ORPHANS ? t('Sans dossier')
    : folder ? (folders.find(f => f.id === folder)?.name ?? t('Dossier'))
    : status === 'pending' ? t('À trier') : status === 'approved' ? t('Validés')
    : status === 'rejected' ? t('Refusés') : t('Bibliothèque')

  return (
    <>
      <div className="htitle">
        <div className="row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{title}</h1>
            <p>{tp(shown.length, '{n} média', '{n} médias')}{activeFilters ? t(' · filtré') : ''}</p>
          </div>
          <button aria-label={t('rechercher')} onClick={() => setSearch(v => !v)}
            style={{ color: search || q ? 'var(--acc)' : 'var(--tx2)' }}><Ic n="search" s={24} /></button>
        </div>
      </div>

      <div className="scroll">
        {search && (
          <input className="field" autoFocus placeholder={t('rechercher dans les prompts…')}
            value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 12 }} />
        )}

        <Seg value={type} onPick={setType}
          options={[['all', t('Tout')], ['photo', t('Images')], ['video', t('Vidéos')]]} />

        <div className="chipline" style={{ margin: '12px 0' }}>
          <button className={`chip ${status === 'pending' ? 'on' : ''}`}
            onClick={() => setStatus(v => v === 'pending' ? 'all' : 'pending')}>
            <Ic n="triage" s={16} /> {t('À trier')}{pendingCount ? ` ${pendingCount}` : ''}
          </button>
          <button className={`chip ${activeFilters && status !== 'pending' ? 'on' : ''}`} onClick={() => setSheet('filters')}>
            <Ic n="filters" s={16} /> {t('Filtres')}{activeFilters ? ` ${activeFilters}` : ''}
          </button>
          <button className={`chip ${folder ? 'on' : ''}`} onClick={() => setSheet('folders')}>
            <Ic n="folder" s={16} /> {t('Dossiers')}
          </button>
          <CorbeilleButton className="chip" />
        </div>

        {(running + queued) > 0 && (
          <button className="jobbar" onClick={goJobs} style={{ marginBottom: 12 }}>
            <span className="spin" />
            <span style={{ flex: 1, textAlign: 'left' }}>
              <b style={{ display: 'block', fontSize: 15 }}>
                {t('{running} en cours · {queued} en attente', { running, queued })}
              </b>
              <small className="muted">{t('Ton rendu continue sur la machine')}</small>
            </span>
            <Ic n="skip" s={18} />
          </button>
        )}

        {shown.length > 0 && (
          <div className="secttl" style={{ marginTop: 4 }}>
            <b>{groups[0]?.label}</b>
            <span>
              <button style={{ color: 'var(--acc)', padding: '0 4px' }}
                onClick={() => { if (picking) clearPick(); else setPicking(true) }}>
                {picking ? t('Terminer') : t('Sélectionner')}
              </button>
            </span>
          </div>
        )}

        {groups.map((g, gi) => (
          <div key={g.label}>
            {gi > 0 && <div className="secttl"><b>{g.label}</b></div>}
            <div className="grid">
              {g.items.map(a => (
                <Tile key={a.id} a={a} picking={picking} picked={picked.has(a.id)}
                  onPick={() => toggle(a.id)} onOpen={() => setOpen(a)} onLong={() => setMenu(a)} />
              ))}
            </div>
          </div>
        ))}

        {shown.length === 0 && (
          <div className="empty">
            {activeFilters || q ? (<>
              {t('Rien avec ces filtres.')}<br />
              <button style={{ color: 'var(--acc)', marginTop: 8 }} onClick={resetFilters}>{t('Réinitialiser')}</button>
            </>) : (<>
              {t("Aucun média pour l'instant.")}<br />
              <button style={{ color: 'var(--acc)', marginTop: 8 }} onClick={goCreate}>{t('Créer le premier')}</button>
            </>)}
          </div>
        )}
      </div>

      {picked.size > 0 && (
        <SelBar ids={[...picked]} assets={s.assets} folders={folders}
          onClear={clearPick} onFoldersChanged={loadFolders} />
      )}

      {sheet === 'filters' && (
        <Sheet title={t('Filtres')} onClose={() => setSheet(null)}>
          <div className="label" style={{ marginTop: 0 }}>{t('Statut')}</div>
          <Seg value={status} onPick={setStatus}
            options={[['all', t('Tout')], ['pending', t('À trier')], ['approved', t('Validés')], ['rejected', t('Refusés')]]} />
          <div className="label">{t('Qualité vidéo')}</div>
          <Seg value={drafts} onPick={setDrafts}
            options={[['all', t('Toutes')], ['draft', t('Brouillons')], ['full', t('Qualité finale')]]} />
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="chip" style={{ flex: 1, justifyContent: 'center' }} onClick={resetFilters}>{t('Réinitialiser')}</button>
            <button className="cta" style={{ flex: 2, padding: 14 }} onClick={() => setSheet(null)}>
              {tp(shown.length, 'Voir {n} résultat', 'Voir {n} résultats')}
            </button>
          </div>
        </Sheet>
      )}

      {sheet === 'folders' && (
        <FolderSheet folders={folders} current={folder} orphanCount={orphanCount}
          onPick={f => { setFolder(f); setSheet(null) }}
          onChanged={loadFolders} onClose={() => setSheet(null)} />
      )}

      {open && (
        <MViewer asset={open} list={shown} onGo={setOpen} onClose={() => setOpen(null)}
          folders={folders} onFoldersChanged={loadFolders} onTriage={() => { setOpen(null); setTriage(true) }} />
      )}
      {menu && <TileMenu a={menu} onClose={() => setMenu(null)} onPick={() => { setPicking(true); toggle(menu.id) }} />}
      {triage && <MTriage assets={s.assets.filter(a => a.reviewStatus === 'pending')} onClose={() => setTriage(false)} />}
    </>
  )
}

/* ---------- vignette ---------- */
/** Retour haptique court. Sans effet là où le navigateur ne le propose pas (Safari iOS). */
const vibrer = (ms = 12) => { try { navigator.vibrate?.(ms) } catch { /* non pris en charge */ } }

/** Feuille de partage du téléphone : le fichier lui-même si le navigateur l'accepte, sinon son lien. */
async function partager(a: Asset): Promise<string | null> {
  const nom = a.uri.split('/').pop() ?? a.id
  try {
    const blob = await (await fetch(a.uri)).blob()
    const fichier = new File([blob], nom, { type: blob.type || (a.mediaType === 'video' ? 'video/mp4' : 'image/png') })
    if (navigator.canShare?.({ files: [fichier] })) { await navigator.share({ files: [fichier] }); return null }
    if (navigator.share) { await navigator.share({ url: new URL(a.uri, location.href).href }); return null }
    return t('partage indisponible dans ce navigateur')
  } catch (e) {
    return (e as Error).name === 'AbortError' ? null : t('partage impossible : {msg}', { msg: (e as Error).message })
  }
}

/* Appui long sur une tuile (13/10) : les gestes du tri sans ouvrir l'image. */
function TileMenu({ a, onClose, onPick }: { a: Asset; onClose: () => void; onPick: () => void }) {
  const edition = useEdition()
  const s = useAppStore()
  const [arme, armer] = useConfirm()
  const [msg, setMsg] = useState<string | null>(null)
  const frais = s.assets.find(x => x.id === a.id) ?? a
  return (
    <Sheet title={a.mediaType === 'video' ? t('Vidéo') : t('Image')} onClose={onClose}>
      <Opt label={t('Partager')} hint={msg ?? t('feuille de partage du téléphone')} onClick={async () => { const e = await partager(frais); if (e) setMsg(e); else onClose() }} />
      <Opt label={frais.reviewStatus === 'approved' ? t('Retirer la validation') : t('Valider')} on={frais.reviewStatus === 'approved'}
        onClick={() => { vibrer(); s.reviewAsset(frais.id, frais.reviewStatus === 'approved' ? 'pending' : 'approved'); onClose() }} />
      <Opt label={frais.reviewStatus === 'rejected' ? t('Annuler le refus') : t('Refuser')} on={frais.reviewStatus === 'rejected'}
        onClick={() => { vibrer(); s.reviewAsset(frais.id, frais.reviewStatus === 'rejected' ? 'pending' : 'rejected'); onClose() }} />
      <Opt label={t('Reprendre les réglages')} hint={t('prompt et graine dans Créer')} onClick={() => { s.cloneFrom(frais); onClose() }} />
      <Opt label={t('Sélectionner')} hint={t('pour ranger ou trier plusieurs médias')} onClick={() => { onPick(); onClose() }} />
      {edition && <Opt label={arme ? t('Confirmer la suppression') : t('Supprimer')} hint={t('en corbeille 30 jours')}
        onClick={() => { if (armer()) { vibrer(20); void s.removeAssets([frais.id]); onClose() } }} />}
    </Sheet>
  )
}

function Tile({ a, picking, picked, onPick, onOpen, onLong }: {
  a: Asset; picking: boolean; picked: boolean; onPick: () => void; onOpen: () => void; onLong: () => void
}) {
  const isVid = a.mediaType === 'video'
  /* Appui long : 450 ms sans bouger. Le clic qui suit le relâchement est avalé. */
  const appui = useRef<{ t: number; x: number; y: number; long: boolean } | null>(null)
  const debut = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const etat = { t: window.setTimeout(() => { etat.long = true; vibrer(); onLong() }, 450), x: e.clientX, y: e.clientY, long: false }
    appui.current = etat
  }
  const bouge = (e: React.PointerEvent) => {
    const p = appui.current
    if (p && !p.long && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) { window.clearTimeout(p.t); appui.current = null }
  }
  const fin = () => { if (appui.current && !appui.current.long) { window.clearTimeout(appui.current.t); appui.current = null } }
  const clip = (a.provenance?.selections as { durationS?: number } | undefined)?.durationS
  return (
    /* `button` et non `div` : c'est une cible tactile, elle doit être
       atteignable au clavier et annoncée comme telle. */
    <button className={`tile ${picked ? 'picked' : ''}`} style={{ padding: 0, textAlign: 'left', WebkitTouchCallout: 'none', userSelect: 'none' }}
      onPointerDown={debut} onPointerMove={bouge} onPointerUp={fin} onPointerCancel={fin} onContextMenu={e => e.preventDefault()}
      aria-label={`${isVid ? t('vidéo') : t('image')} — ${a.reviewStatus === 'approved' ? t('validée') : a.reviewStatus === 'rejected' ? t('refusée') : t('à trier')}`}
      onClick={() => { if (appui.current?.long) { appui.current = null; return } (picking ? onPick() : onOpen()) }}>
      {/* poster pour les vidéos : pas d'autoplay massif au défilement
          (spec p. 18) — la lecture se fait dans la visionneuse. */}
      <img src={vignetteOf(a)}
        alt="" loading="lazy" decoding="async"
        onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = '0' }} />
      {isVid && <span className="play"><Ic n="play" s={15} /></span>}
      {a.videoDraft || a.t2v || a.postOp || (isVid && a.withAudio)
        ? <span className="tag">{badgesOf(a).filter(b => b.cle !== 'm').map(b => b.txt).join(' · ')}</span>
        : (a.batchIds?.length ?? 0) > 1
          ? <span className="tag"><Ic n="layers" s={13} /> {t('{n} variantes', { n: a.batchIds!.length })}</span>
          : null}
      {picking && (
        <button className={`pick ${picked ? 'on' : ''}`} aria-label={picked ? t('désélectionner') : t('sélectionner')}
          onClick={e => { e.stopPropagation(); onPick() }}>{picked ? '✓' : ''}</button>
      )}
      <span className="foot">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Ic n={isVid ? 'play' : 'image'} s={14} />
          {isVid ? (clip ? `${clip} s` : t('Vidéo')) : t('Image')}
        </span>
        <span style={{ color: a.reviewStatus === 'approved' ? 'var(--ok)' : a.reviewStatus === 'rejected' ? 'var(--ko)' : 'var(--tx2)' }}>
          {a.reviewStatus === 'approved' ? t('✓ Validé') : a.reviewStatus === 'rejected' ? t('Refusé') : t('À trier')}
        </span>
      </span>
    </button>
  )
}

/* ---------- barre d'actions de sélection ---------- */
function SelBar({ ids, assets, folders, onClear, onFoldersChanged }: {
  ids: string[]; assets: Asset[]; folders: FolderInfo[]; onClear: () => void; onFoldersChanged: () => void
}) {
  const edition = useEdition()
  const s = useAppStore()
  const [armed, arm] = useConfirm()
  const [sheet, setSheet] = useState<null | 'folders' | 'more'>(null)
  const [comparer, setComparer] = useState(false)
  const sel = assets.filter(a => ids.includes(a.id))
  const allDrafts = sel.length > 0 && sel.every(a => a.mediaType === 'video' && a.videoDraft)

  const upscaleAll = async () => {
    for (const a of sel) await fetch(`/api/assets/${encodeURIComponent(a.id)}/upscale`, { method: 'POST' })
    await s.hydrate(); onClear()
  }
  return (
    <>
      <div className="selbar">
        <button onClick={() => { sel.forEach(a => s.reviewAsset(a.id, 'approved')); onClear() }}
          style={{ color: 'var(--ok)' }}><Ic n="heart" s={18} /><br />{t('Valider')}</button>
        <button onClick={() => { sel.forEach(a => s.reviewAsset(a.id, 'rejected')); onClear() }}
          style={{ color: 'var(--ko)' }}><Ic n="x" s={18} /><br />{t('Refuser')}</button>
        <button onClick={() => setSheet('folders')}><Ic n="folder" s={18} /><br />{t('Ranger')}</button>
        <button onClick={() => setSheet('more')}><Ic n="more" s={18} /><br />{tp(ids.length, '{n} choisi', '{n} choisis')}</button>
      </div>

      {sheet === 'folders' && (
        <FolderSheet folders={folders} assetIds={ids} onChanged={onFoldersChanged}
          onClose={() => setSheet(null)} onDone={onClear} />
      )}
      {sheet === 'more' && (
        <Sheet title={tp(ids.length, '{n} média sélectionné', '{n} médias sélectionnés')} onClose={() => setSheet(null)}>
          <Opt label={allDrafts ? t('Passer en HD ({n})', { n: ids.length }) : t('Passer en HD — brouillons vidéo uniquement')}
            hint={allDrafts ? t('mouvement conservé, réimprimé en haute résolution') : t('la sélection contient autre chose qu’un brouillon vidéo')}
            onClick={() => { if (allDrafts) void upscaleAll() }} />
          <Opt label={t('Comparer')} hint={sel.length >= 2 && sel.length <= 4 ? t('côte à côte, vidéos lues ensemble') : t('sélectionne 2 à 4 rendus')}
            onClick={() => { if (sel.length >= 2 && sel.length <= 4) { setSheet(null); setComparer(true) } }} />
          <Opt label={t('Télécharger')} hint={t('un fichier après l’autre')} onClick={async () => {
            for (const a of sel) {
              const l = document.createElement('a')
              l.href = a.uri; l.download = a.uri.split('/').pop() ?? a.id
              document.body.appendChild(l); l.click(); l.remove()
              await new Promise(r => setTimeout(r, 250))
            }
            setSheet(null)
          }} />
          {edition && <Opt label={armed ? t('⚠ Confirmer la suppression de {n}', { n: ids.length }) : tp(ids.length, 'Supprimer {n} média', 'Supprimer {n} médias')}
            onClick={() => { if (arm()) { void s.removeAssets(ids); setSheet(null); onClear() } }} />}
        </Sheet>
      )}
      {comparer && <Comparer assets={sel} onClose={() => setComparer(false)} />}
    </>
  )
}

/* ---------- feuille dossiers : filtre OU rangement ---------- */
export function FolderSheet({ folders, current, orphanCount, assetIds, onPick, onChanged, onClose, onDone }: {
  folders: FolderInfo[]; current?: string | null; orphanCount?: number
  assetIds?: string[]                    // si fourni : mode RANGEMENT (cases)
  onPick?: (f: string | null) => void    // si fourni : mode FILTRE
  onChanged: () => void; onClose: () => void; onDone?: () => void
}) {
  const s = useAppStore()
  const ranging = !!assetIds
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  /* Coches OPTIMISTES : dépendre du rechargement global ferait clignoter la
     case entre deux appuis. */
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    if (!assetIds) return {}
    const sel = useAppStore.getState().assets.filter(a => assetIds.includes(a.id))
    const out: Record<string, boolean> = {}
    for (const f of folders) out[f.id] = sel.length > 0 && sel.every(a => (a.folders ?? []).includes(f.id))
    return out
  })

  const create = async () => {
    if (!name.trim()) return
    await fetch('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    })
    setName(''); setAdding(false); onChanged()
  }
  const toggleFolder = async (id: string) => {
    if (!assetIds) return
    const next = !checked[id]
    setChecked(c => ({ ...c, [id]: next }))
    await fetch(`/api/folders/${encodeURIComponent(id)}/assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next ? { add: assetIds } : { remove: assetIds }),
    })
    onChanged(); void s.hydrate()
  }

  return (
    <Sheet title={ranging ? tp(assetIds!.length, 'Ranger {n} média', 'Ranger {n} médias') : t('Dossiers')} onClose={onClose}>
      {adding ? (
        <div style={{ display: 'flex', gap: 8, paddingBottom: 12 }}>
          <input className="field" autoFocus placeholder={t('nom du dossier')} value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false) }} />
          <button className="cta" style={{ width: 'auto', padding: '0 18px' }}
            disabled={!name.trim()} onClick={() => void create()}>{t('Créer')}</button>
        </div>
      ) : (
        <button className="opt" onClick={() => setAdding(true)} style={{ color: 'var(--acc)' }}>
          <Ic n="folder" s={18} /> {t('Ajouter un dossier')}
        </button>
      )}

      {!ranging && (<>
        <Opt label={t('Tous les médias')} on={!current} onClick={() => onPick?.(null)} />
        <Opt label={t('Sans dossier')} hint={tp(orphanCount ?? 0, '{n} média non rangé', '{n} médias non rangés')}
          on={current === ORPHANS} onClick={() => onPick?.(ORPHANS)} />
      </>)}

      {/* Ordre des dossiers : MÊME réglage que le desktop (store persisté) —
          on le règle là où on regarde les dossiers, pas dans un écran à part. */}
      {folders.length > 1 && (
        <div style={{ padding: '12px 0 4px' }}>
          <Seg value={s.folderSort}
            options={FOLDER_SORTS.map(o => [o.id, t(o.court)] as [FolderSort, string])}
            onPick={v => s.setFolderSort(v)} />
        </div>
      )}

      {trierDossiers(folders, s.folderSort).map(f => (
        <Opt key={f.id} label={f.name} hint={tp(f.count, '{n} média', '{n} médias')}
          on={ranging ? !!checked[f.id] : current === f.id}
          onClick={() => (ranging ? void toggleFolder(f.id) : onPick?.(f.id))} />
      ))}
      {folders.length === 0 && <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>{t('Aucun dossier pour l’instant.')}</p>}

      {ranging && (
        <button className="cta" style={{ marginTop: 16 }} onClick={() => { onClose(); onDone?.() }}>{t('Terminé')}</button>
      )}
    </Sheet>
  )
}
