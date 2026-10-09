/**
 * Tab favicons: fetched server-side, returned as bounded `data:` URLs, cached
 * per page origin. A favicon is decoration, so every failure (no icon, too
 * big, not an image, slow host) is a cached `null`, never an error.
 */

/** Largest data: URL handed to the View. */
export const MAX_FAVICON_DATA_URL = 32 * 1024;
const MAX_ORIGINS = 256;
const FETCH_TIMEOUT_MS = 4_000;
/** Base64 grows 4/3; this many raw bytes always fit the data: URL bound with any image mime type. */
const MAX_FAVICON_BYTES = Math.floor((MAX_FAVICON_DATA_URL - 64) * 3 / 4);

export class FaviconCache {
	/** Insertion-ordered, so the oldest origin is evicted first. `undefined` = not looked up yet. */
	readonly #icons = new Map<string, string | null>();
	readonly #pending = new Map<string, Promise<void>>();

	/** The cached icon for `pageUrl`'s origin, or null (unknown yet, none, or not http/https). */
	get(pageUrl: string): string | null {
		const origin = originOf(pageUrl);
		return origin === null ? null : (this.#icons.get(origin) ?? null);
	}

	/**
	 * Resolve and cache the icon for `pageUrl`'s origin once. `declared` is the
	 * page's `<link rel=icon>` href, if it has one; otherwise `/favicon.ico`.
	 * A `declared` that throws (the document was mid-navigation) caches nothing,
	 * so the next load retries.
	 */
	async load(pageUrl: string, declared: () => Promise<string | null>): Promise<void> {
		const origin = originOf(pageUrl);
		if (origin === null || this.#icons.has(origin)) return;
		const inFlight = this.#pending.get(origin);
		if (inFlight) return await inFlight;
		const work = (async () => {
			const href = await declared();
			const icon = await fetchIcon(href ? resolve(href, pageUrl) : `${origin}/favicon.ico`);
			this.#icons.set(origin, icon);
			while (this.#icons.size > MAX_ORIGINS) this.#icons.delete(this.#icons.keys().next().value as string);
		})().finally(() => this.#pending.delete(origin));
		this.#pending.set(origin, work);
		await work;
	}
}

function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
	} catch {
		return null;
	}
}

function resolve(href: string, base: string): string | null {
	try {
		return new URL(href, base).toString();
	} catch {
		return null;
	}
}

/** An inline data: icon as-is, or an http(s) icon fetched without cookies. Null on anything else. */
async function fetchIcon(url: string | null): Promise<string | null> {
	if (!url) return null;
	if (url.startsWith("data:image/")) return url.length <= MAX_FAVICON_DATA_URL ? url : null;
	if (!url.startsWith("http:") && !url.startsWith("https:")) return null;
	try {
		const response = await fetch(url, { redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok || !response.body) return null;
		const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		const type = mime.startsWith("image/") ? mime : sniff(url);
		if (!type) return null;
		const declaredLength = Number(response.headers.get("content-length") ?? "0");
		if (declaredLength > MAX_FAVICON_BYTES) {
			await response.body.cancel().catch(() => undefined);
			return null;
		}
		// Read at most the bound, whatever the headers claimed.
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_FAVICON_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
		if (size === 0) return null;
		return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
	} catch {
		return null;
	}
}

/** Servers often send favicon.ico as octet-stream. */
function sniff(url: string): string | null {
	const path = url.split(/[?#]/)[0]!.toLowerCase();
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".svg")) return "image/svg+xml";
	return null;
}
