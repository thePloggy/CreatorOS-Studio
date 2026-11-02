/* ============================================================
   v2 — vue Image : la bibliothèque (photos) EST l'écran, la
   création est une barre flottante par-dessus. Jobs photo en
   placeholders dans la grille.
   ============================================================ */
import { useBriefHistory } from '../components/BriefHistory'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { STATUTS_ACTIFS } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic, rollingEta, fmtDur, SortBar, AssetCard, JobCard, FailCard, failedJobs, BatchCard, groupBatches, JustifiedGrid, ratioOf, AnimMenu, DimsMenu, SeedPill, MobileSheet, SelectionBar, applyFilters, useConfirm, type ReviewFilter } from './bits'
import { STYLES } from '../data/vocabularies'
import { EnhancerPopup, ElementsPopup, FramePicker, TriagePopup, CarouselPopup, BatchViewer } from './popups'
import { Pinceau } from '../components/Pinceau'
import { t, tp } from '../i18n'
import { ChoixPersonnage } from './ChoixPersonnage'
import { useEdition } from '../lib/proprietaire'
import { useMentions } from './Mentions'

/** Préréglages qui s'appuient sur les images de référence (FLUX.2 Klein). */
const PRESETS_REF = [
  { id: 'essayage', label: 'Essayage', aide: 'la tenue de l’image de référence portée par le personnage', ajout: false,
    texte: 'Full-body fashion photo of the main character wearing exactly the outfit shown in the reference image: same garment, fabric, colour and fit. Natural light, clean street background.' },
  { id: 'produit', label: 'Placement produit', aide: 'le personnage présente le produit de l’image de référence', ajout: false,
    texte: 'Lifestyle advertising photo of the main character holding and presenting the product from the reference image; the product stays exactly unchanged and clearly visible. Soft daylight.' },
  { id: 'moodboard', label: 'Moodboard', aide: 'les références donnent l’ambiance (couleurs, lumière, matière), pas leur contenu', ajout: true,
    texte: 'Match the colour palette, light, texture and mood of the reference images, without copying their subjects or composition.' },
]

