/* Recipe review: what the UI drives in this graph, what is declared in the
   sibling `<recipe>.pilotage.json` file, what stays fixed, and what is
   missing on the machine. Read-only: no render, no write.
   Source: GET /api/workflows/:file/revue. */
import { useState } from 'react'
import { t, tp, tServeur } from '../../i18n'

interface Ligne { noeud: string; classe: string; entree: string; avant?: string; apres?: string; ok?: boolean; pourquoi?: string; cle?: string }
interface Revue {
  noeuds: number; pilotes: Ligne[]; declares: Ligne[]; declaration: string | null; nonInjecte: string[]
  noeudsAbsents: string[]; valeursAbsentes: Ligne[]; erreur?: string; exemple: string
}

export function RecetteRevue({ file }: { file: string }) {
  const [r, setR] = useState<Revue | null>(null)
  const [etat, setEtat] = useState<'ferme' | 'charge' | 'ouvert'>('ferme')
  const [err, setErr] = useState<string | null>(null)
  const lire = async () => {
    setEtat('charge'); setErr(null)
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(file)}/revue`)
      const d = await res.json()
      if (!res.ok) throw new Error(tServeur(d.error) ?? `HTTP ${res.status}`)
      setR(d); setEtat('ouvert')
    } catch (e) { setErr(String((e as Error).message || e)); setEtat('ferme') }
  }
  const T = ({ children }: { children: React.ReactNode }) => <div className="text-[12px] font-semibold mt-3 mb-1">{children}</div>
  const L = ({ l, ton }: { l: Ligne; ton?: string }) => (
    <div className="font-mono text-[12px] leading-relaxed" style={{ color: ton }}>
      {l.cle ? `${l.cle} → ` : ''}#{l.noeud} {l.classe}.{l.entree}{l.apres !== undefined ? ` : ${l.avant} → ${l.apres}` : ''}{l.pourquoi ? ` — ${l.pourquoi}` : ''}
    </div>
  )
  return (
    <div className="text-[12px] border border-border rounded-card bg-surface p-3 mt-3">
      <div className="flex items-center gap-2">
        <b>{t('Revue de la recette')}</b>
        <span className="text-faint">{t("ce que l'interface pilote, ce qui manque")}</span>
        <button className="ml-auto underline text-faint" onClick={() => (etat === 'ouvert' ? setEtat('ferme') : void lire())}>
          {etat === 'charge' ? t('lecture…') : etat === 'ouvert' ? t('fermer') : t('lancer la revue')}
        </button>
      </div>
      {err && <div className="text-alert mt-2">{err}</div>}
      {etat === 'ouvert' && r && (
        <div>
          {r.erreur && <div className="text-alert mt-2">{t("L'injection d'essai a échoué : {e}", { e: r.erreur })}</div>}
          <T>{tp(r.pilotes.length, 'Piloté par le câblage — {n} entrée sur {m} nœuds', 'Piloté par le câblage — {n} entrées sur {m} nœuds', { m: r.noeuds })}</T>
          {r.pilotes.length ? r.pilotes.map((l, i) => <L key={i} l={l} />) : <div className="text-faint">{t("rien : cette recette part telle qu'elle est écrite")}</div>}
          {r.nonInjecte.length > 0 && (<><T>{t('Non injecté')}</T>{r.nonInjecte.map((x, i) => <div key={i} className="text-warn">{x}</div>)}</>)}
          <T>{t('Déclaré dans {f}', { f: r.declaration ?? `${file.replace(/\.json$/, '')}.pilotage.json` })}</T>
          {r.declares.length
            ? r.declares.map((l, i) => <L key={i} l={l} ton={l.ok ? undefined : '#f05548'} />)
            : <div className="text-faint">{t('aucune déclaration. Pour imposer une entrée, crée ce fichier à côté de la recette, par exemple :')}
                <pre className="font-mono text-[12px] mt-1 whitespace-pre-wrap">{r.exemple}</pre></div>}
          <T>{t('Sur la machine')}</T>
          {r.noeudsAbsents.length === 0 && r.valeursAbsentes.length === 0
            ? <div style={{ color: '#5fd38d' }}>{t('tous les nœuds et tous les fichiers nommés sont présents')}</div>
            : <>
              {r.noeudsAbsents.map(n => <div key={n} className="text-alert">{t('nœud absent de ComfyUI : {n}', { n })}</div>)}
              {r.valeursAbsentes.map((l, i) => <L key={i} l={l} ton="#f05548" />)}
            </>}
        </div>
      )}
    </div>
  )
}
