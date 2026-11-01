#!/usr/bin/env python3
"""Stage : rend la maquette grise d'une scène décrite par des nombres (31/10).

Entrée : un JSON {largeur, hauteur, images, objets, camera}. Sortie : un MP4 de maquette.
Aucun fichier du visiteur n'entre ici : rien que des nombres, relus et bornés par le serveur.
Repère en mètres : sol y = 0, x à droite, z vers la caméra.
"""
import json
import math
import struct
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


def lire_glb(chemin):
    """Sommets et triangles d'un GLB (toutes ses primitives), sans transformation de nœud."""
    with open(chemin, 'rb') as fichier:
        b = fichier.read()
    if b[:4] != b'glTF':
        raise ValueError('pas un GLB')
    long_json = struct.unpack('<I', b[12:16])[0]
    js = json.loads(b[20:20 + long_json])
    debut = 20 + long_json + 8

    def acces(i, n_comp):
        a = js['accessors'][i]
        v = js['bufferViews'][a['bufferView']]
        o = debut + v.get('byteOffset', 0) + a.get('byteOffset', 0)
        t = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
        n = a['count'] * n_comp
        pas = v.get('byteStride', 0)
        if pas and pas != np.dtype(t).itemsize * n_comp:
            brut = np.frombuffer(b, np.uint8, a['count'] * pas, o).reshape(-1, pas)[:, :np.dtype(t).itemsize * n_comp]
            return np.frombuffer(brut.tobytes(), t).reshape(-1, n_comp)
        return np.frombuffer(b, t, n, o).reshape(-1, n_comp)

    sommets, faces, base = [], [], 0
    for m in js.get('meshes', []):
        for p in m.get('primitives', []):
            v = acces(p['attributes']['POSITION'], 3).astype(float)
            f = acces(p['indices'], 1).reshape(-1, 3).astype(np.int64) if 'indices' in p else np.arange(len(v)).reshape(-1, 3)
            sommets.append(v)
            faces.append(f + base)
            base += len(v)
    if not sommets:
        raise ValueError('GLB sans maillage')
    return np.concatenate(sommets), np.concatenate(faces)


def simplifier(v, f, cases=96):
    """Regroupe les sommets dans une grille : une maquette n'a pas besoin de 200 000 triangles."""
    bas, haut = v.min(axis=0), v.max(axis=0)
    pas = max((haut - bas).max() / cases, 1e-6)
    cle = np.floor((v - bas) / pas).astype(np.int64)
    _, inverse = np.unique(cle, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    somme = np.zeros((inverse.max() + 1, 3))
    np.add.at(somme, inverse, v)
    compte = np.bincount(inverse)
    nv = somme / compte[:, None]
    nf = inverse[f]
    garde = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    return nv, nf[garde]


def modele(o):
    """Un GLB posé au sol, centré, mis à la hauteur demandée et tourné autour de la verticale."""
    v, f = lire_glb(o['fichier'])
    v, f = simplifier(v, f)
    v = v.copy()
    v -= [(v[:, 0].min() + v[:, 0].max()) / 2, v[:, 1].min(), (v[:, 2].min() + v[:, 2].max()) / 2]
    v *= o['h'] / max(v[:, 1].max(), 1e-6)
    a = math.radians(o.get('rot', 0.0))
    c, s = math.cos(a), math.sin(a)
    x, z = v[:, 0].copy(), v[:, 2].copy()
    v[:, 0], v[:, 2] = o['x'] + x * c + z * s, o['z'] - x * s + z * c
    v[:, 1] += o.get('y', 0.0)
    t = v[f]
    return list(np.concatenate([t, t[:, 2:3]], axis=1))     # triangles écrits en quads : même chemin que les boîtes


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
    lots = [(scene['_sol'], 112), (scene['_objets'], 190)]
    for rang, (lot, teinte) in enumerate(lots):
        if not len(lot):
            continue
        r = lot - oeil
        prof = r @ f
        vis = (prof >= 0.15).all(axis=1)
        q, r, prof = lot[vis], r[vis], prof[vis]
        n = np.cross(q[:, 1] - q[:, 0], q[:, -1] - q[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        n *= -np.sign(np.sum(n * (q.mean(axis=1) - oeil), axis=1, keepdims=True) + 1e-12)
        gris = np.clip(teinte * (0.55 + 0.45 * np.maximum(0.0, n @ LUMIERE)), 0, 255).astype(int)
        ordre = np.argsort(-np.linalg.norm(r, axis=2).mean(axis=1))
        px = W / 2 + focale * (r @ d) / prof
        py = H / 2 - focale * (r @ u) / prof
        contour = rang == 0 or q.shape[0] < 2000
        ecart = 14 if rang == 0 else 34
        for i in ordre:
            g = int(gris[i])
            trait = (g - ecart,) * 3 if contour else (g,) * 3
            dessin.polygon(list(zip(px[i].tolist(), py[i].tolist())), fill=(g, g, g), outline=trait)
    return ciel


def camera_a(cles, t, lineaire=False):
    """Interpolation douce entre les poses de caméra (t de 0 à 1)."""
    if t <= cles[0]['t']:
        return cles[0]
    for a, b in zip(cles, cles[1:]):
        if t <= b['t']:
            k = (t - a['t']) / max(b['t'] - a['t'], 1e-6)
            k = k if lineaire else k * k * (3 - 2 * k)
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
        elif o['type'] == 'modele':
            objets += modele(o)
        else:
            objets += boite(o['x'], o.get('y', 0.0), o['z'], o['l'], o['h'], o['p'], o.get('rot', 0.0))
    s['_sol'] = np.array(sol())
    s['_objets'] = np.array(objets) if objets else np.empty((0, 4, 3))
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '24', '-i', '-',
                           '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', sortie], stdin=subprocess.PIPE)
    for i in range(N):
        ff.stdin.write(image(s, camera_a(s['camera'], i / max(1, N - 1), s.get('lineaire', False)), W, H).tobytes())
    ff.stdin.close()
    if ff.wait():
        sys.exit('ffmpeg a échoué')


if __name__ == '__main__':
    principal(sys.argv[1], sys.argv[2])
