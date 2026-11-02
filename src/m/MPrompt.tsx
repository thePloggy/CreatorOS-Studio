/* ============================================================
   Améliorer et Éléments.

   Améliorer : le réécriveur local (même endpoint que le desktop) avec
   le moteur du brouillon. On montre Original ET
   Proposition ; seul « Appliquer » remplace le champ, et le brief
   d'origine est conservé en provenance.

   Éléments : les vocabulaires (tenues, environnements, positions,
   LoRA), insérés SANS écraser le texte existant.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Etoile, GarderobeTab } from '../components/Garderobe'
import { allOutfits, allEnvironments, allStyles, allTextPoses } from '../store/useVocabStore'
import { buildPhotoPrompt } from '../core/promptBuilder'
import { Ic, Opt, Seg, Sheet } from './bits'
import { t, tp, tServeur } from '../i18n'

/* ---------- Améliorer ---------- */
export function MEnhance({ onClose }: { onClose: () => void }) {
  const s = useAppStore()
  const original = s.userPrompt
  const [directives, setDirectives] = useState('')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /* Ce que le VLM a lu dans la still — consultable quand la réécriture
     surprend (image mal lue ≠ consigne mal suivie). */
  const [seen, setSeen] = useState<string | null>(null)
  const [suite, setSuite] = useState(false)
  /* « Tenue de l'image » : même verrou que sur desktop (appel VLM dédié,
     texte inséré tel quel par le serveur ; la description complète part
     quand même). */
  const [keepOutfit, setKeepOutfit] = useState(false)
  const [tenue, setTenue] = useState<{ text: string | null } | null>(null)
  /* Le réécriveur tourne sur le PROCESSEUR : 20 à 60 s, parfois plus si le
     modèle doit être chargé depuis le disque. Sans progression visible,
     l'attente ressemble à un blocage — on montre le temps qui passe. */
  const [sec, setSec] = useState(0)
  useEffect(() => {
    if (!busy) return
    const t0 = Date.now()
    const id = window.setInterval(() => setSec(Math.round((Date.now() - t0) / 1000)), 250)
    return () => window.clearInterval(id)
  }, [busy])

  /* Le fichier que le RENDU utilisera, choisi selon la tâche (même règle
     que la construction du job). */
  const ancre = (s.mode === 'video'
            ? (s.video.task === 'motion_pure' ? s.video.motionStillFile : s.video.startFrameFile)
            : (s.photo.task === 'edit' ? s.photo.editSourceFile : '')) || null

  const run = async () => {
    setBusy(true); setErr(''); setSec(0)
    try {
      const r = await fetch('/api/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          register: 'sfw',
          mode: s.mode === 'video' ? 'video' : 'photo',
          engine: s.mode === 'video' ? s.video.engine : null,
          userPrompt: original,
          userDirectives: directives,
          keepOutfit: keepOutfit && Boolean(ancre),
          /* Même contexte visuel que sur desktop, et surtout la même RÈGLE de
             choix : on décrit le fichier que le rendu utilisera, sélectionné
             d'après la tâche courante. Une précédence aveugle entre les deux
             champs fait décrire une still restée d'une sélection précédente. */
          anchorFile: ancre,
          /* Étendre : le prompt du clip prolongé, même contexte que desktop. */
          previousPrompt: s.mode === 'video' && s.video.task === 'extend' && s.video.extendAssetId
            ? ((p => p?.composedPositive || p?.userPrompt || null)(s.assets.find(a => a.id === s.video.extendAssetId)?.provenance))
            : null,
        }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`)
      setOut(String(b.positive ?? ''))
      setSeen(typeof b.sceneDesc === 'string' ? b.sceneDesc : null)
      setSuite(Boolean(b.continuation))
      setTenue(b.outfitRequested ? { text: typeof b.outfitAnchor === 'string' ? b.outfitAnchor : null } : null)
    } catch (e) { setErr(String((e as Error).message || e)) } finally { setBusy(false) }
  }

  const apply = () => {
    // Le brief d'origine part en provenance : rien n'est perdu.
    useAppStore.setState({ initialBrief: original, promptVision: seen })
    s.setUserPrompt(out)
    onClose()
  }

  return (
    <Sheet title={t('Améliorer le prompt')} onClose={onClose}>
      <div className="label" style={{ marginTop: 0 }}>{t('Original')}</div>
      <div className="card" style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--tx2)' }}>
        {original || <span style={{ color: 'var(--tx3)' }}>{t('— le champ est vide —')}</span>}
      </div>

      <div className="label">{t('Directives au réécriveur')} <span className="muted" style={{ fontWeight: 400 }}>{t('(facultatif)')}</span></div>
      <input className="field" placeholder={t('garde le décor, insiste sur la lumière…')}
        value={directives} onChange={e => setDirectives(e.target.value)} />
      {ancre && (
        <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input type="checkbox" checked={keepOutfit} onChange={e => setKeepOutfit(e.target.checked)} />
          {t("Tenue de l'image — garder exactement la tenue vue dans la still")}
        </label>
      )}

      {!out && !busy && (
        <button className="cta" style={{ marginTop: 16 }} disabled={!original.trim()}
          onClick={() => void run()}>{t('Proposer une réécriture')}</button>
      )}
      {busy && (
        <div className="card" style={{ marginTop: 16, textAlign: 'center' }} role="status" aria-live="polite">
          <div className="spin" style={{ margin: '4px auto 12px' }} />
          <b style={{ fontSize: 16 }}>{t('Le modèle écrit… {sec} s', { sec })}</b>
          <div className="bar idle" style={{ margin: '12px 0 8px' }}><i /></div>
          <small className="muted">
            {t('Le réécriveur tourne sur la machine de rendu — compte 20 à 60 secondes.')}
          </small>
        </div>
      )}
      {err && <p className="err">{err}</p>}

      {tenue && <p className="muted" style={{ marginTop: 12 }}>{t('👗 Tenue verrouillée : {tenue}', { tenue: tenue.text ?? t('aucun vêtement détecté — rien inséré') })}</p>}
      {suite && <p className="muted" style={{ marginTop: 12 }}>{t('↪ Écrit comme la suite du clip prolongé (son prompt a été lu).')}</p>}
      {seen && (
        <details style={{ marginTop: 12 }}>
          <summary className="label" style={{ cursor: 'pointer' }}>{t('👁 ce que le VLM a vu dans la still')}</summary>
          <p className="muted" style={{ marginTop: 6 }}>{seen}</p>
        </details>
      )}

      {out && (<>
        <div className="label">{t('Proposition')} <span className="muted" style={{ fontWeight: 400 }}>{t('(modifiable)')}</span></div>
        <textarea className="field" value={out} onChange={e => setOut(e.target.value)} style={{ minHeight: 180 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="chip" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>{t('Conserver l’original')}</button>
          <button className="cta" style={{ flex: 2, padding: 14 }} onClick={apply}>{t('Appliquer')}</button>
        </div>
        <button className="chip" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
          disabled={busy} onClick={() => void run()}>{busy ? t('réécriture… {sec} s', { sec }) : t('Réessayer')}</button>
      </>)}
    </Sheet>
  )
}

/* ---------- Éléments ---------- */
type Cat = 'garde' | 'compo' | 'tenues' | 'lieux' | 'poses' | 'loras'
type Ligne = { id: string; label: string; prompt: string }
const lignes = (xs: { id: string; label: string; labelFr?: string; prompt?: string }[]): Ligne[] =>
  xs.filter(x => x.prompt).map(x => ({ id: x.id, label: x.labelFr ?? x.label, prompt: x.prompt as string }))
const CATS: [Cat, string, () => Ligne[]][] = [
  ['tenues', 'Tenues', () => lignes(allOutfits())],
  ['lieux', 'Environnements', () => lignes(allEnvironments())],
  ['poses', 'Positions', () => lignes(allTextPoses())],
]

export function MElements({ onClose }: { onClose: () => void }) {
  const s = useAppStore()
  const [cat, setCat] = useState<Cat>('garde')
  const [q, setQ] = useState('')

  const values = useMemo(() => {
    /* `compo` et `loras` n'ont pas de liste de vocabulaire. */
    const entry = CATS.find(c => c[0] === cat)
    if (!entry) return []
    const out = entry[2]()
    const needle = q.trim().toLowerCase()
    return needle ? out.filter(x => `${x.label} ${x.prompt}`.toLowerCase().includes(needle)) : out
  }, [cat, q])

  /* Compatibilité par ARCHITECTURE : une LoRA Flux ne s'applique pas à une
     recette H3 et inversement — les proposer toutes ferait charger une LoRA
     inerte, et on croirait la recette faible. */
  const compatibleLoras = useMemo(
    () => s.loraCatalog.filter(l => (s.mode === 'video' ? l.arch === 'h3' : l.arch !== 'h3')),
    [s.loraCatalog, s.mode])

  /* Insertion ADDITIVE : on n'écrase jamais ce qui est déjà écrit. */
  const insert = (text: string) => {
    const cur = s.userPrompt.trim()
    s.setUserPrompt(cur ? `${cur}, ${text}` : text)
  }

  return (
    <Sheet title={t('Éléments')} onClose={onClose}>
      <Seg value={cat} onPick={setCat}
        options={[['garde', '★'], ['compo', t('Compo')], ['tenues', t('Tenues')], ['lieux', t('Lieux')], ['poses', t('Poses')], ['loras', 'LoRA']]} />

      {cat === 'garde' && <GarderobeTab prompt={s.userPrompt} onInsert={insert} />}
      {cat === 'compo' && <Composition onClose={onClose} />}

      {cat !== 'loras' && cat !== 'compo' && cat !== 'garde' && (<>
        <input className="field" style={{ marginTop: 12 }} placeholder={t('rechercher…')}
          value={q} onChange={e => setQ(e.target.value)} />
        <button className="chip" style={{ marginTop: 10 }} onClick={() => {
          if (!values.length) return
          const pick = values[Math.floor(Math.random() * values.length)]
          insert(pick.prompt)
        }}>{tp(values.length, '🎲 Au hasard dans {n} valeur', '🎲 Au hasard dans {n} valeurs')}</button>

        <div style={{ marginTop: 8 }}>
          {values.slice(0, 200).map(x => (
            <button key={x.id} className="opt" onClick={() => insert(x.prompt)}>
              <span style={{ flex: 1 }}>{x.prompt}<small style={{ display: 'block', color: 'var(--tx2)' }}>{t(x.label)}</small></span>
              {(cat === 'tenues' || cat === 'lieux') && <Etoile kind={cat} id={x.id} />}
              <Ic n="skip" s={16} />
            </button>
          ))}
          {values.length === 0 && (
            <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>
              {t('Rien dans cette catégorie.')}
            </p>
          )}
        </div>
      </>)}

      {cat === 'loras' && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ fontSize: 13 }}>
            {t('Seules les LoRA compatibles avec la recette en cours sont listées.')}
          </p>
          {compatibleLoras.map(l => {
            const on = s.mode === 'video'
              ? s.video.videoLoras.some(x => x.name === l.name)
              : s.loraPicks.some(x => x.name === l.name)
            return (
              <button key={l.name} className="opt" onClick={() => s.toggleLora(l.name)}>
                <span style={{ flex: 1 }}>{l.name}
                  <small style={{ display: 'block', color: 'var(--tx2)' }}>
                    {l.arch}{l.trigger ? t(' · déclencheur : {trigger}', { trigger: l.trigger }) : ''}
                  </small></span>
                {on && <span className="ck"><Ic n="check" s={18} /></span>}
              </button>
            )
          })}
          {compatibleLoras.length === 0 && (
            <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>{t('Aucune LoRA compatible.')}</p>
          )}
        </div>
      )}
    </Sheet>
  )
}

/* ---------- Composition guidée ----------
   Le prompt assemblé champ par champ depuis les vocabulaires. Chaque ligne
   montre sa valeur ou « Non choisi ».
   L'aperçu du prompt composé est visible AVANT d'appliquer. */
function Composition({ onClose }: { onClose: () => void }) {
  const s = useAppStore()
  const [open, setOpen] = useState<null | 'outfit' | 'env' | 'pose' | 'style'>(null)

  const fr = (xs: { id: string; label: string; labelFr?: string }[]) => xs.map(x => ({ id: x.id, label: x.labelFr ?? x.label }))
  const lists: Record<'outfit' | 'env' | 'pose' | 'style', { id: string; label: string }[]> = {
    outfit: fr(allOutfits()),
    env: fr(allEnvironments()),
    pose: fr(allTextPoses()),
    style: fr(allStyles()),
  }
  const cur: Record<'outfit' | 'env' | 'pose' | 'style', { id: string; label: string } | undefined> = {
    outfit: lists.outfit.find(o => o.id === s.photo.outfitId),
    env: lists.env.find(e => e.id === s.photo.environmentId),
    pose: lists.pose.find(p => p.id === s.photo.textPoseId),
    style: lists.style.find(x => x.id === s.photo.styleId),
  }
  const set = (k: 'outfit' | 'env' | 'pose' | 'style', id: string | null) => {
    s.updatePhoto(k === 'outfit' ? { outfitId: id }
      : k === 'env' ? { environmentId: id }
      : k === 'pose' ? { textPoseId: id }
      : { styleId: id })
  }
  const rand = (k: 'outfit' | 'env' | 'pose' | 'style') => {
    const l = lists[k]
    if (l.length) set(k, l[Math.floor(Math.random() * l.length)].id)
  }
  const preview = buildPhotoPrompt(s.photo)

  const ROWS: [typeof open & string, string][] = [
    ['outfit', 'Tenue'], ['env', 'Lieu'], ['pose', 'Pose'], ['style', 'Cadrage / lumière'],
  ]

  return (
    <div style={{ marginTop: 12 }}>
      {ROWS.map(([k, label]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
          <button style={{ flex: 1, textAlign: 'left', minHeight: 40 }} onClick={() => setOpen(k)}>
            <small className="muted" style={{ display: 'block', fontSize: 12 }}>{t(label)}</small>
            <span style={{ fontSize: 15 }}>
              {cur[k] ? t(cur[k]!.label) : <span style={{ color: 'var(--tx3)' }}>{t('Non choisi')}</span>}
            </span>
          </button>
          <button className="chip tap-sm" style={{ minHeight: 36 }} onClick={() => rand(k)} aria-label={t('{label} au hasard', { label: t(label) })}>🎲</button>
        </div>
      ))}

      <div className="label">{t('Aperçu du prompt')}</div>
      <div className="card muted" style={{ fontSize: 13, lineHeight: 1.5, maxHeight: 160, overflowY: 'auto' }}>
        {preview || '—'}
      </div>
      <button className="cta" style={{ marginTop: 14 }} onClick={() => { s.setUserPrompt(preview); onClose() }}>
        {t('Appliquer au prompt')}
      </button>
      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        {t('Le texte reste modifiable à la main ensuite.')}
      </p>

      {open && (
        <Sheet title={t(ROWS.find(r => r[0] === open)![1])} onClose={() => setOpen(null)}>
          <Opt label={t('Non choisi')} on={!cur[open]} onClick={() => { set(open, null); setOpen(null) }} />
          {lists[open].map(it => (
            <Opt key={it.id} label={t(it.label)}
              on={cur[open]?.id === it.id}
              onClick={() => { set(open, it.id); setOpen(null) }} />
          ))}
        </Sheet>
      )}
    </div>
  )
}
