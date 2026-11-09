import { Buffer } from "node:buffer";
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { authed, resolveDid, session, XrpcError } from "./session";

const POST_GRAPHEMES = 300;
const IMAGE_MAX_BYTES = 2_000_000;
const THUMB_MAX_BYTES = 1_000_000;
const PAGE_MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 8000;
const IMAGES_PER_POST = 4;
const IMAGE_MIME: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};
const PNG_METADATA_CHUNKS: Readonly<Record<string, true>> = {
	eXIf: true,
	tEXt: true,
	iTXt: true,
	zTXt: true,
	tIME: true,
};
const LINK = /https?:\/\/[^\s<>"]+/g;
const LINK_TAIL = /[.,;:!?)\]'"]+$/;
const EXIF_ORIENTATION = 0x0112;

const publishSchema = type({
	posts: type("string[]").describe(
		"The chosen option's posts in order, character for character: one post, or a thread of up to 25.",
	),
	"media?": type({
		path: type("string").describe("Absolute path of a PNG, JPEG or WebP the draft carries."),
		post: type("number").describe("0-based index of the post it rides on."),
		alt: type("string").describe("The draft's alt text for it."),
	})
		.array()
		.describe("The draft's images, in the draft's order. At most 4 per post, each under 2 MB."),
	"cards?": type({
		post: type("number").describe("0-based index of the post the card rides on: a post with a link and no image."),
		uri: type("string").describe("The post's first link, as bluesky_link_card returned it."),
		title: type("string").describe("The card title bluesky_link_card returned."),
		description: type("string").describe("The card description bluesky_link_card returned."),
		"image?": type("string").describe("The card image URL bluesky_link_card returned, if any."),
	})
		.array()
		.describe(
			"Link cards, one per post that has a link and no image, each exactly as bluesky_link_card returned it. A post with a link and no card here goes up without one.",
		),
});

const linkCardSchema = type({
	url: type("string").describe("The link the post carries: its first http(s) URL."),
});

type PublishParams = typeof publishSchema.infer;
type Media = NonNullable<PublishParams["media"]>[number];
type Card = NonNullable<PublishParams["cards"]>[number];

interface Facet {
	index: { byteStart: number; byteEnd: number };
	features: (
		| { $type: "app.bsky.richtext.facet#link"; uri: string }
		| { $type: "app.bsky.richtext.facet#mention"; did: string }
		| { $type: "app.bsky.richtext.facet#tag"; tag: string }
	)[];
}

interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

interface StrongRef {
	uri: string;
	cid: string;
}

function graphemeCount(text: string): number {
	let count = 0;
	for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count++;
	return count;
}

function checkDraft(params: PublishParams): void {
	if (params.posts.length < 1 || params.posts.length > 25)
		throw new Error("A Bluesky draft is one post or a thread of up to 25.");
	params.posts.forEach((text, index) => {
		if (text.trim().length === 0) throw new Error(`Post ${index + 1} is empty.`);
		const length = graphemeCount(text);
		if (length > POST_GRAPHEMES)
			throw new Error(
				`Post ${index + 1} is ${length} characters; Bluesky allows ${POST_GRAPHEMES}. Send it back to the board to be cut.`,
			);
	});
	const perPost = new Map<number, number>();
	for (const item of params.media ?? []) {
		if (!Number.isInteger(item.post) || item.post < 0 || item.post >= params.posts.length)
			throw new Error(`Media ${item.path} rides on post ${item.post}, which the draft does not have.`);
		if (!IMAGE_MIME[extname(item.path).toLowerCase()]) {
			throw new Error(
				`${item.path} is not a PNG, JPEG or WebP. Bluesky video and documents are posted by the person in the app.`,
			);
		}
		if (item.alt.trim().length === 0) throw new Error(`${item.path} has no alt text; every Bluesky image needs one.`);
		perPost.set(item.post, (perPost.get(item.post) ?? 0) + 1);
		if ((perPost.get(item.post) ?? 0) > IMAGES_PER_POST)
			throw new Error(`Post ${item.post + 1} has more than ${IMAGES_PER_POST} images.`);
	}
	const carded = new Set<number>();
	for (const card of params.cards ?? []) {
		const text = params.posts[card.post];
		if (!Number.isInteger(card.post) || text === undefined)
			throw new Error(`A link card rides on post ${card.post}, which the draft does not have.`);
		if (carded.has(card.post)) throw new Error(`Post ${card.post + 1} has more than one link card.`);
		carded.add(card.post);
		if (perPost.has(card.post))
			throw new Error(`Post ${card.post + 1} carries images, so Bluesky shows no link card on it.`);
		if (text.match(LINK)?.[0]?.replace(LINK_TAIL, "") !== card.uri)
			throw new Error(`The link card for post ${card.post + 1} is for ${card.uri}, not the post's first link.`);
		if (card.image !== undefined && !/^https?:\/\//i.test(card.image))
			throw new Error(`The link card image ${card.image} is not an http(s) URL.`);
	}
}

function exifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
	if (end - start < 14 || Buffer.from(bytes.subarray(start, start + 6)).toString("latin1") !== "Exif\0\0") return undefined;
	const tiff = start + 6;
	const order = Buffer.from(bytes.subarray(tiff, tiff + 2)).toString("latin1");
	if (order !== "II" && order !== "MM") return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const little = order === "II";
	const ifd = tiff + view.getUint32(tiff + 4, little);
	if (ifd + 2 > end) return undefined;
	const entries = view.getUint16(ifd, little);
	for (let entry = ifd + 2; entry + 12 <= end && entry < ifd + 2 + entries * 12; entry += 12) {
		if (view.getUint16(entry, little) === EXIF_ORIENTATION) {
			const value = view.getUint16(entry + 8, little);
			return value >= 1 && value <= 8 ? value : undefined;
		}
	}
	return undefined;
}

