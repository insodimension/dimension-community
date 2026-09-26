import type { BrowserRegion } from "../contracts.js";
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
		// A selector the agent can pass straight back to browser_act.
		const name = el.getAttribute("name");
		const choice = (type === "radio" || type === "checkbox") && input.getAttribute("value") ? `[value="${input.getAttribute("value")!.replace(/"/g, '\\"')}"]` : "";
		const target = el.id ? `#${CSS.escape(el.id)}` : name ? `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]${choice}` : el.tagName.toLowerCase();
		const kind = el.tagName === "INPUT" ? ` (${type || "text"})` : "";
		const options = el.tagName === "SELECT"
			? ` options: ${Array.from((el as HTMLSelectElement).options).slice(0, 12).map((o) => o.text.trim()).join(" | ")}`
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
const ELEMENTS_IN_REGION_SCRIPT = (region: BrowserRegion, limit: number): string => {
	const out: string[] = [];
	const nodes = document.querySelectorAll("body *");
	for (let i = 0; i < nodes.length && out.length < 60; i += 1) {
		const el = nodes[i] as HTMLElement;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		const intersects =
			r.left < region.x + region.width && r.right > region.x && r.top < region.y + region.height && r.bottom > region.y;
		if (!intersects) continue;
		if (el.children.length > 0 && r.width * r.height > region.width * region.height * 4) continue;
		const input = el as HTMLInputElement;
		const secret = el.tagName === "INPUT" && ["password", "hidden"].includes((input.type ?? "").toLowerCase());
		const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
		const label = secret
			? "[redacted input]"
			: ((editable ? input.value || "" : "") || el.getAttribute("aria-label") || el.innerText || "")
					.trim()
					.replace(/\s+/g, " ")
					.slice(0, 100);
		const id = el.id ? `#${el.id}` : "";
		out.push(
			`${el.tagName.toLowerCase()}${id} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}] ${label}`,
		);
	}
	const text = out.join("\n");
	return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
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
 * prototype do not reach it). Whether `el` is a password input, whether it has
 * focus in a focused document, and this frame's real origin.
 */
const SAVED_PASSWORD_TARGET_SCRIPT = (el: Element): { password: boolean; focused: boolean; origin: string } => ({
	password: el instanceof HTMLInputElement && el.type === "password",
	focused: document.hasFocus() && (el.getRootNode() as Document | ShadowRoot).activeElement === el,
	origin: window.origin,
});
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

export {
	PAGE_TEXT_SCRIPT,
	READ_PAGE_SCRIPT,
	ELEMENTS_IN_REGION_SCRIPT,
	SELECT_ALL_SCRIPT,
	FAVICON_HREF_SCRIPT,
	IS_PASSWORD_SCRIPT,
	TYPE_TARGET_SCRIPT,
	SAVED_PASSWORD_TARGET_SCRIPT,
	FOCUSED_LEAF_SCRIPT,
	FRAME_INSET_SCRIPT,
	READ_FIELD_SCRIPT,
	LINK_HREFS_SCRIPT,
};
