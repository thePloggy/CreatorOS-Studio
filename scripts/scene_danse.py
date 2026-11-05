"""Scène 3D d'une danse : le mannequin danse dans un décor en volumes, filmé par une caméra qui l'accompagne.

Usage : blender -b -P scene_danse.py -- DANSE.fbx SORTIE.mp4 [SECONDES] [STUDIO] [TEINT r,g,b]

Maquette grise pour LTX-2.5 + IC-LoRA Layout-to-Render : le décor (sol à dalles, murs, quelques
volumes) donne au modèle de quoi lire le mouvement de la caméra et le déplacement de la danseuse ;
sur un fond uni, il ne voit pas le mouvement et fait glisser le personnage.
- le corps en gris clair, le décor dans d'autres gris, des teintes distinctes par volume ;
- la caméra suit le centre du corps de loin (lissée), à hauteur de poitrine, avec un léger arc
  autour d'elle : le décor défile derrière, comme un téléphone qui accompagne une danseuse ;
- 704×1280 à 30 i/s ; l'appelant la ramène à 24 i/s et 121 images au plus (5 s), le format du rendu LTX.
STUDIO : salon, ruelle, opera, toit, concert, tokyo, paris, parking, cabaret, bal, loft, studio-danse, sport, cuisine, plage, jardin, basket, desert, metro ou hotel. La zone que la danse parcourt reste libre : les décors sont posés autour et derrière.
"""
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
fbx, sortie = argv[0], argv[1]
secondes = float(argv[2]) if len(argv) > 2 else 5.0
decor = argv[3] if len(argv) > 3 else 'salon'
# le teint de la personne de la photo (r,g,b linéaires) : le mannequin prend sa couleur de peau
teint = tuple(float(x) for x in argv[4].split(',')) if len(argv) > 4 else (0.62, 0.36, 0.25)
# 'paysage' : une vue large du studio (vignette panoramique), 1280×704 et un objectif plus large
paysage = len(argv) > 5 and argv[5] == 'paysage'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == 'ARMATURE')
corps = [o for o in scene.objects if o.type == 'MESH']
action = arm.animation_data.action
debut, fin = (int(round(x)) for x in action.frame_range)
scene.render.fps = 30   # l'animation Mixamo est à 30 i/s ; l'appelant ramène la vidéo à 24 i/s
longueur = fin - debut
tours = max(1, math.ceil((secondes * 30) / max(longueur, 1)))
if tours > 1:
    arm.animation_data.action = None
    piste = arm.animation_data.nla_tracks.new()
    for k in range(tours):
        piste.strips.new(f'{action.name}-{k}', debut + longueur * k, action)
scene.frame_start = debut
scene.frame_end = debut + int(secondes * 30)

# le corps : sa taille et sa trajectoire
centres, haut, sol = [], 0.0, 1e9
for f in range(scene.frame_start, scene.frame_end + 1, 2):
    scene.frame_set(f)
    deps = bpy.context.evaluated_depsgraph_get()
    mini, maxi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
    for o in corps:
        ev = o.evaluated_get(deps)
        for v in ev.to_mesh().vertices:
            p = o.matrix_world @ v.co
            mini = Vector(map(min, mini, p)); maxi = Vector(map(max, maxi, p))
        ev.to_mesh_clear()
    centres.append((f, (mini + maxi) / 2)); haut = max(haut, maxi.z); sol = min(sol, mini.z)
taille = haut - sol
cx = sum(c.x for _, c in centres) / len(centres); cy = sum(c.y for _, c in centres) / len(centres)


def volume(nom, x, y, z, sx, sy, sz, gris):
    bpy.ops.mesh.primitive_cube_add(location=(x, y, z + sz / 2))
    o = bpy.context.object
    o.name = nom
    o.scale = (sx / 2, sy / 2, sz / 2)
    o.color = (gris, gris, gris, 1)
    return o


