import type { BrowserRegion, ElementInspection, PageElement, PageElements, PageScroll } from "../contracts.js";
import type { ReportedIdentity } from "./launch.js";
import type { FieldRead, PageRead } from "./types.js";
/**
 * The page's text and interactive controls, each with a selector for
 * browser_act and its center in main-viewport pixels. Run in a child frame,
 * `frameRef` names it: the section is headed `## frame @<ref>`, every selector
 * starts `@<ref> `, and (`dx`, `dy`) — where the frame's content box sits in
 * the main viewport — is added to each center.
 */
const PAGE_TEXT_SCRIPT = (limit: number, frameRef: string | null = null, dx = 0, dy = 0): string => {
	const parts: string[] = frameRef === null ? [`# ${document.title}`, document.location.href, ""] : [`## frame @${frameRef}: ${document.title}`, document.location.href, ""];
	const body = document.body?.innerText ?? "";
	parts.push(body.replace(/\n{3,}/g, "\n\n").trim());
	const controls: string[] = [];
	// A selector the agent can pass straight back to browser_act: the first form that matches THIS element and no other in the document.
	const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;
	const only = (css: string, el: Element): boolean => {
		try {
			const found = document.querySelectorAll(css);
			return found.length === 1 && found[0] === el;
		} catch {
			return false;
		}
	};
	// The last resort: tags with :nth-of-type up to the nearest unique id, or the body.
	const path = (el: Element): string => {
		const steps: string[] = [];
		for (let node: Element | null = el; node && node !== document.documentElement && steps.length < 8; node = node.parentElement) {
			const anchor = node.id ? `#${CSS.escape(node.id)}` : "";
			if (anchor && document.querySelectorAll(anchor).length === 1) {
				steps.unshift(anchor);
				break;
			}
			const tag = node.tagName.toLowerCase();
			const same = node.parentElement ? Array.from(node.parentElement.children).filter((sibling) => sibling.tagName === node?.tagName) : [];
			steps.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
		}
		return steps.join(" > ");
	};
	const nodes = document.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='link']");
	for (let i = 0; i < nodes.length && controls.length < 200; i += 1) {
		const el = nodes[i] as HTMLElement;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		// Credential boundary: a password/hidden field's value is described, never
		// read.
		const input = el as HTMLInputElement;
		const type = (input.type ?? "").toLowerCase();
		const secret = el.tagName === "INPUT" && (type === "password" || type === "hidden");
		// A text control's current value is what makes a snapshot actionable, so it
		// is included — except for password/hidden fields, which are only ever
		// described. Empty strings must fall through, hence `||` rather than `??`.
		const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
		const value = secret ? "[redacted]" : editable ? (input.value ?? "") : "";
		// Editable controls report their LIVE value first: a textarea's innerText
		// can still be the markup's original text after the value changed.
		const label = (
			(editable
				? value || el.getAttribute("aria-label") || ""
				: el.getAttribute("aria-label") || el.innerText || "") ||
			el.getAttribute("name") ||
			el.getAttribute("placeholder") ||
			""
		)
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 80);
		const tag = el.tagName.toLowerCase();
		const name = el.getAttribute("name");
		const href = tag === "a" ? el.getAttribute("href") : null;
		const choice = (type === "radio" || type === "checkbox") && input.getAttribute("value") ? `[value=${quote(input.getAttribute("value") as string)}]` : "";
		const candidates = [el.id ? `#${CSS.escape(el.id)}` : "", name ? `${tag}[name=${quote(name)}]${choice}` : "", tag, href ? `a[href=${quote(href)}]` : ""];
		const target = candidates.find((css) => css !== "" && only(css, el)) ?? path(el);
		// A checkbox or radio says whether it is set; never a password or hidden field, which are only described.
		const checked = type === "checkbox" || type === "radio" ? (input.checked ? " [checked]" : " [unchecked]") : "";
		const kind = el.tagName === "INPUT" ? ` (${type || "text"})${checked}` : "";
		const picked = el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.text.trim()).join(" | ").slice(0, 80) : "";
		const options = el.tagName === "SELECT"
			? ` options: ${Array.from((el as HTMLSelectElement).options).slice(0, 12).map((o) => o.text.trim()).join(" | ")}${picked ? ` selected: ${picked}` : ""}`
			: "";
		const ref = frameRef === null ? "" : `@${frameRef} `;
		controls.push(`${ref}${target}${kind} "${label}"${options} @${Math.round(dx + rect.x + rect.width / 2)},${Math.round(dy + rect.y + rect.height / 2)}`);
	}
	if (controls.length > 0) parts.push("", frameRef === null ? "## interactive" : `### interactive (frame @${frameRef})`, controls.join("\n"));
	const text = parts.join("\n");
	return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
};
/**
 * browser_read's evidence: the body's readable text (cut at `limit`) and its
 * full length, the share of the first viewport a visible password field's
 * form or dialog covers, and the `src` of up to `maxFrames` VISIBLE iframes
 * with the share of the first viewport each covers. The document and every
 * open shadow root beneath it are searched, so a web-component login modal or
 * challenge is seen. A script tag is never evidence: challenge providers'
 * scripts load site-wide for invisible scoring. Judged outside the page
 * (read.ts); nothing here acts on the page.
 */
