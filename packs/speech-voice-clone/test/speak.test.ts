import { afterEach, describe, expect, test } from "bun:test";
import type { WorkerLease } from "../src/runtime.js";
import { EventChannel } from "../src/speak.js";
import {
	audioBytes,
	BREEZE,
	CHATTERBOX,
	closeSessions,
	type FakeCall,
	FakeLiveWorker,
	FISH,
	makeSession,
	ofType,
	pcmOf,
	pcmSeconds,
	QWEN,
	quiet,
	REGISTRY,
	speaksSeconds,
	VOICE,
	VOXCPM,
	waitFor,
} from "./support.js";

afterEach(() => closeSessions());

const RATE = QWEN.sampleRate;

function callAt(worker: FakeLiveWorker, index: number): FakeCall {
	const call = worker.calls[index];
	if (!call) throw new Error(`the worker has not been asked for utterance ${index + 1}`);
	return call;
}

async function nextCall(worker: FakeLiveWorker, index: number): Promise<FakeCall> {
	await waitFor(() => worker.calls.length > index, `utterance ${index + 1} to reach the worker`);
	return callAt(worker, index);
}

async function finishNext(worker: FakeLiveWorker, index: number, seconds: number, rate = RATE): Promise<void> {
	const call = await nextCall(worker, index);
	call.emit(pcmSeconds(seconds, rate, index));
	call.finish();
}

function failingOn(marker: string, seconds = 0.5, rate = RATE): (call: FakeCall) => void {
	return call => {
		if (call.text.includes(marker)) call.fail(`RuntimeError: ${marker}`);
		else speaksSeconds(seconds, rate)(call);
	};
}

describe("EventChannel", () => {
	test("hands events to a consumer in emit order, whether it started before or after them", async () => {
		const channel = new EventChannel<number>();
		channel.emit(1);
		channel.emit(2);
		const seen: number[] = [];
		const consumer = (async () => {
			for await (const value of channel) seen.push(value);
		})();
		await quiet();
		channel.emit(3);
		await quiet();
		channel.close();
		await consumer;
		expect(seen).toEqual([1, 2, 3]);
	});

	test("close wakes a waiting consumer, still delivers what was queued, and drops anything emitted later", async () => {
		const channel = new EventChannel<string>();
		channel.emit("a");
		channel.close();
		channel.emit("late");
		const seen: string[] = [];
		for await (const value of channel) seen.push(value);
		expect(seen).toEqual(["a"]);

		const waiting = new EventChannel<string>();
		const consumer = (async () => {
			for await (const _ of waiting);
			return "done";
		})();
		await quiet();
		waiting.close();
		expect(await consumer).toBe("done");
	});
});

