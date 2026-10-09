/**
 * A tiny site for the profile tests: pages that look signed in or signed out the
 * way the real sites' markup does, served on `*.localhost` names (Chrome sends
 * every one to loopback) so one server is several different SITES with several
 * different probes. Nothing here is a real site, and nothing is typed anywhere.
 */
import { type SiteProbe, SITE_PROBES } from "../src/probes";

export const SAVED_PASSWORD = "hunter2-pw-9f3k";

const page = (body: string, head = ""): Response =>
	new Response(`<!doctype html><html><head><meta charset="utf-8"><title>page</title>${head}</head><body>${body}</body></html>`, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});

const PAGES: Record<string, () => Response> = {
	// Signed out: the front page with a sign-in link.
	"/": () => page('<a id="login" href="/login">Sign in</a>'),
	"/signed-in": () => page('<div id="me">Alice (CEO @acme) @alice</div>'),
	// A page of the site where a missing marker proves nothing.
	"/deep/page": () => page("<p>settings</p>"),
	// A single-page app draws its nav after `load`.
	"/late": () => page("<p>loading</p>", '<script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", \'<div id="me">Late @late</div>\'); }, 700);</script>'),
	// A sign-in done in place: no navigation, so no page load to look at.
	"/flip": () => page('<button id="go" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<div id=me>Bo @bo</div>\')">Sign in</button>'),
	"/pw": () => page(`<div id="me">Signed in as ${SAVED_PASSWORD}</div>`),
	// The account button, and a stranger's content (a mail body) full of `authuser` links, on Google's own host and others.
	"/google": () =>
		page(
			[
				'<a class="gb_B" aria-label="Google Account: Jane Doe  \n(jane@gmail.com)" href="https://accounts.google.com/SignOutOptions?authuser=0">J</a>',
				'<div class="mail-body"><a href="https://evil.example/?authuser=1">a</a><a href="https://evil.example/?authuser=2">b</a><a href="https://accounts.google.com/AccountChooser?authuser=3">c</a></div>',
			].join(""),
		),
	"/google-out": () => page('<a href="https://accounts.google.com/ServiceLogin">Sign in</a>'),
	"/bsky": () => page('<a aria-label="Profile" href="/profile/alice.bsky.social">Profile</a>'),
	// A form control whose label is not the page's to hand over.
	"/control": () => page('<input id="acct" aria-label="leak@secret.example" value="x"><div id="me">ok</div>'),
	"/plain": () => page("<p>plain</p>"),
};

export interface ProfileSite {
	/** `http://<host>.localhost:<port><path>` */
	url(host: string, path: string): string;
	stop(): Promise<void>;
}

export function startProfileSite(): ProfileSite {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const render = PAGES[new URL(request.url).pathname];
			return render === undefined ? new Response("not found", { status: 404 }) : render();
		},
	});
	return {
		url: (host, path) => `http://${host}:${server.port}${path}`,
		stop: async () => {
			await server.stop(true);
		},
	};
}

/** A probe for `host` whose marker is `#me` and whose account is that element's text. */
export const markerProbe = (host: string, loginPaths: readonly string[] = []): SiteProbe => ({ host, signedIn: "#me", account: { from: "text", selector: "#me" }, loginPaths });

/** The SHIPPED probe for a real site, moved onto a local name: its own selectors, on a page that mimics the site's markup. */
export function shippedProbeOn(realHost: string, host: string): SiteProbe {
	const probe = SITE_PROBES.find((candidate) => candidate.host === realHost);
	if (probe === undefined) throw new Error(`no shipped probe for ${realHost}`);
	return { ...probe, host };
}
