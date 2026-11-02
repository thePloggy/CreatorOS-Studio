/* ============================================================
   Parcours guidé de la démo : 4 étapes au premier passage (rouvrable par
   le bouton « ? »). Personnage → image (avec des exemples de scènes à
   essayer) → vidéo (depuis une image ou un texte) → finitions et partage.
   Les exemples remplissent le prompt et ouvrent Image : rien ne part en
   rendu sans un clic de la personne.
   Styles en ligne : partagé bureau et mobile.
   ============================================================ */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'

const CLE = 'creatoros-parcours-vu'
export const parcoursDejaVu = () => { try { return localStorage.getItem(CLE) === '1' } catch { return true } }
const marquerVu = () => { try { localStorage.setItem(CLE, '1') } catch { /* stockage refusé */ } }

/* Mêmes scènes que les exemples de la démo (scripts/demo/scenes.mjs) : le
   personnage change, la scène reste. */
const EXEMPLES = [
  { titre: 'Café à Paris', prompt: 'sitting at a small café terrace on a Paris cobblestone street in the morning, wearing a loose white linen shirt and light beige trousers, holding a cup of coffee, candid smile, natural light, travel photo' },
  { titre: 'Plage au couchant', prompt: 'walking barefoot along the shoreline at golden hour, wearing a flowing white summer dress, hair moving in the wind, waves behind her, warm sunset light, travel photo' },
  { titre: 'Sentier de montagne', prompt: 'standing at a mountain trail viewpoint above a green alpine valley, wearing a red hiking jacket and a small backpack, looking toward the horizon, bright clear morning, travel photo' },
  { titre: 'Marché aux fleurs', prompt: 'browsing a colourful flower market in Amsterdam, wearing a denim jacket over a striped t-shirt, holding a bouquet of yellow tulips, canal houses behind her, soft overcast light, travel photo' },
]

const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: 10, border: 0, font: 'inherit', fontSize: 13, cursor: 'pointer', background: '#24262c', color: '#e8e9ec' }
const btnMain: React.CSSProperties = { ...btn, background: 'linear-gradient(90deg,#f24d8a,#a855f7)', color: '#fff', fontWeight: 600 }

/** `aller` : ouvre une section de l'application (image, vidéo, personnage, paramètres). */
export function Parcours({ onClose, aller }: { onClose: () => void; aller: (s: 'image' | 'video' | 'persona' | 'config') => void }) {
  const [etape, setEtape] = useState(0)
  const nom = useAppStore(s => s.personaName)
  const credit = useAppStore(s => s.personaCredit)
  const fermer = () => { marquerVu(); onClose() }
  const essayer = (prompt: string) => {
    const s = useAppStore.getState()
    s.setMode('photo'); s.updatePhoto({ task: 'generate' }); s.setUserPrompt(prompt)
    fermer(); aller('image')
  }

  const ETAPES: { titre: string; corps: React.ReactNode }[] = [
    { titre: t('Bienvenue dans CreatorOS'), corps: (<>
      <p>{t('Un studio pour créer les photos et vidéos d’une influenceuse virtuelle — toujours le même visage, d’un post à l’autre.')}</p>
      <p>{t('Les personnages sont fictifs, chacun porté par une LoRA d’identité. Le personnage actif est {nom}', { nom })}
        {credit?.auteur ? t(' (LoRA par {a})', { a: credit.auteur }) : ''}. {t('Change-le avec le menu en haut, à côté du logo.')}</p>
    </>) },
    { titre: t('1 · Une image'), corps: (<>
      <p>{t('Décris une scène : le personnage la joue. Essaie un de ces exemples (le prompt se remplit, tu lances le rendu toi-même) :')}</p>
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {EXEMPLES.map(x => (
          <button key={x.titre} style={{ ...btn, textAlign: 'left' }} onClick={() => essayer(x.prompt)}>
            {t(x.titre)} <span style={{ opacity: 0.55, fontSize: 12 }}>→ {t('remplir le prompt')}</span>
          </button>
        ))}
      </div>
      <p style={{ opacity: 0.7, fontSize: 12.5 }}>{t('Éléments ouvre tenues, lieux, poses — et la garde-robe du personnage (★).')}</p>
    </>) },
    { titre: t('2 · Une vidéo'), corps: (<>
      <p>{t('Dans Vidéo : « Depuis une image » anime une photo de la bibliothèque ; « Depuis un texte » crée un plan d’ambiance (sans personnage) avec son son, ou une scène avec le personnage s’il a une LoRA vidéo.')}</p>
      <p style={{ opacity: 0.7, fontSize: 12.5 }}>{t('Le mode brouillon rend en deux minutes environ pour vérifier un mouvement.')}</p>
    </>) },
    { titre: t('3 · Finir et comparer'), corps: (<>
      <p>{t('Sur une vidéo : ♪ ajouter le son à un clip muet, ≈ fluidité 48 i/s. Sur n’importe quel rendu : 🎲 « Encore une » relance les mêmes réglages avec une nouvelle graine.')}</p>
      <p>{t('Coche 2 à 4 rendus puis « Comparer » pour les voir côte à côte, vidéos lues ensemble.')}</p>
      <p style={{ opacity: 0.7, fontSize: 12.5 }}>{t('Pour rendre avec ton propre compte (expérimental) : Paramètres → Comfy Cloud.')}</p>
    </>) },
  ]
  const e = ETAPES[etape]
  return createPortal(
    <div onClick={fermer} style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(6,7,9,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={e.titre} onClick={ev => ev.stopPropagation()}
        style={{ width: 'min(480px, 100%)', maxHeight: '90vh', overflowY: 'auto', borderRadius: 16, padding: 20,
          background: '#14161a', color: '#e8e9ec', border: '1px solid rgba(127,127,127,.25)', boxShadow: '0 24px 60px rgba(0,0,0,.55)', fontSize: 13.5, lineHeight: 1.55 }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
          {ETAPES.map((_, i) => <span key={i} style={{ flex: 1, height: 3, borderRadius: 99, background: i <= etape ? '#f24d8a' : '#2a2c33' }} />)}
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>{e.titre}</h2>
        {e.corps}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          <button style={{ ...btn, background: 'transparent', opacity: 0.7 }} onClick={fermer}>{t('Passer')}</button>
          <span style={{ flex: 1 }} />
          {etape > 0 && <button style={btn} onClick={() => setEtape(etape - 1)}>{t('‹ Retour')}</button>}
          {etape === 0 && <button style={btn} onClick={() => { fermer(); aller('persona') }}>{t('Voir les personnages')}</button>}
          {etape < ETAPES.length - 1
            ? <button style={btnMain} onClick={() => setEtape(etape + 1)}>{t('Suivant ›')}</button>
            : <button style={btnMain} onClick={fermer}>{t('C’est parti')}</button>}
        </div>
      </div>
    </div>, document.body)
}
