#!/usr/bin/env python
"""Contrôle d'une photo déposée par un visiteur : aucune personne humaine.

Usage : depot_sans_personne.py IMAGE [MODELES_CONTROLE]
Lancé avec le Python de ComfyUI (COMFY_DIR), sur le processeur.
Sortie : une ligne JSON {"personne": bool, "raisons": [...]}.

- GroundingDINO cherche une personne, un visage, un corps ou un enfant,
  photographiés ou dessinés ;
- YuNet (OpenCV) cherche les visages, même petits.
Le moindre signal suffit à refuser : un faux refus coûte moins qu'un visage
réel qui passe."""
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')
os.environ['CUDA_VISIBLE_DEVICES'] = ''
COMFY = os.environ.get('COMFY_DIR') or os.path.join(os.path.expanduser('~'), 'ComfyUI')
sys.path.insert(0, COMFY)
sys.path.insert(0, os.path.join(COMFY, 'custom_nodes', 'comfyui_segment_anything'))

from PIL import Image  # noqa: E402

image = sys.argv[1]
modeles = sys.argv[2] if len(sys.argv) > 2 else ''
raisons = []

img = Image.open(image).convert('RGB')
img.thumbnail((1280, 1280))

try:
    # tout sur le processeur : la carte reste aux rendus (option lue par ComfyUI à l'import)
    import comfy.options  # noqa: E402
    comfy.options.enable_args_parsing()
    sys.argv = [sys.argv[0], '--cpu']
    import node as sa  # noqa: E402
    import torch  # noqa: E402
    from local_groundingdino.datasets import transforms as T  # noqa: E402
    dino = sa.load_groundingdino_model('GroundingDINO_SwinT_OGC (694MB)')
    # mots humains mêlés à des mots d'objets : chaque boîte va au mot qui la décrit le mieux,
    # un mot seul serait collé sur l'objet principal quel qu'il soit
    HUMAINS = ['person', 'human face', 'child', 'hand']
    AUTRES = ['animal', 'robot', 'toy', 'statue', 'bottle', 'product', 'food', 'furniture',
              'vehicle', 'building', 'plant', 'landscape', 'object']
    mots = HUMAINS + AUTRES
    legende = ' . '.join(mots) + ' .'
    tr = T.Compose([T.RandomResize([800], max_size=1333), T.ToTensor(),
                    T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x, _ = tr(img, None)
    with torch.no_grad():
        out = dino(x[None], captions=[legende])
    logits = out['pred_logits'].sigmoid()[0]          # (requêtes, 256 jetons)
    tok = dino.tokenizer(legende)
    ids = tok['input_ids']
    # position des jetons de chaque mot dans la légende
    spans, pos = [], 1
    for m in mots:
        n = len(dino.tokenizer(m)['input_ids']) - 2
        spans.append((pos, pos + n)); pos += n + 1     # + le point qui sépare
    for q in range(logits.shape[0]):
        if logits[q].max() < 0.35:
            continue
        scores = [float(logits[q, a:b].mean()) for a, b in spans]
        k = max(range(len(mots)), key=lambda i: scores[i])
        if mots[k] in HUMAINS and scores[k] >= 0.35:
            raisons.append(f'groundingdino:{mots[k]}:{scores[k]:.2f}')
except Exception as e:  # sans détecteur, on refuse : on ne laisse pas passer à l'aveugle
    raisons.append(f'erreur-groundingdino:{str(e)[:120]}')

try:
    import cv2  # noqa: E402
    import numpy as np  # noqa: E402
    det_p = os.path.join(modeles, 'face_detection_yunet_2023mar.onnx')
    if os.path.exists(det_p):
        bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        det = cv2.FaceDetectorYN.create(det_p, '', (w, h), 0.6, 0.3, 50)
        _, faces = det.detect(bgr)
        if faces is not None and len(faces):
            raisons.append(f'yunet:visages:{len(faces)}')
    else:
        raisons.append('erreur-yunet:modele-absent')
except Exception as e:
    raisons.append(f'erreur-yunet:{str(e)[:120]}')

print(json.dumps({'personne': bool(raisons), 'raisons': raisons}), flush=True)
