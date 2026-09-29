// HTML in a nested frame with `sandbox=""`: no scripts, no forms, no popups, no
// same-origin, no top navigation. The document is data, drawn, never run. It
// arrives through `srcdoc`, so the frame also inherits the View's own CSP, which
// blocks every network fetch the page might attempt.
import type { MountContext, Mounted, Renderer } from "./types";

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const frame = document.createElement("iframe");
	frame.className = "vw-html";
	frame.setAttribute("sandbox", ""); // The empty token list: every restriction on.
	frame.referrerPolicy = "no-referrer";
	frame.title = ctx.filename;
	frame.srcdoc = new TextDecoder("utf-8").decode(bytes);
	el.append(frame);
	return {
		destroy: () => frame.remove(),
		zoom(factor) {
			// Scale the page, not the frame: the frame grows by the inverse so it still fills the pane.
			frame.style.transform = factor === 1 ? "" : `scale(${factor})`;
			frame.style.width = factor === 1 ? "" : `${100 / factor}%`;
			frame.style.height = factor === 1 ? "" : `${100 / factor}%`;
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
