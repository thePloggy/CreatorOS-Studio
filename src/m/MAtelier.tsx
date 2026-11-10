/* ============================================================
   Workshop: character identity and settings.

   Identity (name, trigger word, preamble, LoRA) is edited here as on
   desktop: one shared editor, one source (persona.json).
   ============================================================ */
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Ic } from './bits'
import { t, tp } from '../i18n'
import { PersonaEditeur } from '../components/PersonaEditeur'
import { MesLoras } from '../v2/ExtensionsView'
import { PersonaListe } from '../components/PersonaListe'
import { CreditPersonnage } from '../components/PersonaCredit'
import { CreateurView } from '../features/createur/CreateurView'
import { AvatarUpload } from '../components/Avatar'

interface Health {
  ok?: boolean; comfy?: string
  vram?: { name: string; freeMb: number; totalMb: number } | null
  queue?: number
  composerModels?: Record<string, string>
  workflowsDir?: string; promptsDir?: string; mediaDir?: string; db?: string
}

export function MAtelier({ onBack }: { onBack: () => void }) {
  const s = useAppStore()
  const [h, setH] = useState<Health | null>(null)
  const [actif, setActif] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/health').then(r => r.json()).then(setH).catch(() => {})
  }, [])

  const counts = {
    total: s.assets.length,
    photo: s.assets.filter(a => a.mediaType === 'photo').length,
    video: s.assets.filter(a => a.mediaType === 'video').length,
    pending: s.assets.filter(a => a.reviewStatus === 'pending').length,
  }

  return (
    <>
      <div className="htitle">
        <div className="row">
          <button onClick={onBack} aria-label={t('retour')} style={{ marginTop: 6 }}><Ic n="back" s={24} /></button>
          <div style={{ flex: 1 }}>
            <h1>{s.personaName}</h1>
            <p>{t('Identité et réglages de l’atelier.')}</p>
          </div>
        </div>
      </div>

      <div className="scroll">
        <div className="label">{t('Personnages — touche pour changer')}</div>
        <div className="card"><PersonaListe onChange={setActif} /></div>

        <div className="label">{t('Crédit et licence')}</div>
        <div className="card"><CreditPersonnage key={actif ?? '-'} /></div>

        <div className="label">{t('Identité de {name}', { name: s.personaName })} · <AvatarUpload /></div>
        <div className="card"><PersonaEditeur key={actif ?? '-'} /></div>

        <div className="label">{t('Créateur')}</div>
        <div style={{ marginBottom: 16 }}><CreateurView /></div>

        <div className="label">LoRA</div>
        <div className="card" style={{ marginBottom: 16 }}><MesLoras /></div>

        <div className="label">{t('Bibliothèque')}</div>
        <div className="card">
          <Line k={t('Médias')} v={`${counts.total}`} />
          <Line k={t('Images')} v={`${counts.photo}`} />
          <Line k={t('Vidéos')} v={`${counts.video}`} />
          <Line k={t('En attente de tri')} v={`${counts.pending}`} last />
        </div>

        <div className="label">{t('Machine de rendu')}</div>
        <div className="card">
          <Line k="ComfyUI" v={h?.comfy === 'ok' ? t('connecté') : (h?.comfy ?? '…')} />
          <Line k="VRAM" v={h?.vram ? t('{free} Go libres sur {total}', { free: Math.round(h.vram.freeMb / 1024), total: Math.round(h.vram.totalMb / 1024) }) : '—'} />
          <Line k={t('File')} v={tp(h?.queue ?? 0, '{n} job', '{n} jobs')} last />
        </div>

        {h?.composerModels && (<>
          <div className="label">{t('Réécriveurs de prompt')}</div>
          <div className="card">
            {Object.entries(h.composerModels).map(([k, v], i, arr) => (
              <Line key={k} k={k} v={v} last={i === arr.length - 1} />
            ))}
          </div>
        </>)}

        <p className="muted" style={{ fontSize: 13, marginTop: 20 }}>
          {t('La maintenance (recettes, vocabulaires, textes système) se fait depuis la console desktop : ces écrans manipulent des fichiers qui changent le comportement de tous les prochains rendus.')}
        </p>
      </div>
    </>
  )
}

function Line({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '9px 0',
      borderBottom: last ? undefined : '1px solid var(--line)',
    }}>
      <span className="muted" style={{ fontSize: 14, flex: 1 }}>{k}</span>
      <span style={{ fontSize: 14, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}