const READ_PAGE_SCRIPT = (limit: number, maxFrames: number): Omit<PageRead, "httpStatus" | "url"> => {
	const all = (document.body?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	const shown = (el: Element): boolean => {
		const rect = el.getBoundingClientRect();
		// Offscreen parking (reCAPTCHA's hidden bframe sits at top:-10000px) is not shown.
		return rect.width > 0 && rect.height > 0 && rect.right + scrollX > 0 && rect.bottom + scrollY > 0 && getComputedStyle(el).visibility !== "hidden";
	};
	// Share (0..1) of the first viewport — the top of the document, what a visitor sees on arrival — that `el` covers.
	const share = (el: Element): number => {
		const rect = el.getBoundingClientRect();
		const left = rect.left + scrollX;
		const top = rect.top + scrollY;
		const width = Math.max(0, Math.min(left + rect.width, innerWidth) - Math.max(left, 0));
		const height = Math.max(0, Math.min(top + rect.height, innerHeight) - Math.max(top, 0));
		return innerWidth > 0 && innerHeight > 0 ? (width * height) / (innerWidth * innerHeight) : 0;
	};
	let passwordShare: number | null = null;
	const frames: Array<{ src: string; share: number }> = [];
	const roots: Array<Document | ShadowRoot> = [document];
	for (let r = 0; r < roots.length; r += 1) {
		const walker = document.createTreeWalker(roots[r], NodeFilter.SHOW_ELEMENT);
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			const el = node as Element;
			if (el.shadowRoot) roots.push(el.shadowRoot);
			if (el.tagName === "INPUT") {
				if (((el as HTMLInputElement).type ?? "").toLowerCase() !== "password" || !shown(el)) continue;
				// The largest form or dialog around it: a login form inside a full-screen dialog is the dialog.
				let covered = share(el);
				for (let box = el.closest("form, dialog, [role=dialog]"); box !== null; box = box.parentElement?.closest("form, dialog, [role=dialog]") ?? null) {
					if (shown(box)) covered = Math.max(covered, share(box));
				}
				passwordShare = Math.max(passwordShare ?? 0, covered);
			} else if (el.tagName === "IFRAME" && frames.length < maxFrames) {
				const src = (el as HTMLIFrameElement).src;
				if (src && shown(el)) frames.push({ src, share: share(el) });
			}
		}
	}
	return { title: document.title, text: all.slice(0, limit), truncated: all.length > limit, bodyChars: all.length, passwordShare, frames };
};
/**
 * What is on the page under each of `regions` (viewport px), one pass over the document for all of them, and where the
 * page is scrolled. Every element is its own record (tag, id, box, words), each string cut to its bound HERE so a page
 * cannot make the answer large; the reader still treats every one as hostile text. A password or hidden input is
 * named, never read. A container much larger than the region is left out: it says nothing about what is under the
 * mark. A region takes at most 60 elements and about `limit` characters of them.
 *
 * The page can replace the built-ins this runs on (it runs in the page's own world), so nothing here is a guarantee
 * of the shape: the answer is read as untrusted data on the other side.
 */
