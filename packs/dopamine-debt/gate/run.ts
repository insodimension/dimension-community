import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { JudgmentState } from "@oh-my-pi/pi-ai";
import { writeFileAtomic } from "@oh-my-pi/pi-utils";
import { type CellQuestion, type HostJudge, openHostJudge } from "./judge";

const STAGES = ["script", "cut"] as const;
type Stage = (typeof STAGES)[number];
const USAGE = "usage: inso dd gate <script|cut> <production> <report>";
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANNOT_RUN = 2;
const PYTHON_NAMES = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];

interface Report {
	pass: boolean;
	score?: number;
	blockers: { id: string; message: string }[];
	advisories: { id: string; message: string }[];
	missing?: string[];
	[extra: string]: unknown;
}

interface BridgeRequest {
	id: number;
	op: "judge" | "complete";
	items?: Record<string, JudgmentState>;
	questions?: Record<string, CellQuestion>;
	prompt?: string;
	model?: string;
	schema?: Record<string, unknown> | null;
}

function isStage(value: string | undefined): value is Stage {
	return value !== undefined && (STAGES as readonly string[]).includes(value);
}

async function writeReport(file: string, report: Report): Promise<void> {
	mkdirSync(path.dirname(file), { recursive: true });
	await writeFileAtomic(file, `${JSON.stringify(report, null, 1)}\n`);
}

async function cannotRun(file: string | undefined, missing: string[], extra: Record<string, unknown> = {}): Promise<number> {
	if (file) await writeReport(file, { pass: false, blockers: [], advisories: [], missing, ...extra });
	process.stderr.write(`dd gate cannot run: missing ${missing.join("; ")}\n`);
	return EXIT_CANNOT_RUN;
}

interface Python {
	exe: string;
	root: string;
	env: Record<string, string>;
}

