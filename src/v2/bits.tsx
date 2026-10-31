/* ============================================================
   v2 — briques partagées : vignette d'asset, placeholder de job,
   barre de tri. Le langage visuel vit dans v2.css (élévation par
   luminance, zéro bordure) ; ici uniquement la structure.
   ============================================================ */
import { Children, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Job } from '../types'
import { STATUTS_EN_CALCUL } from '../types'
import { attente } from '../lib/attente'
import { useAppStore } from '../store/useAppStore'
import { posterOf, vignetteOf } from '../components/AssetMedia'
import { renderTime } from '../lib/renderTime'
import { CorbeilleButton } from '../components/Corbeille'
import { FOLDER_SORTS, trierDossiers } from '../lib/folders'
import { defautsDe } from '../lib/controle'
import { t, tp, tServeur } from '../i18n'
import { Comparer } from '../components/Comparer'
import { useEdition } from '../lib/proprietaire'

/* ---------- icônes SVG outline (design Higgsfield : trait 2px arrondi) ---------- */
const IC: Record<string, React.ReactNode> = {
  hd: <><path d="M3 7v10" /><path d="M9 7v10" /><path d="M3 12h6" /><path d="M13 7h3a5 5 0 0 1 0 10h-3z" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  camera: <><rect x="2" y="6" width="13" height="12" rx="2" /><path d="M15 10l7-4v12l-7-4" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" />,
  x: <><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>,
  dots: <><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  play: <path d="M7 4.5l12 7.5-12 7.5V4.5z" />,
  extend: <><path d="M4 5v14" /><path d="M9 12h11" /><path d="M16 8l4 4-4 4" /></>,
  upscale: <><rect x="4" y="10" width="10" height="10" rx="2" /><path d="M13 4h7v7" /><path d="M20 4l-7 7" /></>,
  dice: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.2" cy="8.2" r="1.4" fill="currentColor" stroke="none" /><circle cx="15.8" cy="8.2" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="8.2" cy="15.8" r="1.4" fill="currentColor" stroke="none" /><circle cx="15.8" cy="15.8" r="1.4" fill="currentColor" stroke="none" /></>,
  skip: <><path d="M5 4l10 8-10 8V4z" /><path d="M19 5v14" /></>,
  refresh: <><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.5 9a9 9 0 0 1 15-3.4L23 10" /><path d="M20.5 15a9 9 0 0 1-15 3.4L1 14" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  unlock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  clipboard: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>,
  folderIn: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><path d="M9 13h6" /><path d="M12.5 10.5L15 13l-2.5 2.5" /></>,
  folderOff: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><path d="M2 2l20 20" /></>,
  tag: <><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M7.5 7.5h.01" /></>,
  sound: <><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" /></>,
  wave: <><path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0" /><path d="M2 17c2-4 4-4 6 0s4 4 6 0 4-4 6 0" opacity=".5" /></>,
  columns: <><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  help: <><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.5" /><path d="M12 17.5h.01" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
}
export function Ic({ n, s: size = 13 }: { n: keyof typeof IC; s?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      {IC[n]}
    </svg>
  )
}

/* ---------- filtres de la barre de tri ---------- */
export type ReviewFilter = 'pending' | 'approved' | 'rejected' | null

export type DraftFilter = 'all' | 'draft' | 'full'
export function SortBar({ assets, review, setReview, cols, setCols, picking: _picking, setPicking: _setPicking, onPurge, q, setQ, onTriage, draft, setDraft }: {
  assets: Asset[]
  review: ReviewFilter; setReview: (r: ReviewFilter) => void
  cols: number; setCols: (n: number) => void
  picking: boolean; setPicking: (b: boolean) => void
  onPurge: () => void
  q: string; setQ: (v: string) => void
  onTriage?: () => void
  /** tri brouillon/full (vidéo) — puces affichées seulement si fourni */
  draft?: DraftFilter; setDraft?: (d: DraftFilter) => void
}) {
  const edition = useEdition()
  const qRef = useRef<HTMLInputElement>(null)
  // ⌘K / Ctrl+K : focus la recherche (remplace la palette v1 — filtre les prompts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); qRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const pending = assets.filter(a => a.reviewStatus === 'pending').length
  const rejected = assets.filter(a => a.reviewStatus === 'rejected').length
  const rv = (k: ReviewFilter) => () => setReview(review === k ? null : k)
  return (
    <div className="flex gap-1.5 items-center px-3.5 pt-3 pb-1 flex-wrap">
      <button className={`spill ${review === null ? 'on' : ''}`} onClick={() => setReview(null)}>{t('tout')}</button>
      <button className={`spill ${review === 'pending' ? 'on' : ''}`} onClick={rv('pending')}>
        {t('à revoir')} {pending > 0 && <b style={{ color: 'var(--attention)' }}>{pending}</b>}
      </button>
      <button className={`spill ok ${review === 'approved' ? 'on' : ''}`} onClick={rv('approved')}>♥ {t('validé')}</button>
      <button className={`spill ko ${review === 'rejected' ? 'on' : ''}`} onClick={rv('rejected')}>✕ {t('refusé')}</button>
      {draft && setDraft && (<>
        <span className="w-3" />
        <button className={`spill ${draft === 'all' ? 'on' : ''}`} onClick={() => setDraft('all')}>{t('tout')}</button>
        <button className={`spill ${draft === 'draft' ? 'on' : ''}`} onClick={() => setDraft('draft')}>{t('brouillons')}</button>
        <button className={`spill ${draft === 'full' ? 'on' : ''}`} onClick={() => setDraft('full')}>{t('full size')}</button>
      </>)}
      <span className="w-3" />
      <input ref={qRef} className="seedin" style={{ width: 150, fontFamily: 'inherit' }} placeholder={t('⌘K prompt, moteur, LoRA…')} title={t('cherche dans le prompt, le brief, la recette, le moteur et les LoRA')}
        value={q} onChange={e => setQ(e.target.value)} />
      {onTriage && pending > 0 && (
        <button className="spill" style={{ color: 'var(--attention)' }} onClick={onTriage}>⚡ {t('trier {n}', { n: pending })}</button>
      )}
      {edition && rejected > 0 && (
        <button className="spill purge" onClick={onPurge}>🗑 {t('supprimer les refusés ({n})', { n: rejected })}</button>
      )}
      <CorbeilleButton />
      <span className="inline-flex items-center gap-2 ml-auto text-[10px]" style={{ color: 'var(--faint)' }}>
        ▤ <input type="range" min={1} max={10} value={cols}
          onChange={e => setCols(Number(e.target.value))}
          style={{ width: 110, accentColor: 'var(--accent)' }} />
        <b>{cols}</b>{t('/ligne')}
      </span>
    </div>
  )
}

/** Recherche : chaque mot doit se trouver dans le prompt, le brief, la recette, le moteur ou une LoRA. */
export function matchSearch(a: Asset, q: string): boolean {
  const mots = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!mots.length) return true
  const hay = `${a.provenance.composedPositive ?? ''} ${a.provenance.userPrompt ?? ''} ${a.search ?? ''}`.toLowerCase()
  return mots.every(m => hay.includes(m))
}

export function applyFilters(assets: Asset[], media: 'photo' | 'video', review: ReviewFilter, q = '') {
  return assets.filter(a =>
    a.mediaType === media
    && (review === null || a.reviewStatus === review)
    && matchSearch(a, q))
}

/* ---------- masonry ordonné PAR LIGNES ----------
   CSS columns remplit colonne par colonne (ordre illisible). Ici :
   round-robin — l'item i va dans la colonne i % N, donc la lecture
   gauche→droite suit l'ordre (le plus récent en haut à gauche). */
