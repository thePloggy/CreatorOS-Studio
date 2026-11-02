/* ============================================================
   Notifications au propriétaire — sur son téléphone, par ntfy.

   CREATOROS_NOTIF_URL = l'adresse d'un sujet ntfy (https://ntfy.sh/<sujet>,
   ou un serveur ntfy à soi). Sans elle, rien ne part : la notification reste
   une ligne du journal du serveur. Le message ne porte rien de personnel :
   le type de rendu, sa durée ou sa cause d'échec, jamais d'empreinte ni
   d'adresse de visiteur.
   ============================================================ */
const URL_NOTIF = process.env.CREATOROS_NOTIF_URL || ''

export const notificationsActives = () => !!URL_NOTIF

/** Envoie une notification ; ne lève jamais (une panne de ntfy ne touche pas au rendu). */
export async function notifier(titre, message, { tags = [], priorite = 3 } = {}) {
  console.log(`[notif] ${titre} — ${message}`)
  if (!URL_NOTIF) return
  try {
    const u = new URL(URL_NOTIF)
    // publication JSON : titre et message en UTF-8 sans passer par les en-têtes
    const r = await fetch(u.origin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: u.pathname.replace(/^\/+/, ''), title: titre, message, tags, priority: priorite }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) console.warn(`[notif] ntfy a répondu ${r.status}`)
  } catch (e) { console.warn(`[notif] non envoyée : ${String(e?.message ?? e).slice(0, 200)}`) }
}
