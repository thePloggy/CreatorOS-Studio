/* Inspirations : une rangée de prompts tout faits, chacun avec le rendu qu'il a donné ici. Un clic charge le prompt,
   le personnage et, en vidéo, la photo de départ. Les prompts viennent des workflows officiels de ComfyUI
   (comfyui-workflow-templates, MIT), adaptés au personnage, ou de nos propres rendus ; chaque carte dit d'où.
   Commun à Image, Vidéo (desktop) et Créer (mobile) : seules les classes CSS changent. */
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'
import { SANS_PERSONNAGE } from '../lib/personnage'
import INSPIRATIONS from '../v2/inspirations.json'

export type Inspiration = {
  id: string; mode: 'photo' | 'video'; titre: string; prompt: string; perso: string
  /** fichiers livrés avec le studio (/inspirations/…) ; pour une vidéo, depart = clé de sa photo de départ */
  uri: string; affiche?: string; depart?: string
  /** d'où vient le prompt : nom du workflow officiel ComfyUI, ou « creatoros » */
  source: string
  /** format du rendu (un des formats photo du studio) ; la vidéo garde celui de sa photo de départ */
  format: string
  /** vidéo : moteur et durée du rendu montré, pour que le clic le refasse à l'identique */
  moteur?: string; secondes?: number
}
const FORMATS: Record<string, [number, number]> = {
  '9:16': [768, 1344], '2:3': [832, 1216], '3:4': [896, 1152], '1:1': [1024, 1024], '4:3': [1152, 896], '3:2': [1216, 832], '16:9': [1344, 768],
}
const TOUTES = INSPIRATIONS as Inspiration[]

const sourceLisible = (s: string) => s === 'creatoros' ? t('rendu CreatorOS') : t('prompt : workflow ComfyUI « {nom} »', { nom: s })

/* Personnages de cette installation : sur une installation GitHub, Mila ou Zoelexx n'existent pas ;
   la carte charge alors son prompt sans personnage plutôt qu'un visage au hasard. */
let personnages: Promise<Set<string>> | null = null
const lirePersonnages = () => personnages ??= fetch('/api/personas').then(r => r.json())
  .then((d: { personas?: { id: string }[] }) => new Set((d.personas ?? []).map(p => p.id))).catch(() => new Set<string>())

export async function chargerInspiration(i: Inspiration) {
  const s = useAppStore.getState()
  const connus = await lirePersonnages()
  await s.choisirPersonnagePage(i.perso !== SANS_PERSONNAGE && connus.has(i.perso) ? i.perso : SANS_PERSONNAGE)
  if (i.mode === 'photo') {
    s.updatePhoto({ task: 'generate' })
    const f = FORMATS[i.format]
    if (f) s.setPhotoSize({ w: f[0], h: f[1], label: i.format })
  } else {
    s.updateVideo({ task: 'i2v', aspect: 'origine', ...(i.moteur ? { engine: i.moteur as never } : {}), ...(i.secondes ? { durationS: i.secondes } : {}) })
    if (i.depart) await s.poserDepartInspiration(i.depart)
  }
  useAppStore.getState().setUserPrompt(i.prompt)
}

export function Inspirations({ mode, mobile }: { mode: 'photo' | 'video'; mobile?: boolean }) {
  const liste = TOUTES.filter(i => i.mode === mode)
  if (!liste.length) return null
  const reduit = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return (
    <section className={mobile ? 'm-insp' : 'insp'} aria-label={t('Inspirations')}>
      <div className="insp-tete">
        <h2>{t('Inspirations')}</h2>
        <span>{mode === 'photo' ? t('Clique pour reprendre le prompt et le personnage.') : t('Clique pour reprendre la photo de départ, le prompt et le personnage.')}</span>
      </div>
      <div className="insp-rangee">
        {liste.map(i => (
          <button key={i.id} type="button" className="insp-carte" onClick={() => void chargerInspiration(i)}
            style={{ aspectRatio: (FORMATS[i.format] ?? FORMATS['9:16']).join(' / ') }}
            title={`${i.prompt}\n\n${sourceLisible(i.source)}`}>
            {i.mode === 'video' && !reduit
              ? <video src={i.uri} poster={i.affiche} muted loop playsInline autoPlay preload="metadata" aria-hidden />
              : <img src={i.affiche ?? i.uri} alt="" loading="lazy" />}
            <span className="insp-texte">
              <b>{t(i.titre)} <i>{i.format}</i></b>
              <small>{sourceLisible(i.source)}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
