/**
 * Shared fixtures for the browser pack's tests.
 *
 * These tests drive a REAL Chrome against a local HTTP server we own, because
 * every contract worth defending here (a write happens exactly once, an action
 * that errored after dispatch is never repeated, a profile's cookies are its
 * own) is a property of the actual browser and the actual bytes on the wire. A
 * mocked page would let all of those break silently.
 *
 * Two hard rules baked in here:
 *  - We never touch the human's Chrome profile. Every runtime gets a fresh
 *    `rootDir` under the OS temp dir and every profile lives inside it.
 *  - If no Chrome is installed we SKIP, loudly. A green run that never started
 *    a browser must never be mistaken for "the real browser behaves".
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, setSystemTime } from "bun:test";
import type { BrowserAction, BrowserState } from "../src/contracts";
import { BrowserRuntime, type BrowserRuntimeOptions } from "../src/runtime";
import { BrowserRuntimeError } from "../src/store";

// ---------------------------------------------------------------------------
// Locating a real Chrome
// ---------------------------------------------------------------------------

function candidates(): string[] {
	const fromEnv = ["BROWSER_TEST_CHROME", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"]
		.map((key) => process.env[key]?.trim())
		.filter((value): value is string => value !== undefined && value.length > 0);
	if (process.platform === "win32") {
		const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
			(root): root is string => typeof root === "string" && root.length > 0,
		);
		return [
			...fromEnv,
			...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
			...roots.map((root) => join(root, "Chromium", "Application", "chrome.exe")),
		];
	}
	if (process.platform === "darwin") {
		return [
			...fromEnv,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
	}
	return [
		...fromEnv,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
}

export const chromePath: string | undefined = candidates().find((path) => existsSync(path));

if (chromePath === undefined) {
	console.warn(
		"[browser tests] No Chrome/Chromium found. The real-browser tests are SKIPPED, not passed. " +
			"Set BROWSER_TEST_CHROME=<path to chrome executable> to run them.",
	);
}

/** `describe` that skips the whole group honestly when there is no browser. */
export const describeWithChrome: (label: string, body: () => void) => void =
	chromePath === undefined ? describe.skip : describe;

/** Generous: a cold Chrome launch plus several real navigations. */
export const BROWSER_TEST_TIMEOUT_MS = 120_000;

/** How long a real, already-dispatched effect gets to become observable. */
const EFFECT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Owned runtimes and owned profile roots
// ---------------------------------------------------------------------------

const runtimes: BrowserRuntime[] = [];
const roots: string[] = [];
const servers: Fixture[] = [];

export async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "dimension-browser-test-"));
	roots.push(root);
	return root;
}

/** A runtime bound to `rootDir`. Headless, real Chrome, disposed in teardown. */
export function newRuntime(rootDir: string, options: Omit<BrowserRuntimeOptions, "rootDir"> = {}): BrowserRuntime {
	const runtime = new BrowserRuntime({
		headless: true,
		executablePath: chromePath,
		...options,
		rootDir,
	});
	runtimes.push(runtime);
	return runtime;
}

export async function createRuntime(): Promise<{ runtime: BrowserRuntime; rootDir: string }> {
	const rootDir = await createRoot();
	return { runtime: newRuntime(rootDir), rootDir };
}

/**
 * Tear down ONLY what these tests created: our runtimes (which close only the
 * browsers they launched), our fixture servers, our temp roots.
 */
export async function teardown(): Promise<void> {
	for (const runtime of runtimes.splice(0)) {
		await runtime.dispose().catch(() => undefined);
	}
	for (const server of servers.splice(0)) {
		await server.stop();
	}
	for (const root of roots.splice(0)) {
		// Chrome can hold profile files for a moment after exit on Windows.
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
	}
}

/**
 * Settle `work`, and once `ready()` has held for `graceMs`, make `Date.now()`
 * race ahead so any real-clock deadline inside it passes within a poll. Timers
 * stay real. `ready` must name the last thing the page will ever do; the grace
 * (several of publish.ts's 250 ms polls) lets the code under test observe that
 * final page before its deadline is skipped, so skipping cannot hide an outcome.
 */
