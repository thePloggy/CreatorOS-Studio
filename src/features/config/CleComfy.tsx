/* Réglage « Comfy Cloud » : la clé du visiteur, gardée dans son navigateur. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { ecrireCleComfy, lireCleComfy } from '../../lib/comfyKey'

export function CleComfy() {
  const [cle, setCle] = useState(() => lireCleComfy())
  const [saisie, setSaisie] = useState('')
  return (
    <div className="border border-border rounded-card bg-surface2 p-4 max-w-[720px]">
      <div className="font-semibold text-[13px] mb-1">{t('Comfy Cloud — générer avec ta clé')}
        {' '}<span className="text-[12px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: 'rgba(240,180,60,.16)', color: '#f0b43c' }}>{t('expérimental')}</span></div>
      <p className="text-[12px] mb-2" style={{ lineHeight: 1.5, color: '#f0b43c' }}>
        {t('Pas encore vérifié de bout en bout : Comfy Cloud ne délivre de clé API qu’aux comptes payants. Sans clé, tes rendus passent sur la carte graphique de ce serveur, comme d’habitude.')}
      </p>
      <p className="text-[12px] text-muted mb-3" style={{ lineHeight: 1.5 }}>
        {t('Avec une clé Comfy Cloud, tes rendus tournent sur ton compte Comfy (tes crédits), pas sur la carte graphique de ce serveur. La clé reste dans ce navigateur ; elle accompagne chaque rendu jusqu’au serveur, qui ne l’enregistre ni ne la journalise.')}
      </p>
      {cle ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px]">{t('Clé enregistrée dans ce navigateur')} · <code>{cle.slice(0, 10)}…</code></span>
          <button className="pill" onClick={() => { ecrireCleComfy(null); setCle(null) }}>{t('Oublier la clé')}</button>
        </div>
      ) : null}
      {cle && <LorasCloud />}
      {cle ? null : (
        <form className="flex items-center gap-2 flex-wrap" onSubmit={e => { e.preventDefault(); const v = saisie.trim(); if (v) { ecrireCleComfy(v); setCle(v); setSaisie('') } }}>
          <input type="password" autoComplete="off" spellCheck={false} value={saisie} onChange={e => setSaisie(e.target.value)}
            placeholder="comfyui-…" className="bg-surface3 border border-border rounded px-2 py-1 text-[12px]" style={{ minWidth: 260 }} />
          <button className="pill" type="submit" disabled={!saisie.trim()}>{t('Utiliser cette clé')}</button>
          <a className="text-[12px] text-accent hover:underline" href="https://platform.comfy.org/login" target="_blank" rel="noreferrer">{t('Obtenir une clé')}</a>
        </form>
      )}
    </div>
  )
}

/* ---------- LoRA des personnages sur le compte Comfy Cloud ----------
   Comfy Cloud n'a pas les LoRA d'identité dans son catalogue : sans import,
   un rendu de personnage échoue sur « LoRA introuvable ». Un clic, et Comfy
   Cloud les télécharge lui-même depuis Civitai, sur le compte du visiteur. */
interface LoraCloud { persona: string; personaName: string; moteur: string; name: string; source: string | null; present: boolean }
interface Lance { name: string; status: string; task: string | null; error?: string }

async function poster<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || tServeur(d?.error) || `HTTP ${r.status}`)
  return d as T
}

