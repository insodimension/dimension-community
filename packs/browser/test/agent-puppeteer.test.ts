/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the built pack (`app/server.mjs`, what the host actually runs) cannot
 *  open a throwaway browser or read a page, because the patched puppeteer-core it needs is looked for in the wrong
 *  folder, or a cached copy of it outlives the puppeteer-core it was made from.
 *
 *  The pack finds that library two ways. Built, it is `app/puppeteer-agent.mjs` beside the bundle that imports it. From
 *  source it is bundled on first use into `.cache/`. The two see different `import.meta.url`s; these tests run the
 *  built layout for real (the module bundled the way scripts/build.mjs bundles the server) rather than reading the
 *  resolution off the source.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import stockPuppeteer from "puppeteer-core";
import { agentPuppeteer, bundleFromSource, locateAgentBundle } from "../src/engines/agent-puppeteer";
import { buildAgentPuppeteer, bundleIdentity, PATCH_FILE } from "../scripts/agent-puppeteer.mjs";

const PACK = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_MODULE = join(PACK, "src", "engines", "agent-puppeteer.ts");
/** Under the pack's own (git-ignored) `.cache`, so a bundle written here finds the pack's node_modules above it. */
const SCRATCH = join(PACK, ".cache", "test-scratch");
const made: string[] = [];

