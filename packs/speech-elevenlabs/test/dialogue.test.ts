import { afterEach, describe, expect, test } from "bun:test";
import {
	audioBytes,
	captionWords,
	collect,
	dialogueAudio,
	FINAL,
	Harness,
	jsonResponse,
	KEY,
	makeRig,
	type OpenOptions,
	ofType,
	openTracked,
	pcmBytes,
	pcmSeconds,
	type Responder,
	settle,
	UNIT_DONE,
	VOICE,
	withTimeout,
} from "./support.js";

const harness = new Harness();
afterEach(() => harness.dispose());

const HELLO = { voices: [VOICE] };
const CLOSE = { close_socket: true };
const input = (text: string) => ({ inputs: [{ text, voice_id: VOICE }], flush: true });

/** A dialogue session over a fake socket, opened the way the engine opens it. */
async function start(options: OpenOptions & { readonly respond?: Responder } = {}) {
	const rig = await makeRig(harness, options.respond ? { respond: options.respond } : {});
	const session = await openTracked(harness, rig, options);
	return { rig, session, socket: rig.network.sockets[0]! };
}

describe("connecting", () => {
	test("the socket opens with the session, before any text, with the key in a header and never in the URL", async () => {
		const { rig, socket } = await start();
		expect(rig.network.sockets).toHaveLength(1);
		expect(socket.headers["xi-api-key"]).toBe(KEY);
		expect(socket.url).not.toContain(KEY);
		expect(new URL(socket.url).searchParams.get("model_id")).toBe("eleven_v4_turbo");
		expect(socket.sent).toEqual([]);
	});

	test("frames sent before the socket opens are held and follow the hello frame, in order", async () => {
		const { session, socket } = await start();
		session.push("First.");
		session.push("Second.");
		session.flush();
		expect(socket.sent).toEqual([]);

		socket.open();
		expect(socket.frames).toEqual([HELLO, input("First. "), input("Second. "), CLOSE]);
	});

	test("once open, a pushed segment goes out at once as one flushed input", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("  Hello there.  ");
		expect(socket.frames).toEqual([HELLO, input("Hello there. ")]);
	});

	test.each([
		{
			name: "empty, blank, tag-only and emoji-only segments (tags removed)",
			audioTags: false,
			segments: ["", "   ", "[warmly]", " [warmly] [laughs] ", "🙂"],
		},
		{
			name: "empty, blank, bare-direction and emoji-only segments (tags kept: directions are held, then dropped at flush)",
			audioTags: true,
			segments: ["", "  \n ", "[laughs]", "[laughs] [sighs]", "🙂"],
		},
	])("nothing is sent for $name, and the reply then ends without waiting on the server", async ({ audioTags, segments }) => {
		const { session, socket } = await start({ audioTags });
		socket.open();
		for (const segment of segments) session.push(segment);
		session.flush();

		expect(socket.frames).toEqual([HELLO]);
		expect(await collect(session)).toEqual([{ t: "end" }]);
	});

	test("with tags on, a bare direction sends nothing and leads the next segment as one input", async () => {
		const { session, socket } = await start({ audioTags: true });
		socket.open();
		session.push("[sighs]");
		expect(socket.frames).toEqual([HELLO]);

		session.push("All right, let's begin.");
		expect(socket.frames).toEqual([HELLO, input("[sighs] All right, let's begin. ")]);
	});

	test("with tags off, an emoji-only segment sends nothing and the next segment goes out clean", async () => {
		const { session, socket } = await start({ audioTags: false });
		socket.open();
		session.push("🙂");
		session.push("Hello.");
		expect(socket.frames).toEqual([HELLO, input("Hello. ")]);
	});

	test("a segment pushed after flush is ignored", async () => {
		const { rig, session, socket } = await start();
		socket.open();
		session.push("A.");
		session.flush();
		session.push("B.");
		socket.receive(FINAL);

		expect(socket.frames).toEqual([HELLO, input("A. "), CLOSE]);
		expect(rig.network.sockets).toHaveLength(1);
		expect((await collect(session)).at(-1)).toEqual({ t: "end" });
	});
});

describe("audio", () => {
	test.each([
		{ name: "one long frame is cut into 100 ms events", frames: [10_000], events: [4_800, 4_800, 400] },
		{ name: "an exact multiple leaves no empty event", frames: [9_600], events: [4_800, 4_800] },
		{ name: "an odd trailing byte is carried into the next chunk", frames: [4_801, 3], events: [4_800, 4] },
		{ name: "carried bytes pair up across tiny frames", frames: [1, 1], events: [2] },
	])("$name", async ({ frames, events: sizes }) => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		const original = pcmBytes(frames.reduce((sum, size) => sum + size, 0));
		let offset = 0;
		for (const size of frames) {
			socket.receive(dialogueAudio(original.subarray(offset, offset + size)));
			offset += size;
		}
		socket.receive(UNIT_DONE);
		session.flush();

		const events = await collect(session);
		expect(ofType(events, "audio").map(event => event.pcm.byteLength)).toEqual([...sizes]);
		expect(audioBytes(events)).toEqual(original);
	});

	test("audio reaches the consumer as it arrives, not when the reply ends", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		const first = session.events[Symbol.asyncIterator]().next();
		socket.receive(dialogueAudio(pcmBytes(4_800)));

		const result = await withTimeout(first, "the first audio event");
		expect(result.value).toMatchObject({ t: "audio" });
	});
});

