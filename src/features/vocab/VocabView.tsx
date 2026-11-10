/* ============================================================
   Vocabularies (☰) — EDITABLE libraries.
   Base = starter vocabulary (read-only) + user ADDITIONS
   (localStorage, custom_ prefix) merged everywhere.
   Per-tab additions with auto-tag; JSON export of additions.
   ============================================================ */
import { useState } from 'react'
import { Button, Field, SectionTitle, Select, Textarea } from '../../components/ui'
import { cn } from '../../lib/cn'
import { OUTFITS, ENVIRONMENTS, STYLES, HAIRSTYLES, TEXT_POSES } from '../../data/vocabularies'
import { useVocabStore, isCustom, newId } from '../../store/useVocabStore'
import { autotagOutfit, autotagEnvironment } from '../../lib/autotag'
import { t } from '../../i18n'

const TABS = ['Tenues', 'Environnements', 'Styles', 'Coiffures', 'Poses'] as const
type Tab = typeof TABS[number]

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[12px] rounded px-1.5 border text-muted border-border bg-surface3">
      {children}
    </span>
  )
}

/** Delete ✕ — only on user additions. */
function DeleteBtn({ kind, id }: { kind: string; id: string }) {
  const removeCustom = useVocabStore(s => s.removeCustom)
  if (!isCustom(id)) return null
  return (
    <button onClick={() => removeCustom(kind, id)} title={t('Supprimer cet ajout')}
      className="text-[12px] text-faint hover:text-alert cursor-pointer px-1 shrink-0">✕</button>
  )
}

const inputCls = 'w-full bg-bg border border-border text-text rounded-ctl px-2 py-1.5 text-[12px] focus:outline-none focus:border-accent-dim'

