/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a scout reads a page it was
 *  refused and reports it as read, reads as a signed-in user, reaches the
 *  user's own machine or LAN, or goes around a refusal. browser_read is the
 *  one logged-out read path: it returns a page's text, or `blocked` with the
 *  reason — an HTTP refusal, a login wall, a CAPTCHA, a mirror/proxy host, a
 *  private address — and it never keeps the human from their own browsers.
 *
 *  Real Chrome against local fixture pages (fixture.ts). The fixture lives on
 *  127.0.0.1, which the reader refuses like any private address, so these
 *  runtimes exempt exactly that host (`allowPrivateReadHosts`, a test-only
 *  constructor option). `localhost` and `redlib.localhost` reach the same
 *  server but are NOT exempt, so a read that got past a refusal shows up in
 *  the fixture's hit count. The CAPTCHA pages frame `/recaptcha/…` from the
 *  fixture: reCAPTCHA's signature is that path on any host.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isMirrorHost, isPrivateAddress, MIRROR_REASON, readPolicy } from "../src/read";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ARTICLE_TEXT, BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, startFixture, teardown } from "./fixture";

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** A runtime whose reader may reach the fixture's 127.0.0.1 and nothing else private. */
async function readRuntime(): Promise<{ runtime: BrowserRuntime; rootDir: string }> {
	const rootDir = await createRoot();
	return { runtime: newRuntime(rootDir, { allowPrivateReadHosts: ["127.0.0.1"] }), rootDir };
}

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

const PRIVATE_REASON = (host: string): string => `private address: ${host} is loopback, private or link-local; browser_read reads the public web only`;

test("mirror and proxy hosts are matched by name, not by resemblance", () => {
	const mirrors = [
		"safereddit.com", "www.safereddit.com", "redlib.catsarch.com", "libreddit.kavin.rocks", "teddit.net", "nitter.poast.org", "xcancel.com",
		"api.pullpush.io", "r.jina.ai", "12ft.io", "web.archive.org", "archive.ph", "archive.today", "archive.is", "archive.li", "archive.vn",
		"archive.md", "archive.fo", "webcache.googleusercontent.com", "www-reddit-com.translate.goog", "NITTER.NET.",
	];
	const sites = ["reddit.com", "old.reddit.com", "x.com", "pullpush.io", "jina.ai", "archive.org", "myredlib.com", "notnitter.net", "safereddit.com.example", "translate.google.com", "googleusercontent.com", "cancel.com"];
	expect(mirrors.filter((host) => !isMirrorHost(host))).toEqual([]);
	expect(sites.filter((host) => isMirrorHost(host))).toEqual([]);
});

test("private addresses are told from public ones at the range boundaries", () => {
	const privates = [
		"127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
		"100.127.255.255", "224.0.0.1", "255.255.255.255", "::", "::1", "[::1]", "fd00::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1",
	];
	const publics = ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.255.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "fec0::1"];
	expect(privates.filter((ip) => !isPrivateAddress(ip))).toEqual([]);
	expect(publics.filter((ip) => isPrivateAddress(ip))).toEqual([]);
});

test("a public name that resolves to a private address is refused; one that resolves publicly is not", async () => {
	const answers: Record<string, string[]> = { "intranet.example.com": ["93.184.216.34", "10.0.0.5"], "metadata.example.com": ["169.254.169.254"], "public.example.com": ["93.184.216.34"] };
	const policy = readPolicy([], async (host) => answers[host] ?? []);

	expect(await policy.navigation("http://intranet.example.com/")).toBe(PRIVATE_REASON("intranet.example.com"));
	expect(await policy.subresource("http://metadata.example.com/latest/meta-data/")).toBe(PRIVATE_REASON("metadata.example.com"));
	expect(await policy.navigation("https://public.example.com/post")).toBeNull();
});