describe("one reply", () => {
	test("segments become audio then caption words, in order, and flush ends the reply", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Hello world.");
		session.push("Second one here.");
		session.flush();
		await finishNext(worker, 0, 1);
		await finishNext(worker, 1, 0.5);
		await recorder.untilEnds(1);

		expect(recorder.kinds).toEqual(["audio", "words", "audio", "words", "end"]);
		expect(worker.calls.map(call => call.text)).toEqual(["Hello world.", "Second one here."]);
		expect(audioBytes(recorder.events)).toEqual(new Uint8Array(Buffer.concat([pcmSeconds(1, RATE, 0), pcmSeconds(0.5, RATE, 1)])));
		expect(ofType(recorder.events, "words").map(event => event.words.map(word => word.w))).toEqual([
			["Hello", "world."],
			["Second", "one", "here."],
		]);
	});

	test("the worker gets one segment at a time, in push order, even when the first is slow", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("One.");
		session.push("Two.");
		session.push("Three.");
		session.flush();
		await quiet();
		expect(worker.calls.map(call => call.text)).toEqual(["One."]);
		expect(recorder.events).toEqual([]);

		await finishNext(worker, 0, 0.1);
		await quiet();
		expect(worker.calls.map(call => call.text)).toEqual(["One.", "Two."]);

		await finishNext(worker, 1, 0.1);
		await finishNext(worker, 2, 0.1);
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["One.", "Two.", "Three."]);
		expect(worker.maxInFlight).toBe(1);
		expect(recorder.kinds).toEqual(["audio", "words", "audio", "words", "audio", "words", "end"]);
	});

	test("audio streams out as the worker produces it, before the segment is finished", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Streaming text.");
		const call = await nextCall(worker, 0);
		call.emit(pcmOf(100, 1));
		call.emit(pcmOf(200, 2));
		expect(recorder.kinds).toEqual([]);
		await recorder.until(events => events.length === 2, "two audio events");
		expect(recorder.kinds).toEqual(["audio", "audio"]);
		call.emit(pcmOf(50, 3));
		call.finish();
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["audio", "audio", "audio", "words", "end"]);
		expect(audioBytes(recorder.events)).toEqual(new Uint8Array(Buffer.concat([pcmOf(100, 1), pcmOf(200, 2), pcmOf(50, 3)])));
	});

	test("an empty audio chunk is not an audio event", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Hello there.");
		const call = await nextCall(worker, 0);
		call.emit(new Uint8Array(0));
		call.emit(pcmOf(10));
		call.emit(new Uint8Array(0));
		call.finish();
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["audio", "words", "end"]);
	});

	test("every flush is answered by exactly one end, and only after the audio it closes", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("First reply.");
		session.flush();
		await quiet();
		expect(recorder.count("end")).toBe(0);
		await finishNext(worker, 0, 0.2);
		await recorder.untilEnds(1);
		await quiet();
		expect(recorder.kinds).toEqual(["audio", "words", "end"]);

		session.push("Second reply.");
		session.flush();
		await finishNext(worker, 1, 0.2);
		await recorder.untilEnds(2);
		await quiet();
		expect(recorder.kinds).toEqual(["audio", "words", "end", "audio", "words", "end"]);
	});

	test("flush with nothing to say still answers with an end, so a caller waiting on it never hangs", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["end"]);
		expect(worker.calls).toHaveLength(0);
	});

	test("segments with nothing to speak (blank, emoji, tag-only) never reach the worker, and the reply still ends", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		const { session, recorder } = makeSession({ worker });
		session.push("   ");
		session.push("\ud83c\udf89");
		session.push("[whisper]");
		session.push("");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls).toHaveLength(0);
		expect(recorder.kinds).toEqual(["end"]);
	});

	test("session.sampleRate is the model's rate", () => {
		for (const model of REGISTRY.models) {
			expect(makeSession({ model }).session.sampleRate).toBe(model.sampleRate);
		}
		expect(makeSession({ model: VOXCPM }).session.sampleRate).toBe(48000);
		expect(makeSession({ model: FISH }).session.sampleRate).toBe(44100);
	});

	test("the worker is given the chosen voice and the profile's options untouched", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.1, RATE));
		const options = { seed: 7, instruction: "Dry and unhurried." };
		const { session, recorder } = makeSession({ worker, options });
		session.push("Hello there.");
		session.flush();
		await recorder.untilEnds(1);
		expect(callAt(worker, 0).voice).toBe(VOICE);
		expect(callAt(worker, 0).options).toEqual(options);
	});
});

