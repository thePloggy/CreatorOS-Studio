#!/usr/bin/env python3
"""Contrôle d'un clip rendu, en mesures (pas de modèle de langue) : une à deux secondes par clip.

  python3 scripts/controle_clip.py CLIP.mp4 [--ref IMAGE] [--modeles DOSSIER]

Rend un JSON sur la sortie standard :
  { "duree": s, "images": n, "problemes": [{type, debut, fin, detail, grave}], "visage": {...} | null }

Défauts cherchés :
  noir    — images presque noires pendant au moins 0,3 s
  fige    — l'image ne bouge plus pendant au moins 1 s
  saute   — un changement brutal d'une image à la suivante (une coupe au milieu du plan)
  flou    — la netteté s'effondre pendant au moins 0,5 s (bouillie, image étalée)
  visage  — le visage ne ressemble plus à la référence (SFace, distance cosinus)
  camera  — le mouvement de caméra demandé (--mouvement avant|arriere|lateral|vertical|fixe)
            ne se voit pas dans le flux optique (avertissement seulement)

Le visage demande les modèles OpenCV (Apache-2.0) face_detection_yunet_2023mar.onnx et
face_recognition_sface_2021dec.onnx dans --modeles ; sans eux, ce contrôle est sauté.
"""
import argparse, json, os, sys

import cv2
import numpy as np

SEUIL_SFACE = 0.363          # seuil « même personne » publié pour SFace (cosinus)


def lire(chemin, largeur=256):
    cap = cv2.VideoCapture(chemin)
    fps = cap.get(cv2.CAP_PROP_FPS) or 16.0
    petites, pleines = [], []
    while True:
        ok, im = cap.read()
        if not ok:
            break
        h, w = im.shape[:2]
        g = cv2.cvtColor(cv2.resize(im, (largeur, max(1, int(h * largeur / w)))), cv2.COLOR_BGR2GRAY)
        petites.append(g)
        pleines.append(im)
    cap.release()
    return fps, petites, pleines


def plages(drapeaux, fps, min_s):
    """Suites d'images marquées, d'au moins min_s secondes → [(debut_s, fin_s)]."""
    out, debut = [], None
    for i, d in enumerate(list(drapeaux) + [False]):
        if d and debut is None:
            debut = i
        elif not d and debut is not None:
            if (i - debut) / fps >= min_s:
                out.append((round(debut / fps, 2), round(i / fps, 2)))
            debut = None
    return out


