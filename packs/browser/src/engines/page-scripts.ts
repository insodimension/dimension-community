import type { BrowserRegion } from "../contracts.js";
import type { FieldRead } from "./types.js";
const PAGE_TEXT_SCRIPT = (limit: number): string => {
	const parts: string[] = [`# ${document.title}`, document.location.href, ""];
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
		controls.push(`${target}${kind} "${label}"${options} @${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)}`);
	}
	if (controls.length > 0) parts.push("", "## interactive", controls.join("\n"));
	const text = parts.join("\n");
	return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
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
 * Publish scripts. Each takes data arguments only (a selector, a bound) and
 * reads — none of them writes to the page. A password input is recognised and
 * never read.
 */
const ELEMENT_EXISTS_SCRIPT = (selector: string): boolean => {
	try {
		return document.querySelector(selector) !== null;
	} catch {
		return false;
	}
};
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
/** An input/textarea's `.value`, or a contenteditable's `innerText` minus one trailing newline. */
const READ_FIELD_SCRIPT = (selector: string): FieldRead => {
	let el: Element | null;
	try {
		el = document.querySelector(selector);
	} catch {
		el = null;
	}
	if (el === null) return { state: "absent" };
	if (el.tagName === "INPUT") {
		const input = el as HTMLInputElement;
		if ((input.type ?? "").toLowerCase() === "password") return { state: "password" };
		return { state: "value", value: input.value };
	}
	if (el.tagName === "TEXTAREA") return { state: "value", value: (el as HTMLTextAreaElement).value };
	const html = el as HTMLElement;
	if (!html.isContentEditable) return { state: "not-editable" };
	const text = html.innerText;
	return { state: "value", value: text.endsWith("\n") ? text.slice(0, -1) : text };
};
/** The resolved hrefs of up to `limit` elements matching `selector`, in document order. */
const LINK_HREFS_SCRIPT = (selector: string, limit: number): string[] => {
	let nodes: NodeListOf<Element>;
	try {
		nodes = document.querySelectorAll(selector);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (let i = 0; i < nodes.length && out.length < limit; i += 1) {
		const raw = nodes[i].getAttribute("href");
		if (raw === null) continue;
		try {
			out.push(new URL(raw, document.baseURI).href);
		} catch {
			// Not a URL: not a receipt.
		}
	}
	return out;
};

export {
	PAGE_TEXT_SCRIPT,
	ELEMENTS_IN_REGION_SCRIPT,
	SELECT_ALL_SCRIPT,
	FAVICON_HREF_SCRIPT,
	ELEMENT_EXISTS_SCRIPT,
	IS_PASSWORD_SCRIPT,
	TYPE_TARGET_SCRIPT,
	READ_FIELD_SCRIPT,
	LINK_HREFS_SCRIPT,
};
