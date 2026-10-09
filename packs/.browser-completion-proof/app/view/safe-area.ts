// The part of this View the host has something floating over (its assistant orb parked in a corner).
//
// The host lends it on the standard's `hostContext.safeAreaInsets`; the shared kit's `applySafeAreaInsets` lays it on the
// document as `--fr-safe-area-inset-*`, and the kit's own footer (the annotation panel's "Request edits") pads itself
// with those variables. A View built on the kit's `McpAppShell` gets that for free. This one has its own root (it needs
// the tool results before it mounts anything), so it makes the same two beats itself: once connected, and on every change.
import { applySafeAreaInsets, readSafeAreaInsets } from "@dimension/mcp-app-kit/safe-area";
import type { App } from "@modelcontextprotocol/ext-apps";

/** What of the connected App this needs: its host context now, and the changes to it. */
export type SafeAreaHost = Pick<App, "getHostContext" | "addEventListener" | "removeEventListener">;

/** Lay the host's safe area on `doc` now and after every change to it. Answers the stop. */
export function followSafeArea(app: SafeAreaHost, doc: Document = document): () => void {
	applySafeAreaInsets(readSafeAreaInsets(app.getHostContext()), doc);
	const changed = (context: unknown) => applySafeAreaInsets(readSafeAreaInsets(context), doc);
	app.addEventListener("hostcontextchanged", changed);
	return () => app.removeEventListener("hostcontextchanged", changed);
}
