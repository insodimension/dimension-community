/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a name a person or an agent
 *  types for a profile becomes a path it should not — a folder outside the
 *  profile root, a drive, a hidden entry — or the dock panel starts a sign-in on
 *  a name the runtime then refuses, or a label with a space ("Work Account")
 *  never reaches the runtime that knows which profile it names.
 *
 *  `profileSlug` (src/profile-name.ts) is the ONE rule for what may be a folder.
 *  `browser_open` takes a slug OR a label, so its door (the input schema) only
 *  refuses what no name can be — empty, or longer than a label — and the
 *  runtime decides the rest: a name is a folder only when it IS a slug, and
 *  otherwise only a label that already names a profile. Both halves run here
 *  over one table: the real MCP server over a recording fake runtime (what gets
 *  through the door), and the real runtime with no browser to launch (what ever
 *  becomes a folder).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserOpenOptions, BrowserRuntimePort, BrowserState } from "../src/contracts";
import { MAX_LABEL_CHARS } from "../src/profile-meta";
import { profileSlug } from "../src/profile-name";
import { createBrowserServer } from "../src/server";
import { BrowserRuntimeError, validateProfile } from "../src/store";
import { createRoot, newRuntime, teardown } from "./fixture";

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

/** The runtime the server needs to boot and answer `browser_open`, recording each profile it was asked to open. */
function recordingRuntime(opened: Array<string | undefined>): BrowserRuntimePort {
	const runtime: Pick<BrowserRuntimePort, "open" | "connections" | "profileMeta" | "onConnectionsChanged" | "dispose"> = {
		open: async ({ profile }: BrowserOpenOptions) => {
			opened.push(profile);
			return { browserId: "b".repeat(32), profile, tabs: [] } as unknown as BrowserState;
		},
		connections: async () => ({}),
		profileMeta: async () => ({}),
		onConnectionsChanged: () => () => {},
		dispose: async () => {},
	};
	return runtime as BrowserRuntimePort;
}

/** Each row: what a person might type, and the slug the rule makes of it (null: refused). */
const NAMES: ReadonlyArray<{ readonly raw: string; readonly slug: string | null }> = [
	{ raw: "work", slug: "work" },
	{ raw: "0", slug: "0" },
	{ raw: "traction-x-acme", slug: "traction-x-acme" },
	{ raw: "a_b-9", slug: "a_b-9" },
	{ raw: "a".repeat(48), slug: "a".repeat(48) },
	{ raw: "a".repeat(49), slug: null },
	{ raw: "Work", slug: "work" },
	{ raw: "  Personal  ", slug: "personal" },
	{ raw: "Bad Name!", slug: null },
	{ raw: "", slug: null },
	{ raw: "   ", slug: null },
	{ raw: "-lead", slug: null },
	{ raw: "_lead", slug: null },
	{ raw: "a.b", slug: null },
	{ raw: "..", slug: null },
	{ raw: "a/b", slug: null },
	{ raw: "a\\b", slug: null },
	{ raw: "c:", slug: null },
	{ raw: "a\u0000b", slug: null },
	{ raw: "café", slug: null },
	{ raw: "two words", slug: null },
];

async function connect(runtime: BrowserRuntimePort): Promise<Client> {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "profile-name-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return client;
}

test("the door of browser_open refuses only what no name can be (empty, or longer than a label); anything else, a label with spaces included, reaches the runtime as typed", async () => {
	const opened: string[] = [];
	const client = await connect(recordingRuntime(opened));
	for (const { raw } of NAMES) {
		const before = opened.length;
		const call = await client.callTool({ name: "browser_open", arguments: { profile: raw } });
		const canBeAName = raw.length >= 1 && raw.length <= MAX_LABEL_CHARS;
		expect({ raw, reached: opened.length > before, refused: Boolean(call.isError) }).toEqual({ raw, reached: canBeAName, refused: !canBeAName });
	}
	// What reached the runtime is exactly what was typed: the door never rewrites a name into another.
	expect(opened).toEqual(NAMES.map(({ raw }) => raw).filter((raw) => raw.length >= 1 && raw.length <= MAX_LABEL_CHARS));
});

test("whatever gets through the door becomes a folder only by the slug rule: unsafe and unknown names create nothing, valid slugs create their own folder", async () => {
	const rootDir = await createRoot();
	// No browser to launch: a name the runtime accepts as a new profile fails at launch, after its folder is made.
	const runtime = newRuntime(rootDir, { executablePath: join(rootDir, "no-such-chrome") });
	const rows: Array<{ raw: string; slug: string | null; filesystem: string | null; code: string | null }> = [];
	for (const { raw } of NAMES) {
		let filesystem: string | null;
		try {
			filesystem = validateProfile(raw);
		} catch {
			filesystem = null;
		}
		const refused = await runtime.open({ profile: raw }).then(
			() => undefined,
			(error: unknown) => (error instanceof BrowserRuntimeError ? error.code : "other"),
		);
		rows.push({ raw, slug: profileSlug(raw), filesystem, code: refused === "profile_unknown" ? refused : null });
	}
	expect(rows).toEqual(NAMES.map(({ raw, slug }) => ({ raw, slug, filesystem: slug, code: slug === null ? "profile_unknown" : null })));
	// The folders on disk are the valid slugs and nothing else: no `..`, no `a`, no `c:`.
	expect((await readdir(join(rootDir, "profiles"))).sort()).toEqual([...new Set(NAMES.flatMap(({ slug }) => (slug === null ? [] : [slug])))].sort());
});
