/* ============================================================
   Brouillons mobiles — persistance locale.

   Pourquoi IndexedDB et pas localStorage : le quota de localStorage est
   petit et son API synchrone bloque le thread pendant la saisie. On stocke
   ici de PETITES données (texte, réglages, références de sources), jamais
   de médias — un fichier local non transféré reste une référence, pas un
   octet conservé.

   Règle cardinale : rien de ce qui est conservé ici ne vaut acceptation
   d'un job. La vérité des jobs et des médias est au serveur.
   ============================================================ */

const DB_NAME = 'creatoros-m'
const STORE = 'drafts'
/** Version de SCHÉMA des brouillons (≠ version d'IndexedDB) : un brouillon
 *  écrit par une version antérieure est migré champ à champ, jamais effacé
 *  en bloc (migrer ou récupérer les champs compatibles). */
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
      // Navigation privée, stockage refusé, quota plein : on dégrade en
      // mémoire plutôt que de casser la saisie. L'appelant est prévenu par
      // `storageAvailable()` pour afficher l'avertissement.
      rq.onerror = () => resolve(null)
      rq.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return dbp
}

const mem = new Map<string, DraftRow>()
let degraded = false
/** false quand le brouillon ne peut PAS être conservé durablement — l'UI doit
 *  le dire et proposer de copier le prompt. */
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
    // Schéma plus ancien : on rend quand même les champs, l'appelant complète
    // avec ses valeurs par défaut. Jamais de reset silencieux.
    return row.data ?? null
  } catch { return (mem.get(key)?.data as T) ?? null }
}

/** Écriture DIFFÉRÉE pendant la frappe : un `put` par caractère saturerait
 *  IndexedDB pour rien. Les appels critiques (navigation, envoi) passent par
 *  `saveDraft` directement, qui écrit tout de suite. */
const timers = new Map<string, number>()
export function saveDraftSoon<T>(key: string, personaId: string, data: T, delay = 600) {
  window.clearTimeout(timers.get(key))
  timers.set(key, window.setTimeout(() => { void saveDraft(key, personaId, data) }, delay))
}
export function flushDraft(key: string) {
  const t = timers.get(key)
  if (t) { window.clearTimeout(t); timers.delete(key) }
}

/* ---------- clé d'idempotence d'envoi ----------
   Générée AVANT le premier POST et conservée jusqu'à résolution : une reprise
   de transport réutilise la même clé, et le serveur (index unique sur
   request_id) rend alors le job déjà créé au lieu d'en ouvrir un second.
   Une NOUVELLE intention de rendu demande une nouvelle action explicite de
   l'utilisateur, donc une nouvelle clé. */
export function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch { /* environnement sans WebCrypto */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
