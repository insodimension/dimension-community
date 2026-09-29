// PDF with pdf.js, pages drawn to canvases.
//
// Three constraints shape this file, all from the View's frame:
//  - The worker is a `blob:` URL made from the bundled worker source. The frame
//    has an OPAQUE origin, so a worker fetched from the View's own URL is
//    cross-origin and refused; `worker-src blob:` is what the host's CSP grants.
//    It is a CLASSIC worker: a module worker cannot start from a blob here (`../pdf-worker.ts`).
//  - Bytes go in as `data`, never a URL: `connect-src` allows only the View's own
//    origin, and there is no network to fetch a document from anyway.
//  - Documents can be hundreds of pages, so only pages near the viewport hold a
//    canvas. Every other page is an empty, correctly sized slot.
import * as pdfjs from "pdfjs-dist";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
import { toClassicWorkerSource } from "../pdf-worker";
import type { MountContext, Mounted, Renderer } from "./types";

/** Pixels each side of the page column (the gap between pages is CSS). */
const GUTTER = 16;
/** How far past the viewport a page is kept drawn. */
const PRELOAD_MARGIN = "1200px 0px";
const MAX_PIXEL_RATIO = 2;

let workerUrl: string | undefined;

/** pdf.js signals by exception name (`PasswordException`, `RenderingCancelledException`). */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "");

/** One worker per document. pdf.js terminates only workers it made itself, so the
 *  `Worker` we hand it is ours to terminate. */
function createWorker(): { readonly worker: pdfjs.PDFWorker; readonly port: Worker } {
	workerUrl ??= URL.createObjectURL(new Blob([toClassicWorkerSource(workerSource)], { type: "text/javascript" }));
	const port = new Worker(workerUrl);
	return { worker: pdfjs.PDFWorker.create({ port }), port };
}

