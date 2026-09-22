// Standalone catalog validator - no dependencies, runs on bare node/bun.
// The monorepo runs each pack's tests; THIS repo's CI can only see itself,
// so it validates what is checkable standalone: the catalog and pack layout.
//
// `--check` additionally runs the index generator's drift gate, which is a
// TypeScript file — that mode needs bun (plain node runs every other check).
//
// What a pack declares is read through `scripts/pack-manifest.mjs` — the SAME
// reader the index generator uses, so this gate and that projection can never
// disagree about a pack. It reads the Agent Plugins spec `plugin.json` first
// and falls back to the legacy `dimension.plugin.json` a pre-spec third-party
// pack still ships.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackBlock, readPackManifestResult } from "./pack-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, ".dimension-plugin", "marketplace.json");
/** One-release compatibility copy for clients that only know `.omp-plugin`. */
const legacyCatalogPath = join(root, ".omp-plugin", "marketplace.json");
const errors = [];

const catalogRaw = readFileSync(catalogPath, "utf8");
const catalog = JSON.parse(catalogRaw);

// The copy is what every pre-#158 client actually fetches. A shelf whose two
// catalogs disagree serves two different marketplaces depending on the client's
// build date, which is worse than either being wrong on its own.
if (!existsSync(legacyCatalogPath)) {
	errors.push(".omp-plugin/marketplace.json is missing — pre-#158 clients read only that path (run scripts/build-index.ts)");
} else if (readFileSync(legacyCatalogPath, "utf8") !== catalogRaw) {
	errors.push(".omp-plugin/marketplace.json differs from .dimension-plugin/marketplace.json (run scripts/build-index.ts)");
}

// The catalog is a DERIVED index (scripts/build-index.ts): every field of every
// entry comes off the pack's own files, so a catalog that does not match the
// packs on disk is a bug no per-field check can see. `--check` here delegates
// to the generator's own check rather than reimplementing the projection —
// two implementations of "what the index should be" is exactly the drift this
// gate exists to refuse.
if (process.argv.includes("--check")) {
	// Spawn bun BY NAME, never process.execPath: under node that is node, which
	// cannot run a .ts file, and the resulting non-zero exit read as "DRIFTED" —
	// a false failure naming the wrong cause. No bun on PATH is its own error.
	const check = spawnSync("bun", [join(root, "scripts", "build-index.ts"), "--check"], { stdio: "inherit" });
	if (check.error) errors.push(`--check needs bun on PATH to run scripts/build-index.ts (${check.error.message})`);
	else if (check.status !== 0) errors.push("the catalog has DRIFTED from the packs on disk (run scripts/build-index.ts)");
}

if (typeof catalog.name !== "string" || !/^[a-z0-9-]+$/.test(catalog.name)) {
	errors.push("catalog.name must be a kebab-case string");
}
if (typeof catalog.owner?.name !== "string" || catalog.owner.name.length === 0) {
	errors.push("catalog.owner.name is required");
}
if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
	errors.push("catalog.plugins must be a non-empty array");
}

