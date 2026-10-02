import { describe, expect, test } from "bun:test";
import {
	describeHandshakeFailure,
	describeHttpFailure,
	dialogueHello,
	dialogueInput,
	dialogueSocketUrl,
	modelSupportsAudioTags,
	parseDialogueEvent,
	parseSegmentLine,
	segmentBody,
	segmentUrl,
	usesDialogueSocket,
} from "../src/protocol.js";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

describe("dialogueSocketUrl", () => {
	test("asks for raw 24 kHz PCM with alignment, and carries only the model besides", () => {
		// A model id is caller-supplied: it must not be able to inject another parameter.
		const url = new URL(dialogueSocketUrl("eleven v4/x&output_format=mp3"));
		expect(url.protocol).toBe("wss:");
		expect(url.host).toBe("api.elevenlabs.io");
		expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
		expect(url.searchParams.get("model_id")).toBe("eleven v4/x&output_format=mp3");
		expect(url.searchParams.get("output_format")).toBe("pcm_24000");
		expect(url.searchParams.get("sync_alignment")).toBe("true");
		expect([...url.searchParams.keys()].sort()).toEqual(["model_id", "output_format", "sync_alignment"]);
	});
});

describe("dialogue client frames", () => {
	test("the hello frame registers the one voice", () => {
		expect(dialogueHello("v-1")).toEqual({ voices: ["v-1"] });
	});

	test("an input is flushed at once, addressed to the voice, with a trailing space so segments do not fuse", () => {
		expect(dialogueInput("Hello there.", "v-1")).toEqual({
			inputs: [{ text: "Hello there. ", voice_id: "v-1" }],
			flush: true,
		});
	});
});

describe("segment request", () => {
	test("the voice id is one path segment however odd it is", () => {
		const url = new URL(segmentUrl("a/b?c#d e"));
		expect(url.host).toBe("api.elevenlabs.io");
		const parts = url.pathname.split("/");
		expect(parts).toHaveLength(6);
		expect(parts[1]).toBe("v1");
		expect(parts[2]).toBe("text-to-speech");
		expect(decodeURIComponent(parts[3]!)).toBe("a/b?c#d e");
		expect(`${parts[4]}/${parts[5]}`).toBe("stream/with-timestamps");
		expect(url.searchParams.get("output_format")).toBe("pcm_24000");
	});

	test("the body carries the text and the model", () => {
		expect(segmentBody("Hi.", "eleven_flash_v2_5")).toEqual({ text: "Hi.", model_id: "eleven_flash_v2_5" });
	});
});

describe("model routing", () => {
	test.each([
		{ model: "eleven_v4_turbo", socket: true },
		{ model: "eleven_v4", socket: true },
		{ model: "eleven_v3", socket: true },
		{ model: "eleven_flash_v2_5", socket: false },
		{ model: "eleven_multilingual_v2", socket: false },
		{ model: "eleven_turbo_v2_5", socket: false },
	])("$model: dialogue socket $socket, audio tags $socket", ({ model, socket }) => {
		expect(usesDialogueSocket(model)).toBe(socket);
		expect(modelSupportsAudioTags(model)).toBe(socket);
	});
});

describe("parseDialogueEvent", () => {
	test("audio with alignment is decoded to bytes and arrays", () => {
		const event = parseDialogueEvent(
			JSON.stringify({
				audio: b64([1, 2, 3, 4]),
				alignment: { chars: ["a", "b"], char_start_times_ms: [0, 40], char_durations_ms: [40, 35] },
			}),
		);
		expect(event?.kind).toBe("audio");
		if (event?.kind !== "audio") return;
		expect([...event.pcm]).toEqual([1, 2, 3, 4]);
		expect(event.alignment).toEqual({ chars: ["a", "b"], startsMs: [0, 40], durationsMs: [40, 35] });
	});

	test("audio without alignment is audio only", () => {
		const event = parseDialogueEvent(JSON.stringify({ audio: b64([9, 8]) }));
		expect(event?.kind).toBe("audio");
		if (event?.kind !== "audio") return;
		expect([...event.pcm]).toEqual([9, 8]);
		expect(event.alignment).toBeUndefined();
	});

	test.each([
		{ name: "alignment missing durations", alignment: { chars: ["a"], char_start_times_ms: [0] } },
		{ name: "alignment with non-string chars", alignment: { chars: [1], char_start_times_ms: [0], char_durations_ms: [1] } },
		{ name: "null alignment", alignment: null },
	])("audio is kept and the alignment dropped: $name", ({ alignment }) => {
		const event = parseDialogueEvent(JSON.stringify({ audio: b64([1, 2]), alignment }));
		expect(event?.kind).toBe("audio");
		if (event?.kind !== "audio") return;
		expect([...event.pcm]).toEqual([1, 2]);
		expect(event.alignment).toBeUndefined();
	});

	test("the end of one flushed input's audio is unit-done, the end of the reply is final", () => {
		expect(parseDialogueEvent('{"is_final_audio_for_turn":true}')).toEqual({ kind: "unit-done" });
		expect(parseDialogueEvent('{"is_final":true}')).toEqual({ kind: "final" });
	});

	test("an error frame reports its message, falling back to the error code", () => {
		expect(parseDialogueEvent('{"error":"invalid_voice","message":"Voice not found","code":1008}')).toEqual({
			kind: "error",
			message: "Voice not found",
		});
		expect(parseDialogueEvent('{"error":"invalid_voice"}')).toEqual({ kind: "error", message: "invalid_voice" });
	});

	test.each([
		{ name: "not JSON", raw: "not json" },
		{ name: "empty", raw: "" },
		{ name: "a JSON scalar", raw: "5" },
		{ name: "JSON null", raw: "null" },
		{ name: "a JSON array", raw: "[]" },
		{ name: "an unknown frame", raw: '{"surprise":1}' },
		{ name: "is_final false", raw: '{"is_final":false}' },
	])("ignored: $name", ({ raw }) => {
		expect(parseDialogueEvent(raw)).toBeNull();
	});
});

