import { afterEach, describe, expect, test } from "bun:test";
import { Harness } from "./support.js";
import { EventLog, frames, hangUpAll, INSTRUCTIONS, makeLiveRig, openConverse, pcm, SIGNED_URL, startCall } from "./live-support.js";
import { settle, withTimeout } from "./support.js";

const harness = new Harness();
afterEach(async () => {
	hangUpAll();
	await harness.dispose();
});

describe("the handshake", () => {
	test("introduces the call with exactly the three overridable fields, and reads the audio rates from the metadata", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig, { voice: "voice-xyz" }, "pcm_16000");

		expect(socket.frames).toEqual([
			{
				type: "conversation_initiation_client_data",
				conversation_config_override: {
					agent: { first_message: "", prompt: { prompt: INSTRUCTIONS } },
					tts: { voice_id: "voice-xyz" },
				},
			},
		]);
		expect(session.media).toEqual({ kind: "relay", inputRate: 16_000, outputRate: 16_000 });
	});

	test("the rates are whatever ElevenLabs says, not an assumption", async () => {
		const rig = await makeLiveRig(harness);
		const { session } = await startCall(rig, {}, "pcm_24000");
		expect(session.media).toEqual({ kind: "relay", inputRate: 24_000, outputRate: 24_000 });
	});

	test("a format the relay cannot carry fails the open instead of playing noise", async () => {
		const rig = await makeLiveRig(harness);
		const pending = openConverse(rig);
		const socket = await rig.socket();
		socket.open();
		socket.receive(frames.metadata("ulaw_8000"));

		await expect(pending).rejects.toThrow("audio format");
		expect(socket.closedByClient).toBe(true);
	});

	test("the voice defaults, and a model the agent cannot speak with is refused before anything is minted", async () => {
		const rig = await makeLiveRig(harness);
		const { socket } = await startCall(rig);
		const override = socket.frames[0]?.conversation_config_override as { tts: { voice_id: string } };
		expect(override.tts.voice_id).toBe("EXAVITQu4vr4xnSDxMaL");

		const before = rig.api.requests.length;
		await expect(openConverse(rig, { model: "eleven_flash_v2_5" })).rejects.toThrow("eleven_v4_turbo or eleven_v4");
		expect(rig.api.requests).toHaveLength(before);
	});

	test("an override ElevenLabs refuses before the call starts rejects the open naming the field", async () => {
		const rig = await makeLiveRig(harness);
		const pending = openConverse(rig);
		const socket = await rig.socket();
		socket.open();
		socket.serverClose(1008, "Override for field 'stability' is not allowed by config.");

		const error = await pending.then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);
		expect(error?.message).toContain('"stability"');
		expect(error?.message).not.toContain("SIG-SECRET");
	});

	test("a socket that never comes up rejects the open without quoting the signed URL", async () => {
		const rig = await makeLiveRig(harness);
		const pending = openConverse(rig);
		const socket = await rig.socket();
		socket.onerror?.(new Error(`connect failed ${SIGNED_URL}`));

		const error = await pending.then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);
		expect(error?.message).toContain("Could not reach");
		expect(error?.message).not.toContain("SIG-SECRET");
	});

	test("an aborted signal closes the half-open socket", async () => {
		const rig = await makeLiveRig(harness);
		const controller = new AbortController();
		const pending = openConverse(rig, {}, { signal: controller.signal });
		const socket = await rig.socket();
		socket.open();
		controller.abort(new Error("hung up"));

		await expect(pending).rejects.toThrow("hung up");
		expect(socket.closedByClient).toBe(true);
	});
});

