/* Modèles optionnels : MiniMax H3. Le studio ne fournit pas ses poids (licence) ;
   le propriétaire d'une installation locale les envoie ici, fichier par fichier. */
import { useEffect, useState } from 'react'
import { t } from '../../i18n'
import { lireCleProprietaire, useEdition } from '../../lib/proprietaire'
import { useAppStore } from '../../store/useAppStore'

interface Etat { demo: boolean; installe: boolean; disponible: boolean; licence: string; territoiresExclus: string[]
  fichiers: { nom: string; dossier: string; role: string; present: boolean }[] }

export function ModelesOptionnels() {
  const edition = useEdition()
  const [etat, setEtat] = useState<Etat | null>(null)
  const [accepte, setAccepte] = useState(false)
  const [envoi, setEnvoi] = useState<{ nom: string; pct: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const charger = () => void fetch('/api/modeles/h3').then(r => r.json()).then((e: Etat) => { setEtat(e); useAppStore.setState({ h3: { demo: e.demo, installe: e.installe, disponible: e.disponible } }) }).catch(() => setMsg(t('état indisponible')))
  useEffect(charger, [])

  const envoyer = (nom: string, f: File) => {
    if (f.name !== nom) { setMsg(t('Ce n’est pas le bon fichier : {n} attendu.', { n: nom })); return }
    setMsg(null); setEnvoi({ nom, pct: 0 })
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/modeles/h3/${encodeURIComponent(nom)}`)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    x.setRequestHeader('X-Licence-H3', 'acceptee')
    const cle = lireCleProprietaire(); if (cle) x.setRequestHeader('X-Owner-Key', cle)
    x.upload.onprogress = e => { if (e.lengthComputable) setEnvoi({ nom, pct: Math.round(e.loaded / e.total * 100) }) }
    x.onload = () => { setEnvoi(null); if (x.status >= 300) setMsg((() => { try { return JSON.parse(x.responseText).error } catch { return `HTTP ${x.status}` } })()); charger() }
    x.onerror = () => { setEnvoi(null); setMsg(t('envoi interrompu')) }
    x.send(f)
  }

  if (!etat) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>{msg ?? '…'}</p>
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 720, fontSize: 13, lineHeight: 1.55 }}>
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>MiniMax H3 {etat.disponible && <span style={{ color: 'var(--positif)', fontSize: 12 }}>· {t('prêt')}</span>}</h3>
        <p style={{ color: 'var(--muted)', margin: 0 }}>{t('Moteur vidéo avec son, le plus fluide. Le studio est déjà câblé : il ne manque que ses poids, que nous ne pouvons pas fournir.')}</p>
      </div>
      {etat.demo ? (
        <p style={{ padding: 12, borderRadius: 12, background: 'var(--lv2)', margin: 0 }}>
          {t('Indisponible sur cette démo : elle est hébergée dans l’Union européenne, que la licence MiniMax H3 exclut. Installe la version GitHub chez toi, si ta région est autorisée, pour en profiter.')}
        </p>
      ) : (<>
        <p style={{ padding: 12, borderRadius: 12, background: 'var(--lv2)', margin: 0 }}>
          {t('La licence MiniMax H3 n’accorde aucun droit dans ces territoires : {l}. Vérifie qu’elle te permet de l’utiliser avant d’envoyer les poids.', { l: etat.territoiresExclus.join(', ') })}{' '}
          <a href={etat.licence} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{t('Lire la licence')}</a>
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={accepte} onChange={e => setAccepte(e.target.checked)} /> {t('J’ai lu la licence et ma région n’en est pas exclue.')}
        </label>
        <div style={{ display: 'grid', gap: 6 }}>
          {etat.fichiers.map(f => (
            <div key={f.nom} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 10, background: 'var(--lv1)' }}>
              <span style={{ color: f.present ? 'var(--positif)' : 'var(--faint)' }}>{f.present ? '✓' : '○'}</span>
              <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600 }}>{t(f.role)}</b><br /><code style={{ fontSize: 12, color: 'var(--muted)' }}>{f.dossier}/{f.nom}</code></span>
              {envoi?.nom === f.nom ? <span>{envoi.pct} %</span>
                : !f.present && <label className="pill" style={{ cursor: accepte && edition && !envoi ? 'pointer' : 'not-allowed', opacity: accepte && edition && !envoi ? 1 : .45 }}>
                  {t('Envoyer')}<input type="file" accept=".safetensors" className="hidden" disabled={!accepte || !edition || !!envoi}
                    onChange={e => { const x = e.target.files?.[0]; if (x) envoyer(f.nom, x) }} /></label>}
            </div>
          ))}
        </div>
        {!edition && <p style={{ color: 'var(--muted)', margin: 0 }}>{t('Réservé au propriétaire du studio.')}</p>}
        <p style={{ color: 'var(--faint)', margin: 0, fontSize: 12 }}>{t('Tu peux aussi copier ces fichiers toi-même dans les dossiers de modèles de ComfyUI : le studio les voit au prochain passage.')}</p>
      </>)}
      {msg && <p style={{ color: 'var(--danger)', margin: 0 }}>{msg}</p>}
    </div>
  )
}
