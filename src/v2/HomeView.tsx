/* ============================================================
   Accueil — la vitrine : chaque outil montre ce qu'il fait,
   sur de vrais rendus du studio (voir Apercus.tsx), un clic pour l'ouvrir.
   ============================================================ */
import { useState } from 'react'
import { t } from '../i18n'
import { Pastille } from './bits'
import { APERCUS, ApercuOutil, BANDEAU_CINEMA, BANDEAU_RESTORE, BANDEAU_REEL, BANDEAU_STAGE, pucesDe, type Apercu } from './Apercus'
import type { Asset } from '../types'
import { ChoixMedia, GROUPES, useOuvrirOutil, type ActionOutil, type Section } from './Navigation'

type Cible = 'reel' | 'presets' | 'parole' | 'montage' | 'image' | 'video' | 'assets' | 'stage' | 'reshoot' | 'cinema' | 'restaurer'

export function HomeView({ go, aller, onPick }: { go: (s: Cible) => void; aller: (s: Section) => void; onPick: (a: Asset, action?: ActionOutil) => void }) {
  const { ouvrir, choix, fermerChoix } = useOuvrirOutil(aller)
  const [groupe, setGroupe] = useState<string | null>(null)
  const [cherche, setCherche] = useState('')
  const BANDEAUX: { cible: Cible; titre: string; texte: string; apercu: Apercu }[] = [
    { cible: 'cinema', titre: 'Movie Studio', texte: t('Boîtier, objectif, lumière, pellicule : une fiche de plan, et la scène se joue comme au cinéma.'), apercu: BANDEAU_CINEMA },
    { cible: 'stage', titre: 'Stage', texte: t('Place tes formes, pose ta caméra : le plan fini suit la mise en scène.'), apercu: BANDEAU_STAGE },
    { cible: 'reel', titre: t('Un brief. Un reel.'), texte: t('Plans, clips, son, fondus et accroche : le reel se monte tout seul.'), apercu: BANDEAU_REEL },
    { cible: 'restaurer', titre: 'Restore', texte: t('Vieille photo ou clip abîmé : réparé, colorisé, en HD, avec le comparateur avant / après.'), apercu: BANDEAU_RESTORE },
  ]
  const mot = cherche.trim().toLowerCase()
  // un outil rangé dans deux familles (Restaurer : photo et clip) ne s'affiche qu'une fois dans « Tout »
  const vus = new Set<string>()
  const groupes = GROUPES.filter(g => !groupe || g.titre === groupe)
    .map(g => ({ ...g, outils: g.outils.filter(o => (!mot || `${t(o.label)} ${t(o.texte)}`.toLowerCase().includes(mot)) && (groupe || !vus.has(o.label)) && (vus.add(o.label), true)) })).filter(g => g.outils.length)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'grid', gap: 28 }}>
        <div className="bandeaux">
          {BANDEAUX.map((b, i) => i === 0 ? (
            // l'outil vedette : nom, réglages et texte posés sur l'image, sur un dégradé noir
            <button key={b.titre} onClick={() => go(b.cible)} className="bandeau bandeau-vedette">
              <span className="bandeau-media"><ApercuOutil apercu={b.apercu} /></span>
              <span className="vedette-texte">
                <i>{t('À la une')}</i>
                <b>{b.titre}</b>
                {pucesDe(b.apercu).length > 0 && <span className="puces-sous">{pucesDe(b.apercu).map(p => <em key={p}>{t(p)}</em>)}</span>}
                <span>{b.texte}</span>
              </span>
            </button>
          ) : (
            <button key={b.titre} onClick={() => go(b.cible)} className="bandeau">
              <span className="bandeau-media"><ApercuOutil apercu={b.apercu} /></span>
              <b>{b.titre}</b>
              {pucesDe(b.apercu).length > 0 && <span className="puces-sous">{pucesDe(b.apercu).map(p => <em key={p}>{t(p)}</em>)}</span>}
              <span>{b.texte}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input value={cherche} onChange={e => setCherche(e.target.value)} placeholder={t('Chercher un outil')} className="cherche-outil" />
          <button className={`wtab ${!groupe ? 'on' : ''}`} onClick={() => setGroupe(null)}>{t('Tout')}</button>
          {GROUPES.map(g => <button key={g.titre} className={`wtab ${groupe === g.titre ? 'on' : ''}`} onClick={() => setGroupe(g.titre)}>{t(g.titre)}</button>)}
        </div>
        {groupes.map(g => (
          <div key={g.titre} style={{ display: 'grid', gap: 12 }}>
            <b style={{ fontSize: 20, fontWeight: 800 }}>{t(g.titre)}</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 14 }}>
              {g.outils.map(o => (
                <button key={o.label} onClick={() => ouvrir(o)} className="carte-outil">
                  <span className="carte-image"><ApercuOutil apercu={APERCUS[o.label]} />{o.pastille && <i><Pastille k={o.pastille} /></i>}</span>
                  <b>{t(o.label)}</b>
                  {pucesDe(APERCUS[o.label]).length > 0 && <span className="puces-sous">{pucesDe(APERCUS[o.label]).map(p => <em key={p}>{t(p)}</em>)}</span>}
                  <span>{t(o.texte)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
      </div>
    </div>
  )
}
