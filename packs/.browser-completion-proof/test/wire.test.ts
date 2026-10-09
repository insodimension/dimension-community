/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View shows a torn or wrong picture, freezes on a picture
 *  that arrived split across network reads, shows one page's state against another's picture, or is made to
 *  allocate gigabytes by a stream that claims a huge length. The pack writes these bytes and the View reads them,
 *  from two different runtimes, so the framing is a contract in its own right.
 */
import { describe, expect, test } from "bun:test";
import { encode, KIND_PICTURE, KIND_PING, KIND_STATE, type Message, PING, Reader } from "../src/wire";

const VIEWPORT = { width: 1280, height: 720 };
const jpeg = (size: number, seed: number): Uint8Array => Uint8Array.from({ length: size }, (_, at) => (at * 31 + seed) & 0xff);

function bytes(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const picture = (id: string, size: number, seed: number) => encode(KIND_PICTURE, { id, viewport: VIEWPORT, at: 1_700_000_000_000 }, jpeg(size, seed));
const state = (url: string) => encode(KIND_STATE, { browserId: "b", url });

function expectPicture(message: Message | undefined, id: string, size: number, seed: number): void {
	expect(message?.kind).toBe(KIND_PICTURE);
	if (message?.kind !== KIND_PICTURE) return;
	expect(message.head).toEqual({ id, viewport: VIEWPORT, at: 1_700_000_000_000 });
	expect(message.jpeg).toEqual(jpeg(size, seed));
}

describe("the stream's messages", () => {
	test("a picture and a state come out exactly as they went in, in order", () => {
		const wire = bytes([...picture("p1", 5_000, 1), ...state("http://a.test/"), ...picture("p2", 70_000, 2)]);
		const out = new Reader().push(wire);

		expect(out).toHaveLength(3);
		expectPicture(out[0], "p1", 5_000, 1);
		expect(out[1]).toEqual({ kind: KIND_STATE, state: { browserId: "b", url: "http://a.test/" } });
		expectPicture(out[2], "p2", 70_000, 2);
	});

	test("however the network splits the bytes — every length, one byte at a time, mid-header — the same messages come out", () => {
		const wire = bytes([...picture("p1", 3_000, 3), ...state("http://b.test/"), ...picture("p2", 40_000, 4)]);

		for (const step of [1, 2, 7, 8, 9, 10, 1_000, 16_384, 65_536]) {
			const reader = new Reader();
			const out: Message[] = [];
			for (let at = 0; at < wire.length; at += step) out.push(...reader.push(wire.subarray(at, at + step)));
			expect(out).toHaveLength(3);
			expectPicture(out[0], "p1", 3_000, 3);
			expect(out[1]).toMatchObject({ kind: KIND_STATE });
			expectPicture(out[2], "p2", 40_000, 4);
		}
	});

	test("a picture with an empty body and a state with a body-less message both survive", () => {
		const out = new Reader().push(bytes([...encode(KIND_PICTURE, { id: "e", viewport: VIEWPORT, at: 1 }), ...state("x")]));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ kind: KIND_PICTURE, jpeg: new Uint8Array(0) });
	});

	test("a message that claims to be larger than any picture is a protocol error, not a buffer to fill", () => {
		const header = new Uint8Array(9);
		header[0] = KIND_PICTURE;
		new DataView(header.buffer).setUint32(5, 0xffff_ffff, true);
		expect(() => new Reader().push(header)).toThrow(/larger than allowed/);

		const jsonClaim = new Uint8Array(9);
		jsonClaim[0] = KIND_STATE;
		new DataView(jsonClaim.buffer).setUint32(1, 0xffff_ffff, true);
		expect(() => new Reader().push(jsonClaim)).toThrow(/larger than allowed/);
	});

	test("a kind the Reader does not know is skipped whole, wherever the network splits it and whatever its parts hold, so a newer pack's frame never ends an older View's stream", () => {
		const unknown = (kind: number, json: Uint8Array, body: Uint8Array): Uint8Array => {
			const frame = new Uint8Array(9 + json.length + body.length);
			frame[0] = kind;
			new DataView(frame.buffer).setUint32(1, json.length, true);
			new DataView(frame.buffer).setUint32(5, body.length, true);
			frame.set(json, 9);
			frame.set(body, 9 + json.length);
			return frame;
		};
		// Not JSON, not anything: the Reader cannot know what a kind it does not know holds.
		const junk = unknown(99, new TextEncoder().encode("{not json"), Uint8Array.of(1, 2, 3));
		const wire = bytes([...picture("p1", 300, 5), junk, ...state("http://c.test/"), unknown(7, new Uint8Array(0), new Uint8Array(0)), ...picture("p2", 300, 6)]);

		for (const step of [1, 3, 9, 10, wire.length]) {
			const reader = new Reader();
			const out: Message[] = [];
			for (let at = 0; at < wire.length; at += step) out.push(...reader.push(wire.subarray(at, at + step)));
			expect(out.map((message) => message.kind)).toEqual([KIND_PICTURE, KIND_STATE, KIND_PICTURE]);
			expectPicture(out[2], "p2", 300, 6);
		}
	});

	test("a ping is nine bytes, carries nothing, and comes out as just its kind between the messages around it", () => {
		// Fails if a ping grows a body: it is sent to every quiet View every couple of seconds.
		expect(PING.reduce((sum, part) => sum + part.length, 0)).toBe(9);

		const out = new Reader().push(bytes([...state("http://d.test/"), ...PING, ...PING, ...picture("p3", 200, 7)]));
		expect(out.map((message) => message.kind)).toEqual([KIND_STATE, KIND_PING, KIND_PING, KIND_PICTURE]);
		expect(out[1]).toEqual({ kind: KIND_PING });

		// A ping is never parsed: one with a JSON part that is not JSON (a newer pack's decoration) is still a ping.
		const garbled = new Uint8Array(9 + 4);
		garbled[0] = KIND_PING;
		new DataView(garbled.buffer).setUint32(1, 4, true);
		garbled.set(new TextEncoder().encode("}{]["), 9);
		expect(new Reader().push(garbled)).toEqual([{ kind: KIND_PING }]);
	});
});
