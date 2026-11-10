#!/usr/bin/env bash
# Downloads the demo characters' LoRAs from Civitai.
# The Civitai token is read from a FILE (never an argument or in the URL):
#   CIVITAI_TOKEN_FILE (default ~/.config/civitai/token), a single line.
# Usage: scripts/demo/loras-civitai.sh [LoRA folder]
set -euo pipefail
DEST="${1:-$HOME/apps/ComfyUI/models/loras}"
TOK_FILE="${CIVITAI_TOKEN_FILE:-$HOME/.config/civitai/token}"
[ -r "$TOK_FILE" ] || { echo "jeton introuvable : $TOK_FILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$TOK_FILE")"
# Civitai version  file name
while read -r v f; do
  [ -z "$v" ] && continue
  if [ -f "$DEST/$f" ]; then echo "déjà là : $f"; continue; fi
  code=$(curl -sL -H "Authorization: Bearer $TOKEN" -o "$DEST/$f.part" -w '%{http_code}' "https://civitai.com/api/download/models/$v")
  if [ "$code" = 200 ] && python3 -I -c "import struct,sys; b=open(sys.argv[1],'rb').read(9); sys.exit(0 if b[8:9]==b'{' and struct.unpack('<Q',b[:8])[0] < 64*2**20 else 1)" "$DEST/$f.part"; then
    mv "$DEST/$f.part" "$DEST/$f"; echo "ok : $f ($(du -h "$DEST/$f" | cut -f1))"
  else
    echo "échec : $f (HTTP $code)" >&2; rm -f "$DEST/$f.part"
  fi
done <<'LISTE'
3364646 Becky_V3_32_25_SB_2400-KREA2Raw.safetensors
3057329 Becky_V2-KLEIN.safetensors
3108169 Asian-Kimiko_Krea2_LOREVER.safetensors
3003877 Asian-Kimiko_Flux2Klein9b_LOREVER.safetensors
3131376 krea2_Breezy_AI_v4_epoch_9.safetensors
2660687 flux2klein_br33zy_v1.safetensors
LISTE
