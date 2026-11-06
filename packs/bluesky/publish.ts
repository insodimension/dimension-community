import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { authed, resolveDid, session, XrpcError } from "./session";

export const POST_GRAPHEMES = 300;
export const IMAGE_MAX_BYTES = 2_000_000;
const THUMB_MAX_BYTES = 1_000_000;
const IMAGES_PER_POST = 4;
const MAX_APPROVAL_MS = 24 * 60 * 60_000;
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
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
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;

const approvalRecord = type({
	v: "1",
	draftId: "string",
	nonce: /^[0-9a-f]{32}$/,
	binding: /^[0-9a-f]{64}$/,
	approvedAt: "string",
	expiresAt: "string",
});

const publishSchema = type({
	draftId: type("string").describe("The board draft's id, exactly as the board gave it on Approve."),
	posts: type("string[]").describe(
		"The approved option's posts in order, character for character: one post, or a thread of up to 25.",
	),
	"media?": type({
		path: type("string").describe("Absolute path of a PNG, JPEG or WebP the draft carries."),
		post: type("number").describe("0-based index of the post it rides on."),
		alt: type("string").describe("The draft's alt text for it."),
	})
		.array()
		.describe("The draft's images, in the draft's order. At most 4 per post, each under 2 MB."),
});

type PublishParams = typeof publishSchema.infer;
type Media = NonNullable<PublishParams["media"]>[number];

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

export function approvalsDir(): string {
	const insoHome = process.env.INSO_HOME;
	return insoHome
		? join(insoHome, "browser", "publish-approvals")
		: join(homedir(), ".inso", "browser", "publish-approvals");
}

export function bindingValues(posts: readonly string[], media: readonly Media[]): string[] {
	return [...posts, ...media.map(item => JSON.stringify([item.post, item.path, item.alt]))];
}

export function bindingOf(profile: string, values: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify(["publish-approval/v1", "https://bsky.app", profile, "bluesky_publish", [...values]]))
		.digest("hex");
}

export function graphemeCount(text: string): number {
	let count = 0;
	for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count++;
	return count;
}

function checkDraft(params: PublishParams): void {
	if (!DRAFT_ID.test(params.draftId)) throw new Error(`draftId "${params.draftId}" is not a board draft id.`);
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
}

async function claimApproval(
	draftId: string,
	binding: string,
	now: number,
): Promise<() => Promise<() => Promise<void>>> {
	const dir = approvalsDir();
	const unapproved = `publish_unapproved: no board approval covers this exact Bluesky post (draft ${draftId}, text sha256:${binding.slice(0, 12)}). Post only what the person approved on the campaign board, from the account that draft names, exactly as approved. Nothing was posted.`;
	const raw = await readFile(join(dir, `${draftId}.json`), "utf8").catch(() => null);
	if (raw === null) throw new Error(unapproved);
	const parsed = (() => {
		try {
			return approvalRecord(JSON.parse(raw));
		} catch {
			return null;
		}
	})();
	if (parsed === null || parsed instanceof type.errors || parsed.draftId !== draftId) throw new Error(unapproved);
	const from = Date.parse(parsed.approvedAt);
	const until = Date.parse(parsed.expiresAt);
	if (
		!Number.isFinite(from) ||
		!Number.isFinite(until) ||
		until <= from ||
		until - from > MAX_APPROVAL_MS ||
		parsed.binding !== binding
	)
		throw new Error(unapproved);
	const marker = join(dir, `${draftId}.${parsed.nonce}.used`);
	const used = `publish_unapproved: the approval for draft ${draftId} was already used, so this post may already be up. Do not post it again: check the account's latest posts with bluesky_author_feed and record draft_posted with its url, or unconfirmed.`;
	if (
		await readFile(marker).then(
			() => true,
			() => false,
		)
	)
		throw new Error(used);
	if (until <= now) {
		throw new Error(
			`publish_unapproved: the approval for draft ${draftId} expired at ${new Date(until).toISOString()}. Record draft_failed with that reason; the person presses Retry on the board. Nothing was posted.`,
		);
	}
	return async () => {
		try {
			await (await open(marker, "wx")).close();
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(used);
			throw error;
		}
		return async () => {
			await unlink(marker).catch(() => undefined);
		};
	};
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
			if (marker !== 0xe1 && marker !== 0xfe) kept.push(bytes.subarray(at, end));
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
		while (at + 9 < bytes.length && bytes[at] === 0xff) {
			const marker = bytes[at + 1] ?? 0;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
			}
			at += 2 + view.getUint16(at + 2);
		}
	}
	return undefined;
}