describe("captions", () => {
	test("words run on one timeline across a reply's segments, measured from the PCM actually produced", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Hello world.");
		session.push("Next one.");
		session.flush();
		await finishNext(worker, 0, 1);
		await finishNext(worker, 1, 0.5);
		await recorder.untilEnds(1);

		const [first, second] = ofType(recorder.events, "words").map(event => event.words);
		expect(first?.[0]?.s).toBe(0);
		expect(first?.at(-1)?.e).toBeCloseTo(1, 3);
		expect(second?.[0]?.s).toBeCloseTo(1, 3);
		expect(second?.at(-1)?.e).toBeCloseTo(1.5, 3);
	});

	test("duration is samples over the model's sample rate", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker, model: VOXCPM });
		session.push("Hello world.");
		session.flush();
		await finishNext(worker, 0, 2, VOXCPM.sampleRate);
		await recorder.untilEnds(1);
		expect(ofType(recorder.events, "words")[0]?.words.at(-1)?.e).toBeCloseTo(2, 3);
	});

	test("the next reply starts its own timeline at zero", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("First reply.");
		session.flush();
		await finishNext(worker, 0, 3);
		await recorder.untilEnds(1);
		session.push("Second reply.");
		session.flush();
		await finishNext(worker, 1, 1);
		await recorder.untilEnds(2);
		const [first, second] = ofType(recorder.events, "words").map(event => event.words);
		expect(first?.at(-1)?.e).toBeCloseTo(3, 3);
		expect(second?.[0]?.s).toBe(0);
		expect(second?.at(-1)?.e).toBeCloseTo(1, 3);
	});

	test("captions never carry tags, and what the model was told to say is not what is captioned", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(1, BREEZE.sampleRate));
		const { session, recorder } = makeSession({ worker, model: BREEZE });
		session.push("Okay [laughs] then [whisper] fine.");
		session.flush();
		await recorder.untilEnds(1);
		expect(callAt(worker, 0).text).toBe("Okay (laugh) then fine.");
		expect(ofType(recorder.events, "words")[0]?.words.map(word => word.w)).toEqual(["Okay", "then", "fine."]);
	});

	test("brackets are kept for the model but never shown", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(1, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("[whisper] Come closer.");
		session.flush();
		await recorder.untilEnds(1);
		expect(callAt(worker, 0).text).toBe("[whisper] Come closer.");
		expect(ofType(recorder.events, "words")[0]?.words.map(word => word.w)).toEqual(["Come", "closer."]);
	});
});

describe("held audio tags", () => {
	test("a tag-only segment is held and leads the next one when the model performs tags", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("[whisper]");
		await quiet();
		expect(worker.calls).toHaveLength(0);
		session.push("Hello there.");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["[whisper] Hello there."]);
	});

	test("several tag-only segments pile up in order before the words they direct", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("Hello.");
		session.push("[whisper]");
		session.push("[sad]");
		session.push("Goodbye.");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["Hello.", "[whisper] [sad] Goodbye."]);
	});

	test("Breeze performs a held sound; a bracket it cannot perform is dropped, not held", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, BREEZE.sampleRate));
		const { session, recorder } = makeSession({ worker, model: BREEZE });
		session.push("[laughs]");
		session.push("Okay.");
		session.push("[whisper]");
		session.push("Fine.");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["(laugh) Okay.", "Fine."]);
	});

	test("when tags are not allowed, a tag-only segment vanishes and never leaks into the next segment", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH, audioTags: false });
		session.push("[whisper]");
		session.push("[sad] Hello there.");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["Hello there."]);
	});

	test("a model without tags strips them everywhere", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		const { session, recorder } = makeSession({ worker, model: QWEN, audioTags: true });
		session.push("[whisper]");
		session.push("Hello [sad] there.");
		session.flush();
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["Hello there."]);
	});

	test("held tags do not survive the end of the reply", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("[whisper]");
		session.flush();
		await recorder.untilEnds(1);
		session.push("Next reply.");
		session.flush();
		await recorder.untilEnds(2);
		expect(worker.calls.map(call => call.text)).toEqual(["Next reply."]);
	});

	test("held tags do not survive a cancel", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, FISH.sampleRate));
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("[whisper]");
		session.cancel();
		session.push("Hello.");
		session.flush();
		await recorder.untilEnds(2);
		expect(worker.calls.map(call => call.text)).toEqual(["Hello."]);
	});

	test("a tag-only segment makes no sound, no caption and no error", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker, model: FISH });
		session.push("[whisper]");
		session.push("[sad]");
		await quiet();
		expect(recorder.events).toEqual([]);
		expect(worker.calls).toHaveLength(0);
	});
});

