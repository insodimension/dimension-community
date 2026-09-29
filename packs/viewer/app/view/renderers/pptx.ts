// PowerPoint decks, drawn by @aiden0z/pptx-renderer (Apache-2.0; 1.1 MB minified,
// 342 KB gzip in this pack's build, ECharts and JSZip inside). Best overall fidelity
// of the four candidates in `docs/design/84-chat-viewer-research.md` § Measured: the
// only one that drew every slide, chart, table and layout-centred title on both a
// pptxgenjs and a python-pptx deck. Known miss: a pptxgenjs chart loses its category
// labels.
//
// One slide at a time: `pageCount` is the slide count and `goto(n)` shows slide n.
// The pane's own keys (arrows, Page Up/Down, Home/End) move too and say so through
// `ctx.onPage`, so the toolbar's counter follows. The library renders SVG/HTML
// through `createElement`/`textContent` (its one `innerHTML` writes escaped text);
// each slide it draws is still passed through `neutralizeTree` before it can be
// clicked, because a hyperlink is set as a real `href`.
//
// Offline by construction: `pdfjs: false` turns off the only optional network-ish
// path (EMF-embedded PDF previews, which would import pdf.js and start a worker).

import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { clampZoom, mountOffice, neutralizeTree, POWERPOINT, ProblemError, wireLinks, ZIP_LIMITS } from "./office/shared";
import type { Mounted, MountContext, Renderer } from "./types";

/** How a key moves through the deck; Home and End are handled apart. */
const KEY_STEP: Record<string, number> = {
	ArrowRight: 1,
	ArrowDown: 1,
	PageDown: 1,
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
};

async function mountPptx(root: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const doc = root.ownerDocument;
	root.tabIndex = 0;
	const scroll = doc.createElement("div");
	scroll.className = "vo-scroll vo-slides";
	const host = doc.createElement("div");
	host.className = "vo-slide-host";
	scroll.append(host);
	root.append(scroll);

	const viewer = await PptxViewer.open(bytes, host, {
		renderMode: "slide",
		fitMode: "contain",
		zipLimits: { ...RECOMMENDED_ZIP_LIMITS, ...ZIP_LIMITS },
		lazySlides: true,
		lazyMedia: true,
		pdfjs: false,
		onSlideRendered: (_index, slide) => neutralizeTree(slide),
	});
	const pageCount = viewer.slideCount;
	if (pageCount === 0) {
		viewer.destroy();
		throw new ProblemError({ title: "This presentation has no slides", detail: "There is nothing to show." });
	}
	const unwireLinks = wireLinks(host, ctx);

	const show = (page: number): void => {
		void viewer.goToSlide(Math.min(pageCount, Math.max(1, Math.trunc(page))) - 1);
	};
	const onKey = (event: KeyboardEvent): void => {
		const current = viewer.currentSlideIndex + 1;
		const step = Object.hasOwn(KEY_STEP, event.key) ? KEY_STEP[event.key] : 0;
		const next = event.key === "Home" ? 1 : event.key === "End" ? pageCount : current + step;
		if (next === current || next < 1 || next > pageCount) return;
		event.preventDefault();
		show(next);
		ctx.onPage?.(next);
	};
	root.addEventListener("keydown", onKey);

	return {
		destroy: () => {
			root.removeEventListener("keydown", onKey);
			unwireLinks();
			viewer.destroy();
		},
		zoom: factor => {
			void viewer.setZoom(clampZoom(factor) * 100);
		},
		pageCount,
		goto: show,
	};
}

const renderer: Renderer = {
	mount: (el, bytes, ctx) => mountOffice(el, bytes, ctx, POWERPOINT, root => mountPptx(root, bytes, ctx)),
};

export default renderer;
