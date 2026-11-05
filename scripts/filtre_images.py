"""Filtre de nudité des rendus (NudeNet, MIT, CPU).

Usage : filtre_images.py FICHIER [FICHIER...]
Une image est lue telle quelle ; une vidéo est lue à raison d'une image par
seconde (plus la première et la dernière). Pour chaque fichier, une ligne JSON :
  {"fichier", "positif", "score", "classe", "images"}
« positif » = une partie intime découverte détectée au-dessus du seuil sur au
moins une image. Les parties couvertes (maillot, sous-vêtement) ne comptent pas.
"""
import json
import os
import subprocess
import sys
import tempfile

from nudenet import NudeDetector

# classes qui rendent un rendu positif, avec leur seuil ; en dessous, maillots de bain et
# combinaisons moulantes sortaient en faux positifs (scores mesurés de 0,48 à 0,72)
SEUILS = {
    'FEMALE_GENITALIA_EXPOSED': 0.6,
    'MALE_GENITALIA_EXPOSED': 0.6,
    'ANUS_EXPOSED': 0.6,
    'FEMALE_BREAST_EXPOSED': 0.7,
    'BUTTOCKS_EXPOSED': 0.75,
}
VIDEO = ('.mp4', '.webm', '.mov', '.mkv', '.gif')


def images_de(fichier, dossier):
    if not fichier.lower().endswith(VIDEO):
        return [fichier]
    motif = os.path.join(dossier, 'i%04d.jpg')
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-i', fichier,
                    '-vf', "select='eq(n\\,0)+gte(t-prev_selected_t\\,1)',scale='min(960,iw)':-2",
                    '-vsync', 'vfr', '-q:v', '3', motif], check=False, timeout=120)
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-sseof', '-0.1', '-i', fichier,
                    '-frames:v', '1', '-q:v', '3', os.path.join(dossier, 'z_fin.jpg')], check=False, timeout=60)
    return sorted(os.path.join(dossier, f) for f in os.listdir(dossier) if f.endswith('.jpg'))


# --personne : toute partie du corps humain, découverte ou non (dépôt des visiteurs)
SEUIL_PERSONNE = 0.4


def main():
    det = NudeDetector()
    args = sys.argv[1:]
    personne = '--personne' in args
    args = [a for a in args if a != '--personne']
    for fichier in args:
        res = {'fichier': fichier, 'positif': False, 'score': 0.0, 'classe': None, 'images': 0}
        try:
            with tempfile.TemporaryDirectory() as d:
                imgs = images_de(fichier, d)
                res['images'] = len(imgs)
                for img in imgs:
                    for o in det.detect(img):
                        seuil = SEUIL_PERSONNE if personne else SEUILS.get(o['class'])
                        if seuil is None:
                            continue
                        if o['score'] > res['score']:
                            res['score'], res['classe'] = round(float(o['score']), 3), o['class']
                        if o['score'] >= seuil:
                            res['positif'] = True
        except Exception as e:  # un fichier illisible ne bloque pas les autres
            res['erreur'] = str(e)[:200]
        print(json.dumps(res), flush=True)


if __name__ == '__main__':
    main()