# la zone de danse : tout l'espace que la danse parcourt, plus une marge ; rien n'y est posé
rayon = max(max(((c.x - cx) ** 2 + (c.y - cy) ** 2) ** 0.5 for _, c in centres) + taille * 0.9, taille * 1.4)


def sol_dalles(case, g1, g2, etendue=14):
    for i in range(-etendue, etendue + 1):
        for j in range(-etendue, etendue + 1):
            volume('dalle', cx + i * case, cy + j * case, sol - 0.02, case, case, 0.02, g1 if (i + j) % 2 else g2)


R, T = rayon, taille
fond = cy + R + T * 2.0            # le premier plan de décor derrière la zone de danse, à bonne distance
haut_cam = 0.62                    # hauteur de caméra (fraction de la taille)
if decor == 'ruelle':
    sol_dalles(T * 0.45, 0.36, 0.42)
    for cote in (-1, 1):            # deux murs de briques de part et d'autre, une ruelle
        volume('mur', cx + cote * (R + T * 1.8), cy + T * 1.5, sol, T * 0.15, T * 9, T * 2.6, 0.58 + 0.05 * cote)
    volume('fond', cx, fond + T * 1.5, sol, R * 2 + T * 4, T * 0.2, T * 3.0, 0.55)
    volume('benne', cx - R * 0.6, fond, sol, T * 0.9, T * 0.55, T * 0.65, 0.3)
    for k in range(3):
        volume('caisse', cx + R * 0.5 + k * T * 0.35, fond - T * 0.1, sol, T * 0.3, T * 0.3, T * (0.3 + 0.12 * k), 0.4)
elif decor == 'opera':
    haut_cam = 0.9
    sol_dalles(T * 0.25, 0.47, 0.5)            # le plancher de la scène, à lames
    volume('rideau fond', cx, fond + T * 0.6, sol, R * 2 + T * 6, T * 0.3, T * 4.5, 0.36)
    for cote in (-1, 1):
        for k in range(3):                        # les pendrillons de côté, en coulisses
            volume('pendrillon', cx + cote * (R + T * (0.8 + k * 0.7)), cy + T * (1.2 - k * 1.1), sol, T * 0.25, T * 0.9, T * 4.2, 0.33)
        volume('loge', cx + cote * (R + T * 3.2), cy - T * 1.5, sol + T * 1.4, T * 1.2, T * 1.0, T * 0.9, 0.55)
elif decor == 'toit':
    sol_dalles(T * 0.6, 0.48, 0.53)
    for cote in (-1, 1):
        volume('parapet', cx + cote * (R + T * 1.4), cy, sol, T * 0.2, T * 10, T * 0.55, 0.6)
    volume('parapet fond', cx, fond, sol, R * 2 + T * 3, T * 0.2, T * 0.55, 0.6)
    volume('citerne', cx + R + T * 0.6, fond - T * 0.4, sol, T * 0.8, T * 0.8, T * 1.3, 0.35)
    for k in range(-8, 9):                        # la ligne des toits au loin
        volume('immeuble', cx + k * T * 2.2, fond + T * (6 + (k % 3) * 2), sol - T * 2, T * 1.9, T * 1.5, T * (4 + (k * 7 % 5) * 1.6), 0.7 + 0.04 * (k % 2))
elif decor == 'concert':
    sol_dalles(T * 0.5, 0.25, 0.3)
    volume('ecran', cx, fond + T * 0.8, sol + T * 0.6, R * 2 + T * 5, T * 0.2, T * 2.6, 0.75)
    for cote in (-1, 1):
        volume('enceintes', cx + cote * (R + T * 2.0), fond - T * 0.3, sol, T * 0.9, T * 0.8, T * 2.0, 0.18)
        volume('pilier', cx + cote * (R + T * 3.2), cy + T * 0.5, sol, T * 0.18, T * 0.18, T * 3.6, 0.5)
    volume('portique', cx, cy + T * 0.5, sol + T * 3.4, R * 2 + T * 6.6, T * 0.2, T * 0.2, 0.5)
