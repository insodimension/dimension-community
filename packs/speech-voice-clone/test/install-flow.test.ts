import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpeakSession, SpeechProvider, SpeechProviderContext } from "@dimension/sdk/provider";
import { createVoiceCloneProvider } from "../src/index.js";
import { install, installStamp, isInstalled } from "../src/install.js";
import { type Layout, layoutAt } from "../src/layout.js";
import { type CloneModel, type LockPlatform, PACK_FILES } from "../src/registry.js";
import type { WorkerPool } from "../src/runtime.js";
import { CAN_RUN_FAKE_PROCESSES, fakeEnv, HOST_LOCK, isAlive, PYTHON } from "./python.js";
import { addVoice, CHATTERBOX, FakeLiveWorker, INSTALL_MARKER_FILE, markInstalled, QWEN, quiet, Recorder, REGISTRY, speaksSeconds, TempDirs, VOXCPM, waitFor } from "./support.js";
import { failureOf, rejection } from "./outcome.js";

setDefaultTimeout(60_000);

const temp = new TempDirs();
afterEach(() => temp.dispose());

const LOCK: LockPlatform = HOST_LOCK ?? "windows";
const OTHER_LOCK: LockPlatform = LOCK === "windows" ? "linux" : "windows";
const describeFake = CAN_RUN_FAKE_PROCESSES ? describe : describe.skip;

interface Started {
	readonly model: string;
	readonly pid: number;
	readonly serve: boolean;
	readonly env: Record<string, string | null>;
}

interface Flow {
	readonly layout: Layout;
	readonly env: Record<string, string | undefined>;
	readonly uvCalls: () => Promise<string[][]>;
	readonly started: () => Promise<Started[]>;
	readonly releaseDownload: () => Promise<void>;
}

async function jsonLines<T>(file: string): Promise<T[]> {
	const handle = Bun.file(file);
	if (!(await handle.exists())) return [];
	return (await handle.text())
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as T);
}

async function makeFlow(extra: Record<string, string> = {}): Promise<Flow> {
	const layout = layoutAt(await temp.make("vc-flow-"));
	const uvLog = join(await temp.make("vc-uvlog-"), "uv.log");
	return {
		layout,
		env: fakeEnv({ FAKE_UV_LOG: uvLog, ...extra }),
		uvCalls: () => jsonLines<string[]>(uvLog),
		started: () => jsonLines<Started>(join(layout.root, "lifecycle.log")),
		releaseDownload: () => writeFile(join(layout.root, "gate"), ""),
	};
}

function markerPath(flow: Flow, model: CloneModel): string {
	return join(flow.layout.env(model.id), INSTALL_MARKER_FILE);
}

async function venvCalls(flow: Flow): Promise<string[][]> {
	return (await flow.uvCalls()).filter(call => call[0] === "venv");
}

function runInstall(flow: Flow, model: CloneModel, options: { progress?: number[]; signal?: AbortSignal; registry?: typeof REGISTRY; platform?: LockPlatform } = {}): Promise<void> {
	if (!PYTHON) throw new Error("no python");
	return install(flow.layout, options.registry ?? REGISTRY, model, { uv: PYTHON, platform: options.platform ?? LOCK, env: flow.env }, fraction => options.progress?.push(fraction), options.signal ?? new AbortController().signal);
}

