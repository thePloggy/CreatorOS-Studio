/* Garde-fou d'anatomie : une personne a une tête, deux bras, deux mains, deux jambes. Les
   modèles d'image et de vidéo ajoutent parfois un membre (une troisième jambe sous une cape,
   une main de trop). La consigne saute seulement si le texte demande explicitement un corps
   inhabituel (créature, robot, « three arms »…). */
const CORPS_INHABITUEL = /\b(?:two|three|four|five|six|eight|multiple|many|extra|additional|third|fourth)[- ](?:legs?|arms?|heads?|hands?|faces?)\b|\b(?:three|four|six|eight|multi)[- ]?(?:legged|armed|headed)\b|\b(?:tentacles?|centaurs?|mermaids?|spiders?|octopus|monsters?|aliens?|creatures?|robots?|cyborgs?)\b/i

export const corpsInhabituel = texte => CORPS_INHABITUEL.test(String(texte ?? ''))
/** Pour une image : à ajouter à la fin du prompt. */
export const anatomieImage = texte => corpsInhabituel(texte) ? ''
  : ' Every person has natural human anatomy: exactly one head, two arms, two hands with five fingers each, two legs and two feet — never an extra, duplicated or missing limb.'
/** Pour un clip : le corps reste entier d'un bout à l'autre. */
export const anatomieVideo = texte => corpsInhabituel(texte) ? ''
  : ' Natural human anatomy throughout: two arms, two legs, one head; no limb appears, splits or disappears.'
