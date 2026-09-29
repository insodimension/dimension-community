// The renderer contract. One module per document kind under `renderers/<kind>.ts`
// default-exports a `Renderer`; `index.ts` finds them by file name and loads each
// as its own chunk, so a Word file never pays for the PDF engine.
//
// Everything runs inside the View's sandboxed frame (opaque origin, no network),
// so a renderer may parse untrusted bytes but has nothing to reach with them.

export type Theme = "light" | "dark";

export interface MountContext {
	/** The name to show; also what a renderer may sniff a format from. */
	readonly filename: string;
	/** The host's theme. The document itself (a page of paper) does not follow it;
	 *  the chrome around the page does, and it does so through `var(--fr-*)`. */
	readonly theme: Theme;
	/**
	 * OPTIONAL. Tell the toolbar which page/slide/sheet is showing, 1-based, when
	 * the renderer changes it by itself (a scroll, a sheet-tab click). A call to
	 * `goto` needs no echo: the toolbar already knows.
	 */
	readonly onPage?: (page: number) => void;
	/** OPTIONAL. Ask the host to open an http(s) link. A renderer must never let
	 *  a document navigate the frame itself; without this, links stay inert. */
	readonly openLink?: (url: string) => void;
}

export interface Mounted {
	/** Remove everything the renderer added to `el`, revoke its URLs, stop its workers. */
	destroy(): void;
	/**
	 * ABSOLUTE zoom: `1` is the layout the renderer mounted at ("100%"), `2` is
	 * twice that. The toolbar keeps the factor within 0.25-4 and calls this with
	 * the new absolute value every time; absent means the format cannot zoom and
	 * the zoom controls are hidden.
	 */
	zoom?(factor: number): void;
	/** Pages, slides or sheets, when the document has more than one. Absent hides the pager. */
	readonly pageCount?: number;
	/** Show page/slide/sheet `page` (1-based, in 1..pageCount). Absent hides the pager. */
	goto?(page: number): void;
}

export interface Renderer {
	/**
	 * Draw `bytes` into `el`. `el` is an empty stage: `position: relative`, filling
	 * the pane, `overflow: hidden`, with a definite height. The renderer owns
	 * scrolling inside it. Rejecting shows the pane's error card with the message.
	 */
	mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted>;
}
