/* ============================================================
   Personnage (◐) — l'identité constante des rendus : photo de profil, et
   l'éditeur (nom, mot déclencheur, préambule, LoRA d'identité).
   ============================================================ */
import { Entrainement } from './Entrainement'
import { SectionTitle } from '../../components/ui'
import { Avatar, AvatarUpload } from '../../components/Avatar'
import { useAppStore } from '../../store/useAppStore'
import { PersonaEditeur } from '../../components/PersonaEditeur'
import { PersonaListe } from '../../components/PersonaListe'
import { CreditPersonnage } from '../../components/PersonaCredit'
import { useState } from 'react'
import { t } from '../../i18n'

export function PersonaView() {
  const name = useAppStore(s => s.personaName)
  const [actif, setActif] = useState<string | null>(null)
  return (
    <div className="flex-1 overflow-y-auto scroll-clean p-4 max-w-[720px]">
      <SectionTitle>{t('Personnages — clique pour changer de personnage actif')}</SectionTitle>
      <div className="border border-border rounded-card bg-surface2 p-4 mb-4">
        <PersonaListe onChange={setActif} />
      </div>

      <SectionTitle>{t('Personnage actif')}</SectionTitle>
      <Entrainement />

      {/* Carte identité */}
      <div className="flex items-center gap-3.5 border border-border rounded-card bg-surface2 p-4 mb-4">
        <Avatar size={56} />
        <div>
          <div className="font-bold text-[15px]">{name} <AvatarUpload className="ml-2 font-normal" /></div>
          <div className="text-muted text-[12px]">{t('Personnage fictif, entièrement généré')}</div>
        </div>
        <div className="ml-auto text-[12px] text-muted bg-surface3 border border-border rounded px-2 py-1">
          AI-generated<br /><span className="text-faint">{t('à signaler en publication')}</span>
        </div>
      </div>

      <SectionTitle>{t('Crédit et licence')}</SectionTitle>
      <div className="border border-border rounded-card bg-surface2 p-4 mb-4">
        <CreditPersonnage key={actif ?? '-'} />
      </div>

      <SectionTitle>{t('Identité — appliquée à tous les prochains rendus')}</SectionTitle>
      <div className="border border-border rounded-card bg-surface2 p-4">
        <PersonaEditeur key={actif ?? '-'} />
      </div>
    </div>
  )
}
