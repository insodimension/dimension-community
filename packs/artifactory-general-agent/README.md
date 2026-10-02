# General Agents

Every General Agent you can run, as cards with their real faces and their week
at a glance, and, one click in, each agent's whole profile: its face, voice, charter
and standing instructions, the skills, plugins, MCP servers and tools it may
use, its memory, home, models and safety, and whom it extends. Yours and your
project's are edited in place; a pack's agent reads the same and can be
extended into an agent of your own. The Machinist, in the dock beside the page,
can draft one for you to accept.

Status: an installable pack with two parts.

- **The page**: a host-rendered `workspace-surface` component (`page/`, built to
  `dist/index.mjs`), mounted on the Code space's `page` surface by the rail's
  General Agents entry. It paints with the host's own kit and the host's own
  faces, so plugin faces (Traction's X face) and Mochi skins show exactly as
  they do in the rail.
- **The server**: an MCP server the engine hosts (`src/`, built to
  `app/server.mjs`). The page calls its App-only tools through its seat; the
  Machinist calls its two model tools.

```sh
bun install          # from the Dimension monorepo: @dimension/sdk, @fraym/ui, @fraym/config and @fraym/vibr are workspace dependencies
bun run dev          # the design harness: http://localhost:5198 (GA_HARNESS_PORT to move it), fixture host, real kit and faces
bun run build        # app/server.mjs (esbuild) + dist/index.mjs (vite lib); both are committed
bun run check:types  # two programs: the page under the kit's compiler settings, the server under the engine's
bun run test         # the server's contracts, the page's rules, the KPI fold, the bundle against the kit grant
```

## The door

`railActions[general-agents]`: `target: page`, `surface: page`,
`component: general-agents-page`, `session.agent: machinist`. One click opens
the page full-width; the page's backing session is the Machinist's, and the
Machinist lives in the dock beside the page (the page's **Ask the Machinist**
button reveals it). The rail draws the entry only while the pack is enabled: it
ships `defaultEnabled: false`, so turn it on in Capabilities → Plugins.

The component (`components[general-agents-page]`, `slot: workspace-surface`,
export `GeneralAgentsPage`) is mounted in a seat with two grants:

| Grant | What it opens |
|---|---|
| `artifactory:call` | `store.call("callOwnServerTool", { tool, args })`: this pack's own server's App-only tools, answered with their structured result or refused with their own words |
| `agents:configure` | `store.call("configureGeneralAgent", { name, enabled?, listed? })`: the Capabilities page's two switches |

## What the page reads

All from the fenced Store the seat hands it, never from a driver:

| Fact | For |
|---|---|
| `agents/list` | the roster: title, face, tier, the two switches, capability counts, home id |
| `sessions/list` | activity, folded ONCE per page (coalesced to one read per 250 ms): sessions in 7 days, last active, working or waiting on you, rooms led |
| `agents/usage` | tokens and cost in 7 days |
| `capabilities/catalog` | the marks and names of every plugin, skill, MCP server and tool |
| `models` | the model cards of the Brain section |
| `speech/profiles` | the voice profiles visible from the project, each provider's readiness, and the default (the voice lane's public fact) |
| `speech/agents` | each agent's RESOLVED voice (`name`, `source`, `why`, and which layers set one), computed by the engine |

Faces come as fill props (`agentPresences`, `bridgedPresences`) and resolve
through the kit's `agentPresenceFace`; every face is still until its card or
tile is pointed at or focused, and mounts only near the viewport.

Voice comes from the voice lane (docs "Speech and voice profiles" and "Voice mode"), through two more fill props
under `voice`: `sampler` (hear a profile; one speaker at a time, app-wide) and `assigner` (write
`voice.agents.<agent>` at user or project scope). The page never works out which profile wins: the
engine says (`speech/agents`) and the page labels it. A build without a door leaves it absent, and the
control that would use it says so; a build without `speech/profiles` shows "no voice engine" and nothing else changes.

The KPI rules (`page/kpis.ts`): a row belongs to its `profile`, a row with none
to the Code space's default agent (`coding`); a session is a non-room,
unarchived row an autonomy did not start; a handoff chain (`continuedFrom` /
`continuedInto`) counts once, as its live end; rooms count for their live lead,
never for membership.

