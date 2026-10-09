// What the address bars make of what a person typed (the View's omnibox and the
// dock's "Open a page"), and how a URL is shown back to them. Pure functions: no
// React, no host — the dock runs in the host's page and cannot reach more.

export type AddressGuess = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d{1,5})?(\/|$)/i;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(:\d{1,5})?(\/|$)/;
/** `name.tld` with an optional port and path — the shape an address has
 *  before anyone typed a scheme. The TLD is letters, at least two of them. */
const DOTTED_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/|[?#]|$)/i;

/** The browser only opens http and https. A bare host is guessed: https for
 *  the public web, http for this machine and bare IPs (dev servers rarely
 *  carry certificates). Anything else is refused with a sentence, not guessed
 *  into a search — this browser has no search engine to send words to. */
export function guessAddress(raw: string): AddressGuess {
	const text = raw.trim();
	if (text.length === 0) return { ok: false, reason: "Type an address, like example.com." };
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
	if (scheme === "http" || scheme === "https") {
		try {
			return { ok: true, url: new URL(text).href };
		} catch {
			return { ok: false, reason: `“${text}” is not a valid address.` };
		}
	}
	if (/\s/.test(text)) return { ok: false, reason: `“${text}” isn't an address. Try something like example.com.` };
	const local = LOCAL_HOST.test(text) || IPV4_HOST.test(text);
	// `localhost:3000` parses as scheme "localhost" — only a real scheme is refused.
	if (scheme !== undefined && !local && !/^[^:]+:\d/.test(text)) {
		return { ok: false, reason: `Only http and https addresses can be opened here, not ${scheme}:.` };
	}
	if (!local && !DOTTED_HOST.test(text)) {
		return { ok: false, reason: `“${text}” isn't an address. Try something like ${text.toLowerCase()}.com.` };
	}
	try {
		return { ok: true, url: new URL(`${local ? "http" : "https"}://${text}`).href };
	} catch {
		return { ok: false, reason: `“${text}” is not a valid address.` };
	}
}

export interface AddressParts {
	readonly secure: boolean;
	/** The registrable part the eye looks for first. */
	readonly host: string;
	/** Everything after the host, shown quieter. */
	readonly rest: string;
	readonly blank: boolean;
}

/** A URL as the omnibox shows it at rest: scheme and `www.` dropped, host
 *  emphasised, the rest de-emphasised. */
export function addressParts(url: string): AddressParts {
	if (url.length === 0 || url === "about:blank" || url.startsWith("chrome://newtab")) {
		return { secure: false, host: "", rest: "", blank: true };
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { secure: false, host: url, rest: "", blank: false };
		}
		const path = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
		return {
			secure: parsed.protocol === "https:",
			host: `${parsed.hostname.replace(/^www\./, "")}${parsed.port ? `:${parsed.port}` : ""}`,
			rest: path,
			blank: false,
		};
	} catch {
		return { secure: false, host: url, rest: "", blank: false };
	}
}

/** The label a tab carries: its title, else its host, else "New Tab". */
export function tabLabel(title: string, url: string): string {
	if (title.trim().length > 0) return title;
	const parts = addressParts(url);
	return parts.blank ? "New Tab" : parts.host;
}
