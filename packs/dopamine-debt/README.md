# Dopamine Debt

## What it is

The Dopamine Debt kit: a short style guide, a Filmmaker General Agent and a film kit for deadpan, meme-led
comedy explainer films about your own channel's subject. The skills are guidance any agent may read; nothing
in them holds a film, loops or waits on a reviewer. The person's notes on the render are the review. The
house gate (`inso dd gate`) is an optional score. It is an optional pack in the Community store: no space
requires it.

## What it contains

- **General Agent `filmmaker`**: makes a film in a production's room and shows it early. On by default; it
  appears where a space lists it.
- **Skills** `dopamine-debt-film` (the style guide: voice, jokes, memes, pictures, sound, and turning notes
  into fixes), `kit-film` (building and rendering with the film kit) and `filmmaker-core` (a short pointer
  to both, loaded by the Filmmaker).
- **CLI `inso dd`**:
  - `inso dd setup <brand folder>` writes the brand's `productions/house-gates.json`, whose gate runs
    `inso dd gate`, so an update of the kit never breaks it. An entry written by an earlier kit (one that
    ran `gate/launch.ts`) is replaced, and setup says so.
  - `inso dd gate <script|cut> <production> <report>` runs the house gate.
  - `inso dd new-film <production>` writes a film's build files; they find the kit each time they run.
  - `inso dd import <earlier kit folder> <brand folder>` carries a music ledger, review marks and personas
    from an earlier copy of the kit into the brand's folder.
  - `inso dd root` prints the installed kit's folder.
- **The engine and data**: the Python engine (`dd/`, `framework/` and its film kit), a starting channel
  persona for an AI-news audience, `taste.json` (the house rules), `tunables.json` (the gate's constants)
  and an empty `music.json`.

## Who can use it

Anyone with Dimension 0.12.0 or newer who installs it from the Community store; no space installs it for
you. Its skills and its Filmmaker load only in Video, Code and Unreal sessions, and its Filmmaker appears
only where a space lists it. It needs:

- Python 3.10 or newer on `PATH`, or `DD_PYTHON` set to one, with the packages in `requirements.txt`
  (`python -m pip install -r <folder>/requirements.txt`, where `inso dd root` prints the folder).
  `inso dd gate` exits 2 and names what is missing.
- `ffmpeg`, a headless Chrome or Edge, `npx hyperframes`, and the Motion pack's setup (it installs GSAP)
  for the picture and the render.
- The `inso` command, which Dimension's installer puts on `PATH`. It runs the gate, which calls no model;
  there is nothing else to install.

## Limits and risks

- **What it reads and writes:** the production folder it is given; the brand's `productions/` folder
  (`house-gates.json`) and its `productions/dopamine-debt/` folder, where everything you make for the kit
  lives (films, research, your personas, `music.json`, `calibration/marks.jsonl`); the shared media
  library; and a speech-recognition cache in `<engine home>/productions/dopamine-debt/`. It never writes
  into its own folder, which an update replaces.
- **What it sends over the network:** when you run the optional score, the script and transcript text of
  the film's reads, to the models your session answers them with (your `judge` role, and the juror role you
  pick); `npx -y hyperframes@0.8.217` downloads HyperFrames from npm on the first render;
  faster-whisper downloads its `small.en` model from Hugging Face on first use; media fetches go to
  YouTube through `yt-dlp` (only for http(s) addresses you or the agent chose). Voice and music
  generation go through Dimension's media generation tools, priced and approved before each spend.
- The optional score spends model tokens in your session, on the roles of the active profile. The gate
  itself spends none; its report's `answered_by` names every model that answered the reads.
- It does not install its Python packages, ffmpeg or a browser for you.
- The house rules come from one channel's films and one reviewer's taste; your brand gets the same bar
  until your own notes and marks move it.
- The starting channel persona is a proxy for an AI-news audience, built from public comment counts and
  summarised in our own words. Build your own channel persona once your films have viewers.
- It ships no calibration films or research corpus. Calibrating the score (`FRAMEWORK.md` §11) reads your
  own films, kept in your brand's `productions/dopamine-debt/calibration/`.

## Build and test

No build step: the host loads the CLI's TypeScript as it is, and it imports only modules the host
provides. The engine is Python. Its unit tests live in `tests/`: `python -m pytest tests` in this folder
(`bun run test`), with the packages in `requirements.txt` and `pytest`. `bun run check:types` typechecks
the CLI from a Dimension monorepo checkout. The calibration films the gate was fitted on are not in this
repository.
