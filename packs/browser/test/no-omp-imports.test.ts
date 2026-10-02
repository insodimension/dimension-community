/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack stops being self-contained, or ships MIT-licensed code without its notice. The Browser pack is an
 *  independent plugin: it is installed from the marketplace and runs where `omp/` does not exist, so one import that reaches OMP is a pack that
 *  crashes on start for everyone who is not on the owner's machine. And OMP's licence (MIT, three holders) is kept only if every file copied from it says so.
 *
 *  Every file under src/code says where it came from in its first lines, and a file that says it was copied from OMP carries the whole notice
 *  (holders, a licence path that resolves, what changed). The scan itself is checked on a planted tree, so a scan that finds nothing cannot pass for a clean tree.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOLDERS = "Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc.";
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const HEAD_LINES = 12;

function* filesUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

/** The module specifiers a source file imports, exports from or requires. Comment lines are skipped: prose may name a module. */
function specifiersOf(source: string): string[] {
  const code = source.split("\n").filter(line => !/^\s*(?:\/\/|\/?\*)/.test(line)).join("\n");
  const found: string[] = [];
  for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g]) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

function reachesOmp(specifier: string, from: string, packRoot: string): boolean {
  if (/^@oh-my-pi\//.test(specifier) || /(?:^|\/)oh-my-pi(?:\/|$)/.test(specifier)) return true;
  // A relative path that leaves the pack reaches whatever is next to it, `omp/` included.
  if (specifier.startsWith(".")) return !resolve(dirname(from), specifier).startsWith(packRoot + sep);
  return /^omp(?:\/|$)/.test(specifier);
}

/** What is wrong under `codeDir`: imports that reach OMP, and files whose provenance or notice is missing or incomplete. */
function violationsUnder(codeDir: string, packRoot: string): string[] {
  const problems: string[] = [];
  for (const file of filesUnder(codeDir)) {
    const name = relative(packRoot, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    if (SOURCE_FILE.test(file)) {
      for (const specifier of specifiersOf(source)) if (reachesOmp(specifier, file, packRoot)) problems.push(`${name} imports ${specifier}`);
    }
    if (file.endsWith(".d.ts")) continue;
    const head = source.split("\n").slice(0, HEAD_LINES).join("\n");
    if (head.includes("@generated")) continue;
    if (head.includes("Copied from OMP")) {
      if (!head.includes(HOLDERS)) problems.push(`${name}: the notice does not name OMP's three holders`);
      const licence = /See (\S*third-party\/omp\/LICENSE)/.exec(head)?.[1];
      if (licence === undefined || !existsSync(resolve(dirname(file), licence))) problems.push(`${name}: the notice does not point at OMP's LICENSE`);
      if (!head.includes("Changed for the Browser pack:")) problems.push(`${name}: the notice does not say what changed`);
    } else if (!head.includes("Written for the Browser pack")) {
      problems.push(`${name}: no provenance line (Copied from OMP, or Written for the Browser pack)`);
    }
  }
  return problems;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("nothing under src/code reaches OMP, and every file says where it came from", () => {
  test("the tree is clean", () => {
    expect(violationsUnder(join(PACK, "src", "code"), PACK)).toEqual([]);
  });

  test("OMP's licence is shipped with the pack", () => {
    const licence = readFileSync(join(PACK, "third-party", "omp", "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    for (const holder of ["Mario Zechner", "Can Bölük", "Stencil Labs"]) expect(licence).toContain(holder);
  });

  test("the scan finds every way of reaching OMP and every notice that is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "no-omp-imports-"));
    scratch.push(root);
    const code = join(root, "src", "code");
    mkdirSync(join(root, "third-party", "omp"), { recursive: true });
    writeFileSync(join(root, "third-party", "omp", "LICENSE"), "MIT License");
    mkdirSync(join(code, "deep"), { recursive: true });
    const notice = (licence: string): string => `// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), x.ts @ abc.\n// ${HOLDERS} See ${licence}.\n// Changed for the Browser pack: nothing.\n`;
    const files: Record<string, string> = {
      "clean.ts": `${notice("../../third-party/omp/LICENSE")}import { a } from "./other.js";\n// from "@oh-my-pi/pi-utils" in prose is not an import\n`,
      "deep/clean.ts": `// Written for the Browser pack.\nexport const x = await import("node:fs");\n`,
      "package-import.ts": `// Written for the Browser pack.\nimport { x } from "@oh-my-pi/pi-utils";\n`,
      "dynamic-import.ts": `// Written for the Browser pack.\nconst x = await import("@oh-my-pi/pi-utils/dom");\n`,
      "require.ts": `// Written for the Browser pack.\nconst x = require("@oh-my-pi/pi-utils");\n`,
      "reexport.ts": `// Written for the Browser pack.\nexport { x } from "../../../omp/packages/utils/src/index.js";\n`,
      "side-effect.ts": `// Written for the Browser pack.\nimport "@oh-my-pi/pi-natives";\n`,
      "no-provenance.ts": `export const x = 1;\n`,
      "wrong-holders.ts": "// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), x.ts @ abc.\n// Copyright (c) 2025 Somebody. See ../../third-party/omp/LICENSE.\n// Changed for the Browser pack: nothing.\n",
      "dangling-licence.ts": notice("../../third-party/omp/NOWHERE"),
      "no-change-line.ts": `// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), x.ts @ abc.\n// ${HOLDERS} See ../../third-party/omp/LICENSE.\n`,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(code, name), text);
    const problems = violationsUnder(code, root);
    const flagged = new Set(problems.map(problem => problem.split(/[: ]/)[0]));
    expect([...flagged].sort()).toEqual([
      "src/code/dangling-licence.ts", "src/code/dynamic-import.ts", "src/code/no-change-line.ts", "src/code/no-provenance.ts", "src/code/package-import.ts",
      "src/code/reexport.ts", "src/code/require.ts", "src/code/side-effect.ts", "src/code/wrong-holders.ts",
    ]);
  });
});
