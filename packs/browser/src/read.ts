/**
 * browser_read — one logged-out read of a public page, and when it is blocked.
 *
 * The read path is deliberately narrow: this server's own headless browser on
 * a profile nobody signs in to, one navigation, the page's readable text. A
 * page that will not serve that reader is reported `blocked` with the reason
 * and never worked around — no retry through a mirror, proxy, cache or
 * archive, no solving or waiting out a challenge. Mirror and proxy hosts are
 * refused before anything navigates.
 *
 * Everything here is pure: the evidence comes from one fixed page script
 * (`READ_PAGE_SCRIPT`), read by the driver; this module only judges it.
 */
import type { PageRead } from "./engines/types.js";

/** The default read profile: dedicated, and never signed in to by this pack. */
export const READ_PROFILE = "read";
/** How long a read waits for the page's `load`. */
export const READ_TIMEOUT_MS = 15_000;
export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 100_000;

/**
 * Hosts that re-serve another site's pages (front-ends, scrapers, caches,
 * archives). Reading through one is routing around the site, so they are not
 * a read path. `name.*` matches any host whose first label is `name`; any
 * other entry matches that host and its subdomains.
 */
export const MIRROR_HOSTS: readonly string[] = [
	"safereddit.com",
	"redlib.*",
	"libreddit.*",
	"teddit.*",
	"nitter.*",
	"api.pullpush.io",
	"r.jina.ai",
	"web.archive.org",
	"archive.ph",
	"archive.today",
];
export const MIRROR_REASON = "mirror/proxy hosts are not a read path";
export const TIMEOUT_REASON = `timeout: the page did not load within ${READ_TIMEOUT_MS / 1000} s`;

/** HTTP statuses that mean "not for this reader"; every 5xx is added in `blockedReason`. */
const BLOCKED_STATUSES: readonly number[] = [401, 403, 429, 451];
/** A sign-in page: a `/login` or `/signin` path segment (so `/accounts/login`, `/i/flow/login`, `/login.php`). */
const LOGIN_PATH = /\/(?:login|signin)(?:[/.]|$)/i;
/** Challenge providers, by host (and its subdomains). */
const CHALLENGE_HOSTS: readonly string[] = ["recaptcha.net", "hcaptcha.com", "challenges.cloudflare.com"];
/**
 * reCAPTCHA is served under a `/recaptcha/` path from hosts that also serve
 * everything else (www.google.com/recaptcha/api.js, www.gstatic.com/recaptcha/…),
 * so its signature is the path, on any host.
 */
const CHALLENGE_PATH_PREFIXES: readonly string[] = ["/recaptcha/"];
/** Interstitial titles of bot checks (Cloudflare's "Just a moment…", "Attention Required!"). */
const CHALLENGE_TITLE = /^\s*(?:just a moment|attention required)/i;

/** Whether `hostname` is a mirror or proxy host (MIRROR_HOSTS). */
export function isMirrorHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
	return MIRROR_HOSTS.some((entry) =>
		entry.endsWith(".*") ? host.startsWith(entry.slice(0, -1)) : host === entry || host.endsWith(`.${entry}`),
	);
}

/** Why this page is blocked for a logged-out reader, or null when it can be read. */
export function blockedReason(page: PageRead): string | null {
	const status = page.httpStatus;
	if (status !== null && (BLOCKED_STATUSES.includes(status) || status >= 500)) return `HTTP ${status}`;
	const challenge = challengeEvidence(page);
	if (challenge !== null) return `CAPTCHA or bot check: ${challenge}`;
	if (LOGIN_PATH.test(pathnameOf(page.url))) return "login wall: the page is a sign-in page";
	if (page.passwordVisible) return "login wall: the page shows a password field";
	return null;
}

function challengeEvidence(page: PageRead): string | null {
	if (CHALLENGE_TITLE.test(page.title)) return `the page title is "${page.title.trim().slice(0, 80)}"`;
	for (const src of page.embeds) {
		let url: URL;
		try {
			url = new URL(src);
		} catch {
			continue;
		}
		const host = url.hostname.toLowerCase();
		if (
			CHALLENGE_HOSTS.some((challenge) => host === challenge || host.endsWith(`.${challenge}`)) ||
			CHALLENGE_PATH_PREFIXES.some((prefix) => url.pathname.toLowerCase().startsWith(prefix))
		) {
			return `the page embeds ${url.origin}${url.pathname}`;
		}
	}
	return null;
}

function pathnameOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}
