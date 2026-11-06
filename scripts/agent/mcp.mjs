#!/usr/bin/env node
/* ============================================================
   Serveur MCP du studio : Claude Code, Claude Desktop, Cursor ou tout
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
  { name: 'list_dances', description: 'The dance catalogue (motion-captured dances, by slug) and the 3D studios they can be performed in.',
    inputSchema: { type: 'object', properties: {} }, lancer: () => s.danses() },
  { name: 'dance', description: 'The character of a library photo performs a catalogue dance in a 3D studio. Two chained jobs (3D scene, then identity swap), about 6 min: returns both ids; the finished clip is on finalJobId.',
    inputSchema: { type: 'object', properties: {
      photo: { type: 'string', description: 'Library id of a full-body photo of the character.' },
      dance: { type: 'string', description: 'Dance slug from list_dances.' },
      studio: { type: 'string', description: 'Studio id from list_dances (cabaret, loft, tokyo…).' },
      description: { type: 'string', description: 'Optional: how the step is done, when the name alone is ambiguous (e.g. the moonwalk).' },
      followFace: { type: 'boolean', default: false, description: 'Crop the final clip around her face.' },
      wait: { type: 'boolean', default: false },
    }, required: ['photo', 'dance', 'studio'] },
    lancer: async a => { const r = await s.danse({ photo: a.photo, danse: a.dance, studio: a.studio, description: a.description, suivi: a.followFace }); return a.wait ? s.attendreJob(r.finalJobId, { maxMs: 60 * 60_000 }) : { ...r, status: 'queued' } } },
  { name: 'generate_music', description: 'Compose a music track (two takes) or a sound effect. Tempo and key follow the style; lyrics in any language, plain or with [Verse]/[Chorus] tags. Files join the music list used by edits and reels (list_music).',
    inputSchema: { type: 'object', properties: {
      style: { type: 'string', description: 'Genre, instruments, mood, optional "120 bpm"; for a sound effect, the sound itself.' },
      lyrics: { type: 'string', description: 'Optional lyrics; empty = instrumental.' },
      seconds: { type: 'number', default: 30, description: 'Music 5-120 s, sound effect 2-20 s.' },
      soundEffect: { type: 'boolean', default: false }, wait: { type: 'boolean', default: true },
    }, required: ['style'] },
    lancer: async a => { const { jobId } = await s.musique({ style: a.style, paroles: a.lyrics, secondes: a.seconds, bruitage: a.soundEffect }); return a.wait === false ? { jobId, status: 'queued' } : { ...(await s.attendreJob(jobId)), music: (await s.musiques()).filter(m => m.file.includes(`_${jobId.slice(-6)}`)) } } },
  { name: 'list_music', description: 'Music and audio files available for edits and talking clips.',
    inputSchema: { type: 'object', properties: {} }, lancer: () => s.musiques() },
  { name: 'list_voices', description: 'Synthetic voices available for speak.',
    inputSchema: { type: 'object', properties: {} }, lancer: () => s.voix() },
  { name: 'speak', description: 'Say a sentence with a synthetic voice. Returns an audio file name to pass to talking_clip.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string' }, voice: { type: 'string', description: 'Voice id from list_voices, or "perso" for the character voice.' },
    }, required: ['text', 'voice'] },
    lancer: a => s.dire({ texte: a.text, voix: a.voice }) },
  { name: 'talking_clip', description: 'Make a library photo speak an audio file (from speak). Several minutes: returns a job id.',
    inputSchema: { type: 'object', properties: {
      photo: { type: 'string', description: 'Library id of the photo.' },
      audio: { type: 'string', description: 'Audio file name returned by speak.' },
      text: { type: 'string', description: 'What is said (helps lip sync and the scene).' },
      wait: { type: 'boolean', default: false },
    }, required: ['photo', 'audio'] },
    lancer: async a => { const { jobId } = await s.parole({ photo: a.photo, audio: a.audio, texte: a.text }); return a.wait ? s.attendreJob(jobId) : { jobId, status: 'queued' } } },
  { name: 'edit_video', description: 'Rework a library clip. mode "effect": one-click LTX effect (refine-details, day-to-night, deblur, decompression). mode "modify"/"remove": an element named in English (tracked by SAM3) is changed into the prompt, or removed. mode "background": the background around the person is replaced by the prompt.',
    inputSchema: { type: 'object', properties: {
      clip: { type: 'string', description: 'Library id of the clip.' },
      mode: { type: 'string', enum: ['effect', 'modify', 'remove', 'background'] },
      effect: { type: 'string', enum: ['refine-details', 'day-to-night', 'deblur', 'decompression'] },
      target: { type: 'string', description: 'modify/remove: the element, in English (e.g. "red car").' },
      prompt: { type: 'string', description: 'modify: what it becomes; background: the new background; day-to-night: optional night details.' },
      wait: { type: 'boolean', default: false },
    }, required: ['clip', 'mode'] },
    lancer: async a => {
      const mode = { effect: 'effet', modify: 'modifier', remove: 'retirer', background: 'fond' }[a.mode]
      if (!mode) throw new Error('mode must be effect, modify, remove or background')
      const { jobId } = await s.editionVideo({ clip: a.clip, mode, effet: a.effect, cible: a.target, prompt: a.prompt })
      return a.wait ? s.attendreJob(jobId) : { jobId, status: 'queued' }
    } },
]

const ecrire = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')

async function traiter(m) {
  const { id, method, params } = m
  if (id === undefined) return   // notification (notifications/initialized…) : rien à rendre
  try {
    if (method === 'initialize')
      return ecrire({ id, result: { protocolVersion: params?.protocolVersion ?? VERSION_PROTOCOLE, capabilities: { tools: {} },
        serverInfo: { name: 'creatoros-studio', version: '1.1.0' },
        instructions: 'Renders photos, clips, dances, music, talking clips and reels on a CreatorOS Studio instance (SFW only). Start with machine_status, then generate_photo; feed its library id to image_to_video, dance or talking_clip. Long jobs return an id: poll get_status. One GPU: jobs run one after another.' } })
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