export function Masonry({ cols, children }: { cols: number; children: React.ReactNode }) {
  /* Children.toArray APLATIT les tableaux imbriqués ({jobs.map()} +
     {assets.map()} = 2 enfants-tableaux sinon → 2 colonnes max). */
  const items = Children.toArray(children)
  const n = Math.max(1, cols)
  const buckets: React.ReactNode[][] = Array.from({ length: n }, () => [])
  items.forEach((c, i) => buckets[i % n].push(c))
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      {buckets.map((b, i) => (
        <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{b}</div>
      ))}
    </div>
  )
}

/* ---------- grille « justified rows » (style Higgsfield) ----------
   Lignes de hauteur ~fixe (cible dérivée de la densité), chaque vignette
   garde son RATIO exact et la ligne est mise à l'échelle pour remplir
   pile la largeur — zéro crop, zéro trou, rangées toujours alignées. */
export const ratioOf = (a: Asset): number => {
  if (a.width && a.height) return a.width / a.height
  const m = /^(\d+):(\d+)$/.exec(a.aspect ?? '')
  return m ? Number(m[1]) / Number(m[2]) : 9 / 16
}

/** Chargement progressif d'une grille (15/10) : les `depart` premières cartes,
 *  puis `pas` de plus chaque fois que la sentinelle (posée sous la grille)
 *  approche de l'écran — une ligne à la fois, jamais tout d'un coup. Sans ça,
 *  une bibliothèque de 1 800 rendus montait 1 800 cartes et leurs images.
 *  L'observateur est recréé à chaque palier : observer un élément déjà visible
 *  redéclenche le rappel, la grille se remplit donc jusqu'à déborder l'écran. */