const ELEMENTS_IN_REGIONS_SCRIPT = (
	regions: BrowserRegion[],
	limit: number,
	max: { tag: number; id: number; label: number; count: number },
): { scroll: PageScroll; regions: PageElements[] } => {
	const found: PageElements[] = regions.map(() => ({ elements: [], truncated: false }));
	const used: number[] = regions.map(() => 0);
	const open = (entry: PageElements): boolean => !entry.truncated && entry.elements.length < max.count;
	const nodes = document.querySelectorAll("body *");
	for (let i = 0; i < nodes.length && found.some(open); i += 1) {
		const el = nodes[i] as HTMLElement;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		let described: PageElement | null = null;
		for (let k = 0; k < regions.length; k += 1) {
			const region = regions[k];
			const entry = found[k];
			if (!open(entry)) continue;
			const intersects =
				r.left < region.x + region.width && r.right > region.x && r.top < region.y + region.height && r.bottom > region.y;
			if (!intersects) continue;
			if (el.children.length > 0 && r.width * r.height > region.width * region.height * 4) continue;
			if (described === null) {
				const input = el as HTMLInputElement;
				const secret = el.tagName === "INPUT" && ["password", "hidden"].includes((input.type ?? "").toLowerCase());
				const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
				const label = secret
					? "[redacted input]"
					: ((editable ? input.value || "" : "") || el.getAttribute("aria-label") || el.innerText || "")
							.trim()
							.replace(/\s+/g, " ")
							.slice(0, max.label);
				described = {
					tag: el.tagName.toLowerCase().slice(0, max.tag),
					id: (el.id || "").slice(0, max.id),
					box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
					label,
				};
			}
			const size = described.tag.length + described.id.length + described.label.length + 24;
			if (used[k] + size > limit) entry.truncated = true;
			else {
				used[k] += size;
				entry.elements.push(described);
			}
		}
	}
	const root = document.documentElement;
	return {
		scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: root.scrollWidth, height: root.scrollHeight },
		regions: found,
	};
};
/** Where the page is scrolled and how large its document is, in CSS px. */
const SCROLL_SCRIPT = (): PageScroll => {
	const root = document.documentElement;
	return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: root.scrollWidth, height: root.scrollHeight };
};
const SELECT_ALL_SCRIPT = (el: Element): boolean => {
	const field = el as HTMLInputElement | HTMLTextAreaElement;
	if (typeof field.select !== "function") return false;
	const type = ((field as HTMLInputElement).type ?? "").toLowerCase();
	if (el.tagName === "INPUT" && ["checkbox", "radio", "file", "range", "color", "button", "submit"].includes(type)) {
		return false;
	}
	field.select();
	return true;
};
/** The page's declared icon href (resolved by the browser), or null. Read only; nothing is fetched here. */
const FAVICON_HREF_SCRIPT = (): string | null => {
	const links = document.querySelectorAll("link[rel~='icon' i], link[rel='apple-touch-icon' i]");
	for (let i = 0; i < links.length; i += 1) {
		const href = (links[i] as HTMLLinkElement).href;
		if (href) return href;
	}
	return null;
};
/**
 * Publish scripts. The element scripts run on elements puppeteer already
 * resolved (its query handlers, so `pierce/` reaches shadow roots); the link
 * reader resolves its own selector in-page. All take data arguments only; they
 * read — none of them writes to the page. A password input is recognised and
 * never read.
 */