elif decor == 'tokyo':
    sol_dalles(T * 0.5, 0.3, 0.34)
    for cote in (-1, 1):
        for k in range(-3, 4):          # des façades étroites et des enseignes en saillie
            volume('facade', cx + cote * (R + T * 2.2), cy + k * T * 1.6, sol, T * 0.6, T * 1.5, T * (3 + (k % 3) * 0.8), 0.45 + 0.05 * (k % 2))
            volume('enseigne', cx + cote * (R + T * 1.7), cy + k * T * 1.6, sol + T * 1.6, T * 0.08, T * 0.5, T * 1.0, 0.85)
    volume('fond', cx, fond + T * 2, sol, R * 2 + T * 6, T * 0.3, T * 4, 0.5)
elif decor == 'paris':
    sol_dalles(T * 0.3, 0.44, 0.5)
    for k in range(-5, 6):
        volume('immeuble', cx + k * T * 1.8, fond + T * 1.5, sol, T * 1.7, T * 1.2, T * 4.2, 0.72)
        volume('balcon', cx + k * T * 1.8, fond + T * 0.85, sol + T * 2.2, T * 1.2, T * 0.15, T * 0.12, 0.2)
    volume('banc', cx - R - T * 0.6, fond - T * 0.6, sol, T * 0.9, T * 0.3, T * 0.25, 0.3)
    volume('reverbere', cx + R + T * 0.8, fond - T * 0.5, sol, T * 0.07, T * 0.07, T * 2.4, 0.15)
elif decor == 'parking':
    sol_dalles(T * 0.9, 0.38, 0.4)
    volume('plafond', cx, cy, sol + T * 2.0, R * 2 + T * 14, T * 14, T * 0.15, 0.55)
    for i in (-1, 1):
        for j in range(-2, 3):
            volume('pilier', cx + i * (R + T * 1.5), cy + j * T * 2.5, sol, T * 0.35, T * 0.35, T * 2.0, 0.6)
    # une rangée de six voitures garées en épi au fond, capots vers la danseuse (l'ambiance « Tokyo drift »)
    for k in range(6):
        v = volume('voiture', cx + (k - 2.5) * T * 1.25, fond + T * 0.6, sol, T * 1.0, T * 2.3, T * 0.62, (0.2, 0.32, 0.26, 0.38, 0.22, 0.3)[k])
        v.rotation_euler = (0, 0, math.radians(18 * (1 if k % 2 else -1)))
        volume('vitres', v.location.x, v.location.y + T * 0.15, sol + T * 0.62, T * 0.85, T * 1.0, T * 0.3, 0.12).rotation_euler = v.rotation_euler
elif decor == 'cabaret':
    haut_cam = 0.8
    sol_dalles(T * 0.3, 0.3, 0.36)
    volume('rideau', cx, fond + T * 0.5, sol, R * 2 + T * 5, T * 0.3, T * 3.2, 0.32)
    for k in range(-3, 4):
        volume('table ronde', cx + k * T * 1.1, cy - R - T * 1.6, sol, T * 0.45, T * 0.45, T * 0.42, 0.25)
    volume('micro', cx + R + T * 0.6, fond - T * 0.5, sol, T * 0.05, T * 0.05, T * 0.95, 0.15)
elif decor == 'bal':
    haut_cam = 0.8
    sol_dalles(T * 0.45, 0.5, 0.58)
    for cote in (-1, 1):
        for j in range(-3, 4):
            volume('colonne', cx + cote * (R + T * 2.0), cy + j * T * 1.7, sol, T * 0.3, T * 0.3, T * 3.4, 0.8)
    volume('lustre', cx, cy + T * 0.5, sol + T * 3.0, T * 0.9, T * 0.9, T * 0.5, 0.85)
    volume('fond', cx, fond + T * 1.2, sol, R * 2 + T * 6, T * 0.2, T * 3.8, 0.72)
