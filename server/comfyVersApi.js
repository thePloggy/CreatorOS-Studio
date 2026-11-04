/* ============================================================
   Workflow de l'éditeur ComfyUI (nœuds, liens, sous-graphes, widgets) →
   format API (ce que POST /prompt exécute).

   - Les valeurs des widgets sont rangées par position dans widgets_values ;
     l'ordre des entrées vient d'object_info (requises puis optionnelles), et
     un entier « seed » suivi d'un contrôle (randomize, fixed…) occupe deux places.
   - Sous-graphes : chaque instance est dépliée, ses nœuds prennent l'id
     « instance:nœud ». Une entrée du sous-graphe non branchée laisse au nœud
     intérieur sa propre valeur.
   - Nœuds coupés (mode 2) : retirés. Nœuds contournés (mode 4) : retirés, leurs
     consommateurs reçoivent l'entrée du même type.
   - Nœuds d'interface (Reroute, PrimitiveNode, notes) : traversés ou retirés.
   ============================================================ */

const MUET = 2, CONTOURNE = 4
const ENTREE_SG = -10, SORTIE_SG = -20
const INTERFACE = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'])
// nœuds d'affichage dans l'éditeur, sans rien à rendre ici
const AFFICHAGE = new Set(['ImageCompare', 'PreviewAny', 'Preview3D', 'Preview3DAdvanced'])
const TYPES_WIDGET = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

const DYN = 'COMFY_DYNAMICCOMBO_V3'
const estWidget = (type, opts) => Array.isArray(type) || type === DYN || opts.socketless === true
  || (TYPES_WIDGET.has(type) && !opts.forceInput) || ['COLOR', 'BOUNDING_BOXES'].includes(type)
const aControle = (type, nom, opts) => !!opts.control_after_generate || (type === 'INT' && /(^|\.)(noise_)?seed$/.test(nom))

/** Range widgets_values (positionnel) dans inputs, en suivant object_info ; une liste dynamique
 *  (COMFY_DYNAMICCOMBO_V3) insère après elle les widgets de l'option choisie, nommés « liste.widget ». */
function rangerWidgets(spec, valeurs, inputs, prefixe = '', pos = { k: 0 }) {
  for (const groupe of ['required', 'optional']) {
    for (const [nomBrut, s] of Object.entries(spec?.[groupe] ?? {})) {
      const [type, opts = {}] = Array.isArray(s) ? s : [s]
      if (!estWidget(type, opts)) continue
      const nom = prefixe + nomBrut
      if (pos.k >= valeurs.length) return
      const v = valeurs[pos.k++]
      inputs[nom] = v
      if (aControle(type, nom, opts)) pos.k++
      if (type === DYN) {
        const option = (opts.options ?? []).find(o => o.key === v)
        if (option) rangerWidgets(option.inputs, valeurs, inputs, `${nom}.`, pos)
      }
    }
  }
}

/** Liste des noms de widgets (sans les sous-widgets dynamiques) : pour widgets_values en objet. */
export function widgetsDe(classe, objetInfo) {
  const def = objetInfo[classe]
  if (!def) return null
  const l = []
  for (const groupe of ['required', 'optional'])
    for (const [nom, s] of Object.entries(def.input?.[groupe] ?? {})) { const [type, opts = {}] = Array.isArray(s) ? s : [s]; if (estWidget(type, opts)) l.push(nom) }
  return l
}

const lienObjet = l => Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : l

