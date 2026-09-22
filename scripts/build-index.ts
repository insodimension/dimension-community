// Build the marketplace INDEX from the packs on disk.
//
// WHY THIS EXISTS (owner ruling 2026-09-09): nobody clones the mall to browse
// it. Browse = this ONE file; install = the ONE pack that was chosen. So every
// fact a card needs — title, icon, version, the minimum Dimension it requires,
// its space listings — must ride the index, and the index must never be
// hand-authored: a catalog typed by hand drifts from the pack it describes, and
// the drift only ever shows up as a wrong card in a shipped store.
//
// The pack files are the source of truth, per pack directory `packs/<name>/`:
//   name / source / pluginId  ← the directory name + the manifest's plugin id
//   title / icon / requires / channel / spaces  ← the pack MANIFEST
//   version / author / license / repository  ← `package.json`
//   description / category / tags  ← the merged metadata block
//
// Manifest and metadata block are both read through `scripts/pack-manifest.mjs`,
// which is also what the validator reads them through — one reader, so the
// gate and the generator can never disagree about what a pack declares. Since
// Agent Plugins specification 1.0.0 a pack declares itself in `plugin.json`
// (portable metadata at the top level, Dimension's own fields under
// `extensions["ai.insodimension.dimension"]`); a third-party pack published
// before the spec still ships only `dimension.plugin.json`, which that reader
// falls back to, exactly like the engine's one-release read fallback.
//
// Asset paths are rewritten CATALOG-ROOT-RELATIVE (`packs/x/assets/…`): the
// origin that serves the catalog serves its images, and a not-yet-installed
// pack has no local tree to resolve a pack-relative path against. A bare glyph
// name (`hammer`) and a data-URI are carried through untouched.
//
// The index is written TWICE: to `.dimension-plugin/marketplace.json` (the
// namespace this shelf publishes under since 2026-09) and, byte-identical, to
// the pre-rename `.omp-plugin/marketplace.json`. Every Dimension built before
// oh-my-pi #158 looks only at the second path, so dropping it now would make
// this shelf disappear for every already-installed client. `--check` covers
// BOTH files. Delete the copy (and this paragraph) when the `omp` read fallback
// is dropped — CHANGELOG `[Unreleased]`.
//
// `--check` regenerates in memory and fails on any difference: CI refuses drift
// so the shelf a client fetches always describes the packs that are committed.
//
// No dependencies — runs on bun (`bun scripts/build-index.ts`), like its
// sibling validator.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackBlock, readPackManifest } from "./pack-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, ".dimension-plugin", "marketplace.json");
/** One-release compatibility copy for clients that only know `.omp-plugin`. */
const legacyCatalogPath = join(root, ".omp-plugin", "marketplace.json");
const packsDir = join(root, "packs");

/** Shelf-wide defaults for the two fields a pack's `package.json` usually
 *  omits because they are properties of THIS repository, not of the pack: every
 *  pack here lives in this git repo and ships under its license unless it says
 *  otherwise (vendored packs do — `impeccable` is Apache-2.0). A pack that
 *  declares either field wins. */
const SHELF_REPOSITORY = "https://github.com/insodimension/dimension-community";
const SHELF_LICENSE = "MIT";

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
	} catch {
		return undefined;
	}
}

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const asStrings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.length > 0)
		? [...(value as string[])]
		: undefined;

const asObject = (value: unknown): Json | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

/** A pack asset path made catalog-root-relative, or carried through when it is
 *  already a data-URI. Anything else — an absolute URL, an absolute path, a
 *  non-string — is refused BY NAME: it used to project to nonsense like
 *  `packs/x/https:/cdn…/a.png`, and a missing file used to ship green and paint
 *  a broken tile in the store. */
