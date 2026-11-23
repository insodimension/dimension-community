import { afterEach, describe, expect, jest, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { type Layout, layoutAt } from "../src/layout.js";
import type { CloneModel } from "../src/registry.js";
import { LiveWorker, type WorkerLease, WorkerPool } from "../src/runtime.js";
import { rejection } from "./outcome.js";
import { CAN_RUN_FAKE_PROCESSES, fakeEnv as envWith, isAlive, PYTHON } from "./python.js";
import { QWEN, quiet, TempDirs, VOICE, VOXCPM } from "./support.js";

setDefaultTimeout(30_000);

const IDLE_MS = 60_000;
const WAITING_MS = 400;

const temp = new TempDirs();
const pools: WorkerPool[] = [];
const loose: LiveWorker[] = [];
const held: WorkerLease[] = [];

afterEach(async () => {
	jest.useRealTimers();
	for (const lease of held.splice(0)) lease.release();
	await Promise.all(pools.splice(0).map(pool => pool.close()));
	await Promise.all(loose.splice(0).map(worker => worker.stop()));
	await temp.dispose();
});

interface Started {
	readonly model: string;
	readonly pid: number;
	readonly serve: boolean;
	readonly env: Readonly<Record<string, string | null>>;
}

async function makeLayout(): Promise<Layout> {
	if (!PYTHON) throw new Error("no python");
	return { ...layoutAt(await temp.make("vc-pool-")), python: () => PYTHON };
}

async function starts(layout: Layout): Promise<Started[]> {
	const file = Bun.file(join(layout.root, "lifecycle.log"));
	if (!(await file.exists())) return [];
	return (await file.text())
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Started);
}

async function firstStart(layout: Layout): Promise<Started> {
	const [started] = await starts(layout);
	if (!started) throw new Error("the fake worker never logged a start");
	return started;
}

function openPool(idleMs?: number): WorkerPool {
	const pool = new WorkerPool(idleMs);
	pools.push(pool);
	return pool;
}

function openWorker(layout: Layout, model: CloneModel, env: Record<string, string | undefined>): LiveWorker {
	const worker = new LiveWorker(layout, model, env);
	loose.push(worker);
	return worker;
}

/** Asks the pool for a worker; the lease is given back when the test ends if it was not before. */
function request(
	pool: WorkerPool,
	layout: Layout,
	model: CloneModel,
	env: Record<string, string | undefined> = envWith(),
	signal: AbortSignal = new AbortController().signal,
): Promise<WorkerLease> {
	return pool.acquire(layout, model, env, signal).then(lease => {
		held.push(lease);
		return lease;
	});
}

class Waiting {
	done = false;
	readonly outcome: Promise<unknown>;

	constructor(promise: Promise<unknown>) {
		this.outcome = promise.then(
			value => {
				this.done = true;
				return value;
			},
			() => {
				this.done = true;
			},
		);
	}
}

/** Long enough that a switch which was not really held back would have started a process and finished. */
async function stillWaiting(waiting: Waiting): Promise<void> {
	await Bun.sleep(WAITING_MS);
	expect(waiting.done).toBe(false);
}

interface Echo {
	readonly id: number;
	readonly chunks: Uint8Array[];
	readonly payload: { text: string; voice: { audio: string; transcript: string }; options: Record<string, unknown> };
}

async function speakEcho(worker: LiveWorker, text: string, options: Record<string, unknown> = {}): Promise<Echo> {
	const chunks: Uint8Array[] = [];
	const utterance = worker.speak(text, VOICE, options, pcm => chunks.push(pcm));
	await utterance.done;
	const bytes = new Uint8Array(Buffer.concat(chunks));
	return { id: utterance.id, chunks, payload: JSON.parse(new TextDecoder().decode(bytes)) };
}

function speakHeld(worker: LiveWorker): { id: number; done: Promise<void>; started: Promise<void> } {
	const started = Promise.withResolvers<void>();
	const utterance = worker.speak("hold on", VOICE, {}, () => started.resolve());
	return { id: utterance.id, done: utterance.done, started: started.promise };
}

const describeFake = CAN_RUN_FAKE_PROCESSES ? describe : describe.skip;

