/* English translations, one table per interface area (merged here).
   Key = exact French text passed to t(), value = English. */
import { commun } from './commun'
import { bureau_grilles } from './bureau_grilles'
import { bureau_visionneuse } from './bureau_visionneuse'
import { mobile } from './mobile'
import { partage } from './partage'
import { nouveautes } from './nouveautes'
import { serveur } from './serveur'
import { cinema } from './cinema'
import { reshoot } from './reshoot'
import { planlong } from './planlong'
import { audio } from './audio'
import { danse } from './danse'
import { galeries } from './galeries'

/* `serveur` first: identical interface text keeps its interface translation. */
export const EN: Record<string, string> = {
  ...serveur, ...partage, ...bureau_grilles, ...bureau_visionneuse, ...mobile, ...commun, ...nouveautes, ...cinema, ...reshoot, ...planlong, ...audio, ...danse, ...galeries,
}