describe("what the agent sends becomes neutral events", () => {
	test("the voice: audio keeps its bytes and its rate, and the first frame moves the phase to speaking", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		const bytes = pcm(640, 3);
		socket.receive(frames.audio(bytes));
		await settle();

		const audio = log.of("audio");
		expect(audio).toHaveLength(1);
		expect(Array.from(audio[0]?.pcm ?? [])).toEqual(Array.from(bytes));
		expect(audio[0]?.rate).toBe(16_000);
		expect(log.phases).toEqual(["listening", "speaking"]);
	});

	test("transcripts: the user's words and the agent's, numbered per role", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(frames.user("what is the build doing"));
		socket.receive(frames.agent("Let me look.", "r1"));
		socket.receive(frames.user("thanks"));
		socket.receive(frames.agent("Any time.", "r2"));
		await settle();

		expect(log.of("transcript")).toEqual([
			{ t: "transcript", role: "user", text: "what is the build doing", turn: 1, final: true },
			{ t: "transcript", role: "assistant", text: "Let me look.", turn: 1, final: true },
			{ t: "transcript", role: "user", text: "thanks", turn: 2, final: true },
			{ t: "transcript", role: "assistant", text: "Any time.", turn: 2, final: true },
		]);
	});

	test("a correction replaces the response it names with what was heard, even an empty heard prefix", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(frames.agent("Okay, it looks like the retry helper never backs off.", "r1"));
		socket.receive(frames.agent("I have asked the agent.", "r2"));
		socket.receive(frames.interruption());
		socket.receive(frames.correction("Okay, it looks like the retry helper never backs off.", "Okay, it looks like...", "r1"));
		socket.receive(frames.correction("I have asked the agent.", "", "r2"));
		await settle();

		const assistant = log.of("transcript").filter(event => event.role === "assistant");
		expect(assistant.map(({ text, turn }) => ({ text, turn }))).toEqual([
			{ text: "Okay, it looks like the retry helper never backs off.", turn: 1 },
			{ text: "I have asked the agent.", turn: 2 },
			{ text: "Okay, it looks like...", turn: 1 },
			{ text: "", turn: 2 },
		]);
		expect(assistant.every(event => event.final)).toBe(true);
	});

	test("an interruption tells the client to flush playback, once per interruption", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(frames.audio(pcm(64)));
		socket.receive(frames.interruption());
		socket.receive(frames.audio(pcm(64, 9), 2));
		socket.receive(frames.interruption());
		await settle();

		expect(log.events.map(event => event.t)).toEqual(["phase", "phase", "audio", "phase", "interrupt", "phase", "audio", "phase", "interrupt"]);
	});

	test("a delegation becomes a delegate event with the tool call id, and the platform is told it started", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(frames.tool("call-7", { task: "  check the retry helper  " }));
		await settle();

		expect(log.of("delegate")).toEqual([{ t: "delegate", id: "call-7", task: "check the retry helper" }]);
		expect(socket.framesOfType("client_tool_result")).toEqual([
			{ type: "client_tool_result", tool_call_id: "call-7", result: "started", is_error: false },
		]);
		expect(log.phases.at(-1)).toBe("working");
	});

	test.each([
		{ name: "no task", call: frames.tool("c1", {}), why: "task is required" },
		{ name: "a blank task", call: frames.tool("c1", { task: "   " }), why: "task is required" },
		{ name: "an unknown tool", call: frames.tool("c1", { task: "x" }, "rm_rf"), why: "unknown tool" },
	])("$name is answered as a tool error and never reaches the session", async ({ call, why }) => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(call);
		await settle();

		expect(log.of("delegate")).toEqual([]);
		expect(socket.framesOfType("client_tool_result")).toEqual([{ type: "client_tool_result", tool_call_id: "c1", result: why, is_error: true }]);
	});

	test("pings are answered with the event id: at once when ping_ms is null, after ping_ms otherwise", async () => {
		const rig = await makeLiveRig(harness);
		const { socket } = await startCall(rig);
		socket.receive(frames.ping(2, null));
		const first = await socket.whenSent("pong");
		expect(first).toEqual({ type: "pong", event_id: 2 });

		socket.receive(frames.ping(3, 80));
		// `ping_ms` is the server's measured round trip; the pong is held back by that long, not sent at once.
		expect(socket.framesOfType("pong")).toHaveLength(1);
		const second = await socket.whenSent("pong", 1);
		expect(second).toEqual({ type: "pong", event_id: 3 });
	});

	test("frames it does not know, and a frame that is not JSON, are ignored", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive({ type: "vad_score", vad_score_event: { vad_score: 0.2 } });
		socket.onmessage?.({ data: "not json" });
		await settle();
		expect(log.events.map(event => event.t)).toEqual(["phase"]);
	});

	test("an error frame from the agent surfaces as an error event and the call stays up", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive({ type: "error", message: "agent exploded" });
		await settle();
		expect(log.of("error")).toEqual([{ t: "error", message: "agent exploded" }]);
		expect(log.of("end")).toEqual([]);
	});
});

