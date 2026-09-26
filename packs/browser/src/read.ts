/**
 * browser_read — one logged-out read of a public page, and when it is blocked.
 *
 * The read path is deliberately narrow: this server's own headless browser, a
 * fresh incognito context per read (no cookie jar, no profile), one
 * navigation, the page's readable text. A page that will not serve that
 * reader is reported `blocked` with the reason and never worked around — no
 * retry through a mirror, proxy, cache or archive, no solving or waiting out a
 * challenge.
 *
 * Two refusals are enforced on every request the reader sends, redirects and
 * script navigations included (`ReadPolicy`): mirror/proxy hosts are not
 * navigated to, and nothing is fetched from a loopback, private, link-local or
 * CGNAT address — by name, by resolved address, and by the address the
 * browser actually connected to.
 *
 * The page evidence comes from one fixed page script (`READ_PAGE_SCRIPT`),
 * read by the reader; this module only judges it.
 */
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { PageRead, ReadPolicy } from "./engines/types.js";

/** How long a read waits for the page's `load`. */
export const READ_TIMEOUT_MS = 15_000;
export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 100_000;

/**
 * Hosts that re-serve another site's pages (front-ends, scrapers, caches,
 * archives, translation proxies). Reading through one is routing around the
 * site, so they are not a read path. `name.*` matches any host whose first
 * label is `name`; any other entry matches that host and its subdomains.
 */
export const MIRROR_HOSTS: readonly string[] = [
	"safereddit.com",
	"redlib.*",
	"libreddit.*",
	"teddit.*",
	"nitter.*",
	"xcancel.com",
	"api.pullpush.io",
	"r.jina.ai",
	"12ft.io",
	"web.archive.org",
	"archive.ph",
	"archive.today",
	"archive.is",
	"archive.li",
	"archive.vn",
	"archive.md",
	"archive.fo",
	"webcache.googleusercontent.com",
	"translate.goog",
];
export const MIRROR_REASON = "mirror/proxy hosts are not a read path";
export const TIMEOUT_REASON = `timeout: the page did not load within ${READ_TIMEOUT_MS / 1000} s`;

/** HTTP statuses that mean "not for this reader"; every 5xx is added in `blockedReason`. */
const BLOCKED_STATUSES: readonly number[] = [401, 403, 429, 451];
/**
 * A sign-in page: a log-in / sign-in / sign-up / authwall path segment, with or
 * without `-`/`_` (so `/accounts/login`, `/users/sign_in`, `/sign-in`,
 * `/i/flow/login`, `/login.php`, LinkedIn's `/authwall`).
 */
const LOGIN_PATH = /\/(?:log[-_]?in|sign[-_]?in|sign[-_]?up|authwall)(?:[/.;]|$)/i;
/** Challenge providers, by host (and its subdomains). */
const CHALLENGE_HOSTS: readonly string[] = ["recaptcha.net", "hcaptcha.com", "challenges.cloudflare.com"];
/**
 * reCAPTCHA is served under a `/recaptcha/` path from hosts that also serve
 * everything else (www.google.com/recaptcha/…, www.gstatic.com/recaptcha/…),
 * so its signature is the path, on any host.
 */
const RECAPTCHA_PATH = "/recaptcha/";
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

/**
 * A challenge is something the reader is asked to pass: the interstitial's
 * title, or a VISIBLE challenge frame. A provider's script alone is not one —
 * reCAPTCHA v3 and Turnstile/hCaptcha are loaded site-wide for invisible
 * scoring and comment forms — so only frames the page script saw rendered
 * count, and reCAPTCHA's invisible-scoring badge (`anchor?size=invisible`)
 * does not.
 */
function challengeEvidence(page: PageRead): string | null {
	if (CHALLENGE_TITLE.test(page.title)) return `the page title is "${page.title.trim().slice(0, 80)}"`;
	for (const src of page.frames) {
		let url: URL;
		try {
			url = new URL(src);
		} catch {
			continue;
		}
		if (isChallengeFrame(url)) return `the page shows a challenge frame from ${url.origin}${url.pathname}`;
	}
	return null;
}

function isChallengeFrame(url: URL): boolean {
	const path = url.pathname.toLowerCase();
	if (path.startsWith(RECAPTCHA_PATH)) return !(path.endsWith("/anchor") && url.searchParams.get("size") === "invisible");
	const host = url.hostname.toLowerCase();
	return CHALLENGE_HOSTS.some((challenge) => host === challenge || host.endsWith(`.${challenge}`));
}

function pathnameOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Private addresses — the reader reads the public web only
// ---------------------------------------------------------------------------