export async function racingClock<T>(ready: () => boolean, work: Promise<T>, graceMs = 1_000): Promise<T> {
	const base = Date.now() - performance.now();
	let readyAt: number | undefined;
	let skip = 0;
	// A real interval, deliberately: the deadlines live in real Chrome round trips
	// that a fake timer cannot advance, and only Date.now() is jumped.
	const pump = setInterval(() => {
		if (readyAt === undefined && ready()) readyAt = performance.now();
		if (readyAt === undefined || performance.now() - readyAt < graceMs) return;
		skip += 30_000;
		setSystemTime(new Date(base + performance.now() + skip));
	}, 50);
	try {
		return await work;
	} finally {
		clearInterval(pump);
		setSystemTime();
	}
}

// ---------------------------------------------------------------------------
// The local HTTP fixture
// ---------------------------------------------------------------------------

/**
 * The two hosts the one fixture server answers on. They are different SITES,
 * so Chrome's site isolation moves a navigation between them to a new renderer
 * process — the cross-process swap that briefly detaches a page's CDP session.
 */
export type FixtureHost = "127.0.0.1" | "localhost";

export interface Fixture {
	/** Absolute URL for a fixture path, e.g. `/page2`, on `host` (default 127.0.0.1). */
	url(path: string, host?: FixtureHost): string;
	/** How many times the server was asked for `path` (query excluded). */
	hits(path: string): number;
	/** Every accepted form submission, in order (a POST to `/submit`, or the GET login form's `/logged-in`). This is the write count. */
	submissions(): ReadonlyArray<Record<string, string>>;
	/** The value `/set-cookie` persists; `/show-cookie` echoes it back. */
	readonly cookieValue: string;
	stop(): Promise<void>;
}

const FORM_BODY = `<h1>fixture form</h1>
<form method="POST" action="/submit">
  <input id="user" name="user" type="text" />
  <input id="pass" name="pass" type="password" />
  <button id="go" type="submit">Submit</button>
</form>`;

/** A form that already holds a value, plus a `<select>` whose visible text differs from its values. */
const SIGNUP_BODY = `<h1>signup</h1>
<form method="POST" action="/submit">
  <input id="user" name="user" type="text" value="old name" />
  <select id="plan" name="plan">
    <option value="free">Free</option>
    <option value="pro">Pro plan</option>
  </select>
  <button id="go" type="submit">Submit</button>
</form>`;

/**
 * The form, plus a page-side guard on the password field that THROWS when the
 * field is re-selected while it already holds text — the kind of third-party
 * script (validation layer, autofill bridge) that fails in the middle of an
 * input the browser has already delivered. Typing into the filled field focuses
 * it (dispatched) and then trips the guard (error). Each run of the guard
 * sets the title to `guard fired <n>`, so the live document counts how often
 * that page code ran.
 */
const GUARDED_BODY = `${FORM_BODY}
<script>
  var fired = 0;
  var field = document.getElementById("pass");
  var native = HTMLInputElement.prototype.select;
  Object.defineProperty(field, "select", {
    value: function () {
      if (this.value.length === 0) return native.call(this);
      document.title = "guard fired " + ++fired;
      throw new Error("autofill bridge rejected the stored entry");
    },
  });
</script>`;

/** A link that opens in a new tab — the way sites hand you a second tab. */
const OPENER_BODY = `<h1>opener</h1><a id="blank" href="/page2" target="_blank" style="display:block;padding:40px">open page 2 in a new tab</a>`;

/** A 1x1 PNG, served as this fixture's declared favicon. */
export const FAVICON_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** How long `/slow` keeps its navigation in flight. */
export const SLOW_PAGE_MS = 2_000;
/** How long `/delayed-landing` takes to answer: a navigation that commits well after the click that started it. */
export const DELAYED_LANDING_MS = 700;

function page(title: string, body: string, head = ""): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

