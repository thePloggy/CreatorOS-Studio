/* ============================================================
   T0 côté serveur — le plancher dur, rejoué sur le texte RÉSOLU.

   Le front inspecte le prompt avant l'envoi, mais il ne voit que le
   token wildcard (`__tenues*__`), pas la ligne tirée. Le tirage vivant
   ici, le contrôle est rejoué sur le texte final, après tirage et avant
   injection. Même liste que le front — à modifier par paires.

   Deux familles : tout ce qui évoque un mineur, et le contenu sexuel ou
   la nudité — l'application ne produit que du SFW.
   ============================================================ */
export const T0_BLOCKLIST = [
  // l'enfance est dans T0_ENFANCE_* (mots entiers) ; restent ici les sous-chaînes sans faux positif
  'underage', 'barely legal', 'schoolgirl', 'young girl', 'loli', 'jeune fille mineure',
  'naked', 'fully nude', 'nude body', 'nsfw', 'topless', 'nipple', 'genital',
  'pussy', 'penis', 'porn', 'sex scene', 'see-through', 'seins nus',
  'nude woman', 'nude girl', 'nudity', 'erotic', 'lingerie',
  'nothing under', 'nothing underneath', 'no clothes', 'without clothes',
  'undressed', 'undressing', 'bare chest', 'bare breast', 'breasts', 'underwear',
  'rien en dessous', 'déshabillée', 'poitrine nue',
]
/* Mots courts cherchés en MOT ENTIER (« nue » est dans « avenue », « nu »
   dans « menu ») : comparés aux mots du texte, pas en sous-chaîne. */
export const T0_MOTS = ['nude', 'nue', 'nues', 'nu', 'nus', 'sexy', 'stripping', 'striptease', 'fetish', 'fétiche', 'fetichiste', 'fétichiste']

/* Enfance :
   tout ce qui désigne un enfant ou un âge mineur est refusé, quel que soit le
   reste du texte, en anglais et en français, y compris les orthographes
   déguisées. Mots entiers (après normalisation des chiffres-lettres), puis
   expressions, puis âges écrits en chiffres ou en lettres. */
export const T0_ENFANCE_MOTS = [
  'kid', 'kids', 'kiddo', 'kiddie', 'child', 'children', 'childlike', 'childish', 'toddler', 'toddlers', 'infant', 'infants',
  'baby', 'babies', 'preteen', 'preteens', 'tween', 'tweens', 'teen', 'teens', 'teenager', 'teenagers', 'teenage', 'teeny',
  'minor', 'minors', 'underage', 'underaged', 'juvenile', 'loli', 'lolis', 'lolicon', 'lolita', 'shota', 'shotacon',
  'schoolgirl', 'schoolgirls', 'schoolboy', 'schoolboys', 'pubescent', 'prepubescent', 'puberty', 'nymphet', 'jailbait',
  'ageplay', 'youngster', 'youngsters', 'girlchild', 'cub', 'youngest', 'youngling', 'younglings', 'flatchested', 'petiote', 'petiotes',
  'enfant', 'enfants', 'enfantin', 'enfantine', 'gamin', 'gamine', 'gamins', 'gamines', 'gosse', 'gosses', 'fillette', 'fillettes',
  'bambin', 'bambine', 'bébé', 'bebe', 'ado', 'ados', 'adolescent', 'adolescente', 'adolescents', 'adolescentes',
  'mineur', 'mineure', 'mineurs', 'mineures', 'collégien', 'collégienne', 'collégiens', 'collégiennes',
  'lycéen', 'lycéenne', 'lycéens', 'lycéennes', 'écolier', 'écolière', 'écoliers', 'écolières', 'pubère', 'prépubère', 'préado', 'préados',
]
export const T0_ENFANCE_EXPRESSIONS = [
  'little girl', 'little boy', 'young girl', 'young boy', 'school girl', 'school boy', 'barely legal', 'pre-teen', 'pre teen',
  'under 18', 'under eighteen', 'not 18', 'age play', 'jeune fille', 'jeune garçon', 'petite fille', 'petit garçon',
  'pré-ado', 'moins de 18', 'sous 18', 'pas majeure', 'pas encore majeure', 'jeune adolescente',
  'very young', 'too young', 'so young', 'extremely young', 'young looking', 'young-looking', 'looks young', 'looking young',
  'looks like a girl', 'little one', 'little skinny', 'little body', 'tiny body', 'small body', 'tiny girl', 'small girl',
  'little lady', 'flat chest', 'flat-chest', 'undeveloped', 'not yet developed', 'very small breasts',
  'très jeune', 'trop jeune', 'toute jeune', 'si jeune', 'petit corps', 'corps d’enfant', "corps d'enfant", 'poitrine plate', 'petite jeune',
]
const AGE_CHIFFRES = /\b(?:[1-9]|1[0-7])\s*(?:-|\s)?(?:yo|y\/o|y\.o\.?|yrs?|years?|year-old|years-old|ans|an)\b/u
const AGE_LETTRES = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|un|deux|trois|quatre|cinq|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept)[\s-]*(?:years?|year-old|ans)\b/u
// 1 → i, 3 → e, 4 → a, 0 → o, 5 → s, 7 → t, @ → a : « k1d », « t33n », « l0li »
const DECHIFFRER = t => t.replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/0/g, 'o').replace(/5|\$/g, 's').replace(/7/g, 't')

