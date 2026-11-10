"""Places the character from a photo exactly where the mannequin stands, on the first frame of a mock-up.

Usage: poser_personnage.py MAQUETTE.png MASQUE_CORPS.png PHOTO.png MASQUE_PHOTO.png SORTIE.png
The character is cut out of its photo (white-on-black mask), scaled to the mannequin's height, feet
aligned with its feet, centred on it. The next edit (Qwen Edit) starts from this image: it keeps
the character's position and size and repaints the background.
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
# the mannequin is erased first (inpainted from its surroundings) so its limbs do not show
# around the pasted person, which LTX would turn into a second person
import cv2
import numpy as np
fond_np = cv2.cvtColor(np.array(fond), cv2.COLOR_RGB2BGR)
trou = cv2.dilate((np.array(mc) > 128).astype(np.uint8) * 255, np.ones((15, 15), np.uint8))
fond = Image.fromarray(cv2.cvtColor(cv2.inpaint(fond_np, trou, 9, cv2.INPAINT_TELEA), cv2.COLOR_BGR2RGB))
fond.paste(perso, (x, bc[1]), masque)
fond.save(sortie)
print('POSE', bc, (x, bc[1], w, h))
