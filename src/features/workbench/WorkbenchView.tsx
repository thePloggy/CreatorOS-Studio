/* ============================================================
   Workbench (⚙) — édition de tout ce qui façonne la sortie.

   Deux familles, un seul mécanisme :
     Recettes  (.json)  le graphe ComfyUI
     Textes    (.txt)   system prompts du réécriveur, préambules
                        d'identité

   Les deux sont lus par le serveur À CHAQUE JOB (aucun cache) : une
   écriture prend effet au job suivant, sans redémarrage. Les deux
   sauvegardent l'ancienne version sous `.backups/` et refusent une
   écriture dont la base a bougé sur le disque. La vue sonde le
   `mtime` : si le fichier change dessous, elle recharge quand rien
   n'est en cours d'édition, et prévient sinon.

   La liste se lit au BADGE, pas au nom de fichier. Un nom comme
   `PROD_gen_sfw.json` ne dit pas ce qu'il fait ; « 📷 T2I » le dit
   d'un coup d'œil.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RecetteRevue } from './RecetteRevue'
import { Button, SectionTitle } from '../../components/ui'
import { cn } from '../../lib/cn'
import { t, getLang, tServeur } from '../../i18n'

type Kind = 'recette' | 'texte'
type Use = { kind: string; register: string }
type Summary = { base?: string[]; loras?: string[]; sampling?: string | null; nodes?: number; error?: string }

type Entry = {
  file: string
  bytes: number | null
  mtimeMs: number | null
  kind: Kind
  /* recettes */
  uses?: Use[]
  deprecated?: string | null
  summary?: Summary
  /* textes */
  label?: string
  registers?: string[]
  textKind?: string
}

/* ---------- badges ---------- */

/* L'icône dit la FONCTION. */
const FN_ICON: Record<string, string> = {
  generate: '📷', edit: '✦',
  video_wan: '🎬', video_ltx: '🎬', video_ltx_hq: '🎬', video_minimax: '🎬',
  motion: '🎬', motion_preview: '🎬',
  rewrite: '✍', preamble: '👤',
  intent: '🎯', engine: '⚙', rewrite_video: '✍',
}
const FN_LABEL: Record<string, string> = {
  generate: 'T2I', edit: 'Retouche',
  video_wan: 'Vidéo — Wan 2.2', video_ltx: 'Vidéo — LTX-2.5',
  video_ltx_hq: 'Vidéo — LTX qualité max', video_minimax: 'Vidéo — MiniMax H3',
  motion: 'Animate 2 (motion control) — 720p', motion_preview: 'Animate 2 — prévisu 480p',
  rewrite: 'Réécriveur (archive)', rewrite_video: 'Réécriveur vidéo (archive)',
  preamble: 'Préambule',
  intent: 'Intention globale', engine: 'Moteur',
}

function Badge({ fn }: { fn: string }) {
  return (
    <span className="text-[12px] border rounded-full px-2 py-[2px] whitespace-nowrap text-muted border-border bg-surface2">
      {FN_ICON[fn] ?? '•'} {t(FN_LABEL[fn] ?? fn)}
    </span>
  )
}

/** Badges d'une entrée : un par fonction servie (sans doublon). */
function badgesOf(e: Entry) {
  if (e.kind === 'texte') return [{ fn: e.textKind ?? 'autre' }]
  return [...new Set((e.uses ?? []).map(u => u.kind))].map(fn => ({ fn }))
}

/* Méta locale des textes, par NOM de fichier : le serveur en cours peut être
   antérieur aux nouvelles entrées (étiquettes « autre ») — le nom, lui, ne
   ment pas. La méta serveur gagne quand elle existe. */
function textMetaFallback(file: string): { textKind?: string; registers?: string[] } {
  if (file.startsWith('intent_')) return { textKind: 'intent', registers: [] }
  if (file.startsWith('engine_')) return { textKind: 'engine', registers: [] }
  return {}
}

