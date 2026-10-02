// "Everything else": the manifest keys the profile does not draw, kept as the
// YAML text the author wrote.
//
// The profile draws a handful of keys; a General Agent's manifest has many more
// (`capabilities.control`, `engine.profile`, `routing`, `loop`, `title`, …). The
// profile never rewrites what it does not draw: those keys travel through the
// draft as TEXT (`AgentDraft.extra`), are shown and edited as text, and are
// merged back into the written file line for line. This module never parses
// YAML — the page shares it and must not bundle a YAML parser — so it
// understands exactly the two levels a manifest has (section → key) and treats
// everything deeper as opaque text. The authority on whether the merged file is
// a valid General Agent is always `parseGeneralAgent`, run by the server before
// anything is written.
//
// SHARED by the page and the server. It imports only the pack's structural guard.
import { isRecord } from "./guards";

/** One top-level key of a YAML mapping, with the lines it owns. */
export interface Block {
	readonly key: string;
	/** Verbatim lines: the comments directly above the key, the key line, then
	 *  everything under it. No blank line at either edge. */
	readonly lines: readonly string[];
	/** What follows `key:` on its own line, comment stripped ("" when the value
	 *  starts on the next line, or is absent). */
	readonly inline: string;
	/** The keys of a block mapping (`key:` then indented `sub: value` lines), one
	 *  level down; `null` when the value is a scalar, a flow collection or a
	 *  sequence, whose inside this module does not read. */
	readonly children: readonly Block[] | null;
	/** Indent, in spaces, of the child key lines. */
	readonly childIndent: number;
}

export interface ParsedExtra {
	readonly blocks: readonly Block[];
	/** Non-comment lines that belong to no key (before the first one). */
	readonly stray: readonly string[];
}

const KEY_LINE = /^( *)("[^"]+"|'[^']+'|[A-Za-z0-9_][\w./-]*) *:(?: +(.*))?$/;

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function unquote(key: string): string {
	return key.startsWith('"') || key.startsWith("'") ? key.slice(1, -1) : key;
}

interface RawBlock {
	key: string;
	lines: string[];
	rest: string;
}

/** Split `lines` into the blocks whose key line sits at exactly `indent`. */
function splitLevel(lines: readonly string[], indent: number): { blocks: RawBlock[]; stray: string[] } {
	const blocks: RawBlock[] = [];
	const stray: string[] = [];
	let current: RawBlock | null = null;
	let pending: string[] = [];
	for (const line of lines) {
		const match = KEY_LINE.exec(line);
		if (match && (match[1] ?? "").length === indent) {
			current = { key: unquote(match[2] ?? ""), lines: [...pending, line], rest: match[3] ?? "" };
			pending = [];
			blocks.push(current);
		} else if (isBlank(line) || (line.trimStart().startsWith("#") && indentOf(line) <= indent)) {
			pending.push(line);
		} else if (current) {
			current.lines.push(...pending, line);
			pending = [];
		} else {
			stray.push(line);
			pending = [];
		}
	}
	for (const block of blocks) {
		while (block.lines.length > 0 && isBlank(block.lines[0] ?? "")) block.lines.shift();
		while (block.lines.length > 0 && isBlank(block.lines[block.lines.length - 1] ?? "")) block.lines.pop();
	}
	return { blocks, stray };
}

