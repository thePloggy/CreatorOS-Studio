/* Stage en 3D : le plateau où l'on déplace tout à la main, et la vue de la caméra à
   l'instant choisi. Chargé à la demande. Le rendu final est fait côté serveur à partir des mêmes nombres. */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type ObjetVu = { id: number; type: string; x: number; z: number; h: number; l: number; p: number; y?: number; rot?: number; url?: string }
export type PoseCam = { oeil: number[]; cible: number[]; fov: number }

const gris = new THREE.MeshStandardMaterial({ color: 0xb4b6bc, roughness: 0.9 })
const perso = new THREE.MeshStandardMaterial({ color: 0xd8d9de, roughness: 0.7 })
const vif = new THREE.MeshStandardMaterial({ color: 0xea4e89, roughness: 0.6, emissive: 0x3a0c20 })
const lisse = (k: number) => k * k * (3 - 2 * k)
export const poseA = (poses: PoseCam[], t: number): PoseCam => {
  const k = lisse(t), [a, b] = poses, mix = (u: number[], v: number[]) => u.map((x, i) => x + (v[i] - x) * k)
  return { oeil: mix(a.oeil, b.oeil), cible: mix(a.cible, b.cible), fov: a.fov + (b.fov - a.fov) * k }
}

function forme(o: ObjetVu, cache: Map<string, THREE.Object3D>, choisi: boolean) {
  const g = new THREE.Group(); g.userData.id = o.id
  const mat = choisi ? vif : o.type === 'personne' ? perso : gris
  if (o.type === 'modele' && o.url) {
    const m = cache.get(o.url)
    if (m) {
      const c = m.clone(), b = new THREE.Box3().setFromObject(c), t = b.getSize(new THREE.Vector3()), e = o.h / Math.max(t.y, 1e-3)
      c.scale.setScalar(e)
      c.position.set(-(b.min.x + b.max.x) / 2 * e, -b.min.y * e, -(b.min.z + b.max.z) / 2 * e)
      // l'objet garde ses vraies textures à l'écran pour le placer ; la maquette grise envoyée au modèle est faite par le serveur
      c.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh && !m.material) m.material = mat })
      g.add(c)
    }
  } else if (o.type === 'personne') {
    const corps = new THREE.Mesh(new THREE.CapsuleGeometry(o.h * 0.13, o.h * 0.5, 4, 12), mat); corps.position.y = o.h * 0.42
    const tete = new THREE.Mesh(new THREE.SphereGeometry(o.h * 0.075, 16, 12), mat); tete.position.y = o.h * 0.92
    g.add(corps, tete)
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.l, o.h, o.p), mat); m.position.y = o.h / 2; g.add(m)
  }
  g.position.set(o.x, o.y ?? 0, o.z); g.rotation.y = THREE.MathUtils.degToRad(o.rot ?? 0)
  return g
}
const damier = () => {
  const c = document.createElement('canvas'); c.width = c.height = 2
  const x = c.getContext('2d')!; x.fillStyle = '#6a6a6e'; x.fillRect(0, 0, 2, 2); x.fillStyle = '#5c5c60'; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1)
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(30, 30); return t
}

