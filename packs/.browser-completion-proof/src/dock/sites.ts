// The sites the panel can start a sign-in on, keyed the way the connection
// report keys them. Each one's ORIGIN and name come off the shipped publish
// preset (`recipes/`), so a preset that moves its origin moves the sign-in with
// it; only the login path is the panel's own. Named imports, so the bundle
// carries those two fields and not the presets' selectors and notes.

import { origin as blueskyOrigin, platform as blueskyName } from "../../recipes/bluesky-post.json";
import { origin as linkedinOrigin, platform as linkedinName } from "../../recipes/linkedin-post.json";
import { origin as redditOrigin, platform as redditName } from "../../recipes/reddit-comment.json";
import { origin as xOrigin, platform as xName } from "../../recipes/x-post.json";

export interface SignInSite {
	/** The report's site key: the origin's registrable domain. */
	readonly host: string;
	/** The name a person knows the site by ("X", "LinkedIn"). */
	readonly label: string;
	/** Where a sign-in starts. */
	readonly loginUrl: string;
}

/** `connection.ts` keys a site by its registrable domain (tldts). Every preset
 *  origin is either that domain or its `www.` host, so dropping the `www.`
 *  yields the same key without shipping the Public Suffix List into the page. */
function fromPreset(platform: string, presetOrigin: string, loginPath: string): SignInSite {
	const origin = new URL(presetOrigin);
	return { host: origin.hostname.replace(/^www\./, ""), label: platform, loginUrl: new URL(loginPath, origin).href };
}

export const SIGN_IN_SITES: readonly SignInSite[] = [
	fromPreset(xName, xOrigin, "/login"),
	fromPreset(linkedinName, linkedinOrigin, "/login"),
	fromPreset(redditName, redditOrigin, "/login"),
	// Bluesky's home page IS its sign-in page for a signed-out visitor.
	fromPreset(blueskyName, blueskyOrigin, "/"),
	// Google has no publish preset to take an origin from, and a profile is usually one Google account: the sign-in page is Google's own account page.
	{ host: "google.com", label: "Google", loginUrl: "https://accounts.google.com/" },
];

const BY_HOST: ReadonlyMap<string, SignInSite> = new Map(SIGN_IN_SITES.map(site => [site.host, site]));

/** The known site for a report key, if the panel has one. */
export function knownSite(host: string): SignInSite | undefined {
	return BY_HOST.get(host);
}

/** Where to start signing in to `host`: its login page when known, else the site itself. */
export function signInUrl(host: string): string {
	return BY_HOST.get(host)?.loginUrl ?? `https://${host}/`;
}
