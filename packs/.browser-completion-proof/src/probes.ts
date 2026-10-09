/**
 * Site probes — how the pack itself notices that a profile is signed in.
 *
 * A probe is two CSS selectors for a known site: one that is on the page only
 * when someone is signed in, and one that holds who. The runtime runs it by
 * itself after a page finishes loading in a saved profile, and once more when
 * the browser closes, so a person signing in in the View shows up in the list
 * with no agent doing anything. Every read here is a fixed read script with the
 * selector as DATA (engines/page-scripts.ts); nothing the page or a caller
 * wrote runs, and nothing is clicked.
 *
 * A site with no probe is never guessed at: it is "visited, not checked".
 *
 * X, LinkedIn, Reddit and Bluesky take their selectors from the publish
 * presets (`recipes/`), so a preset that is fixed fixes the probe. Google has
 * none to borrow, and is the one that matters most: a profile is usually one
 * Google account. Like the presets, every selector here is modelled on the
 * site's page and tested against a copy of it (test/profile-probes.test.ts),
 * not yet seen on the live site.
 */
import { accountFromText } from "./connection.js";
import { account as xAccount, signedIn as xSignedIn } from "../recipes/x-post.json";
import { signedIn as blueskySignedIn } from "../recipes/bluesky-post.json";
import { signedIn as linkedinSignedIn } from "../recipes/linkedin-post.json";
import { signedIn as redditSignedIn } from "../recipes/reddit-comment.json";

/** How a probe finds the account behind a signed-in marker. Every read is capped at the host's 256-byte account. */
export type AccountRead =
	/** The marker's text: its last "@handle", else the text itself. */
	| { from: "text"; selector: string }
	/** The marker's link: `pick` takes the absolute href. */
	| { from: "href"; selector: string; pick: (href: string) => string | undefined }
	/**
	 * The marker's `aria-label`: `pick` takes it. Only the one account the marker names: the page's other links are
	 * never counted, because a page can hold any link its author likes (a mail body), so a count of "other accounts"
	 * read from the page is not evidence of anything.
	 */
	| { from: "label"; selector: string; pick: (label: string) => string | undefined };

export interface SiteProbe {
	/** The report's site key: the registrable domain. */
	readonly host: string;
	/** Present only when someone is signed in. */
	readonly signedIn: string;
	readonly account?: AccountRead;
	/**
	 * Where the marker's absence means signed out: the site's front page and its login pages, where a signed-in
	 * page would certainly show it. Anywhere else a missing marker proves nothing (a checkpoint page, an error
	 * page, a settings page without the nav), so no verdict is made.
	 */
	readonly loginPaths: readonly string[];
}

/** What one look at a page found. */
export type ProbeVerdict = { signedIn: true; account?: string } | { signedIn: false };

/** The reads a probe needs: the driver's own, which are all fixed scripts. */
export interface ProbeReader {
	waitFor(condition: { selector: string }, timeoutMs: number, mask: (value: string) => string): Promise<boolean>;
	hasElement(selector: string): Promise<boolean>;
	readText(selector: string, limit: number): Promise<string | null>;
	linkHrefs(selector: string, limit: number): Promise<string[]>;
	readLabel(selector: string, limit: number): Promise<string | null>;
}

/** A Bluesky profile link, `https://bsky.app/profile/<handle>`: the handle. */
const bskyHandle = (href: string): string | undefined => {
	const handle = new URL(href).pathname.match(/^\/profile\/([^/]+)\/?$/)?.[1];
	return handle === undefined ? undefined : `@${decodeURIComponent(handle)}`;
};

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
/** The email in Google's "Google Account: Jane Doe (jane@gmail.com)". The name is never kept: an email names the account. */
const googleEmail = (label: string): string | undefined => label.match(EMAIL)?.[0];
const GOOGLE_MARKER = 'a[aria-label^="Google Account"]';

export const SITE_PROBES: readonly SiteProbe[] = [
	{ host: "x.com", signedIn: xSignedIn, account: { from: "text", selector: xAccount }, loginPaths: ["/login", "/i/flow/login"] },
	{ host: "linkedin.com", signedIn: linkedinSignedIn, loginPaths: ["/login", "/uas/login"] },
	{ host: "reddit.com", signedIn: redditSignedIn, loginPaths: ["/login"] },
	{ host: "bsky.app", signedIn: blueskySignedIn, account: { from: "href", selector: blueskySignedIn, pick: bskyHandle }, loginPaths: [] },
	// A Google sign-in page shows no marker while ANOTHER account is signed in (adding one is the whole point), so no login path counts.
	{
		host: "google.com",
		signedIn: GOOGLE_MARKER,
		account: { from: "label", selector: GOOGLE_MARKER, pick: googleEmail },
		loginPaths: [],
	},
];

/** The probe for a site key, among `table`. */
export function probeFor(host: string, table: readonly SiteProbe[] = SITE_PROBES): SiteProbe | undefined {
	return table.find((probe) => probe.host === host);
}

/** How long a missing marker is waited for on a page where its absence decides: a single-page app draws it after `load`. */
export const SETTLE_MS = 3_000;
const ACCOUNT_CHARS = 256;

/** Whether a missing marker on `url` is a verdict: the site's front page, or one of its login pages. */
function decides(probe: SiteProbe, url: URL): boolean {
	return url.pathname === "/" || probe.loginPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));
}

/**
 * Look at the active tab once. The marker found: signed in, with the account
 * when it can be read. The marker missing where that decides: signed out. The
 * marker missing anywhere else: no verdict (`undefined`), and no waiting.
 */
export async function readProbe(reader: ProbeReader, probe: SiteProbe, url: string, settleMs: number = SETTLE_MS): Promise<ProbeVerdict | undefined> {
	const decisive = decides(probe, new URL(url));
	// Waiting is for a page that is still drawing; `settleMs: 0` (the look as a browser closes) asks the page as it is, once.
	const shown = decisive && settleMs > 0 ? await reader.waitFor({ selector: probe.signedIn }, settleMs, (value) => value) : await reader.hasElement(probe.signedIn);
	if (!shown) return decisive ? { signedIn: false } : undefined;
	const account = await readAccount(reader, probe.account);
	return account === undefined ? { signedIn: true } : { signedIn: true, account };
}

async function readAccount(reader: ProbeReader, read: AccountRead | undefined): Promise<string | undefined> {
	if (read === undefined) return undefined;
	try {
		if (read.from === "text") return accountFromText(await reader.readText(read.selector, ACCOUNT_CHARS));
		if (read.from === "href") {
			const href = (await reader.linkHrefs(read.selector, 1))[0];
			return href === undefined ? undefined : read.pick(href);
		}
		const label = await reader.readLabel(read.selector, ACCOUNT_CHARS);
		return label === null ? undefined : read.pick(label);
	} catch {
		// A page that changed under the read, or a href that is not a URL: signed in, account unknown. Never a guess.
		return undefined;
	}
}
