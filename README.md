# dimension-community

**Dimension Community** — the public shelf for the **Dimension** platform: community components,
layouts, instruments and spaces.

Dimension's UI is assembled from **slots**. The slot set is **open and
layout-owned** (doc 68 §4.1): a layout plugin declares its own slots;
well-known names (`rail · dock · workspace · thread · composer · mark`) are
platform-published *conventions*, not a closed law. This repository is where
the fillings live: anyone can ship a rail, a mark, a dock instrument, a
layout, or a whole space, and Dimension installs it as a plugin.

## What lives here

```
packs/
  build/          A LAYOUT declaring its own slots (ca-switcher / ca-rail /
                  ca-workspace / ca-dock), shipping the Build space — the Code
                  space rebuilt entirely from marketplace packs.
  mochi-mark/     A mark component: the import-surface FLOOR (react only).
  pulse-mark/     The Store's demo mark: zero Fraym UI, one granted binding.
  artifactory-threejs/
                  An ARTIFACTORY — an MCP App, the reference three.js server
                  from modelcontextprotocol/ext-apps, byte-for-byte. Packaging
                  only: `.mcp.json` names the server, `dimension.plugin.json`
                  says `artifactories: [{ mcpServer }]`. Rendered live in the
                  artifact-view seat 2026-09-07.
  artifactory-system-monitor/
                  The second artifactory pilot: an app-only tool the model never
                  sees, called from the View through the engine's consent gate.
  ban-comments/   A RULES-ONLY pack: `plugin.json` + `rules/*.md` (one per language),
                  no code. A stream rule (TTSR) that interrupts an edit/write
                  the moment it adds a code comment.
.dimension-plugin/
  marketplace.json  The catalog Dimension's plugin system reads — GENERATED
                    from the packs by `scripts/build-index.ts` (see below).
```

Each pack declares itself in ONE file — `dimension.plugin.json` — validated by
the engine at plugin load with the same pure validators `@dimension/sdk`
re-exports (`validateComponentDecl`, `validateLayoutDef`,
`validateSpaceDefs`). The full authoring walkthrough
lives in the Dimension repository: `docs/guides/building-a-custom-space.md`.

## The three tiers, by import surface

| Tier | Import surface | Worked example |
|---|---|---|
| **Zero-import floor** | `react` only — the Store arrives as a prop/context value; styling on the host's `--fr-*` custom properties | `pulse-mark` |
| **In-tree** | `react` + enumerated `@fraym/ui` VALUES (each one a permanent capability grant, settled per component) | `independent-composer` · `independent-thread` (granted PARTS + bricks) |
| **Sandboxed** | zero imports — the wire is MCP Apps (`io.modelcontextprotocol/ui`), the platform's Phase 4; a pack is a real MCP server plus a `ui://` View, and the engine hosts it | `artifactory-threejs` · `artifactory-system-monitor` (both `defaultEnabled: false`) |

## How a pack gets in

1. **Declare it.** `dimension.plugin.json` with `"type": "component"` (+ `slot`)
   or `"type": "layout"` (+ `slots`) or `spaces` — or, for an MCP App,
   `artifactories: [{ mcpServer }]` naming a server in the pack's `.mcp.json`.
2. **Build against the published surface.** Facts come from the Store's
   published key table (`catalogue.json` in the Dimension repo — typed via
   `readFact`/`watchFact`); pixels are yours, drawn on `--fr-*` design tokens
   (house rule: tokens only, color-is-meaning stays the host's).
3. **Pass the gates.** The engine's decl validation (a manifest test in the
   monorepo pins it), your pack's own tests, and — for well-known slots — the
   conformance suite (`mountForTest` + per-slot fixtures from `@fraym/ui`).
   For a section that claims parity with a shipped surface, the gate is a live
   structural + behavioral comparison against it, not a self-written test.
4. Open a PR adding your pack under `packs/`, then run `bun scripts/build-index.ts`
   to regenerate the catalog and commit it too. Review + green gates = merged =
   published.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## The catalog is generated, and it is all a client fetches

`.dimension-plugin/marketplace.json` is a **derived index** — never hand-edited.
`bun scripts/build-index.ts` walks `packs/*/` and writes one entry per pack from
that pack's own files (`package.json` for version/description/author/license/
category/tags, `dimension.plugin.json` for `pluginId`/`title`/`icon`/`requires`
and the `spaces[]` listings, with asset paths rewritten catalog-root-relative,
plus a `generalAgents[]` listing from each `general-agents/<name>/agent.md`).
It writes the same bytes to `.omp-plugin/marketplace.json`, the read path every
Dimension built before oh-my-pi #158 uses. `bun scripts/build-index.ts --check`
is a CI gate: a pack edited without regenerating fails the build, so the shelf
always describes the packs that are actually committed. Want different card
copy? Edit the pack, not the index.

This is what makes browsing cheap: a client fetches the **index only** — KBs at
any pack count — and paints every card from it (title, icon, version, screenshots,
the minimum Dimension the pack needs). The pack tree is fetched only for the one
pack someone installs. Nobody clones the mall.

### `requires.dimension`

A pack that needs a platform capability declares the minimum Dimension it runs
on, top-level in its `dimension.plugin.json`:

```json
{ "plugin": "build", "requires": { "dimension": ">=0.10.5" } }
```

The generator lifts it into the pack's catalog entry, so the Store can say
"Requires Dimension ≥ 0.10.5 — update Dimension" on a card **before** anything is
downloaded, and the engine refuses install/load when the host is older. The value
is any semver range; it is matched against the Dimension PRODUCT version by the
engine and the plugin manager (`Bun.semver.satisfies`) — never by the UI. A host
whose version is unknown is never gated. Omit the field when your pack has no
floor; `packs/build` is the worked example (it pins the bundled `general-chat`
companion, which first ships in Dimension 0.10.5).

## General Agents

A pack may ship **General Agents** — the identity a session is opened as (a
space's marketing lead, say) — at `general-agents/<name>/agent.md`. They are
distinct from subagents, which stay in a pack's `agents/` under the open
standard. A space scopes its picker with `generalAgents.list`; users turn agents
on and off in Capabilities → General Agents. Start from `packs/example-agents`
and see [CONTRIBUTING.md](CONTRIBUTING.md#contribute-a-general-agent).

## Status and honesty

- A pack does NOT need the monorepo. `independent-composer` and
  `independent-thread` build from a bare directory with vite alone (verified by
  rebuilding one outside every repo: byte-identical bundle), because their whole
  outside world is the four externals their vite config declares — `react`,
  `react-dom`, `react/jsx-runtime`, `@fraym/ui` — which the HOST resolves at
  load time. Some older packs still take workspace dependencies and therefore
  build inside the Dimension checkout; that is their limitation, not the
  contract's.
- The **artifactory** contribution kind was **retired 2026-09-02** (the old
  lane never worked and was deleted) and **returned 2026-09-06/07 as an MCP
  App on the open standard** — nothing bespoke: a plugin names which of its
  `.mcp.json` servers the engine hosts (`artifactories: [{ mcpServer, label?,
  icon? }]`), the engine spawns it once, reads the `ui://` View in-band, lends
  the tools to every ACP harness through a proxy, and renders the View in the
  `artifact-view` seat. The two packs above are the sandboxed tier's first
  members; a stranger's App from the ext-apps repo runs here unmodified. What
  is not built yet: a seat bound in a layout at boot (slice D) and a proof under
  a harness other than OMP.
- Runtime installation of UI component packs WORKS: a pack ships a committed
  `dist/` bundle, the app installs it from a marketplace source, and the loader
  resolves its imports through the host externals contract. `@dimension/sdk`
  is still workspace-private until the publish lane lands; type declarations
  for the granted surface are generated by `fraym/packages/ui`'s
  `emit-contract-types.ts` if you want them vendored.

## Using the marketplace

From a Dimension session:

```
plugins op:add-marketplace name:dimension-community source:insodimension/dimension-community
plugins op:catalog marketplace:dimension-community
plugins op:install name:independent-thread marketplace:dimension-community
```
