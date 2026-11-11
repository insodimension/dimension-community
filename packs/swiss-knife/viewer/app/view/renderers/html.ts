import { createPageFrame } from "@dimension/mcp-app-kit/annotate";
import type { MountContext, Mounted, Renderer } from "./types";

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const frame = createPageFrame(new TextDecoder("utf-8").decode(bytes));
	frame.className = "vw-html";
	frame.dataset.slot = "viewer-html-frame";
	frame.title = ctx.filename;
	el.append(frame);
	return {
		destroy: () => frame.remove(),
		zoom(factor) {
			frame.style.transform = factor === 1 ? "" : `scale(${factor})`;
			frame.style.width = factor === 1 ? "" : `${100 / factor}%`;
			frame.style.height = factor === 1 ? "" : `${100 / factor}%`;
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
