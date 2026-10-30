/* ============================================================
   v2 — popups : Enhancer (composer avec instructions, résultat,
   Remplacer/Annuler), Éléments (vocabulaires), Picker de frame
   (Générations | Uploads). Tous montés en portail plein écran.
   ============================================================ */
import { LoraStacks, LoraSwitch } from '../components/LoraStacks'
import { useEffect, useRef, useState } from 'react'
import type { Asset, MediaMode } from '../types'
import { vignetteOf } from '../components/AssetMedia'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { corrigerFiche, NOMS_DIM, type Corrections } from '../lib/ficheCorrigee'

/* ---------- Enhancer : /api/compose avec directives, remplacement explicite ---------- */
export function EnhancerPopup({ open, onClose, mode, engine, userPrompt, anchorUri, anchorFile, previousPrompt, onReplace }: {
  open: boolean; onClose: () => void
  mode: MediaMode; engine?: string | null
  userPrompt: string
  /* Still de départ / image source, si le contexte en a une. Le serveur la
     fait décrire par le VLM et coud la description dans le message du
     réécriveur : sans elle il invente la tenue et la pose de départ.
     `anchorFile` (nom déposé dans l'input ComfyUI) prime sur `anchorUri` :
     c'est le fichier que le RENDU utilisera. */
  anchorUri?: string | null
  anchorFile?: string | null
  /* Onglet Étendre : le prompt du clip prolongé. Le réécriveur le reçoit
     comme contexte pour enchaîner le plan suivant au même rythme, sans
     rejouer ce qui a déjà eu lieu. */
  previousPrompt?: string | null
  /* Le second argument porte ce que le VLM a lu : il doit voyager avec le
     prompt jusqu'au job, sinon la vue détail ne peut plus expliquer d'où
     vient une tenue ou une pose décrite. */
  onReplace: (positive: string, vision: string | null) => void
}) {
  const [directives, setDirectives] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [meta, setMeta] = useState('')
  const [seen, setSeen] = useState<string | null>(null)
  /* « Tenue de l'image » : verrouille la tenue sur ce que le VLM voit dans
     la still (appel dédié, inséré tel quel par le serveur). La description
     complète de la scène reste envoyée dans tous les cas. */
  const [keepOutfit, setKeepOutfit] = useState(false)
  const [tenue, setTenue] = useState<{ asked: boolean; text: string | null } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => { if (open) { setResult(null); setErr(null); setDirectives(''); setSeen(null) } }, [open])
  if (!open) return null

  const run = async () => {
    setBusy(true); setErr(null); setElapsed(0)
    const t0 = Date.now()
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const r = await fetch('/api/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({ register: 'sfw', mode, engine: engine ?? null, userPrompt,
          userDirectives: directives, anchorUri: anchorUri ?? null, anchorFile: anchorFile ?? null,
          previousPrompt: previousPrompt ?? null, keepOutfit: keepOutfit && Boolean(anchorFile || anchorUri) }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(tServeur(d.error) || `HTTP ${r.status}`)
      setResult(d.positive)
      setSeen(typeof d.sceneDesc === 'string' ? d.sceneDesc : null)
      setTenue(d.outfitRequested ? { asked: true, text: typeof d.outfitAnchor === 'string' ? d.outfitAnchor : null } : null)
      setMeta(`${d.model ?? 'composer'} · ${((Date.now() - t0) / 1000).toFixed(1)} s${d.cached ? ' · cache' : ''}`)
      if (!d.cached) pushRolling('v2_compose_ms', Date.now() - t0)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr(String((e as Error).message || e))
    }
    window.clearInterval(tick)
    setBusy(false)
  }

  const cancel = () => { abortRef.current?.abort(); onClose() }
  return (
    /* clic hors fenêtre : ne ferme PAS (une composition CPU en cours serait
       perdue par mégarde) — seuls ✕ et Annuler ferment, Annuler ABORT. */
    <div className="pop">
      <div className="pbox" onClick={e => e.stopPropagation()}>
        <h3>✦ Enhancer (composer) <button className="x" onClick={cancel}>✕</button></h3>
        {/* contexte de composition : ce qui décide de l'intent et du format */}
        <div className="flex gap-1.5 items-center mt-1 flex-wrap">
          {mode === 'video' && engine && engine !== 'edit' && (
            <span className="pill tool" style={{ fontSize: 10.5, cursor: 'default' }}>{t('moteur : {engine}', { engine })}</span>
          )}
          {engine === 'edit' && <span className="pill tool" style={{ fontSize: 10.5, cursor: 'default' }}>{t('mode : retouche')}</span>}
          {(anchorFile || anchorUri) && <span className="pill tool used" style={{ fontSize: 10.5, cursor: 'default' }}>{t('👁 image lue')}</span>}
          {previousPrompt && <span className="pill tool used" style={{ fontSize: 10.5, cursor: 'default' }}
            title={t('Le réécriveur reçoit le prompt du clip prolongé pour enchaîner au même rythme')}>{t('↪ suite du plan précédent')}</span>}
        </div>
        <p className="hint">{mode === 'video'
          ? t('Le composer réécrit le brief au format du moteur vidéo. Le prompt n\'est remplacé que si tu valides.')
          : t('Le composer réécrit le brief. Le prompt n\'est remplacé que si tu valides.')}</p>
        {(anchorFile || anchorUri) && (
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={keepOutfit} onChange={e => setKeepOutfit(e.target.checked)} />
            {t('Tenue de l\'image — garder exactement la tenue vue dans la still (le brief ne la change pas)')}
          </label>
        )}
        <textarea className="pin" rows={2} placeholder={t('Instructions à l\'enhancer (optionnel)')}
          value={directives} onChange={e => setDirectives(e.target.value)} />
        {err && <div className="pres" style={{ color: 'var(--danger)' }}>{err}</div>}
        {/* Ce que le VLM a vu. Replié par défaut, mais consultable : quand la
            réécriture surprend, la première question est de savoir si l'image
            a été bien lue — ça ne se corrige pas au même endroit qu'une
            consigne mal suivie. */}
        {tenue && (
          <div className="pres">
            <span className="tag">{t('tenue verrouillée')}</span>
            {tenue.text ?? t('aucun vêtement détecté dans la still — rien n\'a été inséré')}
          </div>
        )}
        {seen && (
          <details className="pres">
            <summary className="tag" style={{ cursor: 'pointer' }}>{t('ce que le VLM a vu dans la still')}</summary>
            <div style={{ marginTop: 6, opacity: 0.85 }}>{seen}</div>
          </details>
        )}
        {result && (
          <div className="pres">
            <span className="tag">{t('résultat — {meta}', { meta })}</span>
            {result}
          </div>
        )}
        <div className="prow">
          <button className="b2" onClick={cancel}>{t('Annuler')}</button>
          {busy ? (
            /* jauge de patience : le fond iridescent remplit le bouton selon la
               moyenne glissante des dernières compositions (même motif carrousel). */
            <button className="b1 fillbtn" disabled>
              <i className="fill" style={{ width: `${Math.min(100, (elapsed * 1000 / readRolling('v2_compose_ms', 30000)) * 100)}%` }} />
              <span>{t('… composition · {elapsed} s / {eta}', { elapsed, eta: fmtEta(readRolling('v2_compose_ms', 30000)) })}</span>
            </button>
          ) : (
            <button className="b2" onClick={run}>{result ? t('↻ Relancer') : t('✦ Composer')}</button>
          )}
          {result && <button className="b1" onClick={() => { onReplace(result, seen); onClose() }}>{t('Remplacer le prompt')}</button>}
        </div>
      </div>
    </div>
  )
}