export function useProgressif(total: number, depart = 40) {
  const [limite, setLimite] = useState(depart)
  const sentinelle = useRef<HTMLDivElement>(null)
  const pas = useRef(6)
  useEffect(() => {
    const el = sentinelle.current
    if (!el || limite >= total) return
    const io = new IntersectionObserver(e => {
      if (e[0]?.isIntersecting) setLimite(l => Math.min(total, l + Math.max(1, pas.current)))
    }, { rootMargin: '300px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [limite, total])
  return { limite, sentinelle, pas }
}

export function JustifiedGrid({ cols, items: recus, progressif = true }: {
  cols: number
  items: { key: string; ratio: number; node: React.ReactNode }[]
  /** false quand la vue gère elle-même le chargement progressif (plusieurs grilles) */
  progressif?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  /* Réorganisation différée (13/10) : un rendu qui arrive pendant que le pointeur
     travaille dans la grille décalerait la carte visée juste avant le clic. Tant que
     le pointeur bouge dessus, les cartes NOUVELLES attendent ; un retrait (tri,
     suppression : un geste de l'opérateur) s'applique tout de suite. Relâché dès que
     le pointeur sort ou s'arrête deux secondes. */
  const affiches = useRef(recus)
  const actifJusqua = useRef(0)
  const [, relacher] = useState(0)
  const minuteur = useRef<number | undefined>(undefined)
  const connues = new Set(affiches.current.map(i => i.key))
  const nouvelles = recus.some(i => !connues.has(i.key))
  const gele = nouvelles && Date.now() < actifJusqua.current
  let items = recus
  if (gele) {
    const frais = new Map(recus.map(i => [i.key, i]))
    items = affiches.current.filter(i => frais.has(i.key)).map(i => frais.get(i.key)!)   // ordre figé, contenu à jour
  } else affiches.current = recus
  const prog = useProgressif(items.length)
  if (progressif) items = items.slice(0, prog.limite)
  const bouge = () => {
    actifJusqua.current = Date.now() + 2000
    window.clearTimeout(minuteur.current)
    minuteur.current = window.setTimeout(() => relacher(n => n + 1), 2050)
  }
  const sort = () => { actifJusqua.current = 0; window.clearTimeout(minuteur.current); relacher(n => n + 1) }
  useEffect(() => () => window.clearTimeout(minuteur.current), [])
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el); setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const GAP = 8
  const target = Math.min(900, Math.max(90, w > 0 ? Math.round(w / (cols * 0.62)) : 240))
  const rows: { h: number; cells: typeof items }[] = []
  if (w > 0) {
    let cur: typeof items = []; let sum = 0
    for (const it of items) {
      cur.push(it); sum += it.ratio
      const h = (w - GAP * (cur.length - 1)) / sum
      if (h <= target) { rows.push({ h, cells: cur }); cur = []; sum = 0 }
    }
    if (cur.length) rows.push({ h: Math.min(target, (w - GAP * (cur.length - 1)) / sum), cells: cur })
  }
  // le palier suivant = une ligne de plus, à la largeur actuelle
  if (rows.length) prog.pas.current = rows[0].cells.length
  return (
    <div ref={ref} className="jgrid" onPointerMove={bouge} onPointerLeave={sort}>
      {rows.map((r, i) => (
        <div key={i} className="jrow" style={{ height: Math.round(r.h) }}>
          {r.cells.map(c => (
            <div key={c.key} className="jcell" style={{ width: Math.round(c.ratio * r.h) }}>{c.node}</div>
          ))}
        </div>
      ))}
      {progressif && items.length < recus.length && <div ref={prog.sentinelle} style={{ height: 1 }} />}
    </div>
  )
}

/* ---------- menu « Déplacer vers… » : dossiers à appartenances multiples ----------
   « + ajouter un dossier » STICKY en tête (champ + Créer, actif dès 1 lettre,
   doublons suffixés côté serveur) ; liste scrollable dans l'ordre choisi par
   l'opérateur (store.folderSort), une checkbox par dossier — cochée si TOUS
   les assets visés y sont. */
export interface FolderInfo { id: string; name: string; createdAt: number; count: number }

/* ---------- sélecteur d'ordre des dossiers ----------
   Le réglage vit dans le store (persisté) et vaut pour TOUTES les listes de
   dossiers de l'app : changer l'ordre ici range aussi le menu « Déplacer
   vers… », la fiche détail et le mobile. */
export function FolderSortButton() {
  const s = useAppStore()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const courant = FOLDER_SORTS.find(o => o.id === s.folderSort) ?? FOLDER_SORTS[0]
  return (
    <>
      <button className="ssort" title={t('ordre des dossiers — {x}', { x: t(courant.label) })}
        onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}>{t(courant.court)} ▾</button>
      {at && <FolderSortMenu at={at} onClose={() => setAt(null)} />}
    </>
  )
}

function FolderSortMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const s = useAppStore()
  useExclusiveMenu(onClose)
  return (
    <V2Portal>
      <div style={{ position: 'fixed', left: at.x, top: at.y, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        <div className="menu" style={{ position: 'relative' }}>
          <div className="mlabel">{t('Ordre des dossiers')}</div>
          {FOLDER_SORTS.map(o => (
            <button key={o.id} onClick={() => { s.setFolderSort(o.id); onClose() }}>
              <span className="fcheck" data-on={s.folderSort === o.id || undefined}>
                {s.folderSort === o.id ? '✓' : ''}
              </span>
              <span className="truncate">{t(o.label)}</span>
            </button>
          ))}
        </div>
      </div>
    </V2Portal>
  )
}
export function FolderMenu({ at, assetIds, onClose, onChanged, nested, side }: {
  at: { x: number; y?: number; bottom?: number }
  assetIds: string[]
  onClose: () => void
  onChanged?: () => void
  /** SOUS-menu d'un menu parent (⋯) : rendu absolu collé au parent, sans fermer celui-ci */
  nested?: boolean
  side?: 'left' | 'right'
}) {
  const s = useAppStore()
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  /* Coches OPTIMISTES : l'état local est la vérité de CE menu — dépendre du
     hydrate() global (1-2 s) faisait disparaître la coche entre deux clics. */
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const sel = useAppStore.getState().assets.filter(a => assetIds.includes(a.id))
    const out: Record<string, boolean> = {}
    const all = new Set(sel.flatMap(a => a.folders ?? []))
    for (const fid of all) out[fid] = sel.length > 0 && sel.every(a => (a.folders ?? []).includes(fid))
    return out
  })
  useExclusiveMenu(onClose, nested)
  const load = () => void fetch('/api/folders').then(r => r.json()).then(d => setFolders(d.folders ?? []))
  useEffect(load, [])
  const toggle = async (fid: string) => {
    const on = !!checked[fid]
    setChecked(c => ({ ...c, [fid]: !on }))
    await fetch(`/api/folders/${encodeURIComponent(fid)}/assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(on ? { remove: assetIds } : { add: assetIds }),
    })
    void s.hydrate(); load(); onChanged?.()
  }
  const create = async () => {
    if (!name.trim()) return
    await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }) })
    setName(''); setCreating(false); load()
  }
  const body = (
      <div className="menu foldermenu" style={{ position: 'relative' }}>
        <div className="fsticky">
          {creating ? (
            <span className="frow">
              <input className="pin" autoFocus style={{ marginTop: 0, padding: '6px 9px' }}
                placeholder={t('nom du dossier')} value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void create() }} />
              <button className="pill tool" disabled={!name.trim()}
                style={!name.trim() ? { opacity: .4, cursor: 'not-allowed' } : { color: 'var(--accent)' }}
                onClick={() => void create()}>{t('créer')}</button>
            </span>
          ) : (
            <button onClick={() => setCreating(true)}>{t('＋ ajouter un dossier')}</button>
          )}
        </div>
        <div className="fscroll">
          {trierDossiers(folders, s.folderSort).map(f => (
            <button key={f.id} onClick={() => void toggle(f.id)}>
              <span className="fcheck" data-on={checked[f.id] || undefined}>{checked[f.id] ? '✓' : ''}</span>
              <Ic n="folder" s={13} />
              <span className="truncate">{f.name}</span>
              <small className="ml-auto" style={{ color: 'var(--faint)' }}>{f.count}</small>
            </button>
          ))}
          {folders.length === 0 && <div style={{ padding: '8px 11px', fontSize: 11, color: 'var(--faint)' }}>{t('aucun dossier')}</div>}
        </div>
      </div>
  )
  if (nested) return (
    /* SOUS-menu : absolu, collé au bord du menu parent (left:100%), repli à
       gauche près du bord d'écran via side. */
    <div className={`submenu ${side === 'left' ? 'left' : ''}`}
      onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>{body}</div>
  )
  return (
    <V2Portal>
      <div style={{ position: 'fixed', left: at.x, top: at.y, bottom: at.bottom, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>{body}</div>
    </V2Portal>
  )
}

/* ---------- badges des vignettes : moteur, brouillon, son, texte, finition ---------- */
const MOTEUR_COURT: Record<string, string> = { wan: 'Wan', ltx_hq: 'LTX', minimax: 'MiniMax', motion: 'Motion', moss: 'MOSS', krea: 'Krea', klein: 'Klein' }
const FINITION: Record<string, string> = { foley: 'bruitage', interpolate: 'fluide', upscale: 'upscale', photo_hd: 'HD' }
export function badgesOf(a: Asset): { cle: string; txt: string; cls?: string }[] {
  const out: { cle: string; txt: string; cls?: string }[] = []
  const moteur = a.mediaType === 'video' ? a.videoEngine : a.op === 'edit' ? null : a.photoEngine
  if (moteur && MOTEUR_COURT[moteur]) out.push({ cle: 'm', txt: MOTEUR_COURT[moteur] })
  if (a.videoDraft) out.push({ cle: 'd', txt: t('brouillon'), cls: 'draft' })
  if (a.t2v) out.push({ cle: 't', txt: t('texte'), cls: 'txt' })
  if (a.postOp) out.push({ cle: 'f', txt: t(FINITION[a.postOp]), cls: 'fin' })
  if (a.mediaType === 'video' && a.withAudio) out.push({ cle: 's', txt: '♪', cls: 'son' })
  return out
}

/* ---------- vignette d'asset ---------- */
export function AssetCard({ a, onOpen, picking, picked, onPick, extra }: {
  a: Asset
  onOpen: (a: Asset) => void
  picking?: boolean; picked?: boolean; onPick?: (id: string) => void
  /** boutons du bas de vignette (Animer / Départ / Fin / Rejouer…) */
  extra?: React.ReactNode
}) {
  const review = useAppStore(s => s.reviewAsset)
  const clone = useAppStore(s => s.cloneFrom)
  const encore = useAppStore(s => s.encoreUne)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [clipS, setClipS] = useState<number | null>(null)
  const vid = useRef<HTMLVideoElement | null>(null)
  const cls = a.reviewStatus === 'approved' ? 'approved' : a.reviewStatus === 'rejected' ? 'rejected' : ''
  return (
    <div className={`card ${cls} ${picked ? 'picked' : ''} ${menu ? 'menu-open' : ''}`} onClick={() => (picking && onPick ? onPick(a.id) : onOpen(a))}
      onMouseEnter={() => { void vid.current?.play().catch(() => { /* autoplay refusé : tant pis */ }) }}
      onMouseLeave={() => { const el = vid.current; if (el) { el.pause(); el.currentTime = 0 } }}>
      {a.mediaType === 'video'
        /* preload none : metadata chargées au 1er hover (le play() les tire) —
           preload=metadata déclenchait N requêtes vidéo au chargement de la grille. */
        ? <video ref={vid} src={a.uri} poster={posterOf(a)} muted loop playsInline preload="none"
            onLoadedMetadata={e => setClipS((e.target as HTMLVideoElement).duration || null)} />
        : <img src={vignetteOf(a)} alt="" loading="lazy" />}
      {a.mediaType === 'video' && <span className="playmark"><Ic n="play" s={13} /></span>}
      <span className="badge">
        {badgesOf(a).map(b => <span key={b.cle} className={`pill9 ${b.cls ?? ''}`}>{b.txt}</span>)}
      </span>
      <span className="mark" />
      {onPick && (
        <button className="selbox" data-on={picked || undefined}
          style={picked || picking ? { opacity: 1 } : undefined}
          onClick={e => { e.stopPropagation(); onPick(a.id) }}>{picked ? '✓' : ''}</button>
      )}
      {menu && <CardMenu a={a} at={menu} onClose={() => setMenu(null)} />}
      {!picking && (
        <div className="hov">
          {(renderTime(a.renderMs) || clipS) && (
            <span className="hovmeta">
              {renderTime(a.renderMs) ? t('rendu {x}', { x: renderTime(a.renderMs) ?? '' }) : ''}
              {clipS ? `${renderTime(a.renderMs) ? ' · ' : ''}clip ${clipS >= 9.5 ? Math.round(clipS) : clipS.toFixed(1)} s` : ''}
              {defautsDe(a.controle).length ? ` · ${defautsDe(a.controle).join(', ')}` : ''}
            </span>
          )}
          <div className="acts">
            <button className="hact ok" title={t('valider')} onClick={e => { e.stopPropagation(); review(a.id, a.reviewStatus === 'approved' ? 'pending' : 'approved') }}><Ic n="heart" /></button>
            <button className="hact ko" title={t('refuser')} onClick={e => { e.stopPropagation(); review(a.id, a.reviewStatus === 'rejected' ? 'pending' : 'rejected') }}><Ic n="x" /></button>
            <a className="hact" title={t('télécharger')} href={a.uri} download onClick={e => e.stopPropagation()}><Ic n="download" /></a>
            <button className="hact" title={t('cloner les réglages')} onClick={e => { e.stopPropagation(); clone(a) }}><Ic n="copy" /></button>
            {a.jobId && !a.postOp && <button className="hact" title={t('encore une : mêmes réglages, nouvelle graine')}
              onClick={e => { e.stopPropagation(); void encore(a) }}><Ic n="dice" /></button>}
            <button className="hact" title={t('plus…')} onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); if (menu) { setMenu(null); return } const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: Math.min(r.left, window.innerWidth - 180), y: r.bottom + 4 }) }}><Ic n="dots" /></button>
          </div>
          {extra && <div className="frameB">{extra}</div>}
        </div>
      )}
    </div>
  )
}

/* ---------- placeholder de job en file / rendu ---------- */
export function JobCard({ j, queueIds }: { j: Job; queueIds?: string[] }) {
  const cancel = useAppStore(st => st.cancelJob)
  const reorder = useAppStore(st => st.reorderJobs)
  const [over, setOver] = useState(false)
  /* Tick local 1 s : le poll n'émet QUE sur changement de statut/progression —
     sans ce tick, compteur et barre restent figés sur leur valeur de naissance
     (constaté 17/09 : « bloqué à 5min19 » alors que le rendu tournait). */
  const [, forceTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => forceTick(n => n + 1), 1000)
    return () => window.clearInterval(iv)
  }, [])
  const active = STATUTS_EN_CALCUL.includes(j.status)
  const finition = j.status === 'post-process'
  /* Silhouette du placeholder = ratio du DERNIER rendu du même média :
     la fournée en cours produit presque toujours le même format, la
     masonry ne se décale plus. Repli 9/16. */
  const lastRatio = useAppStore(st => {
    const a = st.assets.find(x => x.mediaType === j.mode && x.width && x.height)
    return a?.width && a?.height ? a.width / a.height : null
  })
  const draggable = j.status === 'queued' && !!queueIds && queueIds.length > 1
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    const from = e.dataTransfer.getData('text/job-id')
    if (!from || from === j.id || !queueIds) return
    const ids = queueIds.filter(id => id !== from)
    ids.splice(ids.indexOf(j.id) === -1 ? ids.length : ids.indexOf(j.id), 0, from)
    void reorder(ids)
  }
  const prog = j.progress
  const elapsed = active && j.startedAt ? Date.now() - j.startedAt : 0
  /* ---------- barre de progression HYBRIDE ----------
     ComfyUI ne pousse `progress` que par intermittence, et value/max ne
     couvrent que le NŒUD en cours : ni une mesure de bout en bout, ni un flux
     continu. Deux régimes, donc :
       · sans mesure  → on avance à la vitesse nominale (écoulé / estimé) ;
       · à chaque mesure → on RECALE la barre sur la valeur réelle, puis on
         repart à une vitesse recalculée pour atteindre 100 % à l'échéance
         estimée. Une mesure tardive ralentit donc la suite au lieu de figer
         la barre, et une mesure en avance l'accélère.
     La barre ne recule jamais au-delà du seuil de recalage (garde `floor`) :
     un retour en arrière visible se lit comme un bug, pas comme une
     correction. */
  const anchor = useRef<{ pct: number; at: number; elapsed: number } | null>(null)
  const floor = useRef(0)
  useEffect(() => { if (!active) { anchor.current = null; floor.current = 0 } }, [active])
  useEffect(() => {
    if (!active || !prog?.max) return
    const measured = Math.min(0.99, prog.value / prog.max)
    anchor.current = { pct: measured, at: Date.now(), elapsed }
    // Recalage vers le BAS toléré d'un cran seulement (la mesure fait foi),
    // mais jamais en dessous de ce qui était déjà affiché moins 15 points.
    floor.current = Math.max(0, measured - 0.15)
    // `elapsed` volontairement hors dépendances : il change chaque seconde et
    // ne doit pas recréer d'ancre — seule une nouvelle mesure en pose une.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, prog?.value, prog?.max])

  const est = j.estimatedMs || 0
  let ratio: number
  if (!active) ratio = 0
  else if (anchor.current) {
    const a = anchor.current
    // Temps restant PRÉVU au moment de l'ancre ; plancher à 2 s pour éviter
    // une division par ~0 quand la mesure arrive après l'échéance estimée.
    const remaining = Math.max(2000, est - a.elapsed)
    const since = Date.now() - a.at
    ratio = a.pct + (1 - a.pct) * (since / remaining)
  } else if (est) ratio = elapsed / est
  else ratio = 0.3
  // 96 % max : un rendu plus long que l'estimation doit rester « en vie ».
  const pct = Math.round(Math.min(0.96, Math.max(floor.current, ratio)) * 100)
  /* Lenteur anormale : 60 % et au moins 90 s de plus que l'estimation (moyenne des derniers rendus). */
  const lent = active && !finition && est > 0 && elapsed > est * 1.6 && elapsed - est > 90_000
  const eta = active && elapsed
    ? `${fmtDur(elapsed)} / ${j.estimatedMs ? `~${fmtDur(j.estimatedMs)}` : '…'}`
    : prog?.etaS != null ? `~${fmtDur(prog.etaS * 1000)}` : (j.estimatedMs ? `~${fmtDur(j.estimatedMs)}` : '…')
  return (
    <div className={`card jobcard ${active ? '' : 'q'} ${over ? 'dragover' : ''}`}
      style={{ aspectRatio: String(lastRatio ?? 9 / 16) }}
      draggable={draggable}
      onDragStart={e => e.dataTransfer.setData('text/job-id', j.id)}
      onDragOver={e => { if (draggable) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}>
      {/* Aperçu en direct : l'image que le modèle est en train de former, floue mais lisible —
          de quoi annuler tôt un rendu mal parti. */}
      {active && j.apercu && (
        <img src={`/api/jobs/${encodeURIComponent(j.id)}/apercu?t=${j.apercu}`} alt="" aria-hidden
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: .55, filter: 'blur(1px)', pointerEvents: 'none' }} />
      )}
      <div className="jbody" style={active && j.apercu ? { position: 'relative', background: 'linear-gradient(180deg, rgba(12,13,16,.72), rgba(12,13,16,.25) 45%, rgba(12,13,16,.8))' } : undefined}>
        <div className="jtop">
          <span className="pill9">{j.mode === 'video' ? (j.videoEngine ?? 'video') : (j.recipeId?.split('@')[0] ?? 'photo')}</span>
          {j.videoDraft && <span className="pill9 draft">{t('brouillon')}</span>}
        </div>
        <div className="jprompt">{j.composedPositive || j.userPrompt || '—'}</div>
        <div className="jmeta">#{j.id}</div>
        <button className="hact ko" title={t('annuler le job')}
          style={{ position: 'absolute', top: 8, right: 8 }}
          onClick={e => { e.stopPropagation(); void cancel(j.id) }}><Ic n="x" /></button>
        {lent && <div className="jlent" title={t('Bien plus long que les derniers rendus de cette recette. Cause fréquente : mémoire vidéo saturée (un autre programme sur la carte, ou un modèle resté chargé).')}>{t('anormalement lent — mémoire vidéo saturée ?')}</div>}
        <div className="eta">{finition ? `${t('finition')} · ${eta}` : active ? `${t(j.phase ?? 'rendu')} · ${eta}` : attente(j) ?? `${t('en file')} · ${eta}`}</div>
        <div className="pbar"><i style={{ width: `${finition ? 97 : active ? Math.max(pct, 4) : 0}%` }} /></div>
      </div>
    </div>
  )
}

/* ---------- rendu en échec : la carte reste dans la galerie ----------
   Avant le 11/10 un job `blocked` disparaissait des vues du bureau : seul
   l'onglet Jobs du mobile le montrait. La carte porte la phrase du serveur
   (server/erreurs.js : « cause — conseil ») et les gestes de reprise. Une
   annulation par l'opérateur n'est pas un échec : elle n'a pas de carte. */
export function failedJobs(jobs: Job[], video: boolean): Job[] {
  const depuis = Date.now() - 72 * 3600 * 1000
  return jobs.filter(j => (j.mode === 'video') === video && j.status === 'blocked'
    && !!j.error && !/annulé par/i.test(j.error) && j.createdAt > depuis)
}

export function FailCard({ j }: { j: Job }) {
  const retry = useAppStore(st => st.retryJob)
  const del = useAppStore(st => st.deleteJob)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [detail, setDetail] = useState(false)
  const err = tServeur(j.error) || t('Rendu en échec.')
  const coupe = err.indexOf(' — ')
  const cause = coupe > 0 ? err.slice(0, coupe) : err
  const conseil = coupe > 0 ? err.slice(coupe + 3) : ''
  const go = async (draft: boolean) => {
    setBusy(true); setMsg(null)
    const e = await retry(j.id, draft)
    setBusy(false)
    if (e) setMsg(e)
  }
  const peutBrouillon = j.mode === 'video' && !j.videoDraft
  return (
    <div className="card jobcard failcard" style={{ aspectRatio: '9/16' }}>
      <div className="jbody">
        <div className="jtop">
          <span className="pill9 ko">{t('échec')}</span>
          <span className="pill9">{j.mode === 'video' ? (j.videoEngine ?? 'video') : (j.recipeId?.split('@')[0] ?? 'photo')}</span>
        </div>
        <div className="fcause" style={detail ? { WebkitLineClamp: 'unset' } : undefined} onClick={() => setDetail(d => !d)}
          title={t('cliquer pour tout lire')}>{cause}</div>
        {conseil && <div className="fconseil">→ {conseil}</div>}
        <div className="jprompt">{j.composedPositive || j.userPrompt || '—'}</div>
        <div className="jmeta">#{j.id}</div>
        <button className="hact ko" title={t('retirer cette carte (supprime le job en échec)')}
          style={{ position: 'absolute', top: 8, right: 8 }}
          onClick={e => { e.stopPropagation(); void del(j.id).catch(x => setMsg(String(x.message || x))) }}><Ic n="x" /></button>
        {msg && <div className="fconseil" style={{ color: 'var(--danger)' }}>{msg}</div>}
        <div className="factions">
          <button className="pill" disabled={busy} onClick={() => void go(false)}>{busy ? '…' : t('↻ relancer')}</button>
          {peutBrouillon && <button className="pill" disabled={busy} onClick={() => void go(true)} title={t('même réglages, en brouillon : vérifie vite que ça passe')}>{t('brouillon')}</button>}
          <button className="pill" title={t("copier le rapport d'échec")}
            onClick={() => void navigator.clipboard?.writeText(`#${j.id} · ${j.mode === 'video' ? j.videoEngine ?? 'video' : j.recipeId ?? 'photo'}\n${err}`)}>{t('copier')}</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- portal scopé .v2 ----------
   Un portal rend dans document.body, HORS de l'arbre .v2 : les styles
   et variables CSS scopés .v2 ne s'appliquent plus (menu invisible,
   posé en bas du body → page étirée). On ré-enveloppe dans un calque
   .v2 transparent non bloquant. */
/* Un seul menu contextuel ouvert dans toute l'app : chaque menu s'enregistre
   au montage et ferme le précédent (pills d'îlot, ⋯ de vignette, animer ⌄…). */
let closeCurrentMenu: (() => void) | null = null
export function useExclusiveMenu(onClose: () => void, nested = false) {
  /* onClose est recréé à chaque render : s'y abonner en dépendance faisait
     re-tourner l'effet et les menus se fermaient mutuellement en boucle.
     Ref stable + effet AU MONTAGE seulement (un menu monté = ouvert).
     `nested` : le menu REMPLACE son parent (Déplacer vers… depuis un ⋯) —
     fermer « le précédent » démonterait le parent et nous avec. */
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const me = () => ref.current()
    if (!nested) closeCurrentMenu?.() // ouvrir ce menu ferme le précédent
    closeCurrentMenu = me
    const off = () => ref.current()
    window.addEventListener('pointerdown', off)
    return () => {
      window.removeEventListener('pointerdown', off)
      if (closeCurrentMenu === me) closeCurrentMenu = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

export function V2Portal({ children }: { children: React.ReactNode }) {
  return createPortal(
    <div className="v2" style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'none', pointerEvents: 'none' }}>
      {children}
    </div>, document.body)
}

/* ---------- menu ⋯ d'une vignette ---------- */
function CardMenu({ a, at, onClose }: { a: Asset; at: { x: number; y?: number; bottom?: number }; onClose: () => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const [armed, arm] = useConfirm()
  const [showFolders, setShowFolders] = useState(false)
  useExclusiveMenu(onClose)
  const copyImage = async () => {
    try {
      const blob = await (await fetch(a.uri)).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    } catch { await navigator.clipboard.writeText(window.location.origin + a.uri) }
    onClose()
  }
  return (
    <V2Portal>
    <div className="menu" style={{ left: at.x, top: at.y, bottom: at.bottom, pointerEvents: 'auto' }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      {a.mediaType === 'photo' && <button onClick={() => void copyImage()}><Ic n="clipboard" /> {t("Copier l'image")}</button>}
      <button onClick={() => { void navigator.clipboard.writeText(window.location.origin + a.uri); onClose() }}><Ic n="link" /> {t("Copier l'URL")}</button>
      {a.jobId && !a.postOp && <button onClick={() => { void s.encoreUne(a); onClose() }}><Ic n="dice" /> {t('Encore une')}</button>}
      {a.mediaType === 'video' && <FinitionsMenu a={a} onDone={onClose} />}
      <button style={showFolders ? { background: 'var(--lv4)' } : undefined}
        onMouseEnter={() => setShowFolders(true)}
        onClick={e => { e.stopPropagation(); setShowFolders(f => !f) }}><Ic n="folderIn" /> {t('Déplacer vers…')} ›</button>
      {edition && <div className="sep" />}
      {edition && <button style={{ color: 'var(--danger)' }}
        onClick={() => { if (arm()) { void s.removeAsset(a.id); onClose() } }}>
        <Ic n="trash" /> {armed ? t('⚠ Confirmer la suppression') : t('Supprimer')}
      </button>}
      {showFolders && <FolderMenu nested side={at.x + 210 + 330 > window.innerWidth ? 'left' : 'right'}
        onClose={onClose} assetIds={[a.id]} at={at} />}
    </div>
    </V2Portal>
  )
}

/* ---------- finitions d'un clip : son sur clip muet, fluidité 48 i/s ---------- */
export async function lancerFinition(a: Asset, op: 'foley' | 'interpolate', prompt?: string): Promise<string | null> {
  const r = await fetch(`/api/assets/${encodeURIComponent(a.id)}/${op}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prompt ? { prompt } : {}) })
  const d = await r.json().catch(() => ({})) as { id?: string; error?: string }
  if (!r.ok || !d.id) return tServeur(d.error) ?? `HTTP ${r.status}`
  await useAppStore.getState().adoptServerJob(d.id)
  return null
}
function FinitionsMenu({ a, onDone }: { a: Asset; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const go = async (op: 'foley' | 'interpolate') => {
    let prompt: string | undefined
    if (op === 'foley') {
      const p = window.prompt(t('Quels sons ? (vide = ambiance naturelle de la scène, sans voix ni musique)'), '')
      if (p === null) return
      prompt = p.trim() || undefined
    }
    const e = await lancerFinition(a, op, prompt)
    if (e) setErr(e); else onDone()
  }
  return (<>
    {!a.withAudio && <button onClick={() => void go('foley')}><Ic n="sound" /> {t('Ajouter le son')}</button>}
    {a.postOp !== 'interpolate' && <button onClick={() => void go('interpolate')}><Ic n="wave" /> {t('Fluidité ×2 (48 i/s)')}</button>}
    {err && <div className="text-[10.5px] px-2 py-1" style={{ color: 'var(--danger)', maxWidth: 220 }}>{err}</div>}
  </>)
}

/* ---------- popup contextuelle Style ---------- */
export function StyleMenu({ at, onClose, styles }: {
  at: { x: number; y?: number; bottom?: number }; onClose: () => void
  styles: { id: string; label?: string; name?: string; prompt?: string }[]
}) {
  const styleId = useAppStore(st => st.photo.styleId)
  const updatePhoto = useAppStore(st => st.updatePhoto)
  useExclusiveMenu(onClose)
  return (
    <V2Portal>
    <div className="menu" style={{ left: at.x, top: at.y, bottom: at.bottom, pointerEvents: 'auto', maxHeight: '50vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <button style={styleId === null ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
        onClick={() => { updatePhoto({ styleId: null }); onClose() }}>{t('aucun')}{styleId === null ? ' ✓' : ''}</button>
      {styles.map(st => (
        <button key={st.id} style={styleId === st.id ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
          onClick={() => { updatePhoto({ styleId: st.id }); onClose() }}>
          {t(st.label ?? st.name ?? st.id)}{styleId === st.id ? ' ✓' : ''}
        </button>
      ))}
    </div>
    </V2Portal>
  )
}

/* ---------- menu « Animer ⌄ » : Frame Placement (départ / fin) ---------- */
export function AnimMenu({ at, onClose, onStart, onEnd }: {
  at: { x: number; y?: number; bottom?: number }; onClose: () => void
  onStart: () => void; onEnd: () => void
}) {
  useExclusiveMenu(onClose)
  return (
    <V2Portal>
      <div className="menu" style={{ left: at.x, top: at.y, bottom: at.bottom, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        <div style={{ fontSize: 10, color: 'var(--faint)', padding: '4px 11px' }}>{t('Frame placement')}</div>
        <button onClick={() => { onStart(); onClose() }}>{t('→ Frame de départ')}</button>
        <button onClick={() => { onEnd(); onClose() }}>{t('← Frame de fin')}</button>
      </div>
    </V2Portal>
  )
}

/* ---------- menu format photo : liste + rectangle aux proportions ---------- */
export const PHOTO_SIZES: { w: number; h: number; label: string }[] = [
  { w: 768, h: 1344, label: '9:16' },
  { w: 832, h: 1216, label: '2:3' },
  { w: 896, h: 1152, label: '3:4' },
  { w: 1024, h: 1024, label: '1:1' },
  { w: 1152, h: 896, label: '4:3' },
  { w: 1216, h: 832, label: '3:2' },
  { w: 1344, h: 768, label: '16:9' },
]
export function DimsMenu({ at, onClose }: { at: { x: number; y?: number; bottom?: number }; onClose: () => void }) {
  const size = useAppStore(st => st.photoSize)
  const setSize = useAppStore(st => st.setPhotoSize)
  useExclusiveMenu(onClose)
  const cur = size ?? PHOTO_SIZES[0]
  return (
    <V2Portal>
      <div className="menu" style={{ left: at.x, top: at.y, bottom: at.bottom, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        {PHOTO_SIZES.map(p => {
          const on = cur.label === p.label
          const ratio = p.w / p.h
          const rw = ratio >= 1 ? 20 : Math.round(20 * ratio)
          const rh = ratio >= 1 ? Math.round(20 / ratio) : 20
          return (
            <button key={p.label} style={on ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
              onClick={() => { setSize(p); onClose() }}>
              <span style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <span style={{ width: rw, height: rh, borderRadius: 2, boxShadow: `inset 0 0 0 1.5px ${on ? 'var(--accent)' : 'var(--muted)'}` }} />
              </span>
              {p.label} <small style={{ color: 'var(--faint)' }}>{p.w}×{p.h}</small>{on ? ' ✓' : ''}
            </button>
          )
        })}
      </div>
    </V2Portal>
  )
}

/* ---------- pill seed : lock éditable à la main ---------- */
export function SeedPill() {
  const s = useAppStore()
  if (s.seedMode === 'random')
    return <button className="pill" onClick={s.toggleSeedMode} title={t('cliquer pour verrouiller la seed')}><Ic n="dice" s={13} /> {t('seed')}</button>
  /* verrouillée : lock + chiffre éditable + croix rouge = retour au random
     (la pill entière ne toggle plus — éditer le chiffre ne doit rien fermer). */
  return (
    <span className="pill" style={{ gap: 6, cursor: 'default' }} title={t('seed verrouillée')}>
      <Ic n="lock" s={12} />
      <input className="seedin" style={{ background: 'none', width: 104, padding: 0 }} value={String(s.seedValue)}
        onChange={e => { const n = Number(e.target.value.replace(/\D/g, '')); if (Number.isFinite(n)) s.setSeedValue(n) }} />
      <button title={t('revenir en aléatoire')} onClick={s.toggleSeedMode}
        style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', padding: 0 }}>
        <Ic n="x" s={12} />
      </button>
    </span>
  )
}

/* ---------- bottom-sheet mobile à crans (mini / half / full) ---------- */
export function MobileSheet({ children, initial = 'half' }: {
  children: React.ReactNode
  initial?: 'mini' | 'half' | 'full'
}) {
  const [cr, setCr] = useState<'mini' | 'half' | 'full'>(initial)
  const startY = useRef(0)
  const cycle = () => setCr(c => (c === 'mini' ? 'half' : c === 'half' ? 'full' : 'mini'))
  return (
    <div className={`sheet ${cr}`}>
      <div className="grab" onClick={cycle}
        onTouchStart={e => { startY.current = e.touches[0].clientY }}
        onTouchEnd={e => {
          const dy = e.changedTouches[0].clientY - startY.current
          if (dy > 40) setCr(c => (c === 'full' ? 'half' : 'mini'))
          else if (dy < -40) setCr(c => (c === 'mini' ? 'half' : 'full'))
        }} />
      <div className="sbody">{children}</div>
    </div>
  )
}

/* ---------- estimation par moyenne glissante des 5 derniers rendus ---------- */
export function rollingEta(assets: Asset[], pick: (a: Asset) => boolean, fallbackMs: number): number {
  const last = assets.filter(a => pick(a) && a.renderMs && a.renderMs > 500).slice(0, 5)
  if (!last.length) return fallbackMs
  return Math.round(last.reduce((t, a) => t + (a.renderMs as number), 0) / last.length)
}
export function fmtEta(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 90) return `~${sec} s`
  return `~${(sec / 60).toFixed(sec < 600 ? 1 : 0).replace('.', ',')} min`
}
/** Durée lisible « 45 s » · « 1 min 20 s » · « 12 min ». */
export function fmtDur(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return `${sec} s`
  const m = Math.floor(sec / 60), r = sec % 60
  return r && m < 10 ? `${m} min ${r} s` : `${m} min`
}
/* moyenne glissante persistée (localStorage) — durées de la réécriture LLM */
export function pushRolling(key: string, ms: number) {
  try {
    const arr: number[] = JSON.parse(localStorage.getItem(key) ?? '[]')
    arr.unshift(ms)
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 5)))
  } catch { /* stockage indisponible : tant pis */ }
}
export function readRolling(key: string, fallbackMs: number): number {
  try {
    const arr: number[] = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!arr.length) return fallbackMs
    return Math.round(arr.reduce((t, x) => t + x, 0) / arr.length)
  } catch { return fallbackMs }
}

/* ---------- confirmation inline (purge) ---------- */
export function useConfirm(timeout = 4000): [boolean, () => boolean] {
  const [armed, setArmed] = useState(false)
  return [armed, () => {
    if (armed) { setArmed(false); return true }
    setArmed(true); setTimeout(() => setArmed(false), timeout); return false
  }]
}

/* ---------- lots : groupement + vignette mosaïque ----------
   Les assets d'un même batchId (lot > 1 / carrousel) se replient en UNE
   vignette-mosaïque ; le clic ouvre la vue du lot. Modèle Higgsfield
   « Shots ». Les assets sans batchId restent des vignettes simples. */
export type GridItem = { kind: 'asset'; a: Asset } | { kind: 'batch'; id: string; items: Asset[] }

export function groupBatches(assets: Asset[]): GridItem[] {
  const out: GridItem[] = []
  const seen = new Map<string, { kind: 'batch'; id: string; items: Asset[] }>()
  for (const a of assets) {
    /* multi-appartenance : batchId (création) + batchIds (origines de
       carrousels) — l'asset est DUPLIQUÉ dans chaque lot. */
    const ids = [...new Set([...(a.batchId ? [a.batchId] : []), ...(a.batchIds ?? [])])]
    if (!ids.length) { out.push({ kind: 'asset', a }); continue }
    for (const id of ids) {
      const g = seen.get(id)
      if (g) { g.items.push(a); continue }
      const ng = { kind: 'batch' as const, id, items: [a] }
      seen.set(id, ng)
      out.push(ng)
    }
  }
  // un « lot » d'une seule image redevient une vignette simple
  return out.map(it => (it.kind === 'batch' && it.items.length < 2 ? { kind: 'asset', a: it.items[0] } : it))
}

export function BatchCard({ items, onOpen, picking, allPicked, onPickAll }: {
  items: Asset[]; onOpen: () => void
  picking?: boolean; allPicked?: boolean; onPickAll?: () => void
}) {
  const review = useAppStore(st => st.reviewAsset)
  const removeAssets = useAppStore(st => st.removeAssets)
  const edition = useEdition()
  const [delArmed, armDel] = useConfirm()
  const allApproved = items.every(a => a.reviewStatus === 'approved')
  const allRejected = items.every(a => a.reviewStatus === 'rejected')
  const minis = items.slice(0, 9)
  const cols = minis.length > 4 ? 3 : 2
  /* Feuilletage au survol : la position du pointeur sur la largeur de la carte
     choisit l'image du lot affichée en grand — un aperçu sans ouvrir le lot. */
  const [vue, setVue] = useState<number | null>(null)
  const feuilleter = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return
    const r = e.currentTarget.getBoundingClientRect()
    setVue(Math.min(items.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * items.length))))
  }
  const pending = items.filter(a => a.reviewStatus === 'pending').length
  const downloadAll = async () => {
    for (const a of items) {
      const l = document.createElement('a'); l.href = a.uri; l.download = a.uri.split('/').pop() ?? a.id
      document.body.appendChild(l); l.click(); l.remove()
      await new Promise(r => setTimeout(r, 250))
    }
  }
  return (
    <div className={`card ${allApproved ? 'approved' : ''} ${allRejected ? 'rejected' : ''}`} onClick={onOpen} title={t('lot de {n} rendus', { n: items.length })}>
      <span className="mark" />
      <div onPointerMove={feuilleter} onPointerLeave={() => setVue(null)}
        style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: '1fr', gap: 2, aspectRatio: '3/4' }}>
        {vue !== null && items[vue] && (<>
          <img src={vignetteOf(items[vue])} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 1,
            ...(items[vue].reviewStatus === 'rejected' ? { filter: 'grayscale(.55) brightness(.55)' } : null) }} />
          <span style={{ position: 'absolute', left: 6, right: 6, bottom: 6, zIndex: 2, display: 'flex', gap: 2, pointerEvents: 'none' }}>
            {items.map((a, i) => <i key={a.id} style={{ flex: 1, height: 3, borderRadius: 2, background: i === vue ? '#fff' : 'rgba(255,255,255,0.35)' }} />)}
          </span>
        </>)}
        {minis.map(a => (
          <img key={a.id} src={vignetteOf(a)} alt="" loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover',
              /* refusée individuellement : même gris que les vignettes rejetées */
              ...(a.reviewStatus === 'rejected' ? { filter: 'grayscale(.55) brightness(.55)' } : null) }} />
        ))}
      </div>
      <span className="badge">
        <span className="pill9">⊞ {items.length}</span>
        {pending > 0 && <span className="pill9" style={{ color: 'var(--attention)' }}>{t('{n} à revoir', { n: pending })}</span>}
      </span>
      {onPickAll && (
        <button className="selbox" data-on={allPicked || undefined}
          style={allPicked || picking ? { opacity: 1 } : undefined}
          title={t('sélectionner les images du lot')}
          onClick={e => { e.stopPropagation(); onPickAll() }}>{allPicked ? '✓' : ''}</button>
      )}
      <div className="hov">
        <div className="acts">
          <button className="hact ok" title={allApproved ? t('annuler la validation du lot') : t('tout valider')}
            onClick={e => { e.stopPropagation(); items.forEach(a => review(a.id, allApproved ? 'pending' : 'approved')) }}><Ic n="heart" /></button>
          <button className="hact ko" title={allRejected ? t('annuler le refus du lot') : t('tout refuser')}
            onClick={e => { e.stopPropagation(); items.forEach(a => review(a.id, allRejected ? 'pending' : 'rejected')) }}><Ic n="x" /></button>
          <button className="hact" title={t('télécharger le lot')} onClick={e => { e.stopPropagation(); void downloadAll() }}><Ic n="download" /></button>
          {edition && <button className="hact" title={delArmed ? t('confirmer la suppression du lot') : t('supprimer le lot')}
            style={delArmed ? { color: 'var(--danger)', background: 'rgba(240,85,72,.2)' } : { color: 'var(--danger)' }}
            onClick={e => { e.stopPropagation(); if (armDel()) void removeAssets(items.map(a => a.id)) }}><Ic n="trash" /></button>}
        </div>
      </div>
    </div>
  )
}

/* ---------- barre de sélection : remplace la barre de création quand ≥1 coché ---------- */
/* Tâche longue du serveur (captions ou livraison des reels), suivie par
   interrogation : un lot de 60 vidéos dure plusieurs minutes. */
interface TacheReels { type: 'captions' | 'livraison'; total: number; faits: number; fini: boolean
  erreurs: { id: string | null; erreur: string }[]; dossier?: string; livres?: { nom: string }[] }

export function SelectionBar({ ids, assets, folderId, onClear }: { ids: string[]; assets: Asset[]; folderId?: string; onClear: () => void }) {
  const s = useAppStore()
  const edition = useEdition()
  const [armed, arm] = useConfirm()
  const [tache, setTache] = useState<TacheReels | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!tache || tache.fini) return
    const iv = setInterval(() => void fetch('/api/captions/etat').then(r => r.json()).then(d => {
      setTache(d.tache)
      if (d.tache?.fini) {
        void s.hydrate()
        const e = d.tache.erreurs.length ? t(' · {n} en erreur : {x}', { n: d.tache.erreurs.length, x: d.tache.erreurs[0].erreur }) : ''
        setMsg(d.tache.type === 'captions'
          ? t('{n} caption(s) écrite(s)', { n: d.tache.faits - d.tache.erreurs.length }) + e
          : t('{n} reel(s) livré(s) dans {dossier} ({de} → {a})', { n: d.tache.livres.length, dossier: d.tache.dossier, de: d.tache.livres[0]?.nom ?? '', a: d.tache.livres.at(-1)?.nom ?? '' }) + e)
      }
    }).catch(() => {}), 2000)
    return () => clearInterval(iv)
  }, [tache, s])
  const lancer = async (url: string, body: object) => {
    setMsg(null)
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json()
    if (!r.ok) { setMsg(tServeur(d.error) ?? t('échec')); return }
    if (d.fini) { setMsg(d.type === 'captions' ? t('rien à écrire : toutes ont déjà une caption') : t('rien à livrer')); return }
    setTache(d)
  }
  const [folderMenu, setFolderMenu] = useState<{ x: number; bottom: number } | null>(null)
  const [comparer, setComparer] = useState(false)
  const sel = assets.filter(a => ids.includes(a.id))
  /* upscale de masse : actif seulement si TOUTE la sélection est en brouillon vidéo */
  const allDrafts = sel.length > 0 && sel.every(a => a.mediaType === 'video' && a.videoDraft)
  const upscaleAll = async () => {
    for (const a of sel) await fetch(`/api/assets/${encodeURIComponent(a.id)}/upscale`, { method: 'POST' })
    await s.hydrate(); onClear()
  }
  const videos = sel.filter(a => a.mediaType === 'video')
  const toutesCaptionnees = videos.length > 0 && videos.every(a => a.caption)
  /* Sans caption : on écrit celles qui manquent, sans toucher aux autres.
     Toutes remplies : on les réécrit toutes (vider un champ = le faire réécrire seul). */
  const captionner = () => void lancer('/api/captions', { ids: videos.map(a => a.id), tout: toutesCaptionnees })
  const livrer = async () => {
    const { prochain } = await (await fetch('/api/captions/etat')).json()
    const debut = window.prompt(t('Graver et livrer {n} reel(s) dans le dossier de livraison. Premier nom :', { n: videos.length }), prochain)
    if (debut) void lancer('/api/reels/livrer', { ids: videos.map(a => a.id), debut: debut.trim(), folderId })
  }
  const download = async () => {
    /* Nom de base (ex. « J74C ») → J74C1, J74C2… dans l'ordre affiché. Vide = noms d'origine. */
    const base = window.prompt(t("Nom de base des fichiers (ex. J74C → J74C1, J74C2…). Vide = noms d'origine."), '')
    if (base === null) return
    for (const [i, a] of sel.entries()) {
      const link = document.createElement('a')
      const orig = a.uri.split('/').pop() ?? a.id
      link.href = a.uri; link.download = base.trim() ? `${base.trim()}${i + 1}${orig.slice(orig.lastIndexOf('.'))}` : orig
      document.body.appendChild(link); link.click(); link.remove()
      await new Promise(r => setTimeout(r, 250))
    }
  }
  return (
    <div className="fbar" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <b className="text-[13px]" style={{ whiteSpace: 'nowrap' }}>{tp(sel.length, '{n} sélectionnée', '{n} sélectionnées')}</b>
      <button className="pill" onClick={() => void download()}><Ic n="download" /> {t('Télécharger')}</button>
      <button className="pill tool" disabled={sel.length < 2 || sel.length > 4}
        title={sel.length < 2 || sel.length > 4 ? t('sélectionne 2 à 4 rendus') : t('côte à côte, vidéos lues ensemble')}
        style={sel.length < 2 || sel.length > 4 ? { opacity: .4, cursor: 'not-allowed' } : undefined}
        onClick={() => setComparer(true)}><Ic n="columns" /> {t('Comparer')}</button>
      {videos.length > 0 && (<>
        <button className="pill tool" disabled={!!tache && !tache.fini} onClick={captionner}
          title={toutesCaptionnees ? t('réécrire toutes les captions') : t('écrire les captions manquantes')}>
          <Ic n="tag" /> {toutesCaptionnees ? t('Réécrire les captions') : t('Captions')} ({videos.length})</button>
        <button className="pill tool" disabled={!!tache && !tache.fini} onClick={() => void livrer()}
          title={t('graver les captions et livrer dans le dossier de livraison, nommés J74R1, J74R2…')}>
          <Ic n="download" /> {t('Livrer les reels')}</button>
      </>)}
      {tache && !tache.fini && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
        {tache.type === 'captions' ? t('captions') : t('gravure')} {tache.faits}/{tache.total}…</span>}
      {msg && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{msg}</span>}
      <button className="pill tool" onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          if (folderMenu) { setFolderMenu(null); return }
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setFolderMenu({ x: Math.min(r.left, window.innerWidth - 280), bottom: window.innerHeight - r.top + 6 })
        }}><Ic n="folderIn" /> {t('Déplacer vers…')}</button>
      <button className="pill tool" title={allDrafts ? t('upscaler tous les brouillons sélectionnés') : t('sélection mixte : brouillons vidéo uniquement')}
        disabled={!allDrafts} style={!allDrafts ? { opacity: .4, cursor: 'not-allowed' } : undefined}
        onClick={() => void upscaleAll()}><Ic n="upscale" /> Upscale ({sel.length})</button>
      <button className="pill" style={{ color: 'var(--positif)' }} onClick={() => { sel.forEach(a => s.reviewAsset(a.id, 'approved')); onClear() }}><Ic n="heart" /> {t('Valider')}</button>
      <button className="pill" style={{ color: 'var(--danger)' }} onClick={() => { sel.forEach(a => s.reviewAsset(a.id, 'rejected')); onClear() }}><Ic n="x" /> {t('Refuser')}</button>
      {edition && <button className="pill" style={{ color: armed ? 'var(--danger)' : undefined }}
        onClick={() => { if (arm()) { void s.removeAssets(ids); onClear() } }}>
        <Ic n="trash" /> {armed ? t('Confirmer') : t('Supprimer')}
      </button>}
      <button className="pill tool" style={{ marginLeft: 'auto' }} onClick={onClear}>{t('annuler la sélection')}</button>
      {folderMenu && <FolderMenu at={folderMenu} assetIds={ids} onClose={() => setFolderMenu(null)} />}
      {comparer && <Comparer assets={sel} onClose={() => setComparer(false)} />}
    </div>
  )
}