describe("failure", () => {
	test("reports error instead of end, drops the rest of that reply, and speaks the next reply normally", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder } = makeSession({ worker });
		session.push("One.");
		session.push("a boom");
		session.push("Three.");
		session.flush();
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		await quiet();
		expect(recorder.kinds).toEqual(["audio", "words", "error"]);
		expect(ofType(recorder.events, "error")[0]?.message).toBe("RuntimeError: boom");
		expect(worker.calls.map(call => call.text)).toEqual(["One.", "a boom"]);

		session.push("Next reply.");
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["audio", "words", "error", "audio", "words", "end"]);
		expect(worker.calls.map(call => call.text)).toEqual(["One.", "a boom", "Next reply."]);
	});

	test("the next reply is already queued behind the failing one: still spoken, still ended", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder } = makeSession({ worker });
		session.push("a boom");
		session.push("Dropped.");
		session.flush();
		session.push("Second reply.");
		session.flush();
		await recorder.untilEnds(1);
		await quiet();
		expect(recorder.kinds).toEqual(["error", "audio", "words", "end"]);
		expect(worker.calls.map(call => call.text)).toEqual(["a boom", "Second reply."]);
	});

	test("one failure is one error, however many segments were queued behind it", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder } = makeSession({ worker });
		for (const text of ["a boom", "Two.", "Three.", "Four."]) session.push(text);
		session.flush();
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		await quiet();
		expect(recorder.count("error")).toBe(1);
		expect(recorder.count("end")).toBe(0);
	});

	test("a model that cannot load is an error for that reply, and the next reply tries again", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		let attempts = 0;
		const { session, recorder, leases } = makeSession({
			worker,
			lease: (_signal, ledger) => {
				attempts++;
				return attempts <= 2 ? Promise.reject(new Error("Qwen3-TTS failed to load: CUDA is not available")) : Promise.resolve(ledger.grant(worker));
			},
		});
		session.push("First.");
		session.flush();
		await recorder.until(events => events.some(event => event.t === "error"), "the load error");
		expect(ofType(recorder.events, "error")[0]?.message).toBe("Qwen3-TTS failed to load: CUDA is not available");
		expect(recorder.count("end")).toBe(0);

		session.push("Second.");
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["error", "audio", "words", "end"]);
		expect(leases.requested).toBe(3);
		expect(worker.calls.map(call => call.text)).toEqual(["Second."]);
	});

	test("a dead worker that refuses the request synchronously is reported like any other failure", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		worker.speakThrows = new Error("Qwen3-TTS stopped (exit 3): no cuda here");
		const { session, recorder } = makeSession({ worker });
		session.push("Hello.");
		session.flush();
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		expect(ofType(recorder.events, "error")[0]?.message).toBe("Qwen3-TTS stopped (exit 3): no cuda here");
		await quiet();
		expect(recorder.count("end")).toBe(0);
	});

	test("a rejection that is not an Error is reported by its text", async () => {
		const { session, recorder } = makeSession({ lease: () => Promise.reject("plain failure text") });
		session.push("Hello.");
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		expect(ofType(recorder.events, "error")[0]?.message).toBe("plain failure text");
	});

	test("a failed utterance is over: a later cancel does not ask the worker to cancel it again", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder } = makeSession({ worker });
		session.push("a boom");
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		session.cancel();
		expect(worker.cancels).toEqual([]);
	});
});

