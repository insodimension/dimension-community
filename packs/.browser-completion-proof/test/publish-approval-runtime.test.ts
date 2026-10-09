/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the browser pack types or posts
 *  something no human approved on the campaign board, posts one approval twice,
 *  burns an approval on a post that never went out, or refuses a post that was
 *  approved. `mode: "post"` is refused `publish_unapproved` before the compose
 *  page is opened, the confirm (the model's, or the View's Post) spends the
 *  approval just before it clicks submit, and gives it back only when the
 *  publish settles `failed` (nothing submitted).
 *
 *  The real runtime and the real MCP server over an in-memory transport (the
 *  caller stamp is the one a host sends), on a hand-written in-memory compose
 *  page instead of Chrome: the contract is what reaches the page, so the page
 *  records every effect on it (navigate, typing, click) and a refused call must
 *  leave that record empty. The stub page takes the place of a launched
 *  browser through the same private map `entryOf` (wait-inspect.test.ts) and
 *  `driverOf` (publish.test.ts) reach into. The same flows against a real page
 *  are in publish.test.ts.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import type { BrowserAction, PublishRecipe, PublishRecord } from "../src/contracts";
import type { EngineDriver, EngineState, FieldRead } from "../src/engines/types";
import type { BrowserRuntime } from "../src/runtime";
import { parsePreset } from "../src/presets";
import { confirm, prepare, validateRecipe } from "../src/publish";
import { createBrowserServer } from "../src/server";
import { ProfileStore } from "../src/store";
import { ActionNotDispatched } from "../src/store";
import { approvePublish, createRoot, newRuntime, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const ORIGIN = "https://social.example";
const COMPOSE = `${ORIGIN}/compose`;
const RECEIPT = `${ORIGIN}/alice/status/1`;
const PROFILE = "traction-x-brand";
const TEXT = "launch day \u2014 \u00fcn\u00efc\u00f8d\u00e9 \u{1F680}\nline two";
const NO_APPROVAL = "no board approval covers";
const PRESET = "stub-post";
/** A shipped preset on the stub site, with the very selectors `recipe()` writes by hand: only the approval's preset tells the two routes apart. */
const STUB_PRESET = parsePreset(
	{
		name: PRESET,
		platform: "Stub",
		verified: false,
		verifiedAt: null,
		notes: "the stub compose page",
		origin: ORIGIN,
		composeUrl: COMPOSE,
		signedIn: "#me",
		fields: [{ label: "Post text", selector: "#field-0" }],
		submit: "#post",
		receipt: { path: "/alice/status/{digits}" },
	},
	PRESET,
);

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
type Call = (name: string, args: Record<string, unknown>, caller?: string) => Promise<ToolResult>;

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

// ---------------------------------------------------------------------------
// The stub page and the session around it
// ---------------------------------------------------------------------------

/** An in-memory compose page: typed values stick, a navigation empties them, the submit moves the tab to the receipt. */
class ComposePage {
	readonly app = null;
	url = "about:blank";
	readonly fields = new Map<string, string>();
	/** Everything that changed the page, in order. A refused post must leave it empty. */
	readonly effects: string[] = [];
	/** What the site's submit does when clicked; throw to make it fail the way a real click can. */
	onSubmit: () => void = () => {
		this.url = RECEIPT;
	};

	/** Submit clicks that reached the page (a click the driver reports undispatched counts: it was attempted). */
	get clicks(): number {
		return this.effects.filter((effect) => effect === "click").length;
	}

	async state(): Promise<EngineState> {
		return {
			url: this.url,
			title: "Compose",
			documentId: `doc-${this.effects.length}`,
			viewport: { width: 1280, height: 800 },
			tabs: [],
			activeTabId: "tab-1",
			loading: false,
			canGoBack: false,
			canGoForward: false,
			dialogs: [],
		};
	}

	async perform(action: BrowserAction): Promise<Record<string, never>> {
		if (action.kind === "navigate") {
			if (action.url === undefined) throw new Error("navigation requires a URL");
			this.effects.push(`navigate ${action.url}`);
			this.url = action.url;
			this.fields.clear();
		} else if (action.kind === "click") {
			this.effects.push("click");
			this.onSubmit();
		} else {
			throw new Error(`the stub page does not do ${action.kind}`);
		}
		return {};
	}

	async hasElement(): Promise<boolean> {
		return true;
	}

	async readField(selector: string): Promise<FieldRead> {
		return { state: "value", value: this.fields.get(selector) ?? "" };
	}

	async readText(): Promise<string | null> {
		return null;
	}

	async fill(selector: string, value: string): Promise<void> {
		this.effects.push(`fill ${selector}`);
		this.fields.set(selector, value);
	}

	async linkHrefs(): Promise<string[]> {
		return [];
	}

	async close(): Promise<void> {}
}

/** Register `page` as an open browser on `profile`, as `launch` registers a launched one, and answer its browserId. */
function adopt(runtime: BrowserRuntime, profile: string, page: ComposePage): string {
	const browserId = randomBytes(24).toString("base64url");
	const entry = {
		browserId,
		profile,
		engine: "chromium",
		viewport: { width: 1280, height: 800 },
		driver: page as unknown as EngineDriver,
		documentId: "doc-0",
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
		opener: {},
		probe: { timer: undefined, running: undefined, again: false },
	};
	// Reason: test seam into the runtime's private map (as `entryOf` in wait-inspect.test.ts): a stub page in place of a launched Chrome.
	const seam = runtime as unknown as { byId: Map<string, object> };
	seam.byId.set(browserId, entry);
	return browserId;
}

interface Session {
	call: Call;
	runtime: BrowserRuntime;
	rootDir: string;
	page: ComposePage;
	browserId: string;
}

async function session(): Promise<Session> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const page = new ComposePage();
	const browserId = adopt(runtime, PROFILE, page);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [STUB_PRESET] });
	const client = new Client({ name: "publish-approval-runtime-test", version: "0.0.0" }, { capabilities: { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } });
	const token = randomBytes(32).toString("hex");
	const store = new ProfileStore(rootDir);
	store.ensureProfile(PROFILE);
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		if (request.params.sessionId !== "publish-chat" || request.params.token !== token) throw new Error("Unknown host context");
		return { active: true, sessionId: "publish-chat" };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Call = async (name, args, caller) =>
		(await client.callTool({ name, arguments: args, _meta: {
			[CALLER]: caller ?? "app",
			"ai.insodimension/session": { sessionId: "publish-chat" },
			[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId: "publish-chat", token },
		} })) as ToolResult;
	return { call, runtime, rootDir, page, browserId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recipe(values: readonly string[] = [TEXT]): PublishRecipe {
	return {
		origin: ORIGIN,
		composeUrl: COMPOSE,
		signedIn: "#me",
		fields: values.map((value, index) => ({ selector: `#field-${index}`, value })),
		submit: "#post",
		receipt: { path: "/alice/status/{digits}" },
	};
}

/** The board's approval of `values` on this site, as `profile`, through `preset` (none: a hand-written recipe). */
async function approve(s: Session, values: readonly string[] = [TEXT], profile = PROFILE, preset?: string): Promise<{ draftId: string; file: string }> {
	return await approvePublish(s.rootDir, { origin: ORIGIN, profile, values, ...(preset === undefined ? {} : { preset }) });
}

/** How a post is asked for: a recipe the caller wrote, or the shipped preset with the same selectors. */
type Route = "recipe" | "preset";

/** `browser_publish` in post mode on `browserId`, whatever comes back. */
async function publish(s: Session, values: readonly string[] = [TEXT], browserId = s.browserId, route: Route = "recipe"): Promise<ToolResult> {
	const how = route === "preset" ? { preset: { name: PRESET, values: [...values] } } : { recipe: recipe(values) };
	return await s.call("browser_publish", { browserId, ...how, mode: "post" });
}

/** Park `values` and require that it parked. */
async function park(s: Session, values: readonly string[] = [TEXT], browserId = s.browserId, route: Route = "recipe"): Promise<PublishRecord> {
	const parked = await publish(s, values, browserId, route);
	expect(parked.isError, parked.content[0]?.text).toBeFalsy();
	expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
	return parked.structuredContent as unknown as PublishRecord;
}

/** The model's confirm names what it posts (`expect`); the View's Post (`app`) is the human pressing it. */
async function confirmAs(s: Session, parked: PublishRecord, caller: "model" | "app", browserId = s.browserId): Promise<ToolResult> {
	const expectation = { origin: parked.origin, profile: parked.profile, values: parked.fields.map((field) => field.value) };
	return await s.call("browser_publish_confirm", { browserId, publishId: parked.publishId, ...(caller === "model" ? { expect: expectation } : {}) }, caller);
}

async function recordOf(s: Session, publishId: string, browserId = s.browserId): Promise<PublishRecord> {
	const waited = await s.call("browser_publish_wait", { browserId, publishId, waitSeconds: 0 });
	expect(waited.isError).toBeFalsy();
	return waited.structuredContent as unknown as PublishRecord;
}

/** The call was refused `publish_unapproved` for `reason`: an error whose message starts with the code. */
function expectRefused(result: ToolResult, reason: string): void {
	expect(result.isError).toBe(true);
	const text = result.content[0]?.text ?? "";
	expect(text).toStartWith("publish_unapproved:");
	expect(text).toContain(reason);
}

// ---------------------------------------------------------------------------
// browser_publish mode post: refused before the page
// ---------------------------------------------------------------------------

describe("browser_publish post", () => {
	test("with no approval it is refused publish_unapproved and the page is never navigated, typed in or clicked", async () => {
		const s = await session();

		const refused = await publish(s);

		expectRefused(refused, NO_APPROVAL);
		expect(refused.content[0]?.text).toContain("Nothing was typed or clicked");
		expect(s.page.effects).toEqual([]);
		expect((await s.runtime.state(s.browserId)).publish).toBeNull();
	});

	test("check mode needs no approval: it opens the compose page and types nothing", async () => {
		const s = await session();

		const checked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(), mode: "check" });

		expect(checked.isError).toBeFalsy();
		expect(checked.structuredContent?.status).toBe("signed-in");
		expect(s.page.effects).toEqual([`navigate ${COMPOSE}`]);
	});

	test("with an approval for the same text it parks typed and unclicked, and parking spends nothing: a cancelled park parks again", async () => {
		const s = await session();
		expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
		expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
		await approve(s);

		const parked = await park(s);

		expect(parked.fields.map((field) => field.value)).toEqual([TEXT]);
		expect(s.page.fields.get("#field-0")).toBe(TEXT);
		expect(s.page.clicks).toBe(0);
		const cancelled = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: parked.publishId }, "model");
		expect(cancelled.structuredContent?.status).toBe("cancelled");
		await park(s);
		expect(s.page.clicks).toBe(0);
	});

	test("text that differs from the approved text is refused before any page work, and the approved text still parks", async () => {
		const s = await session();
		await approve(s);
		const near: Array<{ name: string; values: string[] }> = [
			{ name: "one character changed", values: [TEXT.replace("launch", "lunch")] },
			{ name: "a trailing space", values: [`${TEXT} `] },
			{ name: "an extra field", values: [TEXT, "and a second field"] },
			{ name: "no field text", values: [""] },
		];

		for (const row of near) {
			const refused = await publish(s, row.values);
			expect({ name: row.name, isError: refused.isError, effects: s.page.effects }).toEqual({ name: row.name, isError: true, effects: [] });
			expectRefused(refused, NO_APPROVAL);
		}
		await park(s);
	});

	test("an approval for another profile, or another site, is refused before any page work", async () => {
		const s = await session();
		await approve(s, [TEXT], "traction-x-other");
		await approvePublish(s.rootDir, { origin: "https://elsewhere.example", profile: PROFILE, values: [TEXT] });

		const refused = await publish(s);

		expectRefused(refused, NO_APPROVAL);
		expect(s.page.effects).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// browser_publish_confirm: the spend
// ---------------------------------------------------------------------------

describe("browser_publish_confirm", () => {
	test("with the approval gone since the park it is refused, nothing is clicked, the publish stays pending, and a fresh approval lets that same publish post", async () => {
		const s = await session();
		expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
		expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
		const { file } = await approve(s);
		const parked = await park(s);
		await rm(file);

		for (const caller of ["model", "app"] as const) {
			const refused = await confirmAs(s, parked, caller);
			expect({ caller, isError: refused.isError, clicks: s.page.clicks }).toEqual({ caller, isError: true, clicks: 0 });
			expectRefused(refused, NO_APPROVAL);
			expect(refused.content[0]?.text).toContain("the publish is still pending");
			expect((await recordOf(s, parked.publishId)).status).toBe("awaiting-confirmation");
		}

		await approve(s);
		const confirmed = await confirmAs(s, parked, "app");

		expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: RECEIPT });
		expect(s.page.clicks).toBe(1);
	});

	test("a confirm refused for another reason (no expect, a wrong expect) spends nothing: the same publish then posts", async () => {
		const s = await session();
		expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
		expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
		await approve(s);
		const parked = await park(s);

		const unexpected = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "model");
		const mismatched = await s.call(
			"browser_publish_confirm",
			{ browserId: s.browserId, publishId: parked.publishId, expect: { origin: parked.origin, profile: parked.profile, values: [`${TEXT}!`] } },
			"model",
		);

		expect(unexpected.content[0]?.text).toContain("expect_required");
		expect(mismatched.content[0]?.text).toContain("publish_mismatch");
		expect(s.page.clicks).toBe(0);
		expect((await confirmAs(s, parked, "model")).structuredContent).toMatchObject({ status: "posted", url: RECEIPT });
		expect(s.page.clicks).toBe(1);
	});

	for (const caller of ["model", "app"] as const) {
		test(`the ${caller === "app" ? "View's Post" : "model's confirm"} spends the approval: the posted text cannot be parked again`, async () => {
			const s = await session();
			expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
			expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
			await approve(s);
			const parked = await park(s);

			const confirmed = await confirmAs(s, parked, caller);

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: RECEIPT });
			expect(s.page.clicks).toBe(1);
			const effects = [...s.page.effects];
			const again = await publish(s);
			expectRefused(again, "already used");
			expect(s.page.effects).toEqual(effects);
		});
	}

	test("one approval, two parked pages of the same post: the first confirm posts and the second is refused, unclicked and still pending", async () => {
		const s = await session();
		const otherPage = new ComposePage();
		const other = adopt(s.runtime, PROFILE, otherPage);
		await approve(s);
		const first = await park(s);
		const second = await park(s, [TEXT], other);

		const posted = await confirmAs(s, first, "app");
		const refused = await confirmAs(s, second, "app", other);

		expect(posted.structuredContent).toMatchObject({ status: "posted" });
		expectRefused(refused, "already used");
		expect({ first: s.page.clicks, second: otherPage.clicks }).toEqual({ first: 1, second: 0 });
		expect((await recordOf(s, second.publishId, other)).status).toBe("awaiting-confirmation");
	});

	describe("a confirm that settles", () => {
		const failures: Array<{ name: string; arrange: (s: Session) => void; error: string }> = [
			{
				name: "failed because the page changed since it was shown",
				arrange: (s) => s.page.fields.set("#field-0", "someone else typed here"),
				error: "changed since shown",
			},
			{
				name: "failed because the submit provably never dispatched",
				arrange: (s) => {
					s.page.onSubmit = () => {
						throw new ActionNotDispatched("no_element", "submit is not on the page");
					};
				},
				error: "submit was not clicked",
			},
		];
		for (const row of failures) {
			test(`${row.name} gives the approval back: the same text parks and posts afterwards`, async () => {
				const s = await session();
				expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
				expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
				await approve(s);
				const parked = await park(s);
				row.arrange(s);

				const failed = await confirmAs(s, parked, "app");

				expect(failed.structuredContent?.status).toBe("failed");
				expect(failed.structuredContent?.error).toContain(row.error);
				s.page.onSubmit = () => {
					s.page.url = RECEIPT;
				};
				const again = await park(s);
				const posted = await confirmAs(s, again, "model");
				expect(posted.structuredContent).toMatchObject({ status: "posted", url: RECEIPT });
			});
		}

		test("unknown (the click landed, then errored) keeps the approval spent: the same text is refused 'already used'", async () => {
			const s = await session();
			await approve(s);
			const parked = await park(s);
			s.page.onSubmit = () => {
				throw new Error("target closed mid-click");
			};

			const unknown = await confirmAs(s, parked, "app");

			expect(unknown.structuredContent?.status).toBe("unknown");
			expect(s.page.clicks).toBe(1);
			const effects = [...s.page.effects];
			expectRefused(await publish(s), "already used");
			expect(s.page.effects).toEqual(effects);
		});
	});
});

