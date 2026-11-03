/* ============================================================
   Éditeur du personnage — nom, mot déclencheur, description, préambule
   d'identité, LoRA photo et vidéo, dépôt d'une LoRA d'identité.

   Une seule source : persona.json côté serveur (PUT /api/persona). Partagé
   par la vue Personnage du bureau et l'atelier mobile : styles en ligne et
   couleurs héritées, pour tenir dans les deux thèmes sans dépendre de l'un.
   ============================================================ */
import { useEffect, useState } from 'react'
import { ChoixVoix } from '../v2/ChoixVoix'
import { useAppStore } from '../store/useAppStore'
import { t, tServeur } from '../i18n'
import { useEdition } from '../lib/proprietaire'
import { Verrouille } from '../features/config/CleProprietaire'

interface LoraRef { name: string; strength: number }
interface Persona {
  name: string | null; trigger: string; description: string; preamble?: string
  loras: LoraRef[]; lorasKlein?: LoraRef[]; videoLoras: LoraRef[]; figes?: string[]; voix?: string | null
}
interface LoraDispo { name: string; arch?: string; bytes?: number | null }

const champ: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, font: 'inherit', fontSize: 13,
  color: 'inherit', background: 'rgba(127,127,127,0.10)', border: '1px solid rgba(127,127,127,0.30)',
}
const bouton: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8, font: 'inherit', fontSize: 12.5, cursor: 'pointer',
  color: 'inherit', background: 'rgba(127,127,127,0.14)', border: '1px solid rgba(127,127,127,0.30)',
}
const etiquette: React.CSSProperties = { display: 'block', fontSize: 12, opacity: 0.7, margin: '12px 0 4px' }
const mo = (o?: number | null) => (o ? t('{n} Mo', { n: Math.round(o / 1e6) }) : '')

