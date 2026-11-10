#!/usr/bin/env python3
"""Checks a rendered clip with measurements (no language model): one to two seconds per clip.

  python3 scripts/controle_clip.py CLIP.mp4 [--ref IMAGE] [--modeles DOSSIER]

Prints JSON on stdout:
  { "duree": s, "images": n, "problemes": [{type, debut, fin, detail, grave}], "visage": {...} | null }

Defects detected:
  noir    — near-black frames for at least 0.3 s
  fige    — the image stops moving for at least 1 s
  saute   — an abrupt change from one frame to the next (a cut mid-shot)
  flou    — sharpness collapses for at least 0.5 s (mush, smeared frame)
  visage  — the face no longer matches the reference (SFace, cosine distance)
  camera  — the requested camera move (--mouvement avant|arriere|lateral|vertical|fixe)
            is not visible in the optical flow (warning only)

The face check needs the OpenCV models (Apache-2.0) face_detection_yunet_2023mar.onnx and
face_recognition_sface_2021dec.onnx in --modeles; without them it is skipped.
"""
import argparse, json, os, sys

import cv2
import numpy as np

SEUIL_SFACE = 0.363          # published SFace "same person" threshold (cosine)


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
    """Runs of flagged frames lasting at least min_s seconds → [(debut_s, fin_s)]."""
    out, debut = [], None
    for i, d in enumerate(list(drapeaux) + [False]):
        if d and debut is None:
            debut = i
        elif not d and debut is not None:
            if (i - debut) / fps >= min_s:
                out.append((round(debut / fps, 2), round(i / fps, 2)))
            debut = None
    return out


# Camera motion: Farneback optical flow, every other frame pair, at 192 px.
# Totals normalised to 48 pairs (~4 s): rad > 0 = image expands (moving forward), dx/dy = translation.
# Thresholds calibrated on the preset previews (push-in rad +92, pull-out −47, lateral dx 84-87,
# crane dy ±37 to 120, static shot all under 5).
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
    if len(g) < 4:                      # occasional failed read: retry once
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
    # frozen: almost no change between frames (a static shot always keeps some motion)
    for a, b in plages(diffs[1:] < 0.35, fps, 1.0):
        res['problemes'].append({'type': 'fige', 'debut': a, 'fin': b, 'detail': f'figé pendant {b - a:.1f} s', 'grave': True})
    # jump: an isolated difference, far above the clip's usual motion
    med = float(np.median(diffs[1:])) or 0.01
    for i in range(1, n):
        if diffs[i] > max(28.0, 8 * med):
            t = round(i / fps, 2)
            res['problemes'].append({'type': 'saute', 'debut': t, 'fin': t, 'detail': f'saute à {t:.1f} s', 'grave': True})
    # blur: sharpness under 35 % of the clip median, long enough to be visible
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
        f = max(faces, key=lambda x: x[2] * x[3])          # largest face
        # a face that is too small or poorly seen is often a background person, or the
        # character in cropped profile: not compared ("not measurable")
        if f[2] < 0.06 * w or f[-1] < 0.9:
            return None
        return rec.feature(rec.alignCrop(im, f))

    imref = cv2.imread(ref)
    if imref is None:
        return {'erreur': 'référence illisible'}
    eref = empreinte(imref)
    if eref is None:
        return {'erreur': 'aucun visage dans la référence'}
    pas = max(1, int(round(fps / 2)))          # two measurements per second
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
    except Exception as e:      # the check must never break a render
        print(json.dumps({'erreur': str(e)[:300]}, ensure_ascii=False))
        sys.exit(0)
