import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const GATE = "dopamine-debt";
const NEW_FILM = path.join("framework", "kit", "new-film");

function fail(message: string): number {
	process.stderr.write(`${message}\n`);
	return 2;
}

export function runSetup(argv: string[], pluginRoot: string, cwd: string): number {
	const [target] = argv;
	if (!target) return fail("usage: dd setup <brand folder | productions folder>");
	const resolved = path.resolve(cwd, target);
	const productions = path.basename(resolved) === "productions" ? resolved : path.join(resolved, "productions");
	const launch = path.join(pluginRoot, "gate", "launch.ts");
	if (!existsSync(launch)) return fail(`dd setup: the gate launcher is missing at ${launch}`);
	const bun = path.basename(process.execPath).toLowerCase().startsWith("bun") ? process.execPath : Bun.which("bun");
	if (!bun) return fail("dd setup: bun is not on PATH; install it from https://bun.sh");
	const file = path.join(productions, "house-gates.json");
	let gates: unknown[] = [];
	if (existsSync(file)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return fail(`dd setup: ${file} is not valid JSON`);
		}
		if (!parsed || typeof parsed !== "object" || !("gates" in parsed) || !Array.isArray(parsed.gates)) return fail(`dd setup: ${file} must be { "gates": [ ... ] }`);
		gates = parsed.gates;
	}
	const isGate = (gate: unknown): gate is { name: unknown; exclude?: unknown } => !!gate && typeof gate === "object" && "name" in gate && gate.name === GATE;
	const kept = gates.find(isGate);
	const gate = {
		name: GATE,
		stages: ["script", "cut"],
		command: bun,
		args: [launch, "{stage}", "{production}", "{report}"],
		exclude: kept && Array.isArray(kept.exclude) ? kept.exclude : [],
	};
	mkdirSync(productions, { recursive: true });
	writeFileSync(file, `${JSON.stringify({ gates: [...gates.filter(other => !isGate(other)), gate] }, null, "\t")}\n`);
	process.stdout.write(`dd setup: wrote ${file} (bun ${bun}, gate ${launch})\n`);
	return 0;
}

export function runNewFilm(argv: string[], pluginRoot: string, cwd: string): number {
	const [target, revision] = argv;
	if (!target) return fail("usage: dd new-film <production folder> [<film>/<rev>]");
	const production = path.resolve(cwd, target);
	const slug = path.basename(production);
	const [film, rev] = (revision ?? `${slug}/r1`).split("/");
	if (!film || !rev) return fail(`dd new-film: the revision must be <film>/<rev>, not "${revision}"`);
	const build = path.join(production, "build");
	const templates = path.join(pluginRoot, NEW_FILM);
	const names = readdirSync(templates);
	const taken = names.filter(name => existsSync(path.join(build, name)));
	if (taken.length) return fail(`dd new-film: ${build} already holds ${taken.join(", ")}; nothing was written`);
	mkdirSync(build, { recursive: true });
	for (const name of names) {
		const text = readFileSync(path.join(templates, name), "utf8").replaceAll("__DD__", pluginRoot).replaceAll("__FILM__", film).replaceAll("__REV__", rev).replaceAll("__SLUG__", slug);
		writeFileSync(path.join(build, name), text);
	}
	process.stdout.write(`dd new-film: wrote ${names.join(", ")} in ${build} (revision ${film}/${rev}); next: python timeline.py there\n`);
	return 0;
}
