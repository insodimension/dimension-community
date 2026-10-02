# Provenance — Face to face

## What ships

`assets/head-f01.bin` and `assets/head-m01.bin` are **derived works of two Microsoft Rocketbox avatars**
(MIT). Each file holds ~9k dot positions, normals, palette-mapped colours and the 52 ARKit morph-target deltas,
sampled from the head mesh and head albedo of one avatar. Neither the FBX meshes nor the source textures
ship; only the sampled, quantised dots do. `src/` is this pack's own code (MIT, `LICENSE`).

## Source

| | |
|---|---|
| Library | Microsoft Rocketbox Avatar Library — https://github.com/microsoft/Microsoft-Rocketbox |
| Pinned commit | [`0943055db6ec570bcef9f2c8b41c9e5467c808f9`](https://github.com/microsoft/Microsoft-Rocketbox/tree/0943055db6ec570bcef9f2c8b41c9e5467c808f9) (`master`, 2022-10-02T19:20:56Z) |
| `head-f01.bin` mesh | `Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01_facial.fbx` |
| `head-f01.bin` albedo | `Assets/Avatars/Adults/Female_Adult_01/Textures/f001_head_color.tga` |
| `head-m01.bin` mesh | `Assets/Avatars/Adults/Male_Adult_01/Export/Male_Adult_01_facial.fbx` |
| `head-m01.bin` albedo | `Assets/Avatars/Adults/Male_Adult_01/Textures/m002_head_color.tga` |
| Licence | MIT, "Copyright (c) 2020 Microsoft" — `LICENSE.md` at the pinned commit; README: "The library of avatars is now released under MIT License." |

### Microsoft Rocketbox licence (must ship with derivatives)

```
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

If Rocketbox is cited academically, the library's README asks for: Gonzalez-Franco et al., "The Rocketbox
library and the utility of freely available rigged avatars", Frontiers in Virtual Reality,
DOI 10.3389/frvir.2020.561558.

## Morph-target mapping (verified, not guessed)

Rocketbox README, 6/2022 update: "Release of ARkit compatible blendshapes. Contribution by Fang Ma and
Matias Volonte". The facial FBX carries them as shape keys named `AK_<nn>_<ARKitName>` (52 of them) and
the Oculus visemes as `AA_VI_<nn>_<name>` (15). Both lists were read directly from the imported FBX in
Blender 5.0.1 (the key names in `Female_Adult_01_facial.fbx`), and the same names are the file names of the
authoring deltas in the companion Headbox repo — https://github.com/openVRlab/Headbox at commit
`63a3a61c84ca14f32f6ecd452fdb77861a11435d`, `Maya/DeltaValues/AK_01_BrowDownLeft.json … AK_52_TongueOut.json`
and `AA_VI_00_Sil.json … AA_VI_14_U.json`. Headbox README: "We have created a total of 15 visemes, 48 FACS,
30 for the Vive facial tracker and 52 ARKit blendshapes. These blendshapes have been released with the
original library."

The 52 `AK_` keys read from the FBX run in ARKit's alphabetical order (AK_01 = BrowDownLeft … AK_52 = TongueOut),
and the name after the index is the ARKit name; the bake maps by NAME, never by index (`.scratch/face2/bake/shapes.json`).
Every one of the 52 morphs is baked under its ARKit name and the runtime uses the ARKit names verbatim:
`src/face/shapes.ts` (`ARKIT_52`, alphabetical) is the pose-vector layout shared with the engine's audio-to-face
model (`myned-ai/wav2arkit_cpu`, which emits exactly these 52 weights, streamed as `face` speech events) and with
the procedural fallback, so slot *i* of the asset is pose index *i*. The Oculus `AA_VI_` viseme keys are not baked:
the procedural lip-sync projects its visemes onto ARKit shapes (`VISEME_RIG` in `src/face/lipsync.ts`).
How far a weight of 1.0 moves each shape on this head is the single rig table `RIG` in `src/face/shapes.ts`
(empty = the deltas as authored).

## How the assets were made (authoring time, not shipped)

`.scratch/face2/bake/` (kept out of the pack): `fetch.ts` downloads the pinned sources;
`extract.py` (Blender 5.0.1 headless) imports the FBX, drops the armature, applies Catmull-Clark level 2
to the head material with each wanted shape key at 1.0, and dumps positions / normals / UVs / per-shape
deltas; `bake.ts` slices the head into horizontal rows at equal arc length (rows curve around skull,
cheeks and chin, phase-locked to the face midline), samples the albedo at each dot, remaps it to the
reference palette (luminance to a neutral grey ramp, a rose tint on crown and temples, strong redness to soft
coral), stores morph deltas per dot as int8 with a per-shape scale, and deflates the result.

## Fallback not used

The CC0 `mpfb.glb` fallback from met4citizen/TalkingHead was not needed: Rocketbox imported cleanly in
Blender 5.0.1 and carries all 52 ARKit + 15 viseme targets.
