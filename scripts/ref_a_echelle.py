"""Référence de Swap à la bonne échelle : la personne de la photo, posée sur une toile élargie pour qu'elle y occupe
la même part de la hauteur que la danseuse de la vidéo (sinon le Swap la redessine plus grande, trop près).

Usage : ref_a_echelle.py PHOTO.png MASQUE_PHOTO.png PART_HAUTEUR SORTIE.png
La toile est unie, de la couleur médiane du bord de la photo ; la personne reste nette, au centre, pieds en bas."""
import sys
from PIL import Image

photo, masque, part, sortie = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
p = Image.open(photo).convert('RGB')
m = Image.open(masque).convert('L').resize(p.size)
b = m.point(lambda v: 255 if v > 128 else 0).getbbox()
if not b:
    sys.exit('personne introuvable')
h_perso = b[3] - b[1]
H = max(p.height, round(h_perso / max(0.15, min(part, 0.9))))
W = round(H * p.width / p.height)
# la toile : la couleur moyenne du bord de la photo (le décor étiré y faisait un géant flou derrière elle)
bord = [p.getpixel((x, y)) for x in range(0, p.width, 8) for y in (0, p.height - 1)] + [p.getpixel((x, y)) for y in range(0, p.height, 8) for x in (0, p.width - 1)]
moyenne = tuple(sorted(c[i] for c in bord)[len(bord) // 2] for i in range(3))
fond = Image.new('RGB', (W, H), moyenne)
x = round(W / 2 - (b[0] + b[2]) / 2)
y = round(H * 0.94 - b[3])
fond.paste(p, (x, y), m)
fond.resize((p.width, p.height), Image.LANCZOS).save(sortie)
print('REF', part, (W, H))
