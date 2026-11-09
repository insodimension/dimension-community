import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

const viewer = fileURLToPath(new URL("../", import.meta.url));
const scratch = join(viewer, ".scratch", "tmp");
const deadlineMs = 10_000;

interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface OwnedProcess {
	child: ChildProcessWithoutNullStreams;
	exited: Promise<ChildExit>;
	output(): { stdout: string; stderr: string };
	dispose(): Promise<void>;
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not finish within ${deadlineMs} ms`)), deadlineMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function launch(script: string, env: NodeJS.ProcessEnv = process.env): OwnedProcess {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script], { cwd: viewer, stdio: "pipe", env });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	const exited = new Promise<ChildExit>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	return {
		child,
		exited,
		output: () => ({ stdout, stderr }),
		async dispose() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await bounded(exited, "owned child cleanup");
		},
	};
}

async function fixture() {
	await mkdir(scratch, { recursive: true });
	return mkdtemp(join(scratch, "server-lifecycle-"));
}

test("unsupported View assets reject construction without leaving the media listener alive", async () => {
	const directory = await fixture();
	let process_: OwnedProcess | undefined;
	try {
		const viewDir = join(directory, "dist");
		await mkdir(viewDir);
		await writeFile(join(viewDir, "index.html"), "<!doctype html><title>viewer</title>");
		await writeFile(join(viewDir, "unsupported.exe"), "unsupported asset");
		const script = join(directory, "construction.ts");
		await writeFile(script, `import { createViewerServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
try {
	const server = await createViewerServer({ viewDir: ${JSON.stringify(viewDir)}, home: ${JSON.stringify(directory)}, env: {} });
	await server.close();
	process.exitCode = 2;
} catch (error) {
	if (!(error instanceof Error)) throw error;
	console.log(error.message);
}
`);
		process_ = launch(script);
		const exit = await bounded(process_.exited, "construction rejection releasing its listener");
		expect(exit).toEqual({ code: 0, signal: null });
		expect(process_.output()).toEqual({ stdout: "Unsupported viewer View asset: unsupported.exe\n", stderr: "" });
	} finally {
		await process_?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("stdio EOF after MCP initialization exits successfully without a termination signal", async () => {
	const directory = await fixture();
	let process_: OwnedProcess | undefined;
	let lines: Interface | undefined;
	try {
		const pack = join(directory, "packs", "swiss-knife");
		const packSource = join(pack, "src");
		const source = join(pack, "viewer", "src");
		await cp(join(viewer, "..", "..", "..", "lib"), join(directory, "lib"), { recursive: true });
		await cp(join(viewer, "..", "src"), packSource, { recursive: true });
		await cp(join(viewer, "src"), source, { recursive: true, filter: path => basename(path) !== "dist" });
		await mkdir(join(source, "dist"));
		await writeFile(join(source, "dist", "index.html"), "<!doctype html><title>viewer</title>");
		const owned = launch(join(source, "stdio.ts"), { ...process.env, INSO_HOME: join(directory, "home") });
		process_ = owned;
		const reader = createInterface({ input: owned.child.stdout });
		lines = reader;
		const initialized = new Promise<unknown>((resolve, reject) => {
			reader.on("line", line => {
				try {
					const message = JSON.parse(line);
					if (message.id === 1) resolve(message);
				} catch (error) {
					reject(error);
				}
			});
			owned.exited.then(exit => reject(new Error(`stdio exited before initialization: ${JSON.stringify(exit)}`)), reject);
		});
		process_.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } } })}\n`);
		expect(await bounded(initialized, "MCP initialization")).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });
		process_.child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		expect(await bounded(process_.exited, "stdin EOF releasing the media listener")).toEqual({ code: 0, signal: null });
		expect(process_.output().stderr).toBe("");
	} finally {
		lines?.close();
		await process_?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