# Mouvement de caméra : flux optique Farneback, une paire d'images sur deux, en 192 px.
# Cumuls ramenés à 48 paires (~4 s) : rad > 0 = l'image s'ouvre (on avance), dx/dy = translation.
# Seuils calés sur les aperçus des presets (push-in rad +92, pull-out −47, latéral dx 84-87,
# grue dy ±37 à 120, plan fixe tout sous 5).
def mouvement_camera(gris):
    prev = None; dx = dy = rad = 0.0; n = 0
    for k, g0 in enumerate(gris):
        if k % 2: continue
        h, w = g0.shape
        g = cv2.resize(g0, (192, max(1, int(h * 192 / w))))
        if prev is not None:
            f = cv2.calcOpticalFlowFarneback(prev, g, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            H, W = g.shape
            ys, xs = np.mgrid[0:H, 0:W]
            rx, ry = xs - W / 2, ys - H / 2
            r = np.sqrt(rx ** 2 + ry ** 2) + 1e-6
            dx += float(f[..., 0].mean()); dy += float(f[..., 1].mean())
            rad += float(((f[..., 0] * rx + f[..., 1] * ry) / r).mean()); n += 1
        prev = g
    k = 48 / max(n, 1)
    return {'dx': round(dx * k, 1), 'dy': round(dy * k, 1), 'rad': round(rad * k, 1)}

def lire_mouvement(m):
    A, L, V = abs(m['rad']), abs(m['dx']), abs(m['dy'])
    if max(A, L, V) < 12: return 'fixe'
    if A >= 20 and A >= 0.6 * max(L, V): return 'avant' if m['rad'] > 0 else 'arriere'
    if L >= 40 and L > 1.5 * V: return 'lateral'
    if V >= 25 and V > 1.5 * L: return 'vertical'
    return 'mixte'

NOMS_MOUVEMENT = {'avant': 'vers l’avant', 'arriere': 'vers l’arrière', 'lateral': 'latéral', 'vertical': 'vertical', 'fixe': 'fixe', 'mixte': 'mélangé'}

def controler(chemin, ref=None, modeles=None, attendu=None):
    fps, g, pleines = lire(chemin)
    if len(g) < 4:                      # lecture ratée de temps en temps : on relit une fois
        fps, g, pleines = lire(chemin)
    n = len(g)
    res = {'duree': round(n / fps, 2), 'images': n, 'fps': round(fps, 2), 'problemes': [], 'visage': None}
    if n < 4:
        res['problemes'].append({'type': 'illisible', 'debut': 0, 'fin': 0, 'detail': 'moins de 4 images', 'grave': False})
        return res
    luma = np.array([x.mean() for x in g])
    diffs = np.array([0.0] + [float(np.abs(g[i].astype(np.int16) - g[i - 1]).mean()) for i in range(1, n)])
    nettete = np.array([cv2.Laplacian(x, cv2.CV_64F).var() for x in g])

    for a, b in plages(luma < 12, fps, 0.3):
        res['problemes'].append({'type': 'noir', 'debut': a, 'fin': b, 'detail': f'noir pendant {b - a:.1f} s', 'grave': True})
    # figé : quasi aucune variation d'une image à l'autre (un plan fixe garde toujours un peu de vie)
    for a, b in plages(diffs[1:] < 0.35, fps, 1.0):
        res['problemes'].append({'type': 'fige', 'debut': a, 'fin': b, 'detail': f'figé pendant {b - a:.1f} s', 'grave': True})
    # saute : une différence isolée, très au-dessus du mouvement habituel du clip
    med = float(np.median(diffs[1:])) or 0.01
    for i in range(1, n):
        if diffs[i] > max(28.0, 8 * med):
            t = round(i / fps, 2)
            res['problemes'].append({'type': 'saute', 'debut': t, 'fin': t, 'detail': f'saute à {t:.1f} s', 'grave': True})
    # flou : netteté sous 35 % de la médiane du clip, assez longtemps pour se voir
    medn = float(np.median(nettete)) or 1.0
    for a, b in plages(nettete < 0.35 * medn, fps, 0.5):
        res['problemes'].append({'type': 'flou', 'debut': a, 'fin': b, 'detail': f'image floue ou étalée pendant {b - a:.1f} s', 'grave': (b - a) >= 1.5})

    if attendu in NOMS_MOUVEMENT:
        m = mouvement_camera(g); vu = lire_mouvement(m)
        res['camera'] = {'attendu': attendu, 'mesure': vu, **m}
        if vu != attendu:
            res['problemes'].append({'type': 'camera', 'debut': 0, 'fin': res['duree'], 'grave': False,
                                     'detail': f"mouvement de caméra demandé : {NOMS_MOUVEMENT[attendu]} ; vu : {NOMS_MOUVEMENT[vu]}"})
    if ref and modeles:
        res['visage'] = visage(pleines, fps, ref, modeles)
        v = res['visage']
        if v and v.get('score') is not None and v['score'] < SEUIL_SFACE:
            res['problemes'].append({'type': 'visage', 'debut': 0, 'fin': res['duree'],
                                     'detail': f"visage peu ressemblant (score {v['score']:.2f}, seuil {SEUIL_SFACE})", 'grave': False})
        elif v and v.get('plage_basse'):
            a, b = v['plage_basse']
            res['problemes'].append({'type': 'visage', 'debut': a, 'fin': b,
                                     'detail': f'le visage s’éloigne de la référence de {a:.1f} à {b:.1f} s', 'grave': False})
    return res


def visage(pleines, fps, ref, modeles):
    det_p = os.path.join(modeles, 'face_detection_yunet_2023mar.onnx')
    rec_p = os.path.join(modeles, 'face_recognition_sface_2021dec.onnx')
    if not (os.path.exists(det_p) and os.path.exists(rec_p)):
        return None
    det = cv2.FaceDetectorYN.create(det_p, '', (320, 320), 0.8)
    rec = cv2.FaceRecognizerSF.create(rec_p, '')

    def empreinte(im):
        h, w = im.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(im)
        if faces is None or not len(faces):
            return None
        f = max(faces, key=lambda x: x[2] * x[3])          # le plus grand visage
        # un visage trop petit ou mal vu est souvent quelqu'un en arrière-plan, ou le
        # personnage de profil et coupé : on ne le compare pas (« non mesurable »)
        if f[2] < 0.06 * w or f[-1] < 0.9:
            return None
        return rec.feature(rec.alignCrop(im, f))

    imref = cv2.imread(ref)
    if imref is None:
        return {'erreur': 'référence illisible'}
    eref = empreinte(imref)
    if eref is None:
        return {'erreur': 'aucun visage dans la référence'}
    pas = max(1, int(round(fps / 2)))          # deux mesures par seconde
    scores, temps = [], []
    for i in range(0, len(pleines), pas):
        e = empreinte(pleines[i])
        if e is not None:
            scores.append(float(rec.match(eref, e, cv2.FaceRecognizerSF_FR_COSINE)))
            temps.append(round(i / fps, 2))
    if len(scores) < 3:
        return {'score': None, 'mesures': len(scores), 'detail': 'visage trop peu visible pour être mesuré'}
    s = np.array(scores)
    out = {'score': round(float(np.median(s)), 3), 'min': round(float(s.min()), 3), 'mesures': len(s)}
    bas = [t for t, x in zip(temps, scores) if x < SEUIL_SFACE]
    if bas and len(bas) >= max(2, len(s) // 4):
        out['plage_basse'] = (bas[0], bas[-1])
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('clip')
    p.add_argument('--ref')
    p.add_argument('--modeles')
    p.add_argument('--mouvement')
    a = p.parse_args()
    try:
        print(json.dumps(controler(a.clip, a.ref, a.modeles, a.mouvement), ensure_ascii=False))
    except Exception as e:      # le contrôle ne doit jamais casser un rendu
        print(json.dumps({'erreur': str(e)[:300]}, ensure_ascii=False))
        sys.exit(0)
