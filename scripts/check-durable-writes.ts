#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Allowance {
	readonly count: number;
	readonly why: string;
}

export type Allowlist = Record<string, Allowance>;

export interface DurableWriteDrift {
	readonly file: string;
	readonly found: number;
	readonly allowed: number;
}

export interface DurableWriteReport {
	readonly counts: ReadonlyMap<string, number>;
	readonly drift: readonly DurableWriteDrift[];
	readonly unexplained: readonly string[];
}

const SHELF_ROOT = resolve(import.meta.dir, "..");
const ALLOWLIST_PATH = join(import.meta.dir, "durable-writes.allow.json");
const PACK_SOURCE = "packs/*/**/*.{ts,tsx,mts,cts,js,mjs,cjs}";
const NOT_RUNTIME_SOURCE =
	/(^|\/)(node_modules|test|tests|scripts|bench|harness|dist|app|third-party|relay-extension|python|patches|\.cache)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const RAW_WRITE =
	/\bwriteFileSync\s*\(|\bBun\.write\s*\(|\.writeFile\s*\(|(?<![\w.$])writeFile\s*\(|\brenameSync\s*\(|\b(?:fs|fsp|promises|fs\.promises)\.rename\s*\(|(?<![\w.$])rename\s*\(/g;
const NOT_A_CALL =
	/^\s*(?:\/\/|\*|\/\*)|\bfunction\s+(?:writeFile|rename)\s*\(|^\s*(?:writeFile|rename)\s*\([^)]*\)\s*:|^\s*(?:async\s+)?(?:writeFile|rename)\s*\([^)]*\)\s*\{/;

function countRawWrites(source: string): number {
	let found = 0;
	for (const line of source.split("\n")) {
		if (!NOT_A_CALL.test(line)) found += line.match(RAW_WRITE)?.length ?? 0;
	}
	return found;
}

export function scanRawWrites(root: string = SHELF_ROOT): Map<string, number> {
	const counts = new Map<string, number>();
	for (const relative of new Bun.Glob(PACK_SOURCE).scanSync({ cwd: root })) {
		const file = relative.replaceAll("\\", "/");
		if (NOT_RUNTIME_SOURCE.test(file)) continue;
		const found = countRawWrites(readFileSync(join(root, file), "utf8"));
		if (found > 0) counts.set(file, found);
	}
	return counts;
}

export function readAllowlist(file: string = ALLOWLIST_PATH): Allowlist {
	return JSON.parse(readFileSync(file, "utf8")) as Allowlist;
}

export function compareWithAllowlist(counts: ReadonlyMap<string, number>, allowlist: Allowlist): DurableWriteReport {
	const drift: DurableWriteDrift[] = [];
	const unexplained: string[] = [];
	for (const file of new Set([...counts.keys(), ...Object.keys(allowlist)])) {
		const found = counts.get(file) ?? 0;
		const allowance = allowlist[file];
		const allowed = allowance?.count ?? 0;
		if (found !== allowed) drift.push({ file, found, allowed });
		if (allowance !== undefined && allowance.why.trim().length === 0) unexplained.push(file);
	}
	drift.sort((left, right) => left.file.localeCompare(right.file));
	return { counts, drift, unexplained };
}

function describeDrift({ file, found, allowed }: DurableWriteDrift): string {
	if (found > allowed) {
		return `${file}: ${found} raw writes, ${allowed} allowed. Write pack state through writeFileAtomic/writeFileAtomicSync from lib/durable-file.mjs, or add an allowance with the reason this file is not durable state.`;
	}
	return `${file}: ${found} raw writes, ${allowed} allowed. Lower the allowance to ${found} in scripts/durable-writes.allow.json${found === 0 ? " (remove the entry)" : ""}.`;
}

if (import.meta.main) {
	const report = compareWithAllowlist(scanRawWrites(), readAllowlist());
	for (const file of report.unexplained) console.error(`${file}: allowance has no reason`);
	for (const entry of report.drift) console.error(describeDrift(entry));
	if (report.drift.length > 0 || report.unexplained.length > 0) process.exit(1);
	console.log(`durable writes: ${report.counts.size} pack files with raw writes, all within their allowance`);
}
