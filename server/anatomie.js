/* Anatomy guard: one head, two arms, two hands, two legs. Image and video models sometimes
   add a limb. The rule is skipped only when the text explicitly asks for an unusual body
   (creature, robot, "three arms"...). */
const CORPS_INHABITUEL = /\b(?:two|three|four|five|six|eight|multiple|many|extra|additional|third|fourth)[- ](?:legs?|arms?|heads?|hands?|faces?)\b|\b(?:three|four|six|eight|multi)[- ]?(?:legged|armed|headed)\b|\b(?:tentacles?|centaurs?|mermaids?|spiders?|octopus|monsters?|aliens?|creatures?|robots?|cyborgs?)\b/i

export const corpsInhabituel = texte => CORPS_INHABITUEL.test(String(texte ?? ''))
/** For an image: appended to the end of the prompt. */
export const anatomieImage = texte => corpsInhabituel(texte) ? ''
  : ' Every person has natural human anatomy: exactly one head, two arms, two hands with five fingers each, two legs and two feet — never an extra, duplicated or missing limb.'
/** For a clip: the body stays whole from start to end. */
export const anatomieVideo = texte => corpsInhabituel(texte) ? ''
  : ' Natural human anatomy throughout: two arms, two legs, one head; no limb appears, splits or disappears.'
