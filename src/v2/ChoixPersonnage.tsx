/* Personnage d'une génération, posé comme un élément du prompt : une pastille
   avec sa photo au-dessus du champ, un clic pour en changer. « Sans
   personnage » : aucun visage imposé (la mention d’âge adulte reste, côté serveur). */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SANS_PERSONNAGE } from '../lib/personnage'
import { t } from '../i18n'

type Perso = { id: string; name: string; avatar?: string | null }

export function usePersonnages() {
  const [liste, setListe] = useState<Perso[]>([])
  useEffect(() => { void fetch('/api/personas').then(r => r.json()).then((d: { personas?: Perso[] }) => setListe(d.personas ?? [])).catch(() => {}) }, [])
  return liste
}

/** `libelleSans` : le nom affiché sans personnage, et proposé dans la liste (« Visage de la photo » pour un
 *  carrousel : sans personnage, le visage vient de la photo d'origine). */
export function ChoixPersonnage({ libelleSans }: { libelleSans?: string } = {}) {
  const liste = usePersonnages()
  const id = useAppStore(s => s.personaId)
  const nom = useAppStore(s => s.personaName)
  const photo = useAppStore(s => s.personaAvatar)
  // un choix de page : les autres pages et le personnage par défaut du studio ne changent pas
  const choisir = useAppStore(s => s.choisirPersonnagePage)
  const [ouvert, setOuvert] = useState(false)
  const boite = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ouvert) return
    const dehors = (e: PointerEvent) => { if (!boite.current?.contains(e.target as Node)) setOuvert(false) }
    window.addEventListener('pointerdown', dehors)
    return () => window.removeEventListener('pointerdown', dehors)
  }, [ouvert])
  const sans = id === SANS_PERSONNAGE
  const prendre = (p: string) => { setOuvert(false); void choisir(p) }
  return (
    <div className="elements-prompt" ref={boite}>
      {sans
        ? <button className="element-ajout" onClick={() => setOuvert(o => !o)}>{libelleSans ? `👤 ${libelleSans}` : `＋ ${t('Personnage')}`}</button>
        : <span className="element">
            <button onClick={() => setOuvert(o => !o)} title={t('changer de personnage')}>
              {photo ? <img src={photo} alt="" /> : <i />}{nom}
            </button>
            {<button className="element-x" aria-label={t('retirer le personnage')} onClick={() => prendre(SANS_PERSONNAGE)}>×</button>}
          </span>}
      {ouvert && (
        <div className="elements-choix">
          {libelleSans && (
            <button className={sans ? 'on' : ''} onClick={() => prendre(SANS_PERSONNAGE)}><i /><span>{libelleSans}</span></button>
          )}
          {liste.map(p => (
            <button key={p.id} className={p.id === id ? 'on' : ''} onClick={() => prendre(p.id)}>
              {p.avatar ? <img src={p.avatar} alt="" /> : <i />}<span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
