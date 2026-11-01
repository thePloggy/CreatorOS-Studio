/* Objet 3D (01/11) : le GLB de TRELLIS.2 en vrai, à faire tourner à la souris.
   Chargé à la demande : three.js ne pèse que sur ceux qui ouvrent la vue. */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export default function Objet3D({ url }: { url: string }) {
  const hote = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = hote.current
    if (!el) return
    const rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    rendu.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    rendu.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(rendu.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x333340, 2.2))
    const soleil = new THREE.DirectionalLight(0xffffff, 2.4); soleil.position.set(2, 3, 2); scene.add(soleil)
    const cam = new THREE.PerspectiveCamera(32, el.clientWidth / el.clientHeight, 0.01, 100)
    const orbite = new OrbitControls(cam, rendu.domElement)
    orbite.enableDamping = true; orbite.autoRotate = true; orbite.autoRotateSpeed = 1.6
    new GLTFLoader().load(url, g => {
      const b = new THREE.Box3().setFromObject(g.scene), c = b.getCenter(new THREE.Vector3()), t = b.getSize(new THREE.Vector3()).length()
      // couleurs peintes sur les sommets : sans métal, sinon l'éclairage les tache de reflets
      g.scene.traverse(n => { const m = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m?.isMeshStandardMaterial) { m.metalness = 0; m.roughness = 0.75 } })
      g.scene.position.sub(c); scene.add(g.scene)
      cam.position.set(0, t * 0.25, t * 2.1); orbite.target.set(0, 0, 0)
    })
    let id = 0
    const boucle = () => { id = requestAnimationFrame(boucle); orbite.update(); rendu.render(scene, cam) }
    boucle()
    const taille = new ResizeObserver(() => { cam.aspect = el.clientWidth / el.clientHeight; cam.updateProjectionMatrix(); rendu.setSize(el.clientWidth, el.clientHeight) })
    taille.observe(el)
    return () => { cancelAnimationFrame(id); taille.disconnect(); orbite.dispose(); rendu.dispose(); rendu.domElement.remove() }
  }, [url])
  return <div ref={hote} style={{ position: 'absolute', inset: 0 }} />
}
