/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent cannot post from a
 *  saved profile a Traction account posts from without a human approving it
 *  first.
 *
 *  A stub page stands in for the site (no Chrome): it records what was typed
 *  and what a click or Enter posted.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserAction } from "../src/contracts";
import type { EngineDriver, EngineState } from "../src/engines/types";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ProfileStore } from "../src/store";
import { createRoot, newRuntime, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "submit-chat";
const ORIGIN = "https://social.example";
const TEXT = "launch day \u2014 \u00fcn\u00efc\u00f8d\u00e9 \u{1F680}\nline two";

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
}

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

class SocialPage {
	readonly app = null;
	url = `${ORIGIN}/compose`;
	readonly fields = new Map<string, string>([["#composer", ""]]);
	readonly tabId = "tab-1";
	readonly posted: string[][] = [];

	async state(): Promise<EngineState> {
		return {
			url: this.url,
			title: "Compose",
			documentId: "doc-1",
			viewport: { width: 1280, height: 800 },
			tabs: [{ id: this.tabId, title: "Compose", url: this.url, active: true, loading: false, favicon: null }],
			activeTabId: this.tabId,
			loading: false,
			canGoBack: false,
			canGoForward: false,
			dialogs: [],
		};
	}

	async perform(action: BrowserAction): Promise<Record<string, never>> {
		switch (action.kind) {
			case "type": {
				if (!this.fields.has(action.selector as string)) throw new Error(`no field ${action.selector}`);
				this.fields.set(action.selector as string, action.text as string);
				break;
			}
			case "press":
				if (action.key === "Enter") this.post();
				break;
			case "click":
				if (action.selector === "#post") this.post();
				break;
			default:
				throw new Error(`the stub page does not do ${action.kind}`);
		}
		return {};
	}

	post(): void {
		this.posted.push([...this.fields.values()].filter((value) => value !== ""));
		for (const key of this.fields.keys()) this.fields.set(key, "");
	}

	logs(): [] {
		return [];
	}

	async activateTab(): Promise<void> {}

	async close(): Promise<void> {}
}

function adopt(runtime: BrowserRuntime, profile: string, page: SocialPage): string {
	const browserId = randomBytes(24).toString("base64url");
	const entry = {
		browserId,
		profile,
		engine: "chromium",
		viewport: { width: 1280, height: 800 },
		driver: page as unknown as EngineDriver,
		documentId: "doc-1",
		url: page.url,
		title: "Compose",
		release: () => undefined,
		revision: 1,
		frames: [],
		queue: Promise.resolve(),
		inputQueue: Promise.resolve(),
		closed: false,
		task: null,
		worker: null,
		publish: null,
		secrets: new Set<string>(),
		logRead: 0,
		logNoticed: 0,
		openers: new Map([[SESSION, { caller: "model", session: SESSION }]]),
		tabOwners: new Map([["tab-1", SESSION]]),
		tabActive: new Map([[SESSION, "tab-1"]]),
		takenOver: false,
		starting: null,
		agentAt: null,
		look: null,
		probe: { timer: undefined, relook: undefined, running: undefined, again: false },
		lastUsed: performance.now(),
		viewers: 0,
		pending: 0,
		cells: 0,
		idle: undefined,
		retiring: undefined,
		closeFailed: false,
		wheelTimer: undefined,
	};
	const registry = runtime as unknown as { byId: Map<string, object> };
	registry.byId.set(browserId, entry);
	return browserId;
}

interface Session {
	page: SocialPage;
	client: Client;
	call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

async function session(profile: string, registry?: readonly string[]): Promise<Session> {
	const rootDir = await createRoot();
	if (registry !== undefined) await writeFile(join(rootDir, "publish-profiles.json"), JSON.stringify({ v: 1, profiles: registry }));
	const runtime = newRuntime(rootDir);
	const page = new SocialPage();
	const browserId = adopt(runtime, profile, page);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	new ProfileStore(rootDir).ensureProfile(profile);
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "submit-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const meta = { [CALLER]: "model", "ai.insodimension/session": { sessionId: SESSION } };
	const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
		(await client.callTool({ name, arguments: { browserId, ...args }, _meta: meta })) as ToolResult;
	return { page, client, call };
}

function textOf(result: ToolResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("posting from a saved profile asks nobody", () => {
	for (const [name, profile, registry] of [
		["a traction-* profile", "traction-social-brand", undefined],
		["the person's own profile a Traction account posts from", "godofrock", ["godofrock"]],
	] as const) {
		test(`browser_act types and posts on ${name}, with no approval record on disk`, async () => {
			const s = await session(profile, registry);
			const result = await s.call("browser_act", { actions: [{ kind: "type", selector: "#composer", text: TEXT }, { kind: "click", selector: "#post" }] });
			expect(result.isError ?? false, textOf(result)).toBe(false);
			expect(s.page.posted).toEqual([[TEXT]]);
		});
	}

	test("Enter posts as a click does, and there is no separate ask-first submit tool", async () => {
		const s = await session("traction-social-brand");
		expect((await s.client.listTools()).tools.map((tool) => tool.name)).not.toContain("browser_submit");

		const result = await s.call("browser_act", { actions: [{ kind: "type", selector: "#composer", text: TEXT }, { kind: "press", key: "Enter" }] });

		expect(result.isError ?? false, textOf(result)).toBe(false);
		expect(s.page.posted).toEqual([[TEXT]]);
	});
});
