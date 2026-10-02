/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent debugging a web app in a throwaway browser stops being told
 *  what Chrome itself refused (a Content-Security-Policy block, a fetch the browser stopped for CORS), which is most of
 *  what a developer needs and the first thing they open DevTools for, or a page's own scripts learn they are watched.
 *
 *  A throwaway browser keeps CDP `Runtime` off (a page can tell when it is on), so puppeteer's `pageerror` and its
 *  Runtime-borne `console` events are gone. What replaces them: Chrome's own messages arrive through the Log domain
 *  (which a page cannot detect), the page's own `console.*` calls through the Console domain, and an uncaught
 *  exception only on a page served from this machine (a listener the pack installs there). On any other site an
 *  uncaught exception is the one thing such a browser does not hear; these tests pin both halves. Real Chrome.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LogEntry } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown, waitUntil } from "./fixture";

const servers: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/**
 * A site whose /app page is under a Content-Security-Policy that refuses inline scripts, runs a script of its own that asks
 * another origin (no CORS headers) for data and then throws, and prints a console error of its own.
 */
function startSite(): { port: number | undefined } {
	const elsewhere = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("data") });
	servers.push(elsewhere);
	const site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/app") {
				const page = '<!doctype html><title>app</title><p>app</p><script>window.inline = "ran"</script><script src="/app.js"></script>';
				return new Response(page, { headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'" } });
			}
			if (pathname === "/app.js") {
				const script = `fetch("http://127.0.0.1:${elsewhere.port}/data").catch(() => undefined);
console.error("printed by the page");
setTimeout(() => { document.body.dataset.thrown = "yes"; throw new Error("uncaught in the page"); }, 50);`;
				return new Response(script, { headers: { "content-type": "text/javascript" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	servers.push(site);
	return { port: site.port };
}

/** Open a throwaway browser on `url`, wait until the page has thrown, and answer everything its log held at the end. */
async function logsOf(runtime: BrowserRuntime, url: string): Promise<LogEntry[]> {
	const { browserId } = await runtime.open({});
	await perform(runtime, browserId, { kind: "navigate", url });
	await runtime.actMany(browserId, [{ kind: "wait", selector: "body[data-thrown]" }], "app");
	const seen: LogEntry[] = [];
	// The log fills as Chrome's events arrive; read until the CORS refusal (the last thing the page triggers) is in.
	return waitUntil(
		"the page's log to hold Chrome's CORS refusal",
		async () => {
			seen.push(...(await runtime.logs(browserId)));
			return seen;
		},
		(entries) => entries.some((entry) => /CORS policy/.test(entry.text)),
	);
}

const texts = (entries: readonly LogEntry[], type: LogEntry["type"]): string[] => entries.filter((entry) => entry.type === type).map((entry) => entry.text);

describeWithChrome("a throwaway browser's page log", () => {
	test("tells the agent what Chrome itself refused, and what the page threw, on a page served from this machine", async () => {
		const { port } = startSite();
		const runtime = newRuntime(await createRoot());
		const entries = await logsOf(runtime, `http://127.0.0.1:${port}/app`);
		const errors = texts(entries, "console.error");
		// Chrome's own refusals: the Log domain.
		expect(errors.some((text) => /Content Security Policy/i.test(text))).toBe(true);
		expect(errors.some((text) => /blocked by CORS policy/.test(text))).toBe(true);
		// The page's own console call: the Console domain.
		expect(errors).toContainEqual(expect.stringContaining("printed by the page"));
		// Its uncaught exception: reported only because the page is served from this machine.
		expect(texts(entries, "exception")).toContainEqual(expect.stringContaining("uncaught in the page"));
	}, BROWSER_TEST_TIMEOUT_MS);

	test("tells the agent what Chrome itself refused on any other site too, but never hears an uncaught exception there, and puts nothing in the page to try", async () => {
		const { port } = startSite();
		// `site.test` is not this machine as far as the page can tell, though the browser is made to reach it here.
		const runtime = newRuntime(await createRoot(), { launchArgs: ["--host-resolver-rules=MAP site.test 127.0.0.1"] });
		const entries = await logsOf(runtime, `http://site.test:${port}/app`);
		const errors = texts(entries, "console.error");
		expect(errors.some((text) => /Content Security Policy/i.test(text))).toBe(true);
		expect(errors.some((text) => /blocked by CORS policy/.test(text))).toBe(true);
		expect(errors).toContainEqual(expect.stringContaining("printed by the page"));
		// The one thing lost: the exception was thrown (the page marked it), and is not reported. Nothing was installed to listen for it.
		expect(texts(entries, "exception")).toEqual([]);
		expect(JSON.stringify(entries)).not.toContain("dimension-exception");
	}, BROWSER_TEST_TIMEOUT_MS);
});