/* Sexuel :
   l'application ne produit que du SFW. Mots entiers, puis expressions. */
export const T0_SEXE_MOTS = [
  'cock', 'cocks', 'dick', 'dicks', 'penis', 'penises', 'phallus', 'pussy', 'pussies', 'vagina', 'vaginal', 'vulva', 'clit', 'clitoris',
  'anus', 'anal', 'ass', 'asshole', 'tits', 'titty', 'titties', 'boob', 'boobs', 'nipple', 'nipples', 'areola', 'areolas',
  'cum', 'cumming', 'cumshot', 'semen', 'sperm', 'ejaculate', 'ejaculating', 'ejaculation', 'orgasm', 'orgasms', 'orgasmic',
  'masturbate', 'masturbating', 'masturbation', 'fingering', 'blowjob', 'blowjobs', 'handjob', 'footjob', 'deepthroat', 'fellatio', 'cunnilingus',
  'suck', 'sucks', 'sucking', 'sucked', 'sex', 'sexual', 'sexually', 'intercourse', 'fuck', 'fucks', 'fucking', 'fucked',
  'horny', 'aroused', 'arousal', 'erection', 'erect', 'hardon', 'bdsm', 'bondage', 'kinky', 'kink', 'xxx', 'hentai', 'ecchi',
  'onlyfans', 'escort', 'stripper', 'strippers', 'upskirt', 'panties', 'thong', 'gstring', 'cameltoe', 'braless', 'undress', 'undresses',
  'unbutton', 'unbuttons', 'unbuttoning', 'unbuttoned', 'unzip', 'unzips', 'unzipping', 'strips', 'nudes', 'naked', 'nakedness', 'genitals',
  'pénis', 'vagin', 'clito', 'sexe', 'sexuel', 'sexuelle', 'sexuels', 'seins', 'nichons', 'bite', 'chatte', 'sucer', 'suce', 'sucent',
  'fellation', 'sodomie', 'sodomise', 'éjacule', 'éjaculation', 'sperme', 'masturbe', 'masturbation', 'baise', 'baiser', 'baisent', 'branlette',
  'déshabille', 'déshabiller', 'déshabillée', 'déboutonne', 'déboutonner', 'déboutonnée', 'culotte', 'excitée', 'érection', 'porno',
]
export const T0_SEXE_EXPRESSIONS = [
  'on her knees in front of', 'kneeling in front of a man', 'between his legs', 'between her legs', 'spread legs', 'spreads her legs',
  'spreading her legs', 'legs spread', 'takes off her', 'taking off her', 'removes her top', 'removes her shirt', 'removes her bra',
  'removes her clothes', 'pulls down her', 'lifts her skirt', 'lifts up her skirt', 'no bra', 'without a bra', 'wet t-shirt', 'bare breasts',
  'bare chest', 'strip club', 'strip tease', 'see through', 'transparent top', 'oral sex', 'making love', 'make love',
  'à genoux devant', 'entre ses jambes', 'jambes écartées', 'écarte les jambes', 'enlève son haut', 'retire son haut', 'enlève sa chemise',
  'retire sa chemise', 'sans soutien-gorge', 'faire l’amour', "faire l'amour", 'fait l’amour', "fait l'amour",
]

/* Tournures de retouche (31/10) : un visiteur a déshabillé un personnage par
   « remove bikini top », puis l'a réduit par « tiny bikini » et « larger boobies ».
   Retirer, réduire ou remplacer par de la peau, sur un vêtement. */
