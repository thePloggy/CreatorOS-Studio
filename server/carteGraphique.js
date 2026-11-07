/* ============================================================
   Carte graphique : NVIDIA (nvidia-smi) ou AMD (rocm-smi, ROCm).

   Le reste du studio parle à ComfyUI en HTTP et ne dépend pas du fabricant.
   Ce module sert aux jauges, au diagnostic, au profil de VRAM et au choix des
   poids (allege.js : sur ROCm, les fichiers int8-convrot et nvfp4 sont
   remplacés par leur version bf16 officielle).

   CREATOROS_GPU=nvidia|amd force le fabricant ; sinon il est déduit de l'outil
   présent (nvidia-smi d'abord). Lu une fois.
   ============================================================ */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let fab
/** 'nvidia', 'amd' ou null (aucun outil trouvé). */
export function fabricant() {
  if (fab !== undefined) return fab
  const force = String(process.env.CREATOROS_GPU || '').toLowerCase()
  if (force === 'nvidia' || force === 'amd') return (fab = force)
  const marche = (cmd, args) => { try { execFileSync(cmd, args, { timeout: 4000, stdio: 'ignore' }); return true } catch { return false } }
  fab = marche('nvidia-smi', ['-L']) ? 'nvidia' : marche('rocm-smi', ['--showproductname']) ? 'amd' : null
  return fab
}
export const estAmd = () => fabricant() === 'amd'

/* rocm-smi --json : une clé par carte (card0, card1…), des libellés qui varient
   un peu selon la version de ROCm : on les cherche par motif. */
function champ(carte, motif) {
  const k = Object.keys(carte).find(x => motif.test(x))
  return k === undefined ? undefined : carte[k]
}
function cartesRocm(json) {
  return Object.entries(json).filter(([k]) => /^card\d+$/.test(k)).map(([, v]) => v)
}

/** Première carte : { nom, util (%), temp (°C), memUtiliseeMo, memTotaleMo } ; null si illisible. */
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
  } catch { /* outil absent ou sortie inattendue */ }
  return null
}

/** Nom, pilote et VRAM totale (Go) pour le diagnostic ; null si aucune carte lisible. */
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
      try { pilote = (await execFileAsync('rocm-smi', ['--showdriverversion', '--json'], { timeout: 4000 })).stdout.match(/"Driver version"\s*:\s*"([^"]+)"/i)?.[1] ?? null } catch { /* facultatif */ }
      return m ? { fabricant: 'amd', nom: m.nom, pilote, vramGo: Math.round(m.memTotaleMo / 1024) } : null
    }
  } catch { /* outil en échec */ }
  return null
}

/** VRAM totale de la première carte, en Go, de façon synchrone (lecture au démarrage). 0 si inconnue. */
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
  } catch { /* outil absent */ }
  return 0
}
