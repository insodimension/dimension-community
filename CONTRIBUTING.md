# Contributing a pack

Approval model: **a PR is the submission, the conformance suite is the bar,
review is the taste check.** No pack merges red.

## The pipeline

1. **Read the guide.** The end-to-end walkthrough (contracts, scaffolding,
   partition of concerns, conformance, registration) is maintained in the
   Dimension repository as `docs/guides/building-a-custom-space.md`. Start
   there; this file only adds the marketplace mechanics.
2. **Scaffold your pack** under `packs/<your-pack>/` mirroring
   `packs/independent-thread/`: `package.json` (name it under your own npm
   scope) with a `dimension` block, `dimension.plugin.json`, `src/`, `vite.config.ts`
   declaring the four granted externals, and a committed `dist/`. That pack
   builds byte-identically from a bare directory with vite and nothing else —
   copy it if you want your pack to stay portable. If you instead need in-repo
   typechecking, add a `tsconfig.json` and be aware it couples your pack to the
   monorepo layout.
   Give it a `README.md` at the pack root: CI fails a new pack without one, and the
   five headings are under [Document it: README.md](https://github.com/insodimension/dimension/blob/main/docs/plugins/authoring.md#document-it-readmemd)
   in the Dimension repository.
3. **Implement against the contract, not beside it.** Your component receives
   everything through props (data in) and speaks only ShellIntents (intents
   out). It holds no session state and talks to no engine. If you find
   yourself needing a capability the contract lacks, that is a FINDING: open
   an issue naming it.
4. **Prove it.** For pure logic, tests in-pack (`packs/reddit/test/`
   is the shape; run from the Dimension monorepo if your pack takes workspace
   deps). For a slot fill claiming parity with a shipped surface, the gate is a
   live structural + behavioral comparison against that surface — the portable
   template ships no test directory precisely because its gate is that
   comparison, not a self-written assertion.
5. **Regenerate the catalog.** You do NOT hand-write your entry:
   `.dimension-plugin/marketplace.json` is generated from the packs on disk.

   ```sh
   bun scripts/build-index.ts
   ```

   It writes one entry per `packs/*/` from that pack's own files, and writes the
   same bytes to `.omp-plugin/marketplace.json` (the path pre-#158 clients read).
   Commit both. CI runs `bun scripts/build-index.ts --check` and **refuses
   drift**, so a pack edited without regenerating fails the build. Wrong copy on
   your card? Fix the pack, not the index:

   | Catalog field | Comes from |
   |---|---|
   | `name` | your pack's directory name |
   | `source` | your pack's release build: `{ "source": "release", "url", "sha256", "size" }` (see "How your pack becomes a release build" below) |
   | `pluginId` · `title` · `icon` · `requires` · `spaces` · `providers` | `dimension.plugin.json` |
   | `description` | `plugin.json` top-level `description`, else `package.json`'s top-level one. This is your store copy: plain words, one or two short sentences on what the pack does for the person. The Dimension monorepo's `--words` gate refuses doc numbers, tool or op names, backticks, file names, config keys and internal terms. |
   | `category` · `tags` | `package.json` → `dimension` block (`category`, `keywords`), else its top-level fields |
   | `version` · `author` · `license` · `repository` | `package.json` (license/repository default to this repo's) |

   Each space's listing carries its `showcase` (`tagline`, `summary`,
   `screenshots`, `video { src, poster? }`, `needs`, `onboarding`), copied
   from the space's own `showcase` declaration and from nothing else — a
   space's `preview` block and `description` never reach the listing. That
   block is what the Spaces tab shows on the space's details page before
   anyone installs it. `icon` and every showcase screenshot, video and
   poster are rewritten catalog-root-relative (`assets/icon.svg` →
   `packs/<you>/assets/icon.svg`) and must exist as real files in the shelf —
   a screenshot you deleted fails the generator by name, and a symlink is
   refused. Screenshots are `.png`, `.webp`, `.jpg`, `.jpeg` or `.svg` (at
   most 8); the video is `.mp4` or `.webm` under 48 MiB. A bare glyph name
   (`"icon": "hammer"`) is passed through untouched.

   A space built in its maker's own repository is listed without code: its
   entry's `source` is `{ "source": "release", "url", "sha256", "size" }`
   pinning the built archive, its media sit under `packs/<space>/`, and
   `dimension-space list` writes it. Such a listing must carry
   `showcase.summary`, at least one screenshot and a video.

   A pack that adds a voice or a generator says so in its manifest, under
   `extensions["ai.insodimension.dimension"].providers`, and the generator
   copies it onto the entry as `providers` so the Connections page can list and
   filter the pack before anyone installs it. Only two kinds are carried:
   `speech` (`{ id, speak?, listen?, converse?, onDevice? }`) and `generation`
   (`{ id, produces, runtime? }`, where `produces` is a non-empty list of
   `video`, `voice`, `music`, `sfx`, `image`, `model3d`, `parts`, `rig`,
   `retopo`, `texture`). A modality outside that list, a provider with no `id`,
   or a flag that is not `true`/`false` fails the generator by name, and
   `validate-marketplace.mjs` refuses a catalog whose `providers` differ from
   the pack's manifest.
6. **Declare a platform floor if you need one.** A pack that requires a recent
   Dimension says so top-level in `dimension.plugin.json`:

   ```json
   { "requires": { "dimension": ">=0.9.89" } }
   ```

   The generator lifts it into your catalog entry, so the Store gates your card
   ("Requires Dimension ≥ X — update Dimension") and the engine refuses install
   and load on an older host — matched against the Dimension PRODUCT version with
   `Bun.semver.satisfies`, never parsed by the UI. Omit it when your pack has no
   floor; an unparseable range fails validation.
7. **Open the PR.** CI validates the catalog and pack layout and refuses index
   drift; the monorepo CI runs your tests; a maintainer reviews for craft
   (design-token discipline, honest empty states, reduced-motion safety).

Browsing this shelf costs ONE fetch: a client reads the index and paints every
card from it, then downloads only the pack it installs, as that pack's own
release build. That is why every browse fact has to live in the index — and
why the index has to be generated.

## How your pack becomes a release build

Nobody installs your pack from this repository's tree. A person who installs
it downloads one archive, `<name>-<version>.tgz`, from this repository's
GitHub Releases (tag `<name>-v<version>`), and Dimension refuses it unless its
sha256 and size are the ones your catalog entry pins.

- **What is in it.** Every file under `packs/<name>/` that git would commit:
  tracked files and new files that are not ignored. Ignored files
  (`node_modules/`, `.venv/`, caches) never ship. Text files carry the line
  endings git stores (LF), so the archive is the same on Windows, macOS and
  Linux. Everything sits under one top directory `<name>/`, sorted, with no
  timestamps or owners, so the same files always give the same bytes. A
  symlink or a nested repository fails the build by name.
- **You build it by regenerating the catalog.** Run `bun install` once (it
  installs the shelf's one dev dependency, `fflate`, pinned exactly in
  `package.json` and `bun.lock`), then `bun scripts/build-index.ts` builds every
  pack's archive in memory and writes its `sha256` and `size` into the entry.
  The archive is compressed by that pinned pure-JS `fflate`, not by bun's own
  zlib, so any bun version gives the bytes CI gives. To look inside your
  archive, `bun scripts/pack-archive.mjs <out-dir> <name>` writes it to disk.
- **Builds are never committed.** No `.tgz` belongs in this repository; the
  catalog holds only the hash and size.
- **Every change is a new version.** A published build is never replaced. Any
  change to a file under `packs/<name>/`, tests included, needs a version bump
  (`check-version-bumps.mjs` refuses one without), which gives it a new tag
  and a new archive.
- **CI publishes it after merge.** On every push to `main`, once the
  `validate` job is green, the `publish-releases` job reads the catalog and,
  for each entry whose release asset does not exist yet, builds the archive
  from the merged commit, checks it is byte for byte the one the catalog pins,
  creates the release at that commit and uploads it. An asset that already
  exists is checked, never overwritten: if its bytes differ from the catalog,
  the job fails and names the pack. A maintainer can run the workflow on
  `main` by hand (Actions, ci, Run workflow) to publish again after a failure.
- **The window.** From the merge until that job finishes (normally a minute
  or two), the catalog on `main` already names your new version but its
  archive is not uploaded yet, so an install in that window fails with
  HTTP 404 and works on retry. Nothing else changes for anyone: people on the
  previous version keep it.
- **Older Dimension.** Release builds need Dimension 0.11.27 or newer. Older
  versions skip every release entry when they read the catalog, so they see
  an empty Community shelf: packs already installed keep working, but get no
  update offers until the app is updated. The switch of this shelf to release
  builds merges only after Dimension 0.11.27 is released.

## Your first space

1. **Install the SDK.**

   ```sh
   npm i -D @dimension/sdk
   ```

   Honest status: `@dimension/sdk` is **not on npm yet** — the publish lane is
   built, but the publish itself is pending the owner's `npm login`, so that
   command 404s today. Until it lands, an author working inside the Dimension
   monorepo takes the workspace dependency instead:
   `"@dimension/sdk": "workspace:*"`.
2. **Copy a template.** `packs/build` is the LAYOUT template (it declares
   its own slots and ships the `build` space); `packs/mochi-mark` is the
   COMPONENT template (it fills one slot). `build` is a real product pack
   rather than a stripped example, so copy its `plugin` / `type` / `slots` /
   `spaces[]` shape and DROP what your space does not need: `preview`,
   `widgets`, `workspace.sections` / `workspace.startCopy` and
   `requires.dimension` are decoration, and five ids in its
   `requires.plugins` (`board`, `analytics`, `workbench`, `session-tools`,
   `general-chat`) are host-bundled plugins with no directory under `packs/`
   — do not go looking for them. A copy must edit, at minimum:
   - `package.json` — `name` and the `dimension` block (`name`, `category`,
     `keywords`); `omp` is the pre-rename spelling of the same block and is
     still read.
   - `plugin.json` — `description`: the store copy the generated catalog entry
     quotes and the plugin card shows. Write what the pack does for the person
     in plain words.
   - `dimension.plugin.json` — see below.
   - `src/index.ts` — for a component its **default** export is what the host
     loads as the component; `mochi-mark/src/index.ts` says so in a comment.
   - component packs only: `vite.config.ts` and the committed `dist/`.
3. **Fill in `dimension.plugin.json`.** Both real manifests share `plugin`
   (the id the host resolves), `contractVersion` (`1`), `title` and `type`.
   Then they diverge:
   - `"type": "component"` (mochi-mark) adds `entry` (`"dist/index.mjs"`) and
     `slot` (`"mark"`) — the slot contract it fills.
   - `"type": "layout"` (build) adds `slots`, each with an `id`
     (`"ca-switcher"`, `"ca-rail"`, `"ca-workspace"`, `"ca-dock"`) and a
     `contract` (`"switcher"`, `"rail"`, `"workspace"`, `"dock"`), plus an
     optional `items`.
   - A layout may also ship `spaces`, and an entry there IS the space:
     `specVersion`, `id`, `label`, `icon`, `order`, `description`, `mark`
     (`fill` / `accent` / `label`), `layout`, `components` (slot id → plugin
     id), `rail`, `workspace` (`surfaces`, `start`, `session`,
     `switchPolicy`), `generalAgents`, and `requires.plugins` — every plugin
     your space names in `components` or `mark.fill` belongs in that list.
4. **Regenerate and validate before you push.**

   ```sh
   bun scripts/build-index.ts
   bun scripts/validate-marketplace.mjs --check
   ```

   The first rewrites the index from the packs on disk (both catalog paths); the
   second checks the catalog and pack layout and refuses index drift — exactly
   what CI runs. Both must be green.
5. **Open the PR.** One pack per PR, against `main`. CI reruns both scripts;
   a maintainer reviews against the house rules below.

## Contribute a General Agent

A **General Agent** is the conversational identity a session is opened AS —
`coding`, `aether`, a space's marketing lead. It is NOT a subagent: a pack's
`agents/` directory stays the open subagent standard (what a `task` tool
spawns), and nothing there ever becomes a General Agent. The reference pack is
[`packs/example-agents`](packs/example-agents) — copy it.

1. **One directory per agent** at the pack root:
   `general-agents/<name>/agent.md`. Directory form only — a flat
   `general-agents/<name>.md` is refused. Siblings (an `AGENTS.md`, notes) may
   sit beside `agent.md`.
2. **Frontmatter.** Required: `name` (must equal the directory name),
   `description` (the picker and store copy) and `specVersion: 1`. Optional:
   `defaultEnabled: false` to ship it off until a user turns it on (the default
   is `true`), plus any agent-manifest section (`identity`, `workspace`, …).
   Never `autonomy.trigger` — a triggered agent is a Loop, not a General Agent.
   The body is the persona prompt.
3. **Scope it to a space.** A space claims its agents with
   `"generalAgents": { "list": ["<name>"], "default": "<name>" }`; only the
   listed agents appear in that space's picker, and a space-claimed agent never
   leaks into Code. `"list": "discoverable"` (or no declaration) offers every
   enabled agent no space has claimed, except `home`-policy residents such as
   Aether, which are reached through their own doors.
4. **Regenerate.** `bun scripts/build-index.ts` lists each agent on the pack's
   catalog entry as `generalAgents: [{ name, description, defaultEnabled }]`,
   and fails the build on any rule above.

Users enable and disable General Agents in **Capabilities → General Agents**.

## House rules that will come up in review

- Design tokens only (`--fr-*` variables / `fr-` utility classes). No raw hex.
- Color is meaning: reserve it for act-now states.
- Honest states: empty, loading and failure are part of the component.
- `prefers-reduced-motion` is not optional.
- No second copy of anything the platform already renders.

## Licensing

Each pack declares its own `license` in its `package.json`; the generated
catalog entry quotes it, defaulting to this repository's MIT when a pack states
none. A vendored pack keeps its upstream license (`packs/impeccable` is
Apache-2.0). The marketplace catalog itself is metadata.
