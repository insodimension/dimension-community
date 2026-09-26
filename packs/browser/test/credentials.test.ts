/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a password the browser holds
 *  for a jev sign-up or login leaks, or lands on the wrong site. The value may
 *  reach exactly one place — the task worker's stdin — and from there only the
 *  password fields of the origin it is bound to. Anything else (a tool result
 *  the outer model reads, the task record, a step, an error, a log line, jev's
 *  goal) is a leak into a model call or a transcript.
 *
 *  Three layers, each against the real code:
 *   - the MCP server + runtime with the scripted fake worker, which writes the
 *     credential it received to a file (never to the protocol) so the test can
 *     prove delivery without echoing it;
 *   - the worker's real fill script, built by the real Python and run in a real
 *     Chrome page;
 *   - the real jev worker helpers that build the goal and log fill failures.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCredential } from "../src/credentials";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BrowserRuntimeError } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, newRuntime, startFixture, teardown } from "./fixture";

const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));
const hasPython = existsSync(PYTHON);
if (!hasPython) {
	console.warn(`[browser tests] ${PYTHON} is missing; the credential tests are SKIPPED. Run: cd python && uv sync --python 3.12`);
}
const describeWithBoth = chromePath === undefined || !hasPython ? describe.skip : describe;
const describeWithPython = hasPython ? describe : describe.skip;

const SHOP = "https://shop.example";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a snippet in the REAL worker package (not the fake one) and return its stdout. */
function python(code: string, stdin: string): string {
	const env: Record<string, string | undefined> = { ...process.env, PYTHONPATH: PYTHON_DIR, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
	const run = spawnSync(PYTHON, ["-c", code], { cwd: PYTHON_DIR, env, input: stdin, encoding: "utf8", windowsHide: true });
	if (run.status !== 0) throw new Error(`python exited ${run.status}: ${run.stderr}`);
	return run.stdout;
}

/** The exact script the jev worker evaluates in the page for `credential`. */
function fillScript(credential: { origin: string; password: string }): string {
	return python("import json, sys\nfrom dim_browser_bridge.jev_task import fill_script\nsys.stdout.write(fill_script(json.loads(sys.stdin.read())))", JSON.stringify(credential));
}

/**
 * The REAL worker's frame walk (`fill_frames`) over raw CDP to the browser at
 * `ws`, on the page target `target`: prints the number of fields it filled.
 */
function fillFrames(request: { ws: string; target: string; credential: { origin: string; password: string } }): string {
	return python(
		[
			"import json, sys",
			"from websockets.sync.client import connect",
			"from dim_browser_bridge.jev_task import fill_frames",
			"req = json.loads(sys.stdin.read())",
			"ws = connect(req['ws'], max_size=None)",
			"seq = [0]",
			"def cdp(method, session_id=None, **params):",
			"    seq[0] += 1",
			"    message = {'id': seq[0], 'method': method, 'params': params}",
			"    if session_id: message['sessionId'] = session_id",
			"    ws.send(json.dumps(message))",
			"    while True:",
			"        reply = json.loads(ws.recv())",
			"        if reply.get('id') == seq[0]:",
			"            if 'error' in reply: raise RuntimeError(reply['error'])",
			"            return reply.get('result', {})",
			"session = cdp('Target.attachToTarget', targetId=req['target'], flatten=True)['sessionId']",
			"sys.stdout.write(json.dumps(fill_frames(cdp, req['target'], session, req['credential'])))",
			"ws.close()",
		].join("\n"),
		JSON.stringify(request),
	);
}

/** Everything the process printed while a test ran: console and raw stdio writes. */
function captureOutput(): { text(): string; restore(): void } {
	const spies = [
		spyOn(console, "log"),
		spyOn(console, "info"),
		spyOn(console, "warn"),
		spyOn(console, "error"),
		spyOn(console, "debug"),
		spyOn(process.stdout, "write"),
		spyOn(process.stderr, "write"),
	];
	return {
		text: () => spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => (typeof arg === "string" ? arg : String(arg)))).join("\n"),
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

function savedPasswords(rootDir: string, profile: string): Record<string, string> {
	const file = join(rootDir, "profiles", profile, "credentials.json");
	if (!existsSync(file)) return {};
	const stored: { origins: Record<string, string> } = JSON.parse(readFileSync(file, "utf8"));
	return stored.origins;
}

/** A fake-worker script that records the credential it was handed into `credentialOut`, then finishes. */
function script(credentialOut: string): string {
	return JSON.stringify({
		credentialOut,
		steps: [{ action: "filled the sign-up form", url: `${SHOP}/signup` }],
		result: { status: "done", summary: "signed up", steps: 1 },
	});
}

function received(credentialOut: string): unknown {
	return JSON.parse(readFileSync(credentialOut, "utf8"));
}

async function refusal(work: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("expected a refusal, but the call resolved");
}

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}

