/* ============================================================
   Reel en un clic : un brief, et l'app réalise le reel : plans
   rédigés, photos, clips LTX, montage avec fondus et accroche, export.
   Le suivi vient du serveur (server/reel.js) ; ici on lance et on regarde.
   Le montage produit reste modifiable dans l'onglet Montage.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { getLang, t, tServeur } from '../i18n'
import { ChoixPersonnage } from './ChoixPersonnage'
import { ChoixVoix } from './ChoixVoix'
import { useEdition } from '../lib/proprietaire'
import { Ecouter, urlEchantillonVoix, urlMusique } from './Ecouter'
import { ActionPanneau, BarreGalerie, Carte, EtapesPanneau, useCarteAuCentre, useMouvementReduit, useSurvolPossible } from './Galerie'
import { HowItWorks, howto } from './HowItWorks'

interface PlanReel { still: string; motion: string; avertissements?: string[]; clipJob?: string | null; photoUri: string | null; clipUri: string | null; photoEtat: string | null; clipEtat: string | null; supprime?: boolean }
interface Reel {
  id: string; brief: string; etat: 'redaction' | 'storyboard' | 'preset' | 'photos' | 'clips' | 'export' | 'fini' | 'echec'
  cases?: Record<string, string | string[] | Record<string, string>[]>
  n: number; accroche?: string; plans: PlanReel[]; montageId?: string; reelUri: string | null; erreur?: string | null; createdAt: number
}
interface MusiqueRow { nom: string; duree: number }
interface PresetReel { id: string; nom: string; texte: string; exemple: string }

const EXEMPLES = [
  'Un dimanche matin à Paris : café en terrasse, balade sur les quais, librairie ancienne, lumière dorée',
  'Road trip au coucher du soleil dans le désert, vieille décapotable, vent dans les cheveux',
  'Séance de yoga au lever du soleil sur une terrasse en bois face à la mer',
  'Soirée cocktail sur un rooftop à New York, néons et lumières de la ville',
]
const json = async (r: Response) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(tServeur(b.error) ?? `HTTP ${r.status}`); return b }

export function ReelView({ goMontage }: { goMontage: (montageId: string) => void }) {
  const s = useAppStore()
  const [brief, setBrief] = useState('')
  const [n, setN] = useState(5)
  const [duree, setDuree] = useState(4)
  const [musique, setMusique] = useState('')
  // par défaut, la voix enregistrée sur la fiche du personnage
  const [voixOff, setVoixOff] = useState(() => (useAppStore.getState().personaVoix ? 'perso' : ''))
  const [caler, setCaler] = useState(true)
  const [musiques, setMusiques] = useState<MusiqueRow[]>([])
  /* Nouveau morceau depuis le reel : ACE-Step le compose à la durée du reel, puis il est choisi. */
  const [nouvelle, setNouvelle] = useState<{ prompt: string; job: string | null; msg: string } | null>(null)
  const genererMorceau = async () => {
    if (!nouvelle?.prompt.trim()) return
    const r = await fetch('/api/musique', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: nouvelle.prompt, paroles: '', secondes: n * duree + 2, genre: 'musique' }) })
    const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
    if (!r.ok || !d.jobId) { setNouvelle(x => x && { ...x, msg: tServeur(d.error) ?? `HTTP ${r.status}` }); return }
    setNouvelle(x => x && { ...x, job: d.jobId!, msg: '' })
    void s.adoptServerJob(d.jobId)
    const avant = new Set(musiques.map(m => m.nom))
    for (let k = 0; k < 120; k++) {
      await new Promise(p => setTimeout(p, 2000))
      const j = await fetch(`/api/jobs/${encodeURIComponent(d.jobId)}`).then(json).catch(() => null) as { job?: { status?: string; error?: string } } | null
      const st = j?.job?.status
      if (st === 'done') {
        const liste = await fetch('/api/montage/musiques').then(json).then((x: { musiques?: MusiqueRow[] }) => x.musiques ?? []).catch(() => [] as MusiqueRow[])
        setMusiques(liste)
        const neuf = liste.find(m => !avant.has(m.nom))
        if (neuf) setMusique(neuf.nom)
        setNouvelle(null); return
      }
      if (st === 'blocked' || st === 'failed' || st === 'cancelled') { setNouvelle(x => x && { ...x, job: null, msg: tServeur(j?.job?.error) ?? t('échec') }); return }
    }
  }
  const [reels, setReels] = useState<Reel[]>([])
  // un preset (saut de tenues, GRWM…) : la structure du reel est tenue par le studio, le brief remplit les cases
  const [presets, setPresets] = useState<PresetReel[]>([])
  const [preset, setPreset] = useState<string>('')
  const [relire, setRelire] = useState(true)
  useEffect(() => { void fetch('/api/reels/presets').then(json).then(d => setPresets(d.presets ?? [])).catch(() => {}) }, [])
  const choisi = presets.find(p => p.id === preset)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const charger = () => void fetch('/api/reels').then(json).then(d => setReels(d.reels ?? [])).catch(e => setErr(String(e.message)))
  useEffect(charger, [s.personaId])
  useEffect(() => { void fetch('/api/montage/musiques').then(json).then(d => setMusiques(d.musiques ?? [])).catch(() => {}) }, [])
  const enCours = reels.some(r => !['fini', 'echec'].includes(r.etat))
  useEffect(() => {
    if (!enCours) return
    const h = setInterval(charger, 3000)
    return () => clearInterval(h)
  }, [enCours])

  const lancer = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await json(await fetch('/api/reels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preset ? { preset, brief, langue: getLang(), relire } : { brief, n, duree, musique: musique || undefined, voix: voixOff || undefined, calerMusique: !!musique && caler, langue: getLang() }) }))
      setReels(x => [r, ...x]); setBrief('')
      setBusy(false); return true
    } catch (e) { setErr(String((e as Error).message)) }
    setBusy(false); return false
  }

  /* Mise en page : la galerie des formats et la liste des reels occupent la largeur, un panneau compact à étapes
     (personnage, format, brief, réglages, bouton) reste visible ; sur téléphone il devient une barre en bas. */
  const reduit = useMouvementReduit()
  const survolPossible = useSurvolPossible()
  const [onglet, setOnglet] = useState<'formats' | 'reels'>('formats')
  const [options, setOptions] = useState(false)
  const [appel, setAppel] = useState(false)
  const galerie = useRef<HTMLElement | null>(null)
  const ancre = useRef<HTMLDivElement | null>(null)
  const panneau = useRef<HTMLElement | null>(null)
  const champBrief = useRef<HTMLTextAreaElement | null>(null)
  const changerOnglet = (o: 'formats' | 'reels') => {
    setOnglet(o)
    const g = galerie.current; const haut = o === 'reels' ? 0 : ancre.current?.offsetTop ?? 0
    if (g && g.scrollTop > haut) g.scrollTo({ top: haut })
  }
  const commencer = () => {
    ancre.current?.scrollIntoView({ behavior: reduit ? 'auto' : 'smooth', block: 'start' })
    const cible = panneau.current?.querySelector<HTMLElement>('.dz-etape.prochaine') ?? panneau.current?.querySelector<HTMLElement>('.dz-action .cta:not(:disabled)')
    cible?.focus({ preventScroll: true })
    setAppel(true); window.setTimeout(() => setAppel(false), 1600)
  }
  const ouvrirBrief = () => { setOptions(true); window.setTimeout(() => champBrief.current?.focus(), 0) }
  const lancerPuisSuivre = async () => { if (await lancer()) changerOnglet('reels') }
  const formats = presets.filter(p => p.id !== 'journee')
  const visibles = reels.filter(r => r.etat !== 'fini' || r.reelUri || r.plans.some(p => !p.supprime))
  const nbEnCours = reels.filter(r => !['fini', 'echec'].includes(r.etat)).length
  const centre = useCarteAuCentre(!survolPossible && !reduit && onglet === 'formats', [onglet, formats.length])
  const pret = !busy && (!!brief.trim() || !!preset)
  const manque = !brief.trim() && !preset ? t('Écris ton brief : le lieu, l’ambiance, ce qui se passe.') : null
  const prochaine = !brief.trim() && !preset ? 3 : 0
  const minutes = preset ? 25 : 2 + n * 3
  const fichiers = howto('reel')

  return (
    <div className="dz">
      <aside ref={panneau} className={`dz-panneau ${options ? 'options-ouvertes' : ''} ${appel ? 'appel' : ''}`} aria-label={t('Reel en un clic')}>
        <header className="dz-tete">
          <h2 className="titre-outil">{t('Reel en un clic')}</h2>
          <p>{t('Décris la scène : {nom} est photographiée plan par plan, chaque plan est animé avec le son, puis le reel est monté avec fondus, accroche et musique.', { nom: s.personaName })}</p>
        </header>

        <EtapesPanneau prochaine={prochaine} etapes={[
          { n: 1, label: t('Personnage'), valeur: s.personaName || t('Choisir un personnage'), fait: !!s.personaName, icone: 'user', vignette: s.personaAvatar || undefined,
            ouvrir: () => { setOptions(true); window.setTimeout(() => panneau.current?.querySelector<HTMLElement>('.dz-reel-perso button, .dz-reel-perso select')?.focus(), 0) } },
          { n: 2, label: t('Format'), valeur: choisi ? t(choisi.nom) : t('Libre'), fait: true, icone: 'grid',
            vignette: choisi ? `/vitrine/reels/${choisi.id}.webp` : undefined, fixe: true, ouvrir: () => changerOnglet('formats'), courant: onglet === 'formats' },
          { n: 3, label: t('Brief'), valeur: brief.trim() || (preset ? t('Facultatif : le studio remplit les cases') : t('Écrire le brief')), fait: !!brief.trim(), icone: 'edit', ouvrir: ouvrirBrief },
        ]} />

        <div className="dz-options" id="reel-options">
          <div className="dz-reel-perso"><ChoixPersonnage /></div>
          {choisi && <p className="dz-note">{t(choisi.texte)}</p>}
          <label className="dz-champ">
            <span>{t('Brief')}</span>
            <textarea ref={champBrief} rows={3} value={brief} onChange={e => setBrief(e.target.value)} maxLength={600} placeholder={choisi ? t(choisi.exemple) : t('Le lieu, l’ambiance, ce qui se passe…')}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && pret) void lancerPuisSuivre() }} />
          </label>
          {!preset && <div className="dz-idees" role="group" aria-label={t('Idées de brief')}>
            {EXEMPLES.map(x => <button key={x} type="button" aria-pressed={brief === t(x)} className={brief === t(x) ? 'on' : ''} onClick={() => setBrief(t(x))}>{t(x).split(':')[0].split(',')[0]}</button>)}
          </div>}
          {!preset && <>
            <div className="dz-champ">
              <span>{t('Plans')}</span>
              <div className="dz-segments" role="group" aria-label={t('Plans')}>
                {[3, 4, 5, 6].map(k => <button key={k} type="button" aria-pressed={n === k} className={n === k ? 'on' : ''} onClick={() => setN(k)}>{k}</button>)}
              </div>
            </div>
            <div className="dz-champ">
              <span>{t('Durée par plan')}</span>
              <div className="dz-segments" role="group" aria-label={t('Durée par plan')}>
                {[3, 4, 5].map(k => <button key={k} type="button" aria-pressed={duree === k} className={duree === k ? 'on' : ''} onClick={() => setDuree(k)}>{t('{n} s', { n: k })}</button>)}
              </div>
            </div>
            <div className="dz-champ">
              <span>{t('Musique')}</span>
              <span className="dz-ligne">
                <select value={musique} onChange={e => setMusique(e.target.value)} className="champ" aria-label={t('Musique')}>
                  <option value="">{t('son des clips seulement')}</option>
                  {musiques.map(m => <option key={m.nom} value={m.nom}>{m.nom}</option>)}
                </select>
                <Ecouter src={urlMusique(musique)} titre={t('Écouter la musique')} />
              </span>
              <span className="dz-ligne">
                <button type="button" className="dz-ajout" disabled={!!nouvelle?.job} onClick={() => setNouvelle(x => x ? null : { prompt: '', job: null, msg: '' })}>
                  {nouvelle?.job ? t('morceau en cours…') : `+ ${t('Nouveau morceau')}`}</button>
                {musique && <label className="dz-case"><input type="checkbox" checked={caler} onChange={e => setCaler(e.target.checked)} /> {t('couper sur le rythme')}</label>}
              </span>
              {nouvelle && !nouvelle.job && <span className="dz-ligne">
                <input className="champ" style={{ flex: 1 }} value={nouvelle.prompt} autoFocus maxLength={300}
                  placeholder={t('Le style du morceau, ex. sunny acoustic guitar and light percussion, upbeat, 100 bpm')}
                  onChange={e => setNouvelle(x => x && { ...x, prompt: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter' && nouvelle.prompt.trim()) void genererMorceau() }} />
                <button className="pill" disabled={!nouvelle.prompt.trim()} onClick={() => void genererMorceau()}>{t('Générer')} · {n * duree + 2} s</button>
              </span>}
              {nouvelle?.msg && <span className="texte-erreur">{nouvelle.msg}</span>}
            </div>
            <div className="dz-champ">
              <span>{t('Voix off')}</span>
              <span className="dz-ligne">
                <ChoixVoix valeur={voixOff} onChange={setVoixOff} vide={t('aucune')} ariaLabel={t('Voix off')} />
                {voixOff && !voixOff.startsWith('clone:') && voixOff !== 'perso' && <Ecouter src={urlEchantillonVoix(voixOff)} titre={t('Écouter la voix')} />}
              </span>
            </div>
          </>}
          {preset && <label className="dz-bascule">
            <input type="checkbox" checked={relire} onChange={e => setRelire(e.target.checked)} />
            <span><b>{t('Relire le storyboard avant de tourner')}</b><small>{t('Chaque case écrite par le studio se corrige avant les images et les clips.')}</small></span>
          </label>}
          <small className="dz-note">{preset
            ? t('Compter environ 25 min : le format est tenu par le studio, les images puis les clips, montage.')
            : t('Compter environ {m} min : rédaction, {n} photos, {n} clips LTX-2.5 avec le son, montage.', { m: 2 + n * 3, n })}</small>
        </div>

        <ActionPanneau id="reel" nbEnCours={nbEnCours} onVoirRendus={onglet !== 'reels' ? () => changerOnglet('reels') : undefined}
          options={options} onOptions={() => setOptions(o => !o)} pret={pret} onLancer={() => void lancerPuisSuivre()}
          label={busy ? t('Envoi…') : t('Réaliser le reel')} detail={`~${t('{m} min', { m: minutes })}`} manque={manque} msg={err} />
      </aside>

      <section className="dz-galerie" ref={galerie} aria-label={t('Galerie')}>
        {onglet === 'formats' && (
          <HowItWorks cleMemoire="hiw:reel" reduit={reduit} onCommencer={commencer}
            hero={{ ...fichiers.hero, repli: '/vitrine/reel-w.webp' }} labelHero={t('Exemples de reels')}
            titre={t('Un brief, un reel monté')} texte={t('Décris la scène : les plans sont photographiés, animés avec le son, puis montés avec accroche et musique.')}
            etapes={[
              { titre: t('Choisis le format'), texte: t('Libre, ou un format tenu par le studio : saut de tenues, GRWM, balade, pépite.'), ...fichiers.etape(1) },
              { titre: t('Écris ton brief'), texte: t('Le lieu, l’ambiance, ce qui se passe ; une idée suffit pour commencer.'), ...fichiers.etape(2) },
              { titre: t('Reçois ton reel'), texte: t('Plans, clips et montage arrivent dans Mes reels, prêts à télécharger ou à retoucher.'), ...fichiers.hero, repli: '/vitrine/reel-w.webp' },
            ]} />
        )}
        <div ref={ancre} className="dz-ancre" aria-hidden />
        <BarreGalerie<'formats' | 'reels'> onglet={onglet} onOnglet={changerOnglet}
          onglets={[{ cle: 'formats', label: t('Formats'), n: formats.length + 1 }, { cle: 'reels', label: t('Mes reels'), n: visibles.length, enCours: nbEnCours }]} />

        {onglet === 'formats' ? (
          <div className="dz-grille" ref={centre.racine}>
            <Carte cle="libre" titre={t('Libre')} detail={t('Ton brief, ta structure')} lettre={t('Libre')}
              choisie={!preset} auCentre={false} survolPossible={survolPossible} reduit={reduit} onChoisir={() => setPreset('')} />
            {formats.map(p => (
              <Carte key={p.id} cle={p.id} titre={t(p.nom)} detail={t(p.texte).split(/[:.]/)[0]} fixe={`/vitrine/reels/${p.id}.webp`} video={`/vitrine/reels/${p.id}.mp4`}
                choisie={preset === p.id} auCentre={centre.cle === p.id} survolPossible={survolPossible} reduit={reduit} onChoisir={() => setPreset(p.id)} />
            ))}
          </div>
        ) : (
          <div className="dz-reels">
            {visibles.map(r => <CarteReel key={r.id} r={r} goMontage={goMontage}
              onRetirer={() => void fetch(`/api/reels/${r.id}`, { method: 'DELETE' }).then(json).then(() => setReels(x => x.filter(y => y.id !== r.id))).catch(e => setErr(String(e.message)))}
              onAnnuler={() => void fetch(`/api/reels/${r.id}/annuler`, { method: 'POST' }).then(json).then((n: Reel) => setReels(x => x.map(y => y.id === r.id ? n : y))).catch(e => setErr(String(e.message)))} />)}
            {!visibles.length && <div className="dz-etat"><b>{t('Aucun reel pour ce personnage.')}</b>
              <button type="button" className="pill" onClick={() => changerOnglet('formats')}>{t('Choisir un format')}</button></div>}
          </div>
        )}
      </section>
    </div>
  )
}

const ETAPES: Reel['etat'][] = ['redaction', 'photos', 'clips', 'export', 'fini']
const NOM_ETAPE: Record<string, string> = { redaction: 'Rédaction', photos: 'Photos', clips: 'Clips', export: 'Montage', fini: 'Prêt' }

function CarteReel({ r, goMontage, onRetirer, onAnnuler }: { r: Reel; goMontage: (id: string) => void; onRetirer: () => void; onAnnuler: () => void }) {
  // refaire un seul plan : sa photo reste, son clip est rendu à nouveau, le reel est remonté
  const [planRefait, setPlanRefait] = useState<number | null>(null)
  const [confirme, setConfirme] = useState<'annuler' | 'supprimer' | null>(null)
  const edition = useEdition()
  const enCours = r.etat !== 'fini' && r.etat !== 'echec'
  const [geste, setGeste] = useState('')
  const [errPlan, setErrPlan] = useState<string | null>(null)
  const refaire = async () => {
    if (planRefait === null) return
    setErrPlan(null)
    try {
      await json(await fetch(`/api/reels/${encodeURIComponent(r.id)}/plans/${planRefait}/refaire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motion: geste }) }))
      setPlanRefait(null)
    } catch (e) { setErrPlan(String((e as Error).message)) }
  }
  // un reel à preset passe par 'storyboard' (relecture) puis 'preset' (images et clips) : on l'affiche sur les mêmes étapes
  const etape = r.etat === 'storyboard' ? 'redaction' : r.etat === 'preset' ? (r.plans.some(p => p.clipJob) ? 'clips' : 'photos') : r.etat
  const idx = r.etat === 'echec' ? -1 : (etape as string) === 'montage' ? ETAPES.indexOf('export') : ETAPES.indexOf(etape as typeof ETAPES[number])
  const photos = r.plans.filter(p => p.photoUri).length, clips = r.plans.filter(p => p.clipUri).length
  const detail = (e: Reel['etat']) => e === 'photos' ? ` ${photos}/${r.plans.length || r.n}` : e === 'clips' ? ` ${clips}/${r.plans.length || r.n}` : ''
  return (
    <div className="carte-reel" style={{ display: 'grid', gridTemplateColumns: r.reelUri ? 'minmax(0, 1fr) 260px' : 'minmax(0, 1fr)', gap: 16, padding: 16, borderRadius: 16, background: 'var(--lv1)' }}>
      <div style={{ display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.accroche ? `« ${r.accroche} »` : r.brief}</div>
        {r.accroche && <div style={{ fontSize: 12, color: 'var(--faint)' }}>{r.brief}</div>}
        {r.etat === 'storyboard' && r.cases && <Storyboard r={r} />}
        <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: 12 }}>
          {ETAPES.map((e, k) => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, background: k < idx || r.etat === 'fini' ? 'var(--lv3)' : k === idx ? 'var(--accent)' : 'var(--lv2)',
              color: k === idx && r.etat !== 'fini' ? '#fff' : k <= idx ? 'var(--text)' : 'var(--faint)' }}>
              {k < idx || r.etat === 'fini' ? '✓ ' : ''}{t(NOM_ETAPE[e])}{k === idx ? detail(e) : ''}
              {k === idx && r.etat !== 'fini' && <span className="reel-loader" role="status" aria-label={t('en cours')} />}
            </span>
          ))}
          {r.etat === 'echec' && (r.erreur === 'annulé' ? <span style={{ color: 'var(--muted)' }}>{t('Annulé')}</span> : <span className="texte-erreur">{t('échec')} — {tServeur(r.erreur ?? '')}</span>)}
        </div>
        <div className="flex gap-2" style={{ overflowX: 'auto' }}>
          {(r.plans.length ? r.plans : Array.from({ length: r.n }, () => null)).map((p, i) => p?.supprime ? null : (
            <div key={i} title={p?.still ?? ''} style={{ width: 86, flex: 'none', aspectRatio: '9 / 16', borderRadius: 10, overflow: 'hidden', background: 'var(--lv2)', position: 'relative' }}>
              {p?.clipUri ? <video src={p.clipUri} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : p?.photoUri ? <img src={p.photoUri} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: .8 }} />
                : <div className="flex items-center justify-center" style={{ height: '100%', fontSize: 12, color: 'var(--faint)' }}>{t('plan {n}', { n: i + 1 })}</div>}
              {p && !p.clipUri && (p.photoEtat === 'rendering' || p.clipEtat === 'rendering' || p.clipEtat === 'queued-comfy') &&
                <span className="pastille-media" style={{ left: 4, bottom: 4 }}>{p.clipJob ? t('anime…') : t('photo…')}</span>}
              {/* contrôle du plan avant le rendu : ce que la réécriture n'a pas su corriger */}
              {p?.avertissements?.length ? <span title={p.avertissements.map(x => t(x)).join(' · ')}
                className="pastille-media" style={{ right: 4, top: 4, background: 'var(--attention)', color: 'var(--bg)' }}>⚠</span> : null}
              {p && (r.etat === 'fini' || r.etat === 'echec') && <button title={t('Refaire ce plan')} onClick={() => { setPlanRefait(i); setGeste(p.motion) }}
                style={{ position: 'absolute', left: 4, top: 4, fontSize: 12, width: 22, height: 22, border: 0, borderRadius: 6, cursor: 'pointer', color: '#fff', background: 'var(--voile)' }}>↻</button>}
            </div>
          ))}
        </div>
        {planRefait !== null && (
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Plan {n} : le mouvement à refaire, les autres plans ne bougent pas', { n: planRefait + 1 })}</span>
            <textarea value={geste} maxLength={300} rows={2} onChange={e => setGeste(e.target.value)}
              className="champ" style={{ fontSize: 12.5 }} />
            <div className="flex gap-2 items-center">
              <button className="pill tool" onClick={() => void refaire()}>↻ {t('Refaire ce plan')}</button>
              <button className="pill tool" onClick={() => setPlanRefait(null)}>{t('Annuler')}</button>
              {errPlan && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{errPlan}</span>}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          {r.montageId && <button className="pill tool" onClick={() => goMontage(r.montageId!)}>{t('Ouvrir dans le Montage')}</button>}
          {edition && (r.etat === 'fini' || r.etat === 'echec') && <button className="pill tool" title={t('Les photos et clips restent dans la bibliothèque')} onClick={onRetirer}>✕ {t('Retirer de la liste')}</button>}
          {edition && enCours && (confirme
            ? <>
                <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>{t('Arrêter ce reel ?')}</span>
                <button className="pill tool" onClick={() => { setConfirme(null); confirme === 'annuler' ? onAnnuler() : onRetirer() }}>{t('Oui')}</button>
                <button className="pill tool" onClick={() => setConfirme(null)}>{t('Non')}</button>
              </>
            : <>
                <button className="pill tool" title={t('Les rendus en file sont arrêtés ; ce qui est déjà fait reste dans la bibliothèque')} onClick={() => setConfirme('annuler')}>■ {t('Annuler')}</button>
                <button className="pill tool" title={t('Arrête le reel et le retire de la liste ; ce qui est déjà fait reste dans la bibliothèque')} onClick={() => setConfirme('supprimer')}>✕ {t('Supprimer')}</button>
              </>)}
        </div>
      </div>
      {r.reelUri && (
        <div style={{ display: 'grid', gap: 8 }}>
          <video src={r.reelUri} controls playsInline style={{ width: '100%', aspectRatio: '9 / 16', borderRadius: 12, background: '#000' }} />
          <a className="pill tool" style={{ justifyContent: 'center' }} href={r.reelUri} download={`reel-${r.id}.mp4`}>{t('Télécharger')}</a>
        </div>
      )}
    </div>
  )
}

/* Le storyboard d'un reel à preset, avant le tournage : chaque case écrite par le réalisateur
   se corrige (une tenue, le plat, l'accroche…), puis « Tourner » lance les images et les clips. */
function Storyboard({ r }: { r: Reel }) {
  const [cases, setCases] = useState(() => JSON.parse(JSON.stringify(r.cases ?? {})) as Record<string, unknown>)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const NOMS: Record<string, string> = { hook: 'Accroche', room: 'Pièce', outfits: 'Tenues', vanity: 'Coiffeuse', robe: 'Tenue de préparation', skin: 'Teint', eyes: 'Yeux', lips: 'Lèvres', final: 'Coiffure et bijoux',
    street: 'Rue', place: 'Lieu', outfit: 'Tenue', dish: 'Plat', drink: 'Boisson', shop: 'Vitrine', find: 'Trouvaille', view: 'Vue de fin', light: 'Lumière', music: 'Morceau' }
  const champ = (v: string, set: (x: string) => void) => <textarea className="pin" rows={2} value={v} onChange={e => set(e.target.value)} style={{ marginTop: 0, fontSize: 12.5 }} />
  const tourner = async () => {
    setBusy(true); setErr(null)
    try { await json(await fetch(`/api/reels/${encodeURIComponent(r.id)}/tourner`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cases }) })) }
    catch (e) { setErr(String((e as Error).message)) }
    setBusy(false)
  }
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 12, background: 'var(--lv2)' }}>
      <b style={{ fontSize: 12.5 }}>{t('Storyboard : relis et corrige, puis tourne')}</b>
      {Object.entries(cases).map(([k, v]) => (
        <label key={k} style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
          <span>{t(NOMS[k] ?? k)}</span>
          {typeof v === 'string' ? champ(v, x => setCases(c => ({ ...c, [k]: x })))
            : Array.isArray(v) && v.every(x => typeof x === 'string')
              ? (v as string[]).map((x, i) => <span key={i}>{champ(x, y => setCases(c => ({ ...c, [k]: (c[k] as string[]).map((z, j) => j === i ? y : z) })))}</span>)
              : <span style={{ color: 'var(--faint)' }}>{t('(case non modifiable)')}</span>}
        </label>
      ))}
      <div className="flex gap-2 items-center">
        <button className="cta" style={{ padding: '8px 16px', flexDirection: 'row' }} disabled={busy} onClick={() => void tourner()}>{busy ? '…' : `🎬 ${t('Tourner')}`}</button>
        {err && <span className="texte-erreur">{err}</span>}
      </div>
    </div>
  )
}
