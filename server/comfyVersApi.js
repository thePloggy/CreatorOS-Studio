/* ============================================================
   ComfyUI editor workflow (nodes, links, subgraphs, widgets) ->
   API format (what POST /prompt runs).

   - Widget values are stored by position in widgets_values; input order
     comes from object_info (required then optional), and an integer "seed"
     followed by a control (randomize, fixed...) takes two slots.
   - Subgraphs: each instance is expanded, its nodes get the id
     "instance:node". An unconnected subgraph input leaves the inner node
     its own value.
   - Muted nodes (mode 2): removed. Bypassed nodes (mode 4): removed, their
     consumers get the input of the same type.
   - UI nodes (Reroute, PrimitiveNode, notes): passed through or removed.
   ============================================================ */

const MUET = 2, CONTOURNE = 4
const ENTREE_SG = -10, SORTIE_SG = -20
const INTERFACE = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'])
// editor-only display nodes, nothing to render here
const AFFICHAGE = new Set(['ImageCompare', 'PreviewAny', 'Preview3D', 'Preview3DAdvanced'])
const TYPES_WIDGET = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

const DYN = 'COMFY_DYNAMICCOMBO_V3'
const estWidget = (type, opts) => Array.isArray(type) || type === DYN || opts.socketless === true
  || (TYPES_WIDGET.has(type) && !opts.forceInput) || ['COLOR', 'BOUNDING_BOXES'].includes(type)
const aControle = (type, nom, opts) => !!opts.control_after_generate || (type === 'INT' && /(^|\.)(noise_)?seed$/.test(nom))

/** Maps widgets_values (positional) into inputs following object_info; a dynamic list
 *  (COMFY_DYNAMICCOMBO_V3) inserts the chosen option's widgets after it, named "list.widget". */
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

/** Widget names (without dynamic sub-widgets): for widgets_values given as an object. */
export function widgetsDe(classe, objetInfo) {
  const def = objetInfo[classe]
  if (!def) return null
  const l = []
  for (const groupe of ['required', 'optional'])
    for (const [nom, s] of Object.entries(def.input?.[groupe] ?? {})) { const [type, opts = {}] = Array.isArray(s) ? s : [s]; if (estWidget(type, opts)) l.push(nom) }
  return l
}

const lienObjet = l => Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : l

/** Converts; returns { graphe, ignores } or throws a readable error. */
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

  /** Output of (node, slot) in a scope: [apiId, slot], { valeur }, or undefined. */
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
    // instance widget values: one per subgraph input, in input order
    const wv = Array.isArray(inst.widgets_values) ? inst.widgets_values : []
    const entrees = (sg.inputs ?? []).map((si, k) => () => {
      const e = (inst.inputs ?? []).find(i => i.name === si.name)
      if (e?.link != null) return entreeDe(p, inst, e)
      if (wv.length === (sg.inputs ?? []).length && wv[k] !== undefined) return { valeur: wv[k] }
      // no value on the instance: use the inner widget this input promotes
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

  // widgets added after the workflow was written: their default value
  for (const n of Object.values(graphe))
    for (const [nom, sp] of Object.entries(objetInfo[n.class_type]?.input?.required ?? {})) {
      if (nom in n.inputs) continue
      const [type, opts = {}] = Array.isArray(sp) ? sp : [sp]
      if (!estWidget(type, opts)) continue
      if (opts.default !== undefined) n.inputs[nom] = opts.default
      else if (Array.isArray(type) && type.length) n.inputs[nom] = type[0]
      else if (Array.isArray(opts.options) && opts.options.length) n.inputs[nom] = typeof opts.options[0] === 'object' ? opts.options[0].key : opts.options[0]
    }
  // remove links to nodes that were not emitted (unknown class)
  for (const n of Object.values(graphe))
    for (const [k, v] of Object.entries(n.inputs))
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !(v[0] in graphe)) delete n.inputs[k]
  return { graphe, ignores: [...ignores] }
}

/** Missing required inputs per node: the graph would fail ComfyUI validation. */
export function entreesManquantes(graphe, objetInfo) {
  const manques = []
  for (const [id, n] of Object.entries(graphe)) {
    const req = objetInfo[n.class_type]?.input?.required ?? {}
    for (const [nom, sp] of Object.entries(req)) {
      const type = Array.isArray(sp) ? sp[0] : sp
      // growing inputs (images.image_1...): present under their derived names
      if (type === 'COMFY_AUTOGROW_V3') continue
      if (!(nom in n.inputs)) manques.push(`${n.class_type}#${id}.${nom}`)
    }
  }
  return manques
}
