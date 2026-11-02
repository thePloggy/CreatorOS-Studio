/* ============================================================
   Re-shoot — la scène 3D du clip.

   Le GLB vient de MoGe-2 (1re image du clip, cf. sceneReshoot côté serveur),
   dans le repère de three.js : caméra d'origine en 0, regard vers −Z. La
   nouvelle caméra est posée comme le fait le nœud CrossViewWarp — pivot =
   médiane des points de la zone centrale, orbite rotY(−az)·rotX(−él) autour
   de lui, regard gardé sur l'axe de la caméra d'origine (keep_source_aim) —
   pour que ce qu'on voit ici soit le cadrage que le rendu recevra.

   Deux vues : « caméra » (ce que voit la nouvelle caméra ; en flou, ce que la
   première n'a jamais vu et que le modèle devra inventer) et « orbite »
   (la scène de loin, les deux caméras et le trajet).
   ============================================================ */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { poseA, type Pose } from './pose'

/* ---------- géométrie : focale, pivot, pose (repère OpenCV du nœud ↔ three.js) ---------- */
interface Geo { vfov: number; aspect: number; pivot: THREE.Vector3 /* OpenCV */ }
function analyser(geom: THREE.BufferGeometry, aspect: number): Geo {
  const pos = geom.getAttribute('position'), uv = geom.getAttribute('uv')
  const kx: number[] = [], pts: [number, number, number][] = []
  for (let i = 0; i < pos.count; i += 3) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), u = uv.getX(i), v = uv.getY(i)
    if (z >= -1e-3) continue
    const r = x / -z
    if (Math.abs(r) > 0.05) kx.push((u - 0.5) / r)
    if (u > 0.2 && u < 0.8 && v > 0.125 && v < 0.8) pts.push([x, -y, -z])
  }
  const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? 0 }
  const fxW = med(kx) || 1.07                       // focale / largeur
  const zs = pts.map(p => p[2]).sort((p, q) => p - q), z95 = zs[Math.floor(zs.length * 0.95)] ?? Infinity
  const garde = pts.filter(p => p[2] < z95)
  const pivot = new THREE.Vector3(med(garde.map(p => p[0])), med(garde.map(p => p[1])), med(garde.map(p => p[2])) || 2)
  return { vfov: THREE.MathUtils.radToDeg(2 * Math.atan(1 / (2 * fxW * aspect))), aspect, pivot }
}
const rotY = (a: number) => new THREE.Matrix3().set(Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a))
const rotX = (a: number) => new THREE.Matrix3().set(1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a))
const cv2three = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z)
function poser(cam: THREE.PerspectiveCamera, g: Geo, p: Pose) {
  const R = rotY(THREE.MathUtils.degToRad(-p.az)).multiply(rotX(THREE.MathUtils.degToRad(-p.el)))
  const eye = g.pivot.clone().add(g.pivot.clone().negate().applyMatrix3(R))
  const aim = new THREE.Vector3(0, 0, Math.max(g.pivot.length(), 1e-3))
  cam.position.copy(cv2three(eye)); cam.up.set(0, 1, 0); cam.lookAt(cv2three(aim)); cam.updateMatrixWorld()
}

/* Les trous (ce que la 1re caméra n'a pas vu) sont bouchés par un flou des points
   voisins : on rend le nuage en basse définition, on le floute en normalisant par la
   couverture (alpha) — un pixel vide prend la couleur de ce qui l'entoure —, puis on
   le pose en fond, assombri, sous le nuage net. */
function creerFlou(r: THREE.WebGLRenderer) {
  const opt = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
  const rtA = new THREE.WebGLRenderTarget(2, 2, opt), rtB = new THREE.WebGLRenderTarget(2, 2, { ...opt, depthBuffer: false })
  const vs = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
  const passe = new THREE.ShaderMaterial({ uniforms: { src: { value: null }, pas: { value: new THREE.Vector2() } }, vertexShader: vs, depthTest: false, depthWrite: false,
    fragmentShader: `uniform sampler2D src; uniform vec2 pas; varying vec2 vUv;
      void main() { float w[5] = float[5](0.227, 0.194, 0.121, 0.054, 0.016); vec4 s = vec4(0.0);
        for (int i = -4; i <= 4; i++) s += texture2D(src, vUv + pas * float(i)) * w[abs(i)];
        gl_FragColor = s; }` })
  const fin = new THREE.ShaderMaterial({ uniforms: { src: { value: null }, fond: { value: new THREE.Color('#1c1d23') } }, vertexShader: vs, depthTest: false, depthWrite: false,
    fragmentShader: `uniform sampler2D src; uniform vec3 fond; varying vec2 vUv;
      void main() { vec4 s = texture2D(src, vUv);
        vec3 c = s.a > 0.002 ? s.rgb / s.a : fond;
        gl_FragColor = vec4(c * 0.8, 1.0);
        #include <colorspace_fragment>
      }` })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), passe); quad.frustumCulled = false
  const fs = new THREE.Scene(); fs.add(quad); const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  return (scene: THREE.Scene, cam: THREE.PerspectiveCamera, echelle: (h: number, f: number) => void) => {
    const W = r.domElement.width, H = r.domElement.height, lw = Math.max(2, Math.round(W / 6)), lh = Math.max(2, Math.round(H / 6))
    if (rtA.width !== lw || rtA.height !== lh) { rtA.setSize(lw, lh); rtB.setSize(lw, lh) }
    scene.background = null
    r.setClearColor(0x000000, 0); r.setRenderTarget(rtA); r.clear(); echelle(lh * 1.5, cam.fov); r.render(scene, cam)
    quad.material = passe
    for (const k of [1, 2, 4, 8]) {
      passe.uniforms.src.value = rtA.texture; passe.uniforms.pas.value.set(k / lw, 0); r.setRenderTarget(rtB); r.render(fs, fsCam)
      passe.uniforms.src.value = rtB.texture; passe.uniforms.pas.value.set(0, k / lh); r.setRenderTarget(rtA); r.render(fs, fsCam)
    }
    r.setRenderTarget(null); quad.material = fin; fin.uniforms.src.value = rtA.texture; r.render(fs, fsCam)
    r.setClearColor(0x000000, 1)
    r.autoClear = false; r.clearDepth(); echelle(H, cam.fov); r.render(scene, cam); r.autoClear = true
  }
}