describe("the microphone", () => {
	test("PCM goes up as base64 in the user_audio_chunk frame, untouched", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig);
		const chunk = pcm(3200, 5);
		session.pushAudio?.(chunk);

		const sent = socket.frames.at(-1) as { user_audio_chunk: string };
		expect(Array.from(Buffer.from(sent.user_audio_chunk, "base64"))).toEqual(Array.from(chunk));
	});

	test("a muted call forwards nothing, shows muted, and forwards again when unmuted", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket, log } = await startCall(rig);
		const before = socket.sent.length;
		session.mute(true);
		session.pushAudio?.(pcm(3200));
		expect(socket.sent).toHaveLength(before);

		session.mute(false);
		session.pushAudio?.(pcm(3200));
		expect(socket.sent).toHaveLength(before + 1);
		await settle();
		expect(log.phases).toEqual(["listening", "muted", "listening"]);
	});

	test("an empty chunk is not sent", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig);
		const before = socket.sent.length;
		session.pushAudio?.(new Uint8Array(0));
		expect(socket.sent).toHaveLength(before);
	});
});

describe("progress and the final answer", () => {
	test("progress is a quiet contextual update with one stable id, sent even while the agent is speaking", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig);
		socket.receive(frames.audio(pcm(64)));
		await settle();
		session.progress("call-1", "reading the client file");
		session.progress("call-1", "running the tests");

		expect(socket.framesOfType("contextual_update")).toEqual([
			{ type: "contextual_update", text: "Progress: reading the client file", context_id: "progress" },
			{ type: "contextual_update", text: "Progress: running the tests", context_id: "progress" },
		]);
		expect(socket.framesOfType("user_message")).toEqual([]);
	});

	test("an idle agent hears the final at once, exactly as the engine wrapped it", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig);
		const text = "Agent Final Message:\n\nThe retry helper never backs off.";
		session.final("call-1", text);
		expect(socket.framesOfType("user_message")).toEqual([{ type: "user_message", text }]);
	});

	test("a final waits for the agent to finish speaking: audio, then agent_response_complete", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 5_000 });
		const { session, socket } = await startCall(rig);
		socket.receive(frames.audio(pcm(64)));
		await settle();
		session.final("call-1", "Agent Final Message:\n\nDone.");
		await settle();
		expect(socket.framesOfType("user_message")).toEqual([]);

		socket.receive(frames.complete());
		await settle();
		expect(socket.framesOfType("user_message")).toEqual([{ type: "user_message", text: "Agent Final Message:\n\nDone." }]);
	});

	test("the wait is bounded: an interruption that nobody answers cannot hold a final forever", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 50 });
		const { session, socket } = await startCall(rig);
		socket.receive(frames.interruption());
		await settle();
		session.final("call-1", "Agent Final Message:\n\nDone.");
		expect(socket.framesOfType("user_message")).toEqual([]);

		const sent = await socket.whenSent("user_message");
		expect(sent.text).toBe("Agent Final Message:\n\nDone.");
	});

	// Real timers below: what is under test IS elapsed time against audio that arrives faster than it plays.
	test("audio that is provably still playing extends the hold, and with no agent_response_complete the agent is quiet once it has played out", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 100 });
		const { session, socket, log } = await startCall(rig);
		// 0.25 s of PCM16 at 16 kHz, delivered at once: the plain 100 ms hold would cut it off.
		socket.receive(frames.audio(pcm(8_000)));
		await settle();
		const calledAt = performance.now();
		session.final("call-1", "Agent Final Message:\n\nDone.");

		await socket.whenSent("user_message");
		expect(performance.now() - calledAt).toBeGreaterThanOrEqual(200);
		expect(log.phases).toEqual(["listening", "speaking", "listening"]);
	});

	test("but never indefinitely: a monologue does not hold the final past the hard cap", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 50 });
		const { session, socket } = await startCall(rig);
		// Ten seconds of speech on the wire; the cap is four holds.
		socket.receive(frames.audio(pcm(320_000)));
		await settle();
		const calledAt = performance.now();
		session.final("call-1", "Agent Final Message:\n\nDone.");

		await socket.whenSent("user_message");
		const waited = performance.now() - calledAt;
		expect(waited).toBeGreaterThanOrEqual(150);
		expect(waited).toBeLessThan(2_000);
	});

	test("the user talking over the agent is not talked over in turn: the final waits for the answer to them", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 5_000 });
		const { session, socket } = await startCall(rig);
		socket.receive(frames.audio(pcm(64)));
		socket.receive(frames.interruption());
		await settle();
		session.final("call-1", "Agent Final Message:\n\nDone.");
		await settle();
		expect(socket.framesOfType("user_message")).toEqual([]);

		socket.receive(frames.user("hold on"));
		socket.receive(frames.audio(pcm(64), 2));
		socket.receive(frames.complete());
		await settle();
		expect(socket.framesOfType("user_message")).toHaveLength(1);
	});

	test("finals that pile up while the agent is busy go out as one message, in order", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 5_000 });
		const { session, socket } = await startCall(rig);
		socket.receive(frames.audio(pcm(64)));
		await settle();
		session.final("a", "Agent Final Message:\n\nfirst");
		session.final("b", "Agent Final Message:\n\nsecond");
		socket.receive(frames.complete());
		await settle();

		expect(socket.framesOfType("user_message")).toEqual([
			{ type: "user_message", text: "Agent Final Message:\n\nfirst\n\nAgent Final Message:\n\nsecond" },
		]);
	});

	test("a second final right after the first waits for the reply to the first instead of cutting it off", async () => {
		const rig = await makeLiveRig(harness, { finalHoldMs: 5_000 });
		const { session, socket } = await startCall(rig);
		session.final("a", "Agent Final Message:\n\nfirst");
		session.final("b", "Agent Final Message:\n\nsecond");
		expect(socket.framesOfType("user_message").map(frame => frame.text)).toEqual(["Agent Final Message:\n\nfirst"]);

		socket.receive(frames.audio(pcm(64)));
		socket.receive(frames.complete());
		await settle();
		expect(socket.framesOfType("user_message").map(frame => frame.text)).toEqual([
			"Agent Final Message:\n\nfirst",
			"Agent Final Message:\n\nsecond",
		]);
	});
});

