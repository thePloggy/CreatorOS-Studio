/* ============================================================
   Quick triage: a queue of pending media, three decisions.

   Rules: Approve and Reject advance, Skip does not change the
   status, Undo reverts only THE LAST decision, and Reject never
   deletes the file.
   ============================================================ */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVideoArretee } from '../v2/bits'
import type { Asset } from '../types'
import { useAppStore } from '../store/useAppStore'
import { Ic } from './bits'
import { t, tc, tp } from '../i18n'

export function MTriage({ assets, onClose }: { assets: Asset[]; onClose: () => void }) {
  const videoArretee = useVideoArretee()
  const s = useAppStore()
  /* The queue is FROZEN on open: otherwise approving a media would remove
     it from `assets` and shift the position. */
  const queue = useRef(assets.map(a => a.id)).current
  const [i, setI] = useState(0)
  const [history, setHistory] = useState<{ id: string; was: Asset['reviewStatus'] }[]>([])

  const id = queue[i]
  const a = s.assets.find(x => x.id === id)
  const done = i >= queue.length

  const decide = (status: 'approved' | 'rejected') => {
    if (!a) return
    setHistory(h => [...h, { id: a.id, was: a.reviewStatus }])
    s.reviewAsset(a.id, status)
    setI(n => n + 1)
  }
  const skip = () => setI(k => k + 1)
  const undo = () => {
    const last = history[history.length - 1]
    if (!last) return
    s.reviewAsset(last.id, last.was)
    setHistory(h => h.slice(0, -1))
    setI(Math.max(0, queue.indexOf(last.id)))
  }

  return createPortal(
    <div className="m viewer">
      <div className="vtop">
        <button onClick={onClose} aria-label={t('fermer')}><Ic n="back" s={24} /></button>
        <span className="muted" style={{ fontSize: 14 }}>
          {done ? t('terminé') : `${i + 1} / ${queue.length}`}
        </span>
        {history.length > 0 && (
          <button style={{ marginLeft: 'auto', color: 'var(--acc)', fontSize: 15 }} onClick={undo}>{tc('undo', 'Annuler')}</button>
        )}
      </div>

      <div className="stage">
        {done || !a ? (
          <div className="empty">
            <div style={{ fontSize: 44, marginBottom: 8 }}>✓</div>
            {tp(queue.length, '{n} média passé en revue.', '{n} médias passés en revue.')}
            <br />
            <button style={{ color: 'var(--acc)', marginTop: 12 }} onClick={onClose}>{t('Revenir à la bibliothèque')}</button>
          </div>
        ) : a.mediaType === 'video'
          ? <video ref={videoArretee} src={a.uri} controls playsInline autoPlay loop />
          : <img src={a.uri} alt="" />}
      </div>

      {!done && a && (
        <div className="vbot">
          <button className="act ko" onClick={() => decide('rejected')}>
            <Ic n="x" s={22} />{t('Refuser')}
          </button>
          <button className="act" onClick={skip}>
            <Ic n="skip" s={22} />{t('Passer')}
          </button>
          <button className="act ok" onClick={() => decide('approved')}>
            <Ic n="heart" s={22} />{t('Valider')}
          </button>
        </div>
      )}
    </div>, document.body)
}