export function stripImageMetadata(bytes: Uint8Array<ArrayBuffer>, mime: string): Uint8Array<ArrayBuffer> {
	if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
		const kept: Uint8Array[] = [bytes.subarray(0, 2)];
		let at = 2;
		while (at + 4 <= bytes.length && bytes[at] === 0xff) {
			const marker = bytes[at + 1] ?? 0;
			if (marker === 0xda) break;
			const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
			const end = at + 2 + length;
			if (marker === 0xe1) {
				const orientation = exifOrientation(bytes, at + 4, Math.min(end, bytes.length));
				if (orientation !== undefined && orientation !== 1)
					kept.push(
						Uint8Array.from([
							0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
							0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00,
							0x00,
						]),
					);
			} else if (marker !== 0xfe) kept.push(bytes.subarray(at, end));
			at = end;
		}
		kept.push(bytes.subarray(at));
		return Buffer.concat(kept);
	}
	if (mime === "image/png" && bytes.length > 8) {
		const kept: Uint8Array[] = [bytes.subarray(0, 8)];
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let at = 8;
		while (at + 12 <= bytes.length) {
			const length = view.getUint32(at);
			const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
			const end = at + 12 + length;
			if (!PNG_METADATA_CHUNKS[kind]) kept.push(bytes.subarray(at, end));
			at = end;
		}
		return Buffer.concat(kept);
	}
	return bytes;
}

export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (mime === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
	if (mime === "image/jpeg") {
		let at = 2;
		let orientation = 1;
		while (at + 9 < bytes.length && bytes[at] === 0xff) {
			const marker = bytes[at + 1] ?? 0;
			const end = at + 2 + view.getUint16(at + 2);
			if (marker === 0xe1) orientation = exifOrientation(bytes, at + 4, Math.min(end, bytes.length)) ?? orientation;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				const height = view.getUint16(at + 5);
				const width = view.getUint16(at + 7);
				return orientation >= 5 ? { width: height, height: width } : { width, height };
			}
			at = end;
		}
	}
	return undefined;
}

