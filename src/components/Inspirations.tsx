/* Inspirations: a row of ready-made prompts, each with the render it produced here. A click loads the prompt,
   the character and, for video, the start photo. Prompts come from the official ComfyUI workflows
   (comfyui-workflow-templates, MIT), adapted to the character, or from our own renders; each card says which.
   Shared by Image, Video (desktop) and Create (mobile): only the CSS classes differ. */
import { useAppStore } from '../store/useAppStore'
import { t } from '../i18n'
import { SANS_PERSONNAGE } from '../lib/personnage'
import INSPIRATIONS from '../v2/inspirations.json'

export type Inspiration = {
  id: string; mode: 'photo' | 'video'; titre: string; prompt: string; perso: string
  /** files shipped with the studio (/inspirations/…); for a video, depart = key of its start photo */
  uri: string; affiche?: string; depart?: string
  /** prompt origin: official ComfyUI workflow name, or "creatoros" */
  source: string
  /** render format (one of the studio's photo formats); a video keeps its start photo's format */
  format: string
  /** video: engine and duration of the shown render, so a click reproduces it exactly */
  moteur?: string; secondes?: number
}
const FORMATS: Record<string, [number, number]> = {
  '9:16': [768, 1344], '2:3': [832, 1216], '3:4': [896, 1152], '1:1': [1024, 1024], '4:3': [1152, 896], '3:2': [1216, 832], '16:9': [1344, 768],
}
const TOUTES = INSPIRATIONS as Inspiration[]

const sourceLisible = (s: string) => s === 'creatoros' ? t('rendu CreatorOS')
  : s.includes('.') ? t('prompt : {nom}', { nom: s })   // a site, e.g. comfy.org
  : t('prompt : workflow ComfyUI « {nom} »', { nom: s })

/* Characters of this install: on a GitHub install, Mila or Zoelexx do not exist;
   the card then loads its prompt without a character rather than a random face. */
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
    const moteur = { ...(i.moteur ? { engine: i.moteur as never } : {}), ...(i.secondes ? { durationS: i.secondes } : {}) }
    // with a start photo: image to video; without: text to video in the card's format
    if (i.depart) { s.updateVideo({ task: 'i2v', aspect: 'origine', ...moteur }); await s.poserDepartInspiration(i.depart) }
    else s.updateVideo({ task: 't2v', aspect: i.format as never, ...moteur })
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
