---
name: creatoros-studio
description: Drive a running CreatorOS Studio (local AI photo, video, dance, music and voice studio on one GPU) through its MCP tools. Use when the user asks to render a photo, animate an image, make a reel, make a character dance, compose music or a sound effect, give a photo a voice, or rework a clip (refine details, day to night, remove or replace an element, change the background).
---

# CreatorOS Studio

The `creatoros-studio` MCP server talks to a studio that is already running (default `http://127.0.0.1:8787`). Every call goes through the studio's HTTP API, so the web UI's rules apply: SFW content filter, render queue, visitor limits. Nothing renders on the agent side.

## Before anything

1. `machine_status`: is ComfyUI linked, how long is the queue, which video engines exist. One GPU: jobs run one after another, so a long queue means a long wait.
2. `list_characters` if the user names a character; otherwise the active one is used.

## Pick the tool

| The user wants | Tool | Time |
|---|---|---|
| A photo | `generate_photo` (waits, returns the library id) | 15-60 s |
| A photo that moves | `image_to_video` with that id and one continuous motion | several min |
| A finished vertical reel from a brief | `make_reel` | 10-30 min |
| The character dancing | `list_dances`, then `dance` (photo id + dance slug + studio id) | ~6 min |
| Music or a sound effect | `generate_music` (two takes land in `list_music`) | ~1 min |
| A photo that talks | `list_voices`, `speak`, then `talking_clip` with the returned audio file | several min |
| Rework an existing clip | `edit_video` (effect / modify / remove / background) | a few min |

Long tools return a job id: poll `get_status` (a reel id starts with `reel-`). For `dance`, poll `finalJobId`: the first job is only the 3D scene.

## Writing prompts

- Photos: write the prompt as it should be rendered (subject, action, place, light, framing), not as a request.
- Motion: one continuous action plus one camera move ("she turns a page, slow push-in"). No cuts, no list of actions.
- Dance: give `description` only when the dance name is ambiguous (how the step is done, e.g. the moonwalk). The studio keeps the dance area clear; choose a studio that suits the dance (cabaret, loft, tokyo street, dance studio…).
- Music: genre, instruments, mood; "128 bpm" in the style sets the tempo, otherwise the genre does. Lyrics in plain stanzas are tagged [Verse]/[Chorus] automatically; the language is detected.
- `edit_video` targets are named in English ("red car", "person").

## Limits to respect

- SFW only. A refused prompt is a final answer: do not rephrase it to get around the filter.
- Use a full-body photo of the character for `dance`; the identity and outfit come from that photo.
- Don't queue many long jobs at once on a shared studio: render one, check it with the user, then continue.
