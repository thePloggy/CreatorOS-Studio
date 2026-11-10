#!/usr/bin/env python3
"""Voice clone: Chatterbox (Resemble AI, MIT) speaks English text with the timbre of a
reference clip (5 to 20 s). The output carries the model's Perth audio watermark.
Usage: clone_voix.py <texte> <reference.wav|mp3> <sortie.wav>"""
import sys

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

texte, reference, sortie = sys.argv[1], sys.argv[2], sys.argv[3]
# ComfyUI may hold the whole GPU: fall back to CPU, slower but safe
try:
    modele = ChatterboxTTS.from_pretrained(device='cuda') if torch.cuda.is_available() else ChatterboxTTS.from_pretrained(device='cpu')
except (RuntimeError, torch.cuda.OutOfMemoryError):
    torch.cuda.empty_cache()
    modele = ChatterboxTTS.from_pretrained(device='cpu')
wav = modele.generate(texte, audio_prompt_path=reference)
ta.save(sortie, wav, modele.sr)
print(sortie)