const IS_PASSWORD_SCRIPT = (el: Element): boolean =>
	el.tagName === "INPUT" && ((el as HTMLInputElement).type ?? "").toLowerCase() === "password";
/**
 * Where typed text would land right now, relative to the aimed element:
 * "elsewhere" unless the focused element is it (or, for a contenteditable,
 * inside it); "password" if what really has focus is a password input. Focus
 * is read in the element's own root, so a field inside a shadow root (where
 * `document.activeElement` is only the host) is found; the password check
 * walks on down through open shadow roots to the innermost focused element.
 */
const TYPE_TARGET_SCRIPT = (el: Element): "ok" | "elsewhere" | "password" => {
	// A detached element is its own root and has no activeElement.
	const active = (el.getRootNode() as Partial<DocumentOrShadowRoot>).activeElement ?? null;
	if (active === null) return "elsewhere";
	const aimed = active === el || ((el as HTMLElement).isContentEditable && el.contains(active));
	if (!aimed) return "elsewhere";
	let focused: Element = active;
	while (focused.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
	return focused.tagName === "INPUT" && ((focused as HTMLInputElement).type ?? "").toLowerCase() === "password" ? "password" : "ok";
};
/**
 * For `useSavedPassword` / `generatePassword`, run in puppeteer's utility world (an isolated world:
 * the page's own overrides of `window.origin`, `type`, `activeElement` or any
 * prototype do not reach it). Whether `el` is a password input, and this
 * frame's real origin.
 */
const SAVED_PASSWORD_TARGET_SCRIPT = (el: Element): { password: boolean; origin: string } => ({
	password: el instanceof HTMLInputElement && el.type === "password",
	origin: window.origin,
});
/**
 * The password insert itself, run in the utility world like
 * SAVED_PASSWORD_TARGET_SCRIPT: focus `el`, check it is still a password
 * input of `origin` holding focus in a focused document, then select its
 * content and replace it with `value` — all in ONE evaluate, so no page
 * script can move focus between the check and the insert (a blur handler
 * that runs inside `focus()` is caught by the check after it). The text goes
 * to this document's selection only, never to whatever frame has focus.
 * Anything but "inserted" means nothing was inserted.
 */
const INSERT_PASSWORD_SCRIPT = (el: Element, value: string, origin: string): "inserted" | "not_password" | "origin" | "focus" | "rejected" => {
	if (!(el instanceof HTMLInputElement) || el.type !== "password") return "not_password";
	if (window.origin !== origin) return "origin";
	el.focus();
	if (!document.hasFocus() || (el.getRootNode() as Document | ShadowRoot).activeElement !== el) return "focus";
	el.select();
	return document.execCommand("insertText", false, value) ? "inserted" : "rejected";
};
/**
 * The focused element of THIS frame when focus ends here (followed down
 * through open shadow roots, and not a frame or the body), else null. Run in
 * the utility world, like SAVED_PASSWORD_TARGET_SCRIPT.
 */
const FOCUSED_LEAF_SCRIPT = (): Element | null => {
	if (!document.hasFocus()) return null;
	let focused: Element | null = document.activeElement;
	while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
	if (focused === null || focused === document.body || focused.tagName === "IFRAME" || focused.tagName === "FRAME") return null;
	return focused;
};
/** Where an iframe's content box starts inside its own border box: border plus padding, in CSS pixels. */
const FRAME_INSET_SCRIPT = (el: Element): { x: number; y: number } => {
	const style = getComputedStyle(el);
	return { x: el.clientLeft + (parseFloat(style.paddingLeft) || 0), y: el.clientTop + (parseFloat(style.paddingTop) || 0) };
};
/**
 * An input/textarea's `.value`, or a contenteditable's text minus one trailing
 * newline. An editor that keeps one `<p>` per line (ProseMirror, Quill,
 * Lexical) reads as those lines joined by one newline each: `innerText` would
 * put a blank line between paragraphs, which is not the text that posts.
 */
const READ_FIELD_SCRIPT = (el: Element): FieldRead => {
	if (el.tagName === "INPUT") {
		const input = el as HTMLInputElement;
		if ((input.type ?? "").toLowerCase() === "password") return { state: "password" };
		return { state: "value", value: input.value };
	}
	if (el.tagName === "TEXTAREA") return { state: "value", value: (el as HTMLTextAreaElement).value };
	const html = el as HTMLElement;
	if (!html.isContentEditable) return { state: "not-editable" };
	const trimmed = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);
	const children = Array.from(html.childNodes);
	const paragraphs =
		children.some((node) => node.nodeName === "P") &&
		children.every((node) => node.nodeName === "P" || (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === ""));
	if (!paragraphs) return { state: "value", value: trimmed(html.innerText) };
	const lines = children.filter((node): node is HTMLParagraphElement => node.nodeName === "P").map((p) => trimmed(p.innerText));
	return { state: "value", value: lines.join("\n") };
};
/**
 * The text an element shows, at most `limit` characters; null for a form
 * control, whose text is a value (a password's included) and never read here,
 * and a control nested inside contributes nothing. Its text nodes are joined
 * by a space, so a display name and a handle in sibling spans read as two
 * words ("Jane Doe @jane"), where `textContent` would glue them ("Jane Doe@jane").
 */
