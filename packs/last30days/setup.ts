import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
	options?: { readonly timeoutMs?: number; readonly cwd?: string },
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

export const runHidden: Runner = (command, args, options = {}) => {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const child = spawn(command, [...args], {
		windowsHide: true,
		shell: false,
		cwd: options.cwd ?? homedir(),
		stdio: ["ignore", "pipe", "pipe"],
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
	return promise;
};

const PYTHON_PROBE =
	"import sys;print(sys.executable);print('%d.%d.%d' % sys.version_info[:3]);raise SystemExit(0 if sys.version_info >= (3, 12) else 1)";
const PYTHON_NAMES = ["python3.14", "python3.13", "python3.12", "python3", "python"];
const UV_PYTHON_REQUEST = ">=3.12";

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
	const found = await run(uv, ["python", "find", "--managed-python", UV_PYTHON_REQUEST], { cwd: homedir() });
	const managedPath = found.stdout.trim().split(/\r?\n/).pop();
	if (found.code !== 0 || !managedPath) return null;
	const probed = await probePython(run, managedPath);
	return probed ? { ...probed, source: "uv" } : null;
}

export function pythonInstallHint(platform: NodeJS.Platform, hasUv: boolean): string {
	if (hasUv) return "uv python install 3.12";
	if (platform === "win32") return "winget install -e --id Python.Python.3.12 --scope user";
	if (platform === "darwin") return "brew install python@3.12";
	return "sudo apt-get install -y python3.12";
}

export const ENGINE_SETTINGS: Readonly<Record<string, string>> = {
	SETUP_COMPLETE: "true",
	BROWSER_CONSENT: "false",
	FROM_BROWSER: "off",
	LAST30DAYS_TRUST_PROJECT_CONFIG: "false",
};

const COPIED_KEY_NAMES: Readonly<Record<string, true>> = {
	SCRAPECREATORS_API_KEY: true,
	BSKY_HANDLE: true,
	BSKY_APP_PASSWORD: true,
};

function envLineKey(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return null;
	return trimmed
		.slice(0, trimmed.indexOf("="))
		.replace(/^export\s+/, "")
		.trim();
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
			lines.push(`${key}=${assign[key]}`);
			continue;
		}
		if (!remove.has(key)) lines.push(line);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const [key, value] of Object.entries(assign)) {
		if (!written.has(key)) lines.push(`${key}=${value}`);
	}
	return `${lines.join("\n")}\n`;
}

