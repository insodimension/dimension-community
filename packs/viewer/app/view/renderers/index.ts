// The renderer registry: a kind is a file. `renderers/<kind>.ts` default-exports
// a `Renderer` and is loaded, as its own chunk, the first time a document of that
// kind opens. Finding modules by file name (rather than one hand-written
// `import("./docx")` per kind) means a renderer that does not exist yet is simply
// absent, and the pane says "preview not available" instead of the build failing.
import type { ViewerKind } from "../../../src/contract";
import type { Renderer } from "./types";

type RendererModule = { readonly default: Renderer };

const modules = import.meta.glob<RendererModule>(["./*.ts", "!./index.ts", "!./types.ts"]);

/** The renderer for `kind`, or `null` when this build ships none for it. A chunk
 *  that fails to load rejects: that is an error to show, not an absence. */
export async function loadRenderer(kind: ViewerKind): Promise<Renderer | null> {
	const load = modules[`./${kind}.ts`];
	return load === undefined ? null : (await load()).default;
}