describe("caption words", () => {
	test("are tag-free and sit on the turn timeline, each fragment anchored to the audio delivered before it", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("[warmly] Hello there.");
		socket.receive(dialogueAudio(pcmSeconds(0.5), "[warmly] Hello "));
		socket.receive(dialogueAudio(pcmSeconds(0.7), "there. "));
		socket.receive(UNIT_DONE);
		session.flush();

		const events = await collect(session);
		const words = captionWords(events);
		expect(words.map(word => word.w)).toEqual(["Hello", "there."]);
		// "[warmly] " spends nine characters of the first fragment's own clock before "Hello".
		expect(words[0]!.s).toBeCloseTo(0.36, 3);
		expect(words[1]!.s).toBeCloseTo(0.5, 3);
	});

	test("a unit's last word is closed when its audio is done, so the next unit's first word does not fuse with it", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hello");
		session.push("world");
		socket.receive(dialogueAudio(pcmSeconds(0.3), "Hello"));
		socket.receive(UNIT_DONE);
		socket.receive(dialogueAudio(pcmSeconds(0.3), "world "));
		socket.receive(UNIT_DONE);
		session.flush();

		const words = captionWords(await collect(session));
		expect(words.map(word => word.w)).toEqual(["Hello", "world"]);
		expect(words[1]!.s).toBeCloseTo(0.3, 3);
	});

	test("the last word is not lost when the reply closes before its unit reports done", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hello");
		session.flush();
		socket.receive(dialogueAudio(pcmSeconds(0.3), "Hello"));
		socket.receive(FINAL);

		const events = await collect(session);
		expect(captionWords(events).map(word => word.w)).toEqual(["Hello"]);
		expect(events.at(-1)).toEqual({ t: "end" });
	});
});

describe("finishing a reply", () => {
	test("flush with text in flight asks the server to close, and its is_final ends the reply", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		session.flush();
		expect(socket.frames.at(-1)).toEqual(CLOSE);
		socket.receive(FINAL);

		const events = await collect(session);
		expect(events.map(event => event.t)).toEqual(["audio", "end"]);
		expect(socket.closed).toBe(true);
	});

	test("flush with nothing pushed ends at once and lets go of the socket", async () => {
		const { rig, session, socket } = await start();
		session.flush();

		expect(await collect(session)).toEqual([{ t: "end" }]);
		expect(socket.closed).toBe(true);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("flush after every segment's audio is complete does not wait for is_final", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("One.");
		session.push("Two.");
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		socket.receive(UNIT_DONE);
		socket.receive(UNIT_DONE);
		session.flush();

		const events = await collect(session);
		expect(events.at(-1)).toEqual({ t: "end" });
		expect(socket.frames.some(frame => "close_socket" in frame)).toBe(false);
		expect(socket.closed).toBe(true);
	});

	test("flush waits for every segment: one unit still owing keeps the reply open until is_final", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("One.");
		session.push("Two.");
		socket.receive(UNIT_DONE);
		session.flush();
		expect(socket.frames.at(-1)).toEqual(CLOSE);

		let ended = false;
		const pending = collect(session).then(events => {
			ended = true;
			return events;
		});
		await settle();
		expect(ended).toBe(false);

		socket.receive(FINAL);
		expect((await pending).at(-1)).toEqual({ t: "end" });
	});

	test("a server that hangs up after delivering everything, before is_final, still completes the reply", async () => {
		const { rig, session, socket } = await start();
		socket.open();
		session.push("Hi.");
		session.flush();
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		socket.receive(UNIT_DONE);
		socket.drop();

		const events = await collect(session);
		expect(events.map(event => event.t)).toEqual(["audio", "end"]);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("events the consumer has not read survive close() and cancel() after a normal end", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		session.flush();
		socket.receive(FINAL);
		session.close();
		session.cancel();

		expect((await collect(session)).map(event => event.t)).toEqual(["audio", "end"]);
	});

	test("close() before the reply ends completes the iterable quietly and drops the socket", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		session.close();

		expect(socket.closed).toBe(true);
		expect(await collect(session)).toEqual([]);
	});

	test("frames the client cannot use do not disturb the reply", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		socket.receive("not json");
		socket.receive({ surprise: 1 });
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		socket.receive(UNIT_DONE);
		session.flush();

		expect((await collect(session)).map(event => event.t)).toEqual(["audio", "end"]);
	});
});

