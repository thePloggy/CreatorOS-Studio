/* ============================================================
   Creator page: who made the app (name, bio, site, links). A small JSON
   file in the data directory, written atomically. Links accept https only
   because the page is public. Title, bio and info fields have an optional
   English version (titreEn, bioEn, kEn/vEn), shown when the UI is in English.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

const FICHIER = path.join(CONFIG.dataDir, 'createur.json')
const VIDE = { nom: '', titre: '', titreEn: '', bio: '', bioEn: '', site: '', liens: [], infos: [] }

const txt = (v, n) => String(v ?? '').trim().slice(0, n)
const https = v => (/^https:\/\/[^\s<>"]+$/.test(txt(v, 300)) ? txt(v, 300) : '')

function nettoyer(c) {
  return {
    nom: txt(c?.nom, 80),
    titre: txt(c?.titre, 140),
    titreEn: txt(c?.titreEn, 140),
    bio: txt(c?.bio, 2000),
    bioEn: txt(c?.bioEn, 2000),
    site: https(c?.site),
    liens: (Array.isArray(c?.liens) ? c.liens : []).slice(0, 12)
      .map(l => ({ label: txt(l?.label, 60), url: https(l?.url) })).filter(l => l.url),
    infos: (Array.isArray(c?.infos) ? c.infos : []).slice(0, 12)
      .map(i => ({ k: txt(i?.k, 60), v: txt(i?.v, 300), kEn: txt(i?.kEn, 60), vEn: txt(i?.vEn, 300) })).filter(i => i.k && i.v),
  }
}

export function lireCreateur() {
  try { return nettoyer(JSON.parse(fs.readFileSync(FICHIER, 'utf8'))) } catch { return { ...VIDE } }
}

export function ecrireCreateur(corps) {
  const c = nettoyer(corps)
  const tmp = `${FICHIER}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2))
  fs.renameSync(tmp, FICHIER)
  return c
}
