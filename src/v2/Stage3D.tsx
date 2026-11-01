/* Stage en 3D (01/11) : la scène telle que la caméra la verra, modèles GLB compris.
   Chargé à la demande. Le rendu final reste fait côté serveur à partir des mêmes nombres. */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type ObjetVu = { id: number; type: string; x: number; z: number; h: number; l: number; p: number; y?: number; rot?: number; url?: string }
export type PoseCam = { oeil: number[]; cible: number[]; fov: number }

const gris = new THREE.MeshStandardMaterial({ color: 0xb0b2b8, roughness: 0.9 })
const perso = new THREE.MeshStandardMaterial({ color: 0xf6a961, roughness: 0.8 })

function forme(o: ObjetVu, cache: Map<string, THREE.Object3D>) {
  const g = new THREE.Group()
  if (o.type === 'modele' && o.url) {
    const m = cache.get(o.url)
    if (m) {
      const c = m.clone(), b = new THREE.Box3().setFromObject(c), t = b.getSize(new THREE.Vector3()), e = o.h / Math.max(t.y, 1e-3)
      c.scale.setScalar(e)
      c.position.set(-(b.min.x + b.max.x) / 2 * e, -b.min.y * e, -(b.min.z + b.max.z) / 2 * e)
      c.traverse(n => { if ((n as THREE.Mesh).isMesh) (n as THREE.Mesh).material = gris })
      g.add(c)
    }
  } else if (o.type === 'personne') {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(o.h * 0.13, o.h * 0.72, 4, 10), perso)
    m.position.y = o.h / 2; g.add(m)
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.l, o.h, o.p), gris)
    m.position.y = o.h / 2; g.add(m)
  }
  g.position.set(o.x, o.y ?? 0, o.z); g.rotation.y = THREE.MathUtils.degToRad(o.rot ?? 0)
  return g
}

export default function Stage3D({ objets, pose, format }: { objets: ObjetVu[]; pose: PoseCam; format: string }) {
  const hote = useRef<HTMLDivElement>(null)
  const etat = useRef<{ scene: THREE.Scene; groupe: THREE.Group; cam: THREE.PerspectiveCamera; dessiner: () => void; cache: Map<string, THREE.Object3D> } | null>(null)
  useEffect(() => {
    const el = hote.current
    if (!el) return
    const rendu = new THREE.WebGLRenderer({ antialias: true })
    rendu.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    rendu.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(rendu.domElement)
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x96969a)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555560, 1.8))
    const soleil = new THREE.DirectionalLight(0xffffff, 1.8); soleil.position.set(-3, 5, 3); scene.add(soleil)
    const sol = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x6e6e72 })); sol.rotation.x = -Math.PI / 2; scene.add(sol)
    const grille = new THREE.GridHelper(60, 60, 0x5a5a5e, 0x5a5a5e); grille.position.y = 0.002; scene.add(grille)
    const groupe = new THREE.Group(); scene.add(groupe)
    const cam = new THREE.PerspectiveCamera(40, el.clientWidth / el.clientHeight, 0.05, 200)
    const dessiner = () => rendu.render(scene, cam)
    etat.current = { scene, groupe, cam, dessiner, cache: new Map() }
    const taille = new ResizeObserver(() => { cam.aspect = el.clientWidth / el.clientHeight; cam.updateProjectionMatrix(); rendu.setSize(el.clientWidth, el.clientHeight); dessiner() })
    taille.observe(el)
    return () => { taille.disconnect(); rendu.dispose(); rendu.domElement.remove(); etat.current = null }
  }, [])
  useEffect(() => {
    const e = etat.current
    if (!e) return
    const peupler = () => { e.groupe.clear(); for (const o of objets) e.groupe.add(forme(o, e.cache)); e.dessiner() }
    const manquants = [...new Set(objets.flatMap(o => (o.url && !e.cache.has(o.url) ? [o.url] : [])))]
    manquants.forEach(url => new GLTFLoader().load(url, g => { e.cache.set(url, g.scene); peupler() }))
    peupler()
  }, [objets])
  useEffect(() => {
    const e = etat.current
    if (!e) return
    e.cam.position.set(pose.oeil[0], pose.oeil[1], pose.oeil[2]); e.cam.fov = pose.fov; e.cam.updateProjectionMatrix()
    e.cam.lookAt(pose.cible[0], pose.cible[1], pose.cible[2]); e.dessiner()
  }, [pose])
  return <div ref={hote} style={{ height: '100%', maxWidth: '100%', margin: '0 auto', aspectRatio: format.replace(':', ' / '), borderRadius: 12, overflow: 'hidden' }} />
}