describeFake("install: uv builds the environment, the worker downloads the model, a marker records the pins", () => {
	test("runs the steps in order with the right commands, reports honest progress, and stamps the install", async () => {
		const flow = await makeFlow();
		const progress: number[] = [];
		await runInstall(flow, QWEN, { progress });

		expect(await flow.uvCalls()).toEqual([
			["venv", "--python", QWEN.python, "--allow-existing", flow.layout.env(QWEN.id)],
			["pip", "sync", "--python", flow.layout.python(QWEN.id), PACK_FILES.lock(QWEN.id, LOCK), "--extra-index-url", REGISTRY.torchIndexes[QWEN.torch] ?? "", "--index-strategy", "unsafe-best-match"],
		]);

		expect(progress[0]).toBe(0);
		expect(progress.at(-1)).toBe(1);
		expect([...progress].sort((a, b) => a - b)).toEqual(progress);
		expect(progress.length).toBeGreaterThanOrEqual(5);
		expect(await isInstalled(flow.layout, QWEN, LOCK)).toBe(true);
		const marker = JSON.parse(await readFile(markerPath(flow, QWEN), "utf8")) as { stamp: string };
		expect(marker.stamp).toBe(installStamp(QWEN, LOCK));
	});

	test("the downloader runs online (the one step allowed to reach the Hub), with the cache in the data folder", async () => {
		const flow = await makeFlow();
		await runInstall(flow, QWEN);
		const [setup] = await flow.started();
		expect(setup?.serve).toBe(false);
		expect(setup?.env.HF_HUB_OFFLINE).toBeNull();
		expect(setup?.env.HF_HOME).toBe(flow.layout.hf);
	});

	test.each(REGISTRY.models.map(model => [model.id, model] as const))("%s: asks uv for its own Python, its own platform lock and its own torch index", async (_id, model) => {
		const flow = await makeFlow({ FAKE_UV_VENV: "folder-only", FAKE_UV_FAIL: "pip" });
		await rejection(runInstall(flow, model));
		const [venv, sync] = await flow.uvCalls();
		expect(venv).toEqual(["venv", "--python", model.python, "--allow-existing", flow.layout.env(model.id)]);
		expect(sync?.slice(0, 2)).toEqual(["pip", "sync"]);
		expect(sync).toContain(PACK_FILES.lock(model.id, LOCK));
		expect(sync?.[sync.indexOf("--extra-index-url") + 1]).toBe(REGISTRY.torchIndexes[model.torch]);
	});

	test("syncs the lock for the platform it was told, and stamps the environment with that platform's lock", async () => {
		const flow = await makeFlow();
		await runInstall(flow, QWEN, { platform: OTHER_LOCK });
		const [, sync] = await flow.uvCalls();
		expect(sync).toContain(PACK_FILES.lock(QWEN.id, OTHER_LOCK));
		expect(sync).not.toContain(PACK_FILES.lock(QWEN.id, LOCK));
		expect(await isInstalled(flow.layout, QWEN, OTHER_LOCK)).toBe(true);
		expect(await isInstalled(flow.layout, QWEN, LOCK)).toBe(false);
	});

	test("a model whose torch index models.json does not define is refused before anything runs", async () => {
		const flow = await makeFlow();
		const error = await failureOf(() => runInstall(flow, QWEN, { registry: { ...REGISTRY, torchIndexes: {} } }));
		expect(error.message).toContain(`no torch index "${QWEN.torch}"`);
		expect(await flow.uvCalls()).toEqual([]);
	});

	test("a signal that is already aborted runs nothing and rejects with its reason", async () => {
		const flow = await makeFlow();
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		expect(await failureOf(() => runInstall(flow, QWEN, { signal: controller.signal }))).toBe(reason);
		expect(await flow.uvCalls()).toEqual([]);
		expect(await flow.started()).toEqual([]);
	});

	test("uv failing to create the environment stops the install with uv's own words, and no marker is written", async () => {
		const flow = await makeFlow({ FAKE_UV_FAIL: "venv" });
		const error = await failureOf(() => runInstall(flow, QWEN));
		expect(error.message).toMatch(/^uv venv --python failed \(exit 2\):\nerror: no matching distribution found/);
		expect(await flow.uvCalls()).toHaveLength(1);
		expect(await flow.started()).toEqual([]);
		expect(existsSync(markerPath(flow, QWEN))).toBe(false);
	});

	test("uv failing to install the packages stops the install before the download, and no marker is written", async () => {
		const flow = await makeFlow({ FAKE_UV_FAIL: "pip", FAKE_UV_VENV: "folder-only" });
		const error = await failureOf(() => runInstall(flow, QWEN));
		expect(error.message).toMatch(/^uv pip sync failed \(exit 2\):\nerror: no matching distribution found/);
		expect(await flow.started()).toEqual([]);
		expect(existsSync(markerPath(flow, QWEN))).toBe(false);
	});

	test("a download the worker reports as fatal fails the install with the worker's reason, and no marker is written", async () => {
		const flow = await makeFlow({ FAKE_SETUP: "fatal" });
		const error = await failureOf(() => runInstall(flow, QWEN));
		expect(error.message).toBe(`downloading ${QWEN.label} failed: download failed: 404`);
		expect(existsSync(markerPath(flow, QWEN))).toBe(false);
		expect(await isInstalled(flow.layout, QWEN, LOCK)).toBe(false);
	});

	test("a downloader that dies without saying why fails the install with the end of its stderr", async () => {
		const flow = await makeFlow({ FAKE_SETUP: "crash" });
		const error = await failureOf(() => runInstall(flow, QWEN));
		expect(error.message).toBe(`downloading ${QWEN.label} failed: disk full`);
		expect(existsSync(markerPath(flow, QWEN))).toBe(false);
	});

	test("aborting during the download stops the downloader, rejects with the abort reason, and writes no marker", async () => {
		const flow = await makeFlow({ FAKE_SETUP: "hold" });
		const controller = new AbortController();
		const downloading = Promise.withResolvers<void>();
		const run = failureOf(() => {
			if (!PYTHON) throw new Error("no python");
			return install(flow.layout, REGISTRY, QWEN, { uv: PYTHON, platform: LOCK, env: flow.env }, fraction => fraction > 0.3 && downloading.resolve(), controller.signal);
		});
		await downloading.promise;
		const reason = new Error("cancelled by the user");
		controller.abort(reason);
		expect(await run).toBe(reason);
		const [setup] = await flow.started();
		expect(isAlive(setup?.pid ?? 0)).toBe(false);
		expect(existsSync(markerPath(flow, QWEN))).toBe(false);
	});

	test("a second install after a failed one starts over cleanly and succeeds", async () => {
		const flow = await makeFlow({ FAKE_SETUP: "fatal" });
		await rejection(runInstall(flow, QWEN));
		await runInstall({ ...flow, env: { ...flow.env, FAKE_SETUP: "ok" } }, QWEN);
		expect(await isInstalled(flow.layout, QWEN, LOCK)).toBe(true);
		expect(await venvCalls(flow)).toHaveLength(2);
	});
});