describe("phases follow the work", () => {
	test("listening, working while a delegation is out, speaking when it is answered, listening again after", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket, log } = await startCall(rig);
		socket.receive(frames.tool("call-1", { task: "check it" }));
		socket.receive(frames.audio(pcm(64)));
		socket.receive(frames.complete());
		session.final("call-1", "Agent Final Message:\n\nok");
		socket.receive(frames.audio(pcm(64), 2));
		socket.receive(frames.complete());
		await settle();

		expect(log.phases).toEqual(["listening", "working", "speaking", "working", "listening", "speaking", "listening"]);
	});

	test("one final answers the whole run: a delegation the agent steered in after the first is closed with it", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket, log } = await startCall(rig);
		socket.receive(frames.tool("a", { task: "fix the retry bug" }));
		socket.receive(frames.tool("b", { task: "and the timeout" }));
		await settle();
		// The engine addresses the newest delegation of the run; the older one is answered by the same final.
		session.final("b", "Agent Final Message:\n\nBoth done.");
		socket.receive(frames.audio(pcm(64)));
		socket.receive(frames.complete());
		await settle();

		expect(log.phases).toEqual(["listening", "working", "listening", "speaking", "listening"]);
	});
});

describe("a long call", () => {
	test("every audio frame re-arms the speaking timer, and the cancelled ones are released rather than kept for the life of the call", async () => {
		const created: WeakRef<object>[] = [];
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = realSetTimeout(...args);
			created.push(new WeakRef(timer));
			return timer;
		}) as typeof setTimeout;
		try {
			const rig = await makeLiveRig(harness);
			const { socket } = await startCall(rig);
			const frameCount = 3_000;
			for (let i = 0; i < frameCount; i++) socket.receive(frames.audio(pcm(320), i));
			await settle();
			Bun.gc(true);

			// Without the release, each of the frames leaves its cancelled timer behind.
			const retained = created.filter(ref => ref.deref() !== undefined).length;
			expect(created.length).toBeGreaterThanOrEqual(frameCount);
			expect(retained).toBeLessThan(50);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});
});

