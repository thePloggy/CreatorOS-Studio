"""Rend une danse Mixamo (FBX) en vidéo de référence pour le motion control.

Usage : blender -b -P rendre_danse.py -- DANSE.fbx SORTIE.mp4 [SECONDES_MAX]

Un mannequin gris neutre danse en pied sur un fond clair uni, caméra fixe de face,
en 9:16 (720×1280) à 30 i/s, une danse courte répétée jusqu'à 8 s : le motion control ne lit que la pose, aucune
personne réelle n'apparaît. Le cadrage englobe toute la danse (le personnage peut
se déplacer), avec une marge autour du corps.
"""
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
fbx, sortie = argv[0], argv[1]
secondes_max = float(argv[2]) if len(argv) > 2 else 12.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == 'ARMATURE')
corps = [o for o in scene.objects if o.type == 'MESH']
action = arm.animation_data.action
debut, fin = (int(round(x)) for x in action.frame_range)
scene.render.fps = 30
# une danse courte (une boucle de 1 à 4 s) est répétée jusqu'à 8 s au moins, sans dépasser le maximum
longueur = fin - debut
tours = max(1, min(int(secondes_max * 30) // max(longueur, 1), -(-240 // max(longueur, 1))))
if tours > 1:
    arm.animation_data.action = None
    piste = arm.animation_data.nla_tracks.new()
    bande = piste.strips.new(action.name, debut, action)
    bande.repeat = tours
    fin = debut + longueur * tours
scene.frame_start = debut
scene.frame_end = min(fin, debut + int(secondes_max * 30))

# le corps image par image : la caméra le suit de côté et le cadre tient le corps le plus large,
# pour qu'une danse qui se déplace garde un personnage grand dans l'image
pas = 2
boites = {}
for f in range(scene.frame_start, scene.frame_end + 1, pas):
    scene.frame_set(f)
    deps = bpy.context.evaluated_depsgraph_get()
    mini, maxi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
    for o in corps:
        ev = o.evaluated_get(deps)
        for v in ev.to_mesh().vertices:
            p = o.matrix_world @ v.co
            mini = Vector(map(min, mini, p))
            maxi = Vector(map(max, maxi, p))
        ev.to_mesh_clear()
    boites[f] = (mini, maxi)
sol = min(b[0].z for b in boites.values())
haut = max(b[1].z for b in boites.values())
demi_largeur = max(max(b[1].x - (b[0].x + b[1].x) / 2, (b[0].x + b[1].x) / 2 - b[0].x) for b in boites.values())
profondeur = min(b[0].y for b in boites.values())
hauteur = haut - sol

# sol et fond
bpy.ops.mesh.primitive_plane_add(size=hauteur * 60, location=(0, 0, sol))
monde = bpy.data.worlds.new('fond')
scene.world = monde
monde.color = (0.82, 0.82, 0.84)

# caméra orthographique de face qui suit le centre du corps (lissé), corps entier avec une marge
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
ratio = 9 / 16
cam_data.ortho_scale = max(hauteur * 1.15, demi_largeur * 2 * 1.12 / ratio)
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
cam.rotation_euler = (1.5708, 0, 0)
scene.camera = cam
centres = {f: (b[0].x + b[1].x) / 2 for f, b in boites.items()}
cles = sorted(centres)
for k, f in enumerate(cles):
    voisins = [centres[cles[x]] for x in range(max(0, k - 4), min(len(cles), k + 5))]
    cam.location = (sum(voisins) / len(voisins), profondeur - hauteur * 4 - 5, sol + hauteur / 2)
    cam.keyframe_insert('location', frame=f)

# rendu rapide et lisible : ombrage studio, mannequin gris, ombres portées
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'SINGLE'
sh.single_color = (0.55, 0.57, 0.62)
sh.show_shadows = True
sh.show_cavity = True
scene.display.shadow_focus = 0.4
scene.render.resolution_x, scene.render.resolution_y = 720, 1280
scene.render.image_settings.file_format = 'FFMPEG'
scene.render.ffmpeg.format = 'MPEG4'
scene.render.ffmpeg.codec = 'H264'
scene.render.ffmpeg.constant_rate_factor = 'HIGH'
scene.render.filepath = sortie
bpy.ops.render.render(animation=True)
print(f'RENDU {sortie} images {scene.frame_end - scene.frame_start + 1}')
