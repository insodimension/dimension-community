import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";

const HOSTS = ["inso", "omp"];
const [stage, production, reportArg] = process.argv.slice(2);
const report = reportArg ? path.resolve(reportArg) : undefined;

async function cannotRun(missing: string[]): Promise<never> {
	if (report) {
		mkdirSync(path.dirname(report), { recursive: true });
		await Bun.write(report, `${JSON.stringify({ pass: false, blockers: [], advisories: [], missing }, null, 1)}\n`);
	}
	process.stderr.write(`dd gate cannot run: missing ${missing.join("; ")}\n`);
	process.exit(2);
}

async function readReport(): Promise<{ pass?: unknown; missing?: unknown } | undefined> {
	if (!report || !existsSync(report)) return undefined;
	try {
		const parsed: unknown = await Bun.file(report).json();
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const host = HOSTS.map(name => Bun.which(name)).find(Boolean);
if (!host) await cannotRun([`a Dimension CLI on PATH (${HOSTS.join(" or ")}) to host the judge`]);
const child = Bun.spawn([host as string, "dd", "gate", ...process.argv.slice(2)], {
	env: { ...process.env, INSO_WORKTREE_PRUNE: "0" },
	stdin: "ignore",
	stdout: "inherit",
	stderr: "pipe",
	windowsHide: true,
});
let verdict = "";
let tail = "";
const decoder = new TextDecoder();
for await (const chunk of child.stderr) {
	const text = decoder.decode(chunk, { stream: true });
	process.stderr.write(text);
	const lines = (tail + text).split(/\r?\n/);
	tail = lines.pop() ?? "";
	for (const line of lines) if (line.startsWith("dd gate")) verdict = line;
}
if (tail.startsWith("dd gate")) verdict = tail;
const code = await child.exited;
const written = await readReport();
const consistent =
	written !== undefined &&
	((code === 0 && written.pass === true) ||
		(code === 1 && written.pass === false && !(Array.isArray(written.missing) && written.missing.length > 0)) ||
		(code === 2 && Array.isArray(written.missing)));
if (!stage || !production || !consistent) {
	await cannotRun([`a dd gate run that writes its report (${path.basename(host as string)} exited ${code}${verdict ? `: ${verdict}` : ""})`]);
}
process.stderr.write(`${verdict}\n`);
process.exit(code);