describeFake("LiveWorker over a real process speaking the frame protocol", () => {
	test("a request travels as a JSON line and its audio comes back by request id, across several frames", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		expect(worker.alive).toBe(true);

		const text = "Gr\u00fc\u00dfe \ud83d\ude42 \u4e16\u754c, line one.\nline two.";
		const echo = await speakEcho(worker, text, { seed: 7, instruction: "calm", nested: { a: [1, 2] } });
		expect(echo.id).toBe(1);
		expect(echo.chunks.length).toBeGreaterThanOrEqual(2);
		expect(echo.payload.text).toBe(text);
		expect(echo.payload.options).toEqual({ seed: 7, instruction: "calm", nested: { a: [1, 2] } });
		expect(echo.payload.voice).toEqual({ audio: VOICE.audio, transcript: VOICE.transcript });
	});

	test("request ids count up from one, one per speak", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		expect((await speakEcho(worker, "a")).id).toBe(1);
		expect((await speakEcho(worker, "b")).id).toBe(2);
		expect((await speakEcho(worker, "c")).id).toBe(3);
	});

	test("two requests in flight each get their own audio, never each other's", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const [first, second] = await Promise.all([speakEcho(worker, "first request"), speakEcho(worker, "second request")]);
		expect(first.payload.text).toBe("first request");
		expect(second.payload.text).toBe("second request");
		expect(first.id).not.toBe(second.id);
	});

	test("a 300,000 byte audio frame, which arrives in several pipe reads, is delivered whole", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const chunks: Uint8Array[] = [];
		await worker.speak("big", VOICE, {}, pcm => chunks.push(pcm)).done;
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toEqual(Uint8Array.from({ length: 300_000 }, (_, i) => i % 251));
	});

	test("cancel stops a request mid-way: the worker finishes it, and the worker serves the next request", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const running = speakHeld(worker);
		await running.started;
		worker.cancel(running.id);
		await running.done;
		expect((await speakEcho(worker, "after the cancel")).payload.text).toBe("after the cancel");
	});

	test("cancelling a request that already finished, or never existed, changes nothing", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const echo = await speakEcho(worker, "done already");
		worker.cancel(echo.id);
		worker.cancel(999);
		expect((await speakEcho(worker, "still fine")).payload.text).toBe("still fine");
	});

	test("a request the model fails on rejects only that request; the worker keeps serving", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const error = await rejection(speakEcho(worker, "this will boom"));
		expect((error as Error).message).toBe(`${QWEN.label}: RuntimeError: boom`);
		expect(worker.alive).toBe(true);
		expect((await speakEcho(worker, "next one")).payload.text).toBe("next one");
	});

	test("serving runs offline, with the Hugging Face cache inside the data folder", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith({ HF_HOME: "/somewhere/else" }));
		await worker.ready;
		const started = await firstStart(layout);
		expect(started.serve).toBe(true);
		expect(started.env).toEqual({
			HF_HOME: layout.hf,
			HF_HUB_OFFLINE: "1",
			HF_HUB_DISABLE_TELEMETRY: "1",
			PYTHONUTF8: "1",
			PYTHONIOENCODING: "utf-8",
		});
	});

	test("a model that reports a fatal load error fails ready with its reason, and the worker is dead", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith({ FAKE_MODE: "fatal" }));
		const error = await rejection(worker.ready);
		expect((error as Error).message).toBe(`${QWEN.label} failed to load: CUDA is not available`);
		expect(worker.alive).toBe(false);
		expect(() => worker.speak("x", VOICE, {}, () => {})).toThrow(/failed to load: CUDA is not available/);
	});

	test("a process that dies before ready fails ready with its exit code and the end of its stderr", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith({ FAKE_MODE: "crash" }));
		const error = (await rejection(worker.ready)) as Error;
		expect(error.message).toContain(`${QWEN.label} stopped (exit 3)`);
		expect(error.message).toContain("no cuda here");
		expect(worker.alive).toBe(false);
	});

	test("a model that speaks at another sample rate than models.json says is refused, and its process is killed", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith({ FAKE_MODE: "badrate" }));
		const error = (await rejection(worker.ready)) as Error;
		expect(error.message).toContain(`${QWEN.sampleRate + 1} Hz`);
		expect(error.message).toContain(`${QWEN.sampleRate} Hz`);
		expect(isAlive((await firstStart(layout)).pid)).toBe(false);
	});

	test("a process that dies mid-request rejects what was pending with its exit code and stderr, and refuses new work", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const pending = worker.speak("die", VOICE, {}, () => {});
		const error = (await rejection(pending.done)) as Error;
		expect(error.message).toContain("stopped (exit 3)");
		expect(error.message).toContain("kaboom");
		expect(worker.alive).toBe(false);
		expect(() => worker.speak("again", VOICE, {}, () => {})).toThrow(/stopped \(exit 3\)/);
	});

	test("stop kills the process, rejects what was pending as unloaded, and the worker is dead", async () => {
		const layout = await makeLayout();
		const worker = openWorker(layout, QWEN, envWith());
		await worker.ready;
		const running = speakHeld(worker);
		await running.started;
		const outcome = rejection(running.done);
		await worker.stop();
		expect(((await outcome) as Error).message).toContain("was unloaded");
		expect(worker.alive).toBe(false);
		expect(isAlive((await firstStart(layout)).pid)).toBe(false);
	});
});

