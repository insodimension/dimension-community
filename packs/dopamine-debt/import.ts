import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "@oh-my-pi/pi-utils";

const USAGE = "usage: inso dd import <earlier kit folder> <brand folder | productions folder>";
const MADE_FOR_THIS_FILM = "made for this film";
const PERSONA_KINDS = ["channel", "topic"];
const EARLIER_MARKS = path.join("calibration", "inso-marks.jsonl");
const MARKS = path.join("calibration", "marks.jsonl");
const LEDGER_ABOUT =
	"Music beds you have ruled on. A film's bed passes the music-approved rule only when its file's sha256 is in `approved`: either after your own yes for that track (`yes`), or a bed the Filmmaker made for one film (`approved_by: \"made for this film\"` with `film`: the production id it counts for, and for no other film), which you judge by ear in the render. Every entry names its licence. `references` are beds you praised inside a film, kept as listening references; they are not approvals. `rejected` beds fail with what you said (`said`), even when they are also in `approved`.";

type Row = Record<string, unknown>;

interface Ledger {
	readonly approved: Row[];
	readonly references: Row[];
	readonly rejected: Row[];
}

function fail(message: string): number {
	process.stderr.write(`${message}\n`);
	return 2;
}

function rows(value: unknown): Row[] {
	return Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object" && !Array.isArray(row)) : [];
}

function renamed(row: Row, from: string, to: string): Row {
	if (!(from in row)) return row;
	const { [from]: moved, ...rest } = row;
	return { ...rest, [to]: moved };
}

function convertLedger(earlier: unknown): Ledger & { readonly about: string } {
	const source = earlier && typeof earlier === "object" ? (earlier as Row) : {};
	const approved = rows(source.approved).map(row => {
		const withYes = renamed(row, "inso", "yes");
		return typeof withYes.approved_by === "string" && withYes.approved_by.startsWith("standing ruling") ? { ...withYes, approved_by: MADE_FOR_THIS_FILM } : withYes;
	});
	const references = rows(source.references).map(row => renamed(row, "inso", "praised"));
	const rejected = rows(source.rejected).map(row => renamed(row, "inso", "said"));
	return { about: LEDGER_ABOUT, approved, references, rejected };
}

function copyOnce(from: string, to: string, report: string[]): void {
	if (existsSync(to)) {
		const same = readFileSync(from).equals(readFileSync(to));
		report.push(same ? `kept ${to} (already the same)` : `kept ${to}: it already exists and differs from ${from}; merge it by hand`);
		return;
	}
	mkdirSync(path.dirname(to), { recursive: true });
	copyFileSync(from, to);
	report.push(`copied ${from} -> ${to}`);
}

export function runImport(argv: string[], cwd: string): number {
	const [kitArg, brandArg] = argv;
	if (!kitArg || !brandArg) return fail(USAGE);
	const kit = path.resolve(cwd, kitArg);
	if (!existsSync(path.join(kit, "taste.json"))) return fail(`dd import: ${kit} is not a Dopamine Debt kit folder (it has no taste.json)`);
	const resolved = path.resolve(cwd, brandArg);
	const productions = path.basename(resolved) === "productions" ? resolved : path.join(resolved, "productions");
	const brand = path.join(productions, "dopamine-debt");
	const report: string[] = [];

	const earlierLedger = path.join(kit, "music.json");
	const ledger = path.join(brand, "music.json");
	if (!existsSync(earlierLedger)) report.push(`no music ledger in ${kit}`);
	else if (existsSync(ledger)) report.push(`kept ${ledger}: it already exists; nothing from ${earlierLedger} was written`);
	else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(earlierLedger, "utf8"));
		} catch {
			return fail(`dd import: ${earlierLedger} is not valid JSON`);
		}
		const converted = convertLedger(parsed);
		mkdirSync(brand, { recursive: true });
		writeFileAtomicSync(ledger, `${JSON.stringify(converted, null, 1)}\n`);
		report.push(`wrote ${ledger} (${converted.approved.length} approved, ${converted.references.length} references, ${converted.rejected.length} rejected)`);
	}

	const earlierMarks = path.join(kit, EARLIER_MARKS);
	if (existsSync(earlierMarks)) copyOnce(earlierMarks, path.join(brand, MARKS), report);
	else report.push(`no marks ledger at ${earlierMarks}`);

	for (const kind of PERSONA_KINDS) {
		const dir = path.join(kit, "personas", kind);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).filter(file => file.endsWith(".md")).sort()) copyOnce(path.join(dir, name), path.join(brand, "personas", kind, name), report);
	}

	process.stdout.write(`${report.map(line => `dd import: ${line}`).join("\n")}\n`);
	return 0;
}
