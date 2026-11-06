# Rooms Rail (`rooms-rail`)

## What it is

The rail of a rooms space: the space's own name with search and one `+` at the top, direct messages, channels and projects or workspaces under headings in the space's own words, an Organise menu on the section header, and a needs-you mark on the rows that wait on you. It is the shipped rooms rail, installable: the pack re-exports the kit's `RAIL_ROOMS`, so the pixels and the behaviour are the app's own.

## What it contains

One component, `rooms-rail`, filling the `rail` slot. No tools, skills, rules, agents or MCP servers.

## Who can use it

On by default. It draws only in a space that binds it with `components: { "rail": "rooms-rail" }` and declares `rail.rooms: true` and `rail.sections`. Clients, Unreal and Traction do, and each lists `rooms-rail` in `requires.plugins`, so opening the space installs it. It ships to every install, stable and canary, because Clients is on stable and its rail is this pack. Its floor is 0.11.12, the first release whose host grants `RAIL_ROOMS` to packs: the 0.11.11 host does not, so a bundle that takes the name would fail to link there. A build of `main` identifies itself as the last release (0.11.11) until the next cut bumps the version, so it does not load the pack until then.

## Limits and risks

It reads the session and room facts the host hands every rail and asks the host to act through the rail's verbs; it keeps no data of its own. Words, actions, row height and heading case come from the space's manifest, not from this pack. A space that binds it without the pack installed shows a named broken seat, never the classic rail. For a different rail, write your own rail pack: `independent-rail` and `triage-rail` are the references.

## Build and test

`bun run build` (vite lib mode) emits `dist/index.mjs`, the ESM bundle the host loads. `dist/` is committed, so the pack installs with no build step. The bundle imports only `@fraym/ui`. The implementation lives in the kit (`fraym/packages/ui`) and is tested there by the `rail-*` suites and `rooms-rail-grant`.
