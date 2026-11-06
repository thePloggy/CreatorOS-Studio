"""Pose le personnage d'une photo à la place exacte du mannequin, sur la 1re image d'une maquette.

Usage : poser_personnage.py MAQUETTE.png MASQUE_CORPS.png PHOTO.png MASQUE_PHOTO.png SORTIE.png
Le personnage est découpé dans sa photo (masque blanc sur noir), mis à la hauteur du mannequin, les pieds
à la hauteur de ses pieds, centré sur lui. La retouche suivante (Qwen Edit) part de cette image : elle garde
la place et la taille du personnage, et repeint le décor.
"""
import sys
from PIL import Image

maq, mcorps, photo, mphoto, sortie = sys.argv[1:6]
fond = Image.open(maq).convert('RGB')
mc = Image.open(mcorps).convert('L').resize(fond.size)
bc = mc.point(lambda v: 255 if v > 128 else 0).getbbox()
if not bc:
    sys.exit('mannequin introuvable dans le masque')
p = Image.open(photo).convert('RGB')
mp = Image.open(mphoto).convert('L').resize(p.size)
bp = mp.point(lambda v: 255 if v > 128 else 0).getbbox()
if not bp:
    sys.exit('personne introuvable dans la photo')
perso, masque = p.crop(bp), mp.crop(bp)
h = bc[3] - bc[1]
w = round(perso.width * h / perso.height)
perso, masque = perso.resize((w, h), Image.LANCZOS), masque.resize((w, h), Image.LANCZOS)
x = round((bc[0] + bc[2]) / 2 - w / 2)
# le mannequin est d'abord effacé de l'image (reconstruit à partir de ce qui l'entoure) : posée par-dessus, une personne
# bras le long du corps laissait dépasser les bras ou les jambes d'un mannequin en pleine danse, et LTX en faisait
# une deuxième personne derrière elle
import cv2
import numpy as np
fond_np = cv2.cvtColor(np.array(fond), cv2.COLOR_RGB2BGR)
trou = cv2.dilate((np.array(mc) > 128).astype(np.uint8) * 255, np.ones((15, 15), np.uint8))
fond = Image.fromarray(cv2.cvtColor(cv2.inpaint(fond_np, trou, 9, cv2.INPAINT_TELEA), cv2.COLOR_BGR2RGB))
fond.paste(perso, (x, bc[1]), masque)
fond.save(sortie)
print('POSE', bc, (x, bc[1], w, h))