describeFake("WorkerPool leases", () => {
	test("one model, loaded once: every lease on it is the same live worker, with no second process", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		const second = await request(pool, layout, QWEN);
		expect(second.worker).toBe(first.worker);
		expect(await starts(layout)).toHaveLength(1);
		expect((await speakEcho(first.worker, "hello")).payload.text).toBe("hello");
	});

	test("simultaneous acquires of one model share a single load", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const env = envWith({ FAKE_LOAD_MS: "200" });
		const [a, b, c] = await Promise.all([request(pool, layout, QWEN, env), request(pool, layout, QWEN, env), request(pool, layout, QWEN, env)]);
		expect(b.worker).toBe(a.worker);
		expect(c.worker).toBe(a.worker);
		expect(await starts(layout)).toHaveLength(1);
	});

	test("with nobody holding a lease, another model replaces the first: only one model is ever resident", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		first.release();
		const second = await request(pool, layout, VOXCPM);
		expect(second.worker).not.toBe(first.worker);
		expect(first.worker.alive).toBe(false);
		expect(second.worker.alive).toBe(true);
		const [qwen, voxcpm] = await starts(layout);
		expect([qwen?.model, voxcpm?.model]).toEqual(["qwen3-tts", "voxcpm2"]);
		expect(isAlive(qwen?.pid ?? 0)).toBe(false);
		expect(isAlive(voxcpm?.pid ?? 0)).toBe(true);
	});

	test("a lease is a lease on a worker that is already loaded and ready to speak", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const env = envWith({ FAKE_LOAD_MS: "300" });
		const begun = Date.now();
		const lease = await request(pool, layout, QWEN, env);
		expect(Date.now() - begun).toBeGreaterThanOrEqual(250);
		expect((await speakEcho(lease.worker, "now")).payload.text).toBe("now");
	});
});

describeFake("WorkerPool drains before it switches", () => {
	test("another model waits for every lease on the resident model, and the resident model keeps speaking meanwhile", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		const second = await request(pool, layout, QWEN);
		const switching = new Waiting(request(pool, layout, VOXCPM));

		await stillWaiting(switching);
		expect(first.worker.alive).toBe(true);
		expect((await speakEcho(first.worker, "still talking")).payload.text).toBe("still talking");
		expect((await starts(layout)).map(started => started.model)).toEqual(["qwen3-tts"]);

		first.release();
		await stillWaiting(switching);
		expect(first.worker.alive).toBe(true);

		second.release();
		await switching.outcome;
		expect(switching.done).toBe(true);
		expect(first.worker.alive).toBe(false);
		expect((await starts(layout)).map(started => started.model)).toEqual(["qwen3-tts", "voxcpm2"]);
	});

	test("a reply in flight on the resident model is never cut off by a request for another model", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const lease = await request(pool, layout, QWEN);
		const running = speakHeld(lease.worker);
		await running.started;
		const switching = new Waiting(request(pool, layout, VOXCPM));
		await stillWaiting(switching);
		lease.worker.cancel(running.id);
		await running.done;
		lease.release();
		await switching.outcome;
		expect(lease.worker.alive).toBe(false);
	});

	test("releasing a lease twice gives back only one: the other holder still keeps the switch waiting", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		const second = await request(pool, layout, QWEN);
		const switching = new Waiting(request(pool, layout, VOXCPM));
		first.release();
		first.release();
		await stillWaiting(switching);
		second.release();
		await switching.outcome;
		expect(switching.done).toBe(true);
	});

	test("requests are served in the order they were made, switches included", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const resident = await request(pool, layout, QWEN);
		const voxcpm = new Waiting(request(pool, layout, VOXCPM));
		const qwenAgain = new Waiting(request(pool, layout, QWEN));

		resident.release();
		const voxcpmLease = (await voxcpm.outcome) as WorkerLease;
		expect(voxcpm.done).toBe(true);
		await stillWaiting(qwenAgain);

		voxcpmLease.release();
		await qwenAgain.outcome;
		expect((await starts(layout)).map(started => started.model)).toEqual(["qwen3-tts", "voxcpm2", "qwen3-tts"]);
	});

	test("an acquire whose signal is already aborted is refused with its reason, before any process starts", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const controller = new AbortController();
		const reason = new Error("barge-in");
		controller.abort(reason);
		expect(await rejection(request(pool, layout, QWEN, envWith(), controller.signal))).toBe(reason);
		expect(await starts(layout)).toEqual([]);
	});

	test("a request aborted while it waits for the drain never switches: the resident model stays loaded and serving", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const resident = await request(pool, layout, QWEN);
		const controller = new AbortController();
		const switching = request(pool, layout, VOXCPM, envWith(), controller.signal);
		const outcome = rejection(switching);
		await quiet();
		const reason = new Error("the reply was cancelled");
		controller.abort(reason);
		resident.release();
		expect(await outcome).toBe(reason);

		expect(resident.worker.alive).toBe(true);
		expect((await starts(layout)).map(started => started.model)).toEqual(["qwen3-tts"]);
		const again = await request(pool, layout, QWEN);
		expect(again.worker).toBe(resident.worker);
	});

	test("an aborted request does not hold up the ones queued behind it", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const resident = await request(pool, layout, QWEN);
		const controller = new AbortController();
		const aborted = rejection(request(pool, layout, VOXCPM, envWith(), controller.signal));
		const behind = request(pool, layout, QWEN);
		await quiet();
		controller.abort(new Error("gone"));
		resident.release();
		await aborted;
		expect((await behind).worker).toBe(resident.worker);
	});
});

