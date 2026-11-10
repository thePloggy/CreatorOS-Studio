/* Music studio: presets and option lists. A preset fills every form field, which the
   user can then edit. The lists match the values accepted by the server (and the
   ACE-Step node): key, time signature, language, singing voice. */

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
  { id: 'boombap', nom: 'Hip-hop boom bap', style: 'classic boom bap hip hop, 90s east coast, gritty, head-nodding groove, dusty jazz samples, scratches', instruments: ['dusty drum break', 'jazz piano sample', 'upright bass', 'vinyl scratches'], bpm: 90, tonalite: 'D minor', mesure: '4', voix: 'male' },
  { id: 'gfunk', nom: 'Hip-hop G-funk', style: 'west coast g-funk hip hop, laid-back, sunny, bouncy groove, whiny synth lead, summer cruising', instruments: ['moog synth bass', 'whistle synth lead', 'talkbox', 'funk drums'], bpm: 95, tonalite: 'G minor', mesure: '4', voix: 'male' },
  { id: 'hiphopfem', nom: 'Hip-hop melodic', style: 'modern melodic hip hop, confident, catchy hook, punchy drums, smooth flow', instruments: ['808 bass', 'crisp drums', 'piano chords', 'plucked synth'], bpm: 100, tonalite: 'F minor', mesure: '4', voix: 'female' },
  { id: 'drill', nom: 'Hip-hop drill', style: 'uk drill hip hop, dark, sliding 808s, sparse menacing melody, energetic flow', instruments: ['sliding 808 bass', 'drill hi-hats', 'dark piano', 'string stabs'], bpm: 142, tonalite: 'C# minor', mesure: '4', voix: 'male' },
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

/** Time signatures: value sent to the server, displayed label. */
export const MESURES: [Exclude<Mesure, ''>, string][] = [['2', '2/4'], ['3', '3/4'], ['4', '4/4'], ['6', '6/8']]

/** Singing voice: value sent to the server, label (t() key). */
export const VOIX_CHANTEES: [Exclude<VoixChantee, ''>, string][] = [
  ['female', 'Voix de femme'], ['male', 'Voix d’homme'], ['duet', 'Duo homme et femme'], ['choir', 'Chœur'], ['none', 'Aucune (instrumental)'],
]

/** Offered singing languages (codes accepted by ACE-Step). */
export const LANGUES_CHANT: [string, string][] = [
  ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'], ['de', 'Deutsch'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'], ['tr', 'Türkçe'], ['ar', 'العربية'],
  ['hi', 'हिन्दी'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'], ['yue', '粵語'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['sv', 'Svenska'],
]

/** One-click instruments (others can be typed). */
export const INSTRUMENTS_COURANTS = ['piano', 'acoustic guitar', 'electric guitar', 'bass', 'drums', '808 bass', 'synth', 'pads', 'strings', 'brass', 'saxophone', 'violin', 'flute', 'choir', 'percussion']

/** Structure tags recognized by ACE-Step. */
export const BALISES_PAROLES = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Bridge]', '[Outro]', '[Instrumental]']
export const SQUELETTE_PAROLES = '[Intro]\n\n[Verse]\n\n\n[Chorus]\n\n\n[Verse]\n\n\n[Chorus]\n\n\n[Bridge]\n\n\n[Chorus]\n\n\n[Outro]\n'

/* The key is sent in short notation ("Dm", "F#", "Bbm"): the English word "minor" would
   trip the demo's content filter. The server expands it for ACE-Step. */
export const codeTonalite = (k: string) => k.replace(/ minor$/, 'm').replace(/ major$/, '')

/** Sound effect examples, inserted into the field on click (texts checked against the content filter). */
export const EXEMPLES_BRUITAGE = [
  'a heavy wooden door creaking open', 'rain on a tin roof, distant thunder', 'footsteps on gravel, slow and heavy',
  'a glass bottle shattering on a stone floor', 'city traffic at night, distant sirens', 'ocean waves on a pebble beach, gulls',
  'small crowd applauding in a wooden hall', 'retro arcade coin pickup blip',
]
