/* ============================================================
   « Éditer » une vidéo : deux façons de dire quoi changer.
   · Pinceau — on peint la zone sur la première image (outil Pinceau).
   · Au prompt — on nomme l'élément (« dress ») et ce qu'il devient ;
     SAM3 le trouve et le suit sur tout le clip, la zone est redessinée,
     le reste de la vidéo reste celui de la source.
   Styles en ligne : partagé bureau et mobile.
   ============================================================ */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import type { Asset } from '../types'
import { t, tServeur } from '../i18n'

const champ: React.CSSProperties = {
  padding: '9px 11px', borderRadius: 10, font: 'inherit', fontSize: 13.5, color: 'inherit', width: '100%',
  background: 'rgba(127,127,127,0.12)', border: '1px solid rgba(127,127,127,0.3)',
}
const choix: React.CSSProperties = {
  display: 'grid', gap: 3, textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer', font: 'inherit',
  color: 'inherit', background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.25)',
}
const bouton: React.CSSProperties = { padding: '8px 14px', borderRadius: 10, border: 0, font: 'inherit', fontSize: 13, cursor: 'pointer', background: '#24262c', color: '#e8e9ec' }

export function EditionVideo({ asset, onClose, onPinceau }: { asset: Asset; onClose: () => void; onPinceau: () => void }) {
  const [mode, setMode] = useState<'choix' | 'prompt'>('choix')
  const [cible, setCible] = useState('')
  // modifier un élément, le retirer, ou changer le fond autour de la personne
  const [op, setOp] = useState<'modifier' | 'retirer' | 'fond' | 'detourer'>('modifier')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const adopter = useAppStore(s => s.adoptServerJob)
  const pret = op === 'detourer' ? true : op === 'retirer' ? !!cible.trim() : op === 'fond' ? !!prompt.trim() : !!(cible.trim() && prompt.trim())

  const lancer = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/edit-video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: op, cible: cible.trim(), prompt: prompt.trim() }) })
      const d = await r.json().catch(() => ({})) as { jobId?: string; error?: string }
      if (!r.ok || !d.jobId) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      await adopter(d.jobId)
      onClose()
    } catch (e) { setErr(String((e as Error).message || e)) }
    setBusy(false)
  }

  return createPortal(
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(6,7,9,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={t('Éditer la vidéo')} onClick={e => e.stopPropagation()}
        style={{ width: 'min(460px, 100%)', borderRadius: 16, padding: 18, background: '#14161a', color: '#e8e9ec',
          border: '1px solid rgba(127,127,127,.25)', boxShadow: '0 24px 60px rgba(0,0,0,.55)', fontSize: 13.5, lineHeight: 1.5, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <b style={{ fontSize: 15 }}>{t('Éditer la vidéo')}</b>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label={t('fermer')} style={{ border: 0, background: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer', opacity: .6 }}>×</button>
        </div>
        {mode === 'choix' ? (<>
          <button style={choix} onClick={() => { onClose(); onPinceau() }}>
            <b>{t('🖌 Pinceau')}</b>
            <span style={{ fontSize: 12, opacity: .7 }}>{t('peindre une zone sur la première image et la refaire sur tout le clip')}</span>
          </button>
          <button style={choix} onClick={() => setMode('prompt')}>
            <b>{t('✎ Au prompt')}</b>
            <span style={{ fontSize: 12, opacity: .7 }}>{t('nommer un élément de la vidéo et dire ce qu’il devient ; il est retrouvé et suivi sur tout le clip')}</span>
          </button>
        </>) : (<>
          <div style={{ display: 'flex', gap: 6 }}>
            {/* « Retirer » (30/10) : IC-LoRA LTX-2.5 Clean-Plate, le décor reconstruit derrière (cf. enqueueCleanPlate) */}
            {([['modifier', t('Modifier')], ['retirer', t('Retirer')], ['fond', t('Changer le fond')], ['detourer', t('Fond vert')]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setOp(k)} style={{ ...bouton, flex: 1, padding: '7px 8px', fontSize: 12.5,
                background: op === k ? 'rgba(168,85,247,.28)' : 'rgba(127,127,127,.12)', border: op === k ? '1px solid #a855f7' : '1px solid transparent' }}>{l}</button>
            ))}
          </div>
          {op !== 'fond' && op !== 'detourer' && <label style={{ display: 'grid', gap: 4, fontSize: 12, opacity: .85 }}>{op === 'retirer' ? t('Ce qui doit disparaître (en anglais)') : t('Élément à modifier (en anglais, un nom court)')}
            <input style={champ} autoFocus maxLength={80} value={cible} placeholder={op === 'retirer' ? 'people, cars, the woman in the yellow raincoat…' : 'dress, sunglasses, hair, car…'} onChange={e => setCible(e.target.value)} />
          </label>}
          {op !== 'detourer' && <label style={{ display: 'grid', gap: 4, fontSize: 12, opacity: .85 }}>{op === 'retirer' ? t('Le décor, en quelques mots (facultatif, en anglais)') : op === 'fond' ? t('Le nouveau décor (en anglais)') : t('Ce qu’il devient (en anglais)')}
            <textarea style={{ ...champ, minHeight: 70, resize: 'vertical' }} maxLength={400} value={prompt}
              placeholder={op === 'retirer' ? 'a rainy city street at dusk, neon signs, wet asphalt' : op === 'fond' ? 'a sunny beach with turquoise water and palm trees' : 'a red silk slip dress with thin straps'} onChange={e => setPrompt(e.target.value)} />
          </label>}
          {op === 'detourer' && <span style={{ fontSize: 11.5, opacity: .6 }}>{t('La personne est suivie image par image et tout le reste passe sur fond vert, prêt pour un montage. Rien n’est redessiné.')}</span>}
          {op === 'retirer' && <span style={{ fontSize: 11.5, opacity: .6 }}>{t('Personnes, passants ou véhicules disparaissent et le décor est reconstruit derrière, son d’origine gardé (LTX-2.5 + IC-LoRA Clean-Plate). Environ 2 min.')}</span>}
          {op === 'fond' && <span style={{ fontSize: 11.5, opacity: .6 }}>{t('La personne est retrouvée et suivie ; tout le reste de l’image est redessiné. Le mouvement de caméra reste celui du clip.')}</span>}
          <span style={{ fontSize: 11.5, opacity: .6 }}>{t('L’élément doit être visible dans la vidéo : l’édition le transforme, elle n’ajoute pas un objet absent. Clips de 10 s au plus.')}</span>
          {err && <span style={{ fontSize: 12, color: '#f08a7e' }}>{err}</span>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...bouton, background: 'transparent', opacity: .75 }} onClick={() => setMode('choix')} disabled={busy}>{t('‹ Retour')}</button>
            <span style={{ flex: 1 }} />
            <button style={{ ...bouton, background: 'linear-gradient(90deg,#f24d8a,#a855f7)', color: '#fff', fontWeight: 600, opacity: pret ? 1 : .5 }}
              disabled={busy || !pret} onClick={() => void lancer()}>{busy ? '…' : t('Lancer l’édition')}</button>
          </div>
        </>)}
      </div>
    </div>, document.body)
}
