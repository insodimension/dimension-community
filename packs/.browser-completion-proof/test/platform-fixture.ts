/**
 * Fixture copies of the platforms' compose pages (test/platform-fixtures),
 * served on 127.0.0.1, and the test-only origin rebase that points a shipped
 * preset at them.
 *
 * Each fixture is served ONLY at the path its preset composes on (like the
 * real site's router), so a preset whose composeUrl or target path drifted
 * finds no compose page. The signed-in regions (`<!-- signed-in -->` …
 * `<!-- /signed-in -->`) are served only after `/__fixture/login` set the
 * session cookie. Every POST is the platform's create call: its JSON `text` is
 * recorded (the real write count) and answered with the next id, from which
 * the page builds its receipt URL in the platform's own shape.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PublishPreset } from "../src/presets";

/** Where each fixture is served: the path its preset composes on (Reddit: the thread a target names). */
export const PLATFORM_ROUTES: Readonly<Record<string, string>> = {
	"x-post": "/compose/post",
	"bluesky-post": "/intent/compose",
	"linkedin-post": "/feed/",
	"reddit-comment": "/r/fixtures/comments/1fx0abc/fixture_thread/",
};

export interface PlatformFixture {
	readonly origin: string;
	url(path: string): string;
	/** GET requests for `path`. */
	hits(path: string): number;
	/** The `text` of every create call that reached the server, in order. */
	submissions(): readonly string[];
	stop(): Promise<void>;
}

const COOKIE = "fixture_session";
const SIGNED_IN = /<!-- signed-in -->[\s\S]*?<!-- \/signed-in -->/g;

export function startPlatformFixture(name: string): PlatformFixture {
	const route = PLATFORM_ROUTES[name];
	if (route === undefined) throw new Error(`no platform fixture for ${name}`);
	const markup = readFileSync(new URL(`./platform-fixtures/${name}.html`, import.meta.url), "utf8");
	const session = randomBytes(8).toString("hex");
	const hits = new Map<string, number>();
	const submissions: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method === "POST") {
				const body = (await request.json()) as { text?: unknown };
				submissions.push(String(body.text));
				return Response.json({ id: submissions.length });
			}
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
			if (pathname === "/__fixture/login") {
				return new Response("<!doctype html><title>signed in</title><p>signed in</p>", { headers: { ...headers, "set-cookie": `${COOKIE}=${session}; Path=/; SameSite=Lax` } });
			}
			if (pathname !== route) return new Response("not found", { status: 404 });
			const signedIn = (request.headers.get("cookie") ?? "").includes(`${COOKIE}=${session}`);
			return new Response(signedIn ? markup : markup.replace(SIGNED_IN, ""), { headers });
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return {
		origin,
		url: (path) => `${origin}${path}`,
		hits: (path) => hits.get(path) ?? 0,
		submissions: () => submissions,
		stop: async () => {
			await server.stop(true);
		},
	};
}

/**
 * TEST ONLY: the same preset on the fixture's origin. Swaps `origin` and the
 * fixed `composeUrl` onto `fixtureOrigin` (path and query kept); every
 * selector and the receipt path stay exactly as shipped. A `composeFrom:
 * "target"` preset takes its target from the caller, on this origin too.
 */
export function rebasePreset(preset: PublishPreset, fixtureOrigin: string): PublishPreset {
	const onFixture = (href: string): string => {
		const url = new URL(href);
		return `${fixtureOrigin}${url.pathname}${url.search}${url.hash}`;
	};
	return { ...preset, origin: fixtureOrigin, ...(preset.composeUrl === undefined ? {} : { composeUrl: onFixture(preset.composeUrl) }) };
}
