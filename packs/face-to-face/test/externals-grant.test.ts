// CONTRACT A TYPECHECK CANNOT CATCH: this pack's imports vs the kit's externals grant.
//
// At typecheck time `@fraym/ui` is the package BARREL, so every kit export is legal. At runtime the bundle
// loader rewrites the bundle's imports against `HOST_EXTERNALS`, the deliberately ENUMERATED subset in
// `fraym/packages/ui/src/shell/space/host-externals.ts`, and a bundle that imports one name the grant lacks
// is refused WHOLE: the face never mounts and nothing in the pack says why. This pack also inlines its head
// asset into the bundle, so a bundle built before the asset was re-baked ships the wrong head.
//
// Everything is read from disk (the built bundle, the sources, the grant source at the pinned kit): never a
// hardcoded name list, so adding an import tells this test whether the grant covers it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACK = resolve(import.meta.dir, "..");
const BUNDLE = join(PACK, "dist/index.mjs");
const GRANT_SOURCE = resolve(PACK, "../../../fraym/packages/ui/src/shell/space/host-externals.ts");

const read = (path: string, hint: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`required artifact missing at ${path} - ${hint}`, { cause });
	}
};

/** Names inside `import { a, b as c, type T } from "<specifier>"`: the left of `as`, types dropped. */
function importedNames(clause: string): string[] {
	return clause
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !part.startsWith("type "))
		.map((part) => (part.split(/\s+as\s+/)[0] as string).trim());
}

/** specifier -> imported names of every top-level `import` in the built bundle. */
function bundleImports(): Map<string, string[]> {
	const source = read(BUNDLE, "rebuild the pack (marketplace/packs/face-to-face: bun run build)");
	const imports = new Map<string, string[]>();
	for (const match of source.matchAll(/^import\s*(?:\{([^}]*)\}\s*from\s*)?["']([^"']+)["']/gm)) {
		imports.set(match[2] as string, [...(imports.get(match[2] as string) ?? []), ...importedNames(match[1] ?? "")]);
	}
	return imports;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
	);
}

/** Every VALUE name the sources import from `@fraym/ui` (type-only imports are erased and need no grant). */
function sourceFraymImports(): Set<string> {
	const names = new Set<string>();
	for (const file of sourceFiles(join(PACK, "src"))) {
		for (const match of readFileSync(file, "utf8").matchAll(/^import\s+(?!type\b)\{([^}]*)\}\s*from\s*["']@fraym\/ui["']/gm)) {
			for (const name of importedNames(match[1] as string)) names.add(name);
		}
	}
	return names;
}

const GRANT_HINT = "the fraym submodule is missing or uninitialized (git submodule update --init)";

/** The `FRAYM_UI_EXTERNAL` object body: getters (`get Name()`) plus shorthand properties (`Name,`). */
function grantNames(): Set<string> {
	const source = read(GRANT_SOURCE, GRANT_HINT);
	const start = source.indexOf("const FRAYM_UI_EXTERNAL = {");
	const end = source.indexOf("} as const;", start);
	if (start < 0 || end < start) throw new Error("FRAYM_UI_EXTERNAL body not found in host-externals.ts");
	const body = source.slice(start, end);
	const names = new Set<string>();
	for (const match of body.matchAll(/^\tget ([A-Za-z_$][\w$]*)\(/gm)) names.add(match[1] as string);
	for (const match of body.matchAll(/^\t([A-Za-z_$][\w$]*),$/gm)) names.add(match[1] as string);
	return names;
}

/** The `HOST_EXTERNALS` specifier keys. */
function grantedSpecifiers(): Set<string> {
	const source = read(GRANT_SOURCE, GRANT_HINT);
	const start = source.indexOf("export const HOST_EXTERNALS");
	const end = source.indexOf("});", start);
	if (start < 0 || end < start) throw new Error("HOST_EXTERNALS map not found in host-externals.ts");
	const specifiers = new Set<string>();
	for (const match of source.slice(start, end).matchAll(/^\t(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)) {
		specifiers.add((match[1] ?? match[2]) as string);
	}
	return specifiers;
}

describe("face-to-face against the @fraym/ui externals grant", () => {
	test("the parses are not vacuous: the bundle imports the voice hook and the grant carries it", () => {
		expect(bundleImports().get("@fraym/ui")).toContain("useVoiceConversation");
		expect(sourceFraymImports().has("useVoiceConversation")).toBe(true);
		expect(grantNames().has("useVoiceConversation")).toBe(true);
		expect(grantNames().has("ARKIT_52_NAMES")).toBe(true);
	});

	test("every specifier the bundle imports is a granted host external", () => {
		const granted = grantedSpecifiers();
		const ungranted = [...bundleImports().keys()].filter((specifier) => !granted.has(specifier));
		expect(ungranted).toEqual([]);
	});

	test("every @fraym/ui name the bundle imports is granted", () => {
		const granted = grantNames();
		expect((bundleImports().get("@fraym/ui") ?? []).filter((name) => !granted.has(name))).toEqual([]);
	});

	test("every @fraym/ui name the SOURCES import is granted, so a forgotten rebuild cannot hide an ungranted import", () => {
		const granted = grantNames();
		expect([...sourceFraymImports()].filter((name) => !granted.has(name))).toEqual([]);
	});

	test("the bundle carries the head asset that is on disk (rebuild after re-baking it)", () => {
		const bundle = read(BUNDLE, "rebuild the pack");
		const asset = readFileSync(join(PACK, "assets/head-f01.bin"));
		expect(bundle.includes(asset.toString("base64"))).toBe(true);
	});
});
