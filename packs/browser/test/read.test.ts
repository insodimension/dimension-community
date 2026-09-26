/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a scout reads a page it was
 *  refused and reports it as read, or goes around the refusal. browser_read is
 *  the one logged-out read path: it returns a page's text, or `blocked` with
 *  the reason — an HTTP refusal, a login wall, a CAPTCHA — and it never reads
 *  through a mirror or proxy host, never on the human's profile while a
 *  publish there awaits the Post.
 *
 *  Real Chrome against local fixture pages (fixture.ts). The mirror case uses
 *  `redlib.localhost`, which Chrome resolves to the fixture, so a read that got
 *  past the refusal would show up in the fixture's hit count. The CAPTCHA case
 *  embeds `/recaptcha/…` from the fixture: reCAPTCHA's own signature is that
 *  path (www.google.com/recaptcha/…, www.gstatic.com/recaptcha/…), so the
 *  production matcher sees it on a loopback host without an injected list.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isMirrorHost, MIRROR_REASON } from "../src/read";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ARTICLE_TEXT, BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, failureCode, newRuntime, perform, startFixture, teardown } from "./fixture";
import { startPublishFixture, type PublishFixture } from "./publish-fixture";

const clients: Client[] = [];
const publishFixtures: PublishFixture[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of publishFixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** The real MCP server over `runtime`, as a host would call it. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<Client> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "read-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return client;
}

test("mirror and proxy hosts are matched by name, not by resemblance", () => {
	const mirrors = ["safereddit.com", "www.safereddit.com", "redlib.catsarch.com", "libreddit.kavin.rocks", "teddit.net", "nitter.poast.org", "api.pullpush.io", "r.jina.ai", "web.archive.org", "archive.ph", "archive.today", "NITTER.NET."];
	const sites = ["reddit.com", "old.reddit.com", "x.com", "pullpush.io", "jina.ai", "archive.org", "myredlib.com", "notnitter.net", "safereddit.com.example"];
	expect(mirrors.filter((host) => !isMirrorHost(host))).toEqual([]);
	expect(sites.filter((host) => isMirrorHost(host))).toEqual([]);
});

describeWithChrome("browser_read", () => {
	test(
		"reads a page's text on the default \"read\" profile, through the tool a model sees as read-only",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const client = await connect(runtime, rootDir);

			const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "browser_read");
			expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
			const result = await client.callTool({ name: "browser_read", arguments: { url: fixture.url("/article") } });

			expect(result.isError).toBeFalsy();
			const read = result.structuredContent as Record<string, unknown>;
			expect(read).toMatchObject({ status: "ok", url: fixture.url("/article"), title: "fixture article" });
			expect(read.text).toBe(`Field notes\n\n${ARTICLE_TEXT}`);
			expect(read.truncated).toBeUndefined();
			expect(await runtime.profiles()).toEqual(["read"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"cuts the text at maxChars and says so",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			const read = await runtime.read({ url: fixture.url("/article"), maxChars: 40 });

			expect(read).toEqual({ status: "ok", url: fixture.url("/article"), title: "fixture article", text: `Field notes\n\n${ARTICLE_TEXT}`.slice(0, 40), truncated: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an HTTP refusal is blocked with its status",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			expect(await runtime.read({ url: fixture.url("/forbidden") })).toEqual({ status: "blocked", url: fixture.url("/forbidden"), reason: "HTTP 403" });
			expect(await runtime.read({ url: fixture.url("/unavailable") })).toEqual({ status: "blocked", url: fixture.url("/unavailable"), reason: "HTTP 503" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a redirect to a sign-in page is a login wall, reported at the URL it landed on",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			const read = await runtime.read({ url: fixture.url("/private") });

			expect(read).toEqual({ status: "blocked", url: fixture.url("/accounts/login?next=/private"), reason: "login wall: the page is a sign-in page" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a visible password field is a login wall; a hidden one is not",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			expect(await runtime.read({ url: fixture.url("/password-gate") })).toEqual({ status: "blocked", url: fixture.url("/password-gate"), reason: "login wall: the page shows a password field" });
			expect(await runtime.read({ url: fixture.url("/hidden-password") })).toMatchObject({ status: "ok", text: "public post" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an embedded CAPTCHA is a bot check",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			const read = await runtime.read({ url: fixture.url("/captcha") });

			expect(read).toEqual({ status: "blocked", url: fixture.url("/captcha"), reason: `CAPTCHA or bot check: the page embeds ${fixture.url("/recaptcha/api2/anchor")}` });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a mirror host is refused before anything launches or navigates",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const mirror = fixture.url("/article").replace("127.0.0.1", "redlib.localhost");

			const read = await runtime.read({ url: mirror });

			expect(read).toEqual({ status: "blocked", url: mirror, reason: MIRROR_REASON });
			expect(fixture.hits("/article")).toBe(0);
			expect(await runtime.profiles()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a profile with a publish awaiting the human's Post is refused, and its page is left alone",
		async () => {
			const site = startPublishFixture();
			publishFixtures.push(site);
			const runtime = newRuntime(await createRoot());
			const opened = await runtime.open({ profile: "poster" });
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("/login") });
			const parked = await runtime.publish(opened.browserId, {
				origin: site.origin,
				composeUrl: site.url("/compose?v=nav"),
				signedIn: "#me",
				fields: [{ selector: "#text", value: "hello" }],
				submit: "#post",
				receipt: { path: "/alice/status/{digits}" },
			}, "post");
			expect(parked).toMatchObject({ status: "awaiting-confirmation" });

			const code = await failureCode(() => runtime.read({ url: site.url("/compose?v=nav"), profile: "poster" }));

			expect(code).toBe("publish_pending");
			expect(site.hits("/compose")).toBe(1);
			expect((await runtime.state(opened.browserId)).url).toBe(site.url("/compose?v=nav"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
