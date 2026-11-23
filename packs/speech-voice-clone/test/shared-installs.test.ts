import { describe, expect, test } from "bun:test";
import { SharedInstalls } from "../src/install.js";
import { failureOf, rejection } from "./outcome.js";
import { quiet, tick, waitFor } from "./support.js";

type OnAbort = "settle-at-once" | "settle-later" | "ignore";

interface Run {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	readonly report: (fraction: number) => void;
	readonly signal: AbortSignal;
}

class ControlledInstall {
	readonly #runs: Run[] = [];
	readonly #onAbort: OnAbort;

	constructor(onAbort: OnAbort = "settle-at-once") {
		this.#onAbort = onAbort;
	}

	get runs(): number {
		return this.#runs.length;
	}

	start = (report: (fraction: number) => void, signal: AbortSignal): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#runs.push({ resolve, reject, report, signal });
		signal.addEventListener("abort", () => {
			if (this.#onAbort === "settle-at-once") reject(signal.reason);
			else if (this.#onAbort === "settle-later") void tick().then(() => reject(signal.reason));
		});
		return promise;
	};

	async started(count: number): Promise<void> {
		await waitFor(() => this.#runs.length >= count, `install ${count} to start`);
	}

	signal(run = 0): AbortSignal | undefined {
		return this.#runs[run]?.signal;
	}

	async progress(fraction: number, run = 0): Promise<void> {
		await this.started(run + 1);
		this.#runs[run]?.report(fraction);
	}

	async finish(run = 0): Promise<void> {
		await this.started(run + 1);
		this.#runs[run]?.resolve();
	}

	async fail(error: Error, run = 0): Promise<void> {
		await this.started(run + 1);
		this.#runs[run]?.reject(error);
	}
}

class Joiner {
	readonly controller = new AbortController();
	readonly progress: number[] = [];
	settled: "pending" | "resolved" | "rejected" = "pending";
	readonly promise: Promise<void>;

	constructor(installs: SharedInstalls, install: ControlledInstall, key = "root\nqwen3-tts") {
		this.promise = installs.join(key, install.start, fraction => this.progress.push(fraction), this.controller.signal);
		this.promise.then(
			() => {
				this.settled = "resolved";
			},
			() => {
				this.settled = "rejected";
			},
		);
	}

	leave(reason: unknown = new Error("cancelled by the user")): unknown {
		this.controller.abort(reason);
		return reason;
	}
}

describe("one running install per key", () => {
	test("joiners of one key share a single run and all resolve when it finishes", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const joiners = [new Joiner(installs, install), new Joiner(installs, install), new Joiner(installs, install)];
		await install.started(1);
		await quiet();
		expect(install.runs).toBe(1);
		expect(joiners.map(joiner => joiner.settled)).toEqual(["pending", "pending", "pending"]);
		await install.finish();
		await Promise.all(joiners.map(joiner => joiner.promise));
		expect(joiners.map(joiner => joiner.settled)).toEqual(["resolved", "resolved", "resolved"]);
	});

	test("different keys install independently", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const qwen = new Joiner(installs, install, "root\nqwen3-tts");
		const voxcpm = new Joiner(installs, install, "root\nvoxcpm2");
		const elsewhere = new Joiner(installs, install, "other-root\nqwen3-tts");
		await install.started(3);
		await install.finish(1);
		await voxcpm.promise;
		await quiet();
		expect([qwen.settled, voxcpm.settled, elsewhere.settled]).toEqual(["pending", "resolved", "pending"]);
		await install.finish(0);
		await install.finish(2);
		await Promise.all([qwen.promise, elsewhere.promise]);
	});

	test("a failure rejects every joiner with the same error, and the next join starts a fresh run", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		const second = new Joiner(installs, install);
		const failure = new Error("uv pip sync failed (exit 2)");
		await install.fail(failure);
		expect(await rejection(first.promise)).toBe(failure);
		expect(await rejection(second.promise)).toBe(failure);

		const retry = new Joiner(installs, install);
		await install.started(2);
		await install.finish(1);
		await retry.promise;
	});

