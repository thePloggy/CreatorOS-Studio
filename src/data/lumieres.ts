/* Lumière : la même photo, un autre éclairage. */
export const GARDE = 'Only the light changes: keep the same place and background, the same subject, face, pose, outfit and framing.'
export const LUMIERES = [
  { id: 'gauche', label: 'Par la gauche', consigne: `Relight the photo with a strong directional key light coming from the left: bright, crisp light on the left side of the subject and deep, well-defined shadows falling to the right, high contrast, dramatic chiaroscuro modelling, the background darker. ${GARDE}` },
  { id: 'droite', label: 'Par la droite', consigne: `Relight the photo with a strong directional key light coming from the right: bright, crisp light on the right side of the subject and deep, well-defined shadows falling to the left, high contrast, dramatic chiaroscuro modelling, the background darker. ${GARDE}` },
  { id: 'fenetre', label: 'Fenêtre', consigne: `Relight the photo with bright, soft daylight coming from one side only, as on an overcast afternoon: a luminous key side, a gradual fall-off into soft shadow on the other side, gentle contrast, natural colours. The scene, the place and the background stay exactly as they are, outdoors stays outdoors. ${GARDE}` },
  { id: 'studio', label: 'Studio', consigne: `Relight the subject with punchy professional studio lighting: a strong key light at 45 degrees with crisp highlights, a dark shadow side with little fill, a bright rim light outlining the subject, high contrast, the background falling off into darkness, in the same place; do not add a studio, a backdrop or equipment. ${GARDE}` },
  { id: 'bleue', label: 'Heure bleue', consigne: `Relight the photo to cool blue hour dusk light. ${GARDE}` },
  { id: 'neon', label: 'Néons', consigne: `Relight the photo with magenta and cyan neon-coloured light falling on the subject from both sides, at night, in the same place; do not add signs, tubes or buildings. ${GARDE}` },
  { id: 'bougie', label: 'Bougie', consigne: `Relight the photo with the warm, low, flickering glow of candlelight falling on the subject, the rest of the scene darker and dimmer, in the same place; do not add a room, walls or candles that are not there. ${GARDE}` },
  { id: 'or', label: 'Heure dorée', consigne: `Relight the photo to warm golden hour sunlight with long soft shadows. Keep the person, pose, outfit and framing unchanged.` },
  { id: 'nuit', label: 'Nuit', consigne: `Turn the same scene into night time: only the light and the sky change. Soft cool moonlight, a deep blue night sky, and warm light only from sources that already belong in this place. Keep exactly the same place, background, subject, pose, outfit and framing; add no buildings, no city, no new objects.` },
  { id: 'coucher', label: 'Couchant de feu', consigne: `Change the sky and light to a dramatic burning orange and crimson sunset. Keep the person, pose, outfit and framing unchanged.` },
]
/* Agrandir : la photo élargie à un format, les bords inventés (Qwen-Image-Edit). */
export const FORMATS = ['16:9', '9:16', '4:5', '1:1', '+30%']
