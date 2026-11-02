/* ============================================================
   Réécriture de prompt par LLM local (Ollama), SUR CPU.

   POURQUOI CPU. Mesures :

     llama 8B       CPU   19 s   12,1 tok/s
     mistral-small  CPU   50 s    4,1 tok/s   |  GPU : HTTP 500
     qwen3:14b      CPU  115 s    6,3 tok/s   |  GPU : 11 s, 73 tok/s

   Le GPU est ~12x plus rapide, mais mistral-small y échoue quand ComfyUI
   tient 21,5 Go des 32. Le chemin GPU n'est pas
   « plus rapide », il est conditionnel à ce que la carte soit libre —
   c'est l'OOM que CONFIG.ollamaUnload évite.
   Sur CPU il n'y a plus d'arbitrage avec la diffusion, et les 91 Go de
   RAM absorbent le modèle sans gêner personne.

   Corollaire : les 70B sont hors jeu ici. À ~4 tok/s pour un modèle de
   14 Go, un Hermes 70B en Q4 tomberait vers 1 tok/s, soit deux à trois
   minutes par réécriture.

   POURQUOI ICI ET PAS DANS LA RECETTE. Un nœud OllamaGenerateV2 dans le
   graphe réécrirait le prompt PENDANT le job : on ne découvrirait le
   texte qu'après coup, dans la provenance, et la file de génération
   attendrait le LLM. Ici, la réécriture arrive dans « Prompt composé »
   AVANT l'envoi — relisible, corrigeable, et les secondes de CPU sont
   dépensées pendant qu'un humain lit, pas pendant que le GPU chôme.
   C'est aussi le seul emplacement où le champ « Directive au LLM » de
   la console veut dire quelque chose.
   ============================================================ */
import crypto from 'node:crypto'
import * as wildcards from './wildcards.js'
import { CONFIG } from './config.js'
import { fetchOllama } from './gpu.js'
import { promptFor, readPrompt } from './prompts.js'

/** Négatif de base. Les recettes Klein tournent à cfg 1.0 avec
 *  ConditioningZeroOut : ce texte n'y agit PAS. Il est produit pour la
 *  traçabilité et pour les recettes à cfg>1 qui, elles, le liront. */
const BASE_NEGATIVE = 'plastic smooth skin, perfect symmetry, blurry, extra fingers, watermark, nudity'

/* System prompt du réécriveur = INTENTION + MOTEUR (diffusion), deux fichiers
   concaténés et LUS SUR LE DISQUE à chaque appel — donc modifiables depuis le
   Workbench sans redémarrage. L'intention dit ce qu'on veut (sujet, limites),
   le moteur dit comment écrire pour lui (ordre, langue, longueur, parole).
   `engine` : 'wan' | 'ltx' | 'ltx_hq' | 'minimax' | 'motion' en vidéo (HQ
   partage le fichier LTX) ; en photo le moteur vient de
   CREATOROS_PHOTO_ENGINE. Repli sur les rewrite_* si un fichier manque. */
/** Moteur de diffusion photo. `klein` (défaut) ou `krea`. */
export const PHOTO_ENGINE_DEFAUT = 'krea'
const PHOTO_ENGINE = CONFIG.photoEngine