export function ImageView({ onOpen, goVideo }: { onOpen: (a: Asset, list: Asset[]) => void; goVideo: () => void }) {
  const edition = useEdition()
  const s = useAppStore()
  const [review, setReview] = useState<ReviewFilter>(null)
  const [cols, setCols] = useState(() => (window.innerWidth < 821 ? 2 : 6))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const picking = picked.size > 0
  const [enh, setEnh] = useState(false)
  const [triage, setTriage] = useState(false)
  const [elm, setElm] = useState(false)
  const [srcPick, setSrcPick] = useState(false)
  const [refPick, setRefPick] = useState(false)
  // Retouche = pinceau : une image choisie s'ouvre directement dans l'outil de zone
  const [pinceauDe, setPinceauDe] = useState<Asset | null>(null)
  const kleinOk = s.personaKlein
  const champPrompt = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentions({ champ: champPrompt, valeur: s.userPrompt, surChange: s.setUserPrompt, surPersona: async id => {
    await s.choisirPersonnage(id)
  } })
  const [q, setQ] = useState('')
  /* un SEUL menu contextuel ouvert à la fois */
  const [ilotMenu, setIlotMenu] = useState<{ kind: 'dims'; x: number; bottom: number } | null>(null)
  const ilotToggle = (kind: 'dims') => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (ilotMenu?.kind === kind) { setIlotMenu(null); return }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setIlotMenu({ kind, x: r.left, bottom: window.innerHeight - r.top + 6 })
  }
  const [carousel, setCarousel] = useState<Asset | null>(null)
  const [batchOpen, setBatchOpen] = useState<string | null>(null)
  const [animMenu, setAnimMenu] = useState<{ x: number; y?: number; bottom?: number; a: Asset } | null>(null)
  const [purgeArmed, armPurge] = useConfirm()

  useEffect(() => { if (s.mode !== 'photo') s.setMode('photo') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => applyFilters(s.assets.filter(a => a.personaId === s.personaId), 'photo', review, q), [s.assets, s.personaId, review, q])
  const grid = useMemo(() => groupBatches(shown), [shown])
  const activeJobs = s.jobs.filter(j => j.mode !== 'video' && STATUTS_ACTIFS.includes(j.status))
  const failed = failedJobs(s.jobs, false)
  const briefs = useBriefHistory('photo', s.userPrompt, s.setUserPrompt)
  const task = s.photo.task
  const isMobile = window.innerWidth < 821
  const queueIds = activeJobs.filter(j => j.status === 'queued').map(j => j.id)

  const purge = async () => {
    if (!edition || !armPurge()) return
    const ids = s.assets.filter(a => a.mediaType === 'photo' && a.reviewStatus === 'rejected').map(a => a.id)
    await s.removeAssets(ids)
  }

  const photoEtaMs = rollingEta(s.assets, a => a.mediaType === 'photo', 25000)

  const togglePick = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const imgExtra = (a: Asset) => (<>
    {/* Éditer : envoie l'image en Retouche comme source (mode photo, tâche
        « edit »), sans passer par le sélecteur de source. */}
    <button className="fbtn" title={t('retoucher au pinceau')} onClick={e => { e.stopPropagation(); setPinceauDe(a) }}><Ic n="edit" /></button>
    <button className="fbtn" title={t('carrousel : 9 variations')} onClick={e => { e.stopPropagation(); setCarousel(a) }}><Ic n="grid" /></button>
    <span className="fbtn-group" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <button className="seg-main" title={t('animer (i2v)')} onClick={e => { e.stopPropagation(); void s.animateFrom(a); goVideo() }}><Ic n="camera" /></button>
      <button className="seg-arrow" title={t('frame de départ / de fin')}
        onClick={e => {
          if (animMenu?.a.id === a.id) { setAnimMenu(null); return }
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setAnimMenu({ x: Math.min(r.left, window.innerWidth - 190), bottom: window.innerHeight - r.top + 6, a })
        }}><Ic n="chevron" s={11} /></button>
    </span>
  </>)

  const envoyerUn = async () => {
    const e = useAppStore.getState()
    const st = e.photo.styleId ? (STYLES.find(x => x.id === e.photo.styleId) as { prompt?: string } | undefined) : null
    if (st?.prompt && task === 'generate' && !e.userPrompt.includes(st.prompt))
      e.setComposed(`${e.userPrompt.trim()}, ${st.prompt}`, '')
    await e.submitJob()
  }
  /* Plusieurs prompts : une ligne = un prompt, chaque
     ligne part avec les mêmes réglages (format, lot, graine, style). Le texte est
     rendu tel quel au champ à la fin. Le serveur compte chaque image au quota. */
  const [multi, setMulti] = useState(false)
  const lignes = multi && task === 'generate' ? s.userPrompt.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 20) : []
  const send = async () => {
    if (lignes.length < 2) return void envoyerUn()
    const garde = s.userPrompt
    try {
      for (const l of lignes) {
        useAppStore.setState({ userPrompt: l, promptTouched: true, composedPositive: '' })
        await envoyerUn()
        if (useAppStore.getState().t0Error) break
      }
    } finally { useAppStore.setState({ userPrompt: garde }) }
  }

  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      <div className="layer1 flex-1 min-h-0 flex flex-col">
        <SortBar assets={s.assets.filter(a => a.mediaType === 'photo')}
          review={review} setReview={setReview}
          cols={cols} setCols={setCols} picking={picking} setPicking={() => setPicked(new Set())}
          onPurge={purge} q={q} setQ={setQ} onTriage={() => setTriage(true)} />
        {purgeArmed && <div className="px-4 text-[12px]" style={{ color: 'var(--danger)' }}>{t('⚠ re-cliquer pour confirmer la suppression définitive')}</div>}

        <div className="scrollwrap"><div className="masonry"><JustifiedGrid cols={cols} items={[
          ...failed.map(j => ({ key: j.id, ratio: 9 / 16, node: <FailCard j={j} /> })),
          ...activeJobs.map(j => ({ key: j.id, ratio: (j.width && j.height ? j.width / j.height : 9 / 16),
            node: <JobCard j={j} queueIds={queueIds} /> })),
          ...grid.map(it => it.kind === 'batch'
            ? { key: it.id, ratio: 3 / 4,
                node: <BatchCard items={it.items} onOpen={() => setBatchOpen(it.id)}
                  picking={picking}
                  allPicked={it.items.every(a => picked.has(a.id))}
                  onPickAll={() => setPicked(p => {
                    const n = new Set(p)
                    const all = it.items.every(a => n.has(a.id))
                    it.items.forEach(a => { if (all) n.delete(a.id); else n.add(a.id) })
                    return n
                  })} /> }
            : { key: it.a.id, ratio: ratioOf(it.a),
                node: <AssetCard a={it.a} onOpen={x => onOpen(x, shown)}
                  picking={picking} picked={picked.has(it.a.id)}
                  onPick={togglePick}
                  extra={imgExtra(it.a)} /> }),
        ]} />
          {shown.length === 0 && activeJobs.length === 0 && failed.length === 0 && (
            <div style={{ color: 'var(--faint)', fontSize: 12, padding: 24 }}>{t('rien ici avec ces filtres')}</div>
          )}
        </div></div>
      </div>

      {/* ---------- barre de création : flottante (desktop) / sheet à crans (mobile) ;
           remplacée par la barre de sélection quand ≥1 vignette cochée ---------- */}
      {picking ? (
        <SelectionBar ids={[...picked]} assets={s.assets} onClear={() => setPicked(new Set())} />
      ) : (() => { const bar = (<>
        <div className="flex-1 min-w-0 fmain">
          <div className="flex gap-1.5 items-center mb-2">
            <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{t('Tâche')}</span>
            <button className={`spill ${task === 'generate' ? 'on' : ''}`} onClick={() => s.updatePhoto({ task: 'generate' })}>✎ {t('Générer')}</button>
            <button className={`spill ${task === 'edit' ? 'on' : ''}`} onClick={() => s.updatePhoto({ task: 'edit' })}>✦ {t('Retouche')}</button>
            {task === 'generate' && (<>
              <span className="text-[12px] ml-3" style={{ color: 'var(--faint)' }}>{t('Recette')}</span>
              <button className={`spill ${s.photoEngine === 'krea' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('krea')}
                title={t('Krea 2 — la recette de production, identité tenue par les LoRA Krea')}>Krea 2</button>
              <button className={`spill ${s.photoEngine === 'klein' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('klein')}
                title={t('FLUX.2 Klein 9B — références multiples ; sans LoRA Klein, le visage vient de la photo de profil du personnage')}>FLUX.2 Klein</button>
              <button className={`spill ${s.photoEngine === 'moss' ? 'on' : ''}`} onClick={() => s.setPhotoEngine('moss')}
                title={t('MOSS Image — texte vers image, Apache-2.0 ; pas de LoRA d’identité : le visage du personnage n’est pas tenu')}>MOSS Image</button>
              {s.photoEngine === 'klein' && !kleinOk && (
                <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{t('{nom} n’a pas de LoRA Klein : son visage vient de sa photo de profil', { nom: s.personaName })}</span>
              )}
            </>)}
          </div>
          {task === 'edit' && (
            <div className="flex gap-2.5 items-center mb-2">
              <button className="slot" style={{ width: 52, height: 66, flex: 'none', aspectRatio: 'auto' }} onClick={() => setSrcPick(true)}>
                {s.photo.editSourceUri ? <img src={s.photo.editSourceUri} alt="" /> : '＋'}
              </button>
              <span className="text-[12px]" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
                <b style={{ color: 'var(--text)' }}>{t('Image à retoucher')}</b><br />
                <span className="inline-flex gap-1.5 mt-1">
                  {edition && <label className="pill" style={{ fontSize: 12, padding: '4px 9px' }}>⇪ {t('Upload')}
                    <input type="file" accept="image/*" className="hidden" onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) void s.uploadEditSource(f)
                    }} />
                  </label>}
                  <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setSrcPick(true)}>▦ {t('Bibliothèque')}</button>
                  {(() => { const src = s.assets.find(x => x.id === s.photo.editSourceAssetId); return src
                    ? <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setPinceauDe(src)}>🖌 {t('Pinceau')}</button> : null })()}
                </span>
              </span>
            </div>
          )}
          {task !== 'edit' && s.references.length > 0 && (
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Références')}
              {s.references.map(r => <button key={r.file} title={t('retirer')} onClick={() => s.retirerReference(r.file)} style={{ width: 38, height: 38, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--lv3)', padding: 0, cursor: 'pointer' }}><img src={r.uri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></button>)}
              {s.references.length < 6 && <button className="pill" style={{ fontSize: 12, padding: '4px 9px' }} onClick={() => setRefPick(true)}>＋</button>}
              <span>{t('FLUX.2 Klein, nomme-les dans le prompt')}</span>
            </div>
          )}
          {task !== 'edit' && !s.references.length && <button className="pill" style={{ fontSize: 12, padding: '4px 9px', alignSelf: 'flex-start' }} onClick={() => setRefPick(true)}>＋ {t('Images de référence')}</button>}
          {task !== 'edit' && (
            <div className="flex gap-1.5 items-center flex-wrap text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('Préréglages')}
              {PRESETS_REF.map(p => (
                <button key={p.id} className="pill" style={{ fontSize: 12, padding: '4px 9px' }} title={t(p.aide)}
                  onClick={() => { s.setUserPrompt(p.ajout && s.userPrompt.trim() ? `${s.userPrompt.trim()} ${p.texte}` : p.texte); if (!s.references.length) setRefPick(true) }}>{t(p.label)}</button>
              ))}
            </div>
          )}
          <ChoixPersonnage />
          <textarea ref={champPrompt}
            className="w-full bg-transparent outline-none resize-none text-[13px]"
            style={{ color: 'var(--text)', minHeight: 40, fieldSizing: 'content' } as React.CSSProperties}
            placeholder={task === 'edit' ? t('Instruction de retouche — « la robe devient rouge »') : multi ? t('Un prompt par ligne : chaque ligne part avec les mêmes réglages') : t('Décrire la scène…')}
            value={s.userPrompt} onChange={e => { s.setUserPrompt(e.target.value); mentions.lire() }} onSelect={mentions.lire}
            onKeyDown={e => { if (!mentions.touche(e)) briefs.onKeyDown(e) }} />
          {mentions.panneau}
          {briefs.panel}
          <div className="flex gap-1.5 items-center mt-2 flex-wrap">
            <button className="pill" onPointerDown={e => e.stopPropagation()} onClick={ilotToggle('dims')}>
              {(s.photoSize ?? { label: '9:16', w: 768, h: 1344 }).label} <small>{(s.photoSize ?? { w: 768, h: 1344 }).w}×{(s.photoSize ?? { w: 768, h: 1344 }).h}</small>
            </button>
            <span className="stepper">
              <button onClick={() => s.setBatchCount(Math.max(1, s.batchCount - 1))}>−</button>
              <span>{t('lot {n}', { n: s.batchCount })}</span>
              <button onClick={() => s.setBatchCount(Math.min(10, s.batchCount + 1))}>+</button>
            </span>
            <SeedPill />
            <button className="pill tool" onClick={() => setEnh(true)}>✦ {t('Enhancer')}</button>
            <button className="pill tool" onClick={() => setElm(true)}>@ {t('Éléments')}</button>
            <button className="pill tool" onClick={briefs.open} title={t('briefs récents et étoilés (↑ dans un champ vide)')}>↺ {t('Briefs')}</button>
            {task === 'generate' && <button className={`pill tool${multi ? ' on' : ''}`} onClick={() => setMulti(m => !m)}
              title={t('Un prompt par ligne, lancés l’un après l’autre')}>≡ {multi && lignes.length > 1 ? t('{n} prompts', { n: lignes.length }) : t('Plusieurs prompts')}</button>}
            {s.userPrompt && <button className="pill tool" onClick={() => s.setUserPrompt('')} title={t('Vider le champ')}>✕</button>}
          </div>
          {s.t0Error && <div className="mt-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>{s.t0Error}</div>}
        </div>
        <button className="cta" style={isMobile ? { padding: '14px', flexDirection: 'row' } : { padding: '0 30px' }} onClick={() => void send()}>
          {t('Générer')} <small>{tp(s.batchCount * Math.max(1, lignes.length), '{n} job', '{n} jobs')} · ~{fmtDur(s.batchCount * Math.max(1, lignes.length) * photoEtaMs)}</small>
        </button>
      </>)
      return isMobile ? <MobileSheet>{bar}</MobileSheet> : <div className="fbar">{bar}</div> })()}

      {ilotMenu?.kind === 'dims' && <DimsMenu at={ilotMenu} onClose={() => setIlotMenu(null)} />}
      {animMenu && <AnimMenu at={animMenu} onClose={() => setAnimMenu(null)}
        onStart={() => { void s.pickStartFrame(animMenu.a.id); goVideo() }}
        onEnd={() => { void s.pickEndFrame(animMenu.a.id); goVideo() }} />}

      {carousel && <CarouselPopup asset={carousel} onClose={() => setCarousel(null)} onLaunched={() => setCarousel(null)} />}
      {batchOpen && (() => {
        const items = shown.filter(a => a.batchId === batchOpen || (a.batchIds ?? []).includes(batchOpen))
        return items.length
          ? <BatchViewer items={items} onClose={() => setBatchOpen(null)}
              onOpenAsset={a => { setBatchOpen(null); onOpen(a, items) }} extraFor={imgExtra} />
          : null
      })()}
      <TriagePopup open={triage} onClose={() => setTriage(false)} assets={s.assets.filter(a => a.mediaType === 'photo')} />
      <EnhancerPopup open={enh} onClose={() => setEnh(false)}
        mode="photo" engine={task === 'edit' ? 'edit' : null} userPrompt={s.userPrompt}
        /* La retouche part d'une image : la décrire évite que le réécriveur
           réinvente la tenue qu'il est censé conserver. Le choix suit `task`
           (un reste de sélection ne doit pas être décrit à la place de
           l'image courante). */
        anchorFile={task === 'edit' ? (s.photo.editSourceFile || null) : null}
        anchorUri={task === 'edit' ? (s.photo.editSourceUri || null) : null}
        onReplace={(pos, vision) => {
          useAppStore.setState({ initialBrief: s.userPrompt, promptVision: vision })
          s.setUserPrompt(pos)
        }} />
      <ElementsPopup open={elm} onClose={() => setElm(false)}
        onInsert={t => s.setUserPrompt((s.userPrompt ? `${s.userPrompt}, ${t}` : t).replace(/,\s*,+/g, ',').replace(/\s{2,}/g, ' '))} />
      <FramePicker open={refPick} onClose={() => setRefPick(false)} assets={s.assets.filter(a => a.mediaType === 'photo')} title={t('Image de référence')}
        onPickAsset={a => { void s.ajouterReference(a); setRefPick(false) }} onPickUpload={() => setRefPick(false)} />
      <FramePicker open={srcPick} onClose={() => setSrcPick(false)} assets={s.assets}
        title={t('Image à retoucher')}
        onPickAsset={a => { void s.pickEditSource(a.id); setPinceauDe(a) }}
        onPickUpload={() => { /* upload input direct non câblé sur photo (v1 idem) */ }} />
      {pinceauDe && <Pinceau asset={pinceauDe} onClose={() => setPinceauDe(null)} />}
    </div>
  )
}
