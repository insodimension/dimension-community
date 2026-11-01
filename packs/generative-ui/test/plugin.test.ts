import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGenerativeUi } from "@dimension/sdk/generative-ui";
import { loadTools } from "./fixtures";

const PACK = join(import.meta.dir, "..");
const DIST = join(PACK, "dist", "index.mjs");
const DIMENSION_KEY = "ai.insodimension.dimension";

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object, got ${JSON.stringify(value)}`);
	}
	return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
		throw new Error(`expected a list of strings, got ${JSON.stringify(value)}`);
	}
	return value;
}

async function readJson(name: string): Promise<Record<string, unknown>> {
	return record(JSON.parse(await readFile(join(PACK, name), "utf8")));
}

describe("the committed bundle", () => {
	test("dist/index.mjs is exactly what scripts/build.mjs produces from src/", async () => {
		const built: unknown = await import(pathToFileURL(join(PACK, "scripts", "build.mjs")).href);
		if (typeof built !== "object" || built === null || !("buildBundle" in built) || typeof built.buildBundle !== "function") {
			throw new Error("scripts/build.mjs does not export buildBundle()");
		}
		const rebuilt: unknown = await built.buildBundle();
		if (typeof rebuilt !== "string") throw new Error("buildBundle() did not return the bundle text");
		const committed = (await readFile(DIST, "utf8")).replaceAll("\r\n", "\n");
		expect(
			committed === rebuilt.replaceAll("\r\n", "\n"),
			"dist/index.mjs is stale: the host loads it, not src/. Run `node scripts/build.mjs` in marketplace/packs/generative-ui and commit dist/index.mjs",
		).toBe(true);
	}, 60_000);

	test("the shipped bundle registers the tool and validates end to end with no monorepo around it", async () => {
		const [registered] = await loadTools(DIST);
		expect(registered?.name).toBe("render_ui");
		const result = await registered?.execute("t1", { blocks: [{ type: "heading", text: "Hello" }] });
		expect(readGenerativeUi(result?.details)).toEqual({ v: 1, blocks: [{ type: "heading", text: "Hello" }] });
	});
});

describe("the manifests", () => {
	test("plugin.json and package.json agree on name and version: the host caches an install by it", async () => {
		const manifest = await readJson("plugin.json");
		const pkg = await readJson("package.json");
		expect(manifest.version).toBe(pkg.version);
		expect(manifest.name).toBe(record(pkg.dimension).name);
	});

	test("the pack is opt-in: only an agent that names it carries the tool", async () => {
		expect(record((await readJson("package.json")).dimension).optIn).toBe(true);
	});

	test("the pack ships to every ring, which is safe only because it floors the app at the release that draws it", async () => {
		const namespace = record(record((await readJson("plugin.json")).extensions)[DIMENSION_KEY]);
		expect(namespace.channel).toBeUndefined();
		expect(record(namespace.requires).dimension).toMatch(/^>=\d+\.\d+\.\d+$/);
	});

	test("the tool card is the built-in generativeUi card for exactly the tool the bundle registers", async () => {
		const namespace = record(record((await readJson("plugin.json")).extensions)[DIMENSION_KEY]);
		const renderers = namespace.toolRenderer;
		if (!Array.isArray(renderers)) throw new Error("plugin.json declares no toolRenderer");
		expect(renderers).toHaveLength(1);
		const [renderer] = renderers.map(record);
		expect(renderer?.use).toBe("generativeUi");
		const registered = (await loadTools(DIST)).map(entry => entry.name);
		expect(registered).toEqual([String(renderer?.match)]);
		const declared = Array.isArray(namespace.tools) ? namespace.tools.map(entry => record(entry).name) : [];
		expect(declared).toEqual(registered);
	});

	test("every extension the host loads is a file the package ships", async () => {
		const pkg = await readJson("package.json");
		const files = strings(pkg.files);
		for (const extension of strings(record(pkg.dimension).extensions)) {
			const found = await stat(join(PACK, extension)).then(
				info => info.isFile(),
				() => false,
			);
			expect(found, `${extension} is not a file`).toBe(true);
			expect(files.some(entry => extension.startsWith(`${entry.replace(/\/$/, "")}/`) || entry === extension)).toBe(true);
		}
	});

	test("no skills, rules, prompts or commands ride along: the tool's description is the only resident context", async () => {
		const entries = await readdir(PACK);
		for (const forbidden of ["skills", "rules", "prompts", "commands"]) expect(entries).not.toContain(forbidden);
	});
});
