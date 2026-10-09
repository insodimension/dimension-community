/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: browsers an agent opens "just
 *  to look" pile up on the person's disk as fake profiles (the start page lists
 *  them, every run adds more), or a throwaway browser is treated as a place to
 *  keep a login — a password minted into a directory that is deleted a second
 *  later, a "signed in" report for a session nobody can reopen — or the sweep
 *  that cleans up after a crashed server deletes a browser that is still
 *  running, or a saved profile.
 *
 *  A browser opened without a profile is throwaway (`BrowserState.profile ===
 *  null`): its own directory under `<root>/ephemeral`, no lock, gone when it
 *  closes. These tests use real Chrome and real directories in temp roots.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PublishRecipe } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, failureCode, newRuntime, teardown } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const entries = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort();

interface ToolResult {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}

/** The real MCP server over `runtime`, reached the way a host reaches it. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<(name: string, args: Record<string, unknown>, caller?: "app") => Promise<ToolResult>> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "ephemeral-test", version: "0.0.0" }, { capabilities: { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } });
	const sessionId = "ephemeral-chat";
	const token = randomBytes(32).toString("hex");
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		if (request.params.sessionId !== sessionId || request.params.token !== token) throw new Error("Unknown host context");
		return { active: true, sessionId };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (name, args, caller) => (await client.callTool({ name, arguments: args, _meta: {
		"ai.insodimension/caller": caller ?? "model",
		"ai.insodimension/session": { sessionId },
		[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId, token },
	} })) as ToolResult;
}

/** A pid that is provably gone: a child that already exited. */
async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", ""]);
	await child.exited;
	return child.pid;
}

