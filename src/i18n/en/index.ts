/* Traductions anglaises, une table par zone de l'interface (fusionnées ici).
   Clé = texte français exact passé à t(), valeur = anglais. */
import { commun } from './commun'
import { bureau_grilles } from './bureau_grilles'
import { bureau_visionneuse } from './bureau_visionneuse'
import { mobile } from './mobile'
import { partage } from './partage'
import { nouveautes } from './nouveautes'
import { serveur } from './serveur'
import { cinema } from './cinema'
import { reshoot } from './reshoot'
import { audio } from './audio'

/* `serveur` en premier : un texte d'interface identique garde sa traduction d'interface. */
export const EN: Record<string, string> = {
  ...serveur, ...partage, ...bureau_grilles, ...bureau_visionneuse, ...mobile, ...commun, ...nouveautes, ...cinema, ...reshoot, ...audio,
}
