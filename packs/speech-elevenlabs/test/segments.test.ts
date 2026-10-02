import { afterEach, describe, expect, test } from "bun:test";
import { SegmentSpeakSession } from "../src/segments.js";
import {
	audioBytes,
	captionWords,
	collect,
	Harness,
	KEY,
	makeRig,
	NdjsonStream,
	type OpenOptions,
	ofType,
	openTracked,
	pcmSeconds,
	type Responder,
	SEGMENT_MODEL,
	segmentLine,
	settle,
	streamingResponder,
	VOICE,
} from "./support.js";

const harness = new Harness();
afterEach(() => harness.dispose());

/** A per-segment session whose every request is answered by a stream the test drives by hand. */
async function start(options: OpenOptions & { readonly respond?: Responder } = {}) {
	const streams: NdjsonStream[] = [];
	const rig = await makeRig(harness, { respond: options.respond ?? streamingResponder(streams) });
	const session = await openTracked(harness, rig, { model: SEGMENT_MODEL, ...options });
	return { rig, session, streams };
}

describe("requests", () => {
	test("segments are spoken strictly in order, one request at a time, the key only in a header", async () => {
		const { rig, session, streams } = await start();
		session.push("First.");
		session.push("Second.");
		await settle();
		expect(rig.http.requests).toHaveLength(1);

		const first = rig.http.requests[0]!;
		expect(first.method).toBe("POST");
		const url = new URL(first.url);
		expect(url.host).toBe("api.elevenlabs.io");
		expect(url.pathname).toBe(`/v1/text-to-speech/${VOICE}/stream/with-timestamps`);
		expect(url.searchParams.get("output_format")).toBe("pcm_24000");
		expect(first.headers.get("xi-api-key")).toBe(KEY);
		expect(first.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(first.body!)).toEqual({ text: "First.", model_id: SEGMENT_MODEL });
		expect(first.url).not.toContain(KEY);
		expect(first.body).not.toContain(KEY);

		streams[0]!.write(segmentLine(pcmSeconds(0.1), "First. "));
		streams[0]!.close();
		await rig.http.whenCalled(2);
		expect(JSON.parse(rig.http.requests[1]!.body!)).toEqual({ text: "Second.", model_id: SEGMENT_MODEL });
		streams[1]!.close();
		session.flush();
		expect((await collect(session)).at(-1)).toEqual({ t: "end" });
	});
});

