import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyDoctor,
	environmentWarnings,
	type Runner,
	type RunResult,
	readConnectorKeys,
	reconcileEnv,
	resolvePython,
	writeEngineConfig,
} from "../setup";

const HOME_ENV = ["HOME", "USERPROFILE", "LAST30DAYS_PYTHON", "LOCALAPPDATA", "ProgramFiles"] as const;
let prior: Record<string, string | undefined> = {};
let home = "";

beforeEach(async () => {
	prior = Object.fromEntries(HOME_ENV.map(name => [name, process.env[name]]));
	home = await mkdtemp(join(tmpdir(), "last30days-setup-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.LAST30DAYS_PYTHON;
	process.env.LOCALAPPDATA = join(home, "AppData", "Local");
	process.env.ProgramFiles = join(home, "Program Files");
});

afterEach(async () => {
	for (const name of HOME_ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(home, { recursive: true, force: true });
});

function scriptedRunner(answers: Record<string, RunResult>): { run: Runner; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		run: async (command, args) => {
			const key = [command, ...args.filter(arg => !arg.startsWith("import sys"))].join(" ");
			calls.push(key);
			return answers[key] ?? { code: 9009, stdout: "", stderr: "" };
		},
	};
}

test("setup marks the engine configured, turns browser cookies off over a prior consent, and keeps the person's own lines", () => {
	const before = [
		"# my keys",
		"OPENAI_API_KEY=sk-mine",
		"BROWSER_CONSENT=true",
		"export FROM_BROWSER=chrome",
		"",
	].join("\n");

	const after = reconcileEnv(
		before,
		{ SETUP_COMPLETE: "true", BROWSER_CONSENT: "false", FROM_BROWSER: "off" },
		new Set(),
	);

	expect(after).toBe(
		[
			"# my keys",
			"OPENAI_API_KEY=sk-mine",
			"BROWSER_CONSENT=false",
			"FROM_BROWSER=off",
			"SETUP_COMPLETE=true",
			"",
		].join("\n"),
	);
});

test("a real interpreter wins over an old Python on PATH", async () => {
	const { run } = scriptedRunner({
		"/usr/bin/python3 -c": { code: 1, stdout: "/usr/bin/python3\n3.11.9\n", stderr: "" },
		"/opt/py/python -c": { code: 0, stdout: "/opt/py/bin/python3.13\n3.13.2\n", stderr: "" },
	});
	const which = (name: string) =>
		({ python3: "/usr/bin/python3", python: "/opt/py/python" })[name as "python3" | "python"] ?? null;

	const python = await resolvePython(run, which, "linux");

	expect(python).toEqual({ path: "/opt/py/bin/python3.13", version: "3.13.2", source: "path" });
});

test("Windows installs are probed newest first, Python312-style folders included, and the WindowsApps alias is skipped", async () => {
	const root = join(process.env.LOCALAPPDATA ?? "", "Programs", "Python");
	await mkdir(join(root, "Python39"), { recursive: true });
	await mkdir(join(root, "Python312"), { recursive: true });
	const newest = join(root, "Python312", "python.exe");
	const { run, calls } = scriptedRunner({
		[`${newest} -c`]: { code: 0, stdout: `${newest}\r\n3.12.7\r\n`, stderr: "" },
	});

	const python = await resolvePython(
		run,
		() => "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
		"win32",
	);

	expect(python).toEqual({ path: newest, version: "3.12.7", source: "installed" });
	expect(calls[0]).toBe(`${newest} -c`);
});

test("uv supplies a managed Python it already has, and never installs one by itself", async () => {
	const managed = "/home/me/.local/share/uv/python/cpython-3.12/bin/python3.12";
	const { run, calls } = scriptedRunner({
		"uv python find --managed-python >=3.12": { code: 0, stdout: `${managed}\n`, stderr: "" },
		[`${managed} -c`]: { code: 0, stdout: `${managed}\n3.12.7\n`, stderr: "" },
	});

	const python = await resolvePython(run, name => (name === "uv" ? "uv" : null), "linux");

	expect(python?.source).toBe("uv");
	expect(calls.some(call => call.includes("python install"))).toBe(false);
});

test("the engine config never holds the card's keys, and copies an older setup made are taken out", async () => {
	const connectors = join(home, ".config", "dimension-last30days");
	const engine = join(home, ".config", "last30days");
	await mkdir(connectors, { recursive: true });
	await mkdir(engine, { recursive: true });
	await writeFile(join(engine, ".env"), "XAI_API_KEY=mine\nSCRAPECREATORS_API_KEY=old-copy\nBSKY_HANDLE=me\n");
	await writeFile(join(connectors, "managed-keys.json"), '{"keys":["SCRAPECREATORS_API_KEY","BSKY_HANDLE"]}');

	const outcome = await writeEngineConfig(engine);

	const text = await readFile(join(engine, ".env"), "utf-8");
	expect(outcome.removed).toEqual(["SCRAPECREATORS_API_KEY", "BSKY_HANDLE"]);
	expect(text).toContain("XAI_API_KEY=mine");
	expect(text).toContain("BROWSER_CONSENT=false");
	expect(text).toContain("LAST30DAYS_TRUST_PROJECT_CONFIG=false");
	expect(text).not.toContain("SCRAPECREATORS_API_KEY");
	expect(text).not.toContain("BSKY_HANDLE");
});

test("a key with characters outside printable ASCII is refused and named", async () => {
	const connectors = join(home, ".config", "dimension-last30days");
	await mkdir(connectors, { recursive: true });
	await writeFile(join(connectors, "scrapecreators.json"), JSON.stringify({ access: "sc-key\nINJECTED=1" }));
	await writeFile(
		join(connectors, "bluesky.json"),
		JSON.stringify({ handle: "@me.bsky.social", access: "aaaa-bbbb" }),
	);

	const keys = await readConnectorKeys();

	expect(keys.scrapecreators).toBe(false);
	expect(keys.refused).toEqual(["ScrapeCreators API key"]);
	expect(keys.bluesky).toBe("me.bsky.social");
});

test("cookie-related settings in the process environment are flagged", () => {
	expect(environmentWarnings({ FROM_BROWSER: "chrome" })).toHaveLength(1);
	expect(environmentWarnings({ LAST30DAYS_CONFIG_DIR: "" })).toHaveLength(1);
	expect(environmentWarnings({})).toHaveLength(0);
});

test("every source lands in exactly one bucket, and every gap has a Dimension fix route", () => {
	const summary = classifyDoctor({
		sources: {
			reddit: { audit_state: "working", status: "ok" },
			hackernews: { audit_state: "working", status: "ok" },
			polymarket: { audit_state: "not-working", status: "ok", probe: { detail: "connection reset" } },
			x: { audit_state: "could-be-on", status: "unconfigured" },
			tiktok: { audit_state: "could-be-on", status: "unconfigured" },
			youtube: { audit_state: "could-be-on", status: "unconfigured" },
			arxiv: { audit_state: "could-be-on", status: "opt-in" },
			bluesky: { audit_state: "turned-on-unverified", status: "ok" },
		},
	});

	expect(summary.working).toEqual(["hackernews", "reddit"]);
	expect(summary.unverified).toEqual(["bluesky"]);
	expect(summary.notWorking.map(source => source.name)).toEqual(["polymarket"]);
	expect(Object.fromEntries(summary.notCovered.map(source => [source.name, source.fix]))).toEqual({
		tiktok: "scrapecreators",
		x: "x-plugin",
		youtube: "yt-dlp",
	});
	expect(summary.extras).toEqual(["arxiv"]);
});