describe("cancel", () => {
	test("drops what is queued and in flight, answers with a single end, and ignores the cancelled utterance's late output", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("One.");
		session.push("Two.");
		session.push("Three.");
		const first = await nextCall(worker, 0);
		first.emit(pcmOf(10, 1));
		await recorder.until(events => events.length === 1, "the first audio");

		session.cancel();
		expect(worker.cancels).toEqual([1]);
		first.emit(pcmOf(10, 2));
		first.finish();
		await quiet();

		expect(worker.calls).toHaveLength(1);
		expect(recorder.kinds).toEqual(["audio", "end"]);
	});

	test("cancelling with nothing going on is still answered by one end and bothers no worker", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.cancel();
		await recorder.untilEnds(1);
		await quiet();
		expect(recorder.kinds).toEqual(["end"]);
		expect(worker.cancels).toEqual([]);
	});

	test("each cancel gets its own end", async () => {
		const { session, recorder } = makeSession();
		session.cancel();
		session.cancel();
		session.cancel();
		await recorder.untilEnds(3);
		await quiet();
		expect(recorder.count("end")).toBe(3);
	});

	test("the session speaks the next reply normally after a cancel, and its captions start at zero", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Spoken before the barge.");
		await finishNext(worker, 0, 2);
		await recorder.until(events => events.some(event => event.t === "words"), "the first words");
		session.push("Cut off.");
		const cutOff = await nextCall(worker, 1);
		session.cancel();
		cutOff.finish();

		session.push("After the barge.");
		session.flush();
		await finishNext(worker, 2, 1);
		await recorder.untilEnds(2);

		expect(recorder.kinds).toEqual(["audio", "words", "end", "audio", "words", "end"]);
		const [before, after] = ofType(recorder.events, "words").map(event => event.words);
		expect(before?.[0]?.s).toBe(0);
		expect(after?.[0]?.s).toBe(0);
		expect(after?.at(-1)?.e).toBeCloseTo(1, 3);
		expect(worker.calls.map(call => call.text)).toEqual(["Spoken before the barge.", "Cut off.", "After the barge."]);
	});

	test("text pushed right after a cancel waits for the cancelled utterance to leave the worker", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Old.");
		const old = await nextCall(worker, 0);
		session.cancel();
		session.push("New.");
		session.flush();
		await quiet();
		expect(worker.calls).toHaveLength(1);

		old.finish();
		await finishNext(worker, 1, 0.2);
		await recorder.untilEnds(2);
		expect(worker.maxInFlight).toBe(1);
		expect(recorder.kinds).toEqual(["end", "audio", "words", "end"]);
	});

	test("a cancel that overtakes a pending flush answers for it with one end, not two", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Hello.");
		await nextCall(worker, 0);
		session.flush();
		session.cancel();
		callAt(worker, 0).finish();
		await quiet();
		expect(recorder.kinds).toEqual(["end"]);
	});

	test("cancelling while the model is still loading means the segment is never sent", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		const gate = Promise.withResolvers<WorkerLease>();
		const { session, recorder } = makeSession({ worker, lease: () => gate.promise });
		session.push("Hello.");
		await quiet();
		session.cancel();
		gate.resolve({ worker: worker.asLiveWorker(), release() {} });
		await quiet();
		expect(worker.calls).toHaveLength(0);
		expect(recorder.kinds).toEqual(["end"]);
	});

	test("cancelling after a failure clears it: the next text speaks and the failed reply is not resurrected", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder } = makeSession({ worker });
		session.push("a boom");
		session.push("Dropped.");
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		session.cancel();
		session.push("Fresh.");
		session.flush();
		await recorder.untilEnds(2);
		expect(recorder.kinds).toEqual(["error", "end", "audio", "words", "end"]);
		expect(worker.calls.map(call => call.text)).toEqual(["a boom", "Fresh."]);
	});
});

