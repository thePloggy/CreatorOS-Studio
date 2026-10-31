#!/usr/bin/env python3
"""Stage : rend la maquette grise d'une scène décrite par des nombres (31/10).

Entrée : un JSON {largeur, hauteur, images, objets, camera}. Sortie : un MP4 de maquette.
Aucun fichier du visiteur n'entre ici : rien que des nombres, relus et bornés par le serveur.
Repère en mètres : sol y = 0, x à droite, z vers la caméra.
"""
import json
import math
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

LUMIERE = np.array([-0.45, 0.8, 0.4])
LUMIERE = LUMIERE / np.linalg.norm(LUMIERE)
FACES = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]


def boite(cx, y0, cz, l, h, p, rot=0.0):
    """Les 6 faces d'une boîte posée à y0, tournée de rot degrés autour de la verticale."""
    a = math.radians(rot)
    c, s = math.cos(a), math.sin(a)
    coins = []
    for y in (y0, y0 + h):
        for dx, dz in ((-l / 2, -p / 2), (l / 2, -p / 2), (l / 2, p / 2), (-l / 2, p / 2)):
            coins.append((cx + dx * c + dz * s, y, cz - dx * s + dz * c))
    v = np.array(coins, dtype=float)
    return [v[list(f)] for f in FACES]


def silhouette(o):
    """Un mannequin en blocs : jambes, buste, bras, tête, à l'échelle de sa hauteur."""
    h, x, z, r = o['h'], o['x'], o['z'], o.get('rot', 0.0)
    a = math.radians(r)
    c, s = math.cos(a), math.sin(a)
    def m(dx, y0, l, ht, p):
        return boite(x + dx * c, y0, z - dx * s, l, ht, p, r)
    faces = []
    faces += m(-0.06 * h, 0, 0.08 * h, 0.47 * h, 0.09 * h)
    faces += m(0.06 * h, 0, 0.08 * h, 0.47 * h, 0.09 * h)
    faces += m(0, 0.47 * h, 0.22 * h, 0.35 * h, 0.12 * h)
    faces += m(-0.15 * h, 0.47 * h, 0.06 * h, 0.34 * h, 0.07 * h)
    faces += m(0.15 * h, 0.47 * h, 0.06 * h, 0.34 * h, 0.07 * h)
    faces += m(0, 0.84 * h, 0.11 * h, 0.15 * h, 0.12 * h)
    return faces


def sol():
    faces = []
    for ix in range(-20, 20):
        for iz in range(-30, 12):
            y = 0.0
            faces.append(np.array([(ix, y, iz + 1), (ix + 1, y, iz + 1), (ix + 1, y, iz), (ix, y, iz)], dtype=float))
    return faces


def base_camera(oeil, cible):
    f = cible - oeil
    f = f / max(np.linalg.norm(f), 1e-6)
    d = np.cross(f, [0, 1, 0])
    d = d / max(np.linalg.norm(d), 1e-6)
    return d, np.cross(d, f), f


def image(scene, cam, W, H):
    oeil, cible = np.array(cam['oeil'], dtype=float), np.array(cam['cible'], dtype=float)
    d, u, f = base_camera(oeil, cible)
    focale = 0.5 * W / math.tan(math.radians(cam['fov']) / 2)
    ciel = Image.new('RGB', (W, H), (150, 150, 150))
    dessin = ImageDraw.Draw(ciel)
    liste = []
    for lot, teinte in ((scene['_sol'], 112), (scene['_objets'], 190)):
        for face in lot:
            r = face - oeil
            prof = r @ f
            if (prof < 0.15).any():
                continue
            n = np.cross(face[1] - face[0], face[3] - face[0])
            n = n / max(np.linalg.norm(n), 1e-9)
            if n @ (face.mean(axis=0) - oeil) > 0:
                n = -n
            eclat = 0.55 + 0.45 * max(0.0, float(n @ LUMIERE))
            liste.append((float(np.linalg.norm(r, axis=1).mean()), lot is scene['_sol'], r, prof, teinte * eclat))
    liste.sort(key=lambda t: (not t[1], -t[0]))
    for _dist, est_sol, r, prof, gris in liste:
        pts = [(W / 2 + focale * float(p @ d) / z, H / 2 - focale * float(p @ u) / z) for p, z in zip(r, prof)]
        g = int(max(0, min(255, gris)))
        dessin.polygon(pts, fill=(g, g, g), outline=(g - 14, g - 14, g - 14) if est_sol else (g - 34, g - 34, g - 34))
    return ciel


def camera_a(cles, t):
    """Interpolation douce entre les poses de caméra (t de 0 à 1)."""
    if t <= cles[0]['t']:
        return cles[0]
    for a, b in zip(cles, cles[1:]):
        if t <= b['t']:
            k = (t - a['t']) / max(b['t'] - a['t'], 1e-6)
            k = k * k * (3 - 2 * k)
            return {
                'oeil': [x + (y - x) * k for x, y in zip(a['oeil'], b['oeil'])],
                'cible': [x + (y - x) * k for x, y in zip(a['cible'], b['cible'])],
                'fov': a['fov'] + (b['fov'] - a['fov']) * k,
            }
    return cles[-1]


def principal(entree, sortie):
    with open(entree, encoding='utf8') as fichier:
        s = json.load(fichier)
    W, H, N = s['largeur'], s['hauteur'], s['images']
    objets = []
    for o in s['objets']:
        if o['type'] == 'personne':
            objets += silhouette(o)
        else:
            objets += boite(o['x'], o.get('y', 0.0), o['z'], o['l'], o['h'], o['p'], o.get('rot', 0.0))
    s['_sol'], s['_objets'] = sol(), objets
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '24', '-i', '-',
                           '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', sortie], stdin=subprocess.PIPE)
    for i in range(N):
        ff.stdin.write(image(s, camera_a(s['camera'], i / max(1, N - 1)), W, H).tobytes())
    ff.stdin.close()
    if ff.wait():
        sys.exit('ffmpeg a échoué')


if __name__ == '__main__':
    principal(sys.argv[1], sys.argv[2])