describe("text with nothing to say", () => {
	/** Straight onto the per-segment session with tags on, which no model routes to today. */
	async function startWithTags() {
		const streams: NdjsonStream[] = [];
		const rig = await makeRig(harness, { respond: streamingResponder(streams) });
		const session = harness.track(
			new SegmentSpeakSession({
				apiKey: KEY,
				model: SEGMENT_MODEL,
				voice: VOICE,
				tags: true,
				fetch: rig.http.fetch,
				signal: new AbortController().signal,
			}),
		);
		return { rig, session };
	}

	test("with tags on, a bare direction makes no request and leads the next segment", async () => {
		const { rig, session } = await startWithTags();
		session.push("[sighs]");
		await settle();
		expect(rig.http.requests).toHaveLength(0);

		session.push("All right, let's begin.");
		expect(rig.http.requests).toHaveLength(1);
		expect(JSON.parse(rig.http.requests[0]!.body!).text).toBe("[sighs] All right, let's begin.");
	});

	test("with tags on, a reply that is only a direction ends at once and makes no request", async () => {
		const { rig, session } = await startWithTags();
		session.push("[sighs]");
		session.flush();
		expect(await collect(session)).toEqual([{ t: "end" }]);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("with tags off, an emoji-only segment makes no request and the next one goes out clean", async () => {
		const { rig, session } = await start();
		session.push("🙂");
		session.push("Hi.");
		expect(rig.http.requests).toHaveLength(1);
		expect(JSON.parse(rig.http.requests[0]!.body!).text).toBe("Hi.");
	});
});

describe("audio and caption words", () => {
	test("a later segment's word times are offset by the audio before it; lines may straddle chunks and end unterminated", async () => {
		const { rig, session, streams } = await start();
		session.push("Hello");
		session.push("café");
		const first = pcmSeconds(0.5);
		const second = pcmSeconds(0.3);

		const line1 = Buffer.from(segmentLine(first, "Hello "));
		streams[0]!.write(line1.subarray(0, 30));
		streams[0]!.write(line1.subarray(30));
		streams[0]!.close();
		await rig.http.whenCalled(2);

		// Cut between the two bytes of "é", and leave the last line without its newline.
		const line2 = Buffer.from(segmentLine(second, "café ").trimEnd());
		const cut = line2.indexOf(0xc3) + 1;
		streams[1]!.write(line2.subarray(0, cut));
		streams[1]!.write(line2.subarray(cut));
		streams[1]!.close();
		session.flush();

		const events = await collect(session);
		const words = captionWords(events);
		expect(words.map(word => word.w)).toEqual(["Hello", "café"]);
		expect(words[0]!.s).toBe(0);
		expect(words[1]!.s).toBeCloseTo(0.5, 3);
		expect(words[1]!.e).toBeCloseTo(0.66, 3);
		expect(audioBytes(events)).toEqual(new Uint8Array(Buffer.concat([first, second])));
	});
});

describe("finishing a reply", () => {
	test("flush ends the reply only once the last segment's stream is done", async () => {
		const { session, streams } = await start();
		session.push("Hi.");
		session.flush();
		let ended = false;
		const pending = collect(session).then(events => {
			ended = true;
			return events;
		});
		streams[0]!.write(segmentLine(pcmSeconds(0.1), "Hi. "));
		await settle();
		expect(ended).toBe(false);

		streams[0]!.close();
		const events = await pending;
		expect(events.map(event => event.t)).toEqual(["audio", "words", "end"]);
	});

	test("flush with nothing pushed ends at once and makes no request", async () => {
		const { rig, session } = await start();
		session.flush();
		expect(await collect(session)).toEqual([{ t: "end" }]);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("close() before the reply ends aborts the request and completes the iterable quietly", async () => {
		const { rig, session } = await start();
		session.push("Hi.");
		session.close();

		expect(rig.http.requests[0]!.signal?.aborted).toBe(true);
		expect(await collect(session)).toEqual([]);
	});
});

describe("barge-in and abort", () => {
	for (const how of ["cancel()", "aborting the signal"]) {
		test(`${how} aborts the request in flight, only ends, and starts nothing more`, async () => {
			const controller = new AbortController();
			const { rig, session, streams } = await start({ signal: controller.signal });
			session.push("First.");
			session.push("Second.");
			streams[0]!.write(segmentLine(pcmSeconds(0.1), "First. "));
			await settle();

			if (how === "cancel()") session.cancel();
			else controller.abort();
			expect(rig.http.requests[0]!.signal?.aborted).toBe(true);

			session.push("Third.");
			await settle();
			expect(rig.http.requests).toHaveLength(1);
			expect(await collect(session)).toEqual([{ t: "end" }]);
		});
	}
});

describe("failures", () => {
	test.each([
		{ name: "401 blames the key and does not echo the answer", status: 401, body: `key ${KEY} is not valid`, says: /rejected the API key/ },
		{ name: "500 names the status", status: 500, body: "upstream exploded", says: /500/ },
	])("a non-2xx answer fails the reply and nothing queued behind it is sent: $name", async ({ status, body, says }) => {
		const { rig, session } = await start({ respond: () => new Response(body, { status }) });
		session.push("First.");
		session.push("Second.");

		const events = await collect(session);
		expect(events.map(event => event.t)).toEqual(["error", "end"]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toMatch(says);
		expect(message).not.toContain(KEY);
		await settle();
		expect(rig.http.requests).toHaveLength(1);
	});

	test("a request that cannot be made fails the reply with the reason", async () => {
		const { session } = await start({ respond: () => Promise.reject(new Error("connection reset")) });
		session.push("Hi.");
		expect(await collect(session)).toEqual([{ t: "error", message: "connection reset" }, { t: "end" }]);
	});
});