interface ProviderRig {
	readonly flow: Flow;
	readonly provider: SpeechProvider;
	readonly ctx: SpeechProviderContext;
	readonly worker: FakeLiveWorker;
	readonly withEnv: (extra: Record<string, string>) => SpeechProviderContext;
}

async function makeProvider(extraEnv: Record<string, string> = {}): Promise<ProviderRig> {
	const flow = await makeFlow(extraEnv);
	await addVoice(flow.layout, "me");
	const worker = new FakeLiveWorker(speaksSeconds(0.2, QWEN.sampleRate));
	const pool = { acquire: () => Promise.resolve(worker.asLiveWorker()) } as unknown as WorkerPool;
	const userHome = await temp.make("vc-user-");
	const provider = createVoiceCloneProvider({ pool, userHome, platform: process.platform });
	const ctx: SpeechProviderContext = {
		home: userHome,
		cwd: userHome,
		env: { ...flow.env, UV: PYTHON ?? "", DIMENSION_VOICE_CLONE_HOME: flow.layout.root },
		settings: { get: () => undefined },
		credentials: { withAccess: () => Promise.reject(new Error("no login")) },
	};
	return { flow, provider, ctx, worker, withEnv: extra => ({ ...ctx, env: { ...ctx.env, ...extra } }) };
}

function prepareModel(rig: ProviderRig, model: CloneModel, progress: number[] = [], signal = new AbortController().signal, ctx = rig.ctx): Promise<void> {
	if (!rig.provider.prepare) throw new Error("no prepare");
	return rig.provider.prepare(ctx, { kind: "speak", model: model.id }, fraction => progress.push(fraction), signal);
}

function openModel(rig: ProviderRig, model: CloneModel, signal = new AbortController().signal, ctx = rig.ctx): Promise<SpeakSession> {
	if (!rig.provider.openSpeak) throw new Error("no openSpeak");
	return rig.provider.openSpeak(ctx, { model: model.id, voice: "me" }, { signal, audioTags: true });
}

const DOWNLOAD_STARTED = "the downloader to start";
const DOWNLOAD_PAUSED = 0.6;

