---
name: image-tools
description: "Generate, edit, mask and cut out images with the image tools. Triggers: 'draw', 'generate an image', 'make a picture', 'illustration', 'logo', 'icon', 'mockup', 'edit this image', 'change the background', 'remove the background', 'transparent background', 'cut out', 'mask', 'inpaint', 'use Nano Banana', 'use Sunburst', 'use Seedream', 'which image model'."
---

# Image

Four tools, one job each:

| Tool | Use it to |
|---|---|
| `image_generate` | draw a new picture, or edit one (`images` = the picture(s) to edit or take reference from) |
| `image_models` | see which image models this machine can run right now, in the order the image role tries them |
| `image_process` | change a file locally, free and instant: `cutout`, `trim`, `crop`, `resize`, `pad`, `flip`, `flop`, `rotate`, `format` |
| `image_mask` | make the mask an edit repaints through, the size of the picture it is for |

## Choosing the model

- Say nothing and the **image role** picks: its first model that this machine has a login for, falling through to the
  next on a failure (rate limit, outage, refusal). The default role starts with GPT Image 2.5 Sunburst, then the
  ChatGPT subscription, then Nano Banana Pro.
- When the person names a model ("use Nano Banana", "Sunburst", "Seedream"), pass it as `model`: a name, an id or a
  `provider/model` selector all work. A named model does not silently fall back; if it fails, say why and offer the
  next one, or pass `fallback: true` when the person said any model will do.
- Unsure what is available, or the name is ambiguous: call `image_models` and pick from what it lists.

## Writing the prompt

Describe the picture, not the conversation: subject, what it is doing, setting, style or medium, lighting, framing,
and any exact text in quotes. Put hard constraints plainly ("no text", "plain white background", "keep the logo
exactly as given"). For an edit, say what changes and what must stay the same.

## Transparency

- A subject that should float on nothing (icon, sticker, product shot): `image_generate` with
  `background: "transparent"` and `format: "png"` or `"webp"`. Only models that draw alpha are tried.
- An existing picture on a **flat** background: `image_process` with `cutout` (it samples the corner colour), then
  `trim`. Free, local, exact.
- An existing **photo** background: `image_generate` with the photo in `images`, `background: "transparent"`, and a
  prompt like "isolate the subject on a transparent background, keep it unchanged".

## Masked edits

1. `image_mask` for the picture: the shapes you give become the area to repaint (`invert` flips it, `feather` softens
   the edge). Fractions (0-1) are easiest when you only know roughly where something is.
2. `image_generate` with `images: [picture]`, `mask: <the mask>` and a prompt that describes the WHOLE result, not
   only the patch. Only models that take a mask are tried.

## After it lands

The pictures appear in the thread; a click opens them in the Viewer, where the person can mark them up and send
notes back. You also get a small preview of each; look at it before claiming the picture shows what was asked.
Report the model that actually ran (the result names it; a fallback may have drawn it) and the cost when given.
