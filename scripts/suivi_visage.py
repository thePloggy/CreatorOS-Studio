#!/usr/bin/env python
"""Cadrage « face tracking » d'une vidéo : la caméra reste verrouillée sur le visage.

Usage : suivi_visage.py VIDEO MODELES_CONTROLE [ZOOM]
Lancé avec le Python de ComfyUI, sur le processeur. Remplace VIDEO par la version recadrée
(même taille, même cadence, son conservé) et affiche une ligne JSON {"ok": bool, ...}.

- YuNet (OpenCV) trouve le visage le plus grand sur chaque image ;
- les images sans visage reprennent la position voisine, et la trajectoire est lissée
  (une caméra qui suit, pas une caméra qui tremble) ;
- la fenêtre, ZOOM fois plus serrée que l'image (défaut 1,7), garde le visage au tiers haut
  et ne sort jamais de l'image ; elle est remise à la taille d'origine.
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

video, modeles = sys.argv[1], sys.argv[2]
zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 1.7


def fin(**r):
    print(json.dumps(r))
    sys.exit(0)


cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
images = []
while True:
    ok, im = cap.read()
    if not ok:
        break
    images.append(im)
cap.release()
if not images:
    fin(ok=False, raison='vidéo illisible')

det = cv2.FaceDetectorYN.create(os.path.join(modeles, 'face_detection_yunet_2023mar.onnx'), '', (W, H), 0.6, 0.3, 50)
centres = []
for im in images:
    _, f = det.detect(im)
    if f is None or not len(f):
        centres.append(None)
        continue
    x, y, w, h = max(f, key=lambda r: r[2] * r[3])[:4]
    centres.append((x + w / 2, y + h / 2))

vus = [i for i, c in enumerate(centres) if c is not None]
if len(vus) < len(images) * 0.3:
    fin(ok=False, raison=f'visage trouvé sur {len(vus)}/{len(images)} images')
# trous : interpolation entre les images où le visage est vu
cx = np.interp(range(len(images)), vus, [centres[i][0] for i in vus])
cy = np.interp(range(len(images)), vus, [centres[i][1] for i in vus])
# lissage : moyenne glissante gaussienne sur ~0,5 s
k = max(3, int(fps * 0.5) | 1)
noyau = np.exp(-0.5 * (np.linspace(-2, 2, k)) ** 2)
noyau /= noyau.sum()
lisse = lambda a: np.convolve(np.pad(a, k // 2, mode='edge'), noyau, mode='valid')
cx, cy = lisse(cx), lisse(cy)

cw, ch = W / zoom, H / zoom
sortie = video + '.suivi.mp4'
ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(fps),
                       '-i', '-', '-i', video, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium',
                       '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', sortie], stdin=subprocess.PIPE)
for im, x, y in zip(images, cx, cy):
    x0 = min(max(x - cw / 2, 0), W - cw)
    y0 = min(max(y - ch * 0.33, 0), H - ch)
    m = np.float32([[zoom, 0, -x0 * zoom], [0, zoom, -y0 * zoom]])
    ff.stdin.write(cv2.warpAffine(im, m, (W, H), flags=cv2.INTER_LANCZOS4).tobytes())
ff.stdin.close()
if ff.wait() != 0:
    fin(ok=False, raison='encodage ffmpeg')
os.replace(sortie, video)
fin(ok=True, images=len(images), visages=len(vus), zoom=zoom)