/* ---------- Éléments : 4 onglets (Tenues · Environnements · Positions ·
   Styles) + LoRAs + Composition. Dans chaque onglet : recherche, puis
   clic = la ligne de prompt de l'item s'insère dans le prompt. Sources :
   vocabulaires (base + ajouts), catalogue /api/loras pour le picker LoRA. */
interface ElItem { id: string; label: string; prompt: string }
const asItems = (xs: { id: string; label: string; labelFr?: string; prompt?: string; framing?: string; lens?: string }[]): ElItem[] =>
  xs.map(x => ({ id: x.id, label: x.labelFr ?? x.label,
    prompt: x.prompt ?? [x.framing, x.lens && `${x.lens} look`].filter(Boolean).join(', ') }))
export const EL_GROUPS = [
  { key: 'tenues', label: 'Tenues', items: () => asItems(allOutfits()) },
  { key: 'lieux', label: 'Environnements', items: () => asItems(allEnvironments()) },
  { key: 'poses', label: 'Positions', items: () => asItems(allTextPoses()) },
  { key: 'styles', label: 'Styles', items: () => asItems(allStyles()) },
] as const

export function ElementsPopup({ open, onClose, onInsert }: {
  open: boolean; onClose: () => void
  onInsert: (text: string) => void
}) {
  const [tab, setTab] = useState<'garde' | 'tenues' | 'lieux' | 'poses' | 'styles' | 'loras' | '__compo'>('garde')
  const prompt = useAppStore(st => st.userPrompt)
  const [q, setQ] = useState('')
  useEffect(() => { setQ('') }, [tab])
  if (!open) return null
  const needle = q.trim().toLowerCase()
  const grp = EL_GROUPS.find(g => g.key === tab)
  const lines = (grp ? grp.items() : [])
    .filter(it => it.prompt && (!needle || `${it.label} ${it.prompt}`.toLowerCase().includes(needle)))
  return (
    <div className="pop" onClick={onClose}>
      <div className="pbox" style={{ width: 'min(680px,94%)' }} onClick={e => e.stopPropagation()}>
        <h3>{t('@ Éléments')} <button className="x" onClick={onClose}>✕</button></h3>
        <div className="wtabs">
          <button className={`wtab ${tab === 'garde' ? 'on' : ''}`} onClick={() => setTab('garde')}>{t('★ Garde-robe')}</button>
          {EL_GROUPS.map(g => (
            <button key={g.key} className={`wtab ${tab === g.key ? 'on' : ''}`} onClick={() => setTab(g.key)}>{t(g.label)}</button>
          ))}
          <button className={`wtab ${tab === 'loras' ? 'on' : ''}`} onClick={() => setTab('loras')}>LoRAs</button>
          <button className={`wtab ${tab === '__compo' ? 'on' : ''}`} onClick={() => setTab('__compo')}>{t('Composition')}</button>
        </div>

        {tab !== '__compo' && tab !== 'garde' && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <input className="pin" style={{ flex: 1, minWidth: 140, marginTop: 0 }} placeholder={t('rechercher…')}
              value={q} onChange={e => setQ(e.target.value)} autoFocus />
          </div>
        )}

        {grp && (
          <div className="wgrid">
            {lines.slice(0, 90).map(h => (
              <button key={h.id} className="wit" onClick={() => { onInsert(h.prompt); onClose() }}>
                {h.prompt}<small style={{ display: 'flex', alignItems: 'center' }}>{h.label}
                  {(tab === 'tenues' || tab === 'lieux') && <span style={{ marginLeft: 'auto' }}><Etoile kind={tab} id={h.id} /></span>}</small>
              </button>
            ))}
            {lines.length > 90 && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 10, padding: 6 }}>
              {t('{n} de plus — affine la recherche', { n: lines.length - 90 })}</div>}
            {lines.length === 0 && <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 11, padding: 10 }}>
              {needle ? t('aucun élément ne contient « {q} »', { q }) : t('aucun élément')}</div>}
          </div>
        )}

        {tab === 'garde' && <GarderobeTab prompt={prompt} onInsert={x => { onInsert(x); onClose() }} />}
        {tab === 'loras' && <LoraPickTab q={needle} />}
        {tab === '__compo' && <CompositionTab onInsert={onInsert} onClose={onClose} />}
        <div className="prow"><button className="b2" onClick={onClose}>{t('Fermer')}</button></div>
      </div>
    </div>
  )
}

