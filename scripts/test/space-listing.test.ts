import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initGitShelf, SHELF_SCRIPTS } from "./git-shelf";

type Json = Record<string, unknown>;

setDefaultTimeout(30_000);

const scriptsDir = resolve(import.meta.dir, "..");
const DIMENSION_NAMESPACE = "ai.insodimension.dimension";
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

function run(root: string, script: string) {
	const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeFile(root: string, path: string, bytes: string | Uint8Array) {
	const file = join(root, path);
	mkdirSync(resolve(file, ".."), { recursive: true });
	writeFileSync(file, bytes);
}

function makeShelf(): string {
	const root = mkdtempSync(join(tmpdir(), "space-listing-"));
	shelves.push(root);
	initGitShelf(root);
	for (const file of SHELF_SCRIPTS) writeFile(root, join("scripts", file), readFileSync(join(scriptsDir, file)));
	writeFile(
		root,
		".dimension-plugin/marketplace.json",
		JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }),
	);
	writeFile(root, "packs/atlas/package.json", JSON.stringify({ name: "atlas", version: "1.0.0" }));
	writeFile(root, "packs/atlas/assets/home.webp", "webp");
	writeFile(root, "packs/atlas/assets/demo.mp4", "mp4");
	writeFile(
		root,
		"packs/atlas/plugin.json",
		JSON.stringify({
			name: "atlas",
			version: "1.0.0",
			description: "Every repository on one map you can ask about.",
			extensions: {
				[DIMENSION_NAMESPACE]: {
					contractVersion: 1,
					spaces: [
						{
							id: "atlas",
							label: "Atlas",
							showcase: {
								tagline: "Maps every repo",
								summary: "Every repository you touch, drawn as one map.",
								screenshots: ["assets/home.webp"],
								video: { src: "assets/demo.mp4", poster: "assets/home.webp" },
							},
						},
					],
				},
			},
		}),
	);
	return root;
}

function catalog(root: string): { plugins: Json[] } {
	return JSON.parse(readFileSync(join(root, ".dimension-plugin", "marketplace.json"), "utf8"));
}

function writeCatalog(root: string, plugins: Json[]) {
	const text = `${JSON.stringify({ ...catalog(root), plugins }, null, "\t")}\n`;
	writeFile(root, ".dimension-plugin/marketplace.json", text);
	writeFile(root, ".omp-plugin/marketplace.json", text);
}

function releaseEntry(showcase: Json): Json {
	return {
		name: "lantern",
		version: "0.2.0",
		description: "A quiet place to read with your sources beside you.",
		license: "MIT",
		source: {
			source: "release",
			url: "https://get.example.com/spaces/lantern/lantern-0.2.0.tgz",
			sha256: "a".repeat(64),
			size: 4096,
		},
		spaces: [{ id: "lantern", label: "Lantern", showcase }],
	};
}

function shelfWithRelease(showcase: Json): string {
	const root = makeShelf();
	writeFile(root, "packs/lantern/assets/shot.webp", "webp");
	writeFile(root, "packs/lantern/assets/demo.webm", "webm");
	expect(run(root, "build-index.ts").status).toBe(0);
	writeCatalog(root, [...catalog(root).plugins, releaseEntry(showcase)]);
	return root;
}

const RELEASE_SHOWCASE = {
	summary: "Read, take notes, and ask your sources.",
	screenshots: ["packs/lantern/assets/shot.webp"],
	video: { src: "packs/lantern/assets/demo.webm" },
};

describe("space listings in the Community index", () => {
	test("a pack's showcase is the listing's showcase, media rebased to the shelf, with no retired fields", () => {
		const root = makeShelf();
		expect(run(root, "build-index.ts").status).toBe(0);

		const [listing] = catalog(root).plugins[0]?.spaces as Json[];
		expect(listing).toStrictEqual({
			id: "atlas",
			label: "Atlas",
			showcase: {
				tagline: "Maps every repo",
				summary: "Every repository you touch, drawn as one map.",
				screenshots: ["packs/atlas/assets/home.webp"],
				video: { src: "packs/atlas/assets/demo.mp4", poster: "packs/atlas/assets/home.webp" },
			},
		});
		expect(run(root, "validate-marketplace.mjs").status).toBe(0);
	});

	test("a release listing with summary, a screenshot and a video is accepted and survives a rebuild", () => {
		const root = shelfWithRelease(RELEASE_SHOWCASE);

		expect(run(root, "validate-marketplace.mjs")).toMatchObject({ status: 0 });
		expect(run(root, "build-index.ts").status).toBe(0);
		expect(catalog(root).plugins.map(plugin => plugin.name)).toEqual(["atlas", "lantern"]);
	});

	test("a release listing without a video is refused", () => {
		const { video: _video, ...noVideo } = RELEASE_SHOWCASE;
		const result = run(shelfWithRelease(noVideo), "validate-marketplace.mjs");

		expect(result.status).toBe(1);
		expect(result.output).toContain("showcase video");
	});

	test("a showcase video the shelf does not hold is refused", () => {
		const result = run(
			shelfWithRelease({ ...RELEASE_SHOWCASE, video: { src: "packs/lantern/assets/missing.mp4" } }),
			"validate-marketplace.mjs",
		);

		expect(result.status).toBe(1);
		expect(result.output).toContain("missing.mp4");
	});

	test("a listing still carrying the retired top-level screenshots is refused", () => {
		const root = shelfWithRelease(RELEASE_SHOWCASE);
		writeCatalog(
			root,
			catalog(root).plugins.map(plugin =>
				plugin.name === "lantern"
					? { ...plugin, spaces: [{ ...(plugin.spaces as Json[])[0], screenshots: ["packs/lantern/assets/shot.webp"] }] }
					: plugin,
			),
		);

		const result = run(root, "validate-marketplace.mjs");
		expect(result.status).toBe(1);
		expect(result.output).toContain("retired screenshots");
	});

	test("a showcase video that is a symlink is refused, even when its target is a real video", () => {
		const root = shelfWithRelease(RELEASE_SHOWCASE);
		const outside = mkdtempSync(join(tmpdir(), "space-listing-outside-"));
		shelves.push(outside);
		writeFileSync(join(outside, "secret.mp4"), "mp4");
		try {
			symlinkSync(join(outside, "secret.mp4"), join(root, "packs/lantern/assets/linked.mp4"), "file");
		} catch (cause) {
			expect((cause as NodeJS.ErrnoException).code).toBe("EPERM");
			return;
		}
		writeCatalog(
			root,
			catalog(root).plugins.map(plugin =>
				plugin.name === "lantern"
					? releaseEntry({ ...RELEASE_SHOWCASE, video: { src: "packs/lantern/assets/linked.mp4" } })
					: plugin,
			),
		);
		const result = run(root, "validate-marketplace.mjs");
		expect(result.status).toBe(1);
		expect(result.output).toContain("is a symlink");
	});

	test("a space with only the legacy preview block lists no showcase", () => {
		const root = makeShelf();
		const manifestPath = join(root, "packs/atlas/plugin.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const [space] = manifest.extensions[DIMENSION_NAMESPACE].spaces;
		delete space.showcase;
		space.description = "Not a tagline.";
		space.preview = { tagline: "Old words.", screenshots: ["assets/home.webp"] };
		writeFileSync(manifestPath, JSON.stringify(manifest));

		expect(run(root, "build-index.ts").status).toBe(0);
		expect(catalog(root).plugins[0]?.spaces).toStrictEqual([{ id: "atlas", label: "Atlas" }]);
	});
});