describeWithChrome("throwaway browsers", () => {
	test(
		"a browser opened without a profile leaves nothing on disk once it is closed or the runtime is disposed",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const ephemeral = join(rootDir, "ephemeral");

			const first = await runtime.open({ viewport: VIEWPORT });
			expect(first.profile).toBeNull();
			// Not vacuous: the browser really ran in a directory of its own.
			const [id] = await entries(ephemeral);
			expect(await entries(ephemeral)).toHaveLength(1);
			expect(existsSync(join(ephemeral, id as string, "chrome"))).toBe(true);
			expect(await entries(join(rootDir, "profiles"))).toEqual([]);

			await runtime.close(first.browserId);
			expect(await entries(ephemeral)).toEqual([]);

			await runtime.open({ viewport: VIEWPORT });
			expect(await entries(ephemeral)).toHaveLength(1);
			await runtime.dispose();
			expect(await entries(ephemeral)).toEqual([]);
			expect(await entries(join(rootDir, "profiles"))).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"browser_open needs no profile, and browser_profiles lists saved profiles only",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const call = await connect(runtime, rootDir);

			const throwaway = await call("browser_open", {});
			expect(throwaway.isError).toBeFalsy();
			expect(throwaway.structuredContent?.profile).toBeNull();
			// The model gets compact text; the View in the same authenticated chat gets structured content.
			expect((await call("browser_profiles", {})).structuredContent).toBeUndefined();
			expect(await call("browser_profiles", {}, "app")).toMatchObject({ structuredContent: { profiles: [] } });

			const kept = await call("browser_open", { profile: "kept" });
			expect(kept.structuredContent?.profile).toBe("kept");
			expect((await call("browser_profiles", {}, "app")).structuredContent).toMatchObject({ profiles: [{ name: "kept", label: "kept", heldBy: "this chat", sites: [] }] });
			expect((await runtime.profileList()).map((profile) => profile.name)).toEqual(["kept"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"throwaway browsers coexist without a lock while a saved profile stays exclusive, and closing one leaves the others alone",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const ephemeral = join(rootDir, "ephemeral");

			const a = await runtime.open({ viewport: VIEWPORT });
			const b = await runtime.open({ viewport: VIEWPORT });
			expect(a.browserId).not.toBe(b.browserId);
			expect(await entries(ephemeral)).toHaveLength(2);

			await runtime.open({ profile: "shared", viewport: VIEWPORT }, { caller: "app" });
			expect(await failureCode(() => runtime.open({ profile: "shared", viewport: VIEWPORT }, { caller: "app" }))).toBe("profile_held");

			await runtime.close(a.browserId);
			expect(await entries(ephemeral)).toHaveLength(1);
			expect((await runtime.state(b.browserId)).profile).toBeNull();
			expect(existsSync(join(rootDir, "profiles", "shared", "chrome"))).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"anything that needs a saved profile — publishing, a saved password, a task credential — refuses a throwaway browser before touching the page",
		async () => {
			const { runtime } = await createRuntime();
			const { browserId, url } = await runtime.open({ viewport: VIEWPORT });
			const recipe: PublishRecipe = {
				origin: "https://example.com",
				composeUrl: "https://example.com/compose",
				signedIn: "#me",
				fields: [{ selector: "#text", value: "hello" }],
				submit: "#go",
				receipt: { path: "/post/{digits}" },
			};

			expect(await failureCode(() => runtime.publish(browserId, recipe, "check"))).toBe("profile_required");
			expect(await failureCode(() => runtime.act(browserId, { kind: "type", selector: "#p", generatePassword: true }))).toBe("profile_required");
			expect(await failureCode(() => runtime.act(browserId, { kind: "type", selector: "#p", useSavedPassword: true }))).toBe("profile_required");
			expect(
				await failureCode(() => runtime.startTask(browserId, { task: "sign up", credential: { origin: "https://example.com", mode: "signup" } })),
			).toBe("profile_required");

			expect((await runtime.state(browserId)).url).toBe(url);
			expect(await runtime.connections()).toEqual({});
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a start never sweeps a throwaway browser that a running Chrome still holds, even when its recorded server is gone",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const ephemeral = join(rootDir, "ephemeral");
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			const [id] = await entries(ephemeral);
			const dir = join(ephemeral, id as string);
			// A file Chrome never touches but a sweep would delete (a running Chrome writes to its own files as we look).
			const canary = join(dir, "chrome", "canary.txt");
			await writeFile(canary, "still here");

			// The server that made it was killed; its Chrome kept running.
			await writeFile(join(dir, "owner.pid"), String(await deadPid()));
			newRuntime(rootDir);

			expect(existsSync(join(dir, "owner.pid"))).toBe(true);
			expect(existsSync(canary)).toBe(true);
			expect((await runtime.state(browserId)).browserId).toBe(browserId);

			await runtime.close(browserId);
			expect(await entries(ephemeral)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

test("a start sweeps throwaway browsers a dead server abandoned, and nothing a live one owns or that is not throwaway", async () => {
	const rootDir = await createRoot();
	const plant = async (parent: "ephemeral" | "profiles", name: string, owner?: number): Promise<string> => {
		const dir = join(rootDir, parent, name);
		await mkdir(join(dir, "chrome"), { recursive: true });
		await writeFile(join(dir, "chrome", "Cookies"), "session");
		if (owner !== undefined) await writeFile(join(dir, "owner.pid"), String(owner));
		return dir;
	};
	const dead = await deadPid();
	const live = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], { stdin: "pipe" });
	try {
		const abandoned = await plant("ephemeral", "abandoned", dead);
		const running = await plant("ephemeral", "running", live.pid);
		const unmarked = await plant("ephemeral", "unmarked");
		// The marker means nothing outside ephemeral/: a saved profile is never swept.
		const saved = await plant("profiles", "saved", dead);

		newRuntime(rootDir);

		expect(existsSync(abandoned)).toBe(false);
		expect(existsSync(running)).toBe(true);
		expect(existsSync(unmarked)).toBe(true);
		expect(existsSync(join(saved, "chrome", "Cookies"))).toBe(true);
	} finally {
		live.kill();
		await live.exited;
	}
});