const ELEMENT_TEXT_SCRIPT = (el: Element, limit: number): string | null => {
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return null;
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const parts: string[] = [];
	let length = 0;
	for (let node = walker.nextNode(); node !== null && length < limit; node = walker.nextNode()) {
		if (node.parentElement?.closest("textarea, select") != null) continue;
		const text = node.nodeValue ?? "";
		parts.push(text);
		length += text.length + 1;
	}
	return parts.join(" ").slice(0, limit);
};
/**
 * An element's `aria-label`, at most `limit` characters; null when it has none
 * and for a form control (whose label could be anything the page put there for
 * the field, and is never read here). The only attribute read by name, so a
 * link's href, a field's value or any token an attribute carries stays unread.
 */
const ELEMENT_LABEL_SCRIPT = (el: Element, limit: number): string | null => {
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return null;
	return el.getAttribute("aria-label")?.slice(0, limit) ?? null;
};
/**
 * The absolute hrefs of up to `limit` elements matching `selector`. The
 * selector is data, never code: plain CSS goes to `document.querySelectorAll`
 * (document order); `pierce/<css>` queries the document, then every open
 * shadow root beneath it, nested ones too (each root in document order).
 * Stops at `limit`.
 */
const LINK_HREFS_SCRIPT = (selector: string, limit: number): string[] => {
	const out: string[] = [];
	const collect = (root: Document | ShadowRoot, css: string): void => {
		const matches = root.querySelectorAll(css);
		for (let i = 0; i < matches.length && out.length < limit; i += 1) {
			const raw = matches[i].getAttribute("href");
			if (raw === null) continue;
			try {
				out.push(new URL(raw, document.baseURI).href);
			} catch {
				// Not a URL: not a receipt.
			}
		}
	};
	if (!selector.startsWith("pierce/")) {
		collect(document, selector);
		return out;
	}
	const css = selector.slice("pierce/".length);
	const roots: Array<Document | ShadowRoot> = [document];
	for (let r = 0; r < roots.length && out.length < limit; r += 1) {
		collect(roots[r], css);
		if (out.length >= limit) break;
		const walker = document.createTreeWalker(roots[r], NodeFilter.SHOW_ELEMENT);
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			const shadow = (node as Element).shadowRoot;
			if (shadow) roots.push(shadow);
		}
	}
	return out;
};

/** The page's visible text, for a wait to match after the runtime has masked it. Nothing in, string out. */
const READ_TEXT_SCRIPT = (): string => document.body?.innerText ?? "";

/**
 * browser_inspect: an element's box, overflow sizes, its parent's box and a
 * FIXED allowlist of computed styles. Nothing the caller wrote runs here; the
 * selector only chose the element. Numbers are rounded to hundredths.
 */