## The page

**Home.** A hero band (name, what the page is for, **Create agent**, **Ask the
Machinist**, and the roster's pulse: working now, agents, cost in 7 days),
the Machinist's undecided proposals, facet pills (All, Yours, This project, From
packs, Off), then the agents as cards grouped by where they come from. Each card
follows the Autonomy card: the face on its accent wash, the name with its tier
and a live badge (Working, Needs you), two lines of what it is for, the Enabled
switch (yours and your project's; a pack's agent shows its state), what it may
use as the Capabilities page's own marks, where it stands (Last active · 3h ago,
or Never used, with a small voice chip beside it when somebody chose the agent's voice,
never for the default), and its week: Sessions 7d, Tokens 7d, Cost 7d, Rooms led.

**Profile.** A header with the agent's face at hero size (it moves when pointed
at), its title, tier, live badge, lineage and the Enabled and Show in rail
switches, and the one action it offers: **Save**, **Create agent**, or, for a
pack's agent, **Extend as a new agent** (a new agent with `extends: [<it>]`,
prefilled with its settings). Under it the vitals strip: sessions, tokens and
cost in 7 days, last active, rooms led, home. Then the sections, each drawn as
the thing it is:

| Section | Drawn as |
|---|---|
| Identity | name and line; a face gallery (every first-party vibr and every contributed face the host lends); personality and how it speaks as choice cards |
| Voice | the voice it speaks with now and why (with a play button); who decides, as a ladder (this project, you, the agent's own file, default), the in-use row marked; every voice profile as a card with its fallback chain, the layer it comes from and what is in the way, each playable before you choose. A pick at *this project* or *you* applies at once; a pick at *the agent's own file* is part of Save. Pack agents get the first two. |
| Charter | an editor under the `agent.md` file card |
| Standing instructions | the in-force `AGENTS.md` as a file card, every candidate tier as a chip, and an editor for the file a save writes |
| Capabilities | Skills, Plugins, MCP and Tools tabs; each a searchable grid of mark cards, checked for its allowlist, with *Every X* as its own state |
| Memory | what it reads as connected tiles (this project, its home, shared notes, other projects), the engine as choice cards, and the recall switch |
| Home | its folder card: id, path, whether it works there, its `AGENTS.md` |
| Brain | the model stack as model cards (ordered, first available wins) and thinking as a stepped meter |
| Safety | approval and where it runs as choice cards, session lanes as toggle chips |
| Lineage | the agents it extends, as agent cards |
| Advanced | Other settings (every key the profile does not draw, as YAML) beside the exact `agent.md` a save writes |

Keys that grant (tools, plugins, MCP, approval, where it runs, recall reach,
session lanes) carry the lock: only a human sets them. One sticky save bar
appears while anything is unsaved, names what it will write, and states the
first thing standing in the way; the server's own verdict (`validate_agent`)
shows inline as you type.

**The Machinist's proposals.** `forge_propose` stores a draft on the server,
stamped with the workspace its session was bound to (`forge_open`); the page
reads the undecided ones for its own workspace (`pending_proposals`, plus any
made with no workspace) and shows them as *Proposed by the Machinist*, on the
home and on the agent's profile, with the fields it set marked. A proposal made
in one project never reaches another project's page. Accept keeps them in the
draft (nothing is written until you save); Discard restores the profile as it
was. Either way the page tells the server (`dismiss_proposal`). Leave a profile
without deciding and the proposal is back on the home. A new, unnamed agent
takes one proposal; the next waits on the home.

## Tiers: where an agent lives

| Tier | Path | Home | On this page |
|---|---|---|---|
| **pack** | `<pack>/general-agents/<name>/agent.md` | yes (`home-<name>`) | read-only; *Extend as a new agent* |
| **user** ("Yours") | `$INSO_HOME/agent/agents/<name>/agent.md`, where `agent_create` writes | yes | read, edit, **create here** |
| **project** | `<workspace>/<PI_CONFIG_DIR>/agents/<name>/agent.md` (legacy `.omp/agents` is read-only) | none: it belongs to one project | read and edit; the page passes the active workspace |

Precedence is the engine's: packs own their names, then the project, then the
user; a shadowed file is reported.

## The server

| Tool | Who calls it | What it does |
|---|---|---|
| `forge_open { agent?, workspace? }` | the model | Reads the roster, or one agent, in words. `workspace` binds the session's project for later calls. |
| `forge_propose { name, description?, charter?, vibr?, voice?, skills?, memory?, thinking?, personality?, extra? }` | the model | Stores a draft for the page to show as proposed. Writes nothing. Has no `tools`, `mcp`, `approval`, `habitat` or `lineage` field, and refuses an `extra` that names a grant-class key. One undecided proposal per agent per workspace: a newer one replaces it. |
| `pending_proposals { workspace? }` · `dismiss_proposal { id }` | the page | The undecided proposals made in that workspace (or with none); the human decided one. |
| `list_agents { workspace? }` | the page | All three tiers, each parsed by `@dimension/sdk/general-agent`'s `parseGeneralAgent`, with its tier, path, revision and whether it is editable. |
| `list_parts { workspace? }` | the page | Skills, MCP servers and tool names read from disk. |
| `validate_agent { draft }` | the page | The server's verdict on a draft without writing. |
| `save_agent { draft, create, tier?, revision?, workspace? }` | the page | Serializes with the SAME `src/agent-md.ts` the page previews, re-parses the whole file before anything touches disk, then writes atomically. `create: true` writes a new agent into the user tier; `create: false` rewrites the agent of that tier and is refused unless `revision` still matches. Never rewrites a Loop. |
| `agent_home { name, workspace? }` · `save_instructions { name, text, revision, workspace? }` | the page | The agent's home and standing instructions; a save is refused unless `revision` still matches. |

The page's tools are App-only (`_meta.ui.visibility: ["app"]`); the model's are
model-only. No tool carries a View.

**Security (doc 58 §3).** The keys that grant (`capabilities.tools`,
`gate.approval`, `workspace.*`, `capabilities.control`, `capabilities.plugins`,
`capabilities.mcp`, `capabilities.optIn`, `subagents.allowed`, `harness`,
`allowedHarnesses`) change only by a human gesture on the profile, and so do
the two profile fields that carry one: Where it runs (`habitat`, written as
`workspace.policy`) and Lineage (`lineage`, written as `extends`, which composes
each base's whole grant into the agent).
`forge_propose` cannot carry them: its schema has none of the drawn ones; an
`extra` that names one is refused whole, read as text and again as the YAML it
parses to; and laying a proposal on a draft never applies one, whatever reaches
the page. `save_agent` and `save_instructions` are App-only: the model cannot
write a file at all.

## Honesty rules

- The profile only emits keys `agent-manifest.ts` accepts, plus the Dimension
  keys `parseGeneralAgent` reads beside them. It never emits `autonomy:`.
- Nothing in a file is unshown and dropped: a key the profile does not draw, or
  a drawn key it cannot draw faithfully (an avatar with a skin, `thinkingLevel:
  auto`, an empty allowlist, a pinned workspace), rides in Other settings
  verbatim, and its control says so. The retired `memory.vault` is the one key a
  rewrite removes.
- A reading the host does not publish says so (`–`, *appear once this host
  measures them*); nothing on the page is estimated.

## Styling

The host's Tailwind scans the kit's and the app's source, never a bundle loaded
at runtime, so `page/page.css` compiles exactly the utilities `page/` uses
against the host's own theme (`@reference`, emitting no token or reset twice)
into the `utilities` layer, scoped under the page's root element
(`:where([data-slot="general-agents-page"])`): a utility the page needs can
never override the host's own responsive variants on a host element, and the
page's own variants still beat the host's plain copies inside it. The page
holds the sheet (`page/styles.ts`) while it is mounted and removes it with its
last instance. Anything the page renders outside its root element would lose
its utilities. Every value reads a `--fr-*` token.

## The harness

`bun run dev` mounts the page exactly as the host does, over `harness/fixture.ts`
(a Store with every fact above and a `call` door answering the server's tools
from memory; nothing is written). `?state=` picks what it meets: `home`,
`empty`, `loading`, `error`, `proposal`; `&call=off` is a host that grants no
`artifactory:call`.
