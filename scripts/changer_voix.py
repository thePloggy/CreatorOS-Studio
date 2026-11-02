#!/usr/bin/env python3
"""Changeur de voix : Chatterbox VC (Resemble AI, MIT) redit un enregistrement avec un autre
timbre ; les mots, le rythme et les pauses restent. Traité par tranches de 20 s.
La sortie porte le filigrane audio Perth du modèle.
Usage : changer_voix.py <source> <voix_cible.wav> <sortie.wav>"""
import os
import sys
import tempfile

import librosa
import numpy as np
import torch
import torchaudio as ta
from chatterbox.vc import ChatterboxVC

source, cible, sortie = sys.argv[1], sys.argv[2], sys.argv[3]
modele = ChatterboxVC.from_pretrained('cuda' if torch.cuda.is_available() else 'cpu')
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
