// Images: a blob URL in an `<img>`. SVG goes through `<img>` too, never inline,
// so a script inside an SVG is never executed (an image context runs none).
//
// The picture sits in a wrapper (`data-slot="viewer-picture"`) that is sized, in
// exact pixels, to the DRAWN image: no letterbox, and the same element through
// every zoom and resize. That is what a layer on top of the picture needs — its
// own box IS the picture's box, so a mark placed in it follows zoom and scroll
// without any arithmetic.
import type { MountContext, Mounted, Renderer } from "./types";

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
	signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));

/** The MIME type a blob needs for the browser to decode it: content first, name second. */
function imageMime(bytes: Uint8Array, filename: string): string {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, ascii("GIF8"))) return "image/gif";
	if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
	if (startsWith(bytes, ascii("ftyp"), 4)) return "image/avif";
	if (startsWith(bytes, ascii("BM"))) return "image/bmp";
	const extension = filename.split(".").pop()?.toLowerCase();
	if (extension === "svg") return "image/svg+xml";
	if (extension === "ico") return "image/x-icon";
	return "application/octet-stream";
}

/** Space kept clear around the picture inside the scroller. */
const MARGIN = 16;

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageMime(bytes, ctx.filename) }));
	const scroller = document.createElement("div");
	scroller.className = "vw-image";
	const picture = document.createElement("div");
	picture.className = "vw-picture";
	picture.dataset.slot = "viewer-picture";
	const img = document.createElement("img");
	img.alt = ctx.filename;
	img.draggable = false;
	img.decoding = "async";
	picture.append(img);
	scroller.append(picture);
	el.append(scroller);
	try {
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("This image could not be decoded."));
			img.src = url;
		});
	} catch (error) {
		scroller.remove();
		URL.revokeObjectURL(url);
		throw error;
	}

	// Zoom is absolute over the FIT size: at 1 the picture is scaled down (never
	// up) to fit the pane; at any other factor that fit size is multiplied. An
	// image with no intrinsic size (an SVG without width, height or viewBox) is
	// laid out as if it filled the pane.
	let factor = 1;
	function layout(): void {
		const room = { width: Math.max(1, scroller.clientWidth - MARGIN * 2), height: Math.max(1, scroller.clientHeight - MARGIN * 2) };
		const natural = { width: img.naturalWidth || room.width, height: img.naturalHeight || room.height };
		const fit = Math.min(room.width / natural.width, room.height / natural.height, 1);
		picture.style.width = `${Math.max(1, Math.round(natural.width * fit * factor))}px`;
		picture.style.height = `${Math.max(1, Math.round(natural.height * fit * factor))}px`;
	}
	const observer = new ResizeObserver(layout);
	observer.observe(scroller);
	layout();

	return {
		destroy() {
			observer.disconnect();
			scroller.remove();
			URL.revokeObjectURL(url);
		},
		zoom(next) {
			factor = next;
			layout();
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
