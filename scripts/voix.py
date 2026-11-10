#!/usr/bin/env python3
"""Voice-over: Kokoro-82M (Apache-2.0) synthesis of English text to 24 kHz WAV.
Usage: voix.py <texte> <voix> <vitesse> <sortie.wav>"""
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

texte, voix, vitesse, sortie = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
langue = 'b' if voix.startswith('b') else 'a'
# on CPU: ComfyUI often holds the whole GPU, and this small model is fast on CPU
p = KPipeline(lang_code=langue, repo_id='hexgrad/Kokoro-82M', device='cpu')
morceaux = [np.asarray(x.audio) for x in p(texte, voice=voix, speed=vitesse)]
if not morceaux:
    sys.exit('texte vide')
sf.write(sortie, np.concatenate(morceaux), 24000)
print(sortie)
