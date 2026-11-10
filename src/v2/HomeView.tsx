/* ============================================================
   Home: the showcase. Each tool shows what it does using real studio
   renders (see Apercus.tsx); one click opens it.
   ============================================================ */
import { useState } from 'react'
import { t } from '../i18n'
import { Ic, Pastille } from './bits'
import { VERSION_HOWTO } from './HowItWorks'
import { APERCUS, ApercuOutil, BANDEAU_CINEMA, BANDEAU_RESTORE, BANDEAU_REEL, BANDEAU_STAGE, pucesDe, type Apercu } from './Apercus'
import type { Asset } from '../types'
import { ChoixMedia, GROUPES, useOuvrirOutil, type ActionOutil, type Section } from './Navigation'

/* grey subtitle under each tool family title */
const SOUS: Record<string, string> = {
  Image: 'Créer, retoucher, restaurer et mettre en scène une photo.',
  'Vidéo': 'Animer une photo, réaliser un plan, modifier et finir un clip.',
  Son: 'Musique, voix et bruitages calés sur l’image.',
  Extensions: 'Modèles, LoRA et workflows en plus, installés sur ta machine.',
}

/* quick access: the most-used tools, as compact icon tiles */
const RAPIDES: [string, Parameters<typeof Ic>[0]['n']][] = [
  ['Text to Image', 'image'], ['Image to Video', 'camera'], ['Dance', 'play'], ['One-click Reel', 'film'], ['Product Shot', 'tag'], ['Music Studio', 'sound'],
]

/* featured block between two families: media on one side, text and button on the other */
function Vedette({ surtitre, titre, texte, bouton, media, inverse, onOuvrir }: { surtitre: string; titre: string; texte: string; bouton: string; media: React.ReactNode; inverse?: boolean; onOuvrir: () => void }) {
  return (
    <section className={`home-vedette maille lueur ${inverse ? 'inverse' : ''}`}>
      <button type="button" className="home-vedette-media" onClick={onOuvrir} aria-label={titre}>{media}</button>
      <div className="home-vedette-texte">
        <span className="dz-howto-surtitre">{surtitre}</span>
        <h3>{titre}</h3>
        <p>{texte}</p>
        <button type="button" className="cta home-vedette-cta" onClick={onOuvrir}><span className="cta-libelle">{bouton}<Ic n="sparkle" s={15} /></span></button>
      </div>
    </section>
  )
}

type Cible = 'reel' | 'presets' | 'parole' | 'montage' | 'image' | 'video' | 'assets' | 'stage' | 'reshoot' | 'cinema' | 'restaurer'

