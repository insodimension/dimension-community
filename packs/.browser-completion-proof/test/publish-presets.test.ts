/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a shipped preset no longer
 *  finds the compose box, the button or the posted link on the page it is
 *  modelled on, so an agent's post fails (or reports no receipt); or a preset
 *  request with the wrong values or a target on another site reaches a page.
 *
 *  Each preset runs from its SHIPPED JSON (recipes/), rebased onto a local
 *  fixture copy of its platform's page (test/platform-fixtures) by the
 *  test-only `rebasePreset`: origin and composeUrl move, every selector and
 *  the receipt path stay. Real Chrome, the real MCP server over an in-memory
 *  transport, the human's Post as an app-stamped confirm. These prove the
 *  presets against the fixture copies only, never against the live sites.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PublishRecord } from "../src/contracts";
import { type PublishPreset, loadPresets } from "../src/presets";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { approvePublish, BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown } from "./fixture";
import { PLATFORM_ROUTES, type PlatformFixture, rebasePreset, startPlatformFixture } from "./platform-fixture";

const CALLER = "ai.insodimension/caller";

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
type Call = (name: string, args: Record<string, unknown>, caller?: string) => Promise<ToolResult>;

const clients: Client[] = [];
const fixtures: PlatformFixture[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of fixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const shipped = await loadPresets();

function shippedPreset(name: string): PublishPreset {
	const preset = shipped.find((candidate) => candidate.name === name);
	if (preset === undefined) throw new Error(`no shipped preset ${name}`);
	return preset;
}

interface Session {
	call: Call;
	runtime: BrowserRuntime;
	browserId: string;
	fixture: PlatformFixture;
	rootDir: string;
	profile: string;
}

/** The real MCP server offering every shipped preset rebased onto `fixtureName`'s fixture; a fresh profile signed in there. */
async function session(profile: string, fixtureName: string): Promise<Session> {
	const fixture = startPlatformFixture(fixtureName);
	fixtures.push(fixture);
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const presets = shipped.map((preset) => rebasePreset(preset, fixture.origin));
	const server = await createBrowserServer({ runtime, viewDir, presets });
	const client = new Client({ name: "publish-presets-test", version: "0.0.0" }, { capabilities: { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } });
	const sessionId = "publish-presets-chat";
	const token = randomBytes(32).toString("hex");
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		if (request.params.sessionId !== sessionId || request.params.token !== token) throw new Error("Unknown host context");
		return { active: true, sessionId };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Call = async (name, args, caller) =>
		(await client.callTool({ name, arguments: args, _meta: {
			...(caller === undefined ? {} : { [CALLER]: caller }),
			"ai.insodimension/session": { sessionId },
			[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId, token },
		} })) as ToolResult;
	const opened = await call("browser_open", { profile });
	expect(opened.isError).toBeFalsy();
	const browserId = opened.structuredContent?.browserId as string;
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/__fixture/login") });
	return { call, runtime, browserId, fixture, rootDir, profile };
}

function errorText(result: ToolResult): string {
	expect(result.isError).toBe(true);
	return result.content.map((part) => part.text ?? "").join("");
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("browser_publish_presets lists the four shipped presets, every one unverified", async () => {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime: newRuntime(rootDir), viewDir });
	const client = new Client({ name: "publish-presets-list", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);

	const listed = (await client.callTool({ name: "browser_publish_presets", arguments: {} })) as ToolResult;

	expect(listed.isError).toBeFalsy();
	expect(listed.structuredContent?.presets).toEqual([
		{ name: "bluesky-post", platform: "Bluesky", verified: false, fields: ["Post text"], needsTarget: false },
		{ name: "linkedin-post", platform: "LinkedIn", verified: false, fields: ["Post text"], needsTarget: false },
		{ name: "reddit-comment", platform: "Reddit", verified: false, fields: ["Comment"], needsTarget: true },
		{ name: "x-post", platform: "X", verified: false, fields: ["Post text"], needsTarget: false },
	]);
});

// ---------------------------------------------------------------------------
// Each preset against its fixture copy: post, the human's Post, the receipt
// ---------------------------------------------------------------------------

interface PresetCase {
	name: string;
	values: string[];
	/** The page a `composeFrom: "target"` preset posts on. */
	target?: (fixture: PlatformFixture) => string;
	/** The receipt the platform's page shows for the first post, in its real shape. */
	receipt: (fixture: PlatformFixture) => string;
}

const CASES: readonly PresetCase[] = [
	{
		name: "x-post",
		values: ["fixture post, line one\nline two ünïcødé 🚀"],
		receipt: (fixture) => fixture.url("/alice/status/1840000000000000001"),
	},
	{
		name: "bluesky-post",
		values: ["fixture skeet, line one\nline two ünïcødé 🦋"],
		receipt: (fixture) => fixture.url("/profile/alice.bsky.social/post/3lfx000000001"),
	},
	{
		name: "linkedin-post",
		values: ["fixture update, line one\n\nline three after a blank line ünïcødé"],
		receipt: (fixture) => fixture.url("/feed/update/urn:li:activity:7240000000000000001/"),
	},
	{
		name: "reddit-comment",
		values: ["fixture comment, line one\nline two ünïcødé"],
		target: (fixture) => fixture.url(PLATFORM_ROUTES["reddit-comment"] ?? ""),
		receipt: (fixture) => fixture.url("/r/fixtures/comments/1fx0abc/comment/lfx0001/"),
	},
];

describeWithChrome("presets against their fixture copies", () => {
	for (const spec of CASES) {
		test(
			`${spec.name}: fills the modelled compose box, parks as an unverified preset, and the human's Post submits once with the platform-shaped receipt`,
			async () => {
				const s = await session(`preset-${spec.name}`, spec.name);
				const preset = { name: spec.name, values: spec.values, ...(spec.target === undefined ? {} : { target: spec.target(s.fixture) }) };
				// A post goes out only if the board approved exactly this text through exactly this preset, for this profile.
				await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: spec.name, values: spec.values });

				const parked = await s.call("browser_publish", { browserId: s.browserId, preset, mode: "post" });

				expect(parked.isError, JSON.stringify(parked.content)).toBeFalsy();
				expect(parked.structuredContent).toMatchObject({
					status: "awaiting-confirmation",
					origin: s.fixture.origin,
					preset: { name: spec.name, verified: false },
					fields: shippedPreset(spec.name).fields.map((field, index) => ({ label: field.label, selector: field.selector, value: spec.values[index] })),
				});
				const record = parked.structuredContent as unknown as PublishRecord;
				expect((await s.runtime.state(s.browserId)).publish?.preset).toEqual({ name: spec.name, verified: false });
				expect(s.fixture.submissions()).toEqual([]);

				const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: record.publishId }, "app");

				expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: spec.receipt(s.fixture), preset: { name: spec.name, verified: false } });
				expect(s.fixture.submissions()).toEqual(spec.values);
			},
			BROWSER_TEST_TIMEOUT_MS,
		);
	}

	test(
		"x-post reads the signed-in handle from X's account switcher, not a mention in the display name beside it",
		async () => {
			// The fixture's switcher is X's shape: the display name ("Alice, CEO @acme") and the handle ("@alice") in sibling elements.
			const s = await session("preset-x-account", "x-post");
			const checked = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "x-post", values: ["hi"] }, mode: "check" });
			expect(checked.structuredContent).toMatchObject({ status: "signed-in", account: "@alice" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an approval for a preset's text does not cover the same text through a hand-written recipe with the preset's own selectors: refused before any page is touched, and the preset still parks",
		async () => {
			const s = await session("preset-by-hand", "x-post");
			const values = ["fixture post, approved through x-post"];
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "x-post", values });
			const x = rebasePreset(shippedPreset("x-post"), s.fixture.origin);
			const byHand = {
				origin: x.origin,
				composeUrl: x.composeUrl ?? "",
				signedIn: x.signedIn,
				fields: x.fields.map((field, index) => ({ selector: field.selector, value: values[index] ?? "" })),
				submit: x.submit,
				receipt: x.receipt,
			};

			const refused = await s.call("browser_publish", { browserId: s.browserId, recipe: byHand, mode: "post" });

			expect(refused.isError).toBe(true);
			expect(errorText(refused)).toStartWith("publish_unapproved:");
			expect(s.fixture.hits(PLATFORM_ROUTES["x-post"] ?? "")).toBe(0);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
			const parked = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "x-post", values }, mode: "post" });
			expect(parked.isError, JSON.stringify(parked.content)).toBeFalsy();
			expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a preset request that is not exactly right is refused before any page is touched",
		async () => {
			const s = await session("preset-refused", "reddit-comment");
			const thread = PLATFORM_ROUTES["reddit-comment"] ?? "";
			const publish = (args: Record<string, unknown>) => s.call("browser_publish", { browserId: s.browserId, mode: "post", ...args });
			const recipe = {
				origin: s.fixture.origin,
				composeUrl: s.fixture.url(thread),
				signedIn: "#expand-user-drawer-button",
				fields: [{ selector: "textarea", value: "x" }],
				submit: "button",
				receipt: { path: "/{segment}" },
			};

			const unknown = errorText(await publish({ preset: { name: "x-thread", values: ["hi"] } }));
			expect(unknown).toContain('unknown preset "x-thread"');
			for (const name of ["bluesky-post", "linkedin-post", "reddit-comment", "x-post"]) expect(unknown).toContain(name);
			expect(errorText(await publish({ recipe, preset: { name: "x-post", values: ["hi"] } }))).toContain("exactly one of preset or recipe");
			expect(errorText(await publish({}))).toContain("exactly one of preset or recipe");
			expect(errorText(await publish({ preset: { name: "x-post", values: ["one", "two"] } }))).toContain("x-post takes 1 value");
			expect(errorText(await publish({ preset: { name: "reddit-comment", values: ["hi"] } }))).toContain("reddit-comment needs target");
			// The same thread on another origin (same server, other host name) and a lookalike host.
			for (const target of [`http://localhost:${new URL(s.fixture.origin).port}${thread}`, `http://127.0.0.1.example${thread}`]) {
				expect(errorText(await publish({ preset: { name: "reddit-comment", values: ["hi"], target } }))).toContain(`target must be a page on ${s.fixture.origin}`);
			}
			expect(errorText(await publish({ preset: { name: "x-post", values: ["hi"], target: s.fixture.url(thread) } }))).toContain("x-post takes no target");

			// Nothing navigated: no compose page was requested, the tab is where sign-in left it, nothing is parked.
			for (const route of Object.values(PLATFORM_ROUTES)) expect(s.fixture.hits(route)).toBe(0);
			const state = await s.runtime.state(s.browserId);
			expect({ url: state.url, publish: state.publish }).toEqual({ url: s.fixture.url("/__fixture/login"), publish: null });
			expect(s.fixture.submissions()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
