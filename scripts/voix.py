#!/usr/bin/env python3
"""Voix off : synthèse Kokoro-82M (Apache-2.0) d'un texte anglais, en WAV 24 kHz.
Usage : voix.py <texte> <voix> <vitesse> <sortie.wav>"""
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

texte, voix, vitesse, sortie = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
langue = 'b' if voix.startswith('b') else 'a'
# sur le processeur : la carte est souvent prise entière par ComfyUI, et ce petit modèle y est rapide
p = KPipeline(lang_code=langue, repo_id='hexgrad/Kokoro-82M', device='cpu')
morceaux = [np.asarray(x.audio) for x in p(texte, voice=voix, speed=vitesse)]
if not morceaux:
    sys.exit('texte vide')
sf.write(sortie, np.concatenate(morceaux), 24000)
print(sortie)
