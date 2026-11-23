import { join } from "node:path";
import { lockPlatform } from "../src/registry.js";

export const FIXTURES = join(import.meta.dir, "fixtures");

const PYTHON_PROBE = "import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3, 8) else 1)";

function pythonCandidates(): string[] {
	const fromEnvironment = process.env.VOICE_CLONE_TEST_PYTHON;
	const localAppData = process.env.LOCALAPPDATA;
	const installed = localAppData
		? ["Python/pythoncore-*/python.exe", "Programs/Python/Python3*/python.exe"].flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: localAppData, absolute: true })])
		: [];
	const conventional = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"];
	return [fromEnvironment, Bun.which("python3"), Bun.which("python"), ...installed, ...conventional].filter((candidate): candidate is string => Boolean(candidate));
}

function findPython(): string | undefined {
	for (const candidate of pythonCandidates()) {
		const probe = Bun.spawnSync([candidate, "-c", PYTHON_PROBE], { stdout: "pipe", stderr: "ignore" });
		const executable = probe.stdout.toString().trim();
		if (probe.exitCode === 0 && executable) return executable;
	}
	return undefined;
}

export const PYTHON = findPython();
export const HOST_LOCK = lockPlatform();
export const CAN_RUN_FAKE_PROCESSES = PYTHON !== undefined && HOST_LOCK !== undefined;

if (!CAN_RUN_FAKE_PROCESSES) {
	console.log("fake-process tests skipped: they need a working Python 3.8+ (set VOICE_CLONE_TEST_PYTHON) on Windows or Linux to host the fake worker and fake uv");
}

export function fakeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { ...process.env, PYTHONPATH: FIXTURES, PYTHONDONTWRITEBYTECODE: "1", ...extra };
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
