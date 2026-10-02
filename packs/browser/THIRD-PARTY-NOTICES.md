# Third-party notices

What the Browser pack copies or depends on beyond its own code, its licence, and where the notice lives. The code realm of `browser_run`
(`src/code/`) is a port of OMP's browser; the port rules are in `docs/design/77-the-browser-artifactory.md` §7.4.7.

## Copied source

| What | Licence | Where | Source |
|---|---|---|---|
| OMP (oh-my-pi) browser: tab realm, run scope, selector rules, call chain, ToolError family, run-code, facade prelude, and the extraction stack (Readability, DOM and HTML-to-markdown reimplementations from `packages/utils`) | MIT, (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. | `src/code/**` (every copied file carries the notice in its first lines); licence text in `third-party/omp/LICENSE` | https://github.com/can1357/oh-my-pi @ dc5f95d9e1 |
| OMP's launch kinds: the order of choice, connected and spawned browsers, the relay (server, bridge, protocol), cmux (socket client, tab, surface), the page picker of the attach engine and the proxy switches | MIT, same holders | `src/code/kinds/**`, `src/engines/attach.ts` (the page picker), `src/engines/launch-env.ts` (the proxy variables); each file carries the notice in its first lines | https://github.com/can1357/oh-my-pi @ dc5f95d9e1 |
| OMP's Chrome relay extension (Manifest V3: `background.js`, `options.html`, `options.js`, `manifest.json`), renamed "Dimension Browser Relay" | MIT, same holders | `relay-extension/` (licence text in `relay-extension/LICENSE`; its own `THIRD-PARTY-NOTICES.txt` lists only what it bundles: nothing) | https://github.com/can1357/oh-my-pi, `packages/browser-relay/extension` @ dc5f95d9e1 |
| Playwright injected ARIA-snapshot code, bundled by OMP (`aria-snapshot.bundle.txt`, Playwright v1.61.0), copied verbatim | Apache-2.0, (c) Microsoft Corporation | `src/code/extract/aria-snapshot.bundle.txt`; licence text in `third-party/playwright/LICENSE`, and Playwright's NOTICE (verbatim, from the v1.61.0 tag; it says Playwright contains code derived from Puppeteer, Apache-2.0) in `third-party/playwright/NOTICE`, as Apache-2.0 §4(d) asks of a redistributor | https://github.com/microsoft/playwright (bundled by OMP's `scripts/generate-aria-snapshot.ts`) |

## Dependencies of the code realm

`ws` 8.21.3 (MIT, (c) Einar Otto Stangvik and contributors): the relay server's WebSocket (`src/code/kinds/relay/server.ts`), an npm dependency of the pack, not copied.

`tab.extract` (`src/code/extract/`) runs on OMP's own pure-TypeScript reimplementations of Readability (`readability/`), a DOM (`dom/`) and an HTML-to-markdown converter (`turndown/`), copied from
`packages/utils/src/{readability,dom,turndown}` of https://github.com/can1357/oh-my-pi @ be1cfdab27 under the same MIT notice as the rest of the port. The upstream npm packages (`@mozilla/readability` 0.6.0,
`linkedom` 0.18.13, `turndown` 7.2.4, `turndown-plugin-gfm` 1.0.2) were tried first and do NOT give OMP's output on the same HTML (they turn `<h1>` into `##`, and put different blank lines between blocks),
so they are not used and are not in `package.json`; `test/code-extract.test.ts` holds five pages and what OMP's reimplementations made of them, and pins that this copy has not drifted from that output.

Behaviour sources the reimplementations follow, named so the credit is not lost: the article scoring and cleaning rules of Readability.js (Apache-2.0, (c) 2010 Arc90 Inc., maintained by Mozilla; the unlikely,
positive, negative and byline expression tables and the scoring steps in `readability/readability.ts` are its) and the conversion defaults of turndown (MIT, (c) Dom Christie). OMP's own files do not reproduce
either upstream notice; if the owner wants the upstream licence texts shipped too, they belong beside `third-party/omp/`.
