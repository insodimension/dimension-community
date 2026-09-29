// Markdown: `marked` to HTML, DOMPurify over the result, then drawn in the pane.
// The sanitiser is the boundary, not a courtesy: a document from an agent (or a
// web page an agent saved) may carry raw HTML, and the View must not run any of
// it. On top of DOMPurify's HTML profile this drops styling hooks, form controls
// and every image that is not inline data (there is no network to fetch one, and
// a broken-image box says less than the alt text).
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { MountContext, Mounted, Renderer } from "./types";

const FORBIDDEN_TAGS = ["style", "form", "button", "textarea", "select", "option", "iframe", "object", "embed", "link", "meta", "base"];

/** Sanitised markup for `source`: the security-relevant step. */
export function markdownToSafeHtml(source: string): string {
	// DOMPurify returns its input UNCHANGED when it has no DOM to work with. That is
	// a fail-open, so refuse instead of drawing unsanitised markup.
	if (!DOMPurify.isSupported) throw new Error("This environment cannot sanitise HTML, so Markdown is not shown.");
	const html = marked.parse(source, { async: false, gfm: true });
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: FORBIDDEN_TAGS,
		FORBID_ATTR: ["style", "srcset"],
	});
}

/** A template's content is inert: its images do not load while we rewrite them. */
function inertFragment(html: string): DocumentFragment {
	const template = document.createElement("template");
	template.innerHTML = html;
	for (const image of template.content.querySelectorAll("img")) {
		if (/^data:image\//i.test(image.getAttribute("src") ?? "")) continue;
		const stand = document.createElement("span");
		stand.className = "vw-md-missing";
		stand.textContent = image.getAttribute("alt")?.trim() ? `[image: ${image.getAttribute("alt")}]` : "[image]";
		image.replaceWith(stand);
	}
	for (const link of template.content.querySelectorAll("a")) {
		link.removeAttribute("target");
		link.setAttribute("rel", "noopener noreferrer");
	}
	return template.content;
}

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const scroller = document.createElement("div");
	scroller.className = "vw-md-scroll";
	const article = document.createElement("article");
	article.className = "vw-md";
	article.dataset.slot = "viewer-text-root";
	article.append(inertFragment(markdownToSafeHtml(new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, ""))));
	if (!article.hasChildNodes()) article.textContent = "(empty file)";
	scroller.append(article);
	el.append(scroller);

	// A link is never followed by the frame: http(s) goes to the host, anything else does nothing.
	article.addEventListener("click", event => {
		const link = (event.target as Element | null)?.closest("a[href]");
		if (link === null || link === undefined) return;
		event.preventDefault();
		const href = link.getAttribute("href") ?? "";
		if (/^https?:\/\//i.test(href)) ctx.openLink?.(href);
	});

	return {
		destroy: () => scroller.remove(),
		zoom(factor) {
			scroller.style.setProperty("--vw-zoom", String(factor));
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
