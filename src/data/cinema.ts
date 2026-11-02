/* ============================================================
   Studio ciné — vocabulaire de la fiche de plan.

   Chaque option a un libellé (français, traduit par t()) et un fragment de
   prompt (anglais, ce que lit Krea 2 ou Klein). La fiche compose une phrase
   naturelle : le moteur photo lit mieux une description de tournage qu'une
   liste de mots-clés.
   ============================================================ */

export interface Opt { id: string; label: string; prompt: string }

export const BOITIERS: Opt[] = [
  { id: 'cine-num', label: 'Caméra cinéma numérique', prompt: 'a large-format digital cinema camera' },
  { id: 'pellicule35', label: 'Caméra cinéma 35 mm', prompt: 'a 35mm motion picture film camera' },
  { id: 'pellicule16', label: 'Caméra 16 mm', prompt: 'a 16mm film camera, visible grain' },
  { id: 'moyen-format', label: 'Moyen format', prompt: 'a medium format camera' },
  { id: 'reflex-vintage', label: 'Reflex argentique', prompt: 'a vintage 35mm SLR' },
  { id: 'telephone', label: 'Téléphone', prompt: 'a smartphone camera, casual handheld snapshot' },
  { id: 'jetable', label: 'Appareil jetable', prompt: 'a disposable camera with direct flash' },
]

export const OPTIQUES: Opt[] = [
  { id: 'spherique', label: 'Sphérique', prompt: 'spherical prime lens' },
  { id: 'anamorphique', label: 'Anamorphique', prompt: 'anamorphic lens, oval bokeh and horizontal flares' },
  { id: 'vintage', label: 'Optique vintage', prompt: 'vintage lens with soft halation' },
  { id: 'macro', label: 'Macro', prompt: 'macro lens' },
]

export const FOCALES = ['14mm', '24mm', '35mm', '50mm', '85mm', '135mm'] as const
export const OUVERTURES: Opt[] = [
  { id: 'f1.4', label: 'f/1.4', prompt: 'at f/1.4, very shallow depth of field, creamy background blur' },
  { id: 'f2.8', label: 'f/2.8', prompt: 'at f/2.8, shallow depth of field' },
  { id: 'f5.6', label: 'f/5.6', prompt: 'at f/5.6, moderate depth of field' },
  { id: 'f11', label: 'f/11', prompt: 'at f/11, deep focus, everything sharp' },
]

export const PLANS: Opt[] = [
  { id: 'gros-plan', label: 'Gros plan', prompt: 'close-up on her face' },
  { id: 'poitrine', label: 'Plan poitrine', prompt: 'medium close-up, chest up' },
  { id: 'americain', label: 'Plan américain', prompt: 'medium shot from the thighs up' },
  { id: 'pied', label: 'Plan en pied', prompt: 'full body shot' },
  { id: 'large', label: 'Plan large', prompt: 'wide establishing shot, she is small in the frame' },
  { id: 'plongee', label: 'Plongée', prompt: 'high angle shot looking down at her' },
  { id: 'contre-plongee', label: 'Contre-plongée', prompt: 'low angle shot looking up at her' },
  { id: 'profil', label: 'De profil', prompt: 'profile shot, side view' },
  { id: 'epaule', label: 'Par-dessus l’épaule', prompt: 'over-the-shoulder shot' },
]

export const LUMIERES: Opt[] = [
  { id: 'heure-doree', label: 'Heure dorée', prompt: 'warm golden hour sunlight, low sun, long soft shadows' },
  { id: 'heure-bleue', label: 'Heure bleue', prompt: 'blue hour twilight, cool ambient light, first city lights' },
  { id: 'neon', label: 'Néons', prompt: 'neon signs at night, magenta and cyan light spilling on her face' },
  { id: 'clair-obscur', label: 'Clair-obscur', prompt: 'chiaroscuro, a single hard key light, deep shadows' },
  { id: 'fenetre', label: 'Lumière de fenêtre', prompt: 'soft natural window light from the side' },
  { id: 'bougie', label: 'Bougies', prompt: 'warm candlelight, flickering glow' },
  { id: 'contre-jour', label: 'Contre-jour', prompt: 'strong backlight, rim light outlining her hair' },
  { id: 'couvert', label: 'Ciel couvert', prompt: 'overcast diffuse daylight, no harsh shadows' },
  { id: 'studio', label: 'Studio trois points', prompt: 'three-point studio lighting, clean key, fill and rim' },
]

