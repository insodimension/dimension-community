/**
 * The puppeteer-core a THROWAWAY AGENT browser is driven with.
 *
 * Stock puppeteer-core turns on CDP `Runtime` in every page, frame and worker
 * (a page can tell: `agent-browser.ts`), runs its own DOM reads in the page's
 * own JavaScript world (a hook a site put on `document.getElementById` sees
 * every one), and names its scripts in V8 stacks. For an agent browser that is
 * the most-probed automation tell, so it is driven with the same library with
 * `patches/puppeteer-core-25.11.0-agent.patch` applied while bundling
 * (`scripts/agent-puppeteer.mjs`): no `Runtime.enable`, DOM work in the
 * utility world, no script names.
 *
 * The View and every saved profile import the stock `puppeteer-core` and never
 * this module (`puppeteer.ts` picks by `EngineOptions.agent`), so nothing here
 * can reach a browser a person signs in to.
 *
 * The build writes `app/puppeteer-agent.mjs` next to `app/server.mjs`, and the
 * running bundle loads exactly that file: it is never built at run time, so an
 * install without it says so (`locateAgentBundle`) rather than looking for a
 * builder the install does not ship. Run from source (tests, `bun src/stdio.ts`)
 * there is no such file, so it is bundled once into `.cache/` beside the pack
 * (where its package imports resolve) under a name that carries a hash of the
 * patch, the builder and the installed library's version.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type StockPuppeteer from "puppeteer-core";
import { fail } from "../store.js";

export type PuppeteerModule = typeof StockPuppeteer;

/** Where the patched library comes from, decided by where this module is running. */
export type AgentBundle =
	/** Run from the built `app/server.mjs`: the file the build wrote beside it. */
	| { kind: "shipped"; file: string }
	/** Run from `src/`: bundled from the pack's own patch and builder on first use. */
	| { kind: "source"; pack: string };

/**
 * The pack's root, the folder that holds its `plugin.json`, found from the folder of the running module. This module is
 * `packs/browser/src/engines/agent-puppeteer.ts` in a source run and inlined into `packs/browser/app/server.mjs` in the
 * built one, so a fixed `../..` is right for one and a folder too high for the other.
 */
function packRootOf(folder: string): string {
	for (let at = folder; ; at = dirname(at)) {
		if (existsSync(join(at, "plugin.json"))) return at;
		if (dirname(at) === at) throw new Error(`no plugin.json above ${folder}: this is not running inside the browser pack`);
	}
}

/** Which of the two layouts the module at `moduleUrl` is running in, and where each finds the patched library. */
export function locateAgentBundle(moduleUrl: string): AgentBundle {
	const folder = dirname(fileURLToPath(moduleUrl));
	const pack = packRootOf(folder);
	return folder === join(pack, "app") ? { kind: "shipped", file: join(pack, "app", "puppeteer-agent.mjs") } : { kind: "source", pack };
}

let loading: Promise<PuppeteerModule> | undefined;

/** The patched puppeteer-core, loaded once per process. */
export function agentPuppeteer(): Promise<PuppeteerModule> {
	loading ??= load();
	return loading;
}

async function load(): Promise<PuppeteerModule> {
	const where = locateAgentBundle(import.meta.url);
	let file: string;
	if (where.kind === "source") file = await bundleFromSource(where.pack);
	else if (existsSync(where.file)) file = where.file;
	else fail("launch_failed", "app/puppeteer-agent.mjs is missing: run the build (`bun run build` in the browser pack) and ship the file with app/server.mjs");
	// Dynamic by necessity: the patched library is a build output, not a module the source tree can name.
	const bundled: { default: PuppeteerModule } = await import(pathToFileURL(file).href);
	return bundled.default;
}

/** The build step's own module (scripts/agent-puppeteer.mjs). */
interface Builder {
	PATCH_FILE: string;
	/** The installed puppeteer-core and esbuild, as a string; throws when puppeteer-core is not the version the patch was made for. */
	bundleIdentity(): string;
	buildAgentPuppeteer(options: { outfile: string }): Promise<unknown>;
}

/**
 * The patched library for a source run, bundled into `<pack>/.cache` by the pack's own builder. The installed library is
 * checked on EVERY call, before a cached file is looked at, and its version names the cache file: a cached bundle of an
 * older puppeteer-core is never reused against a newer one.
 */
export async function bundleFromSource(pack: string): Promise<string> {
	// A computed specifier, dynamic by necessity: the server bundle must not follow it into the build script (and esbuild).
	const builderPath = join(pack, "scripts", "agent-puppeteer.mjs");
	const builder: Builder = await import(pathToFileURL(builderPath).href);
	const identity = builder.bundleIdentity();
	const hash = createHash("sha256").update(readFileSync(builder.PATCH_FILE)).update(readFileSync(builderPath)).update(identity).digest("hex").slice(0, 12);
	const outfile = join(pack, ".cache", `puppeteer-agent-${hash}.mjs`);
	if (existsSync(outfile)) return outfile;
	mkdirSync(dirname(outfile), { recursive: true });
	// Written beside its final name and moved into place, so two processes starting together never import half a file.
	const partial = `${outfile}.${process.pid}.tmp`;
	await builder.buildAgentPuppeteer({ outfile: partial });
	renameSync(partial, outfile);
	return outfile;
}
