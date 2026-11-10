#!/usr/bin/env python3
"""Paints an object into a clip: pastes the cut-out object into the zone, frame by frame.

Input: the clip, the mask video (white = zone), the object PNG (alpha), the output, the pace,
and, for a distant object, the people mask video.
Distant: the object follows the camera motion (optical flow on the background), goes behind
people and takes on distance blur and haze.
The paste is a starting point: the Wan edit then blends it into the scene.
"""
import subprocess
import sys

import numpy as np
from PIL import Image, ImageFilter


def lire(chemin, fps):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', chemin],
                         capture_output=True, text=True, check=True)
    w, h = [int(x) for x in out.stdout.strip().split(',')[:2]]
    brut = subprocess.run(['ffmpeg', '-v', 'error', '-i', chemin, '-vf', f'fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                          capture_output=True, check=True).stdout
    return np.frombuffer(brut, np.uint8).reshape(-1, h, w, 3), w, h


def boite_du_masque(m, w, h, mw, mh):
    ys, xs = np.nonzero(m)
    if len(xs) <= 16:
        return None
    return (xs.min() * w / mw, ys.min() * h / mh, (xs.max() + 1) * w / mw, (ys.max() + 1) * h / mh)


def principal(clip, masque, objet_png, sortie, fps, personnes=None):
    images, w, h = lire(clip, fps)
    masques, mw, mh = lire(masque, fps)
    objet = Image.open(objet_png).convert('RGBA')
    boite = objet.getchannel('A').getbbox()
    if boite:
        objet = objet.crop(boite)
    loin = personnes is not None
    if loin:
        import cv2
        gens, gw, gh = lire(personnes, fps)
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', '-',
                           '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', sortie], stdin=subprocess.PIPE)
    derniere = None
    camera = np.eye(3)
    precedente = None
    calque = None
    for i, im in enumerate(images):
        cadre = Image.fromarray(im)
        if not loin:
            m = masques[min(i, len(masques) - 1), :, :, 0] > 127
            derniere = boite_du_masque(m, w, h, mw, mh) or derniere
            if derniere:
                x0, y0, x1, y1 = derniere
                e = min((x1 - x0) / objet.width, (y1 - y0) / objet.height)
                taille = (max(1, round(objet.width * e)), max(1, round(objet.height * e)))
                o = objet.resize(taille, Image.LANCZOS)
                cadre.paste(o, (round((x0 + x1 - taille[0]) / 2), round((y0 + y1 - taille[1]) / 2)), o)
            ff.stdin.write(np.asarray(cadre).tobytes())
            continue
        # distant: the object is placed once in the zone of the first frame, then follows the background
        g = gens[min(i, len(gens) - 1), :, :, 0]
        if (gw, gh) != (w, h):
            g = cv2.resize(g, (w, h))
        gens_masque = cv2.GaussianBlur(cv2.dilate((g > 100).astype(np.uint8) * 255, np.ones((7, 7))), (0, 0), 2) / 255.0
        gris = cv2.cvtColor(im, cv2.COLOR_RGB2GRAY)
        if precedente is not None:
            decor = ((gens_masque < 0.05) * 255).astype(np.uint8)
            p0 = cv2.goodFeaturesToTrack(precedente, 500, 0.01, 12, mask=decor)
            if p0 is not None and len(p0) >= 8:
                p1, st, _ = cv2.calcOpticalFlowPyrLK(precedente, gris, p0, None, winSize=(21, 21))
                ok = st.reshape(-1) == 1
                if ok.sum() >= 8:
                    a, _ = cv2.estimateAffinePartial2D(p0[ok], p1[ok], method=cv2.RANSAC, ransacReprojThreshold=2)
                    if a is not None:
                        camera = np.vstack([a, [0, 0, 1]]) @ camera
        precedente = gris
        if calque is None:
            zone = boite_du_masque(masques[0, :, :, 0] > 127, w, h, mw, mh)
            if not zone:
                ff.stdin.write(im.tobytes())
                continue
            x0, y0, x1, y1 = zone
            e = min((x1 - x0) / objet.width, (y1 - y0) / objet.height)
            o = objet.resize((max(1, round(objet.width * e)), max(1, round(objet.height * e))), Image.LANCZOS)
            o = o.filter(ImageFilter.GaussianBlur(max(1.0, o.height / 130)))
            calque = np.asarray(o).astype(np.float32)
            pose = np.array([[1, 0, (x0 + x1 - o.width) / 2], [0, 1, y1 - o.height], [0, 0, 1.0]])
            # haze: mean colour of the top of the frame, where the distance is
            brume = im[: max(1, round(y1)), :, :].reshape(-1, 3).mean(0)
        couche = cv2.warpAffine(calque, (camera @ pose)[:2], (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        alpha = couche[..., 3] / 255.0 * (1 - gens_masque)
        teinte = couche[..., :3] * 0.78 + brume * 0.22
        sortie_img = im * (1 - alpha[..., None]) + teinte * alpha[..., None]
        ff.stdin.write(np.clip(sortie_img, 0, 255).astype(np.uint8).tobytes())
    ff.stdin.close()
    if ff.wait():
        sys.exit('ffmpeg a échoué')


if __name__ == '__main__':
    principal(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6] if len(sys.argv) > 6 else None)
