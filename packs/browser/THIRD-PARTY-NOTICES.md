# Third-party notices

What the Browser pack copies or depends on beyond its own code, its licence, and where the notice lives. The code realm of `browser_run`
(`src/code/`) is a port of OMP's browser; the port rules are in `docs/design/77-the-browser-artifactory.md` §7.4.7.

## Copied source

| What | Licence | Where | Source |
|---|---|---|---|
| OMP (oh-my-pi) browser: tab realm, run scope, selector rules, call chain, ToolError family, run-code, facade prelude | MIT, (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. | `src/code/**` (every copied file carries the notice in its first lines); licence text in `third-party/omp/LICENSE` | https://github.com/can1357/oh-my-pi @ dc5f95d9e1 |
| Playwright injected ARIA-snapshot code, bundled by OMP (`aria-snapshot.bundle.txt`, Playwright v1.61.0), copied verbatim | Apache-2.0, (c) Microsoft Corporation | `src/code/extract/aria-snapshot.bundle.txt`; licence text in `third-party/playwright/LICENSE` | https://github.com/microsoft/playwright (bundled by OMP's `scripts/generate-aria-snapshot.ts`) |

## Dependencies of the code realm (extraction)

| Package | Version found | Licence | Used by |
|---|---|---|---|
| `@mozilla/readability` | 0.6.0 | Apache-2.0 | `src/code/extract/readable.ts` (`tab.extract`): article isolation |
| `linkedom` | 0.18.13 | ISC | `src/code/extract/readable.ts`: the DOM Readability reads |
| `turndown` | 7.2.4 | MIT | `src/code/extract/markdown.ts`: HTML to markdown |
| `turndown-plugin-gfm` | 1.0.2 | MIT | `src/code/extract/markdown.ts`: GFM tables, task lists |

OMP ships behaviour-compatible reimplementations of `@mozilla/readability` and `linkedom` (`omp/packages/utils/src/readability.ts`, `dom.ts`);
the pack uses the upstream packages, and `test/code-extract.test.ts` compares their output with OMP's on the same HTML.