const clients: Client[] = [];

/** The real MCP server over `runtime`, reached the way a host reaches it. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "credential-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ENV_KEYS = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
const browsers: Browser[] = [];

beforeAll(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.DIM_BROWSER_PYTHON = PYTHON;
	// See fake-worker/sitecustomize.py for why this beats the real package in cwd.
	process.env.PYTHONPATH = FAKE_WORKER;
	process.env.PYTHONDONTWRITEBYTECODE = "1";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const browser of browsers.splice(0)) await browser.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// The runtime and MCP server: the value reaches the worker and nothing else
// ---------------------------------------------------------------------------

describeWithBoth("credentials through browser_task", () => {
	test(
		"a signup mints a password only the worker receives; no tool result, task record or log carries it; retries and logins reuse it",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const call = await connect(runtime, rootDir);
			const output = captureOutput();
			const seen: ToolResult[] = [];
			try {
				const opened = await call("browser_open", { profile: "signup" });
				const browserId = opened.structuredContent?.browserId as string;
				const task = async (outFile: string, credential: Record<string, unknown>): Promise<ToolResult> => {
					const result = await call("browser_task", { browserId, agent: "jev", task: script(join(rootDir, outFile)), credential, waitSeconds: 25 });
					seen.push(result);
					return result;
				};

				const first = await task("first.json", { origin: SHOP, mode: "signup" });
				expect(first.isError).toBeFalsy();
				expect(first.structuredContent).toMatchObject({ status: "done", credential: { origin: SHOP, created: true } });
				const password = savedPasswords(rootDir, "signup")[SHOP] as string;
				expect(typeof password).toBe("string");
				expect(received(join(rootDir, "first.json"))).toEqual({ origin: SHOP, password });

				// A retried sign-up (named by any URL on the origin) must not orphan the account the first created.
				const retry = await task("retry.json", { origin: `${SHOP}/account/new?ref=ad`, mode: "signup" });
				expect(retry.structuredContent).toMatchObject({ status: "done", credential: { origin: SHOP, created: false } });
				expect(received(join(rootDir, "retry.json"))).toEqual({ origin: SHOP, password });

				const login = await task("login.json", { origin: SHOP, mode: "login" });
				expect(login.structuredContent).toMatchObject({ status: "done", credential: { origin: SHOP, created: false } });
				expect(received(join(rootDir, "login.json"))).toEqual({ origin: SHOP, password });
				expect(savedPasswords(rootDir, "signup")).toEqual({ [SHOP]: password });

				seen.push(await call("browser_state", { browserId }), await call("browser_task_wait", { browserId, waitSeconds: 0 }));
				const everythingTheModelSees = JSON.stringify(seen);
				expect(everythingTheModelSees).not.toContain(password);
				expect(JSON.stringify(await runtime.waitTask(browserId, 0))).not.toContain(password);
				expect(output.text()).not.toContain(password);
			} finally {
				output.restore();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"refusals happen before any worker starts or password is minted, and none carries a saved password",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const { browserId } = await runtime.open({ profile: "refusals" });
			const out = (name: string): string => join(rootDir, `${name}.json`);
			const signup = await runtime.runTask(browserId, { agent: "jev", task: script(out("signup")), credential: { origin: SHOP, mode: "signup" } });
			expect(signup.status).toBe("done");
			const password = savedPasswords(rootDir, "refusals")[SHOP] as string;

			const noSaved = await refusal(() =>
				runtime.runTask(browserId, { agent: "jev", task: script(out("login")), credential: { origin: "https://other.example", mode: "login" } }),
			);
			expect(noSaved.code).toBe("no_credential");
			expect(noSaved.message).not.toContain(password);

			// browser-use reads password fields into its model: it never gets one.
			const browserUse = await refusal(() =>
				runtime.runTask(browserId, { agent: "browser-use", task: script(out("browser-use")), credential: { origin: SHOP, mode: "login" } }),
			);
			expect(browserUse.code).toBe("credential_unsupported");

			// Plain http to a remote host would send the password in clear.
			const cleartext = await refusal(() =>
				runtime.runTask(browserId, { agent: "jev", task: script(out("cleartext")), credential: { origin: "http://shop.example", mode: "signup" } }),
			);
			expect(cleartext.code).toBe("bad_credential");

			for (const name of ["login", "browser-use", "cleartext"]) expect(existsSync(out(name))).toBe(false);
			expect(savedPasswords(rootDir, "refusals")).toEqual({ [SHOP]: password });

			// http on loopback is where a local app under test lives: allowed.
			const local = await runtime.runTask(browserId, { agent: "jev", task: script(out("local")), credential: { origin: "http://127.0.0.1:8123", mode: "signup" } });
			expect(local.credential).toEqual({ origin: "http://127.0.0.1:8123", created: true });
			expect(received(out("local"))).toEqual({ origin: "http://127.0.0.1:8123", password: savedPasswords(rootDir, "refusals")["http://127.0.0.1:8123"] });

			// A damaged store is reported without echoing what it holds.
			const file = join(rootDir, "profiles", "refusals", "credentials.json");
			await writeFile(file, readFileSync(file, "utf8").slice(0, -4));
			const unreadable = await refusal(() =>
				runtime.runTask(browserId, { agent: "jev", task: script(out("unreadable")), credential: { origin: SHOP, mode: "login" } }),
			);
			expect(unreadable.code).toBe("credentials_unreadable");
			expect(unreadable.message).not.toContain(password);
			expect(existsSync(out("unreadable"))).toBe(false);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// The worker's fill script in a real page: only visible fields of its origin
// ---------------------------------------------------------------------------

/** A password whose characters would break (or inject into) a script that did not pass it as a JSON literal. */
const AWKWARD = `a"b'c\\d</script>\${x}\`e пароль✓`;