export function systemFor(register, mode = 'photo', engine = null, opts = {}) {
  // SOUL (persona) + MOOD (scène) : couches ADDITIVES, défaut OFF. `soul` et
  // `mood` sont des NOMS (→ soul_<nom>.txt / mood_<nom>.txt, relus du disque).
  // Contrainte absolue : soul=null ET mood=null ⇒ résultat STRICTEMENT identique
  // à intent + moteur. Elles s'insèrent dans l'ordre intent + soul + mood +
  // moteur, et sont TOLÉRANTES (un fichier absent est ignoré).
  const { soul = null, mood = null } = opts
  // Retouche par instruction : le system prompt est AUTO-SUFFISANT (engine_edit.txt).
  // L'intention dit « écris un prompt qui DÉCRIT une scène », ce qui contredit
  // une instruction d'édition (« change la robe en rouge »).
  if (mode !== 'video' && engine === 'edit') {
    try { return readPrompt('engine_edit.txt') } catch { /* repli plus bas */ }
  }
  const engineKey = mode === 'video'
    ? ({ ltx_hq: 'ltx' }[engine] ?? engine ?? 'wan')
    : (engine && engine !== 'edit' ? engine : PHOTO_ENGINE)
  try {
    const layers = [readPrompt('intent_sfw.txt')]
    /* Exemples few-shot du STYLE CIBLE, fournis par l'opérateur, photo
       seulement. Jamais en vidéo — ils y importaient leur décor alors que la
       still fixait un autre lieu. */
    if (mode !== 'video') { try { layers.push(readPrompt('examples_sfw.txt')) } catch { /* pas d'exemples */ } }
    if (soul) { try { layers.push(readPrompt(`soul_${soul}.txt`)) } catch { /* couche absente, ignorée */ } }
    if (mood) { try { layers.push(readPrompt(`mood_${mood}.txt`)) } catch { /* couche absente, ignorée */ } }
    layers.push(readPrompt(`engine_${engineKey}.txt`))
    return layers.join('\n\n')
  } catch {
    return promptFor(mode === 'video' ? 'rewrite_video' : 'rewrite', 'sfw')
  }
}

/** Lint anti-apparence pour les couches SOUL/MOOD : elles ne doivent décrire
 *  QUE comportement et atmosphère, jamais l'apparence (celle-ci vient de la
 *  LoRA + du préambule). Non bloquant : rend la liste des mots d'apparence
 *  trouvés, pour un signal dans le Workbench. */
const APPEARANCE_RE = /\b(hair|eyes?|skin|freckled?|freckles?|body|figure|physique|face|facial|lips?|mouth|complexion|tanned?|tan|clothing|clothes|clothed|outfit|dress|shirt|shorts|blonde|brunette|hips?|waist|tall|slim|toned)\b/gi
export function lintAppearance(text) {
  return [...new Set((String(text).match(APPEARANCE_RE) || []).map(w => w.toLowerCase()))]
}

/** Modèle du rédacteur. Un seul registre, donc un seul modèle — la
 *  signature garde `register` pour les appelants. */
export function modelFor() {
  return CONFIG.composerModels.sfw
}

/** Réécrit le prompt. Lève une erreur explicite plutôt que de rendre un texte
 *  approximatif : un composeur qui échoue en silence renverrait le prompt brut
 *  et on croirait le LLM médiocre. */
/* Sous ce seuil, la réponse n'est pas un prompt d'image : c'est une phrase.
   un modèle 8B le fait par intermittence — mesuré 20 mots puis 162 sur la
   MÊME entrée. Un seul mot d'insistance suffit à le remettre en piste, et la
   relance ne coûte que quand elle est nécessaire. */
const MIN_WORDS = 60
const INSIST = '\n\nIMPORTANT: your previous answer was far too short. Write the '
  + 'FULL descriptive paragraph of 130-180 words, covering setting, pose, '
  + 'wardrobe, light, camera and skin. Do not answer with a single sentence.'

/* ---------- répliques : protégées du LLM, pas confiées à lui ----------
   Un brief vidéo porte ce que le personnage DIT, souvent en français ou en
   mélange. Un modèle 8B traduit la réplique quelle que soit la consigne
   (règle en dernière ligne comprise : « coucou toi » → « Hi there »). On sort
   donc les segments entre guillemets AVANT l'appel, remplacés par un jeton
   {{LINE n}}, et on les remet APRÈS, caractère pour caractère. Un jeton
   perdu par le modèle → la réplique est rajoutée en fin de texte plutôt
   que perdue. Guillemets reconnus : « … », "…", “…”. */