/** Convertit ; renvoie { graphe, ignores } ou lève une erreur lisible. */
export function versApi(w, objetInfo) {
  const sousGraphes = new Map((w.definitions?.subgraphs ?? []).map(s => [s.id, s]))
  const graphe = {}
  const ignores = new Set()

  function portee(noeuds, liens, prefixe, entrees, parent) {
    return {
      noeuds: new Map(noeuds.map(n => [n.id, n])),
      liens: new Map(liens.map(lienObjet).map(l => [l.id, l])),
      prefixe, entrees, parent,
    }
  }

  /** Ce qui sort de (nœud, slot) dans une portée : [idApi, slot], { valeur }, ou undefined. */
  function origine(p, idNoeud, slot, type) {
    if (idNoeud === ENTREE_SG) return p.entrees[slot]?.()
    const n = p.noeuds.get(idNoeud)
    if (!n || n.mode === MUET) return undefined
    if (n.type === 'Reroute') return entreeDe(p, n, n.inputs?.[0])
    if (AFFICHAGE.has(n.type)) return entreeDe(p, n, (n.inputs ?? []).find(i => i.link != null))
    if (n.type === 'PrimitiveNode') return { valeur: Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined }
    if (n.mode === CONTOURNE) {
      const t = type ?? n.outputs?.[slot]?.type
      const e = (n.inputs ?? []).find(i => i.link != null && (i.type === t || t === '*'))
      return e ? entreeDe(p, n, e) : undefined
    }
    const sg = sousGraphes.get(n.type)
    if (sg) {
      const sp = deplier(p, n, sg)
      const lienSortie = (sg.outputs?.[slot]?.linkIds ?? [])[0]
      const l = sp.liens.get(lienSortie)
      return l ? origine(sp, l.origin_id, l.origin_slot, l.type) : undefined
    }
    return [`${p.prefixe}${n.id}`, slot]
  }

  function entreeDe(p, n, e) {
    if (!e || e.link == null) return undefined
    const l = p.liens.get(e.link)
    return l ? origine(p, l.origin_id, l.origin_slot, l.type) : undefined
  }

  const deplies = new Map()
  function deplier(p, inst, sg) {
    const cle = `${p.prefixe}${inst.id}`
    if (deplies.has(cle)) return deplies.get(cle)
    // valeurs des widgets de l'instance : une par entrée du sous-graphe, dans l'ordre de ses entrées
    const wv = Array.isArray(inst.widgets_values) ? inst.widgets_values : []
    const entrees = (sg.inputs ?? []).map((si, k) => () => {
      const e = (inst.inputs ?? []).find(i => i.name === si.name)
      if (e?.link != null) return entreeDe(p, inst, e)
      if (wv.length === (sg.inputs ?? []).length && wv[k] !== undefined) return { valeur: wv[k] }
      // sans valeur sur l'instance : celle du widget intérieur que cette entrée promeut
      for (const l of (sg.links ?? []).map(lienObjet)) {
        if (l.origin_id !== ENTREE_SG || l.origin_slot !== k) continue
        const cible = (sg.nodes ?? []).find(x => x.id === l.target_id)
        const e = cible?.inputs?.[l.target_slot]
        if (!cible || !e?.widget || !objetInfo[cible.type] || !Array.isArray(cible.widgets_values)) continue
        const vals = {}
        rangerWidgets(objetInfo[cible.type].input, cible.widgets_values, vals)
        if (vals[e.widget.name] !== undefined) return { valeur: vals[e.widget.name] }
      }
      return undefined
    })
    const sp = portee(sg.nodes ?? [], sg.links ?? [], `${cle}:`, entrees, p)
    deplies.set(cle, sp)
    emettre(sp)
    return sp
  }

  function emettre(p) {
    for (const n of p.noeuds.values()) {
      if (n.mode === MUET || n.mode === CONTOURNE || INTERFACE.has(n.type) || AFFICHAGE.has(n.type)) continue
      const sg = sousGraphes.get(n.type)
      if (sg) { deplier(p, n, sg); continue }
      const ordre = widgetsDe(n.type, objetInfo)
      if (!ordre) { ignores.add(n.type); continue }
      const inputs = {}
      const wv = n.widgets_values
      if (Array.isArray(wv)) rangerWidgets(objetInfo[n.type].input, wv, inputs)
      else if (wv && typeof wv === 'object') for (const nom of ordre) if (nom in wv) inputs[nom] = wv[nom]
      for (const e of n.inputs ?? []) {
        const o = entreeDe(p, n, e)
        if (o === undefined) continue
        inputs[e.name] = Array.isArray(o) ? o : o.valeur
      }
      graphe[`${p.prefixe}${n.id}`] = { class_type: n.type, inputs, _meta: { title: n.title ?? n.type } }
    }
  }

  emettre(portee(w.nodes ?? [], w.links ?? [], '', [], null))

  // widgets apparus après l'écriture du workflow : leur valeur par défaut
  for (const n of Object.values(graphe))
    for (const [nom, sp] of Object.entries(objetInfo[n.class_type]?.input?.required ?? {})) {
      if (nom in n.inputs) continue
      const [type, opts = {}] = Array.isArray(sp) ? sp : [sp]
      if (!estWidget(type, opts)) continue
      if (opts.default !== undefined) n.inputs[nom] = opts.default
      else if (Array.isArray(type) && type.length) n.inputs[nom] = type[0]
      else if (Array.isArray(opts.options) && opts.options.length) n.inputs[nom] = typeof opts.options[0] === 'object' ? opts.options[0].key : opts.options[0]
    }
  // retire les liens vers des nœuds qui n'ont pas été émis (classe inconnue)
  for (const n of Object.values(graphe))
    for (const [k, v] of Object.entries(n.inputs))
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !(v[0] in graphe)) delete n.inputs[k]
  return { graphe, ignores: [...ignores] }
}

/** Entrées requises absentes, par nœud : le graphe ne passerait pas la validation de ComfyUI. */
export function entreesManquantes(graphe, objetInfo) {
  const manques = []
  for (const [id, n] of Object.entries(graphe)) {
    const req = objetInfo[n.class_type]?.input?.required ?? {}
    for (const [nom, sp] of Object.entries(req)) {
      const type = Array.isArray(sp) ? sp[0] : sp
      // entrées qui grandissent (images.image_1…) : présentes sous leurs noms dérivés
      if (type === 'COMFY_AUTOGROW_V3') continue
      if (!(nom in n.inputs)) manques.push(`${n.class_type}#${id}.${nom}`)
    }
  }
  return manques
}