const seen = new Set();
for (const plugin of catalog.plugins ?? []) {
	const label = plugin?.name ?? "<unnamed>";
	if (typeof plugin.name !== "string" || !/^[a-z0-9-]+$/.test(plugin.name)) {
		errors.push(`plugin "${label}": name must be kebab-case`);
	}
	if (seen.has(plugin.name)) errors.push(`plugin "${label}": duplicate name`);
	seen.add(plugin.name);
	if (typeof plugin.source === "string") {
		if (!plugin.source.startsWith("./")) {
			errors.push(`plugin "${label}": relative source must start with ./`);
		} else {
			const packDir = join(root, plugin.source);
			if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
				errors.push(`plugin "${label}": source directory ${plugin.source} does not exist`);
			} else if (!existsSync(join(packDir, "package.json"))) {
				errors.push(`plugin "${label}": ${plugin.source}/package.json is missing`);
			}
			// A declared bundle entry is a shipping commitment: dist/ is the ONLY
			// delivery path (the app holds no static pack imports), so a missing
			// or empty committed bundle must fail HERE, not as a dropped
			// component at runtime.
			// Read through the shared reader (`scripts/pack-manifest.mjs`), the
			// same one the index generator uses: `plugin.json` first (Agent
			// Plugins spec 1.0.0, Dimension's fields under
			// `extensions["ai.insodimension.dimension"]`), then the legacy
			// `dimension.plugin.json` a pre-spec third-party pack still ships.
			// The field names below are unchanged — the source moved, the shape
			// did not.
			const { manifest, source: manifestFile, error: manifestError } = readPackManifestResult(packDir);
			if (manifestError) {
				errors.push(`plugin "${label}": ${manifestFile} ${manifestError}`);
			} else if (manifest) {
				if (manifest.entry !== undefined) {
					if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
						errors.push(`plugin "${label}": entry must be a non-empty relative path`);
					} else if (manifest.entry.startsWith("/") || manifest.entry.split(/[\\/]/).includes("..")) {
						errors.push(`plugin "${label}": entry must be relative with no ".." segment`);
					} else {
						const bundlePath = join(packDir, manifest.entry);
						if (!existsSync(bundlePath) || !statSync(bundlePath).isFile()) {
							errors.push(`plugin "${label}": declared entry ${manifest.entry} does not exist — run \`bun run build\` in ${plugin.source} and commit dist/`);
						} else if (statSync(bundlePath).size === 0) {
							errors.push(`plugin "${label}": declared entry ${manifest.entry} is empty`);
						}
					}
				}
				// `opens` is a RESOLUTION PROMISE, and a disabled pack breaks it
				// in silence. The host resolves an open-request by asking the
				// registry which mounted component declares the kind
				// (`instrumentOpening(kind)`); a pack that ships
				// `defaultEnabled: false` contributes no component, so the
				// lookup answers undefined and the host quietly does the OTHER
				// thing — for `review`, it opens the system browser. Nothing is
				// missing on screen and no error is logged, which is why
				// `pr-viewer` shipped in #58 and stayed invisible until it was
				// reported as "where is the PR viewer?" a month later.
				//
				// This is the twin of the unlisted-pack check at the bottom of
				// this file: there a pack exists and the store cannot see it,
				// here a pack installs and the APP cannot see it. Both are
				// green under every other check.
				//
				// Scoped to `opens` on purpose. A pack may legitimately ship
				// off (the decorative `*-mark` packs do, and an opt-in overlay
				// is the right default for a mark), but a pack that has told
				// the host "route this kind to me" has no such defence.
				//
				// The TYPE check is not pedantry, and it is not separable from
				// the rule: the engine parses this field with `parseStringArray`
				// (packages/engine/src/assembly-contributions.ts:241), which
				// rejects a non-array or a non-string member and then drops the
				// WHOLE component declaration with only a warn. So a typo'd
				// `"opens": "review"` fails in exactly the invisible way this
				// rule exists to prevent — and it would also slip past the
				// enabled check below, which is why presence, not array-ness,
				// is what branches here.
				if (
					manifest.opens !== undefined &&
					(!Array.isArray(manifest.opens) || manifest.opens.some(k => typeof k !== "string" || k.length === 0))
				) {
					errors.push(
						`plugin "${label}": opens must be an array of non-empty strings (the engine drops the whole component declaration otherwise)`,
					);
				} else if (Array.isArray(manifest.opens) && manifest.opens.length > 0) {
					const pkgPath = join(packDir, "package.json");
					let pkg;
					try {
						pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					} catch {
						// Only the MISSING case is reported above (the existsSync
						// check on package.json). Nothing in this validator parsed
						// a pack's package.json before this rule existed, so an
						// UNREADABLE one was never reported by anyone — and
						// swallowing it here would leave this gate silently inert
						// for the one pack whose manifest is broken.
						if (existsSync(pkgPath)) errors.push(`plugin "${label}": package.json is not parseable JSON`);
					}
					// Through the shared reader, NOT `pkg.dimension`:
					// `defaultEnabled` moved into `plugin.json`'s Dimension
					// namespace, so a direct package.json read would find
					// nothing and leave this gate inert — the exact silent
					// failure the comment above says it exists to prevent.
					const block = readPackBlock(packDir, pkg);
					if (block.defaultEnabled === false) {
						errors.push(
							`plugin "${label}": declares opens: [${manifest.opens.map(k => JSON.stringify(k)).join(", ")}] but ships defaultEnabled: false — a disabled pack contributes no component, so the host's open-request resolves to nothing and silently falls back. Remove defaultEnabled, or drop the opens declaration.`,
						);
					}
				}
			}
		}
	} else if (typeof plugin.source !== "object" || plugin.source === null) {
		errors.push(`plugin "${label}": source must be a relative path or a source object`);
	}
	if (typeof plugin.description !== "string" || plugin.description.length < 10) {
		errors.push(`plugin "${label}": a real description is required`);
	}
	if (typeof plugin.license !== "string" || plugin.license.length === 0) {
		errors.push(`plugin "${label}": license is required`);
	}
	// Browse fields: the store paints a card from the INDEX alone, so an entry
	// whose title or icon is the wrong TYPE breaks a card for a pack nobody has
	// installed — the one case no runtime read of the pack tree can catch.
	if (plugin.title !== undefined && (typeof plugin.title !== "string" || plugin.title.length === 0)) {
		errors.push(`plugin "${label}": title must be a non-empty string`);
	}
	if (plugin.icon !== undefined && (typeof plugin.icon !== "string" || plugin.icon.length === 0)) {
		errors.push(`plugin "${label}": icon must be a non-empty string (a catalog-root-relative asset path or a glyph name)`);
	}
	// `requires.dimension` gates INSTALL in the engine and the OMP manager, both
	// of which match it with `Bun.semver.satisfies` — the one field here that
	// decides whether a pack may be installed at all, so a range that does not
	// mean what its author thinks must fail HERE, where it can still be fixed.
	//
	// Two checks, because one is not enough: `Bun.semver.satisfies` never THROWS
	// (measured on bun 1.x: `satisfies("0.0.0", "not a range")` returns TRUE),
	// so an unparseable range does not crash the gate — it silently opens it for
	// every host version. The token check is therefore the real gate, and the
	// call is kept because "the engine's matcher does not throw on it" is part
	// of what this field promises.
	if (plugin.requires !== undefined) {
		if (typeof plugin.requires !== "object" || plugin.requires === null || Array.isArray(plugin.requires)) {
			errors.push(`plugin "${label}": requires must be an object (e.g. { "dimension": ">=0.9.89" })`);
		} else if (plugin.requires.dimension !== undefined) {
			const range = plugin.requires.dimension;
			if (typeof range !== "string" || range.length === 0) {
				errors.push(`plugin "${label}": requires.dimension must be a non-empty semver range string`);
			} else {
				// A comparator set: whitespace-separated tokens, `||` alternatives,
				// and the hyphen-range separator. Each token is an optional operator
				// plus a full or partial version (`>=0.9.89`, `^1.2`, `1.x`, `*`).
				const tokens = range.split(/\s+/).filter(token => token.length > 0 && token !== "||" && token !== "-");
				const malformed = tokens.filter(
					token => !/^(?:\*|[xX]|(?:[<>]=?|=|~|\^|v)?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(token),
				);
				if (tokens.length === 0 || malformed.length > 0) {
					errors.push(
						`plugin "${label}": requires.dimension "${range}" is not a semver range (unrecognized: ${malformed.join(", ") || "<empty>"})`,
					);
				} else if (typeof Bun !== "undefined") {
					try {
						Bun.semver.satisfies("0.0.0", range);
					} catch (error) {
						errors.push(
							`plugin "${label}": requires.dimension "${range}" cannot be matched by the engine's semver (${error instanceof Error ? error.message : String(error)})`,
						);
					}
				}
			}
		}
	}
	// `channel` restricts a pack to a RELEASE RING (`canary` = work in progress,
	// testers only). The engine treats any unrecognised value as UNRESTRICTED,
	// deliberately — a typo must never delete a shipping pack from every stable
	// install — which means a typo here is SILENT at runtime. This is the one
	// place it can still be loud, so it fails the shelf.
	if (plugin.channel !== undefined && !["stable", "canary"].includes(plugin.channel)) {
		errors.push(
			`plugin "${label}": channel must be "stable" or "canary" (got ${JSON.stringify(plugin.channel)}); omit it for a pack that ships to everyone`,
		);
	}
}

// A pack that exists but is not listed is invisible to the store: it can only
// ever be dev-linked, and the engine's provenance (`<name>@<marketplace>`) is
// never minted for it. Two artifactory pilots shipped that way (review of #32),
// with CI green because this loop only ever walked `catalog.plugins`.
const packsDir = join(root, "packs");
if (existsSync(packsDir)) {
	const listed = new Set((catalog.plugins ?? []).map(plugin => plugin.source));
	for (const dir of readdirSync(packsDir).sort()) {
		const packDir = join(packsDir, dir);
		if (!statSync(packDir).isDirectory() || !existsSync(join(packDir, "package.json"))) continue;
		if (!listed.has(`./packs/${dir}`)) errors.push(`packs/${dir} exists but has no catalog entry (CONTRIBUTING.md step 5)`);
	}
}

if (errors.length > 0) {
	console.error(`marketplace.json: ${errors.length} problem(s)`);
	for (const error of errors) console.error(`  - ${error}`);
	process.exit(1);
}
console.log(`marketplace.json OK - ${catalog.plugins.length} pack(s) validated`);