describeWithBoth("the password fill in a real page", () => {
	async function openPage(url: string): Promise<Page> {
		const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: await createRoot() });
		browsers.push(browser);
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: "load" });
		return page;
	}

	const valueOf = (page: Page, selector: string): Promise<string | null> =>
		page.$eval(selector, (el) => (el instanceof HTMLInputElement ? el.value : null));

	test(
		"fills only the visible, empty, enabled password fields, with the exact value",
		async () => {
			const fixture = startFixture();
			const page = await openPage(fixture.url("/"));
			await page.evaluate(() => {
				document.body.insertAdjacentHTML(
					"beforeend",
					`<input id="ghost" type="password" style="opacity:0">
					<div aria-hidden="true"><input id="aria" type="password"></div>
					<input id="gone" type="password" style="display:none">
					<input id="inert" type="password" inert>
					<input id="kept" type="password" value="typed by the user">
					<input id="off" type="password" disabled>`,
				);
			});
			const origin = new URL(fixture.url("/")).origin;

			const filled = await page.evaluate(fillScript({ origin, password: AWKWARD }));

			expect(filled).toBe(1);
			expect(await valueOf(page, "#pass")).toBe(AWKWARD);
			for (const hidden of ["#ghost", "#aria", "#gone", "#inert", "#off"]) expect(await valueOf(page, hidden)).toBe("");
			expect(await valueOf(page, "#kept")).toBe("typed by the user");
			expect(await valueOf(page, "#user")).toBe("");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"fills nothing when the page's origin is not the credential's",
		async () => {
			const fixture = startFixture();
			// Same server and port, different host: a different origin.
			const page = await openPage(fixture.url("/", "localhost"));

			expect(await page.evaluate(fillScript({ origin: new URL(fixture.url("/")).origin, password: "s3cret-for-127" }))).toBe(0);
			expect(await valueOf(page, "#pass")).toBe("");

			expect(await page.evaluate(fillScript({ origin: new URL(fixture.url("/", "localhost")).origin, password: "s3cret-for-localhost" }))).toBe(1);
			expect(await valueOf(page, "#pass")).toBe("s3cret-for-localhost");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"fills a cross-origin, out-of-process iframe's password field with ITS origin's credential, and never with the top page's",
		async () => {
			const fixture = startFixture();
			const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: await createRoot() });
			browsers.push(browser);
			const page = await browser.newPage();
			// Top page on 127.0.0.1, the form in an iframe on localhost: another site, so its own process.
			await page.goto(fixture.url("/framed"), { waitUntil: "load" });
			const frame = page.mainFrame().childFrames()[0];
			if (!frame) throw new Error("the fixture iframe did not load");
			await frame.waitForSelector("#pass");
			const { targetInfo } = await (await page.createCDPSession()).send("Target.getTargetInfo");
			const fill = (credential: { origin: string; password: string }): number =>
				JSON.parse(fillFrames({ ws: browser.wsEndpoint(), target: targetInfo.targetId, credential }));
			const iframePass = (): Promise<string | null> => frame.$eval("#pass", (el) => (el instanceof HTMLInputElement ? el.value : null));

			expect(fill({ origin: new URL(fixture.url("/")).origin, password: "top-page-password" })).toBe(0);
			expect(await iframePass()).toBe("");

			expect(fill({ origin: new URL(fixture.url("/", "localhost")).origin, password: AWKWARD })).toBe(1);
			expect(await iframePass()).toBe(AWKWARD);
			expect(await frame.$eval("#user", (el) => (el as HTMLInputElement).value)).toBe("");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a filled field that a show-password toggle turns into text is emptied",
		async () => {
			const fixture = startFixture();
			const page = await openPage(fixture.url("/"));
			expect(await page.evaluate(fillScript({ origin: new URL(fixture.url("/")).origin, password: "never-readable" }))).toBe(1);

			// A separate round trip: the page's microtasks (the observer) have run by the time the value is read.
			await page.$eval("#pass", (el) => el.setAttribute("type", "text"));

			expect(await valueOf(page, "#pass")).toBe("");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a show-password toggle that swaps in a text input carrying the value is emptied before a later read",
		async () => {
			const fixture = startFixture();
			const page = await openPage(fixture.url("/"));
			const password = "swapped-into-plain-text";
			expect(await page.evaluate(fillScript({ origin: new URL(fixture.url("/")).origin, password }))).toBe(1);

			// The page's own toggle: one task replaces the field with a new text input holding its value.
			await page.$eval("#pass", (el) => {
				if (!(el instanceof HTMLInputElement)) return;
				const shown = document.createElement("input");
				shown.id = "shown";
				shown.type = "text";
				shown.value = el.value;
				el.replaceWith(shown);
			});

			expect(await valueOf(page, "#shown")).toBe("");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a value mirrored into a text input by property alone is emptied by the next fill",
		async () => {
			const fixture = startFixture();
			const page = await openPage(fixture.url("/"));
			const credential = { origin: new URL(fixture.url("/")).origin, password: "mirrored-without-a-mutation" };
			const script = fillScript(credential);
			expect(await page.evaluate(script)).toBe(1);
			// A property write is no DOM mutation: nothing observes it.
			await page.$eval("#user", (el, value) => {
				if (el instanceof HTMLInputElement) el.value = value;
			}, credential.password);

			await page.evaluate(script);

			expect(await valueOf(page, "#user")).toBe("");
			expect(await valueOf(page, "#pass")).toBe(credential.password);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a handler's property-only copy into a text input is emptied by the same fill",
		async () => {
			const fixture = startFixture();
			const page = await openPage(fixture.url("/"));
			const password = "copied-by-the-page-handler";
			// The page's own input handler mirrors the field by property: no DOM mutation for an observer to see.
			await page.$eval("#pass", (el) =>
				el.addEventListener("input", () => {
					const user = document.querySelector("#user");
					if (user instanceof HTMLInputElement && el instanceof HTMLInputElement) user.value = el.value;
				}),
			);
			const script = fillScript({ origin: new URL(fixture.url("/")).origin, password });

			// Read inside the fill's own evaluate, before any timer can run: only a synchronous scrub passes.
			const read = await page.evaluate(
				`[${script}, document.querySelector("#user").value, document.querySelector("#pass").value]`,
			);

			// [fields filled, the handler's copy, the password field]
			expect(read).toEqual([1, "", password]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// The credential store: a file it cannot read as passwords is never rewritten
// ---------------------------------------------------------------------------

describe("the credential store", () => {
	test.each([
		{ name: "no origins object", body: `{"version":1,"passwords":{"https://old.example":"Old-Secret-1"}}` },
		{ name: "origins is an array", body: `{"version":1,"origins":["Old-Secret-1"]}` },
		{ name: "a non-string password", body: `{"version":1,"origins":{"https://old.example":"Old-Secret-1","https://odd.example":7}}` },
	])("a well-formed store of the wrong shape ($name) is refused and left byte-identical", async ({ body }) => {
		const profileDir = await createRoot();
		const file = join(profileDir, "credentials.json");
		await writeFile(file, body);

		const refused = await refusal(async () => resolveCredential(profileDir, { origin: "https://new.example", mode: "signup" }));

		expect(refused.code).toBe("credentials_unreadable");
		expect(refused.message).not.toContain("Old-Secret-1");
		expect(readFileSync(file, "utf8")).toBe(body);
	});
});

// ---------------------------------------------------------------------------
// The jev worker: what reaches jev's model and the worker's log
// ---------------------------------------------------------------------------

describeWithPython("the jev worker", () => {
	test("neither jev's goal nor a failed fill's log line carries the password", () => {
		const credential = { origin: SHOP, password: "Zq7!never-in-a-model-call" };
		// A CDP evaluate error commonly quotes the expression it failed on — here, the fill script with the password in it.
		const code = `import contextlib, io, json, sys, types
calls = []
def cdp(method, session_id=None, **params):
    calls.append(method)
    if method == "Runtime.evaluate":
        raise RuntimeError(f"Evaluation failed: {params['expression']}")
    raise AssertionError(f"unexpected CDP call {method}")
harness = types.ModuleType("browser_harness")
helpers = types.ModuleType("browser_harness.helpers")
helpers.cdp = cdp
harness.helpers = helpers
sys.modules["browser_harness"], sys.modules["browser_harness.helpers"] = harness, helpers
from dim_browser_bridge.jev_task import _fill_passwords, _jev_goal
credential = json.loads(sys.stdin.read())
class Browser:
    target = "page-target"
    session = "page-session"
log = io.StringIO()
with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
    filled = _fill_passwords(Browser(), credential)
json.dump({"goal": _jev_goal("Sign up as Ada Lovelace.", credential), "filled": filled, "log": log.getvalue(), "calls": calls}, sys.stdout)`;

		const { goal, filled, log, calls } = JSON.parse(python(code, JSON.stringify(credential))) as { goal: string; filled: boolean; log: string; calls: string[] };

		expect(goal).toStartWith("Sign up as Ada Lovelace.");
		expect(goal).not.toContain(credential.password);
		// The fill reached the evaluate and failed there, with an error that quotes the password.
		expect(calls).toEqual(["Runtime.evaluate"]);
		expect(filled).toBe(false);
		expect(log).toContain("password fill skipped");
		expect(log).not.toContain(credential.password);
	});
});