const TENUE = String.raw`(?:bikinis?|swimsuits?|swimwear|bathing suits?|tops?|bra|bras|shirts?|t-shirt|tee|blouses?|dress|dresses|skirts?|pants|trousers|jeans|shorts|bottoms?|clothes|clothing|outfit|garments?|maillots?|haut|soutien-gorge|chemise|robe|jupe|pantalon|vêtements?|habits?|tenue)`
const RETIRER_TENUE = new RegExp(String.raw`\b(?:remove|removes|removing|erase|erases|erasing|delete|deletes|take off|takes off|taking off|take away|strip|strip off|peel off|pull off|without|no|enlève|enlever|enlevez|retire|retirer|retirez|ôte|ôter|efface|effacer|sans)\s+(?:\w+\s+){0,3}?${TENUE}\b|\b${TENUE}\s+(?:\w+\s+){0,2}?(?:off|removed|gone)\b|\breplace\s+(?:\w+\s+){0,3}?${TENUE}\s+with\s+(?:\w+\s+){0,3}?(?:tattoos?|body ?paint|paint|skin|hands?|flowers?|stickers?|leaves|emojis?)\b|\b(?:tattoos?|body ?paint)\s+(?:\w+\s+){0,3}?(?:cover|covers|covering|instead)\b`, 'u')
const TENUE_REDUITE = new RegExp(String.raw`\b(?:tiny|micro|mini|smaller|skimpy|skimpier|small|minuscule)\s+(?:\w+\s+){0,2}?(?:bikinis?|swimsuits?|swimwear|maillots?)\b|\b(?:bikinis?|swimsuits?)\s+(?:\w+\s+){0,2}?(?:smaller|tiny|micro|skimpy)\b`, 'u')
const CORPS_RETOUCHE = /\b(?:bust|cleavage|bosom|chest|butt|buttocks|poitrine|décolleté|fesses)\s+(?:\w+\s+){0,2}?(?:bigger|larger|huge|enormous|plus gros|énorme)\b|\b(?:bigger|larger|huge|enormous|giant|massive|plus grosse?s?|énormes?|gros|grosse)\s+(?:\w+\s+){0,2}?(?:boobies|booby|boobie|bust|cleavage|bosom|chest|butt|buttocks|poitrine|fesses)\b|\b(?:boobies|booby|boobie|busty)\b/u

/** Rend le terme sexuel trouvé, ou null. */
export function t0Sexe(text) {
  const lower = String(text ?? '').toLowerCase().normalize('NFC')
  // « without clothes » et ses fautes de frappe
  const sansHabits = lower.match(/\b(?:w\w{0,3}out|with out|no|not wearing any|zero)\s+(?:any\s+)?(?:clothes|clothing|clothe|outfit|garments?)\b|\b(?:clothes|clothing)\s+off\b|\bsans\s+(?:aucun\s+)?(?:vêtements?|habits?)\b/u)
  if (sansHabits) return sansHabits[0]
  const retrait = lower.match(RETIRER_TENUE) ?? lower.match(TENUE_REDUITE) ?? lower.match(CORPS_RETOUCHE)
  if (retrait) return retrait[0]
  const exp = T0_SEXE_EXPRESSIONS.find(e => lower.includes(e))
  if (exp) return exp
  const mots = new Set([...lower.split(/[^\p{L}\p{N}@$!|]+/u), ...DECHIFFRER(lower).split(/[^\p{L}\p{N}]+/u), ...lower.replace(/[-_.]/g, '').split(/[^\p{L}\p{N}]+/u)])
  return T0_SEXE_MOTS.find(m => mots.has(m)) ?? null
}

/** Rend le terme d'enfance trouvé, ou null. */
export function t0Enfance(text) {
  const lower = String(text ?? '').toLowerCase().normalize('NFC')
  if (AGE_CHIFFRES.test(lower)) return lower.match(AGE_CHIFFRES)[0]
  if (AGE_LETTRES.test(lower)) return lower.match(AGE_LETTRES)[0]
  const exp = T0_ENFANCE_EXPRESSIONS.find(e => lower.includes(e))
  if (exp) return exp
  const mots = new Set([...lower.split(/[^\p{L}\p{N}@$!|]+/u), ...DECHIFFRER(lower).split(/[^\p{L}\p{N}]+/u)])
  return T0_ENFANCE_MOTS.find(m => mots.has(m)) ?? null
}

/** Rend le terme bloqué, ou null. */
export function t0Hit(text) {
  const enfance = t0Enfance(text)
  if (enfance) return enfance
  const sexe = t0Sexe(text)
  if (sexe) return sexe
  const lower = String(text ?? '').toLowerCase()
  const sous = T0_BLOCKLIST.find(term => lower.includes(term))
  if (sous) return sous
  const mots = new Set(lower.split(/[^\p{L}\p{N}]+/u))
  return T0_MOTS.find(m => mots.has(m)) ?? null
}
