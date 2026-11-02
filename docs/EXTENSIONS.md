# Writing a CreatorOS Studio extension

An extension adds a function to the studio **without code**: a ComfyUI workflow plus a small description of its form. It shows up in **Create → Extensions** with its own form, runs in the studio's render queue, and its result lands in the library (images, clips) or in *Music and voice* (sounds).

## Files

```
my-extension/
  app.json        what the studio shows: name, description, form fields, output type
  workflow.json   a ComfyUI workflow in API format (Workflow → Export (API) in ComfyUI)
```

### app.json

```json
{
  "id": "postcard",
  "nom": "Postcard",
  "description": "A photo becomes a vintage travel postcard.",
  "auteur": "Your name",
  "licence": "MIT",
  "version": "1.0.0",
  "sortie": "image",
  "entrees": [
    { "id": "photo", "type": "image", "label": "Photo" },
    { "id": "lieu", "type": "texte", "label": "Place name", "defaut": "Lisbon", "aide": "Shown on the card" },
    { "id": "style", "type": "choix", "label": "Style", "options": ["warm", "faded"], "defaut": "warm" },
    { "id": "secondes", "type": "nombre", "label": "Seconds", "defaut": 10, "min": 3, "max": 30 }
  ]
}
```

- `id`: lowercase letters, digits and dashes, 2 to 40 characters. It must match the folder name.
- `sortie`: `image`, `video` or `audio`.
- Field types:
  - `texte`: free text, which goes through the studio's content filter;
  - `nombre`: clamped to `min` and `max`;
  - `choix`: one of `options`;
  - `image`: a photo picked from the library.
- At most 12 fields.

### workflow.json

Put `{{field_id}}` where a value should go. When a placeholder is the whole value, it keeps its type (a number stays a number); inside a sentence, it is replaced as text. `{{seed}}` is always available and gets a random seed. An `image` field becomes the file name of the picked photo, so use it in a `LoadImage` node.

```json
"10": { "class_type": "LoadImage", "inputs": { "image": "{{photo}}" } },
"30": { "class_type": "TextEncodeQwenImageEditPlus", "inputs": { "prompt": "Turn this photo into a postcard that says \"Greetings from {{lieu}}\"", "...": "..." } },
"40": { "class_type": "KSampler", "inputs": { "seed": "{{seed}}", "...": "..." } }
```

The workflow needs at least one save node (`SaveImage`, `SaveVideo`, `SaveAudio`, `SaveAudioMP3`); the studio sets its file prefix.

## Safety rules (checked by the studio)

- **Data only.** An extension never brings code or custom nodes. Before running it, the studio checks that every node class and every model file the workflow names already exists in the user's ComfyUI; if not, the card lists what is missing and the Run button stays off.
- Text fields and every text in the filled workflow go through the same content filter as the rest of the studio.
- Built-in extensions (the `extensions/` folder) can be run by anyone using the studio. Extensions installed from the catalogue can only be installed, run and removed by the studio owner.
- Removing an installed extension moves its folder aside, it is never deleted.

## Publishing in the catalogue

1. Put your extension folder in a public GitHub repository.
2. Open a pull request that adds an entry to `extensions/registre.json`:

```json
{ "id": "postcard", "nom": "Postcard", "description": "…", "auteur": "Your name", "licence": "MIT",
  "source": "https://raw.githubusercontent.com/<you>/<repo>/main/<path>/postcard/" }
```

The studio downloads only `app.json` and `workflow.json` from that folder (raw.githubusercontent.com only, 512 KB each at most) and validates them before saving.