describeFake("WorkerPool failures", () => {
	test("a worker that died is replaced by a fresh process on the next acquire", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		await rejection(first.worker.speak("die", VOICE, {}, () => {}).done);
		first.release();
		const second = await request(pool, layout, QWEN);
		expect(second.worker).not.toBe(first.worker);
		expect(second.worker.alive).toBe(true);
		expect(await starts(layout)).toHaveLength(2);
		expect((await speakEcho(second.worker, "back again")).payload.text).toBe("back again");
	});

	test.each([
		{ name: "a fatal load error", mode: "fatal", message: "failed to load: CUDA is not available" },
		{ name: "a crash before ready", mode: "crash", message: "stopped (exit 3)" },
		{ name: "a sample rate mismatch", mode: "badrate", message: "Hz" },
	])("$name rejects the acquire, holds no lease, and the next acquire tries again instead of reusing the failure", async ({ mode, message }) => {
		const layout = await makeLayout();
		const pool = openPool();
		const error = (await rejection(request(pool, layout, QWEN, envWith({ FAKE_MODE: mode })))) as Error;
		expect(error.message).toContain(message);

		const other = await request(pool, layout, VOXCPM);
		expect(other.worker.alive).toBe(true);
		other.release();
		const recovered = await request(pool, layout, QWEN);
		expect(recovered.worker.alive).toBe(true);
		expect((await speakEcho(recovered.worker, "recovered")).payload.text).toBe("recovered");
	});

	test("one failed acquire does not block the queue behind it", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const bad = request(pool, layout, QWEN, envWith({ FAKE_MODE: "crash" }));
		const good = request(pool, layout, VOXCPM);
		expect(((await rejection(bad)) as Error).message).toContain("stopped (exit 3)");
		expect((await good).worker.model.id).toBe("voxcpm2");
	});

	test("another data folder is another worker, even for the same model", async () => {
		const first = await makeLayout();
		const second = await makeLayout();
		const pool = openPool();
		const a = await request(pool, first, QWEN);
		a.release();
		const b = await request(pool, second, QWEN);
		expect(b.worker).not.toBe(a.worker);
		expect(a.worker.alive).toBe(false);
		expect(b.worker.root).toBe(second.root);
	});

	test("close unloads the resident worker, and the pool can load again afterwards", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const first = await request(pool, layout, QWEN);
		first.release();
		await pool.close();
		expect(first.worker.alive).toBe(false);
		expect(isAlive((await firstStart(layout)).pid)).toBe(false);
		const again = await request(pool, layout, QWEN);
		expect(again.worker).not.toBe(first.worker);
		expect(again.worker.alive).toBe(true);
	});

	test("close with nothing loaded is a no-op", async () => {
		await openPool().close();
	});
});