elif decor == 'loft':
    sol_dalles(T * 0.8, 0.42, 0.45)
    volume('mur briques', cx, fond + T * 0.8, sol, R * 2 + T * 8, T * 0.2, T * 2.8, 0.5)
    for k in (-2, 0, 2):
        volume('verriere', cx + k * T * 1.6, fond + T * 0.65, sol + T * 0.7, T * 1.2, T * 0.05, T * 1.6, 0.9)
    volume('poutre', cx, cy, sol + T * 2.7, R * 2 + T * 8, T * 0.25, T * 0.25, 0.3)
    volume('fauteuil', cx + R + T * 1.6, fond, sol, T * 0.7, T * 0.7, T * 0.5, 0.28)
elif decor == 'studio-danse':
    sol_dalles(T * 0.25, 0.55, 0.58)
    volume('mur fond', cx, fond + T * 0.6, sol, R * 2 + T * 8, T * 0.1, T * 2.4, 0.82)
    volume('barre', cx, fond + T * 0.45, sol + T * 0.55, R * 2 + T * 6, T * 0.06, T * 0.06, 0.4)
    volume('mur gauche', cx - R - T * 3.0, cy, sol, T * 0.1, T * 10, T * 2.4, 0.78)
    for k in (-1, 1):
        volume('fenetre', cx - R - T * 2.95, cy + k * T * 1.8, sol + T * 0.8, T * 0.05, T * 1.2, T * 1.3, 0.95)
elif decor == 'sport':
    sol_dalles(T * 0.6, 0.35, 0.38)
    volume('mur fond', cx, fond + T * 0.7, sol, R * 2 + T * 8, T * 0.1, T * 2.6, 0.62)
    for k in range(-3, 4):
        volume('banc muscu', cx + k * T * 1.3, fond, sol, T * 0.5, T * 1.1, T * 0.45, 0.2)
    volume('espalier', cx - R - T * 2.0, cy + T, sol, T * 0.2, T * 1.4, T * 2.2, 0.45)
elif decor == 'cuisine':
    sol_dalles(T * 0.35, 0.6, 0.64)
    volume('mur fond', cx, fond + T * 0.9, sol, R * 2 + T * 8, T * 0.1, T * 2.0, 0.78)
    volume('plan de travail', cx, fond + T * 0.6, sol, R * 2 + T * 3, T * 0.6, T * 0.9, 0.45)
    volume('placards', cx, fond + T * 0.75, sol + T * 1.2, R * 2 + T * 3, T * 0.35, T * 0.6, 0.55)
    volume('frigo', cx + R + T * 1.8, fond + T * 0.6, sol, T * 0.6, T * 0.6, T * 1.8, 0.85)
elif decor == 'plage':
    sol_dalles(T * 1.2, 0.74, 0.76)
    volume('mer', cx, fond + T * 4, sol - 0.01, R * 2 + T * 40, T * 6, 0.02, 0.45)
    volume('parasol', cx + R + T * 1.2, fond - T * 0.5, sol, T * 0.06, T * 0.06, T * 1.6, 0.2)
    volume('toile', cx + R + T * 1.2, fond - T * 0.5, sol + T * 1.55, T * 1.3, T * 1.3, T * 0.12, 0.85)
    volume('transat', cx - R - T * 1.2, fond - T * 0.4, sol, T * 0.6, T * 1.4, T * 0.3, 0.6)
elif decor == 'jardin':
    sol_dalles(T * 0.7, 0.44, 0.47)
    for k in range(-5, 6):
        volume('haie', cx + k * T * 1.3, fond + T * 0.6, sol, T * 1.25, T * 0.8, T * 1.3, 0.3)
    for cote in (-1, 1):
        volume('arbre', cx + cote * (R + T * 2.2), fond - T * 0.5, sol, T * 0.3, T * 0.3, T * 2.6, 0.25)
        volume('feuillage', cx + cote * (R + T * 2.2), fond - T * 0.5, sol + T * 2.0, T * 1.6, T * 1.6, T * 1.4, 0.32)