/** Names that always mean this machine or the local network, whatever DNS says. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local)$/i;
/** IPv4 ranges that are not the public internet: [network, prefix length]. */
const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
	[0x00000000, 8], // "this network"
	[0x0a000000, 8], // RFC 1918
	[0x64400000, 10], // CGNAT (RFC 6598)
	[0x7f000000, 8], // loopback
	[0xa9fe0000, 16], // link-local, incl. 169.254.169.254 cloud metadata
	[0xac100000, 12], // RFC 1918
	[0xc0000000, 24], // IETF protocol assignments
	[0xc0a80000, 16], // RFC 1918
	[0xc6120000, 15], // benchmarking
	[0xe0000000, 3], // multicast, reserved, broadcast
];

/** Whether `ip` (an IPv4 or IPv6 literal, brackets allowed) is loopback, private, link-local, CGNAT or otherwise not public. */
export function isPrivateAddress(ip: string): boolean {
	const address = ip.replace(/^\[|\]$/g, "");
	if (isIPv4(address)) return privateV4(v4Number(address));
	if (!isIPv6(address)) return false;
	const words = v6Words(address);
	if (words === null) return true;
	const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
	const v4 = ((w6 << 16) | w7) >>> 0;
	if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0) {
		if (w5 === 0xffff || w5 === 0) return w5 === 0 && w6 === 0 ? true : privateV4(v4); // ::, ::1, ::ffff:a.b.c.d, ::a.b.c.d
	}
	if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return privateV4(v4); // NAT64
	if ((w0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((w0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((w0 & 0xff00) === 0xff00) return true; // multicast
	return false;
}

function privateV4(value: number): boolean {
	return PRIVATE_V4.some(([base, prefix]) => (value >>> (32 - prefix)) === (base >>> (32 - prefix)));
}

function v4Number(address: string): number {
	return address.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

/** The eight 16-bit words of an IPv6 literal, or null when it cannot be expanded. */
function v6Words(address: string): number[] | null {
	let text = address.toLowerCase().replace(/%.*$/, "");
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (dotted?.[1]) {
		const value = v4Number(dotted[1]);
		text = `${text.slice(0, -dotted[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
	}
	const [head = "", tail] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = tail === undefined || tail === "" ? [] : tail.split(":");
	const fill = tail === undefined ? 0 : 8 - left.length - right.length;
	if (fill < 0) return null;
	const words = [...left, ...Array<string>(fill).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
	return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function privateReason(host: string): string {
	return `private address: ${host} is loopback, private or link-local; browser_read reads the public web only`;
}

/**
 * The reader's request policy for ONE read. `allowPrivateHosts` exempts exact
 * hostnames from the private-address refusal; it exists for the test fixture
 * on 127.0.0.1 and is never set in production. DNS answers are cached for the
 * read, so a page's many sub-resources cost one lookup per host.
 */
export function readPolicy(allowPrivateHosts: readonly string[] = []): ReadPolicy {
	const allowed = new Set(allowPrivateHosts.map((host) => host.toLowerCase()));
	const resolved = new Map<string, Promise<string | null>>();
	const privateHost = (url: string): Promise<string | null> => {
		let host: string;
		try {
			host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			return Promise.resolve(null);
		}
		if (allowed.has(host)) return Promise.resolve(null);
		let answer = resolved.get(host);
		if (!answer) {
			answer = resolveReason(host);
			resolved.set(host, answer);
		}
		return answer;
	};
	return {
		async navigation(url) {
			let host: string;
			try {
				host = new URL(url).hostname;
			} catch {
				return null;
			}
			if (isMirrorHost(host)) return MIRROR_REASON;
			return await privateHost(url);
		},
		subresource: privateHost,
		connected(url, ip) {
			let host: string;
			try {
				host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
			} catch {
				return null;
			}
			return !allowed.has(host) && isPrivateAddress(ip) ? privateReason(host) : null;
		},
	};
}

/** A host's refusal: by name, by literal, then by every address it resolves to. */
async function resolveReason(host: string): Promise<string | null> {
	if (LOCAL_NAME.test(host)) return privateReason(host);
	const literal = host.replace(/^\[|\]$/g, "");
	if (isIPv4(literal) || isIPv6(literal)) return isPrivateAddress(literal) ? privateReason(host) : null;
	try {
		const addresses = await lookup(host, { all: true, verbatim: true });
		return addresses.some((entry) => isPrivateAddress(entry.address)) ? privateReason(host) : null;
	} catch {
		// Unresolvable here: the browser's own lookup fails the same way, and
		// whatever it does connect to is checked again (`connected`).
		return null;
	}
}
