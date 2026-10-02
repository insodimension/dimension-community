/** WHAT BREAKS IF THIS GOES RED: a stranger installs voice-mode and gets no Voice pane. The engine refuses a pack's
 *  whole component declaration for one malformed field, the host refuses a bundle that imports a name it does not
 *  grant, and a committed `dist/` that is older than `src/` ships the old pane under a new version. Each check reads
 *  the real thing (the engine's own parser, the host's grant source, a fresh build), never a hand-kept list. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseComponentDecls } from "../../../../packages/engine/src/assembly-contributions";
import { readPackManifestResult } from "../../../scripts/pack-manifest.mjs";

const PACK = resolve(import.meta.dir, "..");
const BUNDLE = join(PACK, "dist/index.mjs");
const GRANT_SOURCE = resolve(PACK, "../../../fraym/packages/ui/src/shell/space/host-externals.ts");

const packageJson = JSON.parse(readFileSync(join(PACK, "package.json"), "utf8")) as {
	dimension: { name: string };
	files: string[];
};

describe("voice-mode manifest, as a stranger's engine reads it", () => {
	const { manifest, document, error } = readPackManifestResult(PACK);

	test("plugin.json parses and its name pairs with package.json", () => {
		expect(error).toBeUndefined();
		expect(manifest?.plugin).toBe(packageJson.dimension.name);
		expect(document?.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
	});

	test("the engine's own component parser accepts it: one Settings-slot pane, no warnings", () => {
		const warnings: string[] = [];
		const decls = parseComponentDecls(manifest as Record<string, unknown>, reason => warnings.push(reason));
		expect(warnings).toEqual([]);
		expect(decls?.map(decl => ({ id: decl.id, slot: decl.slot, label: decl.label }))).toEqual([
			{ id: "voice-settings", slot: "settings", label: "Voice" },
		]);
		expect(decls?.[0]?.grants ?? []).toEqual([]);
	});

	test("what ships is listed and present: the manifest, the built bundle and the icon", () => {
		for (const shipped of ["plugin.json", "dist/", "assets/"]) expect(packageJson.files).toContain(shipped);
		expect(existsSync(BUNDLE)).toBe(true);
		expect(existsSync(join(PACK, String(manifest?.icon)))).toBe(true);
	});
});

/** The specifiers `HOST_EXTERNALS` resolves, read from the grant source of the pinned kit. */
function grantedSpecifiers(): Set<string> {
	const source = readFileSync(GRANT_SOURCE, "utf8");
	const start = source.indexOf("export const HOST_EXTERNALS");
	const end = source.indexOf("});", start);
	if (start < 0 || end < start) throw new Error("HOST_EXTERNALS map not found in host-externals.ts");
	const specifiers = new Set<string>();
	for (const match of source.slice(start, end).matchAll(/^\t(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)) {
		specifiers.add((match[1] ?? match[2]) as string);
	}
	return specifiers;
}

describe("voice-mode bundle", () => {
	const bundle = readFileSync(BUNDLE, "utf8");

	test("imports only granted host externals: the host refuses a bundle with one it does not grant, whole", () => {
		const specifiers = [...bundle.matchAll(/^import\s*(?:[^"']*?from\s*)?["']([^"']+)["']/gm)].map(match => match[1] as string);
		expect(specifiers.length).toBeGreaterThan(0);
		const granted = grantedSpecifiers();
		expect(specifiers.filter(specifier => !granted.has(specifier))).toEqual([]);
	});

	test("uses the production JSX runtime: the dev runtime is not a granted external", () => {
		expect(bundle).not.toContain("react/jsx-dev-runtime");
	});

	test("dist is the build of src: rebuilding it changes nothing (rebuild with `bun run build` after editing src)", async () => {
		const built = await Bun.build({
			entrypoints: [join(PACK, "src/index.tsx")],
			target: "browser",
			format: "esm",
			external: ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"],
			define: { "process.env.NODE_ENV": '"production"' },
		});
		expect(built.success).toBe(true);
		const fresh = (await built.outputs[0]?.text()) ?? "";
		// Bun labels each module with its path relative to the process cwd; the code under the label is the build.
		const normalise = (code: string) => code.replace(/\r\n/g, "\n").replace(/^\/\/ \S*src\/\S+$/gm, "//").trim();
		expect(normalise(fresh)).toBe(normalise(bundle));
	});
});
