#!/usr/bin/env python3
"""Voice changer: Chatterbox VC (Resemble AI, MIT) re-voices a recording with another
timbre, keeping words, rhythm and pauses. Processed in 20 s chunks.
The output carries the model's Perth audio watermark.
Usage: changer_voix.py <source> <voix_cible.wav> <sortie.wav>"""
import os
import sys
import tempfile

import librosa
import numpy as np
import torch
import torchaudio as ta
from chatterbox.vc import ChatterboxVC

source, cible, sortie = sys.argv[1], sys.argv[2], sys.argv[3]
# ComfyUI may hold the whole GPU: fall back to CPU, slower but safe
try:
    modele = ChatterboxVC.from_pretrained('cuda') if torch.cuda.is_available() else ChatterboxVC.from_pretrained('cpu')
except (RuntimeError, torch.cuda.OutOfMemoryError):
    torch.cuda.empty_cache()
    modele = ChatterboxVC.from_pretrained('cpu')
modele.set_target_voice(cible)
y, _ = librosa.load(source, sr=16000)
pas = 20 * 16000
morceaux = []
with tempfile.TemporaryDirectory() as dossier:
    for i in range(0, len(y), pas):
        tranche = y[i:i + pas]
        if len(tranche) < 1600:
            continue
        f = os.path.join(dossier, f'{i}.wav')
        ta.save(f, torch.from_numpy(tranche).unsqueeze(0), 16000)
        morceaux.append(modele.generate(f).squeeze(0).numpy())
if not morceaux:
    sys.exit('enregistrement trop court')
ta.save(sortie, torch.from_numpy(np.concatenate(morceaux)).unsqueeze(0), modele.sr)
print(sortie)