/* ---------- LoRA picker photo (arch image : flux2/zimage/flux1) ----------
   Empile dans loraPicks (suivies par mkJob). Force 0-2, trigger résolu
   serveur si vide. */
const ARCH_MOTEUR: Record<string, string> = { krea: 'krea2', klein: 'flux2', moss: 'moss' }
function LoraPickTab({ q }: { q: string }) {
  const catalog = useAppStore(st => st.loraCatalog)
  const loadLoras = useAppStore(st => st.loadLoras)
  const picks = useAppStore(st => st.loraPicks)
  const moteur = useAppStore(st => st.photoEngine)
  useEffect(() => { if (!catalog.length) void loadLoras() }, [catalog.length, loadLoras])
  /* UNIQUEMENT les LoRA compatibles avec le moteur photo choisi, d'après l'architecture lue
     dans l'en-tête du fichier. Une autre se charge sans erreur mais tourne À VIDE (constaté).
     Exclue aussi : la LoRA d'identité, déjà cuite dans la recette. */
  const usable = catalog
    .filter(l => l.arch === ARCH_MOTEUR[moteur])
    .filter(l => l.kind !== 'identite')
    .filter(l => !q || l.name.toLowerCase().includes(q) || (l.trigger ?? '').toLowerCase().includes(q))
  const toggle = (name: string) => useAppStore.setState(st => ({
    loraPicks: st.loraPicks.some(x => x.name === name)
      ? st.loraPicks.filter(x => x.name !== name)
      : [...st.loraPicks, { name, strength: 1 }],
  }))
  const setStrength = (name: string, strength: number) => useAppStore.setState(st => ({
    loraPicks: st.loraPicks.map(x => (x.name === name ? { ...x, strength } : x)),
  }))
  const toggleOff = (name: string) => useAppStore.setState(st => ({
    loraPicks: st.loraPicks.map(x => (x.name === name ? { ...x, off: !x.off } : x)),
  }))
  return (
    <>
    <LoraStacks cle="photo" picks={picks} apply={items => useAppStore.setState({ loraPicks: items })} />
    <div className="flex flex-col gap-1 mt-2" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
      {usable.length === 0 && <div className="text-[11px]" style={{ color: 'var(--faint)', padding: 8 }}>{t('Aucune LoRA pour ce moteur : le studio lit chaque fichier et ne propose que celles qui agissent dessus.')}</div>}
      {usable.map(l => {
        const pick = picks.find(x => x.name === l.name)
        return (
          <div key={l.name} className="engine" style={pick ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.35)' } : undefined}>
            <span className="nm" style={{ cursor: 'pointer' }} onClick={() => toggle(l.name)}>
              <span className="text-[11px] truncate">{l.name.replace(/\.safetensors$/, '')}</span>
              <small className="ml-2" style={{ color: 'var(--faint)' }}>{l.arch}{l.trigger ? ` · ${l.trigger}` : ''}</small>
              <span className="ml-auto text-[10px]" style={{ color: pick ? 'var(--accent)' : 'var(--faint)' }}>{pick ? '✓' : '+'}</span>
            </span>
            {pick && (
              <span className="flex items-center gap-2 mt-1.5 text-[10px]" style={{ color: 'var(--muted)', opacity: pick.off ? .5 : 1 }}>
                <LoraSwitch off={pick.off} onToggle={() => toggleOff(l.name)} />
                <input type="range" min={0} max={2} step={0.1} value={pick.strength}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                  onChange={e => setStrength(l.name, Number(e.target.value))} />
                <b style={{ color: 'var(--text)' }}>{pick.strength.toFixed(1)}</b>
              </span>
            )}
          </div>
        )
      })}
      {usable.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 11, padding: 10 }}>{t('aucune LoRA image ne correspond')}</div>}
    </div>
    </>
  )
}

/* ---------- Picker de frame : Générations | Uploads ---------- */
interface UploadRow { name: string; mtime: number; bytes: number }

export function FramePicker({ open, onClose, assets, title, onPickAsset, onPickUpload, onUploadFile, accept = 'image/*' }: {
  open: boolean; onClose: () => void
  assets: Asset[]
  title: string
  /** un asset de la galerie est choisi (sera copié vers input via to-input) */
  onPickAsset: (a: Asset) => void
  /** un upload existant (nom de fichier input) est choisi */
  onPickUpload: (name: string) => void
  /** un NOUVEAU fichier pris sur le disque (l'onglet Uploads ne montrait que les envois passés) */
  onUploadFile?: (f: File) => void
  accept?: string
}) {
  const [tab, setTab] = useState<'gen' | 'up'>('gen')
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const edition = useEdition()
  useEffect(() => {
    if (open && tab === 'up') void fetch('/api/uploads').then(r => r.json()).then(d => setUploads(d.uploads ?? []))
  }, [open, tab])
  if (!open) return null
  const photos = assets.filter(a => a.mediaType === 'photo' && a.reviewStatus !== 'rejected')
  return (
    <div className="pop" onClick={onClose}>
      <div className="pbox" style={{ width: 'min(680px,94%)' }} onClick={e => e.stopPropagation()}>
        <h3>{title} <button className="x" onClick={onClose}>✕</button></h3>
        <div className="wtabs">
          <button className={`wtab ${tab === 'gen' ? 'on' : ''}`} onClick={() => setTab('gen')}>{t('Générations')}</button>
          {edition && <button className={`wtab ${tab === 'up' ? 'on' : ''}`} onClick={() => setTab('up')}>{t('Uploads')}</button>}
        </div>
        <div className="pkgrid">
          {tab === 'gen' && photos.map(a => (
            <button key={a.id} className="pk" onClick={() => { onPickAsset(a); onClose() }}>
              <img src={vignetteOf(a)} alt="" loading="lazy" />
            </button>
          ))}
          {tab === 'up' && onUploadFile && (
            <label className="pk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', cursor: 'pointer',
              fontSize: 11, color: 'var(--muted)', border: '1px dashed var(--line, rgba(255,255,255,.2))', minHeight: 90 }}>
              ＋<br />{t('Depuis l’ordinateur…')}
              <input type="file" accept={accept} className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { onUploadFile(f); onClose() } }} />
            </label>
          )}
          {tab === 'up' && uploads.map(u => (
            <button key={u.name} className="pk" onClick={() => { onPickUpload(u.name); onClose() }}>
              <img src={`/api/uploads/${encodeURIComponent(u.name)}`} alt="" loading="lazy" />
            </button>
          ))}
          {tab === 'up' && uploads.length === 0 && (
            <div style={{ gridColumn: '1/-1', color: 'var(--faint)', fontSize: 11, padding: 12 }}>{t('aucun upload')}</div>
          )}
        </div>
        <div className="prow"><button className="b2" onClick={onClose}>{t('Annuler')}</button></div>
      </div>
    </div>
  )
}

