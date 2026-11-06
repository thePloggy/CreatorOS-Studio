/* Studio musique : presets écrits et listes de choix. Un preset pré-remplit tous les champs du
   formulaire, que l'utilisateur modifie ensuite librement. Les listes reprennent les choix
   acceptés par le serveur (et par le nœud ACE-Step) : tonalité, mesure, langue, voix chantée. */

export type VoixChantee = '' | 'female' | 'male' | 'duet' | 'choir' | 'none'
export type Mesure = '' | '2' | '3' | '4' | '6'

export type PresetMusique = {
  id: string
  nom: string
  style: string
  instruments: string[]
  bpm: number
  tonalite: string
  mesure: Mesure
  voix: VoixChantee
}

export const PRESETS_MUSIQUE: PresetMusique[] = [
  { id: 'lofi', nom: 'Lo-fi chill', style: 'lo-fi hip hop, chill, warm, mellow, vinyl crackle, relaxed late-night mood', instruments: ['rhodes piano', 'muted guitar', 'soft drums', 'upright bass'], bpm: 80, tonalite: 'A minor', mesure: '4', voix: 'none' },
  { id: 'pop', nom: 'Pop upbeat', style: 'upbeat pop, catchy, bright, energetic, radio-ready, feel-good summer vibe', instruments: ['synth', 'electric guitar', 'bass', 'drums', 'handclaps'], bpm: 118, tonalite: 'C major', mesure: '4', voix: 'female' },
  { id: 'house', nom: 'House club', style: 'deep house, club, groovy, four-on-the-floor, hypnotic, euphoric drop', instruments: ['analog synth bass', 'kick drum', 'hi-hats', 'piano chords', 'pads'], bpm: 124, tonalite: 'F minor', mesure: '4', voix: 'none' },
  { id: 'cinematic', nom: 'Cinematic epic', style: 'epic cinematic orchestral, trailer music, heroic, building tension, powerful finale', instruments: ['strings', 'brass', 'taiko drums', 'choir', 'timpani'], bpm: 90, tonalite: 'D minor', mesure: '4', voix: 'choir' },
  { id: 'folk', nom: 'Acoustic folk', style: 'acoustic folk, warm, intimate, storytelling, organic, campfire feeling', instruments: ['acoustic guitar', 'harmonica', 'banjo', 'light percussion'], bpm: 100, tonalite: 'G major', mesure: '4', voix: 'male' },
  { id: 'trap', nom: 'Trap', style: 'trap, hard-hitting, dark, modern hip hop, rolling hi-hats, heavy 808', instruments: ['808 bass', 'trap drums', 'hi-hat rolls', 'dark synth lead'], bpm: 140, tonalite: 'C minor', mesure: '4', voix: 'male' },
  { id: 'jazz', nom: 'Jazz lounge', style: 'smooth jazz lounge, swing, elegant, cozy, late-night cocktail bar', instruments: ['piano', 'upright bass', 'brushed drums', 'saxophone'], bpm: 110, tonalite: 'Bb major', mesure: '4', voix: 'none' },
  { id: 'synthwave', nom: 'Synthwave', style: 'synthwave, retro 80s, neon, nostalgic, driving, cinematic night drive', instruments: ['analog synth', 'gated reverb drums', 'arpeggiator', 'synth bass'], bpm: 105, tonalite: 'E minor', mesure: '4', voix: 'none' },
  { id: 'reggaeton', nom: 'Reggaeton', style: 'reggaeton, latin urban, dembow rhythm, sensual, danceable, party', instruments: ['dembow drums', 'synth bass', 'latin percussion', 'plucked synth'], bpm: 95, tonalite: 'A minor', mesure: '4', voix: 'male' },
  { id: 'ambient', nom: 'Ambient', style: 'ambient, ethereal, calm, spacious, meditative, slowly evolving textures', instruments: ['pads', 'soft piano', 'field recordings', 'reverb guitar'], bpm: 70, tonalite: 'D major', mesure: '4', voix: 'none' },
  { id: 'rock', nom: 'Rock', style: 'energetic rock, anthemic, powerful, driving guitars, stadium chorus', instruments: ['distorted electric guitar', 'bass guitar', 'live drums'], bpm: 122, tonalite: 'E minor', mesure: '4', voix: 'male' },
  { id: 'rnb', nom: 'R&B', style: 'modern R&B, smooth, soulful, sensual, silky groove, intimate', instruments: ['electric piano', 'sub bass', 'snappy drums', 'guitar licks'], bpm: 85, tonalite: 'Eb major', mesure: '4', voix: 'female' },
  { id: 'valse', nom: 'Waltz', style: 'romantic waltz, elegant, sweeping, classic ballroom', instruments: ['strings', 'piano', 'accordion'], bpm: 90, tonalite: 'F major', mesure: '3', voix: 'none' },
]

const NOTES = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']
export const TONALITES_MAJEURES = NOTES.map(n => `${n} major`)
export const TONALITES_MINEURES = NOTES.map(n => `${n} minor`)

/** Mesures : valeur envoyée au serveur, libellé affiché. */
export const MESURES: [Exclude<Mesure, ''>, string][] = [['2', '2/4'], ['3', '3/4'], ['4', '4/4'], ['6', '6/8']]

/** Voix chantée : valeur envoyée au serveur, libellé (clé t()). */
export const VOIX_CHANTEES: [Exclude<VoixChantee, ''>, string][] = [
  ['female', 'Voix de femme'], ['male', 'Voix d’homme'], ['duet', 'Duo homme et femme'], ['choir', 'Chœur'], ['none', 'Aucune (instrumental)'],
]

/** Langues chantées proposées (codes acceptés par ACE-Step). */
export const LANGUES_CHANT: [string, string][] = [
  ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'], ['de', 'Deutsch'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'], ['tr', 'Türkçe'], ['ar', 'العربية'],
  ['hi', 'हिन्दी'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'], ['yue', '粵語'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['sv', 'Svenska'],
]

/** Instruments proposés en un clic (on peut aussi en écrire d'autres). */
export const INSTRUMENTS_COURANTS = ['piano', 'acoustic guitar', 'electric guitar', 'bass', 'drums', '808 bass', 'synth', 'pads', 'strings', 'brass', 'saxophone', 'violin', 'flute', 'choir', 'percussion']

/** Balises de structure reconnues par ACE-Step. */
export const BALISES_PAROLES = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Bridge]', '[Outro]', '[Instrumental]']
export const SQUELETTE_PAROLES = '[Intro]\n\n[Verse]\n\n\n[Chorus]\n\n\n[Verse]\n\n\n[Chorus]\n\n\n[Bridge]\n\n\n[Chorus]\n\n\n[Outro]\n'
