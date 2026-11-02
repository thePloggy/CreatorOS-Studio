/* Personnage d'une génération, posé comme un élément du prompt : une pastille
   avec sa photo au-dessus du champ, un clic pour en changer. « Sans
   personnage » (aucun visage imposé) est réservé au propriétaire du studio. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SANS_PERSONNAGE } from '../lib/personnage'
import { t } from '../i18n'
import { useEdition } from '../lib/proprietaire'

type Perso = { id: string; name: string; avatar?: string | null }

export function usePersonnages() {
  const [liste, setListe] = useState<Perso[]>([])
  useEffect(() => { void fetch('/api/personas').then(r => r.json()).then((d: { personas?: Perso[] }) => setListe(d.personas ?? [])).catch(() => {}) }, [])
  return liste
}

export function ChoixPersonnage() {
  const liste = usePersonnages()
  const edition = useEdition()
  const id = useAppStore(s => s.personaId)
  const nom = useAppStore(s => s.personaName)
  const photo = useAppStore(s => s.personaAvatar)
  const choisir = useAppStore(s => s.choisirPersonnage)
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
        ? <button className="element-ajout" onClick={() => setOuvert(o => !o)}>＋ {t('Personnage')}</button>
        : <span className="element">
            <button onClick={() => setOuvert(o => !o)} title={t('changer de personnage')}>
              {photo ? <img src={photo} alt="" /> : <i />}{nom}
            </button>
            {edition && <button className="element-x" aria-label={t('retirer le personnage')} onClick={() => prendre(SANS_PERSONNAGE)}>×</button>}
          </span>}
      {ouvert && (
        <div className="elements-choix">
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
