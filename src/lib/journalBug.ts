/* Bug report log: the browser's latest errors, plus GET /api/journal-bug
   (version, system, ComfyUI state, latest failures), as one text to paste
   into a GitHub issue. Contains nothing private. */
const erreurs: string[] = []
const garder = (x: string) => { erreurs.push(`${new Date().toISOString()} ${x.slice(0, 300)}`); if (erreurs.length > 20) erreurs.shift() }

/** Install once at startup. */
export function ecouterErreurs() {
  window.addEventListener('error', e => garder(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`))
  window.addEventListener('unhandledrejection', e => garder(`promesse rejetée : ${String((e.reason as Error)?.message ?? e.reason)}`))
}

/** The log text, ready to paste. */
export async function journalBug(): Promise<string> {
  let serveur: unknown = null
  try { serveur = await (await fetch('/api/journal-bug', { signal: AbortSignal.timeout(30_000) })).json() } catch (e) { serveur = { erreur: String((e as Error).message) } }
  const nav = { navigateur: navigator.userAgent, ecran: `${window.innerWidth}×${window.innerHeight}`, langue: navigator.language, page: location.pathname + location.search }
  return ['### CreatorOS Studio — bug report', '```json', JSON.stringify({ ...((serveur as object) ?? {}), ...nav, erreursNavigateur: erreurs }, null, 2), '```'].join('\n')
}
