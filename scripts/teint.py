"""Skin tone of a photo: median colour of the face centre (YuNet). Usage: teint.py PHOTO MODELES
Prints "r,g,b" in 0..1, linear space (for Blender); an average tone if no face is found."""
import os, sys
import cv2
import numpy as np

img = cv2.imread(sys.argv[1])
h, w = img.shape[:2]
det = cv2.FaceDetectorYN.create(os.path.join(sys.argv[2], 'face_detection_yunet_2023mar.onnx'), '', (w, h), 0.6, 0.3, 50)
_, f = det.detect(img)
rgb = (0.80, 0.62, 0.52)
if f is not None and len(f):
    x, y, fw, fh = [int(v) for v in max(f, key=lambda r: r[2] * r[3])[:4]]
    # cheeks and nose: face centre, below the eyes, above the mouth
    zone = img[y + int(fh * 0.45): y + int(fh * 0.7), x + int(fw * 0.25): x + int(fw * 0.75)]
    if zone.size:
        b, g, r = np.median(zone.reshape(-1, 3), axis=0) / 255.0
        rgb = (r, g, b)
lin = [((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in rgb]
print(','.join(f'{c:.3f}' for c in lin))
