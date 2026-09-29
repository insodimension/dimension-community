// What the Word, PowerPoint and Excel renderers have in common: they all open an
// Open XML package (a ZIP) that an agent or a stranger made, inside the View's
// sandboxed frame. It lives in a subfolder because `renderers/index.ts` treats
// every top-level `renderers/*.ts` as a document kind.
//
// Three jobs, all of them about hostile input:
//   1. Look at the bytes BEFORE a parser does (`inspectPackage`): the wrong file,
//      a password-protected file, a truncated ZIP and a ZIP that inflates to
//      gigabytes each become a sentence, not a stack trace or a frozen tab.
//   2. Say it inside the pane (`mountOffice` / `showProblem`): a renderer never
//      rejects out of `mount` for a bad file.
//   3. Make whatever markup a library emitted inert (`neutralizeTree`,
//      `wireLinks`) before the user can click it.
//
// Nothing here touches the network, `eval` or `new Function`.

import type { Mounted, MountContext, Theme } from "../types";

/** The largest file a renderer will open. The host caps what it sends; this is
 *  the renderer's own answer for a caller that does not. */
export const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

/**
 * What a package may declare before it is refused. The numbers are
 * `@aiden0z/pptx-renderer`'s `RECOMMENDED_ZIP_LIMITS`, used for all three
 * formats so one file is not a bomb in Excel and fine in Word. They are checked
 * against the sizes the ZIP's central directory DECLARES, which a hostile file
 * can lie about: this stops honest bombs and oversized packages cheaply, and the
 * opaque-origin frame is what contains the rest (a lying file can exhaust its
 * own View, nothing else).
 */
export const ZIP_LIMITS = {
	maxEntries: 4000,
	maxEntryUncompressedBytes: 32 * 1024 * 1024,
	maxTotalUncompressedBytes: 256 * 1024 * 1024,
} as const;

export interface PackageSpec {
	/** What a person calls it in a sentence: "Word document". */
	readonly label: string;
	/** The indefinite article that goes with `label`. */
	readonly article: "a" | "an";
	/** The part that makes a ZIP this format, lower-case. */
	readonly mainPart: string;
}

export const WORD: PackageSpec = { label: "Word document", article: "a", mainPart: "word/document.xml" };
export const POWERPOINT: PackageSpec = { label: "PowerPoint presentation", article: "a", mainPart: "ppt/presentation.xml" };
export const EXCEL: PackageSpec = { label: "Excel workbook", article: "an", mainPart: "xl/workbook.xml" };