async function facetsOf(text: string): Promise<Facet[]> {
	const encoder = new TextEncoder();
	const span = (start: number, end: number) => ({
		byteStart: encoder.encode(text.slice(0, start)).length,
		byteEnd: encoder.encode(text.slice(0, end)).length,
	});
	const facets: Facet[] = [];
	for (const match of text.matchAll(LINK)) {
		const uri = match[0].replace(LINK_TAIL, "");
		facets.push({
			index: span(match.index, match.index + uri.length),
			features: [{ $type: "app.bsky.richtext.facet#link", uri }],
		});
	}
	const mentions = [...text.matchAll(/(^|[\s(])@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g)];
	const dids = await Promise.all(mentions.map(match => resolveDid((match[2] ?? "").toLowerCase()).catch(() => null)));
	mentions.forEach((match, index) => {
		const did = dids[index];
		if (!did) return;
		const start = match.index + (match[1] ?? "").length;
		facets.push({
			index: span(start, start + 1 + (match[2] ?? "").length),
			features: [{ $type: "app.bsky.richtext.facet#mention", did }],
		});
	});
	for (const match of text.matchAll(/(^|\s)#([^\s#.,;:!?()[\]"']+)/g)) {
		const tag = match[2] ?? "";
		if (/^\d+$/.test(tag) || tag.length > 64) continue;
		const start = match.index + (match[1] ?? "").length;
		facets.push({
			index: span(start, start + 1 + tag.length),
			features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
		});
	}
	return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

async function uploadBlob(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<BlobRef> {
	const reply = await authed<{ blob: BlobRef }>("com.atproto.repo.uploadBlob", { bytes, contentType: mime });
	return reply.blob;
}

function metaContent(html: string, key: string): string | undefined {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
		if (name?.toLowerCase() !== key) continue;
		const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
		if (content !== undefined)
			return content
				.replace(/&amp;/g, "&")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">");
	}
	return undefined;
}

function isPublicIPv4(address: string): boolean {
	const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b < 128) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b < 32) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function isPublicIPv6(address: string): boolean {
	const lower = address.toLowerCase().replace(/%.*$/, "");
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
	const [head = "", tail = ""] = (v4 ? `${lower.slice(0, -v4.length)}0:0` : lower).split("::");
	const left = head === "" ? [] : head.split(":").map(group => Number.parseInt(group, 16));
	const right = tail === "" ? [] : tail.split(":").map(group => Number.parseInt(group, 16));
	const words = [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
	const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0] = words;
	const upper96Zero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
	return !(
		(upper96Zero && (w5 === 0 || w5 === 0xffff)) ||
		(w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) ||
		(w0 & 0xfe00) === 0xfc00 ||
		(w0 & 0xffc0) === 0xfe80 ||
		(w0 & 0xff00) === 0xff00
	);
}

async function isPublicHost(hostname: string): Promise<boolean> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const literal = isIP(host);
	const addresses =
		literal === 0
			? await dns.lookup(host, { all: true, verbatim: true }).catch(() => [])
			: [{ address: host, family: literal }];
	return (
		addresses.length > 0 &&
		addresses.every(entry => (entry.family === 6 ? isPublicIPv6(entry.address) : isPublicIPv4(entry.address)))
	);
}

async function publicFetch(
	raw: string,
	accept: string,
	maxBytes: number,
	whole: boolean,
): Promise<{ url: URL; mime: string; bytes: Uint8Array<ArrayBuffer> } | undefined> {
	let url = URL.canParse(raw) ? new URL(raw) : undefined;
	for (let hop = 0; url !== undefined && hop <= MAX_REDIRECTS; hop++) {
		if ((url.protocol !== "https:" && url.protocol !== "http:") || !(await isPublicHost(url.hostname)))
			return undefined;
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { Accept: accept },
			redirect: "manual",
		}).catch(() => null);
		if (res === null) return undefined;
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			const location = res.headers.get("location");
			url = location && URL.canParse(location, url) ? new URL(location, url) : undefined;
			continue;
		}
		const mime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
		const declared = Number(res.headers.get("content-length") ?? "0");
		if (!res.ok || res.body === null || (whole && declared > maxBytes)) {
			await res.body?.cancel();
			return undefined;
		}
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const next = await reader.read().catch(() => null);
			if (next === null) return undefined;
			if (next.done) break;
			chunks.push(next.value);
			size += next.value.length;
			if (size > maxBytes) {
				await reader.cancel();
				if (whole) return undefined;
				break;
			}
		}
		return { url, mime, bytes: Buffer.concat(chunks).subarray(0, maxBytes) };
	}
	return undefined;
}

async function cardImage(raw: string): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> } | undefined> {
	const image = await publicFetch(raw, "image/*", THUMB_MAX_BYTES, true);
	return image?.mime.startsWith("image/") ? image : undefined;
}

async function fetchCard(uri: string): Promise<Omit<Card, "post"> | undefined> {
	const page = await publicFetch(uri, "text/html", PAGE_MAX_BYTES, false);
	if (!page?.mime.includes("html")) return undefined;
	const html = new TextDecoder().decode(page.bytes);
	const title = metaContent(html, "og:title") ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const description = metaContent(html, "og:description") ?? metaContent(html, "description") ?? "";
	const imageUrl = metaContent(html, "og:image");
	const image = imageUrl && URL.canParse(imageUrl, page.url) ? new URL(imageUrl, page.url).href : undefined;
	return {
		uri,
		title,
		description,
		...(image !== undefined && (await cardImage(image)) !== undefined ? { image } : {}),
	};
}