describe("parseSegmentLine", () => {
	test("audio and alignment ride together", () => {
		const chunk = parseSegmentLine(
			JSON.stringify({
				audio_base64: b64([5, 6]),
				alignment: {
					characters: ["h", "i"],
					character_start_times_seconds: [0, 0.1],
					character_end_times_seconds: [0.1, 0.2],
				},
			}),
		);
		expect([...(chunk?.pcm ?? [])]).toEqual([5, 6]);
		expect(chunk?.alignment).toEqual({ chars: ["h", "i"], starts: [0, 0.1], ends: [0.1, 0.2] });
	});

	test("audio alone and alignment alone are each accepted; a null alignment counts as none", () => {
		const audioOnly = parseSegmentLine(JSON.stringify({ audio_base64: b64([1, 2]), alignment: null }));
		expect([...(audioOnly?.pcm ?? [])]).toEqual([1, 2]);
		expect(audioOnly?.alignment).toBeUndefined();

		const alignmentOnly = parseSegmentLine(
			JSON.stringify({
				alignment: { characters: ["x"], character_start_times_seconds: [0], character_end_times_seconds: [1] },
			}),
		);
		expect(alignmentOnly?.pcm).toBeUndefined();
		expect(alignmentOnly?.alignment?.chars).toEqual(["x"]);
	});

	test.each(["not json", "5", "null", "[]"])("ignored: %p", raw => {
		expect(parseSegmentLine(raw)).toBeNull();
	});
});

describe("failure wording", () => {
	const SECRET = "sk-secret-in-body";

	test.each([
		{ name: "401", status: 401, body: `{"detail":{"status":"invalid_api_key","message":"${SECRET}"}}`, says: "rejected the API key" },
		{ name: "403", status: 403, body: `{"detail":"${SECRET}"}`, says: "rejected the API key" },
		{ name: "401 lacking a permission is not the key's fault", status: 401, body: `{"detail":{"status":"missing_permissions","message":"${SECRET}"}}`, says: "refused the voice connection" },
		{ name: "200: the server accepted the request but refused the socket", status: 200, body: SECRET, says: "refused the voice connection" },
		{ name: "500", status: 500, body: SECRET, says: "answered 500" },
	])("describeHandshakeFailure $name", ({ status, body, says }) => {
		const message = describeHandshakeFailure(status, body);
		expect(message).toContain(says);
		expect(message).not.toContain(SECRET);
		if (says === "refused the voice connection") expect(message).not.toContain("rejected the API key");
	});

	test.each([401, 403])("describeHttpFailure %p blames the key and does not echo the body", status => {
		const message = describeHttpFailure(status, `{"detail":"${SECRET}"}`);
		expect(message).toMatch(/rejected the API key/);
		expect(message).not.toContain(SECRET);
	});

	test("describeHttpFailure names the status and quotes a bounded slice of the body", () => {
		expect(describeHttpFailure(500, "")).toBe("ElevenLabs answered 500");
		const message = describeHttpFailure(502, `bad gateway ${"x".repeat(1_000)}`);
		expect(message).toContain("502");
		expect(message).toContain("bad gateway");
		expect(message.length).toBeLessThan(300);
	});
});