interface Slot {
	readonly element: HTMLDivElement;
	/** The page's unscaled size, learned when it is first loaded; page 1's until then. */
	width: number;
	height: number;
	/** The scale the drawn canvas was rendered at, or 0 when nothing is drawn. */
	drawnScale: number;
	generation: number;
	task: pdfjs.RenderTask | undefined;
	textLayer: pdfjs.TextLayer | undefined;
}

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const { worker, port } = createWorker();
	// `slice`: pdf.js transfers the buffer to its worker, and these bytes are cached for a remount.
	const loading = pdfjs.getDocument({ data: bytes.slice(), worker });
	let doc: pdfjs.PDFDocumentProxy;
	try {
		doc = await loading.promise;
	} catch (error) {
		worker.destroy();
		port.terminate();
		const name = errorName(error);
		if (name === "PasswordException") throw new Error("This PDF is password-protected.");
		if (name === "InvalidPDFException") throw new Error("This file is not a valid PDF.");
		throw error;
	}

	const scroller = document.createElement("div");
	scroller.className = "vw-pdf";
	const column = document.createElement("div");
	column.className = "vw-pdf-column";
	column.dataset.slot = "viewer-text-root"; // The rendered text a comment layer anchors to.
	scroller.append(column);
	el.append(scroller);

	const first = await doc.getPage(1);
	const firstSize = first.getViewport({ scale: 1 });
	const slots: Slot[] = [];
	for (let index = 0; index < doc.numPages; index++) {
		const element = document.createElement("div");
		element.className = "vw-pdf-page";
		element.dataset.index = String(index);
		element.dataset.pageNumber = String(index + 1);
		column.append(element);
		slots.push({ element, width: firstSize.width, height: firstSize.height, drawnScale: 0, generation: 0, task: undefined, textLayer: undefined });
	}

	let destroyed = false;
	let zoomFactor = 1;
	let fitScale = 1;
	const scale = () => fitScale * zoomFactor;
	const visible = new Set<number>();

	function measureFit(): void {
		const room = Math.max(120, scroller.clientWidth - GUTTER * 2);
		fitScale = Math.min(4, Math.max(0.1, room / firstSize.width));
	}

	function layout(): void {
		const current = scale();
		for (const slot of slots) {
			slot.element.style.width = `${Math.floor(slot.width * current)}px`;
			slot.element.style.height = `${Math.floor(slot.height * current)}px`;
			// The text layer sizes its glyphs from this; keep it true to the page even before a redraw.
			slot.element.style.setProperty("--scale-factor", String(current));
		}
	}

	function release(index: number): void {
		const slot = slots[index] as Slot;
		slot.generation++;
		slot.task?.cancel();
		slot.task = undefined;
		slot.textLayer?.cancel();
		slot.textLayer = undefined;
		for (const canvas of slot.element.querySelectorAll("canvas")) {
			canvas.width = 0; // Frees the bitmap now rather than at garbage collection.
			canvas.height = 0;
		}
		slot.element.replaceChildren();
		slot.drawnScale = 0;
	}

	async function draw(index: number): Promise<void> {
		const slot = slots[index] as Slot;
		const wanted = scale();
		if (slot.drawnScale === wanted) return;
		slot.task?.cancel();
		const generation = ++slot.generation;
		const page = await doc.getPage(index + 1);
		if (destroyed || generation !== slot.generation) return;
		const natural = page.getViewport({ scale: 1 });
		slot.width = natural.width;
		slot.height = natural.height;
		const viewport = page.getViewport({ scale: wanted });
		const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
		canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
		const context = canvas.getContext("2d");
		if (context === null) return;
		const task = page.render({
			canvasContext: context,
			canvas,
			viewport,
			...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
		});
		slot.task = task;
		try {
			await task.promise;
		} catch (error) {
			if (errorName(error) === "RenderingCancelledException") return;
			throw error;
		}
		if (destroyed || generation !== slot.generation) return;
		slot.task = undefined;
		slot.drawnScale = wanted;
		slot.element.style.width = `${Math.floor(viewport.width)}px`;
		slot.element.style.height = `${Math.floor(viewport.height)}px`;
		// The text layer: invisible, selectable spans over the canvas, so text can be
		// selected, copied and anchored to. Not fatal if it fails; the page is drawn.
		const layer = document.createElement("div");
		layer.className = "textLayer";
		slot.element.style.setProperty("--scale-factor", String(wanted));
		slot.element.replaceChildren(canvas, layer);
		slot.textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
		void slot.textLayer.render().catch(() => undefined);
	}

	function redrawVisible(): void {
		for (const index of visible) void draw(index).catch(() => undefined);
	}

	const intersection = new IntersectionObserver(
		entries => {
			for (const entry of entries) {
				const index = Number((entry.target as HTMLElement).dataset.index);
				if (entry.isIntersecting) {
					visible.add(index);
					void draw(index).catch(() => undefined);
				} else {
					visible.delete(index);
					release(index);
				}
			}
		},
		{ root: scroller, rootMargin: PRELOAD_MARGIN },
	);

	let lastReported = 1;
	function reportPage(): void {
		// The page under the top quarter of the pane: the one a reader would say they are on.
		const line = scroller.scrollTop + scroller.clientHeight * 0.25;
		let current = slots.length;
		for (let index = 0; index < slots.length; index++) {
			const element = (slots[index] as Slot).element;
			if (element.offsetTop + element.offsetHeight > line) {
				current = index + 1;
				break;
			}
		}
		if (current !== lastReported) {
			lastReported = current;
			ctx.onPage?.(current);
		}
	}
	// A trailing timer, not `requestAnimationFrame`: frames do not run in a hidden
	// tab, and a throttle that waits for one would never report again.
	let reportTimer: number | undefined;
	scroller.addEventListener("scroll", () => {
		if (reportTimer !== undefined) return;
		reportTimer = window.setTimeout(() => {
			reportTimer = undefined;
			reportPage();
		}, 50);
	});

	function relayout(): void {
		// Keep the reader where they were, as a fraction of the document.
		const before = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
		measureFit();
		layout();
		scroller.scrollTop = before * scroller.scrollHeight;
		redrawVisible();
	}

	measureFit();
	layout();
	for (const slot of slots) intersection.observe(slot.element);
	let lastWidth = scroller.clientWidth;
	const resize = new ResizeObserver(() => {
		if (scroller.clientWidth === lastWidth) return;
		lastWidth = scroller.clientWidth;
		relayout();
	});
	resize.observe(scroller);
	// The first page is drawn now so the pane is never blank while the observer warms up.
	void draw(0).catch(() => undefined);
	ctx.onPage?.(1);

	return {
		pageCount: doc.numPages,
		destroy() {
			destroyed = true;
			intersection.disconnect();
			resize.disconnect();
			window.clearTimeout(reportTimer);
			for (let index = 0; index < slots.length; index++) release(index);
			scroller.remove();
			void loading.destroy().finally(() => port.terminate());
		},
		zoom(factor) {
			zoomFactor = factor;
			relayout();
		},
		goto(page) {
			const slot = slots[Math.min(Math.max(page, 1), slots.length) - 1];
			if (slot !== undefined) scroller.scrollTo({ top: slot.element.offsetTop - GUTTER });
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
