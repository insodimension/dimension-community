// What a pack DECLARES, read once for the whole shelf.
//
// WHY THIS MODULE EXISTS: two tools in this repo answer the same question —
// the index generator (`build-index.ts`) projects a pack's declarations into
// the catalog, and the validator (`validate-marketplace.mjs`) gates them. When
// each carried its own read of the pack's files they could disagree about what
// a pack says, and they did: a rule that reads the wrong file does not fail, it
// goes SILENTLY INERT (the `opens` + `defaultEnabled` gate below is exactly
// that shape of bug). One reader, imported by both, makes that disagreement
// impossible. Plain ESM JavaScript on purpose: `build-index.ts` runs under bun
// as TypeScript and the validator runs on bare node, and `.mjs` is the one form
// both can import with no build step and no dependency.
//
// WHAT A PACK DECLARES, since Agent Plugins specification 1.0.0:
//   `plugin.json`  — portable top-level metadata (`name`, `version`,
//                    `description`, `keywords`, `author`, …) plus every
//                    host-specific field under
//                    `extensions["ai.insodimension.dimension"]`.
//   `package.json` `dimension{}` — build-only keys after the migration, but
//                    still the weakest metadata layer (and `omp{}` is the
//                    pre-rename spelling of that block).
//
// WHY THE FALLBACK IS NEW-FIRST, THEN LEGACY: every pack in THIS repo has been
// migrated and no `dimension.plugin.json` remains here. Third-party packs
// published before the spec still ship the legacy file only, and the engine
// keeps a one-release read fallback for them, so these tools must be able to
// read such a pack too. The direction matters: a pack mid-migration can carry
// BOTH files, and the spec file is the one that is authoritative — reading
// legacy-first would make a stale leftover manifest silently outrank the real
// one. Delete the legacy branch when the engine drops its own read fallback.
//
// An UNPARSEABLE `plugin.json` is never treated as "absent": that would fall
// through to a legacy file that is not there and report a pack as manifest-less
// instead of as broken. `readPackManifestResult` carries the error so the
// validator can name the file that actually failed to parse.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {Record<string, unknown>} Json */

/** The Dimension host's reserved key in a spec manifest's `extensions` map. */
export const DIMENSION_EXTENSION = "ai.insodimension.dimension";

/** The spec manifest, newest first; the legacy file the engine still falls back to. */
export const MANIFEST_FILE = "plugin.json";
export const LEGACY_MANIFEST_FILE = "dimension.plugin.json";

/** The metadata keys the catalog reads off a pack, in no particular order. */
const BLOCK_FIELDS = ["description", "keywords", "category", "defaultEnabled", "toolLoading"];

/** The subset of those that spec §5.4 puts at a manifest's TOP level, where
 *  they are portable across hosts rather than Dimension-specific. */
const PORTABLE_BLOCK_FIELDS = ["description", "keywords"];

/** @param {unknown} value @returns {Json | undefined} */
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Json} */ (value) : undefined);

/**
 * One JSON file off disk, distinguishing "not there" from "there and broken".
 * @param {string} path
 * @returns {{ present: boolean, value?: Json, error?: string }}
 */
function readJsonFile(path) {
	if (!existsSync(path)) return { present: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const value = asObject(parsed);
		return value ? { present: true, value } : { present: true, error: "is not a JSON object" };
	} catch {
		return { present: true, error: "is not parseable JSON" };
	}
}

/**
 * A pack's DIMENSION manifest view, plus where it came from and why it failed.
 *
 * The view is flat and uses exactly the field names the legacy
 * `dimension.plugin.json` used (`plugin`, `title`, `icon`, `entry`, `opens`,
 * `requires`, `channel`, `spaces`, `components`, `type`, `slot`,
 * `contractVersion`, …), so every consumer projection written against that
 * shape keeps working: the SOURCE moved, the shape did not.
 *
 * @param {string} packRoot absolute path to `packs/<name>`
 * @returns {{ manifest?: Json, source?: string, error?: string, document?: Json }}
 *   `source` names the file the manifest was read from; `error` is a sentence
 *   fragment about the file named by `source` (e.g. "is not parseable JSON");
 *   `document` is the whole spec manifest when one was read.
 */
export function readPackManifestResult(packRoot) {
	const spec = readJsonFile(join(packRoot, MANIFEST_FILE));
	if (spec.present) {
		// Present but broken is an ERROR, never a fallback: see the header.
		if (!spec.value) return { source: MANIFEST_FILE, error: spec.error };
		const document = spec.value;
		const manifest = { ...(asObject(asObject(document.extensions)?.[DIMENSION_EXTENSION]) ?? {}) };
		// The spec's top-level `name` IS the plugin id the legacy manifest spelled
		// `plugin`; it is the one field that does not live in the namespace.
		if (typeof document.name === "string" && document.name.length > 0) manifest.plugin = document.name;
		return { manifest, source: MANIFEST_FILE, document };
	}

	const legacy = readJsonFile(join(packRoot, LEGACY_MANIFEST_FILE));
	if (!legacy.present) return {};
	if (!legacy.value) return { source: LEGACY_MANIFEST_FILE, error: legacy.error };
	return { manifest: legacy.value, source: LEGACY_MANIFEST_FILE };
}

/**
 * A pack's Dimension manifest view, or undefined when the pack declares
 * neither `plugin.json` nor `dimension.plugin.json` (or the one it declares is
 * unreadable — use `readPackManifestResult` when that difference matters).
 * @param {string} packRoot
 * @returns {Json | undefined}
 */
export function readPackManifest(packRoot) {
	return readPackManifestResult(packRoot).manifest;
}

/**
 * The merged METADATA view the catalog reads: `description`, `keywords`,
 * `category`, `defaultEnabled`, `toolLoading`.
 *
 * Layered WEAKEST FIRST, in the engine's own order, so this shelf and the host
 * that installs from it resolve a field the same way:
 *   1. `package.json` `dimension{}` (or the pre-rename `omp{}`) — where all of
 *      this lived before the spec, and where an unmigrated pack still keeps it.
 *   2. `plugin.json` TOP-LEVEL portable metadata (§5.4: `description`,
 *      `keywords`) — the cross-host answer.
 *   3. `plugin.json`'s `extensions["ai.insodimension.dimension"]` — the
 *      host-specific answer, so a pack can say something different to Dimension
 *      than it says to every other host.
 *
 * @param {string} packRoot
 * @param {Json | undefined} [pkg] the pack's parsed `package.json`, when the
 *   caller already has it; read from disk otherwise.
 * @returns {Json} never undefined — an undeclaring pack yields `{}`.
 */
export function readPackBlock(packRoot, pkg) {
	const manifestPkg = pkg ?? readJsonFile(join(packRoot, "package.json")).value;
	/** @type {Json} */
	const block = {};
	const assign = (source, fields) => {
		if (!source) return;
		for (const field of fields) if (source[field] !== undefined) block[field] = source[field];
	};

	assign(asObject(manifestPkg?.dimension) ?? asObject(manifestPkg?.omp), BLOCK_FIELDS);
	const result = readPackManifestResult(packRoot);
	assign(result.document, PORTABLE_BLOCK_FIELDS);
	assign(result.source === MANIFEST_FILE ? result.manifest : undefined, BLOCK_FIELDS);
	return block;
}