function scratch(): string {
	mkdirSync(SCRATCH, { recursive: true });
	const dir = mkdtempSync(join(SCRATCH, "run-"));
	made.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A pack folder holding the agent module bundled as `app/server.mjs`: the layout the host runs. */
async function builtPack(): Promise<{ pack: string; server: string }> {
	const pack = join(scratch(), "browser");
	mkdirSync(join(pack, "app"), { recursive: true });
	writeFileSync(join(pack, "plugin.json"), "{}");
	const server = join(pack, "app", "server.mjs");
	await build({ entryPoints: [SOURCE_MODULE], outfile: server, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, logLevel: "error" });
	return { pack, server };
}

describe("the built pack loads the patched puppeteer-core from beside app/server.mjs", () => {
	test("says to run the build when app/puppeteer-agent.mjs is missing, and does not go looking for a builder", async () => {
		const { server } = await builtPack();
		const built: { agentPuppeteer(): Promise<unknown> } = await import(pathToFileURL(server).href);
		const failure = await built.agentPuppeteer().then(() => undefined, (err: unknown) => err);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("app/puppeteer-agent.mjs is missing: run the build");
	});

	test("imports the file the build wrote when it is there", async () => {
		const { pack, server } = await builtPack();
		writeFileSync(join(pack, "app", "puppeteer-agent.mjs"), 'export default { shippedBy: "the build" };\n');
		const built: { agentPuppeteer(): Promise<unknown> } = await import(pathToFileURL(server).href);
		expect(await built.agentPuppeteer()).toEqual({ shippedBy: "the build" });
	});

	test("tells the two layouts apart from the pack's own manifest, not from a fixed number of folders up", () => {
		expect(locateAgentBundle(pathToFileURL(SOURCE_MODULE).href)).toEqual({ kind: "source", pack: PACK.replace(/[\\/]$/, "") });
		expect(locateAgentBundle(pathToFileURL(join(PACK, "app", "server.mjs")).href)).toEqual({ kind: "shipped", file: join(PACK, "app", "puppeteer-agent.mjs") });
	});
});

describe("a source run's cached bundle", () => {
	/** A pack with a stub builder whose identity (what the installed library is) the test sets, and which counts its builds. */
	function stubPack(): { pack: string; identify(identity: string): void; builds(): number } {
		const pack = join(scratch(), "browser");
		mkdirSync(join(pack, "scripts"), { recursive: true });
		mkdirSync(join(pack, "patches"), { recursive: true });
		writeFileSync(join(pack, "patches", "agent.patch"), "notes\n");
		writeFileSync(
			join(pack, "scripts", "agent-puppeteer.mjs"),
			[
				'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
				'import { dirname, join } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				"const here = dirname(fileURLToPath(import.meta.url));",
				'export const PATCH_FILE = join(here, "..", "patches", "agent.patch");',
				'export function bundleIdentity() { const text = readFileSync(join(here, "identity.txt"), "utf8"); if (text.startsWith("throw:")) throw new Error(text.slice(6)); return text; }',
				'export async function buildAgentPuppeteer({ outfile }) { appendFileSync(join(here, "builds.txt"), "x"); writeFileSync(outfile, "export default {};\\n"); }',
			].join("\n"),
		);
		const identityFile = join(pack, "scripts", "identity.txt");
		return {
			pack,
			identify: (identity) => writeFileSync(identityFile, identity),
			builds: () => (existsSync(join(pack, "scripts", "builds.txt")) ? readFileSync(join(pack, "scripts", "builds.txt"), "utf8").length : 0),
		};
	}

	test("is reused while the installed puppeteer-core is the same, rebuilt when it changes, and never reused once it is not the pinned version", async () => {
		const stub = stubPack();
		stub.identify("puppeteer-core@25.11.0 esbuild@0.21.5");
		const first = await bundleFromSource(stub.pack);
		expect(await bundleFromSource(stub.pack)).toBe(first);
		expect(stub.builds()).toBe(1);

		// The library under the cache changed (another puppeteer-core, or esbuild): a file made from the old one is not the answer.
		stub.identify("puppeteer-core@25.11.0 esbuild@0.25.0");
		const second = await bundleFromSource(stub.pack);
		expect(second).not.toBe(first);
		expect(stub.builds()).toBe(2);

		// A puppeteer-core the patch was not made for fails the run even though cached bundles exist.
		stub.identify("throw:puppeteer-core 25.99.0 is installed; the agent patch is for 25.11.0.");
		await expect(bundleFromSource(stub.pack)).rejects.toThrow("25.99.0 is installed");
		expect(existsSync(first) && existsSync(second)).toBe(true);
	});
});

describe("the builder (scripts/agent-puppeteer.mjs)", () => {
	/** A folder whose node_modules hold a puppeteer-core / esbuild of the given versions, and a module path inside it to anchor lookups. It is outside the pack, so no real install is found above it. */
	function installed(versions: { puppeteer?: string; esbuild?: string }): string {
		const root = mkdtempSync(join(tmpdir(), "agent-puppeteer-installed-"));
		made.push(root);
		for (const [name, version] of [["puppeteer-core", versions.puppeteer], ["esbuild", versions.esbuild]] as const) {
			if (version === undefined) continue;
			mkdirSync(join(root, "node_modules", name), { recursive: true });
			writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
			writeFileSync(join(root, "node_modules", name, "index.js"), "");
		}
		return pathToFileURL(join(root, "anchor.mjs")).href;
	}

	test("names the installed puppeteer-core and esbuild, and refuses any puppeteer-core but the one the patch was made for", () => {
		expect(bundleIdentity(installed({ puppeteer: "25.11.0", esbuild: "0.21.5" }))).toBe("puppeteer-core@25.11.0 esbuild@0.21.5");
		expect(() => bundleIdentity(installed({ puppeteer: "25.12.0", esbuild: "0.21.5" }))).toThrow("25.12.0 is installed; the agent patch is for 25.11.0");
		expect(() => bundleIdentity(installed({ esbuild: "0.21.5" }))).toThrow("puppeteer-core is not installed");
	});

	test("heads the bundle with the patch's notes, and with them oh-my-pi's MIT notice", async () => {
		const outfile = join(scratch(), "puppeteer-agent.mjs");
		await buildAgentPuppeteer({ outfile });
		const head = readFileSync(outfile, "utf8").slice(0, 4_000);
		expect(head.startsWith("/*!")).toBe(true);
		for (const required of ["Copyright (c) 2025 Mario Zechner", "Copyright (c) 2025-2026 Can Bölük", "Copyright (c) 2026 Stencil Labs, Inc.", "Permission is hereby granted, free of charge", "this permission notice shall be included in all copies"]) {
			expect(head).toContain(required);
		}
		// The notes end where the patch's first diff begins: no hunk text leaks into the comment.
		expect(head).not.toContain("diff --git");
		expect(readFileSync(PATCH_FILE, "utf8")).toContain("Mario Zechner");
	}, 60_000);
});

describe("the patched library a throwaway browser launches with", () => {
	/** The features the single --disable-features switch of `args` turns off. */
	const disabled = (args: readonly string[]): string[] => {
		const switches = args.filter((arg) => arg.startsWith("--disable-features="));
		expect(switches).toHaveLength(1);
		return (switches[0] ?? "").slice("--disable-features=".length).split(",").filter(Boolean);
	};

	test("turns off the features puppeteer's own list does, and what the caller asks for besides", async () => {
		const patched = await agentPuppeteer();
		// A fresh object each time: puppeteer removes the switches it merges from the caller's own `args`.
		const asked = () => ({ headless: true, args: ["--disable-features=AskedFor"] });
		// Control: the stock library adds its list (Translate, AcceptCHFrame, MediaRouter, ...) to the caller's.
		const stock = disabled(await stockPuppeteer.defaultArgs(asked()));
		expect(stock).toEqual(expect.arrayContaining(["AskedFor", "AcceptCHFrame", "Translate"]));
		expect(disabled(await patched.defaultArgs(asked()))).toEqual(stock);
		const stockOwn = disabled(await stockPuppeteer.defaultArgs({ headless: true }));
		expect(stockOwn).toContain("IsolateSandboxedIframes");
		expect(disabled(await patched.defaultArgs({ headless: true }))).toEqual(stockOwn);
	}, 60_000);
});
