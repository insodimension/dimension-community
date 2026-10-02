// CONTRACT A TYPECHECK CANNOT CATCH: the page bundle's imports vs the kit grant.
//
// `page/*` imports from `"@fraym/ui"`, which at TYPECHECK time is the whole
// barrel. At RUNTIME the host's bundle loader resolves it against
// `HOST_EXTERNALS["@fraym/ui"]`, the enumerated subset in
// `fraym/packages/ui/src/shell/space/host-externals.ts`: a name in the barrel
// and missing from the grant typechecks, builds, ships, and then throws at
// `import()`, leaving the page blank (the `general-chat` test's finding). Read
// off the BUILT bundle and the grant SOURCE, the pair the loader meets.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(import.meta.dir, "../dist");
const BUNDLE = join(DIST, "index.mjs");
const PACK = resolve(import.meta.dir, "..");
const GRANT_SOURCE = resolve(import.meta.dir, "../../../../fraym/packages/ui/src/shell/space/host-externals.ts");

function readOrThrow(path: string, hint: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`required artifact missing at ${path} — ${hint}`, { cause });
	}
}

function bundleImports(): Map<string, readonly string[]> {
	const source = readOrThrow(BUNDLE, "rebuild the pack (bun run build)");
	const imports = new Map<string, readonly string[]>();
	for (const match of source.matchAll(/^import\s*(?:\{([^}]*)\}\s*from\s*)?["']([^"']+)["']/gm)) {
		const names = (match[1] ?? "")
			.split(",")
			.map(clause => clause.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
			.filter(Boolean);
		imports.set(match[2] as string, names);
	}
	return imports;
}

function grantNames(): Set<string> {
	const source = readOrThrow(GRANT_SOURCE, "the fraym submodule is missing or uninitialized");
	const start = source.indexOf("const FRAYM_UI_EXTERNAL = {");
	const end = source.indexOf("} as const;", start);
	if (start < 0 || end < start) throw new Error("FRAYM_UI_EXTERNAL body not found in host-externals.ts");
	const body = source.slice(start, end);
	const names = new Set<string>();
	for (const match of body.matchAll(/^\tget ([A-Za-z_$][\w$]*)\(/gm)) names.add(match[1] as string);
	for (const match of body.matchAll(/^\t([A-Za-z_$][\w$]*),$/gm)) names.add(match[1] as string);
	return names;
}

/** The page bundle built from the source on disk into a fresh directory, by the same Vite call `scripts/build.mjs` makes. */
async function freshBundle(): Promise<string> {
	const out = mkdtempSync(join(tmpdir(), "general-agents-bundle-"));
	try {
		// A child process: `bun test` sets NODE_ENV=test, which makes Vite emit the dev JSX runtime, and the committed bundle is a production build.
		const script = `import { build } from "vite";
			await build({ configFile: ${JSON.stringify(join(PACK, "vite.config.ts"))}, root: ${JSON.stringify(PACK)}, logLevel: "silent", build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true } });`;
		const child = Bun.spawn([process.execPath, "-e", script], { cwd: PACK, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		if (code !== 0) throw new Error(`the page bundle did not build: ${stderr}`);
		return readFileSync(join(out, "index.mjs"), "utf8");
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

/** The 1-based line where the two texts first differ, or null when they are the same. */
function firstDifference(a: string, b: string): number | null {
	if (a === b) return null;
	const left = a.split("\n");
	const right = b.split("\n");
	const at = left.findIndex((text, index) => text !== right[index]);
	return (at === -1 ? Math.min(left.length, right.length) : at) + 1;
}

describe("the General Agents page bundle against the @fraym/ui externals grant", () => {
	test("the bundle imports only the host's granted specifiers, and really does import the kit", () => {
		const imports = bundleImports();
		for (const specifier of imports.keys()) expect(["react", "react-dom", "react/jsx-runtime", "@fraym/ui"]).toContain(specifier);
		expect(imports.get("@fraym/ui")).toContain("PresenceSurface");
	});

	test("every name it imports from @fraym/ui is a member of the grant", () => {
		const granted = grantNames();
		expect(granted.has("PresenceSurface")).toBe(true);
		expect([...(bundleImports().get("@fraym/ui") ?? [])].filter(name => !granted.has(name)).sort()).toEqual([]);
	});

	test("it ships as ONE module: no stylesheet or chunk beside it (its utilities ride inside)", () => {
		expect(readdirSync(DIST).sort()).toEqual(["index.mjs"]);
		expect(readOrThrow(BUNDLE, "rebuild").includes("general-agents-page-styles")).toBe(true);
	});

	// Not file times: a checkout writes files in any order, and touching a source
	// changes nothing. What matters is that the committed bytes are what the source builds to.
	test("the committed bundle is what the source builds to", async () => {
		const committed = readOrThrow(BUNDLE, "rebuild the pack (bun run build)");
		expect({ firstDifferingLine: firstDifference(await freshBundle(), committed) }).toEqual({ firstDifferingLine: null });
	}, 120_000);
});
