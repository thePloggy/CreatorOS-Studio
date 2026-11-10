/* ============================================================
   Character (◐) — the constant identity of renders: profile photo, and
   the editor (name, trigger word, preamble, identity LoRA).
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
    <div className="scroll-clean" style={{ padding: '18px 24px 40px', width: '100%', maxWidth: 1800, margin: '0 auto', display: 'grid', gap: 18 }}>
      <section>
        <SectionTitle>{t('Personnages — clique pour changer de personnage actif')}</SectionTitle>
        <div className="border border-border rounded-card bg-surface2 p-4">
          <PersonaListe onChange={setActif}
            onCreerDeZero={() => useAppStore.setState(st => ({ navRequest: { section: 'nouveau-personnage', nonce: (st.navRequest?.nonce ?? 0) + 1 } }))} />
        </div>
      </section>

      {/* the active character: training on the left (wider), identity on the right */}
      <div className="perso-colonnes">
        <section style={{ minWidth: 0 }}>
          <SectionTitle>{t('Personnage actif')} · {name}</SectionTitle>
          <Entrainement />
        </section>
        <aside style={{ minWidth: 0, display: 'grid', gap: 14, alignContent: 'start' }}>
          <div>
            <SectionTitle>{t('Fiche')}</SectionTitle>
            <div className="flex items-center gap-3.5 border border-border rounded-card bg-surface2 p-4">
              <Avatar size={56} />
              <div>
                <div className="font-bold text-[15px]">{name} <AvatarUpload className="ml-2 font-normal" /></div>
                <div className="text-muted text-[12px]">{t('Personnage fictif, entièrement généré')}</div>
              </div>
              <div className="ml-auto text-[12px] text-muted bg-surface3 border border-border rounded px-2 py-1">
                AI-generated<br /><span className="text-faint">{t('à signaler en publication')}</span>
              </div>
            </div>
          </div>
          <div>
            <SectionTitle>{t('Identité — appliquée à tous les prochains rendus')}</SectionTitle>
            <div className="border border-border rounded-card bg-surface2 p-4">
              <PersonaEditeur key={actif ?? '-'} />
            </div>
          </div>
          <div>
            <SectionTitle>{t('Crédit et licence')}</SectionTitle>
            <div className="border border-border rounded-card bg-surface2 p-4">
              <CreditPersonnage key={actif ?? '-'} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
