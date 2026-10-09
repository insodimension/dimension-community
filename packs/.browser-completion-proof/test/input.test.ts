/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the human's mouse and keyboard in the Browser View reach the page
 *  wrong — a click lands off the edge, a drag never releases, a typed letter arrives as a key with no character, a
 *  scroll flings the page 100,000 px — or something a View sent (anything: it is untrusted input from a sandboxed
 *  page) reaches Chrome unchecked. The first half is what the pack accepts; the second is the exact calls Chrome gets.
 */
import { describe, expect, test } from "bun:test";
import { MAX_INPUT_BATCH, MAX_INPUT_TEXT } from "../src/contracts";
import { admitInput, inputCall } from "../src/input";

const VIEWPORT = { width: 800, height: 600 };
const admit = (events: unknown) => admitInput(events, VIEWPORT);
const refusal = (events: unknown): string => {
	try {
		admit(events);
	} catch (error) {
		return (error as Error & { code?: string }).code === "bad_input" ? (error as Error).message : `wrong error: ${String(error)}`;
	}
	return "was accepted";
};

describe("what the pack accepts from a View", () => {
	test("a bare event is filled out with the defaults a browser would assume", () => {
		expect(admit([{ kind: "mouse", type: "down", x: 10, y: 20 }])).toEqual([
			{ kind: "mouse", type: "down", x: 10, y: 20, button: "left", buttons: 0, clickCount: 1, modifiers: 0 },
		]);
		expect(admit([{ kind: "key", type: "down", key: "a", text: "a" }])).toEqual([
			{ kind: "key", type: "down", key: "a", code: "", keyCode: 0, text: "a", modifiers: 0, repeat: false, location: 0 },
		]);
	});

	test("a point outside the page is held on its edge (a drag that left the picture still releases), and a wheel is capped", () => {
		const [up, wheel] = admit([
			{ kind: "mouse", type: "up", x: -50, y: 9_999 },
			{ kind: "wheel", x: 5_000, y: 3, deltaX: -1e9, deltaY: 123_456 },
		]);
		expect(up).toMatchObject({ x: 0, y: 599 });
		expect(wheel).toMatchObject({ x: 799, y: 3, deltaX: -5_000, deltaY: 5_000 });
	});

	test("fields nobody asked for are not passed on", () => {
		const [event] = admit([{ kind: "text", text: "hi", evil: "Runtime.evaluate" }]);
		expect(event).toEqual({ kind: "text", text: "hi" });
	});

	test("each fault is refused as bad_input, naming where, and nothing of that batch is kept", () => {
		const good = { kind: "text", text: "ok" };
		const cases: Array<[string, unknown, RegExp]> = [
			["not a list", { kind: "text", text: "x" }, /input/],
			["an empty list", [], /input/],
			["too many events", Array.from({ length: MAX_INPUT_BATCH + 1 }, () => good), /input/],
			["an unknown kind", [good, { kind: "eval", expression: "1" }], /input\[1\]/],
			["a button that does not exist", [{ kind: "mouse", type: "down", x: 1, y: 1, button: "back" }], /input\[0\]\.button/],
			["a coordinate that is not a number", [{ kind: "mouse", type: "move", x: "1", y: 1 }], /input\[0\]\.x/],
			["a coordinate that is not finite", [{ kind: "mouse", type: "move", x: Number.POSITIVE_INFINITY, y: 1 }], /input\[0\]/],
			["a click count of 9", [{ kind: "mouse", type: "down", x: 1, y: 1, clickCount: 9 }], /clickCount/],
			["modifiers outside the four bits", [{ kind: "key", type: "down", key: "a", modifiers: 99 }], /modifiers/],
			["an empty key", [{ kind: "key", type: "down", key: "" }], /input\[0\]\.key/],
			["text over the limit", [{ kind: "text", text: "x".repeat(MAX_INPUT_TEXT + 1) }], /input\[0\]\.text/],
			["empty text", [{ kind: "text", text: "" }], /input\[0\]\.text/],
		];
		for (const [what, events, message] of cases) expect(refusal(events), what).toMatch(message);
	});

	test("text at exactly the limit, and exactly a full batch, are accepted", () => {
		expect(admit([{ kind: "text", text: "x".repeat(MAX_INPUT_TEXT) }])).toHaveLength(1);
		expect(admit(Array.from({ length: MAX_INPUT_BATCH }, () => ({ kind: "mouse", type: "move", x: 1, y: 1 })))).toHaveLength(MAX_INPUT_BATCH);
	});
});

describe("what Chrome is asked to do", () => {
	const call = (event: unknown) => inputCall(admit([event])[0] as never);

	test("a press and a release are separate calls, the pressed button held in between and let go after", () => {
		const down = call({ kind: "mouse", type: "down", x: 5, y: 6, button: "right", buttons: 2, clickCount: 2, modifiers: 8 });
		const up = call({ kind: "mouse", type: "up", x: 5, y: 6, button: "right", buttons: 0, clickCount: 2 });
		expect(down).toEqual({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 5, y: 6, button: "right", buttons: 2, clickCount: 2, modifiers: 8 } });
		expect(up).toMatchObject({ params: { type: "mouseReleased", button: "right", buttons: 0, clickCount: 2 } });
	});

	test("a move is a hover (no button) until a button is held, when it is a drag", () => {
		expect(call({ kind: "mouse", type: "move", x: 1, y: 2 }).params).toMatchObject({ type: "mouseMoved", button: "none", buttons: 0, clickCount: 0 });
		expect(call({ kind: "mouse", type: "move", x: 1, y: 2, button: "left", buttons: 1 }).params).toMatchObject({ type: "mouseMoved", button: "left", buttons: 1, clickCount: 0 });
	});

	test("the wheel is delivered at the pointer with its deltas", () => {
		expect(call({ kind: "wheel", x: 40, y: 50, deltaX: 0, deltaY: 120 })).toEqual({ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 40, y: 50, deltaX: 0, deltaY: 120, modifiers: 0 } });
	});

	test("a key that types a character is a keyDown carrying it; any other key is a rawKeyDown; a release carries no character", () => {
		const letter = call({ kind: "key", type: "down", key: "A", code: "KeyA", keyCode: 65, text: "A", modifiers: 8 });
		expect(letter.params).toMatchObject({ type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A", unmodifiedText: "A", modifiers: 8 });
		const arrow = call({ kind: "key", type: "down", key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, repeat: true });
		expect(arrow.params).toMatchObject({ type: "rawKeyDown", key: "ArrowLeft", windowsVirtualKeyCode: 37, autoRepeat: true });
		expect(arrow.params).not.toHaveProperty("text");
		const release = call({ kind: "key", type: "up", key: "A", code: "KeyA", keyCode: 65, text: "A" });
		expect(release.params).toMatchObject({ type: "keyUp", key: "A" });
		expect(release.params).not.toHaveProperty("text");
	});

	test("pasted text is inserted as one operation", () => {
		expect(call({ kind: "text", text: "héllo 🚀" })).toEqual({ method: "Input.insertText", params: { text: "héllo 🚀" } });
	});
});
