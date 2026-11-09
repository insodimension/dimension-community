# Dopamine Debt

## What it is

The Dopamine Debt kit: the framework, the Filmmaker General Agent and the film kit behind Dry Run's
comedy explainer films. It takes a film from audience research through spine, joke map, script, voice,
picture and cut to a render, and holds every stage to the house gate (`dd gate`) before the next one starts.
The Video space installs it for you; it is not meant to be used on its own.

## What it contains

- **General Agent `filmmaker`**: makes a Dry Run film end to end in a Video production's room. On by
  default; the Video space lists it in its agent picker.
- **Skills** `filmmaker-core` (the order of work, loaded by the Filmmaker), `dopamine-debt-film` (the
  framework, research to approved render, and turning review notes into rules) and `kit-film` (building
  the picture with the film kit).
- **CLI `dd`**: `dd gate <script|cut> <production> <report>` runs the house gate,
  `dd setup <brand>` writes the brand's `productions/house-gates.json`, and
  `dd new-film <production>` writes a film's build files.
- **The engine and data**: the Python engine (`dd/`, `framework/` and its film kit), the Dry Run channel
  persona and two topic personas, calibration ledgers, `taste.json`, `tunables.json` and `music.json`
  (the approved music beds).

## Who can use it

Anyone on either release ring who has the Video space; installing Video installs this pack. Its Filmmaker
appears only where a space lists it (Video does). It needs:

- Python 3 on `PATH`, or `DD_PYTHON` set to one, with the packages in `requirements.txt`
  (`pip install -r requirements.txt` in this plugin's folder). `dd gate` exits 2 and names what is missing.
- `ffmpeg`, a headless Chrome or Edge, and `npx hyperframes` for the picture and the render.
- A Dimension CLI (`inso` or `omp`) on `PATH`, which hosts the gate's judge model.

## Limits and risks

- The gate judges with a model, so a gate run spends model tokens; `dd gate` reports which model answered.
- It reads and writes only inside the production folder it is given, the brand's `productions/` folder
  (`dd setup`), and its own folder (`music.json` approvals, caches). An update of the pack replaces its
  own folder, so an approval recorded in `music.json` lasts until the next update.
- It does not install its Python packages, ffmpeg or a browser for you.
- The house rules are tuned to Dry Run's films and one reviewer's taste; other brands get the same bar.
- This pack does not ship the research corpus, the calibration films (frames, stems, saved pages) or the
  analogy calibration ledger: they hold third-party comments and media. The skills' Calibrate step needs
  that data on your own machine, under `calibration/targets/`, `calibration/failures/` and
  `personas/evidence/` in this plugin's folder.

## Build and test

No build step: the CLI is TypeScript run by the host, the engine is Python. The tests live in the kit's
source repository, beside the calibration data they read; they are not shipped.