elif decor == 'basket':
    sol_dalles(T * 0.8, 0.5, 0.53)
    volume('panier', cx, fond + T * 0.8, sol, T * 0.15, T * 0.15, T * 2.6, 0.3)
    volume('planche', cx, fond + T * 0.6, sol + T * 2.4, T * 1.0, T * 0.06, T * 0.7, 0.85)
    volume('grillage', cx, fond + T * 2.2, sol, R * 2 + T * 10, T * 0.05, T * 2.4, 0.55)
    for cote in (-1, 1):
        volume('grillage cote', cx + cote * (R + T * 3.5), cy, sol, T * 0.05, T * 10, T * 2.4, 0.55)
elif decor == 'desert':
    sol_dalles(T * 1.5, 0.66, 0.69)
    volume('route', cx, cy, sol - 0.01, T * 3.5, T * 40, 0.02, 0.3)
    for k in range(-4, 5):
        volume('mesa', cx + k * T * 6, fond + T * 22, sol, T * 5, T * 3, T * (3 + (k % 3) * 1.5), 0.6)
    volume('panneau', cx + R + T * 1.5, fond - T * 0.8, sol, T * 0.08, T * 0.08, T * 1.8, 0.4)
elif decor == 'metro':
    sol_dalles(T * 0.4, 0.55, 0.6)
    volume('quai bord', cx, fond + T * 0.5, sol - T * 0.6, R * 2 + T * 14, T * 0.4, T * 0.62, 0.85)
    volume('voie', cx, fond + T * 1.4, sol - T * 0.6, R * 2 + T * 14, T * 1.6, T * 0.02, 0.2)
    volume('mur carrelage', cx, fond + T * 2.6, sol - T * 0.6, R * 2 + T * 14, T * 0.2, T * 3.2, 0.82)
    for cote in (-1, 1):
        volume('banc', cx + cote * (R + T * 1.6), cy - T * 0.8, sol, T * 1.0, T * 0.35, T * 0.45, 0.4)
elif decor == 'hotel':
    haut_cam = 0.8
    sol_dalles(T * 0.6, 0.6, 0.7)
    volume('comptoir', cx - R * 0.3, fond + T * 0.4, sol, T * 2.2, T * 0.6, T * 1.0, 0.35)
    for cote in (-1, 1):
        volume('colonne', cx + cote * (R + T * 1.8), fond - T * 0.4, sol, T * 0.45, T * 0.45, T * 3.4, 0.75)
        volume('fauteuil', cx + cote * (R + T * 2.4), cy - T * 0.4, sol, T * 0.7, T * 0.7, T * 0.55, 0.3)
    volume('fond', cx, fond + T * 1.3, sol, R * 2 + T * 8, T * 0.2, T * 3.6, 0.65)
    volume('lustre', cx, cy + T * 0.5, sol + T * 3.0, T * 1.0, T * 1.0, T * 0.5, 0.88)
else:   # salon
    sol_dalles(T * 0.4, 0.5, 0.56)
    volume('mur fond', cx, fond + T * 0.6, sol, R * 2 + T * 8, T * 0.1, T * 1.9, 0.7)
    volume('mur gauche', cx - R - T * 3.0, cy, sol, T * 0.1, T * 10, T * 1.9, 0.62)
    volume('canape', cx - R * 0.5, fond + T * 0.3, sol, T * 1.3, T * 0.5, T * 0.45, 0.33)
    volume('table', cx + R * 0.7, fond + T * 0.2, sol, T * 0.55, T * 0.5, T * 0.4, 0.28)
    volume('plante', cx + R + T * 1.2, fond + T * 0.3, sol, T * 0.3, T * 0.3, T * 0.9, 0.22)
# le mannequin a la couleur de peau de la personne de la photo : en gris, LTX garde des bras et des jambes gris ; la tenue vient de la 1re image
for o in corps:
    # les articulations de la même couleur que le corps : plus foncées, LTX en faisait des genoux et des coudes de robot
    o.color = (*teint, 1)

