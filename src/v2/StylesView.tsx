/* Mosaïques d'Image : Styles (looks en un clic), Relight (un autre éclairage) et Expand (la photo
   élargie à un format). On choisit une carte, puis une photo de la bibliothèque ; le résultat
   s'ouvre ensuite en avant / après contre la photo d'origine. */
import { useMemo, useState } from 'react'
import type { Asset } from '../types'
import LOOKS from '../data/looks.json'
import MANIFESTE from '../data/apercus-mosaiques.json'
import { LUMIERES, FORMATS } from '../data/lumieres'
import { getLang, t, tServeur } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { FramePicker } from './popups'

export type Mosaique = 'styles' | 'relight' | 'expand'
type Carte = { id: string; nom: string; famille?: string; consigne?: string; format?: string; style?: string }
const FAMILLES = ['Dessin et 3D', 'Peinture', 'Cinéma et mise en scène', 'Portrait et produit', 'Retouche et couleur']
// aperçus présents dans public/vitrine/<mosaïque>/<id>.webp (liste tenue à jour à la pose des vignettes)
const APERCUS: Record<Mosaique, Set<string>> = {
  styles: new Set(MANIFESTE.styles), relight: new Set(MANIFESTE.relight), expand: new Set(MANIFESTE.expand),
}
const TEXTES: Record<Mosaique, { titre: string; texte: string }> = {
  styles: { titre: 'Styles', texte: 'Choisis un style, choisis une photo : elle est redessinée ou rééclairée en un clic, le sujet et le cadrage restent.' },
  relight: { titre: 'Relight', texte: 'Choisis une lumière, choisis une photo : le même instant sous un autre éclairage, rien d’autre ne change.' },
  expand: { titre: 'Expand', texte: 'Choisis un format, choisis une photo : le cadre s’élargit et les bords sont inventés dans la continuité de la scène.' },
}

export function StylesView({ mode = 'styles', goImage }: { mode?: Mosaique; goImage: () => void }) {
  const s = useAppStore()
  const [famille, setFamille] = useState<string>(FAMILLES[0])
  const [choisi, setChoisi] = useState<Carte | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const en = getLang() === 'en'
  const cartes = useMemo<Carte[]>(() => {
    const ap = APERCUS[mode]
    const tri = (l: Carte[]) => l.sort((a, b) => Number(ap.has(b.id)) - Number(ap.has(a.id)))
    if (mode === 'relight') return tri(LUMIERES.map(l => ({ id: l.id, nom: t(l.label), consigne: l.consigne })))
    if (mode === 'expand') return FORMATS.map(f => ({ id: f.replace(/[^0-9a-z]/gi, ''), nom: f, format: f }))
    return tri((LOOKS as { id: string; label: string; en: string; consigne: string; famille: string; style?: string }[])
      .filter(l => l.famille === famille).map(l => ({ id: l.id, nom: en ? l.en : l.label, famille: l.famille, consigne: l.consigne, style: l.style })))
  }, [mode, famille, en])
  const lancer = async (a: Asset) => {
    if (!choisi) return
    setMsg(null)
    try {
      if (choisi.format) {
        const r = await fetch(`/api/assets/${encodeURIComponent(a.id)}/agrandir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: choisi.format }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(tServeur(d.error) ?? `HTTP ${r.status}`)
      } else {
        await s.retouchFrom(a)
        s.setUserPrompt(choisi.consigne ?? '')
        // un style à LoRA : le serveur la charge d'après cet id
        s.updatePhoto({ editStyle: choisi.style ?? null })
        useAppStore.setState({ promptTouched: true, composedPositive: '' })
        try { await s.submitJob() } finally { s.updatePhoto({ editStyle: null }) }
      }
      setChoisi(null); goImage()
    } catch (e) { setMsg(String((e as Error).message || e)) }
  }
  // un format sans aperçu se dessine comme un cadre aux bonnes proportions
  const cadre = (f: string) => { const m = f.match(/^(\d+):(\d+)$/); return m ? Number(m[1]) / Number(m[2]) : 1.3 }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto vue-page" style={{ padding: '22px 28px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <h2 className="titre-outil">{TEXTES[mode].titre}</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{t(TEXTES[mode].texte)}</div>
          </div>
          <span style={{ flex: 1 }} />
          {mode === 'styles' && <div className="wtabs">
            {FAMILLES.map(f => <button key={f} className={`wtab ${famille === f ? 'on' : ''}`} onClick={() => setFamille(f)}>{t(f)}</button>)}
          </div>}
        </div>
        <div className="styles-grille">
          {cartes.map(c => (
            <button key={c.id} className="style-carte" onClick={() => setChoisi(c)} title={c.consigne ?? c.nom}>
              <span className="style-image">
                {APERCUS[mode].has(c.id) ? <img src={`/vitrine/${mode}/${c.id}.webp`} alt="" loading="lazy" />
                  : c.format ? <span className="style-format" style={{ aspectRatio: String(cadre(c.format)) }}>{c.format}</span>
                  : <i>{c.nom.slice(0, 1)}</i>}
              </span>
              <b>{c.nom}</b>
            </button>
          ))}
        </div>
        {msg && <span className="texte-erreur">{msg}</span>}
      </div>
      <FramePicker open={!!choisi} onClose={() => setChoisi(null)} title={choisi ? `${choisi.nom} · ${t('choisis une photo')}` : ''} media="photo"
        assets={s.assets.filter(a => a.mediaType === 'photo' && !a.modele3d)} onPickAsset={a => void lancer(a)} onPickUpload={() => setChoisi(null)} />
    </div>
  )
}