function LorasCloud() {
  const [loras, setLoras] = useState<LoraCloud[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [suivi, setSuivi] = useState<Record<string, Lance>>({})
  const [occupe, setOccupe] = useState(false)
  const minuteur = useRef<number | null>(null)

  const relire = useCallback(async () => {
    try { setErreur(null); setLoras((await poster<{ loras: LoraCloud[] }>('/api/cloud/loras/etat')).loras) }
    catch (e) { setErreur(String((e as Error).message)) }
  }, [])
  useEffect(() => { void relire() }, [relire])

  /* Suivi des téléchargements lancés : un relevé toutes les 5 s, jusqu'à ce
     qu'aucun ne soit plus en cours ; l'état du compte est relu à la fin. */
  useEffect(() => {
    const enCours = Object.values(suivi).filter(l => l.task && ['created', 'running', 'pending', 'queued'].includes(l.status))
    if (!enCours.length) return
    minuteur.current = window.setTimeout(async () => {
      const maj: Record<string, Lance> = {}
      for (const l of enCours) {
        try {
          const d = await poster<{ status: string; error: string | null }>(`/api/cloud/taches/${encodeURIComponent(l.task!)}`)
          maj[l.name] = { ...l, status: d.status, error: d.error ?? undefined }
        } catch (e) { maj[l.name] = { ...l, status: 'failed', error: String((e as Error).message) } }
      }
      setSuivi(s => ({ ...s, ...maj }))
      if (Object.values(maj).every(l => !['created', 'running', 'pending', 'queued'].includes(l.status))) void relire()
    }, 5000)
    return () => { if (minuteur.current) window.clearTimeout(minuteur.current) }
  }, [suivi, relire])

  const importer = async () => {
    setOccupe(true); setErreur(null)
    try {
      const { lances } = await poster<{ lances: Lance[] }>('/api/cloud/loras/importer')
      setSuivi(Object.fromEntries(lances.map(l => [l.name, l])))
      if (lances.every(l => !l.task)) void relire()
    } catch (e) { setErreur(String((e as Error).message)) }
    finally { setOccupe(false) }
  }

  const manquantes = loras?.filter(l => !l.present) ?? []
  const libelle = (l: LoraCloud) => {
    const s = suivi[l.name]
    if (l.present) return { txt: t('sur le compte'), c: 'var(--ok, #4cc38a)' }
    if (!s) return { txt: l.source ? t('absente') : t('sans source connue'), c: 'var(--muted)' }
    if (s.status === 'completed') return { txt: t('importée'), c: 'var(--ok, #4cc38a)' }
    if (s.status === 'failed') return { txt: s.error ? t('échec : {e}', { e: tServeur(s.error) }) : t('échec'), c: 'var(--danger)' }
    if (s.status === 'sans-source') return { txt: t('sans source connue'), c: 'var(--muted)' }
    return { txt: t('téléchargement en cours…'), c: 'var(--attention)' }
  }

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border, rgba(127,127,127,.25))' }}>
      <div className="font-semibold text-[12.5px] mb-1">{t('LoRA des personnages sur ton compte')}</div>
      <p className="text-[12px] text-muted mb-2" style={{ lineHeight: 1.5 }}>
        {t('Comfy Cloud n’a pas les LoRA d’identité des personnages. Importe-les une fois : Comfy Cloud les télécharge lui-même depuis Civitai, sur ton compte.')}
      </p>
      {erreur && <div className="text-[12px] mb-2" style={{ color: 'var(--danger)' }}>{erreur}</div>}
      {!loras && !erreur && <div className="text-[12px] text-muted">{t('chargement…')}</div>}
      {loras && (
        <ul className="text-[12px] mb-2" style={{ lineHeight: 1.7 }}>
          {loras.map(l => { const e = libelle(l); return (
            <li key={`${l.persona}-${l.name}`} className="flex gap-2 flex-wrap">
              <b>{l.personaName}</b><span className="text-muted">{l.moteur === 'krea' ? 'Krea 2' : l.moteur === 'klein' ? 'Klein' : t('vidéo')}</span>
              <span style={{ color: e.c, marginLeft: 'auto' }}>{e.txt}</span>
            </li>) })}
        </ul>
      )}
      <div className="flex gap-2 flex-wrap items-center">
        <button className="pill" disabled={occupe || !loras || !manquantes.length} onClick={() => void importer()}>
          {manquantes.length ? t('Importer les {n} LoRA manquantes', { n: manquantes.length }) : t('Toutes les LoRA sont sur ton compte')}
        </button>
        <button className="pill" disabled={occupe} onClick={() => void relire()}>{t('Actualiser')}</button>
      </div>
    </div>
  )
}
