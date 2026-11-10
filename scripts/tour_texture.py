"""Textured turntable of a 3D model (TRELLIS.2 GLB): studio lighting, subtle floor, orbiting camera.

usage: blender -b -P tour_texture.py -- modele.glb sortie.mp4 [images=97] [taille=720]
The model is centred and scaled (1.5 m tall); one full turn, EEVEE render, assembled by ffmpeg.
"""
import math
import os
import subprocess
import sys
import tempfile

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
glb, sortie = args[0], args[1]
images = int(args[2]) if len(args) > 2 else 97
taille = int(args[3]) if len(args) > 3 else 720

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
objets = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not objets:
    sys.exit('aucun maillage')

# bounding box of all meshes, in world coordinates
coins = [o.matrix_world @ Vector(c) for o in objets for c in o.bound_box]
mini = Vector((min(c.x for c in coins), min(c.y for c in coins), min(c.z for c in coins)))
maxi = Vector((max(c.x for c in coins), max(c.y for c in coins), max(c.z for c in coins)))
hauteur = max(maxi.z - mini.z, 1e-6)
echelle = 1.5 / hauteur
pivot = bpy.data.objects.new('pivot', None)
bpy.context.scene.collection.objects.link(pivot)
for o in bpy.context.scene.objects:
    if o.parent is None and o is not pivot:
        o.parent = pivot
pivot.scale = (echelle,) * 3
pivot.location = (-(mini.x + maxi.x) / 2 * echelle, -(mini.y + maxi.y) / 2 * echelle, -mini.z * echelle)

# floor: a soft grey disc that catches the shadow
bpy.ops.mesh.primitive_circle_add(vertices=96, radius=6, fill_type='NGON', location=(0, 0, 0))
sol = bpy.context.active_object
mat = bpy.data.materials.new('sol'); mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.09, 0.095, 0.105, 1)
bsdf.inputs['Roughness'].default_value = 0.85
sol.data.materials.append(mat)

# world: neutral grey, soft lighting
monde = bpy.data.worlds.new('monde'); bpy.context.scene.world = monde
monde.use_nodes = True
monde.node_tree.nodes['Background'].inputs['Color'].default_value = (0.16, 0.17, 0.19, 1)
monde.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6

def lampe(nom, energie, pos, taille_l):
    l = bpy.data.lights.new(nom, 'AREA'); l.energy = energie; l.size = taille_l
    o = bpy.data.objects.new(nom, l); o.location = pos
    bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = (Vector((0, 0, 0.75)) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
lampe('cle', 520, (2.5, -2.5, 3.2), 2.5)
lampe('remplissage', 160, (-3, -1.5, 1.8), 3)
lampe('contre', 420, (0, 3, 2.8), 2)

# camera orbiting the model
cam = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
bpy.context.scene.collection.objects.link(cam)
cam.data.lens = 50
bpy.context.scene.camera = cam
cible = Vector((0, 0, 0.75))

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = taille
sc.render.film_transparent = False
sc.view_settings.view_transform = 'AgX' if 'AgX' in [v.identifier for v in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
dossier = tempfile.mkdtemp()
for i in range(images):
    a = i / images * 2 * math.pi
    cam.location = (3.3 * math.sin(a), -3.3 * math.cos(a), 1.45)
    cam.rotation_euler = (cible - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(dossier, f'{i:04d}.png')
    bpy.ops.render.render(write_still=True)
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '24', '-i', os.path.join(dossier, '%04d.png'),
                '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sortie], check=True)
print('tour', sortie)
