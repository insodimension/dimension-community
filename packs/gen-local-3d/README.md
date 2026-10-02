# Local image-to-3D

## What it is

Image-to-3D that runs on this machine's GPU, with no account, no key and no cost per model. The agent
hands it one picture of an object with its background already removed, and it runs the model through
pixal3d.cpp's `trellis-cli` and returns a textured `glb`. It is a connector for the engine's
`generation` jobs; it adds no tool of its own. Nothing is sent anywhere.

## What it contains

- **A `generation` provider, id `local-3d`.** It produces `model3d` and runs locally
  (`runtime: "local"`): a job is the `trellis-cli` process, started into its own work folder, with
  progress read from the `[n/N]` stage banners it prints.
- **Two models**, listed in `models.json`:
  - `pixal3d-sv`, Pixal3D single view (Q8_0), whose weights live in the `pixal3d-sv/` folder;
  - `trellis2-4b-q8`, TRELLIS.2-4B (Q8_0 GGUF), whose weights live in the `trellis2-gguf/q8/` folder.
  Both take the options `texture`, `atlas`, `gss` and `gsh`; Pixal3D also takes `fov`. A model whose
  weights folder is missing or incomplete is not offered.
- **Defaults measured in the lab**: `gss` 10, field of view 20 degrees, 1024, seed 42.
- **Input needs, as catalogue `features`**: both models carry `input:cutout` (they take only a PNG with a really
  transparent backdrop; see Limits). A caller that prepares images for a model reads this tag from the catalogue
  instead of knowing the model. Neither carries `input:square`: nothing here asks for a square canvas.
- **Output**: the model as `raw.glb` plus its base-colour atlas, `raw_base.png`.

No tools, skills, rules or components.

## Who can use it

Off by default (`defaultEnabled: false`); switch it on, then open its Connect form and give it two paths,
not secrets: the full path of the `trellis-cli` executable, and the models folder that holds one
subfolder of weights per model. They are kept on this machine at
`~/.config/dimension-gen-local-3d/config.json`. It is global: it declares no `spaces`, so once on it
loads in every space. It needs pixal3d.cpp built or downloaded with its folder kept together, since
`trellis-cli.exe` needs the CUDA and ggml DLLs beside it.

## Limits and risks

- **It costs nothing to ask, and a lot of GPU to run.** The quote is $0, so the spend caps
  (`generation.maxUsdPerJob`, `generation.maxUsdPerDay`) never stop it. A job holds the GPU for minutes:
  measured on an RTX 4080 SUPER, Pixal3D took 219 s for a prop and 581 s for a character, and TRELLIS.2
  took 155 s and 526 s. The engine lets only one local job run at a time across all local providers;
  the rest wait in line.
- **It will not cut your picture out for you.** One PNG per job, absolute path, background already
  removed. The pack reads the alpha channel and refuses a PNG that cuts nothing out, because
  `trellis-cli` would build the backdrop as geometry. Making the cutout is a separate step.
- **Pixal3D is prototype-only.** Its weights' commercial terms are disputed upstream (TencentARC/Pixal3D
  issue 33) and its DINOv3 encoder is under Meta's DINOv3 License, which has not been legally reviewed.
  Its commercial use is recorded as `unknown`, and a release export is blocked.
- **TRELLIS.2 is MIT, but not yet cleared to ship.** The bundled `dinov3.gguf` encoder has the same
  unreviewed DINOv3 License; the owner and legal must clear it before an asset ships.
- **Stopping a job kills only that job's process.** Cancel and abort kill the one `trellis-cli` process
  tree the pack started, and return only once it is gone.
- **It reads GPU memory.** While a job runs it samples the machine's total GPU memory in use through
  `nvidia-smi`, for the asset's provenance. The figure includes other programs on the GPU, so it is an
  upper bound.

## Build and test

There is no build step: the engine loads `index.ts` as it is. The tests run a fake `trellis-cli` that
prints the stage banners, writes the files, fails or hangs as a file beside it says, so they need no
GPU and no weights. From the Dimension repository root:

```sh
bun test marketplace/packs/gen-local-3d/test
```
