/* ============================================================
   Machines modestes — la même recette, des poids plus légers.

   Les recettes sont écrites pour une carte de 24 Go et plus. Sur une carte
   plus petite, juste avant l'envoi à ComfyUI, chaque chargeur de modèle lourd
   est remplacé par une variante allégée du même modèle : FLUX.2 Klein 4B au
   lieu du 9B, Wan 2.2 en GGUF Q4 au lieu du fp8. Le graphe ne change pas
   autrement : mêmes nœuds, mêmes réglages, même sortie.

   Le profil vient de CREATOROS_VRAM (24, 16, 12 ou 8), ou est déduit de la
   carte que ComfyUI déclare (/system_stats). Une variante n'est employée que
   si son fichier est installé ; sinon une variante plus légère encore, sinon
   le modèle d'origine (ComfyUI décharge alors par morceaux, plus lentement).

   Seules les variantes vérifiées sont dans le manifeste : une variante
   non vérifiée qui casse un rendu coûte plus cher qu'un rendu lent.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONFIG } from './config.js'

/** Profils, du plus grand au plus petit (Go de VRAM visés). */
export const PROFILS = [24, 16, 12, 8]
/** Côté long maximal d'une vidéo Wan au profil 8 Go (480p). */
const WAN_COTE_8GO = 832

/* Les variantes viennent du manifeste de l'assistant d'installation : une seule liste
   pour ce qu'on télécharge et ce qu'on emploie. Sur l'original, `tient` = le plus petit
   profil où il passe encore (modèle + ~3 Go d'activations) ; sur la variante, `leger` =
   { remplace, pour : plus petit profil où elle passe, chargeur : classe de nœud qui la
   lit (GGUF : pack ComfyUI-GGUF), suit : ne sert qu'avec ce fichier }. */
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'installer', 'modeles.json'), 'utf8'))
const VARIANTES = {}
for (const v of MANIFESTE.modeles.filter(m => m.leger)) {
  const orig = MANIFESTE.modeles.find(m => m.chemin.split('/').pop() === v.leger.remplace)
  const e = (VARIANTES[v.leger.remplace] ??= { tient: orig?.tient ?? 24, variantes: [] })
  e.variantes.push({ pour: v.leger.pour, fichier: v.chemin.split('/').pop(), chargeur: v.leger.chargeur, suit: v.leger.suit })
}

/* Le nom d'entrée de chaque chargeur, et ses entrées propres. */
const ENTREE = { UNETLoader: 'unet_name', UnetLoaderGGUF: 'unet_name', CLIPLoader: 'clip_name', CLIPLoaderGGUF: 'clip_name' }

/** Profil d'une carte de `octets` de VRAM : la plus grande marche qu'elle atteint. */
export function profilDe(octets) {
  const go = octets / 2 ** 30
  if (!go) return 24
  return go >= 22 ? 24 : go >= 14 ? 16 : go >= 10 ? 12 : 8
}

let carte = { at: 0, profil: null, vram: 0 }
let installes = { at: 0, parClasse: {} }
const comfyJson = async (p, ms = 15_000) => (await fetch(CONFIG.comfyUrl + p, { signal: AbortSignal.timeout(ms) })).json()

/** Profil forcé pour le job en cours (réservé au propriétaire : job.profilVram), posé par jobs.js. */
export const profilDuJob = new AsyncLocalStorage()

/** Le profil en vigueur : celui du job s'il en force un, CREATOROS_VRAM, sinon la carte vue par ComfyUI (relue toutes les 10 min). */
export async function profilActuel() {
  const duJob = profilDuJob.getStore()
  if (PROFILS.includes(duJob)) return { profil: duJob, source: 'job', vram: carte.vram }
  const force = Number(process.env.CREATOROS_VRAM)
  if (PROFILS.includes(force)) return { profil: force, source: 'CREATOROS_VRAM', vram: carte.vram }
  if (Date.now() - carte.at > 600_000) {
    try {
      const d = (await comfyJson('/system_stats', 5000))?.devices?.[0]
      carte = { at: Date.now(), vram: d?.vram_total ?? 0, profil: profilDe(d?.vram_total ?? 0) }
    } catch { carte = { ...carte, at: Date.now() - 540_000 } }  // ComfyUI absent : on réessaie dans une minute
  }
  return { profil: carte.profil ?? 24, source: 'carte', vram: carte.vram }
}

