/* ============================================================
   v2 — Assets : la bibliothèque COMPLÈTE (images + vidéos),
   groupée par mois, avec sidebar de filtres combinables et
   dossiers (appartenances multiples).
   Règles UX : dossier = radio avec le statut
   (Tous/Validés/Refusés) ; types = multi-coche
   (aucun coché = tous) ; les filtres s'appliquent AUSSI dans un
   dossier ; groupement mensuel partout ; supprimer un dossier ne
   supprime jamais les assets.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { AssetCard, FolderSortButton, Ic, JustifiedGrid, useProgressif, ratioOf, SelectionBar, useConfirm, V2Portal, useExclusiveMenu, type FolderInfo, matchSearch } from './bits'
import { trierDossiers } from '../lib/folders'
import { t, tp } from '../i18n'
import { SANS_PERSONNAGE } from '../lib/personnage'
import { usePersonnages } from './ChoixPersonnage'
import { Musiques } from './Musiques'

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected'

const ORPHANS = '__sans_dossier__'
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

export function AssetsView({ onOpen }: { onOpen: (a: Asset, list: Asset[]) => void }) {
  const s = useAppStore()
  const [status, setStatus] = useState<StatusFilter>('all')
  /* `folderId === ORPHANS` : pseudo-dossier « sans dossier » — un asset qui
     n'appartient à AUCUN dossier. Valeur sentinelle plutôt qu'un état séparé :
     tous les tests de sélection exclusive de la sidebar marchent sans retouche. */
  const [folderId, setFolderId] = useState<string | null>(null)
  const [types, setTypes] = useState<Set<'photo' | 'video'>>(new Set())
  const [q, setQ] = useState('')
  const [personnage, setPersonnage] = useState<string | null>(null)
  const personnages = usePersonnages()
  const [cols, setCols] = useState(6)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [fMenu, setFMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const qRef = useRef<HTMLInputElement>(null)

  const loadFolders = () => void fetch('/api/folders').then(r => r.json()).then(d => setFolders(d.folders ?? []))
  useEffect(() => { loadFolders() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); qRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* L'ordre d'affichage est une préférence de l'opérateur (store, persistée),
     pas celui du serveur — les mêmes dossiers, dans le même ordre, partout. */
  // les dossiers sont communs à tous les personnages : le filtre personnage trie les assets, pas les dossiers
  const tries = useMemo(() => trierDossiers(folders, s.folderSort), [folders, s.folderSort])

  const toggleSet = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => {
    const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); setter(n)
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return s.assets.filter(a => {
      if (personnage && a.personaId !== personnage) return false
      if (folderId === ORPHANS) { if ((a.folders ?? []).length) return false }
      else if (folderId && !(a.folders ?? []).includes(folderId)) return false
      if (status === 'pending' && a.reviewStatus !== 'pending') return false
      if (status === 'approved' && a.reviewStatus !== 'approved') return false
      if (status === 'rejected' && a.reviewStatus !== 'rejected') return false
      if (types.size > 0 && !types.has(a.mediaType as 'photo' | 'video')) return false
      if (needle && !matchSearch(a, needle)) return false
      return true
    }).sort((a, b) => b.createdAt - a.createdAt)
  }, [s.assets, personnage, folderId, status, types, q])

  /* groupes JOURNALIERS, récents en premier. Le mois seul mettait des
     centaines de rendus sous un même titre : à ce rythme de production, la
     journée est la bonne granularité pour se repérer. */
  const groups = useMemo(() => {
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const now = new Date()
    const todayK = dayKey(now)
    const yest = new Date(now); yest.setDate(yest.getDate() - 1)
    const yestK = dayKey(yest)
    const labelOf = (d: Date) => {
      const k = dayKey(d)
      if (k === todayK) return t("aujourd'hui")
      if (k === yestK) return t('hier')
      const sameYear = d.getFullYear() === now.getFullYear()
      return `${t(DAYS[d.getDay()])} ${d.getDate()} ${t(MONTHS[d.getMonth()])}${sameYear ? '' : ' ' + d.getFullYear()}`
    }
    const out: { label: string; items: Asset[] }[] = []
    for (const a of shown) {
      const label = labelOf(new Date(a.createdAt))
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] })
      out[out.length - 1].items.push(a)
    }
    return out
  }, [shown])

  const title = folderId === ORPHANS ? t('Sans dossier')
    : folderId
    ? (folders.find(f => f.id === folderId)?.name ?? t('Dossier'))
    : status === 'pending' ? t('À trier') : status === 'approved' ? t('Validés') : status === 'rejected' ? t('Refusés')
    : types.size === 1 ? (types.has('photo') ? t('Images') : t('Vidéos'))
    : t('Tous les assets')

  /* Compteur « sans dossier » : calculé sur TOUS les assets, comme les
     compteurs des dossiers (qui viennent du serveur) — pas sur la vue filtrée,
     sinon le nombre changerait selon les filtres actifs. */
  const orphanCount = useMemo(
    () => s.assets.filter(a => !(a.folders ?? []).length).length, [s.assets])

  const togglePick = (id: string) => setPicked(p => {
    const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n
  })

  const side = (label: string, on: boolean, onClick: () => void, extra?: React.ReactNode) => (
    <button className={`sitem ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="truncate">{t(label)}</span>{extra}
    </button>
  )

  /* Plusieurs grilles (une par groupe) : le chargement progressif est compté
     sur l'ensemble, sinon chaque groupe chargerait ses 40 premières cartes. */
  const prog = useProgressif(shown.length)
  prog.pas.current = Math.max(4, cols)
  let reste = prog.limite
  const groupesVisibles = groups.flatMap(g => {
    if (reste <= 0) return []
    const items = g.items.slice(0, reste); reste -= items.length
    return [{ ...g, items }]
  })

  return (
    <div className="flex-1 min-h-0 flex layer1" style={{ overflow: 'hidden' }}>
      {/* ---------- sidebar ---------- */}
      <aside className="aside-assets flex-none flex flex-col gap-1 p-3 overflow-y-auto" style={{ width: 220 }}>
        <div className="text-[12px] mt-2 mb-0.5 px-2" style={{ color: 'var(--faint)' }}>{t('Personnages')}</div>
        <button className={`sitem ${!personnage ? 'on' : ''}`} onClick={() => setPersonnage(null)}>{t('Tous les personnages')}</button>
        {[...personnages, { id: SANS_PERSONNAGE, name: t('Sans personnage') }].map(p => {
          const n = s.assets.filter(a => a.personaId === p.id).length
          return n ? <button key={p.id} className={`sitem ${personnage === p.id ? 'on' : ''}`} onClick={() => setPersonnage(c => c === p.id ? null : p.id)}>{p.name} <span style={{ opacity: .5 }}>{n}</span></button> : null
        })}
        <input ref={qRef} className="pin" style={{ marginTop: 0 }} placeholder={t('⌘K prompt, moteur, LoRA…')} title={t('cherche dans le prompt, le brief, la recette, le moteur et les LoRA')}
          value={q} onChange={e => setQ(e.target.value)} />
        <div className="stitle">{t('Bibliothèque')}</div>
        {side('Tous les assets', !folderId && status === 'all', () => { setFolderId(null); setStatus('all') })}
        {side('À trier', !folderId && status === 'pending', () => { setFolderId(null); setStatus('pending') })}
        <button className={`sitem ${!folderId && status === 'approved' ? 'on' : ''}`}
          onClick={() => { setFolderId(null); setStatus('approved') }}>
          <span className="sik sik-ok"><Ic n="heart" s={13} /></span><span className="truncate">{t('Validés')}</span>
        </button>
        <button className={`sitem ${!folderId && status === 'rejected' ? 'on' : ''}`}
          onClick={() => { setFolderId(null); setStatus('rejected') }}>
          <span className="sik sik-ko"><Ic n="x" s={13} /></span><span className="truncate">{t('Refusés')}</span>
        </button>
        <div className="stitle">{t('Types')}</div>
        {side('Images', types.has('photo'), () => toggleSet(types, 'photo', setTypes))}
        {side('Vidéos', types.has('video'), () => toggleSet(types, 'video', setTypes))}
        <button className={`sitem ${s.ongletMusiques ? 'on' : ''}`} onClick={() => useAppStore.setState({ ongletMusiques: !s.ongletMusiques })}>{t('Audio')}</button>
        <div className="stitle" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('Dossiers')} <FolderSortButton />
        </div>
        {newFolder === null ? (
          <button className="sitem" style={{ color: 'var(--text)' }} onClick={() => setNewFolder('')}>{t('＋ ajouter un dossier')}</button>
        ) : (
          <span className="frow" style={{ padding: '0 4px' }}>
            <input className="pin" autoFocus style={{ marginTop: 0, padding: '6px 9px' }}
              placeholder={t('nom du dossier')} value={newFolder} onChange={e => setNewFolder(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setNewFolder(null)
                if (e.key === 'Enter' && newFolder.trim()) {
                  void fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: newFolder.trim() }) }).then(() => { setNewFolder(null); loadFolders() })
                }
              }} />
            <button className="pill tool" disabled={!newFolder.trim()}
              style={!newFolder.trim() ? { opacity: .4, cursor: 'not-allowed' } : { color: 'var(--accent)' }}
              onClick={() => { if (newFolder.trim()) void fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newFolder.trim() }) }).then(() => { setNewFolder(null); loadFolders() }) }}>{t('créer')}</button>
          </span>
        )}
        <button className={`sitem ${folderId === ORPHANS ? 'on' : ''}`}
          title={t("les assets qui n'appartiennent à aucun dossier")}
          onClick={() => { setFolderId(fid => fid === ORPHANS ? null : ORPHANS); setStatus('all') }}>
          <span className="sik"><Ic n="folderOff" s={13} /></span>
          <span className="truncate">{t('Sans dossier')}</span>
          <small style={{ color: 'var(--faint)' }}>{orphanCount}</small>
        </button>
        {tries.map(f => (
          <button key={f.id} className={`sitem ${folderId === f.id ? 'on' : ''}`}
            onClick={() => { setFolderId(fid => fid === f.id ? null : f.id); setStatus('all') }}>
            <span className="sik"><Ic n="folder" s={13} /></span>
            <span className="truncate">{f.name}</span>
            <small style={{ color: 'var(--faint)' }}>{f.count}</small>
            <span className="sdots" onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setFMenu({ id: f.id, x: r.right + 4, y: r.top })
              }}><Ic n="dots" s={12} /></span>
          </button>
        ))}
        {folders.length === 0 && <div style={{ fontSize: 12, color: 'var(--faint)', padding: '2px 8px' }}>{t('aucun dossier — « Déplacer vers… » sur une vignette')}</div>}
      </aside>

      {s.ongletMusiques ? <Musiques /> : <>
      {/* ---------- grille ---------- */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{tp(shown.length, '{n} asset', '{n} assets')}</span>
          {shown.length > 0 && (
            <button className="pill tool" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map(a => a.id)))}>
              {picked.size === shown.length ? t('Tout désélectionner') : t('Tout sélectionner')}
            </button>
          )}
          <span className="inline-flex items-center gap-2 ml-auto text-[12px]" style={{ color: 'var(--faint)' }}>
            ▤ <input type="range" aria-label={t('vignettes par rangée')} min={1} max={10} value={cols} onChange={e => setCols(Number(e.target.value))}
              style={{ width: 110, accentColor: 'var(--accent)' }} />
          </span>
        </div>
        {/* ordre d'AFFICHAGE, pas de clic : c'est lui qui numérote les reels et les images téléchargées */}
        {picked.size > 0 && <SelectionBar ids={shown.filter(a => picked.has(a.id)).map(a => a.id)} assets={s.assets}
          folderId={folderId && folderId !== ORPHANS ? folderId : undefined} onClear={() => setPicked(new Set())} />}
        <div className="scrollwrap" style={{ padding: '0 16px 24px' }}>
          {groupesVisibles.map(g => (
            <div key={g.label}>
              <div className="mlabel">{g.label}</div>
              <JustifiedGrid cols={cols} progressif={false} items={g.items.map(a => ({
                key: a.id, ratio: ratioOf(a),
                node: <AssetCard a={a} onOpen={x => onOpen(x, shown)}
                  picking={picked.size > 0} picked={picked.has(a.id)} onPick={togglePick} />,
              }))} />
            </div>
          ))}
          {prog.limite < shown.length && <div ref={prog.sentinelle} style={{ height: 1 }} />}
          {shown.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 12, padding: 24 }}>{t('rien ici avec ces filtres')}</div>}
        </div>
      </div>

      {fMenu && <FolderRowMenu at={fMenu} folder={folders.find(f => f.id === fMenu.id)}
        onClose={() => setFMenu(null)}
        onChanged={() => { loadFolders(); if (folderId === fMenu.id) setFolderId(null) }} />}
      </>}
    </div>
  )
}

/* menu « … » d'un dossier : Renommer / Supprimer */
function FolderRowMenu({ at, folder, onClose, onChanged }: {
  at: { x: number; y: number }; folder?: FolderInfo; onClose: () => void; onChanged: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(folder?.name ?? '')
  const [armed, arm] = useConfirm()
  useExclusiveMenu(onClose)
  if (!folder) return null
  const rename = async () => {
    if (!name.trim()) return
    await fetch(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }) })
    onChanged(); onClose()
  }
  const del = async () => {
    await fetch(`/api/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })
    onChanged(); onClose()
  }
  return (
    <V2Portal>
      <div className="menu" style={{ left: at.x, top: at.y, pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        {renaming ? (
          <span className="flex items-center gap-1.5 p-1">
            <input className="pin" autoFocus style={{ marginTop: 0, padding: '6px 9px', width: 150 }}
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void rename() }} />
            <button className="pill tool" disabled={!name.trim()}
              style={!name.trim() ? { opacity: .4 } : { color: 'var(--accent)' }}
              onClick={() => void rename()}>{t('ok')}</button>
          </span>
        ) : (
          <button onClick={() => setRenaming(true)}>{t('Renommer')}</button>
        )}
        <button style={{ color: 'var(--danger)' }}
          onClick={() => { if (arm()) void del() }}>
          {armed ? t('⚠ Confirmer (les assets restent)') : t('Supprimer')}
        </button>
      </div>
    </V2Portal>
  )
}
