#!/usr/bin/env python3
"""Voix clonée : Chatterbox (Resemble AI, MIT) dit un texte anglais avec le timbre d'un extrait
de référence (5 à 20 s). La sortie porte le filigrane audio Perth du modèle.
Usage : clone_voix.py <texte> <reference.wav|mp3> <sortie.wav>"""
import sys

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

texte, reference, sortie = sys.argv[1], sys.argv[2], sys.argv[3]
modele = ChatterboxTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')
wav = modele.generate(texte, audio_prompt_path=reference)
ta.save(sortie, wav, modele.sr)
print(sortie)
