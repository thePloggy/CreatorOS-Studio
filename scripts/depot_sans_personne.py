#!/usr/bin/env python
"""Checks a visitor-uploaded photo contains no human.

Usage: depot_sans_personne.py IMAGE [MODELES_CONTROLE]
Run with ComfyUI's Python (COMFY_DIR), on CPU.
Output: one JSON line {"personne": bool, "raisons": [...]}.

- GroundingDINO looks for a person, face, body or child,
  photographed or drawn;
- YuNet (OpenCV) looks for faces, even small ones.
Any signal is enough to reject: a false rejection costs less than a real
face getting through."""
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
    # everything on CPU: the GPU stays free for renders (option read by ComfyUI at import)
    import comfy.options  # noqa: E402
    comfy.options.enable_args_parsing()
    sys.argv = [sys.argv[0], '--cpu']
    import node as sa  # noqa: E402
    import torch  # noqa: E402
    from local_groundingdino.datasets import transforms as T  # noqa: E402
    dino = sa.load_groundingdino_model('GroundingDINO_SwinT_OGC (694MB)')
    # human words mixed with object words: each box goes to the word that best describes it;
    # a lone word would be attached to the main object whatever it is
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
    logits = out['pred_logits'].sigmoid()[0]          # (queries, 256 tokens)
    tok = dino.tokenizer(legende)
    ids = tok['input_ids']
    # token positions of each word in the caption
    spans, pos = [], 1
    for m in mots:
        n = len(dino.tokenizer(m)['input_ids']) - 2
        spans.append((pos, pos + n)); pos += n + 1     # + the separating period
    for q in range(logits.shape[0]):
        if logits[q].max() < 0.35:
            continue
        scores = [float(logits[q, a:b].mean()) for a, b in spans]
        k = max(range(len(mots)), key=lambda i: scores[i])
        if mots[k] in HUMAINS and scores[k] >= 0.35:
            raisons.append(f'groundingdino:{mots[k]}:{scores[k]:.2f}')
except Exception as e:  # no detector: reject rather than pass blindly
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