describeFake("WorkerPool releaseIdle", () => {
	test("with nothing loaded there is nothing to free", async () => {
		expect(await openPool().releaseIdle()).toBe(0);
	});

	test("an idle worker is stopped and counted once, and the next acquire starts a fresh process", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const lease = await request(pool, layout, QWEN);
		lease.release();
		expect(await pool.releaseIdle()).toBe(1);
		expect(lease.worker.alive).toBe(false);
		expect(isAlive((await firstStart(layout)).pid)).toBe(false);
		expect(await pool.releaseIdle()).toBe(0);

		const fresh = await request(pool, layout, QWEN);
		expect(fresh.worker).not.toBe(lease.worker);
		expect(await starts(layout)).toHaveLength(2);
	});

	test("a worker someone is holding is left alone, and can be freed once they let go", async () => {
		const layout = await makeLayout();
		const pool = openPool();
		const lease = await request(pool, layout, QWEN);
		expect(await pool.releaseIdle()).toBe(0);
		expect(lease.worker.alive).toBe(true);
		expect((await speakEcho(lease.worker, "still here")).payload.text).toBe("still here");
		lease.release();
		expect(await pool.releaseIdle()).toBe(1);
		expect(lease.worker.alive).toBe(false);
	});
});

describeFake("WorkerPool idle unload", () => {
	test("an idle worker is unloaded once the idle period after its last lease passes, not a moment before, and its process exits", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const lease = await request(pool, layout, QWEN);
		lease.release();
		jest.advanceTimersByTime(IDLE_MS - 1);
		expect(lease.worker.alive).toBe(true);
		jest.advanceTimersByTime(1);
		expect(lease.worker.alive).toBe(false);
		await lease.worker.stop();
		expect(isAlive((await firstStart(layout)).pid)).toBe(false);
	});

	test("a worker that is leased is never unloaded, however long the lease lasts, and the clock starts when it is released", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const lease = await request(pool, layout, QWEN);
		jest.advanceTimersByTime(IDLE_MS * 3);
		expect(lease.worker.alive).toBe(true);

		lease.release();
		jest.advanceTimersByTime(IDLE_MS - 1);
		expect(lease.worker.alive).toBe(true);
		jest.advanceTimersByTime(1);
		expect(lease.worker.alive).toBe(false);
	});

	test("with two leases the clock starts only when the last one is released", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const first = await request(pool, layout, QWEN);
		const second = await request(pool, layout, QWEN);
		first.release();
		jest.advanceTimersByTime(IDLE_MS * 2);
		expect(first.worker.alive).toBe(true);
		second.release();
		jest.advanceTimersByTime(IDLE_MS - 1);
		expect(first.worker.alive).toBe(true);
		jest.advanceTimersByTime(1);
		expect(first.worker.alive).toBe(false);
	});

	test("every release restarts the clock: finishing a reply postpones the unload", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const lease = await request(pool, layout, QWEN);
		lease.release();
		jest.advanceTimersByTime(IDLE_MS - 100);
		const again = await request(pool, layout, QWEN);
		expect(again.worker).toBe(lease.worker);
		await speakEcho(again.worker, "activity");
		again.release();
		jest.advanceTimersByTime(IDLE_MS - 100);
		expect(lease.worker.alive).toBe(true);
		jest.advanceTimersByTime(100);
		expect(lease.worker.alive).toBe(false);
	});

	test("taking a lease cancels a pending unload even when the lease is never used", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const lease = await request(pool, layout, QWEN);
		lease.release();
		jest.advanceTimersByTime(IDLE_MS / 2);
		const again = await request(pool, layout, QWEN);
		jest.advanceTimersByTime(IDLE_MS * 2);
		expect(again.worker.alive).toBe(true);
	});

	test("after an idle unload the next acquire starts a fresh process", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const lease = await request(pool, layout, QWEN);
		lease.release();
		jest.advanceTimersByTime(IDLE_MS);
		const fresh = await request(pool, layout, QWEN);
		expect(fresh.worker).not.toBe(lease.worker);
		expect(fresh.worker.alive).toBe(true);
		expect(await starts(layout)).toHaveLength(2);
	});

	test("a model that replaces another gets its own full idle period, not what was left of the old one's", async () => {
		const layout = await makeLayout();
		jest.useFakeTimers();
		const pool = openPool(IDLE_MS);
		const first = await request(pool, layout, QWEN);
		first.release();
		jest.advanceTimersByTime(IDLE_MS - 1);
		const second = await request(pool, layout, VOXCPM);
		expect(first.worker.alive).toBe(false);
		second.release();
		jest.advanceTimersByTime(IDLE_MS - 1);
		expect(second.worker.alive).toBe(true);
		jest.advanceTimersByTime(1);
		expect(second.worker.alive).toBe(false);
	});
});
