#!/usr/bin/env python
"""Mix (WanAnimate replacement): the SAM2 points marking the driver's subject.
   args: driver_path gen_w gen_h [subject]
   stdout: JSON {"positive": [{x, y}, ...], "frame": [w, h]}
   GroundingDINO finds the subject's largest box on a sharp frame (~1 s);
   three points on its vertical axis, in generation space (gen_w x gen_h).
   Run with ComfyUI's Python (COMFY_DIR), which provides comfyui_segment_anything."""
import sys, os, json, subprocess, tempfile, warnings
warnings.filterwarnings("ignore")
COMFY = os.environ.get("COMFY_DIR") or os.path.join(os.path.expanduser("~"), "ComfyUI")
sys.path.insert(0, COMFY)
sys.path.insert(0, os.path.join(COMFY, "custom_nodes", "comfyui_segment_anything"))
from PIL import Image

driver, GW, GH = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
sujet = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4].strip() else "woman"
# multi-person Mix: rank of the person, left to right, among `total`
rang = int(sys.argv[5]) if len(sys.argv) > 5 else None
total = int(sys.argv[6]) if len(sys.argv) > 6 else None

fd, tmp = tempfile.mkstemp(suffix=".png"); os.close(fd)
subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "1", "-i", driver, "-frames:v", "1", tmp], check=True)
img = Image.open(tmp).convert("RGB"); W, H = img.size
os.remove(tmp)

import node as sa
dino = sa.load_groundingdino_model("GroundingDINO_SwinT_OGC (694MB)")
b = sa.groundingdino_predict(dino, img, sujet, 0.30)
bs = [] if b is None else b.cpu().numpy().tolist()
aire = lambda r: (r[2] - r[0]) * (r[3] - r[1])
def recouvre(a, b):
    i = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return i / max(1e-6, min(aire(a), aire(b)))
if rang is None:
    x0, y0, x1, y1 = max(bs, key=aire) if bs else (0, 0, W, H)
else:
    uniques = []
    for r in sorted(bs, key=aire, reverse=True):
        if all(recouvre(r, u) < 0.6 for u in uniques): uniques.append(r)
    gardes = sorted(uniques[:total], key=lambda r: r[0] + r[2])
    if len(gardes) < total: raise SystemExit(f"{len(gardes)} personne(s) trouvée(s) sur {total}")
    x0, y0, x1, y1 = gardes[rang]

sx, sy = GW / W, GH / H
cx = (x0 + x1) / 2
pos = [{"x": int(round(cx * sx)), "y": int(round((y0 + (y1 - y0) * f) * sy))} for f in (0.22, 0.42, 0.6)]
print(json.dumps({"positive": pos, "frame": [W, H]}))
