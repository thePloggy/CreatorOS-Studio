#!/usr/bin/env python3
"""Temps forts d'un morceau : tempo par autocorrélation de l'enveloppe d'attaques, puis grille
de temps calée sur les attaques les plus fortes. Sans dépendance au-delà de numpy et ffmpeg.
Usage : temps.py <audio> -> JSON {"bpm": float, "temps": [secondes...]}"""
import json
import subprocess
import sys

import numpy as np

SR, HOP = 22050, 512
brut = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
x = np.frombuffer(brut, np.float32)
n = len(x) // HOP
trames = x[: n * HOP].reshape(n, HOP) * np.hanning(HOP)
spec = np.abs(np.fft.rfft(trames, axis=1))
flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(axis=1)
flux = (flux - flux.mean()) / (flux.std() + 1e-9)
fps = SR / HOP
# tempo : pic d'autocorrélation entre 70 et 180 BPM
ac = np.correlate(flux, flux, mode='full')[len(flux) - 1:]
lags = np.arange(len(ac))
ok = (lags >= fps * 60 / 180) & (lags <= fps * 60 / 70)
periode = lags[ok][np.argmax(ac[ok])]
bpm = 60 * fps / periode
# phase : la grille qui recueille le plus d'énergie d'attaque
phases = [flux[p::periode].sum() for p in range(int(periode))]
debut = int(np.argmax(phases))
temps = [round(float(i / fps), 3) for i in range(debut, len(flux), int(periode))]
print(json.dumps({'bpm': round(float(bpm), 1), 'temps': temps}))
