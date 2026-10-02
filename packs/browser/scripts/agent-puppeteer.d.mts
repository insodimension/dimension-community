export interface PatchHunk {
	search: string;
	replace: string;
	line: number;
}
export const PATCH_FILE: string;
export const PATCHED_VERSION: string;
export function parsePatch(text: string): Map<string, PatchHunk[]>;
export function applyHunks(path: string, source: string, hunks: PatchHunk[]): string;
/** The text before the patch's first `diff --git`: what it is derived from, with the MIT notice. */
export function patchNotes(text: string): string;
/** The installed puppeteer-core and esbuild as one string; throws when puppeteer-core is not `PATCHED_VERSION`. `from` is a file URL anchoring the lookup. */
export function bundleIdentity(from?: string): string;
export function buildAgentPuppeteer(options: { outfile: string }): Promise<{ files: string[] }>;