const QUOTE_RE = /«\s*([^»]+?)\s*»|"([^"\n]+?)"|“([^”]+?)”/g
export function shieldLines(text) {
  const lines = []
  const out = String(text).replace(QUOTE_RE, (m, a, b, c) => {
    lines.push((a ?? b ?? c).trim())
    return `{{LINE ${lines.length}}}`
  })
  return { out, lines }
}
export function unshieldLines(text, lines, { drop = false } = {}) {
  let out = String(text)
  lines.forEach((line, i) => {
    const re = new RegExp(`["“«]?\\{\\{\\s*LINE\\s*${i + 1}\\s*\\}\\}["”»]?`, 'g')
    if (drop) {
      /* Moteur MUET (Wan) : la consigne moteur fait supprimer les répliques ;
         si le LLM laisse traîner un jeton, on l'efface au lieu d'y remettre
         les mots — et on ne ré-injecte jamais une réplique absente. */
      out = out.replace(re, '').replace(/\s{2,}/g, ' ')
    } else if (re.test(out)) {
      out = out.replace(re, `"${line}"`)
    } else {
      out = `${out.trim().replace(/[.\s]+$/, '')}. She says: "${line}"`
    }
  })
  return out
}

export async function compose({ register = 'sfw', userPrompt = '', userDirectives = '', mode = 'photo', engine = null, soul = null, mood = null, sceneDesc = null, previousPrompt = null, outfitAnchor = null }) {
  const model = modelFor(register, mode)
  // Un brief de mouvement court (« elle sourit, push-in lent ») donne
  // légitimement 30 mots ; exiger 60 forçait le modèle à broder.
  // Retouche : la sortie DOIT être courte (2 phrases). Un plancher de mots
  // déclencherait la relance INSIST « étoffe » — l'exact inverse de ce qu'on
  // veut, et la cause du délayage en description de scène.
  const minWords = mode === 'video' ? 25 : engine === 'edit' ? 0 : MIN_WORDS
  /* Un item « 🎲 au hasard » arrive ici sous forme de token : le LLM ne sait
     pas ce qu'est `__tenues*__` et l'inventerait. On tire AVANT de
     réécrire, avec une seed jetable (le job n'existe pas encore) : le texte
     composé porte alors une tenue concrète, et c'est elle que la provenance
     gardera. Corollaire assumé : un lot composé partage le même tirage ; un
     lot envoyé SANS composer tire une ligne par job. */
  const drawn = wildcards.resolve(userPrompt, crypto.randomInt(2 ** 31))
  // Répliques hors de portée du LLM en vidéo (voir shieldLines).
  const shielded = mode === 'video' ? shieldLines(drawn.text) : { out: drawn.text, lines: [] }
  const brief = userDirectives.trim()
    ? `${shielded.out.trim()}\n\nDIRECTIVES (priority over defaults): ${userDirectives.trim()}`
    : shielded.out.trim()
  if (!brief) throw new Error('rien à réécrire : le prompt est vide')

  /* ---------- contexte visuel (VLM) ----------
     Sans la still, le réécriveur travaille EN AVEUGLE et invente la tenue et
     la pose de départ : il change une robe, ou fait se lever quelqu'un d'assis.
     En vidéo c'est disqualifiant : la règle « START IN THE IMAGE'S EXACT POSE »
     lui demande de décrire un état initial qu'il ne connaîtrait pas.

     La description du VLM est une ENTRÉE, au même titre que le brief, et
     elle est SUBORDONNÉE à lui : l'image dit ce qui EST, le brief dit ce qui
     doit ARRIVER. Le contrat est écrit noir sur blanc dans le message, car
     sans lui le modèle traite la description comme une consigne et se
     contente de paraphraser l'image au lieu d'exécuter le brief. */
  const desc = String(sceneDesc ?? '').trim()

  /* ---------- continuation (onglet Étendre) ----------
     Le nouveau clip démarre sur la DERNIÈRE image du précédent : la
     description VLM ci-dessus en dit l'état visuel, mais pas l'intention.
     Sans le prompt du plan précédent, le réécriveur ne sait ni ce qui a déjà
     été joué (il le rejoue), ni à quel rythme la scène allait (il redémarre
     plus vite ou plus lentement), ni vers quoi elle tendait. On lui donne ce
     prompt comme CONTEXTE, avec les règles de raccord, et la même mise en
     garde que pour la description : le lire, jamais le recopier. */
  const prev = String(previousPrompt ?? '').trim().slice(0, 6000)
  const suite = prev
    ? '<previous_shot>\n' + prev + '\n</previous_shot>\n\n'
      + 'The block above is the prompt of the PREVIOUS clip. The new clip is its direct continuation: '
      + 'it starts exactly on the last frame of that clip' + (desc ? ', described in <source_image> below' : '')
      + '. Write the next beat of the same scene:\n'
      + '- keep the same spirit, tone, energy and rhythm; the first movement of the new clip starts at the '
      + 'pace the previous clip ended on — no sudden speed-up, no slow restart from stillness;\n'
      + '- never repeat an action the previous clip already completed; an action it left unfinished is '
      + 'carried to its end first;\n'
      + '- carry its intent forward toward what the brief asks;\n'
      + '- keep the same camera language (type of framing, camera behaviour) unless the brief changes it;\n'
      /* Sans cette règle, le réécriveur reprend l'état de DÉPART du clip précédent
         (« tasse pleine à ras bord ») alors que ce clip finit sur une tasse bue. Le prompt précédent
         raconte un début ; la dernière image montre la fin. */
      + '- the previous prompt describes how that clip STARTED, not how it ended: for the current state '
      + '(what she holds, what is full or empty, spilled or tidy, where things and people are) the '
      + 'last frame is the truth' + (desc ? ' — follow <source_image> wherever the two disagree' : '') + ';\n'
      + '- it is context, not text to reuse: do not copy its sentences.\n\n'
    : ''
  /* Tenue verrouillée (« Tenue de l'image ») : le texte vient d'un appel VLM
     dédié, filtré en code. Le réécriveur est prévenu qu'il ne doit PAS
     décrire la tenue, parce que c'est le code qui l'insère plus bas — on ne
     compte pas sur lui pour la recopier fidèlement. Le verrou prime sur le
     brief : c'est un choix explicite de l'opérateur. */
  const tenue = String(outfitAnchor ?? '').trim()
  const verrouTenue = tenue && engine !== 'edit'
    ? `OUTFIT — fixed by the pipeline: she wears exactly "${tenue}". Do NOT describe, name, change or remove her `
      + 'clothing anywhere in your output, even if the brief mentions clothing: the pipeline inserts this exact '
      + 'outfit description itself. Write everything else as usual.\n\n'
    : ''
  const prompt = verrouTenue + suite + (desc
    /* La description est ENCADRÉE et annoncée comme de la donnée. Laissée en
       prose libre, ce modèle en recopie les phrases telles quelles
       (« The mood is bright and sunny », « The camera angle is straight-on »),
       alors que le moteur interdit explicitement ce vocabulaire méta. Même piège que les exemples
       concrets dans les consignes du VLM et que les MARKERS du composeur :
       ce qui est montré est recopié, donc on dit quoi en faire. */
    ? '<source_image>\n' + desc + '\n</source_image>\n\n'
      + 'The block above is a CAPTION of the still, written by a vision model. It is reference '
      + 'DATA about the first frame — the starting pose, the outfit, the setting. Read it, do not '
      + 'reuse it: never copy its sentences or its vocabulary into your output, and carry over '
      + 'none of its statements about mood, camera angle or photo quality. Write the starting state '
      + 'in your own words, in the required format.\n\n'
      + 'TASK — write the brief below as motion starting from that first frame. The brief WINS on '
      + 'any conflict: where it asks for a change (a different outfit, a new location), '
      + 'follow the brief; the image informs only what the brief leaves unsaid.\n\n'
      + brief
    : brief)

  const t0 = Date.now()
  const ask = async text => {
  const ctl = AbortSignal.timeout(CONFIG.composerTimeoutMs)
  let res
  try {
    res = await fetchOllama(`${CONFIG.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl,
      body: JSON.stringify({
        model, system: systemFor(register, mode, engine, { soul, mood }), prompt: text, stream: false,
        // qwen3 : sans ce champ le « thinking » consomme des minutes de CPU
        // (422 s mesurées) ; ignoré par les modèles non-thinking.
        think: false,
        // keep_alive 0 : le modèle quitte la RAM dès la réponse. Il en reste
        // assez pour tout le monde, mais un modèle résident pour rien est une
        // dette qu'on paie au prochain pic.
        keep_alive: 0,
        // num_gpu 0 : valeur de repli. fetchOllama (gpu.js)
        // la retire quand la carte est prise pour Ollama, et la garde quand un
        // long rendu occupe la carte.
        // Retouche : température basse — on veut une instruction littérale et
        // stable, pas de la variété créative qui part en description.
        options: { num_gpu: 0, num_ctx: 4096, temperature: engine === 'edit' ? 0.3 : 0.8 },
      }),
    })
  } catch (e) {
    throw new Error(e.name === 'TimeoutError'
      ? `délai dépassé (${CONFIG.composerTimeoutMs / 1000} s) sur ${model} — le CPU est lent, `
        + 'réessayer ou choisir un modèle plus léger'
      : `Ollama injoignable sur ${CONFIG.ollamaUrl} : ${e.message}`)
  }
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} pour ${model}`)
  const d = await res.json()
  return { text: String(d.response || '').trim(), tokens: d.eval_count ?? null }
  }

  let { text: positive, tokens } = await ask(prompt)
  let retried = false
  if (positive && positive.split(/\s+/).length < minWords) {
    retried = true
    const second = await ask(prompt + INSIST)
    // On garde la plus étoffée : la relance peut elle aussi rater son coup,
    // et rendre alors la PIRE des deux serait une régression pure.
    if (second.text.split(/\s+/).length > positive.split(/\s+/).length) {
      positive = second.text
      tokens = second.tokens
    }
  }
  if (!positive) throw new Error(`${model} n'a rien produit`)
  /* Anti-copie des EXEMPLES few-shot (« beach condo slider door » importé
     dans une vidéo i2v dont la still fixe le décor). Les marqueurs signature des exemples ne peuvent apparaître que si
     le brief les contient — sinon un retry dur. */
  if (engine !== 'edit') {
    const MARKERS = ['beach condo', 'slider door', 'public library', 'bookshelves',
      'gray mini dress', 'knitted cardigan']
    const copied = MARKERS.filter(m => positive.toLowerCase().includes(m) && !prompt.toLowerCase().includes(m))
    if (copied.length) {
      retried = true
      const strict = await ask(prompt
        + `\n\nSTRICT RETRY: your previous rewrite copied these from the style EXAMPLE, which the brief never mentions: ${copied.join(', ')}. `
        + (mode === 'video' ? 'The provided image alone defines the setting and outfit — never invent or import either. '
          : 'Only the brief defines the setting, outfit and props. ')
        + 'Rewrite without them.')
      const still = MARKERS.filter(m => strict.text.toLowerCase().includes(m) && !prompt.toLowerCase().includes(m))
      if (strict.text && !still.length) { positive = strict.text; tokens = strict.tokens }
    }
  }
  positive = unshieldLines(positive, shielded.lines, { drop: mode === 'video' && ['wan', 'motion'].includes(engine ?? 'wan') })
  /* Gabarits de réplique ORPHELINS. Sur un brief sans réplique, le
     réécriveur peut inventer une phrase ET recopier le gabarit de la consigne
     moteur : `<d>[French] {{LINE 1}}</d>`.
     unshieldLines ne remplit que les gabarits d'une vraie réplique du brief :
     celui-ci partirait tel quel au moteur, qui prononcerait « LINE ».
     On retire le bloc <d> vide (avec son « X (S1) says: ») et tout jeton
     restant. */
  if (/\{\{\s*LINE\s*\d+\s*\}\}/i.test(positive)) {
    positive = positive
      .replace(/(?:[A-Z][\w ]{0,30}\(S\d\)\s*says(?: in an off-screen voiceover)?:\s*)?<d>\s*(?:\[[A-Za-z]+\]\s*)?["“«]?\{\{\s*LINE\s*\d+\s*\}\}["”»]?\s*<\/d>/gi, '')
      .replace(/["“«]?\{\{\s*LINE\s*\d+\s*\}\}["”»]?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
  }
  /* Le rédacteur emballe parfois la description H3 dans des balises <p> (tic
     stochastique). Le format MiniMax n'en
     veut pas, et une consigne de plus ne tiendrait pas mieux que les autres
     gardes textuelles : on les retire mécaniquement. Les balises <d> des
     répliques, elles, font PARTIE du format et survivent. */
  if (mode === 'video') positive = positive.replace(/<\/?p>/g, '').replace(/[ \t]{2,}/g, ' ').trim()

  /* Marqueur [Shot 1] — garde MÉCANIQUE, propre aux moteurs MiniMax (seuls
     engine_minimax*.txt l'exigent ; WAN et LTX n'en veulent pas).
     Le modèle l'écrit spontanément sur un brief seul, mais le laisse tomber dès
     qu'on lui fournit la description d'image : il a alors assez de matière
     pour attaquer directement sur un horodatage. Le rappeler dans le message
     le fait replacer AVANT le nom du champ, ce qui casse la structure : on
     répare en code.
     Le marqueur sert à interdire les coupes ; l'horodatage qui suit est
     légitime et reste en place. */
  if (mode === 'video' && String(engine ?? '').startsWith('minimax') && !/\[Shot 1\]/.test(positive)) {
    positive = positive.replace(/(integrated_multimodal_description:\s*\n?)/i, '$1[Shot 1] ')
  }

  /* Marqueurs de plan INVENTÉS — garde mécanique, moteurs MiniMax.
     Sur un brief à plan unique, le réécriveur peut produire
     « [Continue from Shot 1] » au milieu de la description. Le moteur lit
     tout marqueur comme une coupe, alors que la règle du moteur interdit
     d'inventer des plans. On retire donc tout marqueur autre que [Shot 1]
     — sauf si le BRIEF en contient lui-même (multi-plan voulu). Le texte
     qui suivait le marqueur est conservé : seule l'étiquette disparaît. */
  if (mode === 'video' && String(engine ?? '').startsWith('minimax')
      && !/\[\s*shot\s*[2-9]/i.test(String(userPrompt ?? ''))) {
    const EXTRA = /\[\s*(?:continue[^\]]*|shot\s*(?:[2-9]|\d{2,})[^\]]*|cut[^\]]*|next shot[^\]]*)\]\s*/gi
    if (EXTRA.test(positive)) {
      positive = positive.replace(EXTRA, '').replace(/\n{3,}/g, '\n\n').trim()
    }
  }

  /* Insertion CODE de la tenue verrouillée — au début de la scène pour
     MiniMax (juste après [Shot 1]), en tête du texte ailleurs. */
  if (verrouTenue) {
    /* « her » plutôt qu'un article : la liste du VLM est brute (« dark green
       dress », « black lace bra, white thigh-high stockings ») et « her »
       se lit correctement devant l'une comme devant l'autre. */
    const phrase = `She is wearing her ${tenue}, exactly as in the provided image.`
    if (mode === 'video' && String(engine ?? '').startsWith('minimax') && /\[Shot 1\]/.test(positive))
      positive = positive.replace(/\[Shot 1\]\s*/, `[Shot 1] ${phrase} `)
    else
      positive = `${phrase} ${positive}`
  }

  /* Retouche : garde-fou MÉCANIQUE contre le délayage. Le format impose de
     terminer par la clause de préservation « … unchanged. » ; on coupe tout
     ce qui suit la PREMIÈRE occurrence. Un modèle CPU obéit mal à « deux
     phrases et stop » (« robe rouge » s'arrête, « enlève les
     lunettes » repart en description de scène) — on ne compte pas dessus, on
     tronque. Repli : si « unchanged » est absent, on garde le texte tel quel. */
  if (engine === 'edit') {
    const m = positive.match(/^([\s\S]*?\bunchanged\b\.?)/i)
    if (m) positive = m[1].trim()
  }

  return {
    positive,
    retried,
    negative: BASE_NEGATIVE,
    model,
    device: 'cpu', draws: drawn.draws,
    ms: Date.now() - t0,
    tokens,
  }
}