describe("close", () => {
	test("ends the event stream, cancels what is in flight, and ignores everything after", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("In flight.");
		const call = await nextCall(worker, 0);
		session.close();
		expect(worker.cancels).toEqual([1]);
		await recorder.finished;

		session.push("Ignored.");
		session.flush();
		session.cancel();
		call.emit(pcmOf(10));
		call.finish();
		await quiet();
		expect(recorder.events).toEqual([]);
		expect(worker.calls).toHaveLength(1);
	});

	test("is idempotent", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("In flight.");
		await nextCall(worker, 0);
		session.close();
		session.close();
		await recorder.finished;
		expect(worker.cancels).toEqual([1]);
	});

	test("aborting the signal it was opened with closes it", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder, abort } = makeSession({ worker });
		session.push("In flight.");
		await nextCall(worker, 0);
		abort.abort();
		await recorder.finished;
		expect(worker.cancels).toEqual([1]);
		session.push("Ignored.");
		session.flush();
		await quiet();
		expect(recorder.events).toEqual([]);
		expect(worker.calls).toHaveLength(1);
	});

	test("closing mid-reply never produces an end for that reply", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder } = makeSession({ worker });
		session.push("Hello.");
		session.flush();
		const call = await nextCall(worker, 0);
		session.close();
		call.finish();
		await recorder.finished;
		expect(recorder.count("end")).toBe(0);
	});
});

describe("model loading", () => {
	test("a worker lease is requested as soon as the session opens, so the model loads while the user is still speaking", () => {
		const { leases, abort } = makeSession();
		expect(leases.requested).toBe(1);
		expect(leases.signals[0]).toBe(abort.signal);
	});

	test("that early lease is handed straight back once the model is up, so an idle session blocks nothing", async () => {
		const { leases } = makeSession();
		await quiet();
		expect(leases.granted).toBe(1);
		expect(leases.held).toBe(0);
	});

	test("a model that fails during that early load does not break the session or surface until text arrives", async () => {
		const { recorder } = makeSession({ lease: () => Promise.reject(new Error("load failed")) });
		await quiet();
		expect(recorder.events).toEqual([]);
	});

	test("a model that loads slowly delays the first segment but not its order", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		const gate = Promise.withResolvers<WorkerLease>();
		const { session, recorder } = makeSession({ worker, lease: () => gate.promise });
		session.push("First.");
		session.push("Second.");
		session.flush();
		await quiet();
		expect(worker.calls).toHaveLength(0);
		gate.resolve({ worker: worker.asLiveWorker(), release() {} });
		await recorder.untilEnds(1);
		expect(worker.calls.map(call => call.text)).toEqual(["First.", "Second."]);
	});
});