export function Scene3D({ url, pose, cles, t, vue, onPose, onPret }: {
  url: string; pose: Pose; cles: Pose[] | null; t: number; vue: 'camera' | 'orbite'
  onPose: (p: Pose) => void; onPret?: (ok: boolean) => void
}) {
  const boite = useRef<HTMLDivElement>(null)
  const etat = useRef<{ r: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; obs: THREE.PerspectiveCamera; ctl: OrbitControls
    geo: Geo | null; helper: THREE.CameraHelper | null; source: THREE.CameraHelper | null; trajet: THREE.Line | null; anneau: THREE.Line | null; dessiner: () => void; echelle: (h: number, f: number) => void } | null>(null)
  const props = useRef({ pose, cles, t, vue, onPose }); props.current = { pose, cles, t, vue, onPose }

  useEffect(() => {
    const el = boite.current; if (!el) return
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    r.setPixelRatio(Math.min(2, window.devicePixelRatio)); el.appendChild(r.domElement)
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(50, 9 / 16, 0.05, 2000)
    const obs = new THREE.PerspectiveCamera(45, 1, 0.05, 5000)
    const ctl = new OrbitControls(obs, r.domElement); ctl.enableDamping = true
    const S = { r, scene, cam, obs, ctl, geo: null as Geo | null, helper: null as THREE.CameraHelper | null, source: null as THREE.CameraHelper | null,
      trajet: null as THREE.Line | null, anneau: null as THREE.Line | null, dessiner: () => {}, echelle: (_h: number, _f: number) => {} }
    etat.current = S
    const flou = creerFlou(r)
    const taille = () => {
      const w = el.clientWidth, h = el.clientHeight; r.setSize(w, h, false)
      obs.aspect = w / h; obs.updateProjectionMatrix()
    }
    S.dessiner = () => {
      const { pose, cles, t, vue } = props.current; const g = S.geo; if (!g) return
      poser(cam, g, poseA(cles, pose, t))
      const hpx = r.domElement.height
      if (vue === 'camera') flou(scene, cam, S.echelle)
      else {
        scene.background = new THREE.Color('#121318'); S.echelle(hpx, obs.fov)
        S.helper?.update()
        for (const o of [S.helper, S.source, S.trajet, S.anneau]) if (o) o.visible = true
        r.render(scene, obs)
        for (const o of [S.helper, S.source, S.trajet, S.anneau]) if (o) o.visible = false
      }
    }
    const ro = new ResizeObserver(() => { taille(); S.dessiner() }); ro.observe(el); taille()
    let fin = false
    const boucle = () => { if (fin) return; if (props.current.vue === 'orbite') ctl.update(); S.dessiner(); requestAnimationFrame(boucle) }

    new GLTFLoader().load(url, gltf => {
      let geom: THREE.BufferGeometry | null = null, tex: THREE.Texture | null = null
      gltf.scene.traverse(o => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          geom = m.geometry
          tex = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null
          if (tex) tex.colorSpace = THREE.SRGBColorSpace
          m.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
        }
      })
      if (!geom) { props.current && onPret?.(false); return }
      const img = (tex as THREE.Texture | null)?.image as { width?: number; height?: number } | undefined
      const aspect = img?.width && img?.height ? img.width / img.height : 9 / 16
      S.geo = analyser(geom, aspect)
      cam.fov = S.geo.vfov; cam.aspect = aspect; cam.updateProjectionMatrix()
      /* Chaque pixel de la 1re image devient un point de la taille d'un pixel à sa
         profondeur — c'est ce que fait le warp du nœud (splat) : là où aucun point
         ne tombe, le fond flou (creerFlou) reste visible. */
      const g0 = geom as THREE.BufferGeometry
      const nuage = new THREE.BufferGeometry()
      nuage.setAttribute('position', g0.getAttribute('position')); nuage.setAttribute('uv', g0.getAttribute('uv'))
      const pixW = img?.width ?? 352
      const fxW = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(S.geo.vfov) / 2) * aspect)
      const mat = new THREE.ShaderMaterial({
        uniforms: { carte: { value: tex }, angle: { value: 2.0 / (fxW * pixW) }, echelle: { value: 1 } },
        vertexShader: `uniform float angle; uniform float echelle; varying vec2 vUv;
          void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
            float monde = length(position) * angle;                      // taille d'un pixel source à cette distance
            gl_PointSize = max(1.0, monde / -mv.z * echelle);
            gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform sampler2D carte; varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(carte, vUv);
            #include <colorspace_fragment>
          }`,
      })
      const points = new THREE.Points(nuage, mat)
      S.echelle = (h: number, fovDeg: number) => { mat.uniforms.echelle.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) }
      scene.add(points)
      // caméra d'origine (grise), nouvelle caméra (rose), anneau d'orbite, trajet
      const tc = S.geo.pivot.length()
      const c0 = new THREE.PerspectiveCamera(S.geo.vfov, aspect, 0.04 * tc, 0.2 * tc); c0.updateMatrixWorld()
      S.source = new THREE.CameraHelper(c0); S.source.setColors(new THREE.Color('#9a9ca3'), new THREE.Color('#9a9ca3'), new THREE.Color('#9a9ca3'), new THREE.Color('#9a9ca3'), new THREE.Color('#9a9ca3'))
      const cVis = new THREE.PerspectiveCamera(S.geo.vfov, aspect, 0.04 * tc, 0.2 * tc)
      S.helper = new THREE.CameraHelper(cVis); const rose = new THREE.Color('#f24d8a')
      S.helper.setColors(rose, rose, rose, rose, rose)
      cam.add(cVis); scene.add(cam)
      const piv = cv2three(S.geo.pivot), R = S.geo.pivot.length()
      const ring = Array.from({ length: 97 }, (_, i) => { const a = (i / 96) * Math.PI * 2; return new THREE.Vector3(piv.x + Math.sin(a) * R, piv.y, piv.z + Math.cos(a) * R) })
      S.anneau = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineDashedMaterial({ color: '#5a5d66', dashSize: 0.08, gapSize: 0.06 }))
      S.anneau.computeLineDistances()
      S.trajet = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffab5e' }))
      for (const o of [S.source, S.helper, S.anneau, S.trajet]) { o.visible = false; scene.add(o) }
      obs.position.set(R * 1.5, R * 0.9, R * 1.1); ctl.target.copy(piv.clone().multiplyScalar(0.7)); ctl.update()   // en retrait, au-dessus de la caméra d'origine
      onPret?.(true); boucle()
    }, undefined, () => onPret?.(false))

    // vue caméra : glisser l'image fait tourner la caméra (droite = orbite à droite, haut = monte)
    let tire: { x: number; y: number; p: Pose } | null = null
    const bas = (e: PointerEvent) => { if (props.current.vue !== 'camera') return; tire = { x: e.clientX, y: e.clientY, p: props.current.pose }; r.domElement.setPointerCapture(e.pointerId) }
    const bouge = (e: PointerEvent) => {
      if (!tire) return
      const az = Math.max(-90, Math.min(90, tire.p.az + (e.clientX - tire.x) * 0.35))
      const el2 = Math.max(-35, Math.min(45, tire.p.el - (e.clientY - tire.y) * 0.3))
      props.current.onPose({ az: Math.round(az), el: Math.round(el2) })
    }
    const haut = () => { tire = null }
    r.domElement.addEventListener('pointerdown', bas); r.domElement.addEventListener('pointermove', bouge); r.domElement.addEventListener('pointerup', haut)
    return () => { fin = true; ro.disconnect(); ctl.dispose(); r.dispose(); r.domElement.remove(); etat.current = null }
  }, [url])   // eslint-disable-line react-hooks/exhaustive-deps

  // trajet du mouvement (dans la vue orbite)
  useEffect(() => {
    const S = etat.current; if (!S?.geo || !S.trajet) return
    const tmp = new THREE.PerspectiveCamera()
    const pts = cles && cles.length >= 2 ? Array.from({ length: 41 }, (_, i) => { poser(tmp, S.geo!, poseA(cles, pose, i / 40)); return tmp.position.clone() }) : []
    S.trajet.geometry.dispose(); S.trajet.geometry = new THREE.BufferGeometry().setFromPoints(pts)
  }, [cles, pose])

  return <div ref={boite} className="sc3d" style={{ cursor: vue === 'camera' ? 'grab' : 'move' }} />
}
export default Scene3D
