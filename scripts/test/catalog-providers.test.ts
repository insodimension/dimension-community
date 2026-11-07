import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Json = Record<string, unknown>;

const scriptsDir = resolve(import.meta.dir, "..");
const DIMENSION_NAMESPACE = "ai.insodimension.dimension";
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

const voiceProviders = { speech: [{ id: "voicey", speak: true, listen: false, converse: true, onDevice: true }] };
const makerProviders = {
	generation: [{ id: "maker", produces: ["image", "model3d"], runtime: "api", models: ["not-published"] }],
	router: [{ id: "jev" }],
};

function writePack(root: string, name: string, namespace: Json) {
	const dir = join(root, "packs", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", description: `The ${name} test pack` }));
	writeFileSync(
		join(dir, "plugin.json"),
		JSON.stringify({ name, version: "1.0.0", extensions: { [DIMENSION_NAMESPACE]: { contractVersion: 1, ...namespace } } }),
	);
}

function writeLegacyPack(root: string, name: string, manifest: Json) {
	const dir = join(root, "packs", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", description: `The ${name} test pack` }));
	writeFileSync(join(dir, "dimension.plugin.json"), JSON.stringify({ plugin: name, contractVersion: 1, ...manifest }));
}

function run(root: string, script: string, ...args: string[]) {
	const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function makeShelf(): string {
	const root = mkdtempSync(join(tmpdir(), "catalog-providers-"));
	shelves.push(root);
	mkdirSync(join(root, "scripts"));
	for (const file of ["build-index.ts", "pack-manifest.mjs", "space-showcase.mjs", "validate-marketplace.mjs"]) {
		cpSync(join(scriptsDir, file), join(root, "scripts", file));
	}
	mkdirSync(join(root, ".dimension-plugin"));
	writeFileSync(
		join(root, ".dimension-plugin", "marketplace.json"),
		JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }),
	);
	writePack(root, "voice-pack", { providers: voiceProviders });
	writePack(root, "maker-pack", { providers: makerProviders });
	writePack(root, "plain-pack", {});
	writeLegacyPack(root, "legacy-pack", { providers: { speech: [{ id: "old-voice", speak: true }] } });
	return root;
}

function builtShelf(): string {
	const root = makeShelf();
	expect(run(root, "build-index.ts").status).toBe(0);
	return root;
}

const catalogFiles = (root: string) => [join(root, ".dimension-plugin", "marketplace.json"), join(root, ".omp-plugin", "marketplace.json")];

function entryOf(root: string, name: string): Json {
	const catalog = JSON.parse(readFileSync(catalogFiles(root)[0], "utf8")) as { plugins: Json[] };
	const entry = catalog.plugins.find(plugin => plugin.name === name);
	if (!entry) throw new Error(`no catalog entry for ${name}`);
	return entry;
}

function editCatalog(root: string, edit: (plugins: Json[]) => void) {
	for (const file of catalogFiles(root)) {
		const catalog = JSON.parse(readFileSync(file, "utf8")) as { plugins: Json[] };
		edit(catalog.plugins);
		writeFileSync(file, `${JSON.stringify(catalog, null, "\t")}\n`);
	}
}

function editManifest(root: string, pack: string, edit: (namespace: Json) => void) {
	const file = join(root, "packs", pack, "plugin.json");
	const document = JSON.parse(readFileSync(file, "utf8")) as { extensions: Record<string, Json> };
	edit(document.extensions[DIMENSION_NAMESPACE]);
	writeFileSync(file, JSON.stringify(document));
}

const pluginNamed = (plugins: Json[], name: string): Json => plugins.find(plugin => plugin.name === name) as Json;

describe("catalog providers: what the index publishes", () => {
	test("speech and generation providers ride the entry with only the published fields, and a pack that declares none gets no key", () => {
		const root = builtShelf();

		expect(entryOf(root, "voice-pack").providers).toStrictEqual(voiceProviders);
		expect(entryOf(root, "maker-pack").providers).toStrictEqual({
			generation: [{ id: "maker", produces: ["image", "model3d"], runtime: "api" }],
		});
		expect(Object.hasOwn(entryOf(root, "plain-pack"), "providers")).toBeFalse();
		expect(run(root, "validate-marketplace.mjs").status).toBe(0);
	});

	test("a pack that predates the plugin.json manifest is read the same way", () => {
		const root = builtShelf();

		expect(entryOf(root, "legacy-pack").providers).toStrictEqual({ speech: [{ id: "old-voice", speak: true }] });
	});

	test("a pack declaring both kinds publishes both, speech first, with unset flags left off", () => {
		const root = makeShelf();
		writePack(root, "both-pack", {
			providers: {
				generation: [{ id: "g", produces: ["video"] }],
				speech: [{ id: "s" }],
			},
		});
		expect(run(root, "build-index.ts").status).toBe(0);

		const providers = entryOf(root, "both-pack").providers as Json;
		expect(Object.keys(providers)).toEqual(["speech", "generation"]);
		expect(providers).toStrictEqual({ speech: [{ id: "s" }], generation: [{ id: "g", produces: ["video"] }] });
	});

	test("a second run changes nothing", () => {
		const root = builtShelf();
		const first = readFileSync(catalogFiles(root)[0], "utf8");

		expect(run(root, "build-index.ts").status).toBe(0);
		expect(readFileSync(catalogFiles(root)[0], "utf8")).toBe(first);
		expect(run(root, "build-index.ts", "--check").status).toBe(0);
	});
});

describe("catalog providers: the generator refuses a manifest it cannot publish faithfully", () => {
	const refusals: ReadonlyArray<readonly [string, Json, RegExp]> = [
		["a modality outside the list", { generation: [{ id: "g", produces: ["image", "holo"] }] }, /"holo".*not one of/],
		["a generator that makes nothing", { generation: [{ id: "g", produces: [] }] }, /produces must be a non-empty list/],
		["a speech entry with no id", { speech: [{ speak: true }] }, /providers\.speech\[0\]: id is required/],
		["a speech flag that is not true or false", { speech: [{ id: "s", speak: "yes" }] }, /speak must be true or false/],
		["a speech list that is not a list", { speech: { id: "s" } }, /providers\.speech must be an array/],
	];

	test.each(refusals)("%s", (_name, providers, message) => {
		const root = builtShelf();
		const before = readFileSync(catalogFiles(root)[0], "utf8");
		writePack(root, "bad-pack", { providers });

		const result = run(root, "build-index.ts");

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("packs/bad-pack");
		expect(result.output).toMatch(message);
		expect(readFileSync(catalogFiles(root)[0], "utf8")).toBe(before);
	});
});

describe("catalog providers: validate-marketplace refuses drift", () => {
	test("a speech flag changed in the catalog but not in the pack", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			((pluginNamed(plugins, "voice-pack").providers as Json).speech as Json[])[0].onDevice = false;
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain('plugin "voice-pack": the catalog\'s providers differ');
	});

	test("a modality outside the list in the catalog", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			((pluginNamed(plugins, "maker-pack").providers as Json).generation as Json[])[0].produces = ["image", "holo"];
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toMatch(/the catalog entry's providers\.generation\[0\]\.produces has "holo"/);
	});

	test("a speech entry in the catalog with no id", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			delete ((pluginNamed(plugins, "voice-pack").providers as Json).speech as Json[])[0].id;
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain("the catalog entry's providers.speech[0]: id is required");
	});

	test("a pack that declares providers whose catalog entry omits them", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			delete pluginNamed(plugins, "maker-pack").providers;
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain('plugin "maker-pack": the catalog\'s providers differ');
	});

	test("providers on a catalog entry whose pack declares none", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			pluginNamed(plugins, "plain-pack").providers = voiceProviders;
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain('plugin "plain-pack": the catalog\'s providers differ');
	});

	test("a kind the catalog does not carry, smuggled into an entry", () => {
		const root = builtShelf();
		editCatalog(root, plugins => {
			(pluginNamed(plugins, "maker-pack").providers as Json).router = [{ id: "jev" }];
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain('plugin "maker-pack": the catalog\'s providers differ');
	});

	test("a pack manifest edited without regenerating fails both gates, and regenerating clears them", () => {
		const root = builtShelf();
		editManifest(root, "voice-pack", namespace => {
			namespace.providers = { speech: [{ id: "voicey", speak: true, listen: true }] };
		});

		const stale = run(root, "validate-marketplace.mjs", "--check");
		expect(stale.status).toBe(1);
		expect(stale.output).toContain("the catalog has DRIFTED from the packs on disk");
		expect(stale.output).toContain('plugin "voice-pack": the catalog\'s providers differ');

		expect(run(root, "build-index.ts").status).toBe(0);
		expect(run(root, "validate-marketplace.mjs", "--check").status).toBe(0);
	});

	test("a pack manifest with an unpublishable provider fails the validator by name", () => {
		const root = builtShelf();
		editManifest(root, "maker-pack", namespace => {
			namespace.providers = { generation: [{ id: "maker", produces: ["holo"] }] };
		});

		const result = run(root, "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toMatch(/plugin "maker-pack": the pack's manifest providers\.generation\[0\]\.produces has "holo"/);
	});
});