function catalogAsset(value: unknown, packDir: string, what: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${what} must be a non-empty string, got ${typeof value}`);
	}
	if (value.startsWith("data:")) return value;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("/")) {
		throw new Error(`${what} "${value}" must be pack-relative, not an absolute URL or path`);
	}
	const catalogPathRel = posix.join(packDir, value);
	if (!existsSync(join(root, catalogPathRel))) {
		throw new Error(`${what} "${catalogPathRel}" does not exist`);
	}
	return catalogPathRel;
}

/** A manifest `icon` is EITHER a bare glyph name the host looks up in its own
 *  icon set (`hammer`, `layers`) or a pack-relative asset (`assets/icon.svg`).
 *  A glyph has no extension and no separator; only the asset form is rebased
 *  and existence-checked. */
function catalogIcon(icon: string, packDir: string, name: string): string {
	if (icon.startsWith("data:")) return icon;
	const looksLikePath = icon.includes("/") || icon.includes("\\") || icon.includes(".");
	return looksLikePath ? catalogAsset(icon, packDir, `${name}: icon`) : icon;
}

/** The listing projection of one manifest `spaces` declaration.
 *  Deliberately NOT the whole space: a listing answers "what is this and what
 *  does it look like", never "how does it mount". Field order is fixed (and is
 *  exactly what the engine's `readSpaceListings` parses) so a no-change run is
 *  a no-diff run. */
function spaceListing(space: Json, packDir: string): Json {
	const listing: Json = { id: space.id, label: space.label };
	const preview = asObject(space.preview);
	const tagline = asString(preview?.tagline) ?? asString(space.description);
	if (tagline) listing.tagline = tagline;
	const screenshots = preview?.screenshots;
	if (Array.isArray(screenshots) && screenshots.length > 0) {
		listing.screenshots = screenshots.map(shot =>
			catalogAsset(shot, packDir, `${String(space.id)}: preview screenshot`),
		);
	}
	const icon = asString(space.icon);
	if (icon) listing.icon = icon;
	const accent = asString(asObject(space.mark)?.accent);
	if (accent) listing.accent = accent;
	// The dependency closure the install plan will walk. Carried in the index so
	// a card can say "installs 7 components" BEFORE anything is fetched.
	const requires = asStrings(asObject(space.requires)?.plugins);
	if (requires) listing.requires = requires;
	return listing;
}

/** Every space listing a pack contributes, or undefined when it contributes none. */
function spaceListings(manifest: Json, packDir: string): Json[] | undefined {
	if (!Array.isArray(manifest.spaces) || manifest.spaces.length === 0) return undefined;
	const listings = manifest.spaces
		.filter((space): space is Json => !!asObject(space) && !!asString((space as Json).id) && !!asString((space as Json).label))
		.map(space => spaceListing(space, packDir));
	return listings.length > 0 ? listings : undefined;
}

/** `{ dimension: "<semver range>" }` off a manifest, or undefined. The RANGE is
 *  not parsed here: the engine and the OMP manager are the two places that
 *  match it (`Bun.semver.satisfies`), and the validator is what refuses an
 *  unparseable one — a generator that threw on it would leave a contributor
 *  unable to regenerate the file the error tells them to regenerate. */
function requirements(manifest: Json): Json | undefined {
	const requires = asObject(manifest.requires);
	const dimension = asString(requires?.dimension);
	return dimension ? { dimension } : undefined;
}

/** `package.json.author` in catalog shape. npm allows a string
 *  (`"Name <mail> (url)"`) or an object; the catalog carries `{ name }` and,
 *  when the pack states one, `{ url }`. */
function authorOf(pkg: Json): Json | undefined {
	const asAuthorString = asString(pkg.author);
	if (asAuthorString) return { name: asAuthorString };
	const object = asObject(pkg.author);
	const name = asString(object?.name);
	if (!name) return undefined;
	const url = asString(object?.url);
	return url ? { name, url } : { name };
}

/** One catalog entry, in the field order the shelf publishes. */
function entryFor(dir: string): Json {
	const packRoot = join(packsDir, dir);
	const packDir = posix.join("packs", dir);
	const pkg = readJson(join(packRoot, "package.json"));
	if (!pkg) throw new Error(`packs/${dir}: package.json is missing or not parseable JSON`);
	const manifest = readPackManifest(packRoot) ?? {};
	// `description` / `category` / `keywords` are layered by the shared reader:
	// `package.json`'s `dimension` block (or the pre-rename `omp` spelling) is
	// the weakest layer, then `plugin.json`'s portable top-level metadata, then
	// its Dimension namespace — the engine's own order.
	const block = readPackBlock(packRoot, pkg);

	const description = asString(block.description) ?? asString(pkg.description);
	if (!description) throw new Error(`packs/${dir}: a description is required (package.json dimension.description)`);

	const entry: Json = { name: dir, source: `./${packDir}` };
	const pluginId = asString(manifest.plugin);
	if (pluginId) entry.pluginId = pluginId;
	const title = asString(manifest.title);
	if (title) entry.title = title;
	const icon = asString(manifest.icon);
	if (icon) entry.icon = catalogIcon(icon, packDir, dir);
	entry.description = description;
	const version = asString(pkg.version);
	if (!version) throw new Error(`packs/${dir}: package.json version is required`);
	entry.version = version;
	const author = authorOf(pkg);
	if (author) entry.author = author;
	// npm allows `repository` as a string or `{ type, url }`; a pack that states
	// neither belongs to the shelf's own repo, which is the common case here.
	entry.repository = asString(pkg.repository) ?? asString(asObject(pkg.repository)?.url) ?? SHELF_REPOSITORY;
	entry.license = asString(pkg.license) ?? SHELF_LICENSE;
	const category = asString(block.category) ?? asString(pkg.category);
	if (category) entry.category = category;
	const tags = asStrings(block.keywords) ?? asStrings(pkg.keywords);
	if (tags) entry.tags = tags;
	const requires = requirements(manifest);
	if (requires) entry.requires = requires;
	// The RELEASE RING a pack restricts itself to. It must ride the INDEX, not
	// just the pack: a stable-ring client filters what it BROWSES, and it browses
	// this one file. Carried verbatim (the engine's `release-ring.ts` owns the
	// meaning, and treats anything but "canary" as unrestricted), so a pack that
	// declares nothing keeps a byte-identical entry.
	const channel = asString(manifest.channel);
	if (channel) entry.channel = channel;
	const spaces = spaceListings(manifest, packDir);
	if (spaces) entry.spaces = spaces;
	return entry;
}

/** Every pack directory that ships a `package.json`, sorted by name — the order
 *  the catalog publishes, so a no-change run is a no-diff run. */
export function packDirectories(): string[] {
	if (!existsSync(packsDir)) return [];
	return readdirSync(packsDir)
		.filter(dir => {
			const path = join(packsDir, dir);
			return statSync(path).isDirectory() && existsSync(join(path, "package.json"));
		})
		.sort();
}

/** The index as it SHOULD be, given the packs on disk. `seed` carries the
 *  shelf's own identity (`name`, `owner`, `metadata`) — the only hand-authored
 *  part of this file — and every other top-level key it happens to hold. */
export function buildIndex(seed: Json): Json {
	return { ...seed, plugins: packDirectories().map(entryFor) };
}

const serialize = (catalog: Json): string => `${JSON.stringify(catalog, null, "\t")}\n`;

/** A line-level summary of what regeneration would change. Not a real unified
 *  diff (no hunk headers, no context): a CI reader needs to see WHICH lines
 *  moved, and the file is one pretty-printed JSON object where a changed field
 *  is a changed line. Capped, because a reordering can rewrite every line. */
function diffSummary(current: string, next: string): string {
	const currentLines = current.split("\n");
	const nextLines = next.split("\n");
	const lines: string[] = [];
	const limit = 40;
	for (let i = 0; i < Math.max(currentLines.length, nextLines.length); i += 1) {
		if (currentLines[i] === nextLines[i]) continue;
		if (lines.length >= limit) {
			lines.push(`  … and more (${Math.abs(currentLines.length - nextLines.length)} line-count delta)`);
			break;
		}
		if (currentLines[i] !== undefined) lines.push(`  -${currentLines[i]}`);
		if (nextLines[i] !== undefined) lines.push(`  +${nextLines[i]}`);
	}
	return lines.join("\n");
}

const seed = readJson(catalogPath);
if (!seed) {
	console.error(`${catalogPath}: missing or not parseable JSON — the shelf identity (name/owner/metadata) is hand-authored and must exist`);
	process.exit(1);
}
const { plugins: _previousPlugins, ...identity } = seed;

// A refused build is a CONTENT error a contributor must fix (a screenshot that
// is not there, a path that is not pack-relative, a pack with no description),
// so it is reported as one sentence and an exit code — not a stack trace CI
// readers have to decode.
let next: string;
try {
	next = serialize(buildIndex(identity));
} catch (error) {
	console.error(`marketplace.json: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

const current = readFileSync(catalogPath, "utf8");
const legacyCurrent = existsSync(legacyCatalogPath) ? readFileSync(legacyCatalogPath, "utf8") : undefined;
const packCount = packDirectories().length;

if (process.argv.includes("--check")) {
	let drifted = false;
	if (next !== current) {
		console.error(
			".dimension-plugin/marketplace.json is STALE — the index does not match the packs on disk.\n" +
				"  Run `bun scripts/build-index.ts` and commit the result.",
		);
		console.error(diffSummary(current, next));
		drifted = true;
	}
	// The compatibility copy is load-bearing for pre-#158 clients, so a drifted
	// or missing copy is the same failure as a stale index, not a warning.
	if (legacyCurrent !== next) {
		console.error(
			`.omp-plugin/marketplace.json is ${legacyCurrent === undefined ? "MISSING" : "STALE"} — pre-#158 clients read only this path.\n` +
				"  Run `bun scripts/build-index.ts` and commit the result.",
		);
		if (legacyCurrent !== undefined && !drifted) console.error(diffSummary(legacyCurrent, next));
		drifted = true;
	}
	if (drifted) process.exit(1);
	console.log(`marketplace.json: index in sync — ${packCount} pack(s) (+ .omp-plugin compatibility copy)`);
} else if (next === current && legacyCurrent === next) {
	console.log(`marketplace.json: index already in sync — ${packCount} pack(s), no change`);
} else {
	writeFileSync(catalogPath, next);
	// mkdir first: --check's MISSING branch tells the reader to run this script,
	// and the copy is normally missing because the DIRECTORY is gone (a git
	// clean, a partial checkout, someone deleting the stale dir to "fix" the
	// drift error). A bare write would ENOENT — the one stated recovery from
	// that branch failing is worse than the drift it reports.
	mkdirSync(dirname(legacyCatalogPath), { recursive: true });
	writeFileSync(legacyCatalogPath, next);
	console.log(`marketplace.json: wrote ${packCount} pack(s) (+ .omp-plugin compatibility copy)`);
}
