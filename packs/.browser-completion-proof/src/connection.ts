/**
 * The connection report — which profiles are signed in to which sites, as the
 * Browser pack tells its host (dimension#1219) so Traction can show whether an
 * account can post and the dock can list the sites.
 *
 * Pure: observations in, report out. Nothing here reads a page, a file or the
 * credential store. A site is only ever in a report because a probe or a
 * publish check saw the signed-in marker (or its absence), a publish reached
 * `posted` (runtime.ts records those, store.ts persists them per profile), or
 * the page was only visited (`signedIn: null`: not checked, never a guess). A
 * host never observed is absent, never `signedIn: false`.
 */
import { getDomain, parse } from "tldts";
import { type ResolvedProfileMeta } from "./profile-meta.js";
import { RELAY_PROFILE } from "./profile-name.js";

/**
 * The vendor notification the host listens for on the pack's own MCP server.
 * Mirrors `PACK_CONNECTION_REPORT_METHOD` from `@dimension/sdk/artifactory`
 * (not yet published); keep the two identical.
 */
export const PACK_CONNECTION_REPORT_METHOD = "notifications/ai.insodimension/connection";
/**
 * The host silently drops a notification whose report JSON is larger, or whose
 * `account` is longer. Mirror `PACK_CONNECTION_REPORT_MAX_BYTES` and
 * `PACK_CONNECTION_ACCOUNT_MAX_BYTES` from `@dimension/sdk/artifactory`.
 */
export const PACK_CONNECTION_REPORT_MAX_BYTES = 64 * 1024;
export const PACK_CONNECTION_ACCOUNT_MAX_BYTES = 256;

/**
 * What one observation saw for one site on one profile. `observedAt` is epoch
 * ms. `signedIn: null`: the page was visited and no check exists for the site.
 */
export interface SiteObservation {
	signedIn: boolean | null;
	account?: string;
	observedAt: number;
}
/** One profile's observations, keyed by site host. */
export type SiteObservations = Record<string, SiteObservation>;
/** Every profile's observations, keyed by profile name. */
export type ConnectionObservations = Record<string, SiteObservations>;
/**
 * The `report` param: the full current map. Each one replaces the last wholesale.
 * `label`, `colour` and `avatar` are the profile's metadata (profile-meta.ts) for a reader that has none.
 */
export interface ConnectionReport {
	profiles: Record<string, { sites: SiteObservations } & Partial<ResolvedProfileMeta>>;
}
export interface ConnectionReportParams {
	/** `null` retracts the report. */
	report: ConnectionReport | null;
	account?: string;
	[key: string]: unknown;
}

/** The registrable domain under the full Public Suffix List, private suffixes included ("alice.github.io" is a site). */
const PSL = { allowPrivateDomains: true, extractHostname: false } as const;
/** An "@handle" not preceded by a word character, so an email's "@domain" is never one. */
const HANDLE = /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu;

/**
 * The site key for an origin: its bare registrable domain (eTLD+1 under the
 * Public Suffix List: "https://www.x.com" → "x.com", "https://shop.example.com.my"
 * → "example.com.my", "https://alice.github.io" → itself). A host with no
 * registrable domain (an IP literal, `localhost`) keys as itself. Null for
 * anything that is not an http(s) URL.
 */
export function siteHost(origin: string): string | null {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.hostname.replace(/\.$/, "");
	return getDomain(host, PSL) ?? host;
}
/**
 * Whether `origin` is a site on the public internet: an http(s) host under a
 * real suffix of the Public Suffix List (`example.com`, `bbc.co.uk`). A loopback
 * or private host (`localhost`, an IP literal, `app.localhost`, `printer.local`)
 * is not one: an agent testing its own app is not visiting a site.
 */
export function isPublicSite(origin: string): boolean {
	if (siteHost(origin) === null) return false;
	const { isIcann, isPrivate, isIp } = parse(new URL(origin).hostname, PSL);
	return !isIp && (isIcann === true || isPrivate === true);
}

/**
 * The account name in the page text an account selector matched: its LAST
 * "@handle" token when it has one (X renders the display name, which may hold
 * a mention, before the handle: "Jane (CEO @acme) @jane" → "@jane"; an email's
 * "@domain" is never a handle), else the text with whitespace collapsed.
 * Undefined when there is nothing.
 */
export function accountFromText(text: string | null | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const handle = text.match(HANDLE)?.at(-1);
	const account = handle ?? text.replace(/\s+/g, " ").trim();
	return account.length > 0 ? account : undefined;
}

/**
 * Which of two observations to keep first when there is room for one: a site
 * that was checked beats one that was only visited, then the newer wins.
 * Negative when `a` goes first.
 */
export function keepFirst(a: SiteObservation, b: SiteObservation): number {
	return Number(b.signedIn !== null) - Number(a.signedIn !== null) || b.observedAt - a.observedAt;
}

/**
 * An account as a report or a list may carry it: omitted when over the host's
 * 256 UTF-8 bytes (a cut-off handle would name a different account).
 */
export function reportableAccount(account: string | undefined): string | undefined {
	return account !== undefined && Buffer.byteLength(account, "utf8") <= PACK_CONNECTION_ACCOUNT_MAX_BYTES ? account : undefined;
}

/**
 * The report for `observations`: every profile except `relay`, every observed
 * site, each profile with its `meta` when given. It always fits the host's
 * caps: an account over 256 UTF-8 bytes is omitted, and while the report JSON
 * is over 64 KiB the oldest observations are dropped (a site only visited
 * first, then the oldest checked one).
 */
export function buildConnectionReport(observations: ConnectionObservations, meta: Record<string, ResolvedProfileMeta> = {}): ConnectionReport {
	const entries: Array<{ profile: string; host: string; site: SiteObservation }> = [];
	for (const [profile, sites] of Object.entries(observations)) {
		if (profile === RELAY_PROFILE) continue;
		for (const [host, observed] of Object.entries(sites)) {
			const site: SiteObservation = { signedIn: observed.signedIn, observedAt: observed.observedAt };
			const account = reportableAccount(observed.account);
			if (account !== undefined) site.account = account;
			entries.push({ profile, host, site });
		}
	}
	// Keeping a prefix drops the unchecked first, then the oldest.
	entries.sort((a, b) => keepFirst(a.site, b.site));
	const assemble = (count: number): ConnectionReport => {
		const profiles: ConnectionReport["profiles"] = {};
		for (let i = 0; i < count; i += 1) {
			const { profile, host, site } = entries[i];
			(profiles[profile] ??= { sites: {}, ...meta[profile] }).sites[host] = site;
		}
		return { profiles };
	};
	const fits = (report: ConnectionReport): boolean => Buffer.byteLength(JSON.stringify(report), "utf8") <= PACK_CONNECTION_REPORT_MAX_BYTES;
	const whole = assemble(entries.length);
	if (fits(whole)) return whole;
	// Dropping entries never grows the JSON: binary-search the largest newest prefix that fits.
	let low = 0;
	let high = entries.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(assemble(mid))) low = mid;
		else high = mid - 1;
	}
	return assemble(low);
}
