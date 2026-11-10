/* ============================================================
   v2 — "machine" indicator: health of the render machine.
   Green = healthy, orange = warnings, red = a render will fail.
   Click opens the list: what is wrong and what to do.
   Reads /api/diagnostic (server-side check, read-only).
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, tp, getLang } from '../i18n'
import { journalBug } from '../lib/journalBug'

interface Probleme { gravite: 'bloquant' | 'alerte'; domaine: string; quoi: string; conseil: string }
interface Diag { quand: number; dureeMs: number; ok: boolean; bloquants: number; alertes: number; problemes: Probleme[]; infos: Record<string, string | number>
  liaison?: { etat: 'ok' | 'redemarre' | 'panne'; revenuLe: number | null; coupureMs: number | null; bilan: { quand: number; ok: boolean; bloquants: number; alertes: number } | null } }

interface Allegement { profil: number; source: string; vramGo: number | null; variantes: { de: string; vers: string; pour: number; utile: boolean; installee: boolean }[] }
const court = (f: string) => f.replace(/\.(safetensors|gguf)$/, '')

export function VoyantMachine() {
  const [d, setD] = useState<Diag | null>(null)
  const [injoignable, setInjoignable] = useState(false)
  const [ouvert, setOuvert] = useState(false)
  const [enCours, setEnCours] = useState(false)
  const [copie, setCopie] = useState(false)
  const [allege, setAllege] = useState<Allegement | null>(null)
  const boite = useRef<HTMLSpanElement>(null)

  const lire = useCallback(async (frais = false) => {
    try {
      const r = await fetch(`/api/diagnostic${frais ? '?frais=1' : ''}`, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) throw new Error(String(r.status))
      setD(await r.json()); setInjoignable(false)
    } catch { setInjoignable(true) }
  }, [])
  useEffect(() => {
    void lire()
    const iv = setInterval(() => void lire(), 20_000)   // the server caches its check for 2 min: cheap to read
    return () => clearInterval(iv)
  }, [lire])
  // small card: lightweight weights used instead of heavy models (read on open)
  useEffect(() => {
    if (!ouvert) return
    fetch('/api/machine/allegement').then(r => r.ok ? r.json() : null).then(setAllege, () => setAllege(null))
  }, [ouvert])
  // click outside closes
  useEffect(() => {
    if (!ouvert) return
    const cb = (e: MouseEvent) => { if (!boite.current?.contains(e.target as Node)) setOuvert(false) }
    document.addEventListener('mousedown', cb)
    return () => document.removeEventListener('mousedown', cb)
  }, [ouvert])

  const redemarre = d?.liaison?.etat === 'redemarre'
  const revenu = d?.liaison?.revenuLe && Date.now() - d.liaison.revenuLe < 600_000 ? d.liaison : null
  const couleur = injoignable ? 'var(--danger)' : !d ? 'var(--faint)' : redemarre ? 'var(--warn, #ffb648)' : d.bloquants ? 'var(--danger)' : d.alertes ? 'var(--warn, #ffb648)' : 'var(--positif)'
  const titre = injoignable ? t('serveur injoignable') : !d ? t('contrôle en cours…') : redemarre ? t('ComfyUI redémarre…')
    : d.bloquants ? tp(d.bloquants, '{n} problème bloquant', '{n} problèmes bloquants')
      : d.alertes ? tp(d.alertes, '{n} alerte', '{n} alertes') : t('machine saine')
  const loc = getLang() === 'en' ? 'en-GB' : 'fr-FR'
  const relancer = async () => { setEnCours(true); await lire(true); setEnCours(false) }

  return (
    <span ref={boite} style={{ position: 'relative' }}>
      <button onClick={() => setOuvert(o => !o)} title={t('machine — {x} (cliquer pour le détail)', { x: titre })}
        className="flex items-center gap-1.5"
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: d && (d.bloquants || d.alertes) ? couleur : 'inherit', font: 'inherit' }}>
        <i style={{ width: 7, height: 7, borderRadius: 99, background: couleur, display: 'inline-block' }} /> <span className="masquer-etroit">{t('machine')}</span>
        {redemarre && <span style={{ color: couleur }}>{t('redémarre…')}</span>}
        {d && (d.bloquants + d.alertes > 0) && <b style={{ fontWeight: 600 }}>{d.bloquants + d.alertes}</b>}
      </button>
      {ouvert && (
        <div style={{ position: 'absolute', right: 0, top: 22, width: 460, maxHeight: '70vh', overflowY: 'auto', zIndex: 60,
          background: 'var(--lv2)', border: '1px solid var(--lv4)', borderRadius: 12, padding: 14, boxShadow: '0 12px 40px #0009', color: 'var(--text)' }}>
          <div className="flex items-center gap-2 mb-2">
            <b className="text-[13px]">{t('Machine de rendu — {x}', { x: titre })}</b>
            <button className="pill ml-auto" style={{ fontSize: 12, padding: '4px 10px' }} title={t('Copie un journal sans données privées, à coller dans une issue GitHub')}
              onClick={() => void journalBug().then(x => navigator.clipboard?.writeText(x)).then(() => setCopie(true), () => setCopie(false))}>
              {copie ? t('✓ copié') : t('📋 journal pour un bug')}
            </button>
            <button className="pill" style={{ fontSize: 12, padding: '4px 10px' }} disabled={enCours} onClick={() => void relancer()}>
              {enCours ? t('contrôle…') : t('↻ recontrôler')}
            </button>
          </div>
          {revenu && (
            <div className="text-[12px]" style={{ color: 'var(--muted)', margin: '4px 0 8px' }}>
              {t('ComfyUI a redémarré à {h}', { h: new Date(revenu.revenuLe!).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }) })}
              {revenu.coupureMs ? t(' (coupure de {n} s)', { n: Math.round(revenu.coupureMs / 1000) }) : ''} — {t('bilan :')} {!revenu.bilan ? t('contrôle en cours…')
                : revenu.bilan.bloquants || revenu.bilan.alertes ? t('{b} bloquant(s), {a} alerte(s)', { b: revenu.bilan.bloquants, a: revenu.bilan.alertes }) : t('rien à signaler')}
            </div>
          )}
          {allege && allege.profil < 24 && (
            <div className="text-[12px]" style={{ borderLeft: '3px solid var(--lv4)', padding: '5px 0 5px 10px', margin: '8px 0', color: 'var(--muted)' }}>
              <div style={{ color: 'var(--text)' }}>{t('Profil {n} Go', { n: allege.profil })}{allege.vramGo ? t(' (carte de {n} Go)', { n: allege.vramGo }) : ''} — {t('poids légers à la place des modèles lourds, mêmes recettes')}</div>
              {allege.variantes.filter(v => v.utile).map(v => (
                <div key={v.vers}>{v.installee ? '✓' : '✗'} {court(v.de)} → {court(v.vers)}</div>
              ))}
              {allege.variantes.some(v => v.utile && !v.installee) && <div style={{ marginTop: 2 }}>→ {t('les installer : npm run setup -- --vram {n}', { n: allege.profil })}</div>}
            </div>
          )}
          {d?.problemes.map((p, i) => (
            <div key={i} style={{ borderLeft: `3px solid ${p.gravite === 'bloquant' ? 'var(--danger)' : 'var(--warn, #ffb648)'}`, padding: '5px 0 5px 10px', margin: '8px 0' }}>
              <div className="text-[12px]"><span style={{ color: 'var(--muted)' }}>{p.domaine} — </span>{p.quoi}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)', marginTop: 2 }}>→ {p.conseil}</div>
            </div>
          ))}
          {d && !d.problemes.length && <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{t('Rien à signaler : pilote, Python, ComfyUI, recettes, Ollama, disque et livraison sont en ordre.')}</div>}
          {d && (
            <div className="text-[12px]" style={{ color: 'var(--faint)', marginTop: 10, lineHeight: 1.6 }}>
              {Object.entries(d.infos).map(([k, v]) => <div key={k}>{k} : {String(v)}</div>)}
              <div>{t('contrôlé à {h} en {s} s', { h: new Date(d.quand).toLocaleTimeString(loc), s: (d.dureeMs / 1000).toFixed(1) })}</div>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
