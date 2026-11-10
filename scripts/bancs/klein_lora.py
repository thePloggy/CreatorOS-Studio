"""Bench: Klein identity LoRA face retention.
Same seed, prompt and LoRA; varies the model (distilled / base), steps,
CFG and LoRA strength. Submits directly to the local ComfyUI API.
python3 scripts/bancs/klein_lora.py <output folder>"""
import json, sys, time, urllib.request, shutil, os, copy

COMFY = 'http://127.0.0.1:8188'
SORTIE = sys.argv[1]
SORTIE_COMFY = os.path.expanduser('~/apps/ComfyUI/output')
os.makedirs(SORTIE, exist_ok=True)

PERSOS = {
  'breezy': ('br33zy', 'flux2klein_br33zy_v1.safetensors'),
  'becky': ('becky', 'Becky_V2-KLEIN.safetensors'),
}
SCENES = {
  'cafe': (410021, 'sitting at a small café terrace on a Paris cobblestone street in the morning, wearing a loose white linen shirt and light beige trousers, holding a cup of coffee, candid smile, natural light, travel photo'),
  'plage': (410022, 'walking barefoot along the shoreline at golden hour, wearing a flowing white summer dress, hair moving in the wind, waves behind her, warm sunset light, travel photo'),
}
VARIANTES = {
  'A_distille_20et_lora1':   dict(unet='flux-2-klein-9b-fp8.safetensors', steps=20, cfg=1.0, force=1.0, neg=False),
  'B_distille_4et_lora1':    dict(unet='flux-2-klein-9b-fp8.safetensors', steps=4,  cfg=1.0, force=1.0, neg=False),
  'C_distille_20et_lora1.4': dict(unet='flux-2-klein-9b-fp8.safetensors', steps=20, cfg=1.0, force=1.4, neg=False),
  'D_base_30et_cfg4_lora1':  dict(unet='flux-2-klein-base-9b.safetensors', steps=30, cfg=4.0, force=1.0, neg=True),
}

def graphe(unet, steps, cfg, force, neg, texte, seed, prefix):
    g = {
      '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': unet, 'weight_dtype': 'default'}},
      '13': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': None, 'strength_model': force}},
      '4': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen_3_8b_fp8mixed.safetensors', 'type': 'flux2', 'device': 'default'}},
      '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': texte, 'clip': ['4', 0]}},
      '6': {'class_type': 'FluxGuidance', 'inputs': {'guidance': 3, 'conditioning': ['5', 0]}},
      '7': ({'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['4', 0]}} if neg
            else {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['5', 0]}}),
      '8': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'flux2-vae.safetensors'}},
      '9': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 768, 'height': 1344, 'batch_size': 1}},
      '10': {'class_type': 'KSampler', 'inputs': {'seed': seed, 'steps': steps, 'cfg': cfg, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1,
              'model': ['13', 0], 'positive': ['6', 0], 'negative': ['7', 0], 'latent_image': ['9', 0]}},
      '11': {'class_type': 'VAEDecode', 'inputs': {'samples': ['10', 0], 'vae': ['8', 0]}},
      '12': {'class_type': 'SaveImage', 'inputs': {'filename_prefix': prefix, 'images': ['11', 0]}},
    }
    return g

def post(path, body):
    r = urllib.request.urlopen(urllib.request.Request(COMFY + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}), timeout=60)
    return json.load(r)

def attendre(pid):
    while True:
        h = json.load(urllib.request.urlopen(f'{COMFY}/history/{pid}', timeout=30))
        if pid in h: return h[pid]
        time.sleep(2)

resume = []
for nom, (trig, lora) in PERSOS.items():
    for sc, (seed, prompt) in SCENES.items():
        for var, v in VARIANTES.items():
            g = graphe(v['unet'], v['steps'], v['cfg'], v['force'], v['neg'], f'{trig}, a woman, {prompt}', seed, f'banc_klein/{nom}_{sc}_{var}')
            g['13']['inputs']['lora_name'] = lora
            t0 = time.time()
            pid = post('/prompt', {'prompt': g})['prompt_id']
            h = attendre(pid)
            ok = h.get('status', {}).get('completed')
            imgs = [i for o in h.get('outputs', {}).values() for i in o.get('images', [])]
            if ok and imgs:
                src = os.path.join(SORTIE_COMFY, imgs[0].get('subfolder', ''), imgs[0]['filename'])
                dst = os.path.join(SORTIE, f'{nom}_{sc}_{var}.png'); shutil.copy(src, dst)
            resume.append((nom, sc, var, ok, round(time.time() - t0, 1)))
            print(*resume[-1], flush=True)
json.dump(resume, open(os.path.join(SORTIE, 'resume.json'), 'w'), indent=1)
