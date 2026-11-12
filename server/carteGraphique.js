/* ============================================================
   Graphics backend: NVIDIA (nvidia-smi, CUDA), AMD (rocm-smi, ROCm) or
   Apple Silicon (macOS, Metal / MPS).

   The rest of the studio talks to ComfyUI over HTTP and does not depend on the
   vendor. This module feeds the gauges, the diagnostic, the VRAM profile and
   the choice of weights (allege.js: without CUDA, the int8-convrot and nvfp4
   files are replaced by their official bf16 version or a GGUF).

   CREATOROS_GPU=nvidia|amd|apple forces the backend; otherwise it is deduced
   from the machine (macOS on arm64 = apple, then nvidia-smi, then rocm-smi).
   Read once.
   ============================================================ */
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/* On a Mac the GPU shares the system memory. The studio plans for 55 % of it:
   macOS, the browser, the text encoder kept in RAM and the local LLM need the rest.
   CREATOROS_MAC_BUDGET (0.3 to 0.9) changes that share. */
const part = Number(process.env.CREATOROS_MAC_BUDGET)
export const PART_MEMOIRE_MAC = part >= 0.3 && part <= 0.9 ? part : 0.55
/** Bytes of unified memory the studio may plan for on a Mac. */
export const budgetMac = (totalOctets = os.totalmem()) => Math.round(totalOctets * PART_MEMOIRE_MAC)

let fab
/** 'nvidia', 'amd', 'apple' or null (nothing found). */
export function fabricant() {
  if (fab !== undefined) return fab
  const force = String(process.env.CREATOROS_GPU || '').toLowerCase()
  if (force === 'nvidia' || force === 'amd' || force === 'apple') return (fab = force)
  if (process.platform === 'darwin') return (fab = process.arch === 'arm64' ? 'apple' : null)
  const marche = (cmd, args) => { try { execFileSync(cmd, args, { timeout: 4000, stdio: 'ignore' }); return true } catch { return false } }
  fab = marche('nvidia-smi', ['-L']) ? 'nvidia' : marche('rocm-smi', ['--showproductname']) ? 'amd' : null
  return fab
}
export const estAmd = () => fabricant() === 'amd'
export const estApple = () => fabricant() === 'apple'
/** No CUDA kernels on this machine: AMD (ROCm) or Apple Silicon (MPS). */
export const sansCuda = () => estAmd() || estApple()

/* rocm-smi --json: one key per card (card0, card1…), labels that vary a little
   between ROCm versions: they are looked up by pattern. */
function champ(carte, motif) {
  const k = Object.keys(carte).find(x => motif.test(x))
  return k === undefined ? undefined : carte[k]
}
function cartesRocm(json) {
  return Object.entries(json).filter(([k]) => /^card\d+$/.test(k)).map(([, v]) => v)
}

/* macOS: chip name from sysctl, memory in use from vm_stat (active + wired + compressed pages). */
let puce
function nomPuce() {
  if (puce !== undefined) return puce
  try { puce = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 3000, encoding: 'utf8' }).trim() || 'Apple Silicon' }
  catch { puce = 'Apple Silicon' }
  return puce
}
/** Parses `vm_stat` output into bytes in use; null if unreadable. Exported for the tests. */
export function memoireUtiliseeVmStat(texte) {
  const page = Number(texte.match(/page size of (\d+) bytes/)?.[1]) || 16384
  const pages = motif => Number(texte.match(motif)?.[1]) || 0
  const n = pages(/Pages active:\s+(\d+)/) + pages(/Pages wired down:\s+(\d+)/) + pages(/Pages occupied by compressor:\s+(\d+)/)
  return n ? n * page : null
}
async function memoireUtiliseeMac() {
  try { return memoireUtiliseeVmStat((await execFileAsync('vm_stat', [], { timeout: 3000 })).stdout) } catch { return null }
}

/** First card: { nom, util (%), temp (°C), memUtiliseeMo, memTotaleMo }; null if unreadable.
 *  On a Mac, load and temperature are not readable without root: they stay null. */
