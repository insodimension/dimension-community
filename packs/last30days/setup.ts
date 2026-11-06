import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type Runner = (
	command: string,
	args: readonly string[],
	options?: { readonly input?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

export const runHidden: Runner = (command, args, options = {}) => {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const child = spawn(command, [...args], {
		windowsHide: true,
		shell: false,
		env: options.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	child.stdout.on("data", chunk => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", chunk => {
		stderr += chunk.toString();
	});
	child.on("error", error => {
		clearTimeout(timer);
		resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
	});
	child.on("close", code => {
		clearTimeout(timer);
		resolve({ code, stdout, stderr });
	});
	child.stdin.end(options.input ?? "");
	return promise;
};

const PYTHON_PROBE =
	"import sys;print(sys.executable);print('%d.%d.%d' % sys.version_info[:3]);raise SystemExit(0 if sys.version_info >= (3, 12) else 1)";
const PYTHON_NAMES = ["python3.14", "python3.13", "python3.12", "python3", "python"];
const UV_PYTHON_REQUEST = ">=3.12";
const UV_INSTALL_VERSION = "3.12";
const UV_INSTALL_TIMEOUT_MS = 300_000;

export interface ResolvedPython {
	readonly path: string;
	readonly version: string;
	readonly source: "env" | "installed" | "path" | "uv";
}

function versionOrder(name: string): [number, number] {
	const match = /(\d)\.?(\d{1,2})/.exec(name);
	return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

async function windowsInstallCandidates(): Promise<string[]> {
	const roots = [
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Python") : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Python") : undefined,
		process.env.ProgramFiles,
	].filter((root): root is string => Boolean(root));
	const found: string[] = [];
	for (const root of roots) {
		const entries = await readdir(root).catch(() => [] as string[]);
		const pythons = entries
			.filter(entry => /python/i.test(entry))
			.sort((a, b) => {
				const [aMajor, aMinor] = versionOrder(a);
				const [bMajor, bMinor] = versionOrder(b);
				return bMajor - aMajor || bMinor - aMinor || b.localeCompare(a);
			});
		for (const entry of pythons) found.push(join(root, entry, "python.exe"));
	}
	return found;
}

async function probePython(run: Runner, command: string): Promise<{ path: string; version: string } | null> {
	const result = await run(command, ["-c", PYTHON_PROBE], { timeoutMs: 15_000 });
	if (result.code !== 0) return null;
	const [path, version] = result.stdout.trim().split(/\r?\n/);
	return path && version ? { path: path.trim(), version: version.trim() } : null;
}

export async function resolvePython(
	run: Runner,
	which: (name: string) => string | null,
	platform: NodeJS.Platform = process.platform,
): Promise<ResolvedPython | null> {
	const pinned = process.env.LAST30DAYS_PYTHON;
	if (pinned) {
		const probed = await probePython(run, pinned);
		if (probed) return { ...probed, source: "env" };
	}
	const installed = platform === "win32" ? await windowsInstallCandidates() : [];
	for (const candidate of installed) {
		const probed = await probePython(run, candidate);
		if (probed) return { ...probed, source: "installed" };
	}
	for (const name of PYTHON_NAMES) {
		const onPath = which(name);
		if (!onPath) continue;
		const probed = await probePython(run, onPath);
		if (probed) return { ...probed, source: "path" };
	}
	const uv = which("uv");
	if (!uv) return null;
	const found = await run(uv, ["python", "find", UV_PYTHON_REQUEST]);
	if (found.code !== 0) {
		const install = await run(uv, ["python", "install", UV_INSTALL_VERSION], { timeoutMs: UV_INSTALL_TIMEOUT_MS });
		if (install.code !== 0) return null;
	}
	const managed = found.code === 0 ? found : await run(uv, ["python", "find", UV_PYTHON_REQUEST]);
	const managedPath = managed.stdout.trim().split(/\r?\n/).pop();
	if (managed.code !== 0 || !managedPath) return null;
	const probed = await probePython(run, managedPath);
	return probed ? { ...probed, source: "uv" } : null;
}

export function pythonInstallHint(platform: NodeJS.Platform): string {
	if (platform === "win32") return "winget install -e --id Python.Python.3.12 --scope user";
	if (platform === "darwin") return "brew install python@3.12";
	return "sudo apt-get install -y python3.12 (or install uv, which provides its own Python)";
}

export const ENGINE_SETTINGS: Readonly<Record<string, string>> = {
	SETUP_COMPLETE: "true",
	BROWSER_CONSENT: "false",
	FROM_BROWSER: "off",
};

function envLineKey(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return null;
	return trimmed
		.slice(0, trimmed.indexOf("="))
		.replace(/^export\s+/, "")
		.trim();
}

export function formatEnvValue(value: string): string {
	const flat = value.replace(/\r/g, "").replace(/\n/g, " ");
	if (flat && !/^['"]/.test(flat) && !/\s/.test(flat)) return flat;
	if (!flat.includes('"')) return `"${flat}"`;
	if (!flat.includes("'")) return `'${flat}'`;
	return flat;
}

export function reconcileEnv(
	text: string,
	assign: Readonly<Record<string, string>>,
	remove: ReadonlySet<string>,
): string {
	const written = new Set<string>();
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const key = envLineKey(line);
		if (key === null) {
			lines.push(line);
			continue;
		}
		if (key in assign) {
			if (written.has(key)) continue;
			written.add(key);
			lines.push(`${key}=${formatEnvValue(assign[key] ?? "")}`);
			continue;
		}
		if (!remove.has(key)) lines.push(line);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const [key, value] of Object.entries(assign)) {
		if (!written.has(key)) lines.push(`${key}=${formatEnvValue(value)}`);
	}
	return `${lines.join("\n")}\n`;
}

export interface ConnectorKeys {
	readonly scrapecreators: string | null;
	readonly bluesky: { readonly handle: string; readonly appPassword: string } | null;
}

export function connectorDir(): string {
	return join(homedir(), ".config", "dimension-last30days");
}

export function engineConfigDir(): string | null {
	const override = process.env.LAST30DAYS_CONFIG_DIR;
	if (override === undefined) return join(homedir(), ".config", "last30days");
	return override === "" ? null : override;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readConnectorKeys(dir: string = connectorDir()): Promise<ConnectorKeys> {
	const scrape = await readJson(join(dir, "scrapecreators.json"));
	const bluesky = await readJson(join(dir, "bluesky.json"));
	const handle = nonEmpty(bluesky?.handle)?.replace(/^@/, "");
	const appPassword = nonEmpty(bluesky?.access);
	return {
		scrapecreators: nonEmpty(scrape?.access),
		bluesky: handle && appPassword ? { handle, appPassword } : null,
	};
}

const MANAGED_KEYS_FILE = "managed-keys.json";

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const staging = `${path}.${process.pid}.tmp`;
	await writeFile(staging, content, { encoding: "utf-8", mode: 0o600 });
	await rename(staging, path);
}

export interface EngineConfigOutcome {
	readonly path: string;
	readonly keys: readonly string[];
	readonly removed: readonly string[];
}

export async function writeEngineConfig(configDir: string, keys: ConnectorKeys): Promise<EngineConfigOutcome> {
	const envPath = join(configDir, ".env");
	const managedPath = join(connectorDir(), MANAGED_KEYS_FILE);
	const connectorValues: Record<string, string> = {
		...(keys.scrapecreators ? { SCRAPECREATORS_API_KEY: keys.scrapecreators } : {}),
		...(keys.bluesky ? { BSKY_HANDLE: keys.bluesky.handle, BSKY_APP_PASSWORD: keys.bluesky.appPassword } : {}),
	};
	const previouslyManaged = await readJson(managedPath);
	const previousKeys = Array.isArray(previouslyManaged?.keys)
		? previouslyManaged.keys.filter((key): key is string => typeof key === "string")
		: [];
	const removed = previousKeys.filter(key => !(key in connectorValues));
	const current = await readFile(envPath, "utf-8").catch(() => "");
	await writeAtomic(envPath, reconcileEnv(current, { ...ENGINE_SETTINGS, ...connectorValues }, new Set(removed)));
	await writeAtomic(managedPath, `${JSON.stringify({ keys: Object.keys(connectorValues) })}\n`);
	return { path: envPath, keys: Object.keys(connectorValues), removed };
}

export interface DoctorSource {
	readonly audit_state?: string;
	readonly detail?: string;
	readonly probe?: { readonly detail?: string };
	readonly status?: string;
}

export interface DoctorReport {
	readonly sources?: Readonly<Record<string, DoctorSource>>;
	readonly engine_version?: string;
}

const SCRAPECREATORS_SOURCES: Readonly<Record<string, true>> = {
	tiktok: true,
	instagram: true,
	threads: true,
	pinterest: true,
	linkedin: true,
	meta_ads: true,
	telegram: true,
};

function notCoveredFix(name: string, source: DoctorSource): string | null {
	if (name === "x") return "comes from the X plugin (x_posts_envelope), last 7 days only";
	if (name === "youtube") return "needs yt-dlp: Capabilities, last30days, Connect, Install";
	if (name === "bluesky") return "needs a Bluesky app password: Capabilities, last30days, Connect, Bluesky";
	if (SCRAPECREATORS_SOURCES[name])
		return "needs a ScrapeCreators key: Capabilities, last30days, Connect, ScrapeCreators";
	return source.status === "opt-in" ? null : "not configured";
}

export function summarizeDoctor(report: DoctorReport): string[] {
	const working: string[] = [];
	const unverified: string[] = [];
	const extras: string[] = [];
	const problems: string[] = [];
	for (const [name, source] of Object.entries(report.sources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		if (source.audit_state === "working") {
			working.push(name);
		} else if (source.audit_state === "not-working") {
			problems.push(`Not working: ${name} (${source.probe?.detail || source.detail || "probe failed"})`);
		} else if (source.audit_state === "could-be-on") {
			const fix = notCoveredFix(name, source);
			if (fix) problems.push(`Not covered: ${name} (${fix})`);
			else extras.push(name);
		} else {
			unverified.push(name);
		}
	}
	return [
		`Working: ${working.join(", ") || "none"}`,
		...(unverified.length ? [`Turned on, not yet verified: ${unverified.join(", ")}`] : []),
		...problems,
		...(extras.length ? [`Optional extras, off: ${extras.join(", ")}`] : []),
	];
}
