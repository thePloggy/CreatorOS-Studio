/* ============================================================
   Composition vocabularies — a small NEUTRAL starter set
   (outfits, locations, framings, hairstyles, poses). Each item carries a
   full English prompt line (`prompt`); the French title is for display.
   User additions live separately (store/useVocabStore) and are merged
   everywhere.
   ============================================================ */
import type { Outfit, Environment, PhotoStyle, Hairstyle, TextPose } from '../types'

const SRC = 'vocabulaire de base'

const outfit = (id: string, labelFr: string, prompt: string, garment: string, material: string, color: string, context: string, fit = ''): Outfit => ({
  id, label: prompt, labelFr, prompt, garment, material, color, fit, context,
  tags: [garment, material, color, context].filter(Boolean), source: SRC,
})

export const OUTFITS: Outfit[] = [
  outfit('o_linen_shirt', 'chemise en lin blanche', 'a loose white linen shirt with rolled sleeves and light beige trousers', 'shirt', 'linen', 'white', 'ville', 'ample'),
  outfit('o_summer_dress', 'robe d’été fleurie', 'a flowing floral cotton sundress with thin straps, knee length', 'sundress', 'cotton', 'floral', 'plage', 'fluide'),
  outfit('o_denim_jacket', 'veste en jean', 'a classic blue denim jacket over a plain white t-shirt and black jeans', 'jacket', 'denim', 'blue', 'ville'),
  outfit('o_knit_sweater', 'pull en maille crème', 'a chunky cream knit sweater and a camel wool skirt', 'sweater', 'knit', 'cream', 'général', 'ample'),
  outfit('o_trench', 'trench beige', 'a beige trench coat belted at the waist, white sneakers', 'coat', 'cotton', 'beige', 'ville'),
  outfit('o_evening', 'robe de soirée satin', 'an elegant long navy satin evening gown with long sleeves', 'gown', 'satin', 'navy', 'chic'),
  outfit('o_blazer', 'tailleur noir', 'a tailored black blazer and matching trousers, silk blouse', 'blazer', 'wool', 'black', 'chic', 'ajustée'),
  outfit('o_sport', 'tenue de sport', 'a sage green athletic zip jacket and matching leggings, running shoes', 'jacket', 'jersey', 'sage-green', 'sport', 'ajustée'),
  outfit('o_raincoat', 'ciré jaune', 'a bright yellow rain jacket with a hood, dark jeans and boots', 'raincoat', 'nylon', 'yellow', 'ville'),
  outfit('o_overalls', 'salopette en jean', 'light denim overalls over a striped long-sleeve top', 'overalls', 'denim', 'blue', 'général'),
]

const env = (id: string, labelFr: string, prompt: string, location: string, sceneType: string, weather = ''): Environment => ({
  id, label: prompt, labelFr, prompt, location, sceneType, weather,
  tags: [location.toLowerCase(), sceneType], source: SRC,
})

export const ENVIRONMENTS: Environment[] = [
  env('e_cafe', 'terrasse de café', 'sitting at a small outdoor café terrace on a cobblestone street', 'old town', 'ville'),
  env('e_beach', 'plage au coucher du soleil', 'on a quiet sandy beach with gentle waves', 'seaside', 'plage', 'golden hour'),
  env('e_park', 'parc en automne', 'in a city park with autumn trees and fallen leaves', 'park', 'nature'),
  env('e_library', 'bibliothèque ancienne', 'in an old library with tall wooden bookshelves', 'library', 'intérieur'),
  env('e_studio', 'studio photo', 'in a photo studio with a seamless light grey backdrop', 'studio', 'studio'),
  env('e_rooftop', 'toit-terrasse en ville', 'on a city rooftop terrace overlooking the skyline', 'rooftop', 'ville', 'blue hour'),
  env('e_market', 'marché en plein air', 'walking through an open-air market with fruit and flower stalls', 'market', 'ville'),
  env('e_mountain', 'sentier de montagne', 'on a mountain hiking trail with a valley view', 'mountains', 'nature'),
  env('e_kitchen', 'cuisine lumineuse', 'in a bright modern kitchen with plants on the window sill', 'home', 'intérieur'),
  env('e_station', 'gare', 'on a train station platform under a glass and iron roof', 'station', 'ville'),
]

const style = (id: string, labelFr: string, framing: string, lens: string, context = 'extérieur'): PhotoStyle => ({
  id, label: framing, labelFr, framing, lens, context, tags: [context], source: SRC,
})

export const STYLES: PhotoStyle[] = [
  style('s_portrait', 'portrait serré', 'close-up portrait, shoulders up, shallow depth of field', '85mm'),
  style('s_half', 'plan taille', 'medium shot from the waist up, natural light', '50mm'),
  style('s_full', 'plein pied', 'full body shot, eye level', '35mm'),
  style('s_wide', 'plan large', 'wide environmental shot, subject small in the frame', '24mm'),
  style('s_candid', 'pris sur le vif', 'candid street photography, looking away from the camera', '35mm'),
  style('s_selfie', 'selfie', 'smartphone selfie at arm’s length, front camera', '', 'selfie'),
  style('s_mirror', 'selfie miroir', 'mirror selfie holding a phone, full outfit visible', '', 'selfie'),
  style('s_editorial', 'éditorial', 'fashion editorial, soft studio lighting, clean composition', '70mm'),
]

export const HAIRSTYLES: Hairstyle[] = [
  { id: 'h_loose', label: 'loose hair', labelFr: 'cheveux lâchés', prompt: 'long loose hair' },
  { id: 'h_ponytail', label: 'ponytail', labelFr: 'queue de cheval', prompt: 'hair tied in a high ponytail' },
  { id: 'h_bun', label: 'bun', labelFr: 'chignon', prompt: 'hair in a messy bun' },
  { id: 'h_braid', label: 'braid', labelFr: 'tresse', prompt: 'a single side braid' },
  { id: 'h_waves', label: 'waves', labelFr: 'ondulations', prompt: 'soft beach waves' },
]

const pose = (id: string, labelFr: string, prompt: string, context = 'général'): TextPose => ({
  id, label: prompt, labelFr, prompt, context, source: SRC,
})

export const TEXT_POSES: TextPose[] = [
  pose('p_standing', 'debout, détendue', 'standing relaxed, hands in pockets'),
  pose('p_walking', 'en marche', 'walking towards the camera mid-stride', 'ville'),
  pose('p_sitting', 'assise', 'sitting on a bench, legs crossed'),
  pose('p_leaning', 'adossée', 'leaning against a wall, arms folded'),
  pose('p_laughing', 'éclat de rire', 'laughing, head slightly tilted back'),
  pose('p_coffee', 'tasse à la main', 'holding a coffee cup with both hands'),
  pose('p_looking', 'regard au loin', 'looking over the shoulder into the distance'),
  pose('p_reading', 'en lecture', 'reading a book, absorbed'),
]

/** First item of a list — a selector's initial value. */
export const firstId = (items: { id: string }[]) => items[0]?.id ?? null

export const MUSIC_LIBRARY = [
  { id: 'm1', label: 'Lofi chill' },
  { id: 'm2', label: 'Deep house douce' },
  { id: 'm3', label: 'Bossa lounge' },
]