// ---------------------------------------------------------------------------
// The preset is part of what was approved
// ---------------------------------------------------------------------------

describe("an approval bound to a shipped preset", () => {
	for (const caller of ["model", "app"] as const) {
		test(`lets that preset post, spent by the ${caller === "app" ? "View's Post" : "model's confirm"}: the record keeps the preset and the post cannot go out again`, async () => {
			const s = await session();
			expect((await s.call("browser_open", { profile: PROFILE }, "model")).isError).toBe(true);
			expect((await s.call("browser_profile_consent", { name: PROFILE, decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
			await approve(s, [TEXT], PROFILE, PRESET);
			const parked = await park(s, [TEXT], s.browserId, "preset");
			expect(parked.preset).toMatchObject({ name: PRESET });

			const confirmed = await confirmAs(s, parked, caller);

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: RECEIPT, preset: { name: PRESET } });
			expect(s.page.clicks).toBe(1);
			const effects = [...s.page.effects];
			expectRefused(await publish(s, [TEXT], s.browserId, "preset"), "already used");
			expect(s.page.effects).toEqual(effects);
		});
	}

	test("does not cover a hand-written recipe with the approved text, site and profile: no page work, and the preset still parks", async () => {
		const s = await session();
		await approve(s, [TEXT], PROFILE, PRESET);

		const refused = await publish(s);

		expectRefused(refused, NO_APPROVAL);
		expect(s.page.effects).toEqual([]);
		await park(s, [TEXT], s.browserId, "preset");
	});

	test("an approval written without a preset does not cover the same text through a preset: no page work, and the hand-written recipe still parks", async () => {
		const s = await session();
		await approve(s);

		const refused = await publish(s, [TEXT], s.browserId, "preset");

		expectRefused(refused, NO_APPROVAL);
		expect(s.page.effects).toEqual([]);
		await park(s);
	});

	test("an approval for another preset is refused through this one", async () => {
		const s = await session();
		await approve(s, [TEXT], PROFILE, "bluesky-post");

		const refused = await publish(s, [TEXT], s.browserId, "preset");

		expectRefused(refused, NO_APPROVAL);
		expect(s.page.effects).toEqual([]);
	});
});

describe("publication authority at the actual page boundary", () => {
	test("revocation while re-reading the parked draft prevents submit", async () => {
		const page = new ComposePage();
		const prepared = await prepare(page as unknown as EngineDriver, PROFILE, validateRecipe(recipe()), "post");
		if (!("record" in prepared)) throw new Error("Expected a parked publication");
		let authorized = true;
		let reading!: () => void;
		let release!: () => void;
		const entered = new Promise<void>(resolve => { reading = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const originalRead = page.readField.bind(page);
		page.readField = async selector => {
			reading();
			await gate;
			return originalRead(selector);
		};
		const assertCurrent = () => {
			if (!authorized) throw new Error("host context revoked");
		};
		const settling = confirm(page as unknown as EngineDriver, prepared, Object.assign(assertCurrent, { assertCurrent }));
		await entered;
		authorized = false;
		release();
		await settling;
		expect(prepared.record.status).toBe("failed");
		expect(page.clicks).toBe(0);
	}, 30_000);

	test("revocation after an accepted click reports unknown and never submits again", async () => {
		const page = new ComposePage();
		const prepared = await prepare(page as unknown as EngineDriver, PROFILE, validateRecipe(recipe()), "post");
		if (!("record" in prepared)) throw new Error("Expected a parked publication");
		let authorized = true;
		page.onSubmit = () => {
			page.url = RECEIPT;
			authorized = false;
		};
		const assertCurrent = () => {
			if (!authorized) throw new Error("host context revoked");
		};
		await confirm(page as unknown as EngineDriver, prepared, Object.assign(assertCurrent, { assertCurrent }));
		expect(prepared.record.status).toBe("unknown");
		expect(page.clicks).toBe(1);
	}, 30_000);
});

describe("approval ownership across authority loss", () => {
	test("revocation while the parked draft is re-read prevents submit and restores the unspent approval", async () => {
		const s = await session();
		await approve(s);
		const parked = await park(s);
		let authorized = true;
		let reading!: () => void;
		let release!: () => void;
		const entered = new Promise<void>(resolve => { reading = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const read = s.page.readField.bind(s.page);
		s.page.readField = async selector => {
			reading();
			await gate;
			return read(selector);
		};
		const assertCurrent = () => {
			if (!authorized) throw new Error("host context revoked");
		};
		const confirming = s.runtime.confirmPublish(s.browserId, parked.publishId, "app", undefined, Object.assign(assertCurrent, { assertCurrent }));
		await entered;
		authorized = false;
		release();
		const refused = await confirming;
		expect(refused.status).toBe("failed");
		expect(s.page.clicks).toBe(0);
		s.page.readField = read;
		const again = await park(s);
		expect(again.status).toBe("awaiting-confirmation");
	});

	test("revocation after accepted submit cannot restore the approval or replay the click", async () => {
		const s = await session();
		await approve(s);
		const parked = await park(s);
		let authorized = true;
		s.page.onSubmit = () => {
			s.page.url = RECEIPT;
			authorized = false;
		};
		const assertCurrent = () => {
			if (!authorized) throw new Error("host context revoked");
		};
		const uncertain = await s.runtime.confirmPublish(s.browserId, parked.publishId, "app", undefined, Object.assign(assertCurrent, { assertCurrent }));
		expect(uncertain.status).toBe("unknown");
		expect(s.page.clicks).toBe(1);
		expectRefused(await publish(s), "already used");
		expect(s.page.clicks).toBe(1);
	});
});