const INSPECT_SCRIPT = (el: Element): Omit<ElementInspection, "found"> => {
	const round = (n: number): number => Math.round(n * 100) / 100;
	const box = (node: Element | null): BrowserRegion | null => {
		if (!node) return null;
		const r = node.getBoundingClientRect();
		return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
	};
	const computed = getComputedStyle(el);
	const styles: Record<string, string> = {};
	for (const property of ["display", "position", "box-sizing", "width", "height", "margin", "padding", "border-width", "overflow", "overflow-x", "overflow-y", "flex", "grid-template-columns", "object-fit", "opacity", "visibility", "z-index"]) {
		styles[property] = computed.getPropertyValue(property);
	}
	return {
		rect: box(el) as BrowserRegion,
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
		styles,
		parent: box(el.parentElement),
	};
};
/** The browser's own answers to `navigator.userAgentData.getHighEntropyValues` (a secure context only). */
const UA_HINTS_SCRIPT = (names: string[]): Promise<ReportedIdentity["hints"]> => {
	// NavigatorUAData is not in TypeScript's DOM lib.
	const uaNavigator = navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<ReportedIdentity["hints"]> } };
	if (!uaNavigator.userAgentData) throw new Error("navigator.userAgentData is unavailable");
	return uaNavigator.userAgentData.getHighEntropyValues(names);
};

/** The unmasked WebGL vendor and renderer, as one string; undefined when the page has no WebGL. */
const GRAPHICS_SCRIPT = (): string | undefined => {
	const gl = document.createElement("canvas").getContext("webgl");
	const info = gl?.getExtension("WEBGL_debug_renderer_info");
	return gl && info ? `${String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL))} ${String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))}` : undefined;
};

/**
 * The value an eval step returned, as JSON text cut at `limit` (run with the result as `this`). Cycles, functions,
 * DOM nodes, errors and bigints are described, never thrown on.
 */
const EVAL_RESULT_SCRIPT = function (this: unknown, limit: number): { text: string; truncated: boolean } {
	const ancestors: unknown[] = [];
	let text: string;
	try {
		text =
			JSON.stringify(this, function (this: unknown, _key: string, value: unknown) {
				if (typeof value === "bigint") return `${value}n`;
				if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
				if (typeof value === "symbol") return String(value);
				if (value instanceof Node) return `[${value.nodeName.toLowerCase()}${(value as Element).id ? `#${(value as Element).id}` : ""}]`;
				if (value instanceof Error) return `${value.name}: ${value.message}`;
				if (value !== null && typeof value === "object") {
					while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
					if (ancestors.includes(value)) return "[circular]";
					ancestors.push(value);
				}
				return value;
			}) ?? "undefined";
	} catch (error) {
		text = `[unserialisable: ${error instanceof Error ? error.message : String(error)}]`;
	}
	return { text: text.slice(0, limit), truncated: text.length > limit };
};

export {
	PAGE_TEXT_SCRIPT,
	READ_TEXT_SCRIPT,
	INSPECT_SCRIPT,
	READ_PAGE_SCRIPT,
	ELEMENTS_IN_REGIONS_SCRIPT,
	SCROLL_SCRIPT,
	SELECT_ALL_SCRIPT,
	FAVICON_HREF_SCRIPT,
	IS_PASSWORD_SCRIPT,
	TYPE_TARGET_SCRIPT,
	SAVED_PASSWORD_TARGET_SCRIPT,
	INSERT_PASSWORD_SCRIPT,
	FOCUSED_LEAF_SCRIPT,
	FRAME_INSET_SCRIPT,
	READ_FIELD_SCRIPT,
	ELEMENT_TEXT_SCRIPT,
	ELEMENT_LABEL_SCRIPT,
	LINK_HREFS_SCRIPT,
	UA_HINTS_SCRIPT,
	GRAPHICS_SCRIPT,
	EVAL_RESULT_SCRIPT,
};
