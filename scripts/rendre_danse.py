"""Renders a Mixamo dance (FBX) as a reference video for motion control.

Usage: blender -b -P rendre_danse.py -- DANSE.fbx SORTIE.mp4 [SECONDES_MAX]

A neutral grey mannequin dances full-body on a plain light background, fixed front camera,
9:16 (720×1280) at 30 fps, a short dance looped up to 8 s: motion control reads only the pose, no
real person appears. Fixed camera: the framing covers the whole dance (the character may move),
with a margin around the body.
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
# a short dance (a 1 to 4 s loop) is repeated to at least 8 s, without exceeding the maximum
longueur = fin - debut
tours = max(1, min(int(secondes_max * 30) // max(longueur, 1), -(-240 // max(longueur, 1))))
if tours > 1:
    # each loop starts where the previous one ends: hip translation accumulates,
    # otherwise the dancer jumps back at the start of each loop
    arm.animation_data.action = None
    piste = arm.animation_data.nla_tracks.new()
    bassin = [c for c in action.fcurves if c.data_path.endswith('Hips"].location')]
    ecart = {c.array_index: c.evaluate(fin) - c.evaluate(debut) for c in bassin}
    for k in range(tours):
        a = action.copy() if k else action
        if k:
            for c in a.fcurves:
                if c.data_path.endswith('Hips"].location'):
                    for pt in c.keyframe_points:
                        pt.co.y += ecart[c.array_index] * k
                        pt.handle_left.y += ecart[c.array_index] * k
                        pt.handle_right.y += ecart[c.array_index] * k
        piste.strips.new(f'{action.name}-{k}', debut + longueur * k, a)
    fin = debut + longueur * tours
scene.frame_start = debut
scene.frame_end = min(fin, debut + int(secondes_max * 30))

# body bounds frame by frame: the camera stays FIXED and frames the whole dance. A following camera
# cancels the dancer's travel, and on a plain background motion control then makes them slide in
# place. Tight cropping is done afterwards, on the render.
pas = 2
mini, maxi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
for f in range(scene.frame_start, scene.frame_end + 1, pas):
    scene.frame_set(f)
    deps = bpy.context.evaluated_depsgraph_get()
    for o in corps:
        ev = o.evaluated_get(deps)
        for v in ev.to_mesh().vertices:
            p = o.matrix_world @ v.co
            mini = Vector(map(min, mini, p))
            maxi = Vector(map(max, maxi, p))
        ev.to_mesh_clear()
sol, haut = mini.z, maxi.z
hauteur = haut - sol

# floor and background
bpy.ops.mesh.primitive_plane_add(size=hauteur * 60, location=(0, 0, sol))
monde = bpy.data.worlds.new('fond')
scene.world = monde
monde.color = (0.82, 0.82, 0.84)

# front orthographic camera, fixed, whole dance in frame with a margin
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
ratio = 9 / 16
cam_data.ortho_scale = max(hauteur * 1.15, (maxi.x - mini.x) * 1.12 / ratio)
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
cam.rotation_euler = (1.5708, 0, 0)
cam.location = ((mini.x + maxi.x) / 2, mini.y - hauteur * 4 - 5, sol + cam_data.ortho_scale / 2 - hauteur * 0.06)
scene.camera = cam

# fast, readable render: studio shading, grey mannequin, cast shadows
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
