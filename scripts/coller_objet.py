#!/usr/bin/env python3
"""Objet peint dans un clip (01/11) : colle l'objet détouré dans la zone suivie, image par image.

Entrée : le clip, la vidéo de masque (blanc = zone), le PNG de l'objet (alpha), la sortie, le rythme.
Le collage sert de départ : la retouche Wan le fond ensuite dans la scène.
"""
import subprocess
import sys

import numpy as np
from PIL import Image


def lire(chemin, fps):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', chemin], capture_output=True, text=True, check=True)
    w, h = [int(x) for x in out.stdout.strip().split(',')[:2]]
    brut = subprocess.run(['ffmpeg', '-v', 'error', '-i', chemin, '-vf', f'fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(brut, np.uint8).reshape(-1, h, w, 3), w, h


def principal(clip, masque, objet_png, sortie, fps):
    images, w, h = lire(clip, fps)
    masques, mw, mh = lire(masque, fps)
    objet = Image.open(objet_png).convert('RGBA')
    boite = objet.getchannel('A').getbbox()
    if boite:
        objet = objet.crop(boite)
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', '-', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', sortie], stdin=subprocess.PIPE)
    derniere = None
    for i, im in enumerate(images):
        m = masques[min(i, len(masques) - 1), :, :, 0] > 127
        ys, xs = np.nonzero(m)
        if len(xs) > 16:
            derniere = (xs.min() * w / mw, ys.min() * h / mh, (xs.max() + 1) * w / mw, (ys.max() + 1) * h / mh)
        cadre = Image.fromarray(im)
        if derniere:
            x0, y0, x1, y1 = derniere
            e = min((x1 - x0) / objet.width, (y1 - y0) / objet.height)
            taille = (max(1, round(objet.width * e)), max(1, round(objet.height * e)))
            o = objet.resize(taille, Image.LANCZOS)
            cadre.paste(o, (round((x0 + x1 - taille[0]) / 2), round((y0 + y1 - taille[1]) / 2)), o)
        ff.stdin.write(np.asarray(cadre).tobytes())
    ff.stdin.close()
    if ff.wait():
        sys.exit('ffmpeg a échoué')


if __name__ == '__main__':
    principal(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
