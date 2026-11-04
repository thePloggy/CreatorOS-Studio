/* ============================================================
   Formats de reels — les codes des réseaux sociaux (Instagram, TikTok).
   Le réalisateur choisit d'abord le format qui va au brief, puis écrit
   avec les règles de ce format seulement. Chaque format dit :
   - regles      comment on le tourne (ce qui change d'un plan à l'autre,
                 ce qui ne change pas, le geste de la coupe) ;
   - cadrageFixe même cadrage, même angle, caméra fixe sur tous les plans ;
   - tenueParPlan une tenue par plan (la tenue est le sujet) ;
   - coupe       'coupe' (coupe franche, sur le temps) ou 'fondu' ;
   - dureePlan   durée d'un plan au montage, en secondes (le clip est
                 rendu plus long, le montage n'en garde que le début).
   Les textes ne contiennent pas d'exemple de lieu : le réalisateur
   recopierait l'exemple dans tous les reels.
   ============================================================ */

export const FORMATS = {
  journee: {
    nom: 'Day in the life',
    quand: 'an outing, a trip, a day somewhere, a walk, a place to discover — she goes through several places',
    regles: `Format "day in the life": she goes through ${'${n}'} different places of her moment, one action per place, in the order real life would have it. Each step starts where the previous one ended. Never two steps of the same kind of place or activity.`,
    cadrageFixe: false, tenueParPlan: false, coupe: 'coupe', dureePlan: null,
  },
  transition: {
    nom: 'Outfit transition',
    quand: 'trying outfits, a glow-up, getting dressed, a style change, a before/after look — the outfit is the subject',
    regles: `Format "outfit transition": every shot is filmed at EXACTLY the same spot, same framing, same camera position, static camera — only her outfit changes. Shot 1 starts simple (a comfortable home outfit), each next shot adds or swaps one thing (a dress, then a bag, then a hat, then shoes…) and the last shot is the complete look, ready to go out. The cut hides the change: the still of every shot catches her in the air at the top of a small jump in place (or in the middle of a spin), and the motion is her landing and striking a pose with a confident look to the camera — so each shot starts on the move and the outfit seems to change in mid-air. In the last shot she lands, poses, then takes a step toward the camera. "outfit" of each shot describes her full outfit in that shot. The place does not move: "spot" is the same words in every shot.`,
    cadrageFixe: true, tenueParPlan: true, coupe: 'coupe', dureePlan: 1.8,
  },
  grwm: {
    nom: 'Get ready with me',
    quand: 'getting ready, makeup, skincare, hair, preparing for an event, morning routine',
    regles: `Format "get ready with me": one room (her bathroom or bedroom), one step of her routine per shot in real order (skincare, makeup, hair, getting dressed, final look). She looks at the camera as if talking to a friend. Close shots for the face steps, a wider shot for the final look. The last shot is the finished result with a smile to the camera.`,
    cadrageFixe: false, tenueParPlan: false, coupe: 'coupe', dureePlan: 2.5,
  },
  pov: {
    nom: 'POV',
    quand: 'a "POV" brief, a situation lived through the viewer\'s eyes, a reaction, a relatable moment',
    regles: `Format "POV": the camera is the viewer; she looks straight into the lens and reacts to the viewer as to a person in front of her. One place, a short situation in ${'${n}'} beats with a funny or touching turn. The hook starts with "POV:".`,
    cadrageFixe: false, tenueParPlan: false, coupe: 'coupe', dureePlan: 2.5,
  },
  tendance: {
    nom: 'Trend / dance / challenge',
    quand: 'a dance, a challenge, a trend, a repeated move, a playful pointless challenge',
    regles: `Format "trend": one spot, one short move or challenge repeated or built up across the shots (each shot a different angle or a different stage of the move), on the beat, energetic and playful; the last shot ends on a laugh or a look to the camera.`,
    cadrageFixe: false, tenueParPlan: false, coupe: 'coupe', dureePlan: 1.6,
  },
  voyage: {
    nom: 'Travel montage',
    quand: 'a travel memory, holidays, a city or a landscape to show fast',
    regles: `Format "travel montage": fast cuts through ${'${n}'} different spots of the destination, she is in each one doing one quick thing (a look back, a step into the frame, a twirl, a glance at the view); each spot is a postcard of the place.`,
    cadrageFixe: false, tenueParPlan: false, coupe: 'coupe', dureePlan: 1.8,
  },
}

export const reglesFormat = (id, n) => (FORMATS[id] ?? FORMATS.journee).regles.replaceAll('${n}', String(n))

export const consigneChoix = () => `You pick the format of a short Instagram / TikTok reel from its brief. Formats:
${Object.entries(FORMATS).map(([id, f]) => `- ${id}: ${f.nom} — when the brief is about ${f.quand}`).join('\n')}
Answer with the format that fits the brief best.`

export const SCHEMA_CHOIX = { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: Object.keys(FORMATS) } } }
