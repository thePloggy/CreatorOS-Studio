/* ============================================================
   Persistence of the creation draft.

   On mobile the OS unloads the app as soon as the screen turns off:
   without this hook, a prompt being written disappears between visits.
   The Zustand store only persists display preferences.

   Kept: mode, prompt, photo AND video settings (both coexist in the
   store, so each operation keeps its draft), quantity and seed.

   NEVER kept: `blob:` URLs of files picked on the phone. They do not
   survive a reload; restoring them would show a dead thumbnail. The
   server-side file NAME stays valid and is kept, so an already
   uploaded source is still there on return.
   ============================================================ */
import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { loadDraft, saveDraft, saveDraftSoon } from './draft'

const KEY = 'default:create'

interface Snapshot {
  mode: unknown
  userPrompt: string
  promptTouched: boolean
  photo: Record<string, unknown>
  video: Record<string, unknown>
  batchCount: number
  seedMode: unknown
  seedValue: unknown
}

/** Strips local URLs (blob:) from a selections object: they are dead
 *  after a reload. `*File` fields (server-side names) and `*AssetId`
 *  survive. */
function stripBlobs<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = { ...o }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.startsWith('blob:')) out[k] = ''
  }
  return out as T
}

export function useDraftPersistence() {
  const restored = useRef(false)

  // ---- restore, once on mount ----
  useEffect(() => {
    void (async () => {
      const d = await loadDraft<Snapshot>(KEY)
      if (d) {
        const st = useAppStore.getState()
        useAppStore.setState({
          mode: (d.mode as typeof st.mode) ?? st.mode,
          userPrompt: d.userPrompt ?? '',
          promptTouched: !!d.promptTouched,
          photo: { ...st.photo, ...stripBlobs(d.photo ?? {}) } as typeof st.photo,
          video: { ...st.video, ...stripBlobs(d.video ?? {}) } as typeof st.video,
          batchCount: d.batchCount ?? st.batchCount,
          seedMode: (d.seedMode as typeof st.seedMode) ?? st.seedMode,
          seedValue: (d.seedValue as typeof st.seedValue) ?? st.seedValue,
        })
      }
      restored.current = true
    })()
  }, [])

  // ---- debounced save on each change ----
  useEffect(() => useAppStore.subscribe(st => {
    // Never write BEFORE restoring: it would overwrite the saved draft
    // with the store's default state.
    if (!restored.current) return
    const snap: Snapshot = {
      mode: st.mode,
      userPrompt: st.userPrompt, promptTouched: st.promptTouched,
      photo: stripBlobs(st.photo as unknown as Record<string, unknown>),
      video: stripBlobs(st.video as unknown as Record<string, unknown>),
      batchCount: st.batchCount, seedMode: st.seedMode, seedValue: st.seedValue,
    }
    saveDraftSoon(KEY, 'default', snap)
  }), [])

  // ---- IMMEDIATE write when the page goes to the background ----
  useEffect(() => {
    const flush = () => {
      if (!restored.current) return
      const st = useAppStore.getState()
      void saveDraft(KEY, 'default', {
        mode: st.mode,
        userPrompt: st.userPrompt, promptTouched: st.promptTouched,
        photo: stripBlobs(st.photo as unknown as Record<string, unknown>),
        video: stripBlobs(st.video as unknown as Record<string, unknown>),
        batchCount: st.batchCount, seedMode: st.seedMode, seedValue: st.seedValue,
      } satisfies Snapshot)
    }
    /* `visibilitychange` rather than `beforeunload`: on iOS the app is
       often suspended without ever firing `beforeunload`. */
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])
}