export interface ConnectorKeys {
	readonly scrapecreators: boolean;
	readonly bluesky: string | null;
	readonly refused: readonly string[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function isPrintableAscii(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && /^[\x20-\x7e]+$/.test(value);
}

export async function readConnectorKeys(
	dir: string = join(homedir(), ".config", "dimension-last30days"),
): Promise<ConnectorKeys> {
	const scrape = await readJson(join(dir, "scrapecreators.json"));
	const bluesky = await readJson(join(dir, "bluesky.json"));
	const refused = [
		...(scrape && !isPrintableAscii(scrape.access) ? ["ScrapeCreators API key"] : []),
		...(bluesky && !isPrintableAscii(bluesky.handle) ? ["Bluesky handle"] : []),
		...(bluesky && !isPrintableAscii(bluesky.access) ? ["Bluesky app password"] : []),
	];
	return {
		scrapecreators: Boolean(scrape) && isPrintableAscii(scrape?.access),
		bluesky:
			bluesky && isPrintableAscii(bluesky.handle) && isPrintableAscii(bluesky.access)
				? bluesky.handle.trim().replace(/^@/, "")
				: null,
		refused,
	};
}

export function engineConfigDir(): string | null {
	const override = process.env.LAST30DAYS_CONFIG_DIR;
	if (override === undefined) return join(homedir(), ".config", "last30days");
	return override === "" ? null : override;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const staging = `${path}.${process.pid}.tmp`;
	await writeFile(staging, content, { encoding: "utf-8", mode: 0o600 });
	await rename(staging, path);
}

export interface EngineConfigOutcome {
	readonly path: string;
	readonly removed: readonly string[];
}

export async function writeEngineConfig(configDir: string): Promise<EngineConfigOutcome> {
	const envPath = join(configDir, ".env");
	const managedPath = join(homedir(), ".config", "dimension-last30days", "managed-keys.json");
	const managed = await readJson(managedPath);
	const copied = Array.isArray(managed?.keys)
		? managed.keys.filter((key): key is string => typeof key === "string" && COPIED_KEY_NAMES[key] === true)
		: [];
	const current = await readFile(envPath, "utf-8").catch(() => "");
	const present = new Set(current.split(/\r?\n/).flatMap(line => envLineKey(line) ?? []));
	await writeAtomic(envPath, reconcileEnv(current, ENGINE_SETTINGS, new Set(copied)));
	await rm(managedPath, { force: true });
	return { path: envPath, removed: copied.filter(key => present.has(key)) };
}

export function environmentWarnings(env: NodeJS.ProcessEnv): string[] {
	return [
		...(env.FROM_BROWSER !== undefined ? ["FROM_BROWSER is set in this process"] : []),
		...(env.BROWSER_CONSENT !== undefined ? ["BROWSER_CONSENT is set in this process"] : []),
		...(env.LAST30DAYS_CONFIG_DIR === "" ? ["LAST30DAYS_CONFIG_DIR is empty, so no config file is read"] : []),
	];
}

export interface DoctorSource {
	readonly audit_state?: string;
	readonly detail?: string;
	readonly probe?: { readonly detail?: string };
	readonly status?: string;
}

export interface DoctorReport {
	readonly sources?: Readonly<Record<string, DoctorSource>>;
}

export type FixRoute = "x-plugin" | "yt-dlp" | "bluesky" | "scrapecreators" | "unconfigured";

export interface DoctorSummary {
	readonly working: readonly string[];
	readonly unverified: readonly string[];
	readonly notWorking: readonly { readonly name: string; readonly detail: string }[];
	readonly notCovered: readonly { readonly name: string; readonly fix: FixRoute }[];
	readonly extras: readonly string[];
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

const FIX_TEXT: Readonly<Record<FixRoute, string>> = {
	"x-plugin": "comes from the X plugin (x_posts_envelope), last 7 days only",
	"yt-dlp": "needs yt-dlp: Capabilities, last30days, Connect, Install",
	bluesky: "needs a Bluesky app password: Capabilities, last30days, Connect, Bluesky",
	scrapecreators: "needs a ScrapeCreators key: Capabilities, last30days, Connect, ScrapeCreators",
	unconfigured: "not configured",
};

function fixRoute(name: string): FixRoute {
	if (name === "x") return "x-plugin";
	if (name === "youtube") return "yt-dlp";
	if (name === "bluesky") return "bluesky";
	if (SCRAPECREATORS_SOURCES[name]) return "scrapecreators";
	return "unconfigured";
}

export function classifyDoctor(report: DoctorReport): DoctorSummary {
	const working: string[] = [];
	const unverified: string[] = [];
	const notWorking: { name: string; detail: string }[] = [];
	const notCovered: { name: string; fix: FixRoute }[] = [];
	const extras: string[] = [];
	for (const [name, source] of Object.entries(report.sources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		if (source.audit_state === "working") working.push(name);
		else if (source.audit_state === "not-working")
			notWorking.push({ name, detail: source.probe?.detail || source.detail || "probe failed" });
		else if (source.audit_state === "could-be-on" && source.status === "opt-in") extras.push(name);
		else if (source.audit_state === "could-be-on") notCovered.push({ name, fix: fixRoute(name) });
		else unverified.push(name);
	}
	return { working, unverified, notWorking, notCovered, extras };
}

export function renderDoctor(summary: DoctorSummary): string[] {
	return [
		`Working: ${summary.working.join(", ") || "none"}`,
		...(summary.unverified.length ? [`Turned on, not yet verified: ${summary.unverified.join(", ")}`] : []),
		...summary.notWorking.map(source => `Not working: ${source.name} (${source.detail})`),
		...summary.notCovered.map(source => `Not covered: ${source.name} (${FIX_TEXT[source.fix]})`),
		...(summary.extras.length ? [`Optional extras, off: ${summary.extras.join(", ")}`] : []),
	];
}
