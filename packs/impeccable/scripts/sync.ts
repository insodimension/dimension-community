/**
 * Sync the vendored Impeccable skill from upstream GitHub releases.
 *
 *   bun packages/impeccable/scripts/sync.ts            # latest skill-v* release
 *   bun packages/impeccable/scripts/sync.ts skill-v3.9.1
 *   bun packages/impeccable/scripts/sync.ts --check    # report drift, change nothing
 *
 * Pipeline (deterministic, idempotent):
 *   1. Resolve the release (arg tag or /releases/latest) + its `universal.zip`
 *      asset and published sha256 digest.
 *   2. Download the zip and VERIFY the digest — a mismatch aborts the sync.
 *   3. Extract the `.pi/skills/impeccable/` provider tree (upstream ships a
 *      Pi-family build — our engine's native layout) and REPLACE
 *      `packages/impeccable/skills/impeccable/` with it.
 *   4. Port patch (markdown only): upstream references scripts as
 *      `.pi/skills/impeccable/…` (workspace-relative); as a plugin the skill
 *      lives at `<pluginRoot>/skills/impeccable/`, so every occurrence becomes
 *      the house `<SKILL_DIR>/…` convention and SKILL.md gains a one-line
 *      path note after its frontmatter.
 *   5. Record provenance in `upstream.json` and bump the plugin patch version
 *      (bundled plugins only re-provision on a version change).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { conformSkillFrontmatter } from "./frontmatter";

const REPO = "pbakaus/impeccable";
const ASSET_NAME = "universal.zip";
const PROVIDER_PREFIX = ".pi/skills/impeccable/";
const PLUGIN_ROOT = join(import.meta.dir, "..");
const SKILL_DEST = join(PLUGIN_ROOT, "skills", "impeccable");
const UPSTREAM_FILE = join(PLUGIN_ROOT, "upstream.json");
const PATH_NOTE =
	"> **Path note (Dimension port):** `<SKILL_DIR>` = the directory of THIS SKILL.md — you see its resolved path when the skill loads; `scripts/` and `reference/` ship beside it. Substitute that absolute path when running commands.";

interface ReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
	readonly digest?: string;
}

interface Release {
	readonly tag_name: string;
	readonly assets: readonly ReleaseAsset[];
}

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url, { headers: { "user-agent": "dimension-impeccable-sync" } });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return res.json();
}

/** Minimal ZIP reader: end-of-central-directory -> central entries -> inflateRaw. */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
	// Locate EOCD (no zip64 needed: the asset is well under 4 GiB / 65k entries).
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_536); i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("EOCD signature not found — not a zip?");
	const entryCount = zip.readUInt16LE(eocd + 10);
	let offset = zip.readUInt32LE(eocd + 16);
	const entries = new Map<string, Buffer>();
	for (let n = 0; n < entryCount; n++) {
		if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central header at ${offset}`);
		const method = zip.readUInt16LE(offset + 10);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const localOffset = zip.readUInt32LE(offset + 42);
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		offset += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith("/")) continue; // directory row
		// Local header repeats name/extra lengths; data follows them.
		const localNameLength = zip.readUInt16LE(localOffset + 26);
		const localExtraLength = zip.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = zip.subarray(dataStart, dataStart + compressedSize);
		if (method === 0) entries.set(name, Buffer.from(raw));
		else if (method === 8) entries.set(name, inflateRawSync(raw));
		else throw new Error(`unsupported compression method ${method} for ${name}`);
	}
	return entries;
}

/** `.pi/skills/impeccable/…` -> `<SKILL_DIR>/…` in markdown, + the path note in SKILL.md. */
function portMarkdown(name: string, text: string): string {
	let out = text.replaceAll(PROVIDER_PREFIX, "<SKILL_DIR>/");
	if (name === "SKILL.md") out = conformSkillFrontmatter(out);
	if (name === "SKILL.md" && !out.includes("Path note (Dimension port)")) {
		const close = out.indexOf("\n---", out.indexOf("---") + 3);
		if (close >= 0) {
			const insertAt = out.indexOf("\n", close + 1) + 1;
			out = `${out.slice(0, insertAt)}\n${PATH_NOTE}\n${out.slice(insertAt)}`;
		}
	}
	return out;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const requestedTag = args.find(arg => !arg.startsWith("--"));

const releaseUrl = requestedTag
	? `https://api.github.com/repos/${REPO}/releases/tags/${requestedTag}`
	: `https://api.github.com/repos/${REPO}/releases/latest`;
const release = (await fetchJson(releaseUrl)) as Release;
const asset = release.assets.find(entry => entry.name === ASSET_NAME);
if (!asset) throw new Error(`release ${release.tag_name} has no ${ASSET_NAME} asset`);

const current = existsSync(UPSTREAM_FILE) ? (JSON.parse(readFileSync(UPSTREAM_FILE, "utf8")) as { tag?: string }) : {};
if (checkOnly) {
	const drift =
		current.tag === release.tag_name
			? "in sync"
			: `DRIFT: local ${current.tag ?? "<none>"} vs upstream ${release.tag_name}`;
	console.log(`impeccable: ${drift}`);
	process.exit(current.tag === release.tag_name ? 0 : 1);
}
if (current.tag === release.tag_name) {
	console.log(
		`impeccable: already at ${release.tag_name} — nothing to do (pass a tag to force a re-sync of another version).`,
	);
	process.exit(0);
}

console.log(`impeccable: syncing ${current.tag ?? "<none>"} -> ${release.tag_name}`);
const res = await fetch(asset.browser_download_url, { headers: { "user-agent": "dimension-impeccable-sync" } });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const sha256 = createHash("sha256").update(zip).digest("hex");
const published = asset.digest?.replace(/^sha256:/, "");
if (published && sha256 !== published) {
	throw new Error(`sha256 mismatch: downloaded ${sha256}, release says ${published} — ABORTING`);
}

const entries = readZipEntries(zip);
const skillEntries = [...entries.entries()].filter(([name]) => name.startsWith(PROVIDER_PREFIX));
if (skillEntries.length === 0) throw new Error(`no ${PROVIDER_PREFIX} entries in ${ASSET_NAME}`);

rmSync(SKILL_DEST, { recursive: true, force: true });
let ported = 0;
for (const [name, data] of skillEntries) {
	const relative = name.slice(PROVIDER_PREFIX.length);
	const target = join(SKILL_DEST, relative);
	mkdirSync(dirname(target), { recursive: true });
	if (relative.endsWith(".md")) {
		const before = data.toString("utf8");
		const after = portMarkdown(relative.split("/").pop() ?? relative, before);
		if (after !== before) ported++;
		writeFileSync(target, after);
	} else {
		writeFileSync(target, data);
	}
}

const version = release.tag_name.replace(/^skill-v/, "");
writeFileSync(
	UPSTREAM_FILE,
	`${JSON.stringify(
		{
			repo: REPO,
			tag: release.tag_name,
			version,
			asset: ASSET_NAME,
			sha256,
			provider: ".pi",
			syncedAt: new Date().toISOString(),
		},
		null,
		"\t",
	)}\n`,
);

// Track the upstream skill version directly; bundled plugins re-provision on
// any version change, so the sync itself is the bump.
for (const file of ["package.json", "plugin.json"]) {
	const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, file), "utf8")) as { version: string };
	manifest.version = version;
	writeFileSync(join(PLUGIN_ROOT, file), `${JSON.stringify(manifest, null, "\t")}\n`);
}

console.log(
	`impeccable: ${skillEntries.length} files at ${release.tag_name} (sha256 ${sha256.slice(0, 12)}…), ${ported} markdown files path-ported, plugin version -> ${version}`,
);