function html(markup: string, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(markup, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/** `/article`'s body text: long enough to truncate, with a marker at each end. */
export const ARTICLE_TEXT = `ARTICLE-START ${"lorem ipsum dolor sit amet ".repeat(200)}ARTICLE-END`;

export function startFixture(): Fixture {
	const hits = new Map<string, number>();
	const submissions: Record<string, string>[] = [];
	const cookieValue = randomBytes(8).toString("hex");
	const origin = (host: FixtureHost): string => `http://${host}:${server.port}`;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const { pathname } = url;
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			if (pathname === "/") return html(page("fixture form", FORM_BODY));
			if (pathname === "/page2") return html(page("second page", "<p>second page</p>"));
			if (pathname === "/signup") return html(page("signup", SIGNUP_BODY));
			if (pathname === "/guarded") return html(page("guarded form", GUARDED_BODY));
			if (pathname === "/opener") return html(page("opener", OPENER_BODY));
			if (pathname === "/with-icon") return html(page("with icon", "<p>has an icon</p>", `<link rel="icon" href="/brand.png">`));
			// The fixture form inside a CROSS-ORIGIN iframe (the other host: another site, so an out-of-process frame).
			if (pathname === "/framed") {
				const other: FixtureHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
				return html(page("framed login", `<h1>framed login</h1><iframe id="login" src="${origin(other)}/" style="width:600px;height:300px;border:0"></iframe>`));
			}
			// The dialogs page inside a CROSS-ORIGIN iframe: an out-of-process frame, whose dialogs never reach its parent's session.
			if (pathname === "/framed-dialogs") {
				const other: FixtureHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
				return html(page("framed dialogs", `<iframe id="dialogs" src="${origin(other)}/dialogs" style="width:600px;height:300px;border:0"></iframe>`));
			}
			// The fixture form on a page that claims the OTHER host's origin: `window.origin` is replaceable by page script.
			if (pathname === "/spoofed") {
				const other: FixtureHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
				return html(page("spoofed", `${FORM_BODY}<p id="claims"></p><script>window.origin = ${JSON.stringify(origin(other))}; document.getElementById("claims").textContent = "claims " + window.origin;</script>`));
			}
			// The fixture form with a show-password toggle that turns #pass into a text field.
			if (pathname === "/revealable") {
				return html(page("revealable", `${FORM_BODY}<button type="button" id="show" onclick="document.getElementById('pass').type = 'text'">show</button><button type="button" id="echo" onclick="document.getElementById('echoed').textContent = 'echo:' + document.getElementById('pass').value">echo</button><p id="echoed"></p>`));
			}
			// A login form with no `method`: it submits as GET, so the password lands in the next page's URL, form-encoded.
			if (pathname === "/get-login") {
				return html(page("get login", `<form action="/logged-in"><input id="user" name="user" type="text" /><input id="pass" name="pass" type="password" /><button id="go" type="submit">Log in</button></form>`));
			}
			if (pathname === "/logged-in") {
				submissions.push(Object.fromEntries(url.searchParams));
				return html(page("logged in", `<p id="count">submissions:${submissions.length}</p>`));
			}
			// An ad iframe, then two form iframes (the other host's, then this host's); #drop removes the ad, so every later frame's index shifts down one.
			if (pathname === "/three-frames") {
				const other: FixtureHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
				const frame = (id: string, src: string): string => `<iframe id="${id}" src="${src}" style="width:600px;height:160px;border:0"></iframe>`;
				return html(page("three frames", `<button type="button" id="drop" onclick="document.getElementById('ad').remove()">drop ad</button>${frame("ad", "/page2")}${frame("a", `${origin(other)}/`)}${frame("b", "/")}`));
			}
			// The fixture form plus a decoy field (in the form) that takes focus on the task after #pass gains it.
			if (pathname === "/focus-thief") {
				const body = FORM_BODY.replace(`<button id="go"`, `<input id="decoy" name="decoy" type="text" /><button id="go"`);
				return html(page("focus thief", `${body}<script>document.getElementById("pass").addEventListener("focus", () => setTimeout(() => document.getElementById("decoy").focus(), 0));</script>`));
			}
			// Page dialogs, each answered by the page's own script: it records what came back in the title.
			if (pathname === "/dialogs") {
				return html(page("dialogs", `<button id="alert" onclick="alert('hello alert'); document.title = 'after alert'">alert</button>
<button id="confirm" onclick="document.title = 'confirm:' + confirm('really?')">confirm</button>
<button id="prompt" onclick="document.title = 'prompt:' + prompt('your name?', 'anon')">prompt</button>
<button id="many" onclick="for (let i = 1; i <= 7; i++) alert('dialog ' + i); document.title = 'many done'">many</button>`));
			}
			// A page that asks before it is left (a link click is the user activation Chrome wants first).
			if (pathname === "/unload-guard") {
				return html(page("unload guard", `<a id="leave" href="/page2" style="display:block;padding:40px">leave</a><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "unsaved"; });</script>`));
			}
			// Every way a click starts a navigation: a link, a form whose answer is slow, a script that starts late, and a button that navigates nowhere.
			if (pathname === "/nav") {
				return html(page("nav start", `<a id="link" href="/delayed-landing?via=link">slow page</a>
<form method="GET" action="/delayed-landing"><input name="q" value="x"><button id="slow-go" type="submit">send</button></form>
<button id="later" type="button" onclick="setTimeout(() => { location.href = '/page2'; }, 20)">later</button>
<button id="idle" type="button" onclick="document.title = 'idle clicked'">idle</button>
<form method="GET" action="/page2"><input id="q" name="q" type="text"></form>`));
			}
			if (pathname === "/delayed-landing") {
				await Bun.sleep(DELAYED_LANDING_MS);
				return html(page("landed", "<p>landed after a slow answer</p>"));
			}
			// Controls with state, a link list without ids, and a password field whose value must never appear.
			if (pathname === "/controls") {
				return html(page("controls", `<label><input type="checkbox" id="agree" name="agree" checked> agree</label>
<label><input type="checkbox" id="news" name="news"> news</label>
<label><input type="radio" name="size" value="s"> small</label><label><input type="radio" name="size" value="m" checked> medium</label>
<select id="plan" name="plan"><option value="free">Free</option><option value="pro" selected>Pro plan</option></select>
<input id="secret" type="password" value="hunter2-secret">
<nav><a href="/page2" onclick="document.title='first';return false">first</a> <a href="/page2?x=1" onclick="document.title='second';return false">second</a> <a href="/page2" onclick="document.title='third';return false">third</a></nav>
<ul><li><a href="/opener" onclick="document.title='list 1';return false">list link</a></li><li><a href="/opener" onclick="document.title='list 2';return false">list link</a></li></ul>`));
			}
			// The eval's layout bug: a content-box card wider than the panel that holds it.
			if (pathname === "/layout") {
				return html(page("layout", `<style>.panel{width:360px;padding:0;border:1px dashed #888;overflow:visible}.card{width:480px;box-sizing:content-box;padding:20px;border:2px solid #36c;margin:0 0 8px}</style><div class="panel" id="panel"><div class="card" id="card">Pro plan</div></div>`));
			}
			// Content that arrives late: an element, text, and a new URL.
			if (pathname === "/late") {
				return html(page("late", `<p>starting</p><script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", '<p id="late">late arrival text</p>'); }, 300); setTimeout(() => history.replaceState(null, "", "/late?done=1"), 500);</script>`));
			}
			// An app with a global of its own, for a script run in the page's main world to read.
			if (pathname === "/app") return html(page("app", `<p id="out">ready</p><script>window.appState = { count: 3, items: ["a", "b"] };</script>`));
			// A page that goes wrong every way a developer cares about; the query strings carry a token that must never be kept.
			if (pathname === "/broken") {
				return html(page("broken", `<script>
console.error("boom from the app");
console.warn("careful now");
setTimeout(() => { throw new Error("uncaught in the app"); }, 0);
// Once both requests have answered, so a test can wait for the page to have finished going wrong.
Promise.allSettled([fetch("/nope?token=SECRET-TOKEN"), fetch("http://127.0.0.1:1/unreachable?token=SECRET-TOKEN")]).then(() => document.body.insertAdjacentHTML("beforeend", '<p id="settled">settled</p>'));
</script>`));
			}
			// Thirty 100px blocks, edge to edge: a page far taller than any viewport.
			if (pathname === "/tall") {
				const blocks = Array.from({ length: 30 }, (_, i) => `<div style="height:100px;background:hsl(${i * 12},80%,50%)">block ${i}</div>`).join("");
				return html(page("tall", blocks, "<style>body{margin:0}</style>"));
			}
			if (pathname === "/brand.png") return new Response(FAVICON_PNG, { headers: { "content-type": "image/png" } });
			// Answers only after SLOW_PAGE_MS: a navigation that stays in flight long enough to observe.
			if (pathname === "/slow") {
				await Bun.sleep(SLOW_PAGE_MS);
				return html(page("slow page", "<p>finally</p>"));
			}
			// Hit only if a `javascript:` URL were ever executed in the page.
			if (pathname === "/js-ran") return new Response("ran", { headers: { "cache-control": "no-store" } });
			// `/bounce?left=N` navigates itself to the OTHER host's `/bounce?left=N-1`
			// as soon as it loads, until `left` reaches 0: a chain of page-initiated
			// cross-site navigations the runtime did not start and cannot serialize.
			if (pathname === "/bounce") {
				const left = Number(url.searchParams.get("left") ?? "0");
				if (left <= 0) return html(page("bounced", "<p id='done'>bounced</p>"));
				const other: FixtureHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
				const next = `${origin(other)}/bounce?left=${left - 1}`;
				return html(page(`bounce ${left}`, `<script>addEventListener("load", () => location.replace(${JSON.stringify(next)}));</script>`));
			}
			if (pathname === "/submit" && request.method === "POST") {
				const fields: Record<string, string> = {};
				for (const [key, value] of new URLSearchParams(await request.text())) fields[key] = value;
				submissions.push(fields);
				return html(page("submitted", `<p id="count">submissions:${submissions.length}</p>`));
			}
			if (pathname === "/set-cookie") {
				return html(page("cookie set", "<p>cookie set</p>"), {
					"set-cookie": `fixturesid=${cookieValue}; Max-Age=86400; Path=/; SameSite=Lax`,
				});
			}
			if (pathname === "/show-cookie") {
				const found = /(?:^|;\s*)fixturesid=([^;]+)/.exec(request.headers.get("cookie") ?? "");
				return html(page("cookie", `<p id="cookie">COOKIE:${found?.[1] ?? "none"}</p>`));
			}
			// browser_read pages: one readable, one per way a page refuses a logged-out reader.
			if (pathname === "/article") return html(page("fixture article", `<article><h1>Field notes</h1><p>${ARTICLE_TEXT}</p></article>`));
			if (pathname === "/forbidden") return html(page("forbidden", "<p>go away</p>"), {}, 403);
			if (pathname === "/unavailable") return html(page("unavailable", "<p>try later</p>"), {}, 503);
			if (pathname === "/private") return new Response(null, { status: 302, headers: { location: "/accounts/login?next=/private" } });
			if (pathname === "/accounts/login") return html(page("sign in", "<p>sign in to continue</p>"));
			if (pathname === "/password-gate") return html(page("members", `<p>members only</p><input type="password" id="pw" />`));
			if (pathname === "/hidden-password") return html(page("with a closed login dialog", `<p>public post</p><div style="display:none"><input type="password" /></div><input type="password" style="visibility:hidden" />`));
			if (pathname === "/users/sign_in") return html(page("sign in", "<p>you need to sign in or sign up before continuing</p>"));
			// A web-component login modal: the password field lives in an open shadow root.
			if (pathname === "/shadow-login") return html(page("members", `<p>members only</p><login-box></login-box><script>customElements.define("login-box", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<input type="password" />'; } });</script>`));
			if (pathname === "/captcha") return html(page("checking", `<p>one moment</p><iframe src="/recaptcha/api2/anchor?k=fixture"></iframe>`));
			if (pathname === "/recaptcha/api2/anchor") return html(page("recaptcha", "<p>I'm not a robot</p>"));
			// reCAPTCHA v3 as sites ship it: the script on every page and the invisible-scoring badge, no challenge.
			if (pathname === "/recaptcha-v3") return html(page("fixture article", `<article><p>scored, not challenged</p></article><script src="/recaptcha/api.js?render=fixture"></script><div style="position:fixed;right:0;bottom:0;width:256px;height:60px"><iframe src="/recaptcha/api2/anchor?k=fixture&size=invisible" width="256" height="60"></iframe></div>`));
			// Long public pages that carry a widget, not a wall: a checkbox CAPTCHA in the comment form under
			// the article, and a quick-login box in the sidebar. And the same article behind a full-viewport
			// challenge or login dialog, which IS a wall however much text sits behind it.
			if (pathname === "/article-with-comment-captcha") return html(page("fixture article", `<article><h1>Field notes</h1><p>${ARTICLE_TEXT}</p></article><form><p>Leave a comment</p><textarea></textarea><iframe src="/recaptcha/api2/anchor?k=fixture&size=normal" width="304" height="78"></iframe></form>`));
			if (pathname === "/article-behind-challenge") return html(page("fixture article", `<article><h1>Field notes</h1><p>${ARTICLE_TEXT}</p></article><iframe src="/recaptcha/api2/bframe?k=fixture" style="position:fixed;left:0;top:0;width:100vw;height:100vh;border:0"></iframe>`));
			if (pathname === "/article-with-sidebar-login") return html(page("fixture article", `<aside style="float:right;width:240px"><form><input name="user" /><input name="pass" type="password" /><button>Log in</button></form></aside><article><h1>Field notes</h1><p>${ARTICLE_TEXT}</p></article>`));
			if (pathname === "/article-behind-login") return html(page("fixture article", `<article><h1>Field notes</h1><p>${ARTICLE_TEXT}</p></article><dialog open style="position:fixed;left:0;top:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0"><form><input name="user" /><input name="pass" type="password" /></form></dialog>`));
			if (pathname === "/recaptcha/api.js") return new Response("", { headers: { "content-type": "text/javascript" } });
			// Redirects out of the fixture's allowed host: to a mirror host, and to a private one.
			if (pathname === "/to-mirror") return new Response(null, { status: 302, headers: { location: `http://redlib.localhost:${url.port}/article` } });
			if (pathname === "/to-private") return new Response(null, { status: 302, headers: { location: `${origin("localhost")}/article` } });
			// Opens a popup as it loads; the reader's popup blocker must keep `/page2` from ever being fetched.
			if (pathname === "/popup") return html(page("popup opener", `<p>a page with a popunder</p><script>window.open("/page2");</script>`));
			return new Response("not found", { status: 404 });
		},
	});

	const fixture: Fixture = {
		url: (path, host = "127.0.0.1") => `${origin(host)}${path}`,
		hits: (path) => hits.get(path) ?? 0,
		submissions: () => submissions,
		cookieValue,
		stop: async () => {
			await server.stop(true);
		},
	};
	servers.push(fixture);
	return fixture;
}