/* « Même plan, 4 lumières » : quatre lumières qui se distinguent à coup sûr. */
export const BALAYAGE = ['heure-doree', 'heure-bleue', 'neon', 'clair-obscur']

export const PELLICULES: Opt[] = [
  { id: 'aucune', label: 'Numérique propre', prompt: 'clean digital image' },
  { id: 'portra', label: 'Couleur portrait 400', prompt: 'shot on 400 ISO color portrait film, gentle grain, natural skin tones' },
  { id: 'cine-500', label: 'Pellicule cinéma 500T', prompt: 'shot on tungsten 500T motion picture film stock, halation around highlights' },
  { id: 'inversible', label: 'Diapositive', prompt: 'shot on slide film, punchy saturated colors' },
  { id: 'nb', label: 'Noir et blanc', prompt: 'black and white film, rich silver tones' },
  { id: 'polaroid', label: 'Instantané', prompt: 'instant film photo, soft faded colors' },
]

export const LOOKS: Opt[] = [
  { id: 'drame', label: 'Drame d’auteur', prompt: 'quiet arthouse drama still' },
  { id: 'polar', label: 'Film noir', prompt: 'film noir mood' },
  { id: 'sf', label: 'Science-fiction', prompt: 'moody science fiction film still' },
  { id: 'romance', label: 'Romance', prompt: 'romantic film still' },
  { id: 'clip', label: 'Clip musical', prompt: 'music video frame, bold styling' },
  { id: 'pub', label: 'Pub de mode', prompt: 'high-end fashion campaign' },
  { id: 'docu', label: 'Documentaire', prompt: 'candid documentary photograph' },
]

export const ETALONNAGES: Opt[] = [
  { id: 'naturel', label: 'Naturel', prompt: 'natural color grade' },
  { id: 'teal-orange', label: 'Sarcelle et orange', prompt: 'teal and orange color grade' },
  { id: 'chaud', label: 'Chaud', prompt: 'warm amber color grade' },
  { id: 'froid', label: 'Froid', prompt: 'cool blue color grade' },
  { id: 'desature', label: 'Désaturé', prompt: 'muted desaturated color grade' },
  { id: 'bleach', label: 'Sans blanchiment', prompt: 'bleach bypass look, high contrast, low saturation' },
  { id: 'pastel', label: 'Pastel', prompt: 'soft pastel color grade' },
]

export interface Fiche {
  scene: string
  boitier: string; optique: string; focale: string; ouverture: string
  plan: string; lumiere: string; pellicule: string; look: string; etalonnage: string
  palette: string[]          // #rrggbb, 8 au plus
}

export const FICHE_DEFAUT: Fiche = {
  scene: '', boitier: 'cine-num', optique: 'spherique', focale: '50mm', ouverture: 'f2.8',
  plan: 'poitrine', lumiere: 'heure-doree', pellicule: 'aucune', look: 'drame', etalonnage: 'naturel', palette: [],
}

/* Plans de départ : une fiche complète, à retoucher. */
export const DEPARTS: { id: string; label: string; fiche: Partial<Fiche> }[] = [
  { id: 'terrasse', label: 'Terrasse à l’heure dorée', fiche: { scene: 'sitting at a café terrace in an old European street, holding a cup of coffee', boitier: 'cine-num', optique: 'anamorphique', focale: '85mm', ouverture: 'f1.4', plan: 'poitrine', lumiere: 'heure-doree', pellicule: 'portra', look: 'romance', etalonnage: 'chaud' } },
  { id: 'neon', label: 'Rue de néons', fiche: { scene: 'standing in a rainy city street at night, wet pavement reflecting the signs', boitier: 'cine-num', optique: 'anamorphique', focale: '35mm', ouverture: 'f1.4', plan: 'americain', lumiere: 'neon', pellicule: 'cine-500', look: 'sf', etalonnage: 'teal-orange' } },
  { id: 'noir', label: 'Film noir', fiche: { scene: 'leaning against a door frame in a dim hallway, looking off camera', boitier: 'pellicule35', optique: 'vintage', focale: '50mm', ouverture: 'f2.8', plan: 'americain', lumiere: 'clair-obscur', pellicule: 'nb', look: 'polar', etalonnage: 'naturel' } },
  { id: 'plage', label: 'Plage en 16 mm', fiche: { scene: 'walking barefoot along the shoreline, wind in her hair', boitier: 'pellicule16', optique: 'vintage', focale: '24mm', ouverture: 'f5.6', plan: 'pied', lumiere: 'contre-jour', pellicule: 'cine-500', look: 'clip', etalonnage: 'pastel' } },
  { id: 'atelier', label: 'Portrait à la fenêtre', fiche: { scene: 'sitting by a tall window in an artist studio, a sketchbook on her knees', boitier: 'moyen-format', optique: 'spherique', focale: '85mm', ouverture: 'f2.8', plan: 'poitrine', lumiere: 'fenetre', pellicule: 'portra', look: 'drame', etalonnage: 'desature' } },
]

