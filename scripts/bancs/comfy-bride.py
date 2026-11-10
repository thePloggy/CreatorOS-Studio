# Simule une petite carte sur une grande, pour le labo (scripts/bancs/labo-*petite*.mjs).
# usage, avec le python du venv de ComfyUI : CARTE_GO=12 COMFY_DIR=~/ComfyUI python scripts/bancs/comfy-bride.py --port 8190 --disable-dynamic-vram
# Lance ComfyUI comme sur une carte de CARTE_GO Go : PyTorch ne peut pas allouer plus (fraction),
# et ComfyUI croit n'avoir que ça (--reserve-vram), donc il décharge les poids comme il le ferait vraiment.
import os, sys, runpy, torch
carte = float(os.environ['CARTE_GO'])
total = torch.cuda.get_device_properties(0).total_memory / 2**30
torch.cuda.set_per_process_memory_fraction((carte - 0.8) / total)   # ~0,8 Go pour le contexte CUDA hors PyTorch
racine = os.path.expanduser(os.environ.get('COMFY_DIR', '~/ComfyUI'))   # le dossier de ComfyUI
os.chdir(racine); sys.path.insert(0, racine)
libre = torch.cuda.mem_get_info()[0] / 2**30   # ce que les autres processus laissent vraiment
sys.argv = ['main.py', *sys.argv[1:], '--reserve-vram', f'{max(0, libre - carte + 0.8):.1f}']
runpy.run_path('main.py', run_name='__main__')