/** A sentence for the pane: a short title and one line of what to do or what happened. */
export interface Problem {
	readonly title: string;
	readonly detail: string;
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
/** Also the whole of an empty archive, which starts with its own end record. */
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_ENTRY = 0x02014b50;
/** The compound-file signature of pre-2007 Office files AND of encrypted Open XML. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
/** `EncryptedPackage`, UTF-16LE: the stream name every password-protected Open XML file carries. */
const ENCRYPTED_PACKAGE = new TextEncoder().encode("E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0");

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	const first = needle[0];
	let from = haystack.indexOf(first);
	while (from !== -1 && from + needle.length <= haystack.length) {
		let matches = true;
		for (let index = 1; index < needle.length; index++) {
			if (haystack[from + index] !== needle[index]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
		from = haystack.indexOf(first, from + 1);
	}
	return false;
}

/**
 * Judge `bytes` as the Open XML package `spec` describes, reading only the ZIP
 * index. `null` means "hand it to the parser"; anything else is what to tell the
 * person instead. Pure.
 */
export function inspectPackage(bytes: Uint8Array, spec: PackageSpec): Problem | null {
	if (bytes.length === 0) return { title: "This file is empty", detail: "It has no content to show." };
	if (bytes.length > MAX_OFFICE_BYTES) {
		return {
			title: `This ${spec.label} is too large to preview`,
			detail: `It is ${formatBytes(bytes.length)}; the preview limit is ${formatBytes(MAX_OFFICE_BYTES)}.`,
		};
	}
	if (CFB_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
		return containsBytes(bytes, ENCRYPTED_PACKAGE)
			? {
					title: "This file is password-protected",
					detail: "Remove the password in the app that made it, then open it again.",
				}
			: {
					title: "This is an older Office file",
					detail: "Only the Open XML formats (.docx, .pptx, .xlsx) can be previewed, not .doc, .ppt or .xls.",
				};
	}
	const damaged: Problem = {
		title: `This ${spec.label} looks damaged`,
		detail: "The file is not a complete Open XML package. It may have been cut off, or renamed from another format.",
	};
	if (bytes.length < 22) return damaged;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const head = view.getUint32(0, true);
	if (head !== ZIP_LOCAL_HEADER && head !== ZIP_END_OF_CENTRAL_DIRECTORY) return damaged;

	// The end-of-central-directory record is the last 22 bytes plus a comment of up to 65535.
	let eocd = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
		if (view.getUint32(at, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
			eocd = at;
			break;
		}
	}
	if (eocd === -1) return damaged;
	const entryCount = view.getUint16(eocd + 10, true);
	const directorySize = view.getUint32(eocd + 12, true);
	const directoryOffset = view.getUint32(eocd + 16, true);
	if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		return tooComplex(spec);
	}
	if (directoryOffset + directorySize > eocd) return damaged;
	if (entryCount > ZIP_LIMITS.maxEntries) return tooComplex(spec);

	const decoder = new TextDecoder();
	let total = 0;
	let position = directoryOffset;
	let mainPartFound = false;
	let mainPartEncrypted = false;
	for (let index = 0; index < entryCount; index++) {
		if (position + 46 > eocd || view.getUint32(position, true) !== ZIP_CENTRAL_ENTRY) return damaged;
		const flags = view.getUint16(position + 8, true);
		const uncompressed = view.getUint32(position + 24, true);
		const nameLength = view.getUint16(position + 28, true);
		const extraLength = view.getUint16(position + 30, true);
		const commentLength = view.getUint16(position + 32, true);
		if (position + 46 + nameLength > eocd) return damaged;
		if (uncompressed > ZIP_LIMITS.maxEntryUncompressedBytes) return tooComplex(spec);
		total += uncompressed;
		if (total > ZIP_LIMITS.maxTotalUncompressedBytes) return tooComplex(spec);
		const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength)).toLowerCase();
		if (name === spec.mainPart) {
			mainPartFound = true;
			mainPartEncrypted = (flags & 1) !== 0;
		}
		position += 46 + nameLength + extraLength + commentLength;
	}
	if (!mainPartFound) {
		return {
			title: `This is not ${spec.article} ${spec.label}`,
			detail: `The file is a ZIP archive, but it has no ${spec.mainPart}. It may be a different kind of document with the wrong extension.`,
		};
	}
	if (mainPartEncrypted) {
		return {
			title: "This file is password-protected",
			detail: "Remove the password in the app that made it, then open it again.",
		};
	}
	return null;
}

function tooComplex(spec: PackageSpec): Problem {
	return {
		title: `This ${spec.label} is too large to preview`,
		detail: `It holds more than ${ZIP_LIMITS.maxEntries.toLocaleString("en-US")} parts or expands past ${formatBytes(ZIP_LIMITS.maxTotalUncompressedBytes)}, which is beyond what the previewer opens safely.`,
	};
}

/** Thrown by a renderer's `build` when the file is fine as bytes but has nothing to
 *  show (a deck with no slides): `mountOffice` draws `problem` as written. */
export class ProblemError extends Error {
	constructor(readonly problem: Problem) {
		super(problem.title);
	}
}

/** A library's exception, as a sentence a person can act on. */
export function failureProblem(error: unknown, spec: PackageSpec): Problem {
	const message = error instanceof Error ? error.message : String(error);
	return {
		title: `This ${spec.label} could not be previewed`,
		detail: `${message.slice(0, 240)} The file may be damaged or use features the previewer does not support.`,
	};
}

const STYLE_ID = "viewer-office-styles";

/**
 * The chrome around a document. Every colour of the CHROME is a host token
 * (`--fr-*`), so light and dark follow the window; the document itself is paper,
 * white with black ink on both themes, the way Word and Excel draw it. The paper
 * is named colours, not a theme surface, so it is defined once here as
 * `--vo-paper` / `--vo-ink` and nothing else in the pane spells one.
 */
