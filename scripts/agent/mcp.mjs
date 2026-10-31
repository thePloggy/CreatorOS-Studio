#!/usr/bin/env node
/* ============================================================
   Serveur MCP du studio (30/10) : Claude Code, Claude Desktop, Cursor ou tout
   client MCP peut lancer photos, vidéos et reels sur un studio qui tourne.

   Transport stdio, JSON-RPC 2.0, une ligne par message. Écrit à la main
   (initialize, tools/list, tools/call, ping) pour ne pas ajouter de dépendance.
   Les outils ne font qu'appeler l'API HTTP du studio (client.mjs) : mêmes
   contrôles que l'interface (filtre de contenu, file, quota).

   claude mcp add creatoros-studio -- node /chemin/vers/scripts/agent/mcp.mjs
   ============================================================ */
import readline from 'node:readline'
import { client } from './client.mjs'

const s = client()
const VERSION_PROTOCOLE = '2025-06-18'

const OUTILS = [
  { name: 'generate_photo', description: 'Render one photo from a prompt written as it should be rendered (SFW only). Takes about 15-60 s; waits by default and returns the image URL.',
    inputSchema: { type: 'object', properties: {
      prompt: { type: 'string', description: 'What the photo shows: subject, action, place, light, framing.' },
      character: { type: 'string', description: 'Character id (see list_characters). Default: the active one.' },
      width: { type: 'integer', default: 768 }, height: { type: 'integer', default: 1344 },
      wait: { type: 'boolean', default: true, description: 'Wait for the render; false returns the job id at once.' },
    }, required: ['prompt'] },
    lancer: async a => { const { jobId } = await s.photo({ prompt: a.prompt, persona: a.character, largeur: a.width, hauteur: a.height }); return a.wait === false ? { jobId, status: 'queued' } : s.attendreJob(jobId) } },
  { name: 'image_to_video', description: 'Animate a library image into a short clip with a described motion. Takes several minutes: returns a job id unless wait is true; poll get_status.',
    inputSchema: { type: 'object', properties: {
      image: { type: 'string', description: 'Library id of the start image (from generate_photo or list_library).' },
      motion: { type: 'string', description: 'One continuous action and camera move, e.g. "she turns a page, slow push-in".' },
      engine: { type: 'string', enum: ['ltx_hq', 'wan'], default: 'ltx_hq' },
      seconds: { type: 'number', description: 'Clip length; the engine clamps it.' },
      audio: { type: 'boolean', default: true }, wait: { type: 'boolean', default: false },
    }, required: ['image', 'motion'] },
    lancer: async a => { const { jobId } = await s.video({ image: a.image, geste: a.motion, moteur: a.engine, secondes: a.seconds, son: a.audio !== false }); return a.wait ? s.attendreJob(jobId) : { jobId, status: 'queued' } } },
  { name: 'make_reel', description: 'Make a finished vertical reel from a one-line brief: shots are written and checked, photos and clips rendered, then edited with a hook caption. Takes 10-30 min: returns a reel id; poll get_status.',
    inputSchema: { type: 'object', properties: {
      brief: { type: 'string', description: 'Place, mood and what happens, in one or two sentences.' },
      shots: { type: 'integer', minimum: 3, maximum: 6, default: 4 },
      language: { type: 'string', enum: ['en', 'fr'], default: 'en', description: 'Language of the hook caption.' },
    }, required: ['brief'] },
    lancer: a => s.reel({ brief: a.brief, plans: a.shots, langue: a.language }) },
  { name: 'get_status', description: 'Status of a job (photo or video) or a reel, with media URLs once done.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A job id or a reel id (reel-…).' } }, required: ['id'] },
    lancer: a => String(a.id).startsWith('reel-') ? s.etatReel(a.id) : s.job(a.id) },
  { name: 'list_library', description: 'The most recent photos and videos in the library, with their ids and URLs.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer', default: 10, maximum: 200 } } },
    lancer: a => s.bibliotheque({ n: a.n ?? 10 }) },
  { name: 'list_characters', description: 'Characters available for photos, and the active one.',
    inputSchema: { type: 'object', properties: {} }, lancer: () => s.personas() },
  { name: 'machine_status', description: 'ComfyUI link, render queue length, GPU and VRAM profile, available video engines.',
    inputSchema: { type: 'object', properties: {} }, lancer: () => s.machine() },
]

const ecrire = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')

async function traiter(m) {
  const { id, method, params } = m
  if (id === undefined) return   // notification (notifications/initialized…) : rien à rendre
  try {
    if (method === 'initialize')
      return ecrire({ id, result: { protocolVersion: params?.protocolVersion ?? VERSION_PROTOCOLE, capabilities: { tools: {} },
        serverInfo: { name: 'creatoros-studio', version: '1.0.0' },
        instructions: 'Renders photos, clips and reels on a CreatorOS Studio instance (SFW only). Start with machine_status, then generate_photo; feed its library id to image_to_video. Long jobs return an id: poll get_status.' } })
    if (method === 'ping') return ecrire({ id, result: {} })
    if (method === 'tools/list') return ecrire({ id, result: { tools: OUTILS.map(({ lancer, ...o }) => o) } })
    if (method === 'tools/call') {
      const o = OUTILS.find(x => x.name === params?.name)
      if (!o) return ecrire({ id, error: { code: -32602, message: `unknown tool: ${params?.name}` } })
      try {
        const r = await o.lancer(params.arguments ?? {})
        return ecrire({ id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }], structuredContent: Array.isArray(r) ? { items: r } : r } })
      } catch (e) {
        // une erreur d'outil (filtre, studio absent) est un résultat lisible par le modèle, pas une erreur de protocole
        return ecrire({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } })
      }
    }
    ecrire({ id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (e) {
    ecrire({ id, error: { code: -32603, message: String(e.message || e) } })
  }
}

readline.createInterface({ input: process.stdin }).on('line', l => {
  if (!l.trim()) return
  let m
  try { m = JSON.parse(l) } catch { return ecrire({ id: null, error: { code: -32700, message: 'parse error' } }) }
  void traiter(m)
})