/** Envoi en flux avec progression : fetch n'en donne pas sur un envoi. */
function deposer(f: File, remplacer: boolean, progres: (p: number) => void) {
  return new Promise<{ nom: string; arch?: string }>((ok, ko) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/persona/lora?nom=${encodeURIComponent(f.name)}${remplacer ? '&remplacer=1' : ''}`)
    x.setRequestHeader('Content-Type', 'application/octet-stream')
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

function ListeLoras({ titre, aide, liste, dispo, onChange, garde }: {
  titre: string; aide: string; liste: LoraRef[]; dispo: LoraDispo[]; onChange: (l: LoraRef[]) => void
  /** Architectures acceptées par cette liste (Krea 2, Klein…) ; absente = toutes. */
  garde?: (arch: string) => boolean
}) {
  const [envoi, setEnvoi] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // la bibliothèque du modèle : seulement les LoRA de son architecture (ou non reconnues)
  const libres = dispo.filter(d => !liste.some(l => l.name === d.name) && (!garde || garde(d.arch ?? 'inconnue')))

  async function televerser(f: File, remplacer = false): Promise<void> {
    setMsg(null); setEnvoi(0)
    try {
      const { nom, arch } = await deposer(f, remplacer, setEnvoi)
      if (!liste.some(l => l.name === nom)) onChange([...liste, { name: nom, strength: 1 }])
      if (garde && arch && !garde(arch)) { setMsg(t('« {nom} » déposée, mais elle semble entraînée pour un autre modèle ({arch}) : vérifie la liste.', { nom, arch })); return }
      setMsg(t('« {nom} » déposée — pense à enregistrer.', { nom }))
    } catch (e) {
      if ((e as { existe?: boolean }).existe && confirm(t('« {nom} » existe déjà. La remplacer ?', { nom: f.name }))) return televerser(f, true)
      setMsg(t('refusée : {e}', { e: (e as Error).message }))
    } finally { setEnvoi(null) }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{titre}</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>{aide}</div>
      {liste.length === 0 && <div style={{ fontSize: 12, opacity: 0.5, margin: '6px 0' }}>{t('aucune')}</div>}
      {liste.map((l, i) => (
        <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>{l.name}</span>
          <input type="range" min={0} max={150} value={Math.round(l.strength * 100)} style={{ width: 110 }}
            onChange={e => onChange(liste.map((x, j) => j === i ? { ...x, strength: Number(e.target.value) / 100 } : x))} />
          <span style={{ width: 34, fontSize: 12, textAlign: 'right' }}>{l.strength.toFixed(2)}</span>
          <button style={{ ...bouton, padding: '4px 8px' }} aria-label={t('retirer {nom}', { nom: l.name })}
            onClick={() => onChange(liste.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {libres.length > 0 && (
          <select style={{ ...champ, width: 'auto', maxWidth: '100%', flex: 1 }} value=""
            onChange={e => { if (e.target.value) onChange([...liste, { name: e.target.value, strength: 1 }]) }}>
            <option value="">{t('ajouter une LoRA déjà présente…')}</option>
            {libres.map(d => <option key={d.name} value={d.name}>{d.name}{d.arch ? ` · ${d.arch}` : ''}{d.bytes ? ` · ${mo(d.bytes)}` : ''}</option>)}
          </select>
        )}
        <label style={{ ...bouton, opacity: envoi !== null ? 0.6 : 1 }}>
          {envoi !== null ? t('envoi… {n} %', { n: Math.round(envoi * 100) }) : t('Téléverser une LoRA (.safetensors)')}
          <input type="file" accept=".safetensors" hidden disabled={envoi !== null}
            onChange={e => { const f = e.target.files?.[0]; if (f) void televerser(f); e.target.value = '' }} />
        </label>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>{msg}</div>}
    </div>
  )
}

export function PersonaEditeur() {
  const [p, setP] = useState<Persona | null>(null)
  const [dispo, setDispo] = useState<LoraDispo[]>([])
  const [modifie, setModifie] = useState(false)
  const [etat, setEtat] = useState<string | null>(null)
  const edition = useEdition()

  const charger = () => {
    void fetch('/api/persona').then(r => r.json()).then((d: Persona) => { setP(d); setModifie(false) }).catch(() => setEtat(t('lecture impossible')))
    void fetch('/api/loras').then(r => r.json()).then((d: { loras?: LoraDispo[] }) => setDispo(d.loras ?? [])).catch(() => {})
  }
  useEffect(charger, [])
  if (!p) return <div style={{ fontSize: 13, opacity: 0.6 }}>{etat ?? t('chargement…')}</div>

  const fige = (k: string) => p.figes?.includes(k) ?? false
  const maj = (d: Partial<Persona>) => { setP({ ...p, ...d }); setModifie(true); setEtat(null) }

  async function enregistrer() {
    setEtat(t('enregistrement…'))
    const r = await fetch('/api/persona', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setEtat(t('refusé : {e}', { e: tServeur(d.error) ?? r.status })); return }
    setP(d); setModifie(false); setEtat(t('enregistré — appliqué aux prochains rendus'))
    useAppStore.setState({ personaName: d.name?.trim() || t('Personnage') })
    void useAppStore.getState().refreshPersona()   // recette Klein grisée ou non selon ses LoRA
    charger()
  }

  const texte = (k: 'name' | 'trigger' | 'description' | 'preamble', libelle: string, aide: string, long = false) => (
    <>
      <label style={etiquette}>{libelle}{fige(k) && t(' · fixé par variable d’environnement')}</label>
      {long
        ? <textarea rows={3} style={champ} value={p[k] ?? ''} disabled={fige(k)} onChange={e => maj({ [k]: e.target.value })} />
        : <input style={champ} value={p[k] ?? ''} disabled={fige(k)} onChange={e => maj({ [k]: e.target.value })} />}
      <div style={{ fontSize: 12, opacity: 0.5, marginTop: 3 }}>{aide}</div>
    </>
  )

  return (
    <fieldset disabled={!edition} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {texte('name', t('Nom'), t('Affiché dans l’interface.'))}
      {texte('trigger', t('Mot déclencheur'), t('Le mot appris par la LoRA d’identité, placé en tête de chaque prompt (ex. ava_token).'))}
      {texte('preamble', t('Préambule d’identité'), t('Description fixe ajoutée après le mot déclencheur : âge, cheveux, traits qui ne changent jamais.'), true)}
      {texte('description', t('Description'), t('Pour toi : qui est ce personnage. N’entre pas dans le prompt.'), true)}
      <label style={etiquette}>{t('Voix')}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <ChoixVoix valeur={p.voix ?? ''} onChange={v => maj({ voix: v || null })} perso={false} vide={t('aucune voix attitrée')} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.5, marginTop: 3 }}>{t('Sa voix partout : voix off de ses reels et avatar parlant. Une voix du studio, ou ta voix clonée depuis un extrait de la bibliothèque audio.')}</div>
      <ListeLoras titre={t('LoRA d’identité — photo Krea 2')} aide={t('Empilées sur chaque rendu photo Krea 2 et chaque retouche au pinceau photo.')}
        liste={p.loras} dispo={dispo} garde={a => a === 'krea2' || a === 'inconnue'} onChange={l => maj({ loras: l })} />
      <ListeLoras titre={t('LoRA d’identité — photo FLUX.2 Klein')} aide={t('Empilées sur les rendus photo FLUX.2 Klein. Une LoRA Krea n’agit pas sur Klein : il faut une LoRA entraînée sur Klein.')}
        liste={p.lorasKlein ?? []} dispo={dispo} garde={a => a === 'flux2' || a === 'inconnue'} onChange={l => maj({ lorasKlein: l })} />
      <ListeLoras titre={t('LoRA d’identité — vidéo')} aide={t('Empilées sur les rendus image-vers-vidéo, avec le mot déclencheur. Une LoRA n’agit que sur le moteur pour lequel elle a été entraînée (une LoRA Wan ne fait rien sur LTX).')}
        liste={p.videoLoras} dispo={dispo} garde={a => !['krea2', 'flux2', 'flux1', 'zimage'].includes(a)} onChange={l => maj({ videoLoras: l })} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
        {edition ? <>
          <button style={{ ...bouton, background: modifie ? 'rgba(234,78,137,0.35)' : bouton.background, fontWeight: 600 }}
            disabled={!modifie} onClick={() => void enregistrer()}>{t('Enregistrer')}</button>
          {modifie && <button style={bouton} onClick={charger}>{t('Annuler')}</button>}
        </> : <Verrouille />}
        {etat && <span style={{ fontSize: 12, opacity: 0.75 }}>{etat}</span>}
      </div>
      <div style={{ fontSize: 12, opacity: 0.5, marginTop: 14 }}>
        {t('N’utilise qu’un personnage qui t’appartient : inventé par toi, ou toi-même. Jamais le visage ou le nom d’une personne réelle.')}
      </div>
    </fieldset>
  )
}
