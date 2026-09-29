// A file with no preview: a card that says so. The size, kind and path are in
// the toolbar above; this only fills the pane so it is never blank.
import type { MountContext, Mounted, Renderer } from "./types";

async function mount(el: HTMLElement, _bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const card = document.createElement("div");
	card.className = "vw-card";
	const title = document.createElement("p");
	title.className = "vw-card-title";
	title.textContent = "No preview for this file";
	const body = document.createElement("p");
	body.className = "vw-card-body";
	body.textContent = `${ctx.filename} is not a format the viewer can draw.`;
	card.append(title, body);
	el.append(card);
	return { destroy: () => card.remove() };
}

const renderer: Renderer = { mount };
export default renderer;