/** Les fichiers que ComfyUI voit pour un chargeur (relu toutes les 2 min). */
async function fichiersDe(classe) {
  if (Date.now() - installes.at > 120_000) installes = { at: Date.now(), parClasse: {} }
  if (!installes.parClasse[classe]) {
    try {
      const info = (await comfyJson(`/object_info/${classe}`))?.[classe]
      const opt = info?.input?.required?.[ENTREE[classe]]?.[0]
      // deux formats : ['a', 'b'] ou 'COMBO' + { options: [...] }
      installes.parClasse[classe] = new Set(Array.isArray(opt) ? opt : info?.input?.required?.[ENTREE[classe]]?.[1]?.options ?? [])
    } catch { installes.parClasse[classe] = new Set() }
  }
  return installes.parClasse[classe]
}

/** La variante à employer pour `nom` au profil `profil`, parmi les installées ; null = garder l'original. */
async function choisir(nom, profil, dejaChoisis) {
  const e = VARIANTES[String(nom).split('/').pop()]
  if (!e || profil >= e.tient) return null
  // la plus fidèle qui passe au profil, puis les plus légères ; à défaut, la plus légère de toutes
  const passe = e.variantes.filter(v => v.pour <= profil).sort((a, b) => b.pour - a.pour)
  const ordre = passe.length ? passe : [...e.variantes].sort((a, b) => a.pour - b.pour)
  for (const v of ordre) {
    if (v.suit && !dejaChoisis.has(v.suit)) continue   // l'encodeur 4B ne sert qu'avec le modèle 4B
    if ((await fichiersDe(v.chargeur)).has(v.fichier)) return v
  }
  return null
}

/** Remplace les chargeurs lourds d'un graphe au format API. Rend { graphe, remplaces: [[de, vers]] }. */
export async function alleger(graphe) {
  const { profil } = await profilActuel()
  if (profil >= 24 || !graphe || typeof graphe !== 'object') return { graphe, remplaces: [] }
  const out = structuredClone(graphe)
  const remplaces = []
  const choisis = new Set()
  // modèles de diffusion d'abord : le choix de l'encodeur en dépend
  const noeuds = Object.values(out).filter(n => n?.class_type in ENTREE)
    .sort((a, b) => (a.class_type.startsWith('CLIP') ? 1 : 0) - (b.class_type.startsWith('CLIP') ? 1 : 0))
  for (const n of noeuds) {
    const nom = n.inputs?.[ENTREE[n.class_type]]
    if (typeof nom !== 'string') continue
    const v = await choisir(nom, profil, choisis)
    if (!v) continue
    choisis.add(v.fichier)
    remplaces.push([nom, v.fichier])
    if (v.chargeur === n.class_type) n.inputs[ENTREE[n.class_type]] = v.fichier
    else if (v.chargeur === 'UnetLoaderGGUF') { n.class_type = v.chargeur; n.inputs = { unet_name: v.fichier } }
    else if (v.chargeur === 'CLIPLoaderGGUF') { n.class_type = v.chargeur; n.inputs = { clip_name: v.fichier, type: n.inputs.type } }
  }
  // Wan sur 8 Go : les poids Q4 tiennent, pas les activations en 720p ; la vidéo passe en 480p
  // (côté long 832), même cadrage. À 12 Go, le 720p passe (banc docs/LAB.md).
  if (profil <= 8 && remplaces.some(([, f]) => /^Wan2\.2-.*\.gguf$/.test(f))) {
    for (const n of Object.values(out)) {
      if (!/^Wan.*ToVideo$/.test(n?.class_type ?? '')) continue
      const { width: w, height: h } = n.inputs ?? {}
      if (typeof w !== 'number' || typeof h !== 'number') continue
      const k = WAN_COTE_8GO / Math.max(w, h)
      if (k >= 1) continue
      n.inputs.width = Math.round(w * k / 16) * 16; n.inputs.height = Math.round(h * k / 16) * 16
      remplaces.push([`${w}x${h}`, `${n.inputs.width}x${n.inputs.height}`])
    }
  }
  return { graphe: out, remplaces }
}

/** Ce que le studio dit de la machine : profil, source, variantes prêtes ou manquantes. */
export async function etatAllegement() {
  const { profil, source, vram } = await profilActuel()
  const variantes = []
  for (const [de, e] of Object.entries(VARIANTES))
    for (const v of e.variantes)
      variantes.push({ de, vers: v.fichier, pour: v.pour, utile: profil < e.tient, installee: (await fichiersDe(v.chargeur)).has(v.fichier) })
  return { profil, source, vramGo: vram ? Math.round(vram / 2 ** 30) : null, variantes }
}