describeFake("prepare drives one shared install", () => {
	test("installs the model, reports strictly rising progress ending at 1, and the provider then reads ready", async () => {
		const rig = await makeProvider();
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });
		const progress: number[] = [];
		await prepareModel(rig, QWEN, progress);
		expect(progress.length).toBeGreaterThan(2);
		expect([...new Set(progress)].sort((a, b) => a - b)).toEqual(progress);
		expect(progress.every(fraction => fraction > 0 && fraction <= 1)).toBe(true);
		expect(progress.at(-1)).toBe(1);
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("preparing an installed model again runs nothing and reports nothing", async () => {
		const rig = await makeProvider();
		await prepareModel(rig, QWEN);
		const calls = (await rig.flow.uvCalls()).length;
		const progress: number[] = [];
		await prepareModel(rig, QWEN, progress);
		expect(progress).toEqual([]);
		expect(await rig.flow.uvCalls()).toHaveLength(calls);
	});

	test("simultaneous prepares of one model run one install between them, and each hears it reach 1", async () => {
		const rig = await makeProvider();
		const heard: number[][] = [[], [], []];
		await Promise.all(heard.map(progress => prepareModel(rig, QWEN, progress)));
		expect(await venvCalls(rig.flow)).toHaveLength(1);
		for (const progress of heard) expect(progress.at(-1)).toBe(1);
	});

	test("a prepare that joins a running install is told where it has got to, then follows it to the end", async () => {
		const rig = await makeProvider({ FAKE_SETUP: "gate" });
		const first: number[] = [];
		const running = prepareModel(rig, QWEN, first);
		await waitFor(() => first.some(fraction => fraction >= DOWNLOAD_PAUSED), "the install to reach the paused download");

		const late: number[] = [];
		const joined = prepareModel(rig, QWEN, late);
		await waitFor(() => late.length > 0, "the late joiner's first report");
		expect(late[0]).toBe(first.at(-1) ?? -1);

		await rig.flow.releaseDownload();
		await Promise.all([running, joined]);
		expect(late.at(-1)).toBe(1);
		expect(first.at(-1)).toBe(1);
		expect(await venvCalls(rig.flow)).toHaveLength(1);
	});

	test("one prepare cancelling detaches only itself: the other still gets its install", async () => {
		const rig = await makeProvider({ FAKE_SETUP: "gate" });
		const progress: number[] = [];
		const stays = prepareModel(rig, QWEN, progress);
		const controller = new AbortController();
		const leaves = failureOf(() => prepareModel(rig, QWEN, [], controller.signal));
		await waitFor(() => progress.some(fraction => fraction >= DOWNLOAD_PAUSED), "the install to reach the paused download");

		const reason = new Error("the user changed their mind");
		controller.abort(reason);
		expect(await leaves).toBe(reason);
		const [downloader] = await rig.flow.started();
		expect(isAlive(downloader?.pid ?? 0)).toBe(true);

		await rig.flow.releaseDownload();
		await stays;
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
		expect(await venvCalls(rig.flow)).toHaveLength(1);
	});

	test("the last prepare cancelling stops the install: nothing is left installed, and the next prepare starts over", async () => {
		const rig = await makeProvider({ FAKE_SETUP: "hold" });
		const controller = new AbortController();
		const progress: number[] = [];
		const preparing = failureOf(() => prepareModel(rig, QWEN, progress, controller.signal));
		await waitFor(() => progress.some(fraction => fraction >= DOWNLOAD_PAUSED), "the download to be under way");
		const reason = new Error("cancelled by the user");
		controller.abort(reason);
		expect(await preparing).toBe(reason);
		const [downloader] = await rig.flow.started();
		await waitFor(() => !isAlive(downloader?.pid ?? 0), "the downloader to be stopped");
		expect(existsSync(markerPath(rig.flow, QWEN))).toBe(false);
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });

		await prepareModel(rig, QWEN, [], new AbortController().signal, rig.withEnv({ FAKE_SETUP: "ok" }));
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("cancelling and asking again straight away still installs", async () => {
		const rig = await makeProvider({ FAKE_SETUP: "hold" });
		const controller = new AbortController();
		const progress: number[] = [];
		const cancelled = failureOf(() => prepareModel(rig, QWEN, progress, controller.signal));
		await waitFor(() => progress.some(fraction => fraction >= DOWNLOAD_PAUSED), "the download to be under way");
		controller.abort(new Error("cancelled by the user"));
		const again = prepareModel(rig, QWEN, [], new AbortController().signal, rig.withEnv({ FAKE_SETUP: "ok" }));
		await cancelled;
		await again;
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("a signal that is already aborted rejects with its reason and starts nothing", async () => {
		const rig = await makeProvider();
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		expect(await failureOf(() => prepareModel(rig, QWEN, [], controller.signal))).toBe(reason);
		expect(await rig.flow.uvCalls()).toEqual([]);
	});

	test("a failed install leaves the model needing a download, and trying again once the cause is gone works", async () => {
		const rig = await makeProvider();
		const failing = rig.withEnv({ FAKE_UV_FAIL: "pip" });
		await failureOf(() => prepareModel(rig, QWEN, [], new AbortController().signal, failing));
		expect((await rig.provider.status(failing)).speak).toMatchObject({ ready: false, reason: "needs-download" });
		await prepareModel(rig, QWEN);
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("installing one model does not make another count as installed", async () => {
		const rig = await makeProvider();
		await prepareModel(rig, QWEN);
		expect(await isInstalled(rig.flow.layout, CHATTERBOX, LOCK)).toBe(false);
		expect(existsSync(rig.flow.layout.env(CHATTERBOX.id))).toBe(false);
	});
});
