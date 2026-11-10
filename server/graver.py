"""Grave la caption d'un reel sur un bandeau, et livre en 1080x1920.

    graver.py <source.mp4> <sortie.mp4> "<caption>"   → JSON {zone, visage, ...}

Le bandeau : texte blanc centré dans une seule boîte noire arrondie, 2 lignes (3 au plus).
Sa place : le tiers bas par défaut ; s'il couvre un visage à un moment du
clip, le milieu ; sinon le tiers haut. Le bas extrême (légende, boutons
TikTok/Instagram) et le haut extrême (onglets) ne sont jamais utilisés : l'app
les recouvre.

Le visage est cherché par le détecteur de Haar livré avec OpenCV, sur une
dizaine d'images réparties sur le clip : c'est rapide (CPU, < 1 s) et ça suit
un visage qui bouge. Il ne sert qu'à PLACER le texte — aucune identification.
"""
import json, subprocess, sys, tempfile, os
import cv2
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
POLICE = os.environ.get('CREATOROS_CAPTION_FONT', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf')
TAILLE = 50
# Vertical center of the caption band, as a fraction of height: lower third, middle, upper third.
ZONES = [('bas', 0.68), ('milieu', 0.50), ('haut', 0.30)]


def sonde(src):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets',
                          '-show_entries', 'stream=width,height,nb_read_packets:format=duration',
                          '-of', 'json', src], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    s = d['streams'][0]
    return int(s['width']), int(s['height']), float(d['format']['duration'])


def visages(src, duree, n=10):
    """Étendue verticale (fractions 0-1, dans le cadre 9:16 final) couverte par
    un visage sur l'ensemble du clip, ou None."""
    det = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
    cap = cv2.VideoCapture(src)
    haut, bas = 1.0, 0.0
    for i in range(n):
        cap.set(cv2.CAP_PROP_POS_MSEC, 1000 * duree * (i + 0.5) / n)
        ok, img = cap.read()
        if not ok:
            continue
        h = img.shape[0]
        gris = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        for (_, y, _, hb) in det.detectMultiScale(gris, scaleFactor=1.1, minNeighbors=5, minSize=(h // 20, h // 20)):
            y0, y1 = y / h, (y + hb) / h
            # forehead and chin overflow the detection box: 20 % margin
            haut, bas = min(haut, y0 - 0.2 * (y1 - y0)), max(bas, y1 + 0.2 * (y1 - y0))
    cap.release()
    return (max(0.0, float(haut)), min(1.0, float(bas))) if bas > haut else None


def lignes(texte, police, largeur_max):
    mots, out, cur = texte.split(), [], ''
    for m in mots:
        essai = (cur + ' ' + m).strip()
        if police.getlength(essai) <= largeur_max or not cur:
            cur = essai
        else:
            out.append(cur); cur = m
    if cur:
        out.append(cur)
    # two balanced lines rather than a long one and an orphan word
    if len(out) == 2 and len(out[1].split()) == 1 and len(out[0].split()) > 2:
        a = out[0].split()
        out = [' '.join(a[:-1]), a[-1] + ' ' + out[1]]
    return out


def bandeau(texte):
    """PNG transparent 1080 de large : UNE boîte noire arrondie autour de
    toutes les lignes, texte centré. Deux lignes au plus à la taille normale ;
    une caption plus longue (réécrite à la main) fait d'abord baisser la
    police, puis passe à trois lignes — jamais plus : au-delà, le bandeau
    mange l'image et ne se lit plus en deux secondes."""
    marge, pad_x, pad_y, inter = 90, 40, 22, 8
    for maxi in (2, 3):
        for taille in range(TAILLE, 37, -2):
            police = ImageFont.truetype(POLICE, taille)
            ls = lignes(texte, police, W - 2 * marge - 2 * pad_x)
            if len(ls) <= maxi:
                break
        if len(ls) <= maxi:
            break
    while len(ls) > 3:  # oversized text: keep shrinking down to three lines
        taille -= 2
        police = ImageFont.truetype(POLICE, taille)
        ls = lignes(texte, police, W - 2 * marge - 2 * pad_x)
    asc, desc = police.getmetrics()
    hl = asc + desc
    larg = max(police.getlength(l) for l in ls) + 2 * pad_x
    h_tot = len(ls) * hl + (len(ls) - 1) * inter + 2 * pad_y
    img = Image.new('RGBA', (W, h_tot), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0 = (W - larg) / 2
    d.rounded_rectangle([x0, 0, x0 + larg, h_tot], radius=22, fill=(0, 0, 0, 128))  # 50 % black
    y = pad_y
    for l in ls:
        d.text(((W - police.getlength(l)) / 2, y), l, font=police, fill=(255, 255, 255, 255))
        y += hl + inter
    return img, len(ls)


def choisir_zone(h_bandeau, visage):
    hb = h_bandeau / H
    for nom, c in ZONES:
        z0, z1 = c - hb / 2 - 0.02, c + hb / 2 + 0.02
        if visage is None or z1 < visage[0] or z0 > visage[1]:
            return nom, c
    return ZONES[0]  # faces everywhere: the lower third is the least intrusive


def main():
    src, dst, texte = sys.argv[1], sys.argv[2], sys.argv[3]
    w, h, duree = sonde(src)
    # The final frame is a filled 9:16 (center crop): face height fractions
    # stay those of the source as long as cropping is horizontal.
    rogne_largeur = w / h >= W / H
    visage = visages(src, duree)
    if visage and not rogne_largeur:
        # vertical crop: map the fractions into the final frame
        hf = w * H / W / h
        m = (1 - hf) / 2
        visage = (max(0.0, (visage[0] - m) / hf), min(1.0, (visage[1] - m) / hf))
    img, n = bandeau(texte)
    zone, c = choisir_zone(img.height, visage)
    y = int(c * H - img.height / 2)
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as t:
        img.save(t.name)
    cadre = f'scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},setsar=1'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-i', t.name,
           '-filter_complex', f'[0:v]{cadre}[v];[v][1:v]overlay=0:{y}:format=auto,format=yuv420p[o]',
           '-map', '[o]', '-map', '0:a?', '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19',
           '-b:v', '0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dst]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:  # GPU unavailable (driver, NVENC sessions full): use CPU
        cmd[cmd.index('h264_nvenc')] = 'libx264'
        i = cmd.index('-preset'); cmd[i + 1] = 'medium'
        for k in ('-rc', '-cq', '-b:v'):
            j = cmd.index(k); del cmd[j:j + 2]
        cmd[cmd.index('-c:a'):cmd.index('-c:a')] = ['-crf', '18']
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    os.unlink(t.name)
    print(json.dumps({'zone': zone, 'lignes': n, 'visage': visage, 'y': y}))


if __name__ == '__main__':
    main()
