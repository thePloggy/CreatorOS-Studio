/* ============================================================
   Mobile drafts: local persistence.

   IndexedDB rather than localStorage: localStorage's quota is small
   and its synchronous API blocks the thread while typing. Only SMALL
   data is stored here (text, settings, source references), never
   media: an un-uploaded local file stays a reference.

   Nothing stored here means a job was accepted. The server is the
   source of truth for jobs and media.
   ============================================================ */

const DB_NAME = 'creatoros-m'
const STORE = 'drafts'
/** Draft SCHEMA version (≠ IndexedDB version): a draft written by an
 *  earlier version is migrated field by field, never wiped wholesale
 *  (migrate or recover compatible fields). */
export const DRAFT_SCHEMA = 1

export interface DraftRow<T = unknown> {
  key: string            // `${personaId}:${type}:${operation}[:${replayMode}]`
  schema: number
  personaId: string
  data: T
  updatedAt: number
}

let dbp: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp
  dbp = new Promise(resolve => {
    try {
      const rq = indexedDB.open(DB_NAME, 1)
      rq.onupgradeneeded = () => {
        const db = rq.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      rq.onsuccess = () => resolve(rq.result)
      // Private browsing, storage refused, quota full: fall back to
      // memory rather than break input. The caller is informed through
      // `storageAvailable()` to show the warning.
      rq.onerror = () => resolve(null)
      rq.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return dbp
}

const mem = new Map<string, DraftRow>()
let degraded = false
/** false when the draft can NOT be stored durably: the UI must say so
 *  and offer to copy the prompt. */
export const storageAvailable = () => !degraded

export async function saveDraft<T>(key: string, personaId: string, data: T): Promise<void> {
  const row: DraftRow<T> = { key, schema: DRAFT_SCHEMA, personaId, data, updatedAt: Date.now() }
  mem.set(key, row as DraftRow)
  const db = await open()
  if (!db) { degraded = true; return }
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(row)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
      tx.onabort = () => rej(tx.error)
    })
  } catch { degraded = true }
}

export async function loadDraft<T>(key: string): Promise<T | null> {
  const db = await open()
  if (!db) { degraded = true; return (mem.get(key)?.data as T) ?? null }
  try {
    const row = await new Promise<DraftRow<T> | undefined>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly')
      const rq = tx.objectStore(STORE).get(key)
      rq.onsuccess = () => res(rq.result as DraftRow<T> | undefined)
      rq.onerror = () => rej(rq.error)
    })
    if (!row) return null
    // Older schema: fields are returned anyway, the caller fills in
    // its defaults. Never a silent reset.
    return row.data ?? null
  } catch { return (mem.get(key)?.data as T) ?? null }
}

/** DEBOUNCED write while typing: one `put` per keystroke would flood
 *  IndexedDB. Critical calls (navigation, submit) use `saveDraft`
 *  directly, which writes immediately. */
const timers = new Map<string, number>()
export function saveDraftSoon<T>(key: string, personaId: string, data: T, delay = 600) {
  window.clearTimeout(timers.get(key))
  timers.set(key, window.setTimeout(() => { void saveDraft(key, personaId, data) }, delay))
}
export function flushDraft(key: string) {
  const t = timers.get(key)
  if (t) { window.clearTimeout(t); timers.delete(key) }
}

/* ---------- submit idempotency key ----------
   Generated BEFORE the first POST and kept until resolved: a transport
   retry reuses the same key, and the server (unique index on
   request_id) then returns the already-created job instead of opening a
   second one. A NEW render intent requires a new explicit user action,
   hence a new key. */
export function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch { /* environment without WebCrypto */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