/* ---------- Composition (sélecteurs v1 + overrides) ----------
   Réutilise buildPhotoPrompt : tenue (+ overrides matière/coupe/
   couleur), pose texte, environnement, style. Le texte composé s'insère
   dans le prompt — onglet « Composition » de la popup Éléments. */
import { allOutfits, allEnvironments, allStyles, allTextPoses } from '../store/useVocabStore'
import { buildPhotoPrompt } from '../core/promptBuilder'
import { useAppStore } from '../store/useAppStore'
import { Etoile, GarderobeTab } from '../components/Garderobe'
import { AssetCard, Ic, SelectionBar, pushRolling, readRolling, fmtEta } from './bits'

export function CompositionTab({ onInsert, onClose }: { onInsert: (t: string) => void; onClose: () => void }) {
  const s = useAppStore()
  const p = s.photo
  const outfits = allOutfits().map(o => ({ id: o.id, label: o.labelFr ?? o.label }))
  const envs = allEnvironments().map(e => ({ id: e.id, label: e.labelFr ?? e.label }))
  const styles = allStyles().map(st => ({ id: st.id, label: st.labelFr ?? st.label }))
  const poses = allTextPoses().map(po => ({ id: po.id, label: po.labelFr ?? po.label }))
  const preview = buildPhotoPrompt(p)
  const sel = (label: string, value: string | null, items: { id: string; label?: string; name?: string }[], set: (id: string | null) => void) => (
    <label className="flex flex-col gap-1 text-[10.5px]" style={{ color: 'var(--faint)' }}>
      {t(label)}
      <select className="pin" style={{ marginTop: 0, padding: 8 }} value={value ?? ''}
        onChange={e => set(e.target.value || null)}>
        <option value="">—</option>
        {items.map(i => <option key={i.id} value={i.id}>{i.label ?? i.name ?? i.id}</option>)}
      </select>
    </label>
  )
  return (
    <div className="flex flex-col gap-2.5 mt-2">
      <div className="grid grid-cols-2 gap-2">
        {sel('Tenue', p.outfitId, outfits, id => s.updatePhoto({ outfitId: id, outfitOverrides: {} }))}
        {sel('Pose', p.textPoseId, poses, id => s.updatePhoto({ textPoseId: id }))}
        {sel('Environnement', p.environmentId, envs, id => s.updatePhoto({ environmentId: id }))}
        {sel('Style', p.styleId, styles, id => s.updatePhoto({ styleId: id }))}
      </div>
      {p.outfitId && (
        <div className="grid grid-cols-2 gap-2">
          {(['material', 'fit', 'color'] as const).map(k => (
            <label key={k} className="flex flex-col gap-1 text-[10.5px]" style={{ color: 'var(--faint)' }}>
              {k === 'material' ? t('matière (override)') : k === 'fit' ? t('coupe (override)') : t('couleur (override)')}
              <input className="pin" style={{ marginTop: 0, padding: 8 }}
                placeholder={t('défaut tenue')}
                value={p.outfitOverrides[k] ?? ''}
                onChange={e => s.updatePhoto({ outfitOverrides: { ...p.outfitOverrides, [k]: e.target.value || undefined } })} />
            </label>
          ))}
        </div>
      )}
      {preview && <div className="pres"><span className="tag">{t('texte composé')}</span>{preview}</div>}
      <div className="prow" style={{ marginTop: 4 }}>
        <button className="b2" onClick={() => s.clearComposition()}>{t('Vider')}</button>
        <button className="b1" disabled={!preview}
          onClick={() => { onInsert(preview); onClose() }}>{t('Insérer la composition')}</button>
      </div>
    </div>
  )
}