describe("barge-in and abort", () => {
	test("cancel closes the socket at once, drops what the consumer has not read, and only ends", async () => {
		const { rig, session, socket } = await start();
		socket.open();
		session.push("Hello there.");
		socket.receive(dialogueAudio(pcmSeconds(0.3), "Hello there. "));
		session.cancel();
		expect(socket.closed).toBe(true);

		// Whatever the server still says is not delivered.
		socket.receive(dialogueAudio(pcmSeconds(0.3), "More "));
		socket.receive(FINAL);
		session.cancel();

		expect(await collect(session)).toEqual([{ t: "end" }]);
		// The socket reports its own close a moment later; that is not a failure to investigate.
		await settle();
		expect(rig.http.requests).toHaveLength(0);
	});

	test("aborting the signal does the same as cancel", async () => {
		const controller = new AbortController();
		const { session, socket } = await start({ signal: controller.signal });
		socket.open();
		session.push("Hi.");
		socket.receive(dialogueAudio(pcmBytes(4_800)));
		controller.abort();

		expect(socket.closed).toBe(true);
		expect(await collect(session)).toEqual([{ t: "end" }]);
	});
});

describe("failures", () => {
	test("an error frame surfaces its message, then end, and closes the socket", async () => {
		const { session, socket } = await start();
		socket.open();
		session.push("Hi.");
		socket.receive({ error: "invalid_voice_id", message: "Voice not found", code: 1008 });
		socket.receive(dialogueAudio(pcmBytes(4_800)));

		expect(await collect(session)).toEqual([{ t: "error", message: "Voice not found" }, { t: "end" }]);
		expect(socket.closed).toBe(true);
	});

	test.each([
		{
			name: "a rejected key",
			respond: () => jsonResponse({ detail: { status: "invalid_api_key", message: `key ${KEY} is invalid` } }, 401),
			says: "rejected the API key",
		},
		{
			name: "a key limited to Text to Speech (401 missing_permissions) is not blamed",
			respond: () => jsonResponse({ detail: { status: "missing_permissions" } }, 401),
			says: "refused the voice connection",
		},
		{ name: "an unreachable API", respond: () => Promise.reject(new Error(`dns failure for ${KEY}`)), says: "Could not reach ElevenLabs" },
	])("a socket that never opens is explained by one probe of the account: $name", async ({ respond, says }) => {
		const { rig, session, socket } = await start({ respond });
		socket.drop();

		const events = await collect(session);
		expect(events.map(event => event.t)).toEqual(["error", "end"]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toContain(says);
		expect(message).not.toContain(KEY);

		expect(rig.http.requests).toHaveLength(1);
		const probe = rig.http.requests[0]!;
		expect(probe.url).toBe("https://api.elevenlabs.io/v1/user");
		expect(probe.method).toBe("GET");
		expect(probe.headers.get("xi-api-key")).toBe(KEY);

		// Dead now: a late segment reopens nothing.
		session.push("late");
		expect(rig.network.sockets).toHaveLength(1);
	});

	test("cancelling while the probe is out ends at once, and the probe's answer adds nothing", async () => {
		const answer = Promise.withResolvers<Response>();
		const { rig, session, socket } = await start({ respond: () => answer.promise });
		socket.drop();
		await rig.http.whenCalled(1);
		session.cancel();

		expect(await collect(session)).toEqual([{ t: "end" }]);
		answer.resolve(jsonResponse({}, 401));
		await settle();
	});

	test.each([
		{ name: "after audio was heard", audio: "heard" as const, sequence: ["audio", "error", "end"], before: false },
		{ name: "before any audio", audio: "none" as const, sequence: ["error", "end"], before: true },
		{ name: "after only an empty audio frame", audio: "empty" as const, sequence: ["error", "end"], before: true },
	])("a connection that drops mid-reply fails the reply: $name", async ({ audio, sequence, before }) => {
		const { rig, session, socket } = await start();
		socket.open();
		session.push("Hi.");
		if (audio === "heard") socket.receive(dialogueAudio(pcmBytes(4_800)));
		if (audio === "empty") socket.receive({ audio: "" });
		socket.drop();

		const events = await collect(session);
		expect(events.map(event => event.t)).toEqual([...sequence]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toContain("closed the voice connection");
		// Nothing spoken at all points at the voice id; a drop after speech is just a broken connection.
		expect(message.includes("before speaking")).toBe(before);
		expect(rig.http.requests).toHaveLength(0);
	});
});

describe("an idle connection", () => {
	test("that the server closes is no error: the next segment opens a new one, and caption times keep counting", async () => {
		const { rig, session, socket: first } = await start();
		first.open();
		session.push("One.");
		first.receive(dialogueAudio(pcmSeconds(0.5), "One. "));
		first.receive(UNIT_DONE);
		first.drop();

		session.push("Two.");
		expect(rig.network.sockets).toHaveLength(2);
		const second = rig.network.sockets[1]!;
		expect(second.headers["xi-api-key"]).toBe(KEY);
		second.open();
		expect(second.frames).toEqual([HELLO, input("Two. ")]);

		second.receive(dialogueAudio(pcmSeconds(0.3), "Two. "));
		second.receive(UNIT_DONE);
		session.flush();

		const events = await collect(session);
		expect(ofType(events, "error")).toEqual([]);
		const words = captionWords(events);
		expect(words.map(word => word.w)).toEqual(["One.", "Two."]);
		expect(words[1]!.s).toBeCloseTo(0.5, 3);
		expect(rig.http.requests).toHaveLength(0);
	});
});
