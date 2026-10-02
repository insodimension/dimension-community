// The page's utilities, held while a page is mounted. The host's Tailwind scans
// the kit's and the app's SOURCE, never a bundle loaded at runtime, so a class
// only this page uses would be silently absent (the `triage-rail` and
// `traction-ui` packs' finding). `page.css` compiles exactly the utilities
// these sources use, against the host's own theme (`@reference`, so no token,
// reset or base rule is emitted twice), scoped to the page's root element so
// none of them can reach a host element. Every value reads a `--fr-*` token, so
// themes, accent, contrast and UI scale flow through untouched.
import { useInsertionEffect } from "react";
import css from "./page.css?inline";
import { holdSheet } from "./sheet";

const STYLE_ID = "general-agents-page-styles";

/** Keep the page's sheet in the document while the calling page is mounted: in
 *  place before its first paint, gone with its last instance. */
export function usePageStyles(): void {
	useInsertionEffect(() => holdSheet(globalThis.document, STYLE_ID, css), []);
}