function probePython(command: string[]): string | undefined {
	try {
		const probe = Bun.spawnSync([...command, "-c", "import sys; assert sys.version_info >= (3, 10); print(sys.executable)"], {
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		return probe.exitCode === 0 ? probe.stdout.toString().trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

function findPython(): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const isStoreAlias = (dir: string) => /[\\/]WindowsApps[\\/]?$/i.test(dir);
	const ordered = [...dirs.filter(dir => !isStoreAlias(dir)), ...dirs.filter(isStoreAlias)];
	const candidates = [process.env.DD_PYTHON, ...ordered.flatMap(dir => PYTHON_NAMES.map(name => path.join(dir, name)))];
	for (const candidate of candidates) {
		if (!candidate || !lstatSync(candidate, { throwIfNoEntry: false })) continue;
		const exe = probePython([candidate]);
		if (exe) return exe;
	}
	return process.platform === "win32" ? probePython(["cmd.exe", "/d", "/c", "python"]) : undefined;
}

function pythonFor(exe: string, root: string, engineHome: string): Python {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env.PYTHONUTF8 = "1";
	env.PYTHONIOENCODING = "utf-8";
	env.PYTHONDONTWRITEBYTECODE = "1";
	env.DD_ENGINE_HOME = engineHome;
	return { exe, root, env };
}

async function pythonCheck(python: Python, stage: Stage, production: string): Promise<string[]> {
	const proc = Bun.spawn([python.exe, "-m", "dd.house", "check", stage, production], {
		cwd: python.root,
		env: python.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) return [`a working dd prerequisite check (python exited ${code}: ${err.trim().split("\n").at(-1) ?? ""})`];
	const parsed: unknown = JSON.parse(out);
	if (parsed && typeof parsed === "object" && "missing" in parsed && Array.isArray(parsed.missing)) {
		return parsed.missing.map(String);
	}
	return [`a dd prerequisite check that answers {missing: [...]} (got ${out.trim().slice(0, 200)})`];
}

async function answer(judge: HostJudge, request: BridgeRequest): Promise<Record<string, unknown>> {
	try {
		if (request.op === "judge") {
			return { id: request.id, results: await judge.judgeItems(request.items ?? {}, request.questions ?? {}) };
		}
		const result = await judge.complete(request.prompt ?? "", request.model ?? "default", request.schema ?? undefined);
		return { id: request.id, ...result };
	} catch (error) {
		return { id: request.id, error: error instanceof Error ? error.message : String(error) };
	}
}

async function pythonRun(
	python: Python,
	stage: Stage,
	production: string,
	report: string,
	judge: HostJudge,
): Promise<{ code: number; stderr: string }> {
	const proc = Bun.spawn([python.exe, "-m", "dd.house", "run", stage, production, report], {
		cwd: python.root,
		env: python.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const stderrText = new Response(proc.stderr).text();
	const pending: Promise<void>[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of proc.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			const request = JSON.parse(line) as BridgeRequest;
			pending.push(
				answer(judge, request).then(reply => {
					proc.stdin.write(`${JSON.stringify(reply)}\n`);
					proc.stdin.flush();
				}),
			);
		}
	}
	await Promise.all(pending);
	proc.stdin.end();
	return { code: await proc.exited, stderr: await stderrText };
}

function judgeRecord(judge: HostJudge): Record<string, unknown> {
	return {
		role: "judge",
		agentDir: judge.agentDir,
		ownHome: judge.ownHome,
		primary: judge.primary ?? null,
		answered: Object.fromEntries(judge.answered),
		jurors: Object.fromEntries(judge.jurors),
	};
}

export async function runGate(argv: string[], pluginRoot: string): Promise<number> {
	const report = argv[2] ? path.resolve(argv[2]) : undefined;
	try {
		return await gate(argv, report, pluginRoot);
	} catch (error) {
		return cannotRun(report, [`a dd gate run that finishes (${error instanceof Error ? error.message : String(error)})`]);
	}
}

async function gate(argv: string[], report: string | undefined, pluginRoot: string): Promise<number> {
	const [stage, productionArg] = argv;
	if (!isStage(stage) || !productionArg || !report) {
		process.stderr.write(`${USAGE}\n`);
		return cannotRun(report, [`arguments (${USAGE})`]);
	}
	const production = path.resolve(productionArg);
	const engineHome = path.resolve(process.env.DD_ENGINE_HOME || process.env.INSO_HOME?.trim() || path.join(homedir(), ".inso"));
	const missing: string[] = [];
	const exe = findPython();
	const python = exe ? pythonFor(exe, pluginRoot, engineHome) : undefined;
	if (!python) missing.push("a working Python 3.10 or newer on PATH or in DD_PYTHON (the dd engine is Python)");
	else missing.push(...(await pythonCheck(python, stage, production)));
	let judge: HostJudge | undefined;
	try {
		judge = await openHostJudge(engineHome, existsSync(production) ? production : pluginRoot);
		if (!judge.primary) missing.push(`a judge model: the \`judge\` model role in ${judge.agentDir} resolves to no credentialed model`);
	} catch (error) {
		missing.push(`the judge role chain (${error instanceof Error ? error.message : String(error)})`);
	}
	try {
		if (missing.length > 0 || !python || !judge) {
			return await cannotRun(report, missing, judge ? { judge: judgeRecord(judge) } : {});
		}
		rmSync(report, { force: true });
		const run = await pythonRun(python, stage, production, report, judge);
		if (!existsSync(report)) {
			const last = run.stderr.trim().split("\n").at(-1) ?? "";
			return await cannotRun(report, [`a dd run that finishes (python exited ${run.code}: ${last})`], {
				judge: judgeRecord(judge),
			});
		}
		const written = (await Bun.file(report).json()) as Report;
		written.judge = judgeRecord(judge);
		await writeReport(report, written);
		if (written.missing?.length) {
			process.stderr.write(`dd gate cannot run: missing ${written.missing.join("; ")}\n`);
			return EXIT_CANNOT_RUN;
		}
		if (run.code === EXIT_PASS && written.pass === true) {
			process.stderr.write(`dd gate ${stage}: pass, score ${written.score ?? "n/a"}\n`);
			return EXIT_PASS;
		}
		if ((run.code === EXIT_FAIL || run.code === EXIT_PASS) && written.pass === false) {
			process.stderr.write(`dd gate ${stage}: fail, ${written.blockers.length} blocker(s), score ${written.score ?? "n/a"}\n`);
			return EXIT_FAIL;
		}
		return await cannotRun(report, [`a dd run whose exit code agrees with its report (python exited ${run.code}, report pass ${String(written.pass)})`], { judge: judgeRecord(judge) });
	} finally {
		judge?.close();
	}
}