	test("a finished install is forgotten: joining again runs again, so an environment deleted since is rebuilt", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		await install.finish();
		await first.promise;
		const second = new Joiner(installs, install);
		await install.started(2);
		await install.finish(1);
		await second.promise;
	});
});

describe("progress", () => {
	test("every joiner sees the install's progress, in order, and nothing that does not move forward", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		const second = new Joiner(installs, install);
		for (const fraction of [0, 0.1, 0.1, 0.3, 0.2, 0.3, 0.7, 1]) await install.progress(fraction);
		await install.finish();
		await Promise.all([first.promise, second.promise]);
		expect(first.progress).toEqual([0.1, 0.3, 0.7, 1]);
		expect(second.progress).toEqual([0.1, 0.3, 0.7, 1]);
	});

	test("a joiner that arrives mid-install is told where the install is at once, then follows it", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const early = new Joiner(installs, install);
		await install.progress(0.2);
		await install.progress(0.6);
		const late = new Joiner(installs, install);
		expect(late.progress).toEqual([0.6]);
		await install.progress(0.9);
		await install.finish();
		await Promise.all([early.promise, late.promise]);
		expect(early.progress).toEqual([0.2, 0.6, 0.9]);
		expect(late.progress).toEqual([0.6, 0.9]);
	});

	test("a joiner that arrives before the install has moved is told nothing yet", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		await install.progress(0);
		const second = new Joiner(installs, install);
		expect(second.progress).toEqual([]);
		await install.finish();
		await Promise.all([first.promise, second.promise]);
	});

	test("an install that reports as soon as it starts is heard by the joiner that started it", async () => {
		const installs = new SharedInstalls();
		const progress: number[] = [];
		await installs.join(
			"k",
			(report, _signal) => {
				report(0.4);
				return Promise.resolve();
			},
			fraction => progress.push(fraction),
			new AbortController().signal,
		);
		expect(progress).toEqual([0.4]);
	});

	test("a joiner that has left hears no more progress", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const stays = new Joiner(installs, install);
		const leaves = new Joiner(installs, install);
		await install.progress(0.3);
		leaves.leave();
		await rejection(leaves.promise);
		await install.progress(0.8);
		await install.finish();
		await stays.promise;
		expect(leaves.progress).toEqual([0.3]);
		expect(stays.progress).toEqual([0.3, 0.8]);
	});
});

describe("leaving", () => {
	test("a joiner that aborts is rejected with its own reason, and the others carry on with the install untouched", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const stays = new Joiner(installs, install);
		const leaves = new Joiner(installs, install);
		await install.started(1);
		const reason = leaves.leave(new Error("barge-in"));
		expect(await rejection(leaves.promise)).toBe(reason);
		expect(install.signal()?.aborted).toBe(false);
		await quiet();
		expect(stays.settled).toBe("pending");
		await install.finish();
		await stays.promise;
		expect(stays.settled).toBe("resolved");
	});

	test("the install is aborted only when the last joiner leaves, with that joiner's reason", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		const second = new Joiner(installs, install);
		const third = new Joiner(installs, install);
		await install.started(1);
		first.leave(new Error("first"));
		second.leave(new Error("second"));
		await Promise.allSettled([first.promise, second.promise]);
		expect(install.signal()?.aborted).toBe(false);

		const reason = third.leave(new Error("third"));
		expect(install.signal()?.aborted).toBe(true);
		expect(install.signal()?.reason).toBe(reason);
		expect(await rejection(third.promise)).toBe(reason);
	});

	test("someone who joins after another has left keeps the install alive for as long as they stay", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		const second = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		const third = new Joiner(installs, install);
		await quiet();
		expect(install.runs).toBe(1);
		second.leave();
		await Promise.allSettled([first.promise, second.promise]);
		expect(install.signal()?.aborted).toBe(false);
		await install.finish();
		await third.promise;
		expect(third.settled).toBe("resolved");
	});

	test("the only joiner leaving before the install has begun means it never begins", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const only = new Joiner(installs, install);
		const reason = only.leave(new Error("changed my mind"));
		expect(await rejection(only.promise)).toBe(reason);
		await quiet();
		expect(install.runs).toBe(0);
	});

	test("aborting after the install has finished changes nothing, and does not poison the next join", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const joiner = new Joiner(installs, install);
		await install.finish();
		await joiner.promise;
		joiner.leave();
		await quiet();
		expect(joiner.settled).toBe("resolved");

		const next = new Joiner(installs, install);
		await install.started(2);
		expect(install.signal(1)?.aborted).toBe(false);
		await install.finish(1);
		await next.promise;
	});

	test("an install that fails after the last joiner left does not surface as an unhandled rejection", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("ignore");
		const only = new Joiner(installs, install);
		await install.started(1);
		only.leave();
		await rejection(only.promise);
		await install.fail(new Error("died while being cancelled"));
		await quiet();
		expect(only.settled).toBe("rejected");
	});

	test("after the last joiner leaves and the install has stopped, a new join starts a fresh install that completes", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const first = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		await rejection(first.promise);
		await quiet();

		const retry = new Joiner(installs, install);
		await install.started(2);
		expect(install.signal(1)?.aborted).toBe(false);
		await install.finish(1);
		await retry.promise;
		expect(retry.settled).toBe("resolved");
	});
});

