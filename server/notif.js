/* ============================================================
   Owner notifications, to their phone, via ntfy.

   CREATOROS_NOTIF_URL = a ntfy topic URL (https://ntfy.sh/<topic>, or a
   self-hosted ntfy server). Without it nothing is sent: the notification is
   just a server log line. The message carries nothing personal: render type,
   duration or failure cause, never a visitor fingerprint or address.
   ============================================================ */
const URL_NOTIF = process.env.CREATOROS_NOTIF_URL || ''

export const notificationsActives = () => !!URL_NOTIF

/** Sends a notification; never throws (an ntfy outage does not affect the render). */
export async function notifier(titre, message, { tags = [], priorite = 3 } = {}) {
  console.log(`[notif] ${titre} — ${message}`)
  if (!URL_NOTIF) return
  try {
    const u = new URL(URL_NOTIF)
    // JSON publish: UTF-8 title and message without going through headers
    const r = await fetch(u.origin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: u.pathname.replace(/^\/+/, ''), title: titre, message, tags, priority: priorite }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) console.warn(`[notif] ntfy a répondu ${r.status}`)
  } catch (e) { console.warn(`[notif] non envoyée : ${String(e?.message ?? e).slice(0, 200)}`) }
}
