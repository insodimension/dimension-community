/**
 * Page input from the View's direct channel: checking what arrives, and turning it into the browser's own input calls.
 * Everything the View sends is untrusted: it is parsed once here, bounded, and rebuilt field by field before it reaches Chrome.
 */
import { z } from "zod";
import { MAX_INPUT_BATCH, MAX_INPUT_TEXT, type Viewport } from "./contracts.js";
import { fail } from "./store.js";

/** The largest wheel delta one event may carry, as the `scroll` action's. */
const MAX_DELTA = 5_000;
const modifiers = z.number().int().min(0).max(15).default(0);

const eventSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("mouse"),
		type: z.enum(["move", "down", "up"]),
		x: z.number(),
		y: z.number(),
		button: z.enum(["left", "right", "middle"]).default("left"),
		buttons: z.number().int().min(0).max(31).default(0),
		clickCount: z.number().int().min(1).max(3).default(1),
		modifiers,
	}),
	z.object({ kind: z.literal("wheel"), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number(), modifiers }),
	z.object({
		kind: z.literal("key"),
		type: z.enum(["down", "up"]),
		key: z.string().min(1).max(32),
		code: z.string().max(32).default(""),
		keyCode: z.number().int().min(0).max(0xffff).default(0),
		text: z.string().max(16).optional(),
		modifiers,
		repeat: z.boolean().default(false),
		location: z.number().int().min(0).max(3).default(0),
	}),
	z.object({ kind: z.literal("text"), text: z.string().min(1).max(MAX_INPUT_TEXT) }),
]);
const batchSchema = z.array(eventSchema).min(1).max(MAX_INPUT_BATCH);

/** What a sender may give: every field with a default is optional. This is the View's side of the wire (a type-only import: the View bundle never loads zod). */
export type PageInputEvent = z.input<typeof eventSchema>;
/** What the browser is asked to do: every field present, coordinates inside the page. */
export type AdmittedInput = z.output<typeof eventSchema>;

/** A point held inside the page: a drag that leaves the picture still releases on its edge. */
const inside = (value: number, size: number): number => Math.min(Math.max(value, 0), Math.max(size - 1, 0));
const limited = (value: number): number => Math.min(Math.max(value, -MAX_DELTA), MAX_DELTA);

/**
 * The events of one batch, validated and rebuilt. Throws `bad_input` naming the first fault; nothing of a bad batch is kept.
 * Coordinates are CSS px in the page; they are held inside `viewport` rather than refused, and wheel deltas are capped.
 */
export function admitInput(raw: unknown, viewport: Viewport): AdmittedInput[] {
	const parsed = batchSchema.safeParse(raw);
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		fail("bad_input", `input${(issue?.path ?? []).map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("")}: ${issue?.message ?? "invalid"}`);
	}
	return parsed.data.map((event): AdmittedInput => {
		switch (event.kind) {
			case "mouse":
				return { ...event, x: inside(event.x, viewport.width), y: inside(event.y, viewport.height) };
			case "wheel":
				return { ...event, x: inside(event.x, viewport.width), y: inside(event.y, viewport.height), deltaX: limited(event.deltaX), deltaY: limited(event.deltaY) };
			default:
				return event;
		}
	});
}

/** One call to the browser's own input domain. */
export interface InputCall {
	method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
	params: Record<string, unknown>;
}

/** What one admitted event is, as the browser's input call. A key that types a character is a `keyDown` carrying its text (the page then sees keypress and input); any other key is a `rawKeyDown`. */
export function inputCall(event: AdmittedInput): InputCall {
	switch (event.kind) {
		case "mouse":
			return {
				method: "Input.dispatchMouseEvent",
				params: {
					type: event.type === "move" ? "mouseMoved" : event.type === "down" ? "mousePressed" : "mouseReleased",
					x: event.x,
					y: event.y,
					button: event.type === "move" && event.buttons === 0 ? "none" : event.button,
					buttons: event.buttons,
					clickCount: event.type === "move" ? 0 : event.clickCount,
					modifiers: event.modifiers,
				},
			};
		case "wheel":
			return { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers } };
		case "key":
			return {
				method: "Input.dispatchKeyEvent",
				params: {
					type: event.type === "up" ? "keyUp" : event.text === undefined ? "rawKeyDown" : "keyDown",
					key: event.key,
					code: event.code,
					windowsVirtualKeyCode: event.keyCode,
					nativeVirtualKeyCode: event.keyCode,
					modifiers: event.modifiers,
					autoRepeat: event.repeat,
					location: event.location,
					isKeypad: event.location === 3,
					...(event.type === "down" && event.text !== undefined ? { text: event.text, unmodifiedText: event.text } : {}),
				},
			};
		case "text":
			return { method: "Input.insertText", params: { text: event.text } };
	}
}
