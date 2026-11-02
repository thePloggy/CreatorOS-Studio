/* ============================================================
   Configuration de l'outil — ce qui n'est pas une tâche de création :
   vocabulaires (catalogues + ajouts), recettes et textes de façonnage
   (Workbench). Regroupés sous ⚙ config.
   ============================================================ */
import { useState } from 'react'
import { cn } from '../../lib/cn'
import { VocabView } from '../vocab/VocabView'
import { WorkbenchView } from '../workbench/WorkbenchView'
import { CleComfy } from './CleComfy'
import { CleProprietaire, Verrouille } from './CleProprietaire'
import { useEdition } from '../../lib/proprietaire'
import { useAppStore } from '../../store/useAppStore'
import { ModelesOptionnels } from './ModelesOptionnels'
import { t } from '../../i18n'

export type ConfigTab = 'vocab' | 'workbench' | 'cloud' | 'modeles'

export function ConfigView({ initial = 'vocab' }: { initial?: ConfigTab }) {
  const [tab, setTab] = useState<ConfigTab>(() => { const o = useAppStore.getState().ongletConfig; if (o) useAppStore.setState({ ongletConfig: null }); return o ?? initial })
  const edition = useEdition()
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 h-11 border-b border-border bg-surface shrink-0">
        <span className="font-semibold text-[13px]">{t("Configuration de l'outil")}</span>
        <div className="flex bg-surface2 border border-border rounded-ctl p-[3px] gap-[3px]">
          {([['cloud', 'Comfy Cloud'], ['modeles', 'Modèles optionnels'], ['vocab', 'Vocabulaires'], ['workbench', 'Recettes & textes']] as [ConfigTab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={cn('px-3 py-1 rounded text-[12px] font-semibold cursor-pointer', tab === id ? 'bg-surface3 text-text' : 'text-muted hover:text-text')}>
              {t(label)}
            </button>
          ))}
        </div>
        <span className="text-[10.5px] text-faint font-mono ml-auto">{t("réglages de l'outil — pas des tâches de création")}</span>
      </div>
      {tab !== 'cloud' && tab !== 'modeles' && !edition && <Verrouille style={{ padding: '6px 16px' }} />}
      {tab === 'modeles' ? <div className="p-4 overflow-y-auto"><ModelesOptionnels /></div> : tab === 'cloud' ? <div className="p-4 overflow-y-auto"><CleComfy /><CleProprietaire /></div> : tab === 'vocab' ? <VocabView /> : <WorkbenchView />}
    </div>
  )
}