const OFFICE_CSS = `
.vo-root{--vo-paper:white;--vo-ink:black;--vo-ink-2:color-mix(in srgb,var(--vo-ink) 55%,var(--vo-paper));--vo-rule:color-mix(in srgb,var(--vo-ink) 14%,var(--vo-paper));position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--fr-surface-2);color:var(--fr-text);font-family:var(--fr-sans);font-size:var(--fr-fs-sm);outline:none}
.vo-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.vo-problem{margin:auto;max-width:28rem;padding:16px 20px;background:var(--fr-surface);border:1px solid var(--fr-border);border-left:3px solid var(--fr-warn);border-radius:8px}
.vo-problem-title{display:block;color:var(--fr-text);font-weight:600}
.vo-problem-detail{margin:6px 0 0;color:var(--fr-text-2);line-height:1.5}
.vo-problem-file{margin:8px 0 0;color:var(--fr-text-3);font-family:var(--fr-mono);font-size:var(--fr-fs-xs);overflow-wrap:anywhere}
.vo-note{flex:none;padding:6px 12px;border-top:1px solid var(--fr-border);background:var(--fr-surface);color:var(--fr-text-2)}
.vo-slides{display:flex;justify-content:center;padding:16px;box-sizing:border-box}
.vo-slide-host{width:100%}
.vo-tabs{flex:none;display:flex;gap:2px;padding:4px 8px 0;border-top:1px solid var(--fr-border);background:var(--fr-surface);overflow-x:auto}
.vo-tab{flex:none;max-width:16rem;padding:5px 12px;border:1px solid transparent;border-bottom:0;border-radius:6px 6px 0 0;background:transparent;color:var(--fr-text-2);font:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vo-tab:hover{background:var(--fr-surface-2);color:var(--fr-text)}
.vo-tab[aria-selected=true]{background:var(--fr-surface-2);border-color:var(--fr-border);color:var(--fr-text);font-weight:600}
.vo-tab:focus-visible{outline:2px solid var(--fr-accent);outline-offset:-2px}
.vo-empty{margin:24px;color:var(--fr-text-2)}
.vo-grid{border-collapse:separate;border-spacing:0;table-layout:fixed;background:var(--vo-paper);color:var(--vo-ink)}
.vo-grid th,.vo-grid td{box-sizing:border-box;padding:0 6px;height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border-right:1px solid var(--vo-rule);border-bottom:1px solid var(--vo-rule);font-weight:400;text-align:left}
.vo-grid thead th,.vo-grid tbody th{background:var(--fr-surface);color:var(--fr-text-2);border-color:var(--fr-border);text-align:center;font-size:var(--fr-fs-xs)}
.vo-grid thead th{position:sticky;top:0;z-index:2}
.vo-grid tbody th{position:sticky;left:0;z-index:1}
.vo-grid thead th:first-child{left:0;z-index:3}
.vo-num{text-align:right !important}
.vo-flag{text-align:center !important}
.vo-raw{color:var(--vo-ink-2);font-style:italic}
`;

/** Add the pane's stylesheet to `doc` once. */
export function ensureOfficeStyles(doc: Document): void {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement("style");
	style.id = STYLE_ID;
	style.textContent = OFFICE_CSS;
	(doc.head ?? doc.documentElement).append(style);
}

function createRoot(el: HTMLElement, theme: Theme): HTMLElement {
	const root = el.ownerDocument.createElement("div");
	root.className = "vo-root";
	root.style.colorScheme = theme;
	el.replaceChildren(root);
	return root;
}

/** Draw a problem in the pane instead of a document. */
export function showProblem(el: HTMLElement, ctx: MountContext, problem: Problem): Mounted {
	ensureOfficeStyles(el.ownerDocument);
	const doc = el.ownerDocument;
	const root = createRoot(el, ctx.theme);
	const card = doc.createElement("div");
	card.className = "vo-problem";
	card.setAttribute("role", "alert");
	const title = doc.createElement("strong");
	title.className = "vo-problem-title";
	title.textContent = problem.title;
	const detail = doc.createElement("p");
	detail.className = "vo-problem-detail";
	detail.textContent = problem.detail;
	const file = doc.createElement("p");
	file.className = "vo-problem-file";
	file.textContent = ctx.filename;
	card.append(title, detail, file);
	root.append(card);
	return { destroy: () => root.remove() };
}

/**
 * The shared shape of a mount: refuse the wrong bytes, build the document into a
 * fresh root, and turn ANY failure into the pane's problem card. `build` gets the
 * root and returns what the renderer exposes; it owns freeing whatever it started
 * if it throws after starting something.
 */
