# Generative UI

## What it is

The assistant can show you a designed interface instead of a wall of text: a three-day trip plan with a timeline per day, two options side by side, a packing checklist you can tick, a schedule, a summary with numbers and a chart. It is drawn in your theme (light, dark, accent, text size), and its buttons answer the assistant for you.

## What it contains

- **Tool `render_ui`**, loaded eagerly, read tier (it draws on your screen and writes nothing, so it never asks). Two parameters: `title` and `blocks`. A block is `{ type, ...props }` from a closed palette of 22: `stack grid card tabs collapse divider` (layout), `heading text callout tags` (text), `list checklist kv timeline` (lists), `table comparison stats progress chart` (data; the chart is bar, line or donut), `button` (a click sends its `message` as your next message), `link image` (https only; an image loads only when you click it).
- The tool's description is generated from the same table the validator enforces, so the grammar the model reads and the one that is checked cannot drift. It is the only resident context the pack adds: no skill, rule, prompt or command ships with it.
- A bad interface is refused with the path and the fix (`blocks[2].columns: expected a whole number 1-4`, `"kpi" is not a block type; use "stats"`), up to eight at a time, and the model corrects it and calls again.
- The card itself is the kit's built-in `generativeUi` tool card (declared in `plugin.json`), drawn by `@fraym/ui`. Design: `docs/design/104-generative-ui.md`.

## Who can use it

Either release ring, and Dimension 0.11.19 or later (`requires.dimension`), the first release whose engine and kit know the `generativeUi` card. It is **opt-in**: the pack declares `optIn` in `package.json`, so it loads only for an agent that names it in `capabilities.optIn`. Today that is **Aether** alone (`packages/dimension-agents/general-agents/aether/agent.md`); the Coding agent, the Designer and the Machinist never load it. The `chat` space requires it, so it arrives with Chat. No sign-in, key or CLI.

## Limits and risks

- Plain text only. HTML, script and `javascript:` or `data:` links in any string are refused, never rendered or stripped; only `**bold**`, `*italic*`, `` `code` `` and `[label](https://url)` are understood.
- Bounds: 48 KiB of JSON, 400 blocks, 8 levels deep, 60 children, 12 buttons, strings of at most 2000 characters, tables of at most 200 rows by 12 columns.
- Nothing remote loads by itself. A link opens when you click it; an image shows a placeholder with its host until you click Load.
- A click sends a message in your name, only after you click, and shows *Sent*. If the host refuses the send the button says why.
- Checklist ticks and the *Sent* mark live in the open card. Reopening the session redraws the interface from what was saved, but the ticks start again.
- The interface is stored in the tool result of the session (up to 48 KiB per call), in addition to the call's arguments.

## Build and test

```
node scripts/build.mjs   # esbuild -> dist/index.mjs (committed: the host loads the built bundle)
bun test test/
```
