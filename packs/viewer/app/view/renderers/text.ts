// Plain text in a `<pre>`. The loader already capped what it read; this only
// decodes and lays out. `zoom` scales the font, the one thing text can scale.
import type { MountContext, Mounted, Renderer } from "./types";

async function mount(el: HTMLElement, bytes: Uint8Array, _ctx: MountContext): Promise<Mounted> {
	const scroller = document.createElement("div");
	scroller.className = "vw-text";
	const pre = document.createElement("pre");
	pre.dataset.slot = "viewer-text-root";
	// `stream: true` holds back a UTF-8 sequence cut in half by the byte cap
	// instead of printing a replacement character at the end.
	pre.textContent = new TextDecoder("utf-8").decode(bytes, { stream: true }).replace(/^\uFEFF/, "");
	if (pre.textContent === "") pre.textContent = "(empty file)";
	scroller.append(pre);
	el.append(scroller);
	return {
		destroy: () => scroller.remove(),
		zoom(factor) {
			scroller.style.setProperty("--vw-zoom", String(factor));
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