async function embedFor(media: readonly { item: Media; bytes: Uint8Array<ArrayBuffer> }[], card: Card | undefined): Promise<unknown> {
	if (media.length > 0) {
		const images = await Promise.all(
			media.map(async ({ item, bytes: raw }) => {
				const mime = IMAGE_MIME[extname(item.path).toLowerCase()] ?? "image/png";
				const bytes = stripImageMetadata(raw, mime);
				if (bytes.length > IMAGE_MAX_BYTES)
					throw new Error(
						`${item.path} is ${bytes.length.toLocaleString("en-US")} bytes; Bluesky takes images up to 2,000,000. Re-render it smaller. Nothing was posted.`,
					);
				const size = imageSize(bytes, mime);
				return { alt: item.alt, image: await uploadBlob(bytes, mime), ...(size ? { aspectRatio: size } : {}) };
			}),
		);
		return { $type: "app.bsky.embed.images", images };
	}
	if (card === undefined) return undefined;
	const external: { uri: string; title: string; description: string; thumb?: BlobRef } = {
		uri: card.uri,
		title: card.title,
		description: card.description,
	};
	if (card.image !== undefined) {
		const image = await cardImage(card.image);
		if (image === undefined)
			throw new Error(
				`The link card image ${card.image} could not be fetched as a public image under 1 MB, so nothing was posted. Get the card again with bluesky_link_card and call again with it.`,
			);
		external.thumb = await uploadBlob(image.bytes, image.mime);
	}
	return { $type: "app.bsky.embed.external", external };
}

export function createLinkCardTool(): ToolDefinition<typeof linkCardSchema> {
	return {
		name: "bluesky_link_card",
		label: "Bluesky: Link card",
		description:
			"Read the link card Bluesky would show for a link: the page's title, description and image URL. Only public http(s) pages are read. Pass the result, with the post's index, in bluesky_publish's cards for a post with a link and no image.",
		parameters: linkCardSchema,
		approval: "read",
		async execute(_toolCallId: string, params: typeof linkCardSchema.infer) {
			const uri = params.url.trim();
			const card = await fetchCard(uri);
			if (card === undefined)
				throw new Error(
					`${uri} gave no link card: it is not a public http(s) HTML page, or it did not answer. Post it without a card.`,
				);
			return { content: [{ type: "text" as const, text: JSON.stringify(card) }] };
		},
	};
}

export function createPublishTool(): ToolDefinition<typeof publishSchema> {
	return {
		name: "bluesky_publish",
		label: "Bluesky: Publish",
		description:
			"Publish the chosen bluesky-post draft from the connected account, straight away: one post or a thread, with its images and alt text, links as rich text, and a link card for each post listed in cards (get it with bluesky_link_card). Pass the chosen option's posts and media exactly as the board holds them. Picking the option on the board is the go-ahead; nothing asks again. Post a draft once: if a call fails unclearly, check bluesky_author_feed before calling again. Returns each post's bsky.app link.",
		parameters: publishSchema,
		approval: "write",
		async execute(_toolCallId: string, params: PublishParams) {
			checkDraft(params);
			const media = await Promise.all(
				(params.media ?? []).map(async item => {
					const bytes = new Uint8Array(
						await readFile(item.path).catch(() => {
							throw new Error(`${item.path} could not be read. Nothing was posted.`);
						}),
					);
					return { item, bytes };
				}),
			);
			const account = await session();
			const prepared = await Promise.all(
				params.posts.map(async (text, index) => {
					const [facets, embed] = await Promise.all([
						facetsOf(text),
						embedFor(
							media.filter(({ item }) => item.post === index),
							params.cards?.find(card => card.post === index),
						),
					]);
					return { text, facets, embed };
				}),
			);
			const posted: string[] = [];
			let root: StrongRef | undefined;
			let parent: StrongRef | undefined;
			for (const post of prepared) {
				const record = {
					$type: "app.bsky.feed.post",
					text: post.text,
					createdAt: new Date().toISOString(),
					...(post.facets.length > 0 ? { facets: post.facets } : {}),
					...(post.embed ? { embed: post.embed } : {}),
					...(root && parent ? { reply: { root, parent } } : {}),
				};
				let ref: StrongRef;
				try {
					ref = await authed<StrongRef>("com.atproto.repo.createRecord", {
						json: { repo: account.did, collection: "app.bsky.feed.post", record },
					});
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					if (
						posted.length === 0 &&
						error instanceof XrpcError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 408 &&
						error.status !== 429
					)
						throw new Error(
							`${reason}. Bluesky refused post 1, so nothing was posted; fix the cause and call again.`,
						);
					if (posted.length === 0)
						throw new Error(
							`${reason}. Bluesky gave no clear refusal, so post 1 may be up: check with bluesky_author_feed before anything else, and never post this draft again.`,
						);
					throw new Error(
						`${reason}. Posted ${posted.length} of ${prepared.length} before it stopped, so the thread is incomplete: ${posted.join(" ")}. Record draft_posted with the first link and tell the person which posts are missing; never post the draft again.`,
					);
				}
				root ??= ref;
				parent = ref;
				posted.push(`https://bsky.app/profile/${account.handle}/post/${ref.uri.split("/").pop()}`);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: posted.map((url, index) => `Posted ${index + 1}/${posted.length}: ${url}`).join("\n"),
					},
				],
			};
		},
	};
}