/* ---------- Triage plein écran (mobile & desktop) : ✓ / ✕ enchaîné ---------- */
export function TriagePopup({ open, onClose, assets }: { open: boolean; onClose: () => void; assets: Asset[] }) {
  const review = useAppStore(st => st.reviewAsset)
  const [done, setDone] = useState({ ok: 0, ko: 0 })
  const [x0, setX0] = useState(0)
  useEffect(() => { if (open) setDone({ ok: 0, ko: 0 }) }, [open])
  if (!open) return null
  const pending = assets.filter(a => a.reviewStatus === 'pending')
  const cur = pending[0]
  const decide = (st: 'approved' | 'rejected') => {
    if (!cur) return
    review(cur.id, st)
    setDone(d => (st === 'approved' ? { ...d, ok: d.ok + 1 } : { ...d, ko: d.ko + 1 }))
  }
  return (
    <div className="pop" style={{ background: 'var(--bg)', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' }}>
      <div className="flex items-center px-3 py-2.5">
        <button className="b2" onClick={onClose}>{t('‹ terminé')}</button>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {t('reste {n} · ♥ {ok} · ✕ {ko}', { n: pending.length, ok: done.ok, ko: done.ko })}
        </span>
      </div>
      {!cur ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div style={{ fontSize: 15 }}>{t('Tout est trié ✓')}</div>
          <button className="b1" onClick={onClose}>{t('Retour')}</button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 flex items-center justify-center" style={{ background: '#08090b' }}
            onTouchStart={e => setX0(e.touches[0].clientX)}
            onTouchEnd={e => { const dx = e.changedTouches[0].clientX - x0; if (dx > 70) decide('approved'); else if (dx < -70) decide('rejected') }}>
            {cur.mediaType === 'video'
              ? <video key={cur.id} src={cur.uri} autoPlay muted loop playsInline className="max-h-full max-w-full" />
              : <img key={cur.id} src={cur.uri} alt="" className="max-h-full max-w-full object-contain" />}
          </div>
          <div className="flex gap-2 p-3">
            <button className="b2 flex-1" style={{ color: 'var(--danger)', padding: 14 }} onClick={() => decide('rejected')}>{t('✕ Refuser')}</button>
            <button className="b2 flex-1" style={{ color: 'var(--positif)', padding: 14 }} onClick={() => decide('approved')}>{t('♥ Valider')}</button>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------- Carrousel ⊞ : 9 variations en gardant les éléments cochés ----------
   Les éléments FERMÉS sont gardés, les OUVERTS varient (seed constante si
   demandée). Les sélections restaurées viennent de la provenance de l'asset
   — sur un asset au prompt libre (sans selections), seule la seed est reprise. */
export function CarouselPopup({ asset, onClose, onLaunched }: {
  asset: Asset; onClose: () => void; onLaunched: () => void
}) {
  const s = useAppStore()
  const basePrompt = asset.provenance.composedPositive || asset.provenance.userPrompt || ''
  /* Cadenas FERMÉ = la dimension reste CONSTANTE dans tout le shooting ;
     ouvert = le rédacteur en fait ce qu'il veut. `props` (les accessoires
     autour d'elle — la voiture, l'îlot, la baignoire) est une dimension à
     part entière depuis le 25/09 : elle était noyée dans le décor, donc
     indissociable de lui. */
  /* `light` : la lumière est une dimension à part depuis le carrousel v2
     (28/09) — elle était mêlée au décor ET au style. */
  const [keep, setKeep] = useState({ outfit: true, env: true, props: true, light: true, pose: false, style: false, seed: false, lora: true })
  /* Mode SHOOTING : le writer n'édite plus le prompt, il écrit des PLANS
     (action, pose, cadrage, angle) calibrés sur un corpus de référence.
     Défaut ACTIVÉ : l'ancien mode ne variait ni le cadrage ni l'action —
     19 segments sur 21 identiques d'une variante à l'autre (24/09). */
  const [shoot, setShoot] = useState(true)
  /* Décomposition montrée AVANT les cadenas : sans elle on verrouille à
     l'aveugle, sans savoir si « appuyée contre l'îlot » a été rangé dans la
     pose ou dans les accessoires. Le résultat est réutilisé à la réécriture,
     donc le VLM ne tourne qu'une fois. */
  const [dims, setDims] = useState<Record<string, string> | null>(null)
  const [dimsErr, setDimsErr] = useState(false)
  /* Préparation du carrousel v2 : prompt racine (lignée), description VLM et
     fiche — renvoyés tels quels à la rédaction pour ne pas les recalculer. */
  const [prep, setPrep] = useState<{ racine: string | null; vlm: string | null; fiche: unknown } | null>(null)
  /* Corrections de l'opérateur sur la lecture du VLM (lib/ficheCorrigee). */
  const [corr, setCorr] = useState<Corrections>({})
  const [edite, setEdite] = useState<string | null>(null)
  const [extraLoras, setExtraLoras] = useState<{ name: string; strength?: number; trigger?: string }[]>([])
  useEffect(() => {
    setDims(null); setDimsErr(false); setPrep(null); setCorr({}); setEdite(null)
    void fetch('/api/carrousel/fiche', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchorUri: asset.uri, prompt: basePrompt, register: 'sfw' }) })
      .then(r => r.json())
      .then(d => {
        if (!d.dims) { setDimsErr(true); return }
        setDims(d.dims); setPrep({ racine: d.racine ?? null, vlm: d.vlm ?? null, fiche: d.fiche })
      })
      .catch(() => setDimsErr(true))
  }, [asset.id, asset.uri, basePrompt])
  useEffect(() => {
    void fetch(`/api/assets/${encodeURIComponent(asset.id)}/provenance`).then(r => r.json())
      .then(p => setExtraLoras(Array.isArray(p.extraLoras) ? p.extraLoras : []))
      .catch(() => setExtraLoras([]))
  }, [asset.id])
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'config' | 'rewriting' | 'review' | 'send'>('config')
  const [elapsed, setElapsed] = useState(0)
  const [variants, setVariants] = useState<string[]>([])
  /* LoRA attribuée par la grille à chaque plan (carrousel v2) ; null = le
     catalogue devine au rendu, comme avant. */
  const [lorasPlans, setLorasPlans] = useState<({ name: string; strength: number; trigger: string }[] | null)[]>([])
  const [tab, setTab] = useState(0)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const flip = (k: keyof typeof keep) => setKeep(p => ({ ...p, [k]: !p[k] }))
  const VARY_LABELS: Record<string, string> = {
    outfit: 'the outfit / clothing',
    pose: 'the pose / body position / framing',
    env: 'the setting / location / background',
    style: 'the photographic style / lighting',
  }

  /* étape 1 : UN passage LLM → 9 variantes proposées à la relecture */
  const rewrite = async () => {
    const vary = (['outfit', 'pose', 'env', 'style'] as const).filter(k => !keep[k]).map(k => VARY_LABELS[k])
    /* Contrat par dimension : `env` s'appelle `location` côté serveur. */
    const contrat = { outfit: keep.outfit, pose: keep.pose, location: keep.env, props: keep.props, light: keep.light, style: keep.style }
    const ouverts = (['outfit', 'pose', 'env', 'props', 'light', 'style'] as const).filter(k => !keep[k])
    if (shoot ? !ouverts.length : !vary.length) { setErr(t('décoche au moins un élément (décoché = varie)')); return }
    setBusy(true); setErr(null); setPhase('rewriting'); setElapsed(0)
    const t0 = Date.now()
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)

    try {
      /* Mode shooting → carrousel v2 (server/carrousel.js) ; le mode
         variation reste sur l'ancienne route, qui seule le sait faire. */
      const r = shoot
        ? await fetch('/api/carrousel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: basePrompt, register: 'sfw', n: 8, anchorUri: asset.uri, keep: contrat,
            ...corrigerFiche(prep, corr), promptRacine: prep?.racine ?? undefined }),
          signal: AbortSignal.timeout(600000),
        })
        : await fetch('/api/rewrite', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: basePrompt, vary, register: 'sfw', n: 8,
            anchorUri: asset.uri, anchorOutfit: keep.outfit, shoot, keep: contrat }),
          signal: AbortSignal.timeout(600000),
        })
      const d = await r.json().catch(() => ({ error: t('réponse illisible du serveur') }))
      if (!r.ok || d.error) throw new Error(tServeur(d.error) || `HTTP ${r.status}`)
      if (!Array.isArray(d.variants) || !d.variants.length) throw new Error(t('aucune variante produite'))
      pushRolling('v2_rewrite_ms', Date.now() - t0)
      // l'ORIGINE ouvre le carrousel, suivie des 8 réécritures
      setVariants([basePrompt, ...d.variants.slice(0, 8)])
      setLorasPlans(Array.isArray(d.loras) ? d.loras.slice(0, 8) : [])
      setTab(0)
      setPhase('review')
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? t('délai dépassé (10 min) — le CPU est chargé, réessayer') : String((e as Error).message || e)
      setErr(msg); setPhase('config')
    }
    window.clearInterval(tick)
    setBusy(false)
  }

  /* étape 2 : envoi des variantes validées/éditées — flux normal, batchId commun */
  const send = async () => {
    setPhase('send'); setBusy(true)
    const seedVal = keep.seed ? asset.provenance.seed?.value : undefined
    const bid = crypto.randomUUID()
    /* l'ORIGINAL n'est pas re-généré : son rendu existant rejoint le lot */
    try { await fetch(`/api/jobs/${encodeURIComponent(asset.jobId)}/batch-id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: bid }) }) } catch { /* non bloquant */ }
    s.setMode('photo')
    s.updatePhoto({ task: 'generate' })
    s.setBatchCount(1)
    s.setCarouselBatchId(bid)
    s.setCarouselLocks(keep)
    s.setCarouselPromptRacine(prep?.racine ?? null)
    /* les LoRAs du job d'origine (et leurs déclencheurs) doivent suivre les
       variantes : sans elles, les 8 plans perdent le style de l'original. */
    useAppStore.setState({ loraPicks: keep.lora ? extraLoras.map(l => ({
      name: l.name, strength: l.strength ?? 1, trigger: l.trigger ?? '' })) : [] })
    let done = 0
    for (const [j, v] of variants.slice(1).entries()) {   // onglet « origine » exclu : jamais re-rendu
      if (!v.trim()) continue
      /* LoRA du plan : seulement si l'opérateur n'a pas gardé celles de
         l'original (cadenas LoRA) — son choix prime. */
      if (!(keep.lora && extraLoras.length))
        useAppStore.setState({ loraPicks: lorasPlans[j] ?? [] })
      s.setUserPrompt(v.trim())
      if (seedVal != null) { if (useAppStore.getState().seedMode !== 'lock') s.toggleSeedMode(); s.setSeedValue(seedVal) }
      else if (useAppStore.getState().seedMode === 'lock') s.toggleSeedMode()
      await s.submitJob()
      done++; setProgress(done)
    }
    s.setCarouselBatchId(null)
    s.setCarouselLocks(null)
    s.setCarouselPromptRacine(null)
    /* l'original vient d'être re-tagué côté serveur : recharger les assets
       pour que sa vignette rejoigne le lot sans attendre un reload. */
    await s.hydrate()
    setBusy(false)
    if (done > 0) onLaunched()
  }

  return (
    <div className="pop" onClick={busy ? undefined : onClose}>
      <div className="pbox" style={phase === 'review' ? { width: 'min(680px,94%)' } : undefined} onClick={e => e.stopPropagation()}>
        <h3><Ic n="grid" s={14} /> {t('Carrousel — 9 variations')} <button className="x" onClick={onClose}>✕</button></h3>

        {(phase === 'config' || phase === 'rewriting') && (<>
          <p className="hint">{t('Cadenas fermé = la dimension reste constante dans tout le shooting ; ouvert = le rédacteur en fait ce qu\'il veut. Tu relis les plans avant l\'envoi.')}</p>
          <p className="hint" style={{ marginTop: 0 }}>
            {dims ? t('👁 image lue — voici ce que chaque dimension contient')
              : dimsErr ? t('⚠ décomposition indisponible : les cadenas restent utilisables, sans aperçu')
                : t('👁 lecture de l\'image…')}
          </p>
          <button className="wit" style={{ width: '100%', marginBottom: 8, ...(shoot ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.4)', color: 'var(--accent)' } : {}) }}
            onClick={() => !busy && setShoot(v => !v)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Ic n={shoot ? 'camera' : 'refresh'} s={12} /> {shoot ? t('Mode shooting') : t('Mode variation')}
            </span>
            <small>{shoot ? t('plans différents : action, cadrage, angle') : t('même plan, posture réécrite')}</small>
          </button>
          <div className="wgrid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
            {([['outfit', 'Tenue'], ['pose', 'Pose'], ['env', 'Décor'], ['props', 'Accessoires'], ['light', 'Lumière'], ['style', 'Style photo'], ['seed', 'Seed'],
              ...(extraLoras.length ? [['lora', `LoRA (${extraLoras.map(l => l.name.replace(/\.safetensors$/, '')).join(', ').slice(0, 30)})`]] as const : [])] as const).map(([k, label]) => (
              <button key={k} className="wit" style={keep[k] ? { boxShadow: 'inset 0 0 0 1px rgba(242,77,138,.4)', color: 'var(--accent)' } : undefined}
                onClick={() => !busy && flip(k)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Ic n={keep[k] ? 'lock' : 'unlock'} s={12} /> {t(label)}</span><small>{keep[k] ? t('constant') : t('libre')}</small>
                {(() => {
                  /* Ce que le VLM a trouvé dans cette dimension. `env` s'appelle
                     `location` côté serveur ; seed et lora n'en sont pas une. */
                  const clef = k === 'env' ? 'location' : k
                  if (!dims && !dimsErr && clef !== 'seed' && clef !== 'lora')
                    return <span className="dimload" aria-label={t('lecture de l\'image en cours')}><i /><i /></span>
                  const lu = dims?.[clef]
                  if (lu === undefined) return null
                  const corrige = !!corr[clef]?.trim()
                  const vu = corrige ? corr[clef] : lu
                  return <em style={{ width: '100%', marginTop: 3, fontStyle: 'normal',
                    fontSize: 10, lineHeight: 1.35, color: corrige ? 'var(--accent)' : 'var(--faint)',
                    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                    title={corrige ? t('corrigé (le VLM avait lu : {l})', { l: lu || '—' }) : vu}>
                    <span role="button" tabIndex={0} aria-label={t('corriger ce que le VLM a lu')}
                      style={{ cursor: 'pointer', marginRight: 4, color: 'var(--muted)' }}
                      onClick={e => { e.stopPropagation(); if (!busy) setEdite(clef) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setEdite(clef) } }}>✎</span>
                    {vu || '—'}</em>
                })()}
              </button>
            ))}
          </div>
          {edite && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <span className="hint" style={{ margin: 0 }}>{t('Corriger « {d} » — ce que la photo montre vraiment (en anglais, ex. « black 1967 Ford Mustang fastback »). Vide = la lecture du VLM.', { d: NOMS_DIM[edite] ?? edite })}</span>
              <textarea className="pin" rows={2} autoFocus value={corr[edite] ?? dims?.[edite] ?? ''}
                onChange={e => setCorr(c => ({ ...c, [edite]: e.target.value }))} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="b2" onClick={() => { setCorr(c => { const n = { ...c }; delete n[edite]; return n }); setEdite(null) }}>{t('Remettre la lecture du VLM')}</button>
                <span style={{ flex: 1 }} />
                <button className="b1" onClick={() => setEdite(null)}>OK</button>
              </div>
            </div>
          )}
          {err && <p className="hint" style={{ color: 'var(--danger)' }}>{err}</p>}
          <div className="prow">
            <button className="b2" onClick={onClose} disabled={busy}>{t('Annuler')}</button>
            {phase === 'config' ? (
              <button className="b1" onClick={() => void rewrite()}>{t('✦ Réécrire 8 variantes')}</button>
            ) : (
              /* jauge : le fond iridescent remplit le bouton de gauche à droite en ~100 s */
              <button className="b1 fillbtn" disabled>
                <i className="fill" style={{ width: `${Math.min(100, (elapsed * 1000 / readRolling('v2_rewrite_ms', 100000)) * 100)}%` }} />
                <span>{t('… réécriture · {elapsed} s / {eta}', { elapsed, eta: fmtEta(readRolling('v2_rewrite_ms', 100000)) })}</span>
              </button>
            )}
          </div>
          {phase === 'rewriting' && (
            <p className="hint" style={{ marginTop: 6 }}>{t('un passage LLM (CPU) — l\'original sera l\'onglet « origine », les 8 réécritures suivent')}</p>
          )}
        </>)}

        {phase === 'review' && (<>
          <p className="hint">{t('Relis, corrige si besoin, puis envoie. Un onglet vidé ne part pas.')}</p>
          <div className="wtabs">
            {variants.map((_, i) => (
              <button key={i} className={`wtab ${tab === i ? 'on' : ''}`} onClick={() => setTab(i)}>{i === 0 ? t('origine') : i + 1}</button>
            ))}
          </div>
          <textarea className="pin" rows={7} value={variants[tab] ?? ''} readOnly={tab === 0}
            style={tab === 0 ? { opacity: .7 } : undefined}
            onChange={e => tab !== 0 && setVariants(v => v.map((x, i) => (i === tab ? e.target.value : x)))} />
          {tab === 0 && <p className="hint">{t('l\'original n\'est pas re-généré — son rendu existant rejoint le lot tel quel')}</p>}
          {err && <p className="hint" style={{ color: 'var(--danger)' }}>{err}</p>}
          <div className="prow">
            <button className="b2" onClick={() => setPhase('config')}>{t('‹ Réglages')}</button>
            <button className="b2" onClick={() => void rewrite()} disabled={busy}>{t('↻ Relancer la réécriture')}</button>
            <button className="b1" onClick={() => void send()}>{t('Envoyer les {n} variantes', { n: variants.slice(1).filter(v => v.trim()).length })}</button>
          </div>
        </>)}

        {phase === 'send' && (
          <div className="pres" style={{ marginTop: 10 }}>
            <span className="tag">{t('envoi {done}/{total}', { done: progress, total: variants.slice(1).filter(v => v.trim()).length })}</span>
            <div className="pbar" style={{ marginTop: 6 }}><i style={{ width: `${(progress / Math.max(1, variants.slice(1).filter(v => v.trim()).length)) * 100}%` }} /></div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- vue d'un lot (multishot) : tous les rendus + actions ---------- */
export function BatchViewer({ items, onClose, onOpenAsset, extraFor }: {
  items: Asset[]
  onClose: () => void
  onOpenAsset: (a: Asset) => void
  /** actions par vignette (Animer / Départ / Fin / …) fournies par la vue hôte */
  extraFor?: (a: Asset) => React.ReactNode
}) {
  const s = useAppStore()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const picking = picked.size > 0
  const togglePick = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const first = items[0]
  const pending = items.filter(a => a.reviewStatus === 'pending').length
  const prompt = first.provenance.userPrompt || first.provenance.composedPositive || ''
  const locks = items.find(a => a.batchLocks)?.batchLocks
  const LOCK_LABELS: Record<string, string> = { outfit: t('Tenue'), pose: t('Pose'), env: t('Décor'), style: t('Style'), seed: t('Seed'), lora: 'LoRA' }
  const kept = locks ? Object.entries(locks).filter(([, v]) => v).map(([k]) => LOCK_LABELS[k] ?? k) : []
  const varied = locks ? Object.entries(locks).filter(([, v]) => !v).map(([k]) => LOCK_LABELS[k] ?? k) : []
  return (
    <div className="pop" style={{ alignItems: 'stretch', justifyContent: 'flex-start', background: 'var(--bg)', position: 'fixed' }}>
      {/* ---- grille des shots ---- */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3">
          <button className="b2" onClick={onClose}>{t('‹ retour')}</button>
          <b className="text-[13px]"><Ic n="grid" s={13} /></b>
          <b className="text-[13px]">{t('Lot — {n} rendus', { n: items.length })}</b>
          {pending > 0 && <span className="text-[11px]" style={{ color: 'var(--attention)' }}>{t('{n} à revoir', { n: pending })}</span>}
        </div>
        {/* pleine LARGEUR, format d'origine, scroll vertical assumé : chaque
            colonne fait ~1/3 de la largeur, la hauteur suit le ratio réel
            (9:16 → cartes hautes, on scrolle). Aucune contrainte de hauteur. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-8">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, width: '100%' }}>
            {items.map(a => (
              <div key={a.id} style={{ height: 'fit-content' }}>
                <AssetCard a={a} onOpen={() => onOpenAsset(a)} extra={extraFor?.(a)}
                  picking={picking} picked={picked.has(a.id)} onPick={togglePick} />
              </div>
            ))}
          </div>
        </div>
      </div>
      {picking && (
        <div style={{ position: 'absolute', left: 0, right: 300, bottom: 0, zIndex: 6 }}>
          <SelectionBar ids={[...picked]} assets={items} onClear={() => setPicked(new Set())} />
        </div>
      )}
      {/* ---- panneau détails du lot (façon Higgsfield « Shots ») ---- */}
      <aside className="flex-none flex flex-col gap-2.5 p-4 overflow-y-auto" style={{ width: 300, background: 'var(--lv1)' }}>
        <div className="rounded-xl p-3 text-[11px]" style={{ background: 'var(--lv2)' }}>
          {([
            ['Type', t('Lot (carrousel)')],
            ['Lot', (first.batchId ?? '—').slice(0, 8)],
            ['Images', String(items.length)],
            ['Recette', first.provenance.recipeId || '—'],
            ['Créé', new Date(first.createdAt).toLocaleString()],
            ...(locks ? [['Gardé', kept.length ? kept.join(', ') : '—'], ['Varie', varied.length ? varied.join(', ') : '—']] as const : []),
          ] as const).map(([k, val]) => (
            <div key={k} className="flex justify-between py-[3px]" style={{ color: 'var(--muted)' }}>
              <span>{t(k)}</span>
              {k === 'Lot'
                ? <b className="mono" style={{ color: 'var(--text)', fontWeight: 500, cursor: 'copy' }}
                    title={t('{id} — cliquer pour copier l\'id complet', { id: first.batchId ?? '' })}
                    onClick={() => first.batchId && void navigator.clipboard.writeText(first.batchId)}>{val}</b>
                : <b style={{ color: 'var(--text)', fontWeight: 500 }}>{val}</b>}
            </div>
          ))}
        </div>
        {prompt && (
          <div className="rounded-xl p-3" style={{ background: 'var(--lv2)' }}>
            <h4 className="text-[10px] uppercase tracking-wider flex items-center" style={{ color: 'var(--faint)', margin: 0 }}>
              {t('Prompt d\'origine')}
              <button className="ml-auto text-[10px] normal-case tracking-normal" style={{ color: 'var(--muted)', background: 'none', border: 0, cursor: 'pointer' }}
                onClick={() => void navigator.clipboard.writeText(prompt)}>{t('copier')}</button>
            </h4>
            <div className="mt-2 text-[11px] max-h-[140px] overflow-y-auto" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>{prompt}</div>
          </div>
        )}
        <div className="mt-auto flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <button className="b2 flex-1" style={{ color: 'var(--positif)' }}
              onClick={() => items.forEach(a => a.reviewStatus === 'pending' && s.reviewAsset(a.id, 'approved'))}><Ic n="heart" /> {t('Tout valider')}</button>
            <button className="b2 flex-1" style={{ color: 'var(--danger)' }}
              onClick={() => items.forEach(a => a.reviewStatus === 'pending' && s.reviewAsset(a.id, 'rejected'))}><Ic n="x" /> {t('Tout refuser')}</button>
          </div>
          <button className="b2" onClick={() => {
            void (async () => { for (const a of items) {
              const l = document.createElement('a'); l.href = a.uri; l.download = a.uri.split('/').pop() ?? a.id
              document.body.appendChild(l); l.click(); l.remove()
              await new Promise(r => setTimeout(r, 250))
            } })()
          }}><Ic n="download" /> {t('Tout télécharger')}</button>
        </div>
      </aside>
    </div>
  )
}
