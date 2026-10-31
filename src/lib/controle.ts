/* Résumé lisible du contrôle automatique d'un clip (server/controle.js). */
import type { Controle } from '../types'
import { t, getLang } from '../i18n'

const nb = (x: number) => (getLang() === 'en' ? x.toFixed(1) : x.toFixed(1).replace('.', ','))
const LIBELLE: Record<string, string> = {
  noir: 'images noires', fige: 'figé', saute: 'saute', flou: 'flou', visage: 'visage qui s’éloigne', illisible: 'clip illisible',
  camera: 'mouvement de caméra différent',
}
const MOUVEMENT: Record<string, string> = {
  avant: 'vers l’avant', arriere: 'vers l’arrière', lateral: 'latéral', vertical: 'vertical', fixe: 'immobile', mixte: 'mélangé',
}

/** Une ligne par défaut, horodatée : « figé 1,2–2,5 s ». */
export function defautsDe(c?: Controle | null): string[] {
  if (!c) return []
  return c.problemes.map(p => {
    const quand = p.debut === p.fin ? `${nb(p.debut)} s` : `${nb(p.debut)}–${nb(p.fin)} s`
    return `${p.grave ? '⚠ ' : ''}${t(LIBELLE[p.type] ?? p.type)} ${quand}`
  })
}

/** Résumé court pour la fiche : défauts, visage, prise. */
export function resumeControle(c?: Controle | null): string | null {
  if (!c) return null
  const morceaux = defautsDe(c)
  if (!morceaux.length) morceaux.push(t('rien à signaler'))
  if (c.boucle) morceaux.push(t(c.boucle.propre ? 'boucle sans jointure ({s})' : 'jointure visible ({s})', { s: c.boucle.ssim.toFixed(2) }))
  if (c.visage?.score != null) morceaux.push(t('visage {s}', { s: c.visage.score.toFixed(2) }))
  if (c.camera) morceaux.push(c.camera.mesure === c.camera.attendu
    ? t('caméra {m} ✓', { m: t(MOUVEMENT[c.camera.mesure] ?? c.camera.mesure) })
    : t('caméra {m} au lieu de {a}', { m: t(MOUVEMENT[c.camera.mesure] ?? c.camera.mesure), a: t(MOUVEMENT[c.camera.attendu] ?? c.camera.attendu) }))
  if (c.prise === 2) morceaux.push(c.choix === 'écartée' ? t('2e prise, écartée') : t('2e prise'))
  else if (c.relance) morceaux.push(c.choix === 'écartée' ? t('relancée, écartée') : t('relancée'))
  return morceaux.join(' · ')
}
