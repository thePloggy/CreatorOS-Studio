/* ============================================================
   Sélecteur de source — connaît sa DESTINATION.

   Chaque rôle sait ce qu'il accepte (image ou vidéo), où poser le
   résultat, et propose deux chemins : la bibliothèque, ou un fichier du
   téléphone (galerie et appareil photo).

   Règle : une source encore en cours de transfert n'autorise pas l'envoi
   d'un job — c'est le store qui pose le nom de fichier une fois la copie
   serveur faite, et tant qu'il est vide le formulaire n'est pas prêt.
   ============================================================ */
import { useMemo, useRef, useState } from 'react'
import type { Asset } from '../types'
import { vignetteOf } from '../components/AssetMedia'
import { useAppStore } from '../store/useAppStore'
import { Ic, Seg, Sheet } from './bits'
import { getLang, t } from '../i18n'
import { useEdition } from '../lib/proprietaire'

export type SourceRole = 'start' | 'end' | 'driver' | 'still' | 'extend' | 'editsrc'

const ROLE: Record<SourceRole, { title: string; video: boolean }> = {
  start: { title: 'Image de départ', video: false },
  end: { title: 'Image de fin', video: false },
  still: { title: 'Image du sujet', video: false },
  editsrc: { title: 'Image à retoucher', video: false },
  driver: { title: 'Vidéo de mouvement', video: true },
  /* Prolonger part TOUJOURS d'un clip déjà rendu : c'est sa dernière
     frame que le serveur extrait. Pas d'import depuis le téléphone. */
  extend: { title: 'Clip à prolonger', video: true },
}

export function MSourcePicker({ role, onClose }: { role: SourceRole; onClose: () => void }) {
  const s = useAppStore()
  const cfg = ROLE[role]
  const [tab, setTab] = useState<'lib' | 'device'>('lib')
  const edition = useEdition()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const list = useMemo(() => s.assets
    .filter(a => (cfg.video ? a.mediaType === 'video' : a.mediaType === 'photo'))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 120), [s.assets, cfg.video])

  const pickAsset = async (a: Asset) => {
    setBusy(true); setErr('')
    try {
      switch (role) {
        case 'start': await s.pickStartFrame(a.id); break
        case 'end': void s.pickEndFrame(a.id); break
        case 'still': await s.pickMotionStill(a.id); break
        case 'extend': await s.pickExtendClip(a.id); break
        case 'editsrc': await s.pickEditSource(a.id); break
        case 'driver':
          // pas de driver depuis la bibliothèque côté store : on passe par
          // le fichier, comme le desktop
          setErr(t('Choisis la vidéo depuis ton téléphone.'))
          setBusy(false); return
      }
      onClose()
    } catch (e) { setErr(String((e as Error).message || e)) } finally { setBusy(false) }
  }

  const pickFile = async (f: File) => {
    setBusy(true); setErr('')
    try {
      if (role === 'driver') await s.uploadMotionDriver(f)
      else if (role === 'still') await s.uploadMotionStill(f)
      else if (role === 'editsrc') await s.uploadEditSource(f)
      else await s.uploadStartFrame(f)
      onClose()
    } catch (e) { setErr(String((e as Error).message || e)) } finally { setBusy(false) }
  }

  return (
    <Sheet title={t(cfg.title)} onClose={onClose}>
      {role === 'extend'
        ? <p className="muted" style={{ fontSize: 13 }}>{t('Un clip déjà rendu : c’est sa dernière image qui sert de départ.')}</p>
        : edition ? <Seg value={tab} onPick={setTab} options={[['lib', t('Bibliothèque')], ['device', t('Mon téléphone')]]} />
        : <p className="muted" style={{ fontSize: 13 }}>{t('Sur la démo publique, on part d’une image générée par le studio : l’envoi de fichiers est réservé au propriétaire.')}</p>}

      {err && <p className="err">{err}</p>}
      {busy && <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>{t('transfert en cours…')}</p>}

      {(tab === 'lib' || role === 'extend' || !edition) ? (
        <div className="grid" style={{ marginTop: 12, '--cols': 3 } as React.CSSProperties}>
          {list.map(a => (
            <button key={a.id} className="tile" style={{ padding: 0 }} onClick={() => void pickAsset(a)}
              aria-label={t(a.mediaType === 'video' ? 'vidéo du {date}' : 'image du {date}', { date: new Date(a.createdAt).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'fr-FR') })}>
              <img src={vignetteOf(a)} alt="" loading="lazy" />
              {a.mediaType === 'video' && <span className="play"><Ic n="play" s={13} /></span>}
            </button>
          ))}
          {list.length === 0 && <p className="muted" style={{ gridColumn: '1/-1', padding: 16 }}>
            {cfg.video ? t('Aucun média vidéo dans la bibliothèque.') : t('Aucun média image dans la bibliothèque.')}
          </p>}
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          {/* `capture` absent volontairement : on propose la galerie ET
              l'appareil photo, c'est l'OS qui présente le choix. */}
          <input ref={fileRef} type="file" hidden
            accept={cfg.video ? 'video/*' : 'image/*'}
            onChange={e => { const f = e.target.files?.[0]; if (f) void pickFile(f) }} />
          <button className="cta" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Ic n="camera" s={20} /> {t('Choisir un fichier')}
          </button>
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            {t("Le fichier est transféré sur la machine de rendu avant d'être utilisable. Tant que le transfert n'est pas terminé, le rendu ne peut pas partir.")}
          </p>
        </div>
      )}
    </Sheet>
  )
}