export function HomeView({ go, aller, onPick }: { go: (s: Cible) => void; aller: (s: Section) => void; onPick: (a: Asset, action?: ActionOutil) => void }) {
  const { ouvrir, choix, fermerChoix } = useOuvrirOutil(aller)
  const [groupe, setGroupe] = useState<string | null>(null)
  const [cherche, setCherche] = useState('')
  const [deplies, setDeplies] = useState<Set<string>>(new Set())
  const PLI = 10
  const BANDEAUX: { cible: Cible; titre: string; texte: string; apercu: Apercu }[] = [
    { cible: 'cinema', titre: 'Movie Studio', texte: t('Des images clés cohérentes, posées sur une table de montage : un seul plan vidéo passe par chacune.'), apercu: BANDEAU_CINEMA },
    { cible: 'stage', titre: t('Scène 3D'), texte: t('Place tes formes, pose ta caméra : le plan fini suit la mise en scène.'), apercu: BANDEAU_STAGE },
    { cible: 'reel', titre: t('Un brief. Un reel.'), texte: t('Plans, clips, son, fondus et accroche : le reel se monte tout seul.'), apercu: BANDEAU_REEL },
    { cible: 'restaurer', titre: 'Restore', texte: t('Vieille photo ou clip abîmé : réparé, colorisé, en HD, avec le comparateur avant / après.'), apercu: BANDEAU_RESTORE },
  ]
  const mot = cherche.trim().toLowerCase()
  // a tool listed in two families (Restore: photo and clip) appears only once under "All"
  const vus = new Set<string>()
  const groupes = GROUPES.filter(g => !groupe || g.titre === groupe)
    .map(g => ({ ...g, outils: g.outils.filter(o => (!mot || `${t(o.label)} ${t(o.texte)}`.toLowerCase().includes(mot)) && (groupe || !vus.has(o.label)) && (vus.add(o.label), true)) })).filter(g => g.outils.length)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '22px 28px 40px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'grid', gap: 28 }}>
        <div className="bandeaux">
          {BANDEAUX.map((b, i) => i === 0 ? (
            // featured tool: name, settings and text over the image, on a black gradient
            <button key={b.titre} onClick={() => go(b.cible)} className="bandeau bandeau-vedette lueur">
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
        <div className="home-rapides">
          {RAPIDES.map(([label, ic]) => {
            const o = GROUPES.flatMap(g => g.outils).find(x => x.label === label)
            return o && <button key={label} type="button" className="home-rapide" onClick={() => ouvrir(o)}>
              <span className="home-rapide-ic"><Ic n={ic} s={17} /></span><b>{t(label)}</b><span>{t(o.texte)}</span>
            </button>
          })}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input value={cherche} onChange={e => setCherche(e.target.value)} placeholder={t('Chercher un outil')} className="cherche-outil" />
          <button className={`wtab ${!groupe ? 'on' : ''}`} onClick={() => setGroupe(null)}>{t('Tout')}</button>
          {GROUPES.map(g => <button key={g.titre} className={`wtab ${groupe === g.titre ? 'on' : ''}`} onClick={() => setGroupe(g.titre)}>{t(g.titre)}</button>)}
        </div>
        {groupes.map((g, gi) => (
          <div key={g.titre} style={{ display: 'grid', gap: 28 }}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="section-tete">
              <h3>{t(g.titre)}</h3>
              {SOUS[g.titre] && <p>{t(SOUS[g.titre])}</p>}
            </div>
            {(() => {
              // two rows, then a fade and "See all" (except when searching or filtering by family)
              const plie = !mot && !groupe && g.outils.length > PLI && !deplies.has(g.titre)
              return <div className={`section-grille ${plie ? 'pliee' : ''}`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 14 }}>
              {(plie ? g.outils.slice(0, PLI) : g.outils).map(o => (
                <button key={o.label} onClick={() => ouvrir(o)} className="carte-outil">
                  <span className="carte-image"><ApercuOutil apercu={APERCUS[o.label]} />{o.pastille && <i><Pastille k={o.pastille} /></i>}</span>
                  <b>{t(o.label)}</b>
                  {pucesDe(APERCUS[o.label]).length > 0 && <span className="puces-sous">{pucesDe(APERCUS[o.label]).map(p => <em key={p}>{t(p)}</em>)}</span>}
                  <span>{t(o.texte)}</span>
                </button>
              ))}
            </div>
            {plie && <div className="voir-tout-fondu"><button type="button" className="voir-tout" onClick={() => setDeplies(d => new Set(d).add(g.titre))}>
              {t('Voir les {n} outils', { n: g.outils.length })}<Ic n="chevron" s={13} /></button></div>}
              </div>
            })()}
          </div>
          {!mot && !groupe && gi === 0 && <Vedette surtitre="Movie Studio" titre={t('Une fiche de plan. Une séquence.')} bouton={t('Ouvrir Movie Studio')}
            texte={t('Trois plans fixes, un clip entre deux images, un préquel devant, un séquel derrière : une séquence de film d’un seul tenant, avec ton personnage.')}
            media={<video src={`/danses/howto/cinema-hero.mp4?v=${VERSION_HOWTO}`} poster={`/danses/howto/cinema-hero.jpg?v=${VERSION_HOWTO}`} muted loop playsInline autoPlay preload="none" />}
            onOuvrir={() => go('cinema')} />}
          {!mot && !groupe && gi === 1 && (() => {
            const o = GROUPES.flatMap(x => x.outils).find(x => x.label === 'Dance')
            return o && <Vedette inverse surtitre="Dance" titre={t('Ton personnage danse')} bouton={t('Choisir une danse')}
              texte={t('Une photo, une danse du catalogue, un studio : le mouvement est repris geste pour geste, le visage et la tenue restent les siens.')}
              media={<video src="/danses/hero-montage.mp4?v=20261106" poster="/danses/hero-montage.jpg?v=20261106" muted loop playsInline autoPlay preload="none" />} onOuvrir={() => ouvrir(o)} />
          })()}
          </div>
        ))}
        {!mot && !groupe && <section className="home-nuage">
          <h3>{t('Tous les outils')}</h3>
          <div>{GROUPES.flatMap(g => g.outils).filter((o, i, l) => l.findIndex(x => x.label === o.label) === i).map(o => (
            <button key={o.label} type="button" onClick={() => ouvrir(o)}>{t(o.label)}</button>
          ))}</div>
        </section>}
        {!mot && !groupe && <footer className="home-pied">
          <div className="home-pied-marque"><b>CreatorOS</b><span>{t('Un studio photo, vidéo, danse, musique et voix, sur un seul GPU, chez toi.')}</span>
            <a href="https://github.com/thePloggy/CreatorOS-Studio" target="_blank" rel="noopener noreferrer"><Ic n="link" s={14} />{t('Installer depuis GitHub')}</a></div>
          {GROUPES.map(g => (
            <div key={g.titre} className="home-pied-col"><span>{t(g.titre)}</span>
              {g.outils.slice(0, 8).map(o => <button key={o.label} type="button" onClick={() => ouvrir(o)}>{t(o.label)}</button>)}</div>
          ))}
        </footer>}
        <ChoixMedia choix={choix} onClose={fermerChoix} onPick={onPick} />
      </div>
    </div>
  )
}