export async function facetsOf(text: string): Promise<Facet[]> {
	const encoder = new TextEncoder();
	const span = (start: number, end: number) => ({
		byteStart: encoder.encode(text.slice(0, start)).length,
		byteEnd: encoder.encode(text.slice(0, end)).length,
	});
	const facets: Facet[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
		const uri = match[0].replace(/[.,;:!?)\]'"]+$/, "");
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

async function linkCard(
	uri: string,
): Promise<
	| {
			$type: "app.bsky.embed.external";
			external: { uri: string; title: string; description: string; thumb?: BlobRef };
	  }
	| undefined
> {
	const page = await fetch(uri, {
		signal: AbortSignal.timeout(8000),
		headers: { Accept: "text/html" },
		redirect: "follow",
	}).catch(() => null);
	if (!page?.ok || !(page.headers.get("content-type") ?? "").includes("html")) return undefined;
	const html = (await page.text()).slice(0, 1_000_000);
	const title = metaContent(html, "og:title") ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const description = metaContent(html, "og:description") ?? metaContent(html, "description") ?? "";
	const external: { uri: string; title: string; description: string; thumb?: BlobRef } = { uri, title, description };
	const imageUrl = metaContent(html, "og:image");
	if (imageUrl) {
		const image = await fetch(new URL(imageUrl, page.url || uri), { signal: AbortSignal.timeout(8000) }).catch(
			() => null,
		);
		const mime = image?.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		if (image?.ok && mime.startsWith("image/")) {
			const bytes = new Uint8Array(await image.arrayBuffer());
			if (bytes.length <= THUMB_MAX_BYTES) external.thumb = await uploadBlob(bytes, mime);
		}
	}
	return { $type: "app.bsky.embed.external", external };
}

async function embedFor(text: string, media: readonly Media[]): Promise<unknown> {
	if (media.length > 0) {
		const images = [];
		for (const item of media) {
			const mime = IMAGE_MIME[extname(item.path).toLowerCase()] ?? "image/png";
			const bytes = stripImageMetadata(new Uint8Array(await readFile(item.path)), mime);
			if (bytes.length > IMAGE_MAX_BYTES)
				throw new Error(
					`${item.path} is ${bytes.length.toLocaleString("en-US")} bytes; Bluesky takes images up to 2,000,000. Re-render it smaller. Nothing was posted.`,
				);
			const size = imageSize(bytes, mime);
			images.push({ alt: item.alt, image: await uploadBlob(bytes, mime), ...(size ? { aspectRatio: size } : {}) });
		}
		return { $type: "app.bsky.embed.images", images };
	}
	const link = /https?:\/\/[^\s<>"]+/.exec(text)?.[0]?.replace(/[.,;:!?)\]'"]+$/, "");
	return link ? linkCard(link) : undefined;
}

export function createPublishTool(): ToolDefinition<typeof publishSchema> {
	return {
		name: "bluesky_publish",
		label: "Bluesky: Publish",
		description:
			"Publish an APPROVED bluesky-post draft from the connected account: one post or a thread, with its images and alt text, links as rich text and a link card. Pass the draftId and the approved option's posts and media exactly as the board holds them. Refused (publish_unapproved, nothing posted) unless the board's Approve covers this exact text, images and account; an approval is spent once, so a refusal saying it was used means the post may already be up and must never be sent again. Returns each post's bsky.app link.",
		parameters: publishSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const parsed = publishSchema(args);
			if (parsed instanceof type.errors) return ["Bluesky post: (arguments missing or malformed)"];
			const lines = [`Bluesky draft: ${parsed.draftId}`];
			parsed.posts.forEach((text, index) => {
				lines.push(`Post ${index + 1}/${parsed.posts.length}:\n${text}`);
				for (const item of (parsed.media ?? []).filter(media => media.post === index))
					lines.push(`  Image: ${item.path}\n  Alt: ${item.alt}`);
			});
			return lines;
		},
		async execute(_toolCallId: string, params: PublishParams) {
			checkDraft(params);
			const media = params.media ?? [];
			const account = await session();
			const spend = await claimApproval(
				params.draftId,
				bindingOf(account.handle, bindingValues(params.posts, media)),
				Date.now(),
			);
			const prepared = [];
			for (const [index, text] of params.posts.entries()) {
				const [facets, embed] = await Promise.all([
					facetsOf(text),
					embedFor(
						text,
						media.filter(item => item.post === index),
					),
				]);
				prepared.push({ text, facets, embed });
			}
			const release = await spend();
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
					if (posted.length === 0 && error instanceof XrpcError) {
						await release();
						throw new Error(
							`${reason}. Bluesky refused post 1, so nothing was posted and the approval still stands; fix the cause and call again.`,
						);
					}
					if (posted.length === 0)
						throw new Error(
							`${reason}. Bluesky never answered, so post 1 may be up: check with bluesky_author_feed before anything else, and never post this draft again.`,
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