describe("how a call ends", () => {
	test("ElevenLabs closing normally is a provider end, with nothing before it but the events already sent", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.receive(frames.user("bye"));
		socket.serverClose(1000);
		const events = await log.settled();

		expect(events.map(event => event.t)).toEqual(["phase", "transcript", "end"]);
		expect(log.of("end")).toEqual([{ t: "end", reason: "provider" }]);
	});

	test("hanging up ends the call once, as a client end, and closes the socket", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket, log } = await startCall(rig);
		session.close();
		session.close();
		const events = await log.settled();

		expect(events.filter(event => event.t === "end")).toEqual([{ t: "end", reason: "client" }]);
		expect(socket.closedByClient).toBe(true);
		// Whatever the socket reports after the hang-up changes nothing.
		socket.serverClose(1006);
		await settle();
		expect(log.events.filter(event => event.t === "end")).toHaveLength(1);
		expect(log.of("error")).toEqual([]);
	});

	test("nothing is delivered or sent after the end", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket, log } = await startCall(rig);
		session.close();
		const sent = socket.sent.length;
		socket.receive(frames.audio(pcm(64)));
		session.pushAudio?.(pcm(3200));
		session.progress("x", "late");
		session.final("x", "late");
		await log.settled();

		expect(socket.sent).toHaveLength(sent);
		expect(log.of("audio")).toEqual([]);
	});

	test("a refused override (close code 1008) is an error that names the field, then the end", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.serverClose(1008, "Override for field 'stability' is not allowed by config.");
		const events = await log.settled();

		expect(events.map(event => event.t)).toEqual(["phase", "error", "end"]);
		expect(log.of("error")[0]?.message).toContain('"stability"');
		expect(log.of("end")).toEqual([{ t: "end", reason: "error" }]);
	});

	test.each([1006, 1011])("any other close code (%i) is an error, then an error end", async code => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.serverClose(code, "gone");
		await log.settled();

		expect(log.of("error")[0]?.message).toContain(String(code));
		expect(log.of("end")).toEqual([{ t: "end", reason: "error" }]);
	});

	test("a socket error mid-call is not an end by itself: the close that follows ends it, once, with its code", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.onerror?.(new Error("reset"));
		await settle();
		expect(log.of("end")).toEqual([]);

		socket.serverClose(1006);
		await log.settled();
		expect(log.of("end")).toEqual([{ t: "end", reason: "error" }]);
		expect(log.of("error")).toHaveLength(1);
	});

	test("the iterable completes after the end, so a consumer's loop exits", async () => {
		const rig = await makeLiveRig(harness);
		const { session, socket } = await startCall(rig);
		const log = new EventLog(session);
		socket.serverClose(1000);
		await withTimeout(log.settled(), "the loop to exit");
	});
});
