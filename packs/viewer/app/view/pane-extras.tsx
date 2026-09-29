// The seam a layer on top of the viewer plugs into (markup on an image, comments
// on a document). Deliberately its own file: the pane imports these two exports
// and nothing else about what sits on top, and the layer's owner edits THIS file
// without touching the pane. The defaults draw nothing and offer no modes, so the
// viewer is complete without any layer.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { ReactNode } from "react";
import type { ViewerKind } from "../../src/contract";
import type { DocTab } from "./tabs";

/** The toolbar's markup modes: pick marks on a picture, or comments on text. */
export type AnnotateMode = "marks" | "comments";

export interface PaneExtrasProps {
	readonly app: App;
	readonly tab: DocTab;
	/** This document's tab is the one showing. */
	readonly active: boolean;
	/** The renderer has mounted: `frame` now holds the rendered document. */
	readonly ready: boolean;
	/** The `position: relative` frame around the rendered document (`data-slot="viewer-stage-frame"`). */
	readonly frame: HTMLElement | null;
	/** The mode the toolbar toggle is in, or `null` when off. */
	readonly mode: AnnotateMode | null;
	/** Leave or change the mode from inside the layer (Esc, a Done button). */
	readonly onMode: (mode: AnnotateMode | null) => void;
}

/** Which modes the toolbar offers for a kind. Empty hides the toggle. */
export function annotationModes(_kind: ViewerKind): readonly AnnotateMode[] {
	return [];
}

/**
 * Rendered as the LAST child of the pane's flex row, after the stage frame, so
 * what it returns is the pane's right-hand column (return `null` for none).
 * Overlays belong INSIDE the document: portal into `frame`, or into the picture
 * (`[data-slot="viewer-picture"]`) or text (`[data-slot="viewer-text-root"]`)
 * element found in `frame` once `ready`.
 */
export function PaneExtras(_props: PaneExtrasProps): ReactNode {
	return null;
}