const pick = (l: Opt[], id: string) => l.find(o => o.id === id) ?? l[0]

/* Couleurs nommées : le moteur lit mieux « dusty rose » qu'un code hexadécimal. */
const NOMMEES: [string, number, number, number][] = [
  ['black', 15, 15, 18], ['charcoal', 54, 57, 64], ['slate grey', 112, 128, 144], ['silver', 192, 192, 196], ['white', 245, 245, 240],
  ['ivory', 240, 232, 210], ['beige', 214, 196, 160], ['sand', 194, 170, 120], ['tan', 170, 130, 90], ['brown', 110, 70, 40],
  ['chocolate', 70, 40, 25], ['burgundy', 110, 20, 40], ['crimson', 190, 20, 50], ['red', 220, 40, 40], ['coral', 250, 120, 100],
  ['dusty rose', 200, 140, 145], ['pink', 245, 160, 190], ['magenta', 210, 40, 160], ['plum', 110, 50, 100], ['lavender', 180, 160, 220],
  ['violet', 130, 70, 200], ['navy', 25, 35, 80], ['cobalt blue', 30, 80, 190], ['sky blue', 120, 180, 230], ['cyan', 40, 200, 220],
  ['teal', 20, 120, 125], ['emerald', 20, 140, 90], ['olive', 110, 115, 50], ['sage green', 150, 170, 130], ['lime', 170, 220, 60],
  ['mustard', 205, 160, 40], ['gold', 220, 175, 60], ['amber', 240, 150, 30], ['orange', 245, 120, 30], ['rust', 170, 80, 40],
]
export function nomCouleur(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  let best = NOMMEES[0], d0 = Infinity
  for (const c of NOMMEES) {
    const d = 2 * (c[1] - r) ** 2 + 4 * (c[2] - g) ** 2 + 3 * (c[3] - b) ** 2
    if (d < d0) { d0 = d; best = c }
  }
  return best[0]
}

/** La phrase envoyée au moteur photo. `lumiere` remplace celle de la fiche (balayage). */
export function composerFiche(f: Fiche, lumiere?: string): string {
  const parts = [
    f.scene.trim().replace(/[.\s]+$/, ''),
    `${pick(PLANS, f.plan).prompt}`,
    `shot on ${pick(BOITIERS, f.boitier).prompt} with a ${f.focale} ${pick(OPTIQUES, f.optique).prompt} ${pick(OUVERTURES, f.ouverture).prompt}`,
    pick(LUMIERES, lumiere ?? f.lumiere).prompt,
    pick(PELLICULES, f.pellicule).prompt,
    `${pick(LOOKS, f.look).prompt}, ${pick(ETALONNAGES, f.etalonnage).prompt}`,
  ].filter(Boolean)
  const noms = [...new Set(f.palette.map(nomCouleur))]
  if (noms.length) parts.push(`color palette of ${noms.join(', ')}`)
  return parts.join('. ') + '.'
}

/** Couleurs dominantes d'une image (8 au plus), par seaux de 4 bits et écart minimal. */
export async function couleursDominantes(src: string, n = 5): Promise<string[]> {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = src
  await img.decode()
  const c = document.createElement('canvas'); c.width = 64; c.height = 64
  const g = c.getContext('2d'); if (!g) return []
  g.drawImage(img, 0, 0, 64, 64)
  const d = g.getImageData(0, 0, 64, 64).data
  const seaux = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < d.length; i += 4) {
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
    const s = seaux.get(k) ?? { n: 0, r: 0, g: 0, b: 0 }
    s.n++; s.r += d[i]; s.g += d[i + 1]; s.b += d[i + 2]; seaux.set(k, s)
  }
  const tries = [...seaux.values()].sort((a, b) => b.n - a.n).map(s => [s.r / s.n, s.g / s.n, s.b / s.n])
  const pris: number[][] = []
  for (const c of tries) {
    if (pris.every(p => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 > 2400)) pris.push(c)
    if (pris.length >= n) break
  }
  return pris.map(p => '#' + p.map(x => Math.round(x).toString(16).padStart(2, '0')).join(''))
}
