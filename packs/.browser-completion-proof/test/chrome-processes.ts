/**
 * What the operating system says is running, for tests that must prove a Chrome is GONE — by pid, never by the
 * pack's own bookkeeping (a runtime that forgot a browser says nothing about whether its process died).
 *
 * A throwaway browser's command line carries `--user-data-dir=<root>/ephemeral/<random>/chrome`, and so does every
 * helper process of that Chrome (renderer, GPU, crashpad), so one path fragment names a browser's whole process tree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dlopen, FFIType } from "bun:ffi";

const run = promisify(execFile);

interface OsProcess {
	pid: number;
	command: string;
}

/** One throwaway browser as the operating system sees it. */
export interface ThrowawayChrome {
	/** The browser process itself (the one with no `--type=`): what holds a slot. */
	main: number | undefined;
	/** Its whole tree: the browser process, renderers, GPU, crashpad. */
	all: number[];
}

/** Every Chrome-family process on the machine with its command line. */
async function chromeProcesses(): Promise<OsProcess[]> {
	if (process.platform === "win32") {
		const script =
			"Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
		if (stdout.trim() === "") return [];
		const parsed = JSON.parse(stdout) as { ProcessId: number; CommandLine: string | null } | Array<{ ProcessId: number; CommandLine: string | null }>;
		return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({ pid: entry.ProcessId, command: entry.CommandLine ?? "" }));
	}
	const { stdout } = await run("ps", ["-eo", "pid=,args="], { maxBuffer: 64 * 1024 * 1024 });
	return stdout
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null && /chrom/i.test(match[2] ?? ""))
		.map((match) => ({ pid: Number(match[1]), command: match[2] as string }));
}

/**
 * The live Chrome browsers under `root`, by the name of the throwaway directory each runs in. One OS query for all of them,
 * because on Windows each query costs a second.
 */
export async function chromePidsByThrowaway(root: string): Promise<Map<string, ThrowawayChrome>> {
	const byDirectory = new Map<string, ThrowawayChrome>();
	for (const entry of await chromeProcesses()) {
		if (!entry.command.includes(root)) continue;
		const match = /ephemeral[\\/]([0-9a-f]+)[\\/]/i.exec(entry.command);
		if (match === null) continue;
		const name = match[1] as string;
		const known = byDirectory.get(name) ?? { main: undefined, all: [] };
		known.all.push(entry.pid);
		if (!entry.command.includes("--type=")) known.main = entry.pid;
		byDirectory.set(name, known);
	}
	return byDirectory;
}

/** Whether the OS still has a process with this pid. Signal 0 delivers nothing; it only asks. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Poll until none of `pids` is alive; the survivors at the deadline otherwise (an empty list is success; a 0 deadline asks once). */
export async function waitUntilGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const survivors = pids.filter(isAlive);
		if (survivors.length === 0 || Date.now() >= deadline) return survivors;
		await Bun.sleep(50);
	}
}

/**
 * Freeze a process so it stops answering anything — a Chrome that will not shut down is exactly this to whoever asks it to.
 * Returns what thaws it. POSIX: SIGSTOP/SIGCONT. Windows: NtSuspendProcess/NtResumeProcess through bun:ffi (the POSIX branch is
 * not exercised on this machine).
 */
export function suspendProcess(pid: number): () => void {
	if (process.platform !== "win32") {
		process.kill(pid, "SIGSTOP");
		return () => {
			try {
				process.kill(pid, "SIGCONT");
			} catch {
				// Already gone: nothing to thaw.
			}
		};
	}
	const PROCESS_SUSPEND_RESUME = 0x0800;
	const kernel = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const ntdll = dlopen("ntdll.dll", {
		NtSuspendProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
		NtResumeProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const handle = kernel.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
	if (handle === null) throw new Error(`could not open process ${pid} to suspend it`);
	const status = ntdll.symbols.NtSuspendProcess(handle);
	if (status !== 0) {
		kernel.symbols.CloseHandle(handle);
		throw new Error(`NtSuspendProcess(${pid}) answered ${status}`);
	}
	return () => {
		ntdll.symbols.NtResumeProcess(handle);
		kernel.symbols.CloseHandle(handle);
	};
}
