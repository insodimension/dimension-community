import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Runner,
	type RunResult,
	readConnectorKeys,
	reconcileEnv,
	resolvePython,
	summarizeDoctor,
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
		"SCRAPECREATORS_API_KEY=old",
		"",
	].join("\n");

	const after = reconcileEnv(
		before,
		{ SETUP_COMPLETE: "true", BROWSER_CONSENT: "false", FROM_BROWSER: "off", BSKY_APP_PASSWORD: "abcd efgh" },
		new Set(["SCRAPECREATORS_API_KEY"]),
	);

	expect(after).toBe(
		[
			"# my keys",
			"OPENAI_API_KEY=sk-mine",
			"BROWSER_CONSENT=false",
			"FROM_BROWSER=off",
			"SETUP_COMPLETE=true",
			'BSKY_APP_PASSWORD="abcd efgh"',
			"",
		].join("\n"),
	);
});

test("a real interpreter wins over the Store alias and an old Python on PATH", async () => {
	const { run } = scriptedRunner({
		"/usr/bin/python3 -c": { code: 1, stdout: "/usr/bin/python3\n3.11.9\n", stderr: "" },
		"/opt/py/python -c": { code: 0, stdout: "/opt/py/bin/python3.13\n3.13.2\n", stderr: "" },
	});
	const which = (name: string) =>
		({ python3: "/usr/bin/python3", python: "/opt/py/python" })[name as "python3" | "python"] ?? null;

	const python = await resolvePython(run, which, "linux");

	expect(python).toEqual({ path: "/opt/py/bin/python3.13", version: "3.13.2", source: "path" });
});

test("Windows installs are probed newest first and the WindowsApps alias that exits without running is skipped", async () => {
	const root = join(process.env.LOCALAPPDATA ?? "", "Python");
	await mkdir(join(root, "pythoncore-3.9-64"), { recursive: true });
	await mkdir(join(root, "pythoncore-3.14-64"), { recursive: true });
	const newest = join(root, "pythoncore-3.14-64", "python.exe");
	const { run, calls } = scriptedRunner({
		[`${newest} -c`]: { code: 0, stdout: `${newest}\r\n3.14.0\r\n`, stderr: "" },
	});

	const python = await resolvePython(
		run,
		() => "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
		"win32",
	);

	expect(python).toEqual({ path: newest, version: "3.14.0", source: "installed" });
	expect(calls[0]).toBe(`${newest} -c`);
});

test("with no Python 3.12+ anywhere, uv installs a managed one", async () => {
	const managed = "/home/me/.local/share/uv/python/cpython-3.12/bin/python3.12";
	let installed = false;
	const run: Runner = async (command, args) => {
		const line = [command, ...args].join(" ");
		if (line === "uv python install 3.12") {
			installed = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (line === "uv python find >=3.12") {
			return installed
				? { code: 0, stdout: `${managed}\n`, stderr: "" }
				: { code: 2, stdout: "", stderr: "not found" };
		}
		if (command === managed) return { code: 0, stdout: `${managed}\n3.12.7\n`, stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};

	const python = await resolvePython(run, name => (name === "uv" ? "uv" : null), "linux");

	expect(installed).toBe(true);
	expect(python).toEqual({ path: managed, version: "3.12.7", source: "uv" });
});

test("keys connected on the card reach the engine config, and a disconnected key is taken out again", async () => {
	const connectors = join(home, ".config", "dimension-last30days");
	const engine = join(home, ".config", "last30days");
	await mkdir(connectors, { recursive: true });
	await mkdir(engine, { recursive: true });
	await writeFile(join(engine, ".env"), "XAI_API_KEY=mine\n");
	await writeFile(join(connectors, "scrapecreators.json"), '{ "access": "sc-key" }\n');
	await writeFile(
		join(connectors, "bluesky.json"),
		'{ "handle": "@me.bsky.social", "access": "aaaa-bbbb-cccc-dddd" }\n',
	);

	const first = await writeEngineConfig(engine, await readConnectorKeys());

	expect(first.keys).toEqual(["SCRAPECREATORS_API_KEY", "BSKY_HANDLE", "BSKY_APP_PASSWORD"]);
	expect(await readFile(join(engine, ".env"), "utf-8")).toBe(
		[
			"XAI_API_KEY=mine",
			"SETUP_COMPLETE=true",
			"BROWSER_CONSENT=false",
			"FROM_BROWSER=off",
			"SCRAPECREATORS_API_KEY=sc-key",
			"BSKY_HANDLE=me.bsky.social",
			"BSKY_APP_PASSWORD=aaaa-bbbb-cccc-dddd",
			"",
		].join("\n"),
	);

	await rm(join(connectors, "scrapecreators.json"));
	const second = await writeEngineConfig(engine, await readConnectorKeys());

	expect(second.removed).toEqual(["SCRAPECREATORS_API_KEY"]);
	expect(await readFile(join(engine, ".env"), "utf-8")).not.toContain("SCRAPECREATORS_API_KEY");
	expect(await readFile(join(engine, ".env"), "utf-8")).toContain("XAI_API_KEY=mine");
});

test("the source report names what is live and how to cover each gap the Dimension way", () => {
	const lines = summarizeDoctor({
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

	expect(lines).toEqual([
		"Working: hackernews, reddit",
		"Turned on, not yet verified: bluesky",
		"Not working: polymarket (connection reset)",
		"Not covered: tiktok (needs a ScrapeCreators key: Capabilities, last30days, Connect, ScrapeCreators)",
		"Not covered: x (comes from the X plugin (x_posts_envelope), last 7 days only)",
		"Not covered: youtube (needs yt-dlp: Capabilities, last30days, Connect, Install)",
		"Optional extras, off: arxiv",
	]);
});