export async function mesures() {
  try {
    if (fabricant() === 'nvidia') {
      const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name',
        '--format=csv,noheader,nounits'], { timeout: 4000 })
      const [util, temp, used, total, nom] = stdout.split('\n')[0].split(',').map(s => s.trim())
      return { nom, util: Number(util) || 0, temp: Number(temp) || 0, memUtiliseeMo: Number(used) || 0, memTotaleMo: Number(total) || 0 }
    }
    if (fabricant() === 'amd') {
      const { stdout } = await execFileAsync('rocm-smi', ['--showuse', '--showtemp', '--showmeminfo', 'vram', '--showproductname', '--json'], { timeout: 6000 })
      const c = cartesRocm(JSON.parse(stdout))[0]
      if (!c) return null
      const octets = v => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0
      return {
        nom: String(champ(c, /card series|card model|product name/i) ?? 'AMD GPU').trim(),
        util: Math.round(Number(String(champ(c, /gpu use/i) ?? '0').replace(/[^\d.]/g, '')) || 0),
        temp: Math.round(Number(String(champ(c, /temperature.*(edge|junction)/i) ?? '0').replace(/[^\d.]/g, '')) || 0),
        memUtiliseeMo: Math.round(octets(champ(c, /vram total used memory/i)) / 2 ** 20),
        memTotaleMo: Math.round(octets(champ(c, /vram total memory/i)) / 2 ** 20),
      }
    }
    if (fabricant() === 'apple') {
      const utilisee = await memoireUtiliseeMac()
      return { nom: nomPuce(), util: null, temp: null, memUtiliseeMo: utilisee === null ? null : Math.round(utilisee / 2 ** 20), memTotaleMo: Math.round(os.totalmem() / 2 ** 20) }
    }
  } catch { /* tool missing or unexpected output */ }
  return null
}

/** Name, driver and total VRAM (GB) for the diagnostic; null if no card is readable.
 *  On a Mac, vramGo is the planned share of the unified memory and memoireGo the whole of it. */
export async function identite() {
  try {
    if (fabricant() === 'nvidia') {
      const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], { timeout: 4000 })
      const [nom, pilote, mem] = stdout.split('\n')[0].split(',').map(s => s.trim())
      return { fabricant: 'nvidia', nom, pilote, vramGo: Math.round(parseFloat(mem) / 1024) || 0 }
    }
    if (fabricant() === 'amd') {
      const m = await mesures()
      let pilote = null
      try { pilote = (await execFileAsync('rocm-smi', ['--showdriverversion', '--json'], { timeout: 4000 })).stdout.match(/"Driver version"\s*:\s*"([^"]+)"/i)?.[1] ?? null } catch { /* optional */ }
      return m ? { fabricant: 'amd', nom: m.nom, pilote, vramGo: Math.round(m.memTotaleMo / 1024) } : null
    }
    if (fabricant() === 'apple') {
      let macos = null
      try { macos = (await execFileAsync('sw_vers', ['-productVersion'], { timeout: 3000 })).stdout.trim() } catch { /* optional */ }
      return { fabricant: 'apple', nom: nomPuce(), pilote: macos ? `macOS ${macos}, Metal` : 'Metal', vramGo: Math.round(budgetMac() / 2 ** 30), memoireGo: Math.round(os.totalmem() / 2 ** 30) }
    }
  } catch { /* tool failed */ }
  return null
}

/** Total VRAM of the first card, in GB, synchronously (read at start-up). 0 if unknown.
 *  On a Mac: the planned share of the unified memory. */
export function vramGoSync() {
  try {
    if (fabricant() === 'nvidia') {
      const mo = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, encoding: 'utf8' })
      return Math.round(Number(mo.split('\n')[0]) / 1024) || 0
    }
    if (fabricant() === 'amd') {
      const out = execFileSync('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeout: 4000, encoding: 'utf8' })
      const c = cartesRocm(JSON.parse(out))[0]
      return c ? Math.round(Number(String(champ(c, /vram total memory/i) ?? '0').replace(/[^\d]/g, '')) / 2 ** 30) || 0 : 0
    }
    if (fabricant() === 'apple') return Math.round(budgetMac() / 2 ** 30)
  } catch { /* tool missing */ }
  return 0
}