export async function mountOffice(
	el: HTMLElement,
	bytes: Uint8Array,
	ctx: MountContext,
	spec: PackageSpec,
	build: (root: HTMLElement) => Promise<Mounted>,
): Promise<Mounted> {
	const problem = inspectPackage(bytes, spec);
	if (problem) return showProblem(el, ctx, problem);
	ensureOfficeStyles(el.ownerDocument);
	const root = createRoot(el, ctx.theme);
	try {
		const mounted = await build(root);
		return {
			...mounted,
			destroy: () => {
				mounted.destroy();
				root.remove();
			},
		};
	} catch (error) {
		return showProblem(el, ctx, error instanceof ProblemError ? error.problem : failureProblem(error, spec));
	}
}

// --- Untrusted markup ------------------------------------------------------

/** Elements that can run script, load a document or leave the page. Removed. */
const DROPPED_ELEMENTS: Record<string, true> = {
	script: true,
	iframe: true,
	frame: true,
	frameset: true,
	object: true,
	embed: true,
	applet: true,
	base: true,
	link: true,
	meta: true,
	form: true,
	portal: true,
	animate: true,
	set: true,
};

/** Attributes that carry a URL. */
const URL_ATTRIBUTES: Record<string, true> = {
	href: true,
	"xlink:href": true,
	src: true,
	poster: true,
	data: true,
	action: true,
	formaction: true,
	background: true,
	ping: true,
	codebase: true,
	longdesc: true,
	cite: true,
};

/** The only URLs an element may keep: an image the document carries itself, or a fragment. */
const SELF_CONTAINED_URL = /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon|avif)[;,]|blob:|#)/i;

/** Where a link's http(s) target is parked once its `href` is gone. */
export const LINK_ATTRIBUTE = "data-vo-href";

function externalUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Make markup a document library produced inert, in place. Elements that run or
 * fetch are removed; every `on*` handler and every URL attribute that is not the
 * document's own image or a fragment is stripped; a link loses its `href` (so it
 * can never navigate the frame) and, if its target is http(s), keeps it in
 * {@link LINK_ATTRIBUTE} for {@link wireLinks} to hand to the host. Idempotent,
 * so a renderer that mounts content lazily (a slide at a time) calls it per piece.
 *
 * CSS is not scrubbed. It cannot run script, and the View's CSP (`connect-src
 * 'self'`, `img-src`/`font-src` limited to `self data: blob:`) is what stops a
 * stylesheet fetching; a scrubber that misses one CSS escape would only be
 * false comfort beside it.
 */
export function neutralizeTree(root: ParentNode): void {
	for (const element of Array.from(root.querySelectorAll("*"))) {
		if (Object.hasOwn(DROPPED_ELEMENTS, element.localName)) {
			element.remove();
			continue;
		}
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith("on") || name === "srcset") {
				element.removeAttribute(attribute.name);
			} else if (Object.hasOwn(URL_ATTRIBUTES, name)) {
				// Whitespace and control characters inside a scheme are ignored by browsers
				// (`java\tscript:`), so judge the URL the way a browser reads it.
				const url = attribute.value.replace(/[\u0000-\u0020]/g, "");
				if ((element.localName === "a" || element.localName === "area") && (name === "href" || name === "xlink:href")) {
					element.removeAttribute(attribute.name);
					const target = externalUrl(attribute.value);
					if (target) element.setAttribute(LINK_ATTRIBUTE, target);
				} else if (!SELF_CONTAINED_URL.test(url)) {
					element.removeAttribute(attribute.name);
				}
			}
		}
	}
}

/**
 * Route clicks on {@link neutralizeTree}'d links to the host, and swallow every
 * other link activation. Without `ctx.openLink` links stay inert. One capture
 * listener on `root` covers content that mounts later.
 */
export function wireLinks(root: EventTarget, ctx: MountContext): () => void {
	const onClick = (event: Event): void => {
		const target = event.target;
		const link = target instanceof Element ? target.closest("a, area") : null;
		if (!link) return;
		event.preventDefault();
		const url = link.getAttribute(LINK_ATTRIBUTE);
		if (url) ctx.openLink?.(url);
	};
	root.addEventListener("click", onClick, true);
	return () => root.removeEventListener("click", onClick, true);
}

/** Absolute zoom, kept in a range a layout survives. */
export function clampZoom(factor: number): number {
	return Number.isFinite(factor) ? Math.min(4, Math.max(0.25, factor)) : 1;
}