// ---------------------------------------------------------------------------
// Small test helpers
// ---------------------------------------------------------------------------

/** Perform an action that is expected to complete; anything else fails the test with its error. */
export async function perform(runtime: BrowserRuntime, browserId: string, action: BrowserAction): Promise<BrowserState> {
	const result = await runtime.act(browserId, action);
	if (result.status !== "completed") {
		throw new Error(`expected ${action.kind} to complete, got ${result.status}: ${result.error ?? ""}`);
	}
	return result.state;
}

/**
 * Poll `probe` until `ok` accepts it, or fail at the deadline. The timeout is a
 * FAILURE, never a success: nothing here treats "time passed" as proof that an
 * effect happened. Use it only to wait for an observation the product itself
 * makes — a server hit, a landed navigation — never to let a race settle.
 */
export async function waitUntil<T>(
	what: string,
	probe: () => T | Promise<T>,
	ok: (value: T) => boolean,
	timeoutMs = EFFECT_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let seen = await probe();
	while (!ok(seen)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(seen)}`);
		}
		await Bun.sleep(25);
		seen = await probe();
	}
	return seen;
}

/**
 * Settle `work` within `ms` or fail naming `what`. A real-clock DEADLINE, not a
 * wait: the regression under test is a hang inside real Chrome, which no fake
 * clock can advance, and it must go red rather than stall the suite.
 */
export async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
	let timer: Timer | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([work, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wait for the form round trip that a `click` deliberately does NOT await. A
 * click reports `completed` once the browser dispatched it; the POST travels to
 * the server and the response comes back to the page afterwards. Landing on
 * the `/submit` response is the observable END of that round trip: the server
 * has accepted the write and the submitting page is gone, so the submission
 * count is settled and "exactly once" can be asserted honestly.
 */
export async function submissionLanded(
	runtime: BrowserRuntime,
	browserId: string,
	fixture: Fixture,
): Promise<void> {
	await waitUntil(
		"the browser to land on the fixture's /submit response",
		async () => (await runtime.state(browserId)).url,
		(url) => url === fixture.url("/submit"),
	);
}

/**
 * Run `work`, expect it to reject with a {@link BrowserRuntimeError}, and yield
 * its code. A call that RESOLVES fails the test — the refusal is the contract.
 */
export async function failureCode(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
	} catch (err) {
		if (err instanceof BrowserRuntimeError) return err.code;
		throw err;
	}
	throw new Error("expected the call to be refused, but it resolved");
}