const fmtBytes = (n: number | null) => (n == null ? '—' : t('{n} Ko', { n: (n / 1024).toFixed(1) }))
const fmtTime = (ms: number | null) =>
  ms == null ? '—' : new Date(ms).toLocaleString(getLang() === 'en' ? 'en-US' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' })

/** Sous-titre : ce que la recette FAIT tourner, en une ligne. */
function engineLine(s?: Summary) {
  if (!s || s.error) return s?.error ? `⚠ ${tServeur(s.error)}` : null
  const parts = [...(s.base ?? []), ...(s.loras ?? [])]
  return [parts.join(' + '), s.sampling].filter(Boolean).join(' · ') || null
}

export function WorkbenchView() {
  const [recipes, setRecipes] = useState<Entry[]>([])
  const [texts, setTexts] = useState<Entry[]>([])
  const [dirs, setDirs] = useState<{ recettes: string; textes: string }>({ recettes: '', textes: '' })
  const [showArchive, setShowArchive] = useState(false)

  const [sel, setSel] = useState<{ kind: Kind; file: string } | null>(null)
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [mtime, setMtime] = useState<number | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn' | 'err'; msg: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  // Lint anti-apparence des couches SOUL/MOOD (renvoyé par /api/prompts) :
  // mots d'apparence détectés. Non bloquant — un simple signal.
  const [warnings, setWarnings] = useState<string[]>([])

  const dirty = text !== savedText
  const api = (k: Kind) => (k === 'recette' ? '/api/workflows' : '/api/prompts')

  const live = useRef({ sel, dirty, mtime })
  live.current = { sel, dirty, mtime }

  const loadList = useCallback(async () => {
    const [w, p] = await Promise.all([
      fetch('/api/workflows').then(r => r.json()),
      fetch('/api/prompts').then(r => r.json()),
    ])
    setDirs({ recettes: w.dir, textes: p.dir })
    setRecipes(w.files.map((f: Entry) => ({ ...f, kind: 'recette' as const })))
    setTexts(p.files.map((f: Omit<Entry, 'kind'> & { kind?: string }) => ({
      ...f,
      ...(!f.kind || f.kind === 'autre' ? textMetaFallback(f.file) : { textKind: f.kind }),
      kind: 'texte' as const,
    })))
  }, [])

  const open = useCallback(async (kind: Kind, file: string) => {
    const r = await fetch(`${api(kind)}/${encodeURIComponent(file)}`)
    const d = await r.json()
    if (!r.ok) { setBanner({ tone: 'err', msg: tServeur(d.error) ?? t('lecture impossible') }); return }
    setSel({ kind, file }); setText(d.text); setSavedText(d.text); setMtime(d.mtimeMs)
    setJsonError(null); setBanner(null); setDiskChanged(false)
    setWarnings(Array.isArray(d.appearanceWarnings) ? d.appearanceWarnings : [])
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  /* Sondage du disque — la moitié « lecture » du va-et-vient. */
  useEffect(() => {
    const id = setInterval(async () => {
      const cur = live.current
      if (!cur.sel || saving) return
      try {
        const r = await fetch(`${api(cur.sel.kind)}/${encodeURIComponent(cur.sel.file)}`)
        if (!r.ok) return
        const d = await r.json()
        if (d.mtimeMs === cur.mtime) return
        if (cur.dirty) { setDiskChanged(true); return }
        setText(d.text); setSavedText(d.text); setMtime(d.mtimeMs)
        setBanner({ tone: 'warn', msg: t('rechargé : le fichier a changé sur le disque') })
        void loadList()
      } catch { /* serveur momentanément indisponible */ }
    }, 4000)
    return () => clearInterval(id)
  }, [saving, loadList])

  const onEdit = (v: string) => {
    setText(v)
    // Le JSON se valide à la frappe ; un texte libre n'a pas de format.
    if (sel?.kind !== 'recette') { setJsonError(null); return }
    try { JSON.parse(v); setJsonError(null) }
    catch (e) { setJsonError((e as Error).message) }
  }

  /* Import d'un fichier : remplit l'éditeur, n'écrit rien. L'opérateur relit,
     puis « Enregistrer » passe par la validation et la sauvegarde du serveur. */
  const importer = async (f: File) => {
    const brut = await f.text()
    let wf: unknown
    try { wf = JSON.parse(brut) }
    catch (e) { setBanner({ tone: 'err', msg: t('JSON invalide : {e}', { e: (e as Error).message }) }); return }
    // L'export « Save » de l'interface (nodes + links) n'est pas jouable par le serveur.
    if (wf && typeof wf === 'object' && Array.isArray((wf as { nodes?: unknown }).nodes)) {
      setBanner({ tone: 'err', msg: t('« {f} » est un export de l’interface ComfyUI (nodes + links). Exporter le graphe avec « Save (API) » ou « Export (API) », puis l’importer.', { f: f.name }) })
      return
    }
    const v = JSON.stringify(wf, null, 1) + '\n'
    setText(v); setJsonError(null)
    setBanner({ tone: 'warn', msg: t('« {f} » chargé dans l’éditeur, rien n’est encore écrit. Relire, puis « Enregistrer » : la recette actuelle est sauvegardée dans .backups/ avant d’être remplacée.', { f: f.name }) })
  }

  const save = async () => {
    if (!sel) return
    setSaving(true); setBanner(null)
    try {
      const r = await fetch(`${api(sel.kind)}/${encodeURIComponent(sel.file)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, baseMtimeMs: mtime }),
      })
      const d = await r.json()
      if (!r.ok) {
        setBanner({
          tone: 'err',
          msg: d.conflict
            ? t('{e} — recharger écrasera vos modifications, les copier d’abord.', { e: tServeur(d.error) })
            : t('refus du serveur : {e}', { e: tServeur(d.error) }),
        })
        if (d.conflict) setDiskChanged(true)
        return
      }
      setSavedText(text); setMtime(d.mtimeMs); setDiskChanged(false)
      const detail = sel.kind === 'recette'
        ? t('{n} nœuds, {c} classes, {o} sortie(s)', { n: d.nodes, c: d.classes, o: d.outputs })
        : t('{n} mots', { n: d.words })
      setBanner({
        tone: 'ok',
        msg: t('enregistré — {d}. Pris en compte au prochain job.', { d: detail })
          + (d.backup ? t(' Sauvegarde : .backups/{b}', { b: d.backup }) : ''),
      })
      void loadList()
    } finally { setSaving(false) }
  }

  /* Production d'abord, archive repliée : la liste sert à trouver ce qui
     tourne, pas à inventorier le dossier. */
  const prod = recipes.filter(r => r.uses?.length)
  const archive = recipes.filter(r => !r.uses?.length)
  const entry = [...recipes, ...texts].find(e => e.kind === sel?.kind && e.file === sel?.file) ?? null

  const Row = ({ e, dim = false }: { e: Entry; dim?: boolean }) => {
    const engine = e.kind === 'recette' ? engineLine(e.summary) : null
    const active = sel?.kind === e.kind && sel.file === e.file
    return (
      <button onClick={() => void open(e.kind, e.file)}
        className={cn(
          'w-full text-left border rounded-ctl px-2.5 py-2 mb-1 cursor-pointer',
          active ? 'border-accent-dim bg-accent/10' : 'border-border bg-surface2 hover:border-accent-dim/50',
          dim && !active && 'opacity-60',
        )}>
        <div className="flex gap-1 flex-wrap mb-1">
          {badgesOf(e).map((b, i) => <Badge key={i} {...b} />)}
          {e.deprecated && (
            <span className="text-[12px] border border-border bg-surface3 text-faint rounded-full px-2 py-[2px]">
              {t('dépréciée')}
            </span>
          )}
        </div>
        {engine && <div className="text-[12px] text-muted leading-snug mb-0.5">{engine}</div>}
        {e.kind === 'texte' && (
          <div className="text-[12px] text-muted leading-snug mb-0.5">{e.label}</div>
        )}
        <div className="text-[12px] text-faint font-mono truncate">
          {e.file} · {fmtBytes(e.bytes)} · {fmtTime(e.mtimeMs)}
        </div>
      </button>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ---- colonne gauche ---- */}
      <div className="w-[330px] shrink-0 border-r border-border overflow-y-auto scroll-clean p-3">
        <div className="flex items-center gap-1.5 flex-wrap mb-3 text-[12px] text-faint">
          <span>{t('📷 génération · ✦ retouche · 🎬 vidéo · ✍ réécriveur · 👤 préambule')}</span>
        </div>

        <SectionTitle>{t('Recettes')}</SectionTitle>
        <div className="text-[12px] text-faint mb-2 font-mono break-all">{dirs.recettes}</div>
        {prod.map(e => <Row key={e.file} e={e} />)}

        <button onClick={() => setShowArchive(v => !v)}
          className="w-full text-left text-[12px] text-muted border border-border bg-surface3 rounded-ctl px-2.5 py-1.5 mb-2 mt-1 cursor-pointer">
          {showArchive ? '▾' : '▸'} {t('Bancs d’essai et archives ({n})', { n: archive.length })}
        </button>
        {showArchive && archive.map(e => <Row key={e.file} e={e} dim />)}

        <SectionTitle className="mt-4">{t('Textes')}</SectionTitle>
        <div className="text-[12px] text-faint mb-2 font-mono break-all">{dirs.textes}</div>
        {texts
          .map(e => <Row key={e.file} e={e} />)}
      </div>

      {/* ---- colonne droite : l'éditeur ---- */}
      <div className="flex-1 overflow-y-auto scroll-clean p-4">
        {!sel && (
          <div className="text-[12px] text-muted max-w-[620px] leading-relaxed">
            {t('Choisir une recette ou un texte à gauche.')}
            <br /><br />
            {t('Les')} <b>{t('recettes')}</b> {t('sont les graphes ComfyUI. Les')} <b>{t('textes')}</b> {t('sont ce qui façonne la sortie sans être un graphe : le system prompt du réécriveur, le préambule d’identité préfixé au prompt.')}
            <br /><br />
            {t('Les deux sont relus par le serveur à chaque job : une modification prend effet au job suivant, sans redémarrage.')}
          </div>
        )}

        {sel && (
          <>
            <div className="flex items-baseline gap-2 flex-wrap mb-1">
              <span className="text-[13px] font-mono text-text">{sel.file}</span>
              {entry && badgesOf(entry).map((b, i) => <Badge key={i} {...b} />)}
              <span className="text-[12px] text-faint ml-auto">{t('sur disque : {d}', { d: fmtTime(mtime) })}</span>
            </div>

            {diskChanged && (
              <div className="text-[12px] text-warn border border-warn/30 bg-warn/10 rounded-ctl px-3 py-2 mb-2">
                {t('Le fichier a changé sur le disque pendant votre édition. « Relire le disque » abandonnera vos modifications — les copier avant si elles comptent.')}
              </div>
            )}
            {banner && (
              <div className={cn(
                'text-[12px] border rounded-ctl px-3 py-2 mb-2',
                banner.tone === 'ok' ? 'text-info border-info/30 bg-info/10'
                  : banner.tone === 'warn' ? 'text-warn border-warn/30 bg-warn/10'
                  : 'text-alert border-alert/40 bg-alert/10',
              )}>
                {banner.msg}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="text-[12px] border rounded-ctl px-3 py-2 mb-2 text-warn border-warn/30 bg-warn/10">
                {t("⚠ Couche SOUL/MOOD — mots d'")}<b>{t('apparence')}</b>{t(' détectés :')} <span className="font-mono">{warnings.join(', ')}</span>{t('. Ces couches ne doivent décrire que le')} <b>{t("comportement / l'atmosphère")}</b> {t("(l'apparence vient de la LoRA). Signal non bloquant.")}
              </div>
            )}

            <textarea
              value={text}
              onChange={e => onEdit(e.target.value)}
              spellCheck={false}
              className={cn(
                'w-full min-h-[520px] bg-bg border rounded-ctl p-3 resize-y scroll-clean',
                'focus:outline-none focus:ring-2 focus:ring-accent/15',
                sel.kind === 'recette'
                  ? 'font-mono text-[12px] text-[#c9d5e1]'
                  // Un system prompt se relit comme de la prose, pas comme du code.
                  : 'text-[12.5px] leading-relaxed text-[#dbe4ec]',
                jsonError ? 'border-alert/50' : 'border-border focus:border-accent-dim',
              )}
            />
            <div className="text-[12px] mt-1">
              {jsonError
                ? <span className="text-alert">{t('JSON invalide : {e}', { e: jsonError })}</span>
                : dirty
                  ? <span className="text-warn">{t('modifications non enregistrées')}</span>
                  : <span className="text-faint">{t('identique au disque')}</span>}
              {sel.kind === 'texte' && (
                <span className="text-faint">{t(' · {n} mots', { n: text.trim().split(/\s+/).filter(Boolean).length })}</span>
              )}
            </div>

            <div className="flex gap-2 mt-3 items-center">
              <Button variant="primary" disabled={!!jsonError || !dirty || saving} onClick={() => void save()}>
                {saving ? t('… écriture') : t('💾 Enregistrer sur le disque')}
              </Button>
              <Button disabled={saving} onClick={() => void open(sel.kind, sel.file)}>{t('↺ Relire le disque')}</Button>
              {sel.kind === 'recette' && (
                <label className={cn('rounded-ctl font-semibold cursor-pointer transition-colors bg-surface2 border border-border2 text-text hover:bg-surface3 px-4 py-2 text-[12.5px]', saving && 'opacity-50 pointer-events-none')}
                  title={t('Remplacer le contenu par un workflow exporté de ComfyUI au format API (.json)')}>
                  {t('📂 Importer un workflow API')}
                  <input type="file" accept=".json,application/json" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) void importer(f); e.target.value = '' }} />
                </label>
              )}
              <Button className="ml-auto"
                onClick={() => void navigator.clipboard?.writeText(text)}>{t('⧉ Copier')}</Button>
            </div>

            {sel.kind === 'recette' && <RecetteRevue key={sel.file} file={sel.file} />}

            <div className="text-[12px] text-faint mt-3 border border-border rounded-card bg-surface p-3 leading-snug">
              {t('Le serveur relit ce fichier à chaque job : une écriture prend effet au job suivant, sans redémarrage. L’ancienne version est copiée dans')}
              <span className="font-mono"> .backups/</span> {t('avant écrasement.')}
              {sel.kind === 'recette'
                ? t(' Une recette invalide est refusée avant écriture : JSON cassé, lien vers un nœud absent, ou absence de nœud de sortie.')
                : t(' Seul le vide est refusé — un texte de façonnage vide changerait le rendu sans le dire.')}
              <br />
              {t('Ce dossier est le dossier')} <b>{t('servi')}</b>{t(', hors dépôt git. Après une modification qui doit survivre, la reporter dans le dépôt — sinon le prochain déploiement la remplacera.')}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