describe("asking again right after a cancel", () => {
	test("gets its own install rather than the one that is being cancelled, and it completes", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("settle-later");
		const first = new Joiner(installs, install);
		await install.started(1);
		const reason = first.leave(new Error("cancelled by the user"));
		const retry = new Joiner(installs, install);
		expect(await rejection(first.promise)).toBe(reason);
		await install.started(2);
		expect(retry.settled).toBe("pending");
		await install.finish(1);
		await retry.promise;
		expect(retry.settled).toBe("resolved");
	});

	test("the replacement waits for the cancelled install to stop, so two never work on one environment at once", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("ignore");
		const first = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		const retry = new Joiner(installs, install);
		await rejection(first.promise);
		await quiet();
		expect(install.runs).toBe(1);
		expect(retry.settled).toBe("pending");

		await install.fail(new Error("stopped"), 0);
		await install.started(2);
		await install.finish(1);
		await retry.promise;
		expect(install.runs).toBe(2);
	});

	test("a cancelled install that stops badly does not stop the replacement from running", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("settle-later");
		const first = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		const retry = new Joiner(installs, install);
		await install.started(2);
		await install.finish(1);
		await retry.promise;
		expect(retry.settled).toBe("resolved");
	});

	test("while the replacement runs, the cancelled one stopping does not make a third joiner start a third", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("settle-later");
		const first = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		const second = new Joiner(installs, install);
		await Promise.allSettled([first.promise]);
		await install.started(2);
		await quiet();
		const third = new Joiner(installs, install);
		await quiet();
		expect(install.runs).toBe(2);
		await install.finish(1);
		await Promise.all([second.promise, third.promise]);
	});

	test("the replacement is itself cancellable before the old install has stopped, and then never begins", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall("ignore");
		const first = new Joiner(installs, install);
		await install.started(1);
		first.leave();
		const retry = new Joiner(installs, install);
		const reason = retry.leave(new Error("changed my mind again"));
		expect(await rejection(retry.promise)).toBe(reason);
		await install.fail(new Error("stopped"), 0);
		await quiet();
		expect(install.runs).toBe(1);
	});
});

describe("a signal that is already aborted", () => {
	test("is refused with its reason before any install starts", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		const error = await failureOf(() => installs.join("k", install.start, () => {}, controller.signal));
		expect(error).toBe(reason);
		await quiet();
		expect(install.runs).toBe(0);
	});

	test("does not disturb an install that is already running for someone else", async () => {
		const installs = new SharedInstalls();
		const install = new ControlledInstall();
		const running = new Joiner(installs, install);
		await install.progress(0.4);
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		const heard: number[] = [];
		await failureOf(() => installs.join("root\nqwen3-tts", install.start, fraction => heard.push(fraction), controller.signal));
		await install.progress(0.8);
		await install.finish();
		await running.promise;
		expect(heard).toEqual([]);
		expect(install.runs).toBe(1);
		expect(install.signal()?.aborted).toBe(false);
	});
});
