/* ============================================================
   Importer sa propre LoRA (.safetensors) depuis un sélecteur de LoRA.

   Le fichier part en flux vers POST /api/persona/lora (route réservée au
   propriétaire : le serveur refuse un visiteur de la démo publique). Le
   serveur vérifie l'en-tête safetensors et lit l'architecture ; le catalogue
   est rechargé, et la LoRA apparaît dans la liste si elle agit sur le moteur
   en cours.

   Sur la démo publique, pas de bouton : une note explique que l'import marche
   en local mais qu'il est coupé ici (fichier inconnu sur une machine partagée).
   Partagé bureau / mobile : styles en ligne, couleurs héritées.
   ============================================================ */
import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useEdition } from '../lib/proprietaire'
import { t, tServeur } from '../i18n'
import { Ic } from '../v2/bits'

/** Envoi en flux avec progression : fetch n'en donne pas sur un envoi. */
export function deposerLora(f: File, remplacer: boolean, progres: (p: number) => void) {
  return new Promise<{ nom: string; arch?: string }>((ok, ko) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/persona/lora?nom=${encodeURIComponent(f.name)}${remplacer ? '&remplacer=1' : ''}`)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    // XHR ne passe pas par le fetch patché : la clé du propriétaire est ajoutée ici
    try { const cle = localStorage.getItem('creatoros.ownerKey'); if (cle) x.setRequestHeader('X-Owner-Key', cle) } catch { /* stockage indisponible */ }
    x.upload.onprogress = e => { if (e.lengthComputable) progres(e.loaded / e.total) }
    x.onload = () => {
      let r: { nom?: string; error?: string; lora?: { arch?: string } | null } = {}
      try { r = JSON.parse(x.responseText) } catch { /* réponse vide */ }
      if (x.status === 409) ko(Object.assign(new Error(tServeur(r.error) ?? t('existe déjà')), { existe: true }))
      else if (x.status >= 400 || !r.nom) ko(new Error(tServeur(r.error) ?? `HTTP ${x.status}`))
      else ok({ nom: r.nom, arch: r.lora?.arch })
    }
    x.onerror = () => ko(new Error(t('connexion coupée')))
    x.send(f)
  })
}

const bouton: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8, font: 'inherit', fontSize: 12.5, cursor: 'pointer',
  color: 'inherit', background: 'rgba(127,127,127,0.14)', border: '1px dashed rgba(127,127,127,0.45)',
}

export function ImportLora({ compatible, onAjout, style }: {
  /** La LoRA importée agit-elle sur le moteur en cours ? (lu dans l'en-tête du fichier) */
  compatible?: (l: { name: string; arch?: string }) => boolean
  /** Appelé quand la LoRA est compatible : le sélecteur peut la cocher d'office. */
  onAjout?: (nom: string) => void
  style?: React.CSSProperties
}) {
  const edition = useEdition()
  const loadLoras = useAppStore(st => st.loadLoras)
  const champ = useRef<HTMLInputElement>(null)
  const [envoi, setEnvoi] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ texte: string; ko?: boolean } | null>(null)
  const [enAttente, setEnAttente] = useState<File | null>(null)   // même nom déjà présent : remplacer ?

  if (!edition) return (
    <p style={{ fontSize: 12, opacity: 0.75, margin: '8px 0', lineHeight: 1.45, ...style }}>
      🔒 {t('Pour la sécurité de tous, l’import de LoRA est coupé sur cette démo publique. Installe le studio chez toi pour importer tes propres LoRA.')}{' '}
      <a href="https://github.com/thePloggy/CreatorOS-Studio" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{t('Installer CreatorOS Studio')}</a>
    </p>
  )

  const envoyer = async (f: File, remplacer = false) => {
    setMsg(null); setEnAttente(null); setEnvoi(0)
    try {
      const { nom, arch } = await deposerLora(f, remplacer, setEnvoi)
      await loadLoras()
      const ok = compatible ? compatible({ name: nom, arch }) : true
      if (ok) onAjout?.(nom)
      setMsg(ok
        ? { texte: t('« {nom} » ajoutée{arch}.', { nom: nom.replace(/\.safetensors$/, ''), arch: arch ? ` (${arch})` : '' }) }
        : { texte: t('« {nom} » ajoutée, mais elle vise {arch} : elle n’agit pas sur ce moteur. Tu la retrouveras avec le bon moteur.', { nom: nom.replace(/\.safetensors$/, ''), arch: arch ?? t('une architecture inconnue') }), ko: true })
    } catch (e) {
      if ((e as { existe?: boolean }).existe) setEnAttente(f)
      else setMsg({ texte: (e as Error).message, ko: true })
    } finally { setEnvoi(null) }
  }

  return (
    <div style={{ margin: '8px 0', ...style }}>
      <input ref={champ} type="file" accept=".safetensors" hidden
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void envoyer(f) }} />
      <button type="button" style={bouton} disabled={envoi !== null} onClick={() => champ.current?.click()}>
        {envoi !== null ? t('Envoi… {p} %', { p: Math.round(envoi * 100) }) : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Ic n="upload" s={14} />{t('Importer une LoRA (.safetensors)')}</span>}
      </button>
      {enAttente && (
        <div style={{ fontSize: 12, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{t('« {nom} » existe déjà.', { nom: enAttente.name })}</span>
          <button type="button" style={{ ...bouton, padding: '3px 9px', borderStyle: 'solid' }} onClick={() => void envoyer(enAttente, true)}>{t('Remplacer')}</button>
          <button type="button" style={{ ...bouton, padding: '3px 9px', borderStyle: 'solid' }} onClick={() => setEnAttente(null)}>{t('Annuler')}</button>
        </div>
      )}
      {msg && <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85, color: msg.ko ? '#e8a23a' : undefined }}>{msg.texte}</div>}
    </div>
  )
}