export function VocabView() {
  const [tab, setTab] = useState<Tab>('Tenues')
  const [adding, setAdding] = useState(false)

  const store = useVocabStore()

  /* Add form — shared fields, interpreted per tab. */
  const [fPrompt, setFPrompt] = useState('')
  const [fLabelFr, setFLabelFr] = useState('')
  const [fCtx, setFCtx] = useState('général')
  const [fLens, setFLens] = useState('')
  const resetForm = () => { setFPrompt(''); setFLabelFr(''); setFLens('') }

  const submit = () => {
    const id = newId()
    if (tab === 'Tenues') {
      if (!fPrompt.trim()) return
      const auto = autotagOutfit(fPrompt, fCtx)
      store.addOutfit({
        id, prompt: fPrompt.trim(), context: fCtx, source: 'ajout manuel',
        ...auto, labelFr: fLabelFr.trim() || auto.labelFr,
      })
    } else if (tab === 'Environnements') {
      if (!fPrompt.trim()) return
      const auto = autotagEnvironment(fPrompt, fCtx)
      store.addEnvironment({
        id, prompt: fPrompt.trim(), label: fPrompt.slice(0, 60),
        sceneType: fCtx, weather: '', source: 'ajout manuel',
        labelFr: fLabelFr.trim() || `${fCtx.charAt(0).toUpperCase() + fCtx.slice(1)} — ${auto.location}`,
        ...auto,
      })
    } else if (tab === 'Styles') {
      if (!fPrompt.trim()) return
      store.addStyle({
        id, label: fPrompt.slice(0, 48), labelFr: fLabelFr.trim() || undefined,
        framing: fPrompt.trim(), lens: fLens.trim(),
        tags: [fLens.trim(), 'ajout'].filter(Boolean), context: 'extérieur', source: 'ajout manuel',
      })
    } else if (tab === 'Coiffures') {
      if (!fPrompt.trim()) return
      store.addHairstyle({ id, label: fPrompt.slice(0, 60), labelFr: fLabelFr.trim() || undefined, prompt: fPrompt.trim() })
    } else if (tab === 'Poses') {
      if (!fPrompt.trim()) return
      store.addTextPose({ id, label: fPrompt.slice(0, 60), labelFr: fLabelFr.trim() || undefined, prompt: fPrompt.trim(), context: fCtx, source: 'ajout manuel' })
    }
    resetForm(); setAdding(false)
  }

  const exportAdds = () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'creatoros_vocab_ajouts.json'
    a.click()
  }

  const outfits = [...OUTFITS, ...store.customOutfits]
  const environments = [...ENVIRONMENTS, ...store.customEnvironments]
  const styles = [...STYLES, ...store.customStyles]
  const hairstyles = [...HAIRSTYLES, ...store.customHairstyles]
  const textPoses = [...TEXT_POSES, ...store.customTextPoses]

  const counts: Record<Tab, number> = {
    Tenues: outfits.length, Environnements: environments.length,
    Styles: styles.length, Coiffures: hairstyles.length, Poses: textPoses.length,
  }

  const canAdd = true

  const nbCustom = store.customOutfits.length + store.customEnvironments.length + store.customStyles.length
    + store.customHairstyles.length + store.customTextPoses.length

  return (
    <div className="flex-1 overflow-y-auto scroll-clean p-4 max-w-[980px]">
      <SectionTitle>{t('Vocabulaires — ce dans quoi la console puise (base + ajouts)')}</SectionTitle>

      <div className="flex gap-1.5 mb-3 flex-wrap items-center">
        {TABS.map(tb => (
          <button key={tb} onClick={() => { setTab(tb); setAdding(false) }}
            className={cn(
              'text-[12px] border rounded-full px-3 py-1 cursor-pointer',
              tab === tb ? 'text-text border-accent-dim bg-accent/10' : 'text-muted border-border bg-surface2',
            )}>
            {t(tb)} <span className="text-muted">{counts[tb]}</span>
          </button>
        ))}
        {canAdd && (
          <button onClick={() => setAdding(a => !a)}
            className={cn(
              'ml-auto text-[12px] border rounded-full px-3 py-1 cursor-pointer',
              adding ? 'text-text border-accent-dim bg-accent/10' : 'border-dashed border-border2 text-muted hover:text-text',
            )}>
            {t('＋ Ajouter')}
          </button>
        )}
        {nbCustom > 0 && (
          <button onClick={exportAdds}
            className="text-[12px] border border-border rounded-full px-3 py-1 text-muted hover:text-text cursor-pointer"
            title={t('Télécharger les ajouts (JSON)')}>
            {t('⇩ Export ({n})', { n: nbCustom })}
          </button>
        )}
      </div>

      {/* ---------- Add form (per tab) ---------- */}
      {adding && canAdd && (
        <div className="border border-accent-dim/40 rounded-card bg-surface2 p-3 mb-4">
          <div className="text-[12px] font-semibold mb-2">{t('Ajouter — {tab}', { tab: t(tab) })}</div>

          <>
              <Field label={
                tab === 'Tenues' ? t('Ligne de prompt EN (la tenue)')
                : tab === 'Environnements' ? t('Ligne de prompt EN (le lieu)')
                : tab === 'Styles' ? t('Cadrage EN')
                : tab === 'Coiffures' ? t('Ligne de prompt EN (la coiffure)')
                : t('Ligne de prompt EN (la pose)')
              }>
                <Textarea rows={2} value={fPrompt} onChange={e => setFPrompt(e.target.value)}
                  placeholder={
                    tab === 'Tenues' ? t('ex. emerald-green wool coat over a cream turtleneck')
                    : tab === 'Environnements' ? t('ex. on an old harbour at sunrise, pastel facades and fishing boats behind')
                    : tab === 'Styles' ? t('ex. low-angle full-body shot from the ground, 24mm')
                    : tab === 'Coiffures' ? t('ex. her hair in a loose french braid with escaped strands')
                    : t('ex. sitting on a low wall, swinging her legs')
                  } />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label={t('Titre FR (opt. — sinon auto)')}>
                  <input className={inputCls} value={fLabelFr} onChange={e => setFLabelFr(e.target.value)} placeholder={t('auto')} />
                </Field>
                {(tab === 'Tenues' || tab === 'Environnements' || tab === 'Poses') && (
                  <Field label={t('Contexte')}>
                    <Select value={fCtx} onChange={e => setFCtx(e.target.value)}>
                      {(tab === 'Environnements'
                        ? ['général', 'ville', 'plage', 'nature', 'chic', 'intérieur', 'studio']
                        : ['général', 'ville', 'plage', 'chic', 'sport'])
                        .map(c => <option key={c} value={c}>{t(c)}</option>)}
                    </Select>
                  </Field>
                )}
                {tab === 'Styles' && (
                  <Field label={t('Focale (opt.)')}>
                    <input className={inputCls} value={fLens} onChange={e => setFLens(e.target.value)} placeholder={t('ex. 35mm')} />
                  </Field>
                )}
              </div>
              {tab === 'Tenues' && fPrompt.trim() && (
                <div className="text-[12px] text-faint mb-2">
                  {t('Auto-tag : {v}', { v: (() => { const a = autotagOutfit(fPrompt, fCtx); return `${t(a.labelFr)} · ${a.material || t('matière ?')}` })() })}
                </div>
              )}
          </>

          <div className="flex gap-2">
            <Button variant="primary" onClick={submit}>{t('Ajouter')}</Button>
            <Button onClick={() => { resetForm(); setAdding(false) }}>{t('Annuler')}</Button>
          </div>
        </div>
      )}

      {tab === 'Tenues' && (
        <div className="grid gap-2">
          {outfits.map(o => (
            <div key={o.id} className={cn('flex items-center gap-3 border rounded-card bg-surface2 px-3 py-2.5',
              isCustom(o.id) ? 'border-accent-dim/40' : 'border-border')}>
              <span className="font-semibold text-[12.5px] w-[190px] shrink-0">{t(o.labelFr ?? o.label)}</span>
              <span className="text-[12px] text-muted flex-1 truncate" title={o.prompt}>
                {o.prompt ?? `${o.garment} · ${o.material} · ${o.color}`}
              </span>
              <span className="flex gap-1">{o.tags.slice(0, 3).map(tg => <Tag key={tg}>{t(tg)}</Tag>)}</span>
              <DeleteBtn kind="outfit" id={o.id} />
            </div>
          ))}
          <div className="text-[12px] text-faint mt-1">
            {t('Base : vocabulaire de départ (lecture seule) · ajouts (liseré bleu) stockés localement — « Export » pour les sauvegarder.')}
          </div>
        </div>
      )}

      {tab === 'Environnements' && (
        <div className="grid gap-2">
          {environments.map(e => (
            <div key={e.id} className={cn('flex items-center gap-3 border rounded-card bg-surface2 px-3 py-2.5',
              isCustom(e.id) ? 'border-accent-dim/40' : 'border-border')}>
              <span className="font-semibold text-[12.5px] w-[220px] shrink-0 truncate">{t(e.labelFr ?? e.label)}</span>
              <span className="text-[12px] text-muted flex-1 truncate" title={e.prompt}>{t(e.sceneType)} · {e.location}</span>
              <span className="flex gap-1">{e.tags.slice(0, 2).map(tg => <Tag key={tg}>{t(tg)}</Tag>)}</span>
              <DeleteBtn kind="environment" id={e.id} />
            </div>
          ))}
          <div className="text-[12px] text-faint mt-1">
            {t('Varier la lumière et la météo (pas de golden hour systématique).')}
          </div>
        </div>
      )}

      {tab === 'Styles' && (
        <div className="grid gap-2">
          {styles.map(s => (
            <div key={s.id} className={cn('flex items-center gap-3 border rounded-card bg-surface2 px-3 py-2.5',
              isCustom(s.id) ? 'border-accent-dim/40' : 'border-border')}>
              <span className="font-semibold text-[12.5px] w-[260px] shrink-0 truncate">{t(s.labelFr ?? s.label)}</span>
              <span className="text-[12px] text-muted flex-1 truncate">{s.framing}{s.lens ? ` · ${s.lens}` : ''}</span>
              <span className="flex gap-1">{s.tags.map(tg => <Tag key={tg}>{t(tg)}</Tag>)}</span>
              <DeleteBtn kind="style" id={s.id} />
            </div>
          ))}
        </div>
      )}

      {tab === 'Coiffures' && (
        <div className="grid gap-2">
          {hairstyles.map(h => (
            <div key={h.id} className={cn('flex items-center gap-3 border rounded-card bg-surface2 px-3 py-2.5',
              isCustom(h.id) ? 'border-accent-dim/40' : 'border-border')}>
              <span className="font-semibold text-[12.5px] w-[240px] shrink-0 truncate">{t(h.labelFr ?? h.label)}</span>
              <span className="text-[12px] text-muted flex-1 truncate" title={h.prompt}>{h.prompt}</span>
              <DeleteBtn kind="hairstyle" id={h.id} />
            </div>
          ))}
        </div>
      )}

      {tab === 'Poses' && (
        <div className="grid gap-2">
          {textPoses.map(p => (
            <div key={p.id} className={cn('flex items-center gap-3 border rounded-card bg-surface2 px-3 py-2.5',
              isCustom(p.id) ? 'border-accent-dim/40' : 'border-border')}>
              <span className="text-[12px] text-muted flex-1 truncate" title={p.prompt}>{p.prompt}</span>
              <Tag>{t(p.context)}</Tag>
              <DeleteBtn kind="textPose" id={p.id} />
            </div>
          ))}
          <div className="text-[12px] text-faint mt-1">
            {t('Poses exprimées en texte : elles entrent dans le prompt, entre la tenue et le cadrage.')}
          </div>
        </div>
      )}

    </div>
  )
}