test("a public host whose connection landed on a private address is refused (DNS rebinding)", () => {
	const policy = readPolicy(["127.0.0.1"]);

	expect(policy.connected("https://public.example.com/post", "127.0.0.1")).toBe(PRIVATE_REASON("public.example.com"));
	expect(policy.connected("https://public.example.com/post", "::ffff:192.168.1.1")).toBe(PRIVATE_REASON("public.example.com"));
	expect(policy.connected("https://public.example.com/post", "93.184.216.34")).toBeNull();
	expect(policy.connected("http://127.0.0.1:8080/", "127.0.0.1")).toBeNull();
});

describeWithChrome("browser_read", () => {
	test(
		"reads a page's text through the MCP tool, and uses no profile",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await readRuntime();
			const client = await connect(runtime, rootDir);

			const result = await client.callTool({ name: "browser_read", arguments: { url: fixture.url("/article") } });

			expect(result.isError).toBeFalsy();
			const read = result.structuredContent as Record<string, unknown>;
			expect(read).toMatchObject({ status: "ok", url: fixture.url("/article"), title: "fixture article" });
			expect(read.text).toBe(`Field notes\n\n${ARTICLE_TEXT}`);
			expect(read.truncated).toBeUndefined();
			expect(await runtime.profiles()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"cuts the text at maxChars and says so",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			const read = await runtime.read({ url: fixture.url("/article"), maxChars: 40 });

			expect(read).toEqual({ status: "ok", url: fixture.url("/article"), title: "fixture article", text: `Field notes\n\n${ARTICLE_TEXT}`.slice(0, 40), truncated: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a read never carries a cookie: not a signed-in View profile's, not an earlier read's",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();
			const opened = await runtime.open({ profile: "signed-in" });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/set-cookie") });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/show-cookie") });
			expect((await runtime.snapshot(opened.browserId)).text).toContain(`COOKIE:${fixture.cookieValue}`);

			expect(await runtime.read({ url: fixture.url("/show-cookie") })).toMatchObject({ status: "ok", text: "COOKIE:none" });
			expect(await runtime.read({ url: fixture.url("/set-cookie") })).toMatchObject({ status: "ok" });
			expect(await runtime.read({ url: fixture.url("/show-cookie") })).toMatchObject({ status: "ok", text: "COOKIE:none" });
			expect(await runtime.profiles()).toEqual(["signed-in"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the reader never keeps the human from a browser: after a read, all four Browser View slots open",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();
			expect(await runtime.read({ url: fixture.url("/article"), maxChars: 10 })).toMatchObject({ status: "ok" });

			for (const profile of ["one", "two", "three", "four"]) {
				expect((await runtime.open({ profile })).profile).toBe(profile);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an HTTP refusal is blocked with its status",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/forbidden") })).toEqual({ status: "blocked", url: fixture.url("/forbidden"), reason: "HTTP 403" });
			expect(await runtime.read({ url: fixture.url("/unavailable") })).toEqual({ status: "blocked", url: fixture.url("/unavailable"), reason: "HTTP 503" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a redirect to a sign-in page is a login wall, reported at the URL it landed on",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			const read = await runtime.read({ url: fixture.url("/private") });

			expect(read).toEqual({ status: "blocked", url: fixture.url("/accounts/login?next=/private"), reason: "login wall: the page is a sign-in page" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a Devise-style /users/sign_in page is a login wall",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/users/sign_in") })).toEqual({ status: "blocked", url: fixture.url("/users/sign_in"), reason: "login wall: the page is a sign-in page" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a visible password field is a login wall, inside a shadow root too; a hidden one is not",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/password-gate") })).toEqual({ status: "blocked", url: fixture.url("/password-gate"), reason: "login wall: the page shows a password field" });
			expect(await runtime.read({ url: fixture.url("/shadow-login") })).toEqual({ status: "blocked", url: fixture.url("/shadow-login"), reason: "login wall: the page shows a password field" });
			expect(await runtime.read({ url: fixture.url("/hidden-password") })).toMatchObject({ status: "ok", text: "public post" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a quick-login box beside a long article is not a login wall; a login dialog over the viewport is",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			const read = await runtime.read({ url: fixture.url("/article-with-sidebar-login") });
			expect(read).toMatchObject({ status: "ok", url: fixture.url("/article-with-sidebar-login"), title: "fixture article" });
			expect(read.status === "ok" && read.text.endsWith(ARTICLE_TEXT)).toBe(true);
			expect(await runtime.read({ url: fixture.url("/article-behind-login") })).toEqual({ status: "blocked", url: fixture.url("/article-behind-login"), reason: "login wall: the page shows a password field" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a visible CAPTCHA frame is a bot check; reCAPTCHA v3's script and scoring badge are not",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/captcha") })).toEqual({ status: "blocked", url: fixture.url("/captcha"), reason: `CAPTCHA or bot check: the page shows a challenge frame from ${fixture.url("/recaptcha/api2/anchor")}` });
			expect(await runtime.read({ url: fixture.url("/recaptcha-v3") })).toMatchObject({ status: "ok", text: "scored, not challenged" });
			expect(fixture.hits("/recaptcha/api.js")).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a CAPTCHA widget in a long article's comment form is not a bot check; a challenge over the viewport is",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/article-with-comment-captcha"), maxChars: 11 })).toEqual({ status: "ok", url: fixture.url("/article-with-comment-captcha"), title: "fixture article", text: "Field notes", truncated: true });
			expect(await runtime.read({ url: fixture.url("/article-behind-challenge") })).toEqual({ status: "blocked", url: fixture.url("/article-behind-challenge"), reason: `CAPTCHA or bot check: the page shows a challenge frame from ${fixture.url("/recaptcha/api2/bframe")}` });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a mirror host is refused before anything navigates",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();
			const mirror = fixture.url("/article").replace("127.0.0.1", "redlib.localhost");

			expect(await runtime.read({ url: mirror })).toEqual({ status: "blocked", url: mirror, reason: MIRROR_REASON });
			expect(fixture.hits("/article")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a redirect to a mirror host is refused at the redirect, and the mirror is never fetched",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();
			const mirror = fixture.url("/article").replace("127.0.0.1", "redlib.localhost");

			expect(await runtime.read({ url: fixture.url("/to-mirror") })).toEqual({ status: "blocked", url: mirror, reason: MIRROR_REASON });
			expect(fixture.hits("/to-mirror")).toBe(1);
			expect(fixture.hits("/article")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"loopback, localhost and link-local targets are refused before anything navigates",
		async () => {
			const fixture = startFixture();
			const runtime = newRuntime(await createRoot());
			const port = new URL(fixture.url("/")).port;

			for (const [url, host] of [
				[fixture.url("/article"), "127.0.0.1"],
				[fixture.url("/article", "localhost"), "localhost"],
				[`http://[::1]:${port}/article`, "[::1]"],
				["http://169.254.169.254/latest/meta-data/", "169.254.169.254"],
				["http://192.168.1.1/", "192.168.1.1"],
			] as const) {
				expect(await runtime.read({ url })).toEqual({ status: "blocked", url, reason: PRIVATE_REASON(host) });
			}
			expect(fixture.hits("/article")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a public page's redirect into a private address is refused at the redirect",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/to-private") })).toEqual({ status: "blocked", url: fixture.url("/article", "localhost"), reason: PRIVATE_REASON("localhost") });
			expect(fixture.hits("/to-private")).toBe(1);
			expect(fixture.hits("/article")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page's popup never opens: the read stays on one tab and the popup's URL is never fetched",
		async () => {
			const fixture = startFixture();
			const { runtime } = await readRuntime();

			expect(await runtime.read({ url: fixture.url("/popup") })).toMatchObject({ status: "ok", text: "a page with a popunder" });
			expect(fixture.hits("/page2")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
