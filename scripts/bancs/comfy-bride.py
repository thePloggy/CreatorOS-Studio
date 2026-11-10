# Simulates a small GPU on a large one, for the lab (scripts/bancs/labo-*petite*.mjs).
# usage, with ComfyUI's venv python: CARTE_GO=12 COMFY_DIR=~/ComfyUI python scripts/bancs/comfy-bride.py --port 8190 --disable-dynamic-vram
# Runs ComfyUI as on a CARTE_GO GB card: PyTorch cannot allocate more (memory fraction),
# and ComfyUI sees only that much (--reserve-vram), so it offloads weights as it would on a real card.
import os, sys, runpy, torch
carte = float(os.environ['CARTE_GO'])
total = torch.cuda.get_device_properties(0).total_memory / 2**30
torch.cuda.set_per_process_memory_fraction((carte - 0.8) / total)   # ~0.8 GB for the CUDA context outside PyTorch
racine = os.path.expanduser(os.environ.get('COMFY_DIR', '~/ComfyUI'))   # ComfyUI folder
os.chdir(racine); sys.path.insert(0, racine)
libre = torch.cuda.mem_get_info()[0] / 2**30   # what other processes actually leave free
sys.argv = ['main.py', *sys.argv[1:], '--reserve-vram', f'{max(0, libre - carte + 0.8):.1f}']
runpy.run_path('main.py', run_name='__main__')