export default function Stage3D({ objets, poses, instant, vue, choisi, format, onChoisir, onBouger, onCam }: {
  objets: ObjetVu[]; poses: PoseCam[]; instant: number; vue: 'plateau' | 'camera'; choisi: number | null; format: string
  onChoisir: (id: number | null) => void; onBouger: (id: number, x: number, z: number) => void; onCam: (n: 0 | 1, x: number, z: number) => void
}) {
  const hote = useRef<HTMLDivElement>(null)
  const rappels = useRef({ onChoisir, onBouger, onCam }); rappels.current = { onChoisir, onBouger, onCam }
  const vueRef = useRef(vue); vueRef.current = vue
  const etat = useRef<{ groupe: THREE.Group; reperes: THREE.Group; libre: THREE.PerspectiveCamera; tournage: THREE.PerspectiveCamera; aide: THREE.CameraHelper; orbite: OrbitControls; dessiner: () => void; cache: Map<string, THREE.Object3D> } | null>(null)
  useEffect(() => {
    const el = hote.current
    if (!el) return
    const rendu = new THREE.WebGLRenderer({ antialias: true })
    rendu.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    rendu.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(rendu.domElement)
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8e8e92)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555560, 1.9))
    const soleil = new THREE.DirectionalLight(0xffffff, 1.8); soleil.position.set(-3, 5, 3); scene.add(soleil)
    const sol = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: damier() })); sol.rotation.x = -Math.PI / 2; scene.add(sol)
    const groupe = new THREE.Group(), reperes = new THREE.Group(); scene.add(groupe, reperes)
    const libre = new THREE.PerspectiveCamera(42, el.clientWidth / el.clientHeight, 0.05, 200); libre.position.set(5.5, 5, 8)
    const tournage = new THREE.PerspectiveCamera(40, el.clientWidth / el.clientHeight, 0.3, 2.2)
    const aide = new THREE.CameraHelper(tournage); scene.add(tournage, aide)
    const orbite = new OrbitControls(libre, rendu.domElement); orbite.target.set(0, 0.8, -1); orbite.maxPolarAngle = Math.PI / 2 - 0.02
    const dessiner = () => {
      aide.visible = reperes.visible = vueRef.current === 'plateau'
      rendu.render(scene, vueRef.current === 'plateau' ? libre : tournage)
    }
    orbite.addEventListener('change', dessiner)
    etat.current = { groupe, reperes, libre, tournage, aide, orbite, dessiner, cache: new Map() }
    /* Glisser un accessoire ou un repère de caméra le déplace au sol ; glisser le vide fait tourner la vue. */
    const rayon = new THREE.Raycaster(), plan = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point = new THREE.Vector3()
    let prise: { id?: number; cam?: 0 | 1 } | null = null
    const viser = (e: PointerEvent) => {
      const r = rendu.domElement.getBoundingClientRect()
      rayon.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), libre)
    }
    const bas = (e: PointerEvent) => {
      if (vueRef.current !== 'plateau' || e.button !== 0) return
      viser(e)
      const h = rayon.intersectObjects([...reperes.children, ...groupe.children], true)[0]
      let o: THREE.Object3D | null = h?.object ?? null
      while (o && o.userData.id === undefined && o.userData.cam === undefined) o = o.parent
      if (!o) { rappels.current.onChoisir(null); return }
      prise = { id: o.userData.id, cam: o.userData.cam }
      if (prise.id !== undefined) rappels.current.onChoisir(prise.id)
      orbite.enabled = false; rendu.domElement.setPointerCapture(e.pointerId)
    }
    const bouge = (e: PointerEvent) => {
      if (!prise) return
      viser(e)
      if (!rayon.ray.intersectPlane(plan, point)) return
      const x = Math.round(point.x * 10) / 10, z = Math.round(point.z * 10) / 10
      if (prise.id !== undefined) rappels.current.onBouger(prise.id, x, z)
      else if (prise.cam !== undefined) rappels.current.onCam(prise.cam, x, z)
    }
    const haut = () => { prise = null; orbite.enabled = true }
    rendu.domElement.addEventListener('pointerdown', bas, true)
    rendu.domElement.addEventListener('pointermove', bouge)
    rendu.domElement.addEventListener('pointerup', haut)
    const taille = new ResizeObserver(() => {
      libre.aspect = tournage.aspect = el.clientWidth / el.clientHeight; libre.updateProjectionMatrix(); tournage.updateProjectionMatrix()
      rendu.setSize(el.clientWidth, el.clientHeight); dessiner()
    })
    taille.observe(el)
    return () => { taille.disconnect(); orbite.dispose(); rendu.dispose(); rendu.domElement.remove(); etat.current = null }
  }, [])
  useEffect(() => {
    const e = etat.current
    if (!e) return
    const peupler = () => { e.groupe.clear(); for (const o of objets) e.groupe.add(forme(o, e.cache, o.id === choisi && vue === 'plateau')); e.dessiner() }
    const manquants = [...new Set(objets.flatMap(o => (o.url && !e.cache.has(o.url) ? [o.url] : [])))]
    manquants.forEach(url => new GLTFLoader().load(url, g => { e.cache.set(url, g.scene); peupler() }))
    peupler()
  }, [objets, choisi, vue])
  useEffect(() => {
    const e = etat.current
    if (!e) return
    const p = poseA(poses, instant)
    e.tournage.position.set(p.oeil[0], p.oeil[1], p.oeil[2]); e.tournage.fov = p.fov; e.tournage.far = vue === 'plateau' ? 2.2 : 200; e.tournage.updateProjectionMatrix()
    e.tournage.lookAt(p.cible[0], p.cible[1], p.cible[2]); e.tournage.updateMatrixWorld(); e.aide.update()
    e.reperes.clear()
    poses.forEach((c, n) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), vif); m.position.set(c.oeil[0], c.oeil[1], c.oeil[2]); m.userData.cam = n
      const pied = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.position.clone(), new THREE.Vector3(c.oeil[0], 0, c.oeil[2])]), new THREE.LineBasicMaterial({ color: 0xea4e89 }))
      e.reperes.add(m, pied)
    })
    e.reperes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(poses.map(c => new THREE.Vector3(c.oeil[0], c.oeil[1], c.oeil[2]))), new THREE.LineBasicMaterial({ color: 0xea4e89 })))
    e.dessiner()
  }, [poses, instant, vue])
  return <div style={{ height: '100%', display: 'flex', justifyContent: 'center' }}>
    <div ref={hote} style={{ height: '100%', width: vue === 'camera' ? undefined : '100%', maxWidth: '100%', aspectRatio: vue === 'camera' ? format.replace(':', ' / ') : undefined, borderRadius: 14, overflow: 'hidden' }} />
  </div>
}
