import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "@oh-my-pi/pi-utils";

const GATE = "dopamine-debt";
const NEW_FILM = path.join("framework", "kit", "new-film");
const HOST_NAMES = ["inso", "omp"];
const RUNTIME_NAMES = ["bun", "node"];
const SHELL_SCRIPT = /\.(cmd|bat|ps1)$/i;
const GATE_ARGS = ["dd", "gate", "{stage}", "{production}", "{report}"];

interface GateEntry {
	readonly name: unknown;
	readonly command?: unknown;
	readonly args?: unknown;
	readonly exclude?: unknown;
}

function fail(message: string): number {
	process.stderr.write(`${message}\n`);
	return 2;
}

function hostCli(): string | undefined {
	const execPath = process.execPath;
	if (!RUNTIME_NAMES.includes(path.basename(execPath).toLowerCase().replace(/\.exe$/, ""))) return execPath;
	return HOST_NAMES.map(name => Bun.which(name)).find((found): found is string => !!found);
}

function isGate(gate: unknown): gate is GateEntry {
	return !!gate && typeof gate === "object" && "name" in gate && gate.name === GATE;
}

export function runSetup(argv: string[], cwd: string): number {
	const [target] = argv;
	if (!target) return fail("usage: inso dd setup <brand folder | productions folder>");
	const resolved = path.resolve(cwd, target);
	const productions = path.basename(resolved) === "productions" ? resolved : path.join(resolved, "productions");
	const host = hostCli();
	if (!host) return fail(`dd setup: no Dimension CLI (${HOST_NAMES.join(" or ")}) is on PATH to run the gate; run this command as \`inso dd setup\``);
	if (SHELL_SCRIPT.test(host)) return fail(`dd setup: ${host} is a script shim, which the house gate cannot start without a shell; run this command as \`inso dd setup\` from the installed app`);
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
	const kept = gates.find(isGate);
	const gate = {
		name: GATE,
		stages: ["script", "cut"],
		command: host,
		args: GATE_ARGS,
		exclude: kept && Array.isArray(kept.exclude) ? kept.exclude : [],
	};
	mkdirSync(productions, { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify({ gates: [...gates.filter(other => !isGate(other)), gate] }, null, "\t")}\n`);
	if (kept && Array.isArray(kept.args) && kept.args.some(arg => typeof arg === "string" && path.basename(arg) === "launch.ts"))
		process.stdout.write(`dd setup: replaced the earlier gate entry (${[kept.command, ...kept.args].map(String).join(" ")}), which ran a launcher inside one installed version of the kit\n`);
	process.stdout.write(`dd setup: wrote ${file} (gate: ${host} ${GATE_ARGS.join(" ")})\n`);
	return 0;
}

export function runNewFilm(argv: string[], pluginRoot: string, cwd: string): number {
	const [target, revision] = argv;
	if (!target) return fail("usage: inso dd new-film <production folder> [<film>/<rev>]");
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
		const text = readFileSync(path.join(templates, name), "utf8").replaceAll("__FILM__", film).replaceAll("__REV__", rev).replaceAll("__SLUG__", slug);
		writeFileAtomicSync(path.join(build, name), text);
	}
	process.stdout.write(`dd new-film: wrote ${names.join(", ")} in ${build} (revision ${film}/${rev}); next: python timeline.py there\n`);
	return 0;
}