describe("holding the worker", () => {
	test("a reply takes one lease for all its segments and gives it back when the reply ends", async () => {
		const { session, recorder, leases } = makeSession();
		await quiet();
		const before = leases.requested;
		session.push("One.");
		session.push("Two.");
		session.push("Three.");
		await recorder.until(events => events.filter(event => event.t === "words").length === 3, "three segments");
		expect(leases.requested - before).toBe(1);
		expect(leases.held).toBe(1);
		session.flush();
		await recorder.untilEnds(1);
		expect(leases.held).toBe(0);
	});

	test("every reply takes its own lease, so another model can take the worker between replies", async () => {
		const { session, recorder, leases } = makeSession();
		await quiet();
		const before = leases.requested;
		for (const text of ["First reply.", "Second reply.", "Third reply."]) {
			session.push(text);
			session.flush();
		}
		await recorder.untilEnds(3);
		expect(leases.requested - before).toBe(3);
		expect(leases.held).toBe(0);
	});

	test("text with nothing to speak takes no lease", async () => {
		const { session, recorder, leases } = makeSession({ model: FISH });
		await quiet();
		const before = leases.requested;
		session.push("   ");
		session.push("[whisper]");
		session.flush();
		await recorder.untilEnds(1);
		expect(leases.requested).toBe(before);
	});

	test("a reply that is still being spoken keeps the worker: the lease is held until it ends", async () => {
		const worker = new FakeLiveWorker();
		const { session, leases } = makeSession({ worker });
		await quiet();
		session.push("Long reply.");
		await nextCall(worker, 0);
		await quiet();
		expect(leases.held).toBe(1);
	});

	test("cancelling gives the lease back at once, even though the worker is still busy with the cancelled utterance", async () => {
		const worker = new FakeLiveWorker();
		const { session, recorder, leases } = makeSession({ worker });
		await quiet();
		session.push("Barged in on.");
		await nextCall(worker, 0);
		session.cancel();
		await recorder.untilEnds(1);
		await quiet();
		expect(leases.held).toBe(0);
		expect(worker.cancels).toEqual([1]);
	});

	test("cancelling while the lease is still being waited for withdraws the request and hands the lease back if it arrives anyway", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, RATE));
		const gate = Promise.withResolvers<WorkerLease>();
		const { session, leases } = makeSession({
			worker,
			lease: (_signal, ledger) => (ledger.requested === 1 ? Promise.resolve(ledger.grant(worker)) : gate.promise.then(() => ledger.grant(worker))),
		});
		await quiet();
		session.push("Hello.");
		await waitFor(() => leases.requested === 2, "the reply's lease request");
		const waiting = leases.signals[1];
		expect(waiting?.aborted).toBe(false);
		session.cancel();
		expect(waiting?.aborted).toBe(true);
		gate.resolve({ worker: worker.asLiveWorker(), release() {} });
		await quiet();
		expect(worker.calls).toHaveLength(0);
		expect(leases.held).toBe(0);
	});

	test("a failed reply gives the lease back, and the next reply asks for a fresh one", async () => {
		const worker = new FakeLiveWorker(failingOn("boom"));
		const { session, recorder, leases } = makeSession({ worker });
		await quiet();
		const before = leases.requested;
		session.push("a boom");
		await recorder.until(events => events.some(event => event.t === "error"), "the error");
		expect(leases.held).toBe(0);
		session.flush();
		session.push("Fine.");
		session.flush();
		await recorder.untilEnds(1);
		expect(leases.requested - before).toBe(2);
		expect(leases.held).toBe(0);
	});

	test("closing mid-reply gives the lease back", async () => {
		const worker = new FakeLiveWorker();
		const { session, leases } = makeSession({ worker });
		await quiet();
		session.push("Hello.");
		await nextCall(worker, 0);
		expect(leases.held).toBe(1);
		session.close();
		await quiet();
		expect(leases.held).toBe(0);
	});

	test("aborting the session's signal gives the lease back too", async () => {
		const worker = new FakeLiveWorker();
		const { session, leases, abort } = makeSession({ worker });
		await quiet();
		session.push("Hello.");
		await nextCall(worker, 0);
		abort.abort();
		await quiet();
		expect(leases.held).toBe(0);
	});
});

describe("models in the registry", () => {
	test.each(REGISTRY.models.map(model => [model.id, model] as const))("%s: a reply speaks and ends at the model's rate", async (_id, model) => {
		const worker = new FakeLiveWorker(speaksSeconds(1, model.sampleRate));
		const { session, recorder } = makeSession({ worker, model });
		session.push("A short reply.");
		session.flush();
		await recorder.untilEnds(1);
		expect(recorder.kinds).toEqual(["audio", "words", "end"]);
		expect(ofType(recorder.events, "audio")[0]?.pcm.length).toBe(model.sampleRate * 2);
		expect(ofType(recorder.events, "words")[0]?.words.at(-1)?.e).toBeCloseTo(1, 3);
	});

	test("Chatterbox has no tags: brackets never reach it", async () => {
		const worker = new FakeLiveWorker(speaksSeconds(0.2, CHATTERBOX.sampleRate));
		const { session, recorder } = makeSession({ worker, model: CHATTERBOX });
		session.push("Oh [laughs] really?");
		session.flush();
		await recorder.untilEnds(1);
		expect(callAt(worker, 0).text).toBe("Oh really?");
	});
});