# des repères de sens : une masse de cheveux sombre à l'ARRIÈRE de la tête et des chaussures foncées. Sur un mannequin
# uni, l'avant et l'arrière se confondent et le modèle « saute » un tour ; avec des cheveux derrière, chaque demi-tour se lit.
def attache(nom, os_nom, ou, taille_bloc, couleur):
    """Une sphère accrochée à un os (contrainte Child Of, inverse posé à la 1re image) : elle suit la danse."""
    pb = arm.pose.bones.get('mixamorig:' + os_nom)
    if pb is None:
        return
    scene.frame_set(scene.frame_start)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=16, ring_count=8, location=ou(pb))
    o = bpy.context.object
    o.name = nom
    o.scale = taille_bloc
    o.color = couleur
    c = o.constraints.new('CHILD_OF')
    c.target = arm
    c.subtarget = pb.name
    c.inverse_matrix = (arm.matrix_world @ pb.matrix).inverted()


mw = arm.matrix_world
e = taille / 1.75
# derrière la tête (le dos est du côté +Y : la danseuse fait face à la caméra, placée côté -Y)
attache('cheveux', 'Head', lambda pb: mw @ pb.tail + Vector((0, e * 0.06, -e * 0.06)), (e * 0.085, e * 0.075, e * 0.11), (0.07, 0.05, 0.04, 1))
for cote in ('Left', 'Right'):
    attache('chaussure', cote + 'Foot', lambda pb: (mw @ pb.head + mw @ pb.tail) / 2 + Vector((0, 0, -e * 0.025)), (e * 0.05, e * 0.09, e * 0.045), (0.93, 0.93, 0.93, 1))

# la caméra : de face, à distance, à hauteur de poitrine ; elle suit le centre du corps (lissé) et tourne un peu autour
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 35
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
recul = max(taille * 2.4, rayon * 1.7)
n = len(centres)
for k, (f, c) in enumerate(centres):
    voisins = [centres[x][1] for x in range(max(0, k - 6), min(n, k + 7))]
    m = sum(voisins, Vector()) / len(voisins)
    angle = math.radians(-14 + 28 * k / max(1, n - 1))          # un arc lent de 28° autour d'elle
    cam.location = (m.x + recul * math.sin(angle), m.y - recul * math.cos(angle), sol + taille * haut_cam)
    direction = Vector((m.x, m.y, sol + taille * 0.5)) - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    cam.keyframe_insert('location', frame=f); cam.keyframe_insert('rotation_euler', frame=f)

monde = bpy.data.worlds.new('fond')
scene.world = monde
monde.color = (0.75, 0.75, 0.77)
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'OBJECT'
sh.show_shadows = True
sh.show_cavity = True
scene.render.resolution_x, scene.render.resolution_y = (1280, 704) if paysage else (704, 1280)
if paysage:
    cam_data.lens = 24
    # la vignette d'un studio le montre vide : ni mannequin, ni cheveux, ni chaussures
    for o in scene.objects:
        if o.type == 'MESH' and (o in corps or o.name.startswith(('cheveux', 'chaussure'))):
            o.hide_render = True
scene.render.image_settings.file_format = 'FFMPEG'
scene.render.ffmpeg.format = 'MPEG4'
scene.render.ffmpeg.codec = 'H264'
scene.render.ffmpeg.constant_rate_factor = 'HIGH'
scene.render.filepath = sortie
bpy.ops.render.render(animation=True)

# le masque du corps à la 1re image : blanc sur noir, pour poser le personnage à la place exacte du mannequin
scene.frame_set(scene.frame_start)
for o in scene.objects:
    if o.type == 'MESH' and o not in corps:
        o.hide_render = True
for o in corps:
    o.color = (1, 1, 1, 1)
monde.color = (0, 0, 0)
sh.light = 'FLAT'
sh.show_shadows = False
sh.show_cavity = False
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = sortie.rsplit('.', 1)[0] + '_masque.png'
bpy.ops.render.render(write_still=True)
print(f'SCENE {sortie} images {scene.frame_end - scene.frame_start + 1}')