function describe(raw: RawBlock, depth: number): Block {
	const inline = raw.rest
		.replace(/^#.*$/, "")
		.replace(/\s+#.*$/, "")
		.trim();
	const keyAt = raw.lines.findIndex(line => {
		const match = KEY_LINE.exec(line);
		return match !== null && unquote(match[2] ?? "") === raw.key;
	});
	const body = raw.lines.slice(keyAt + 1);
	const first = body.find(line => !isBlank(line) && !line.trimStart().startsWith("#"));
	const base = { key: raw.key, lines: raw.lines, inline };
	if (depth > 0 || inline !== "") return { ...base, children: null, childIndent: 0 };
	if (first === undefined) return { ...base, children: [], childIndent: 2 };
	const childIndent = indentOf(first);
	// A sequence written at the key's own indent, or a block scalar, is not a mapping.
	if (childIndent === 0 || !KEY_LINE.test(first)) return { ...base, children: null, childIndent: 0 };
	return { ...base, children: splitLevel(body, childIndent).blocks.map(child => describe(child, 1)), childIndent };
}

/** Read `text` as the two-level mapping a manifest is. Never throws: what it
 *  cannot place is reported in `stray`; YAML itself is the server's to judge. */
export function parseExtra(text: string): ParsedExtra {
	const { blocks, stray } = splitLevel(text.replace(/\r\n?/g, "\n").split("\n"), 0);
	return { blocks: blocks.map(block => describe(block, 0)), stray };
}

/** Every path the text names: `key`, and `key.child` for a block mapping. */
export function extraPaths(blocks: readonly Block[]): Set<string> {
	const paths = new Set<string>();
	for (const block of blocks) {
		paths.add(block.key);
		for (const child of block.children ?? []) paths.add(`${block.key}.${child.key}`);
	}
	return paths;
}

/** `lines` moved from `from` spaces of indent to `to` — what lets one section
 *  hold the profile's keys (written at 2) and the author's (written at any depth). */
export function reindent(lines: readonly string[], from: number, to: number): string[] {
	return lines.map(line => (isBlank(line) ? "" : " ".repeat(to) + line.slice(Math.min(from, indentOf(line)))));
}

/** A block mapping's children as lines at `indent` spaces. */
export function childLines(block: Block, indent: number): string[] {
	return (block.children ?? []).flatMap(child => reindent(child.lines, block.childIndent, indent));
}

/**
 * Lay `patch` over `base`, path by path: a key the patch names replaces the
 * same key in `base` (a section merges child by child), the rest of `base` is
 * kept as written, and new keys are appended. Both are YAML mapping text.
 */
export function overlayExtra(base: string, patch: string): string {
	const target = parseExtra(base).blocks.map(block => ({ block, lines: [...block.lines] }));
	for (const incoming of parseExtra(patch).blocks) {
		const at = target.findIndex(entry => entry.block.key === incoming.key);
		const entry = target[at];
		if (entry === undefined) target.push({ block: incoming, lines: [...incoming.lines] });
		else if (entry.block.children === null || incoming.children === null) target[at] = { block: incoming, lines: [...incoming.lines] };
		else {
			// Section over section: child by key, everything at 2 spaces.
			const merged = new Map<string, string[]>();
			for (const child of entry.block.children) merged.set(child.key, reindent(child.lines, entry.block.childIndent, 2));
			for (const child of incoming.children) merged.set(child.key, reindent(child.lines, incoming.childIndent, 2));
			target[at] = { block: incoming, lines: [`${incoming.key}:`, ...[...merged.values()].flat()] };
		}
	}
	return target.map(entry => entry.lines.join("\n")).join("\n");
}

// ── what a proposal may not carry ───────────────────────────────────────────
//
// One rule, two readers. `grantPathsIn` reads TEXT — all the page can do, as it
// bundles no YAML parser — and so sees only the forms `parseExtra` places.
// `grantPathsInDocument` reads the PARSED document — what the engine reads, in
// whatever spelling the text used (flow mapping, explicit `? key`, anchored or
// tagged key) — and is the server's authority on a proposal. `forge_propose`
// runs both.

/** Sections every key of which grants something (an approval mode, a workspace). */
const GRANT_SECTIONS: Readonly<Record<string, true>> = { gate: true, workspace: true };
/** Sections that hold some grants and some harmless keys. */
const MIXED_SECTIONS: Readonly<Record<string, true>> = { capabilities: true, subagents: true };
/**
 * The manifest keys that GRANT — tool reach, approval, workspace reach, the
 * control lanes, plugins, MCP, delegation, harnesses (doc 58 §3; the flat
 * `tools` and `spawns` are the legacy spellings of two of them). Only a human
 * gesture on the profile sets these; the model's `forge_propose` never does.
 */
const GRANT_PATHS: Readonly<Record<string, true>> = {
	"capabilities.tools": true,
	"capabilities.mcp": true,
	"capabilities.plugins": true,
	"capabilities.control": true,
	"capabilities.optIn": true,
	"subagents.allowed": true,
	harness: true,
	allowedHarnesses: true,
	tools: true,
	spawns: true,
};

/**
 * The rule. Each top-level key comes with the keys under it: a list, or `null`
 * when a value is there that cannot be read key by key. A mixed section
 * (`capabilities`, `subagents`) with `null` counts as holding a grant — inline,
 * a flow mapping or explicit keys on the next line, a sequence — because the
 * keys it really names are unknown.
 */
function grantPathsOf(sections: Iterable<readonly [key: string, children: readonly string[] | null]>): string[] {
	const found: string[] = [];
	for (const [key, children] of sections) {
		if (Object.hasOwn(GRANT_SECTIONS, key) || Object.hasOwn(GRANT_PATHS, key)) found.push(key);
		else if (Object.hasOwn(MIXED_SECTIONS, key)) {
			if (children === null) found.push(`${key} (inline)`);
			else for (const child of children) if (Object.hasOwn(GRANT_PATHS, `${key}.${child}`)) found.push(`${key}.${child}`);
		}
	}
	return found;
}

/**
 * The grant-class paths `text` names. `parseExtra` gives a section
 * `children: null` exactly when something follows its key line that is not a
 * block mapping of `key: value` lines; an empty section, or one holding only
 * comments, has `[]`.
 */
export function grantPathsIn(text: string): string[] {
	return grantPathsOf(parseExtra(text).blocks.map(block => [block.key, block.children === null ? null : block.children.map(child => child.key)] as const));
}

/** The grant-class paths a PARSED document names — `grantPathsIn`'s verdict read off the keys the text resolves to, not the lines it was written in. */
export function grantPathsInDocument(document: unknown): string[] {
	if (!isRecord(document)) return [];
	return grantPathsOf(Object.entries(document).map(([key, value]) => [key, value === null || value === undefined ? [] : isRecord(value) ? Object.keys(value) : null] as const));
}
