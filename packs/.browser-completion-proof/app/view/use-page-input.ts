// The human's mouse, wheel and keys on the page: each event goes to the pack's input door (use-browser-stream's `post`), strictly in
// order, one request in flight. Whatever happens while a request is out waits and goes together in the next one, so a fast sweep of
// the mouse is a short list, not a request per pixel. Between neighbours the queue keeps only what loses nothing: of two moves the
// later, of two wheels their sum.
import { useCallback, useEffect, useRef } from "react";
import { MAX_INPUT_BATCH, MAX_INPUT_TEXT } from "../../src/contracts";
import type { PageInputEvent } from "../../src/input";
import { failureText } from "./browser-client";

const MAX_DELTA = 5000;
const clampDelta = (value: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));

export interface PageInput {
	/** Queue one event; folded into the pending tail where that is lossless. */
	send(event: PageInputEvent): void;
	/** Drop everything not yet sent (a tab switch, a task taking over). */
	reset(): void;
}

export interface PageInputOptions {
	/** Sends one batch; rejects with the reason it was refused. */
	readonly post: (events: readonly PageInputEvent[]) => Promise<void>;
	/** A batch that changed something was refused. A refused move or wheel is invisible and the next one supersedes it. */
	readonly onError: (message: string) => void;
}

/** Folds `next` into `last` when the pair means the same as one event. */
function merge(last: PageInputEvent, next: PageInputEvent): PageInputEvent | null {
	if (last.kind === "mouse" && last.type === "move" && next.kind === "mouse" && next.type === "move") return next;
	if (last.kind === "wheel" && next.kind === "wheel" && last.x === next.x && last.y === next.y && last.modifiers === next.modifiers) {
		return { ...next, deltaX: clampDelta(last.deltaX + next.deltaX), deltaY: clampDelta(last.deltaY + next.deltaY) };
	}
	if (last.kind === "text" && next.kind === "text" && last.text.length + next.text.length <= MAX_INPUT_TEXT) return { kind: "text", text: last.text + next.text };
	return null;
}

const quiet = (event: PageInputEvent) => event.kind === "wheel" || (event.kind === "mouse" && event.type === "move");

export function usePageInput(options: PageInputOptions): PageInput {
	const queueRef = useRef<PageInputEvent[]>([]);
	const busyRef = useRef(false);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const drain = useCallback(async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		try {
			while (queueRef.current.length > 0) {
				const batch = queueRef.current.splice(0, MAX_INPUT_BATCH);
				try {
					await optionsRef.current.post(batch);
				} catch (cause) {
					if (!batch.every(quiet)) optionsRef.current.onError(failureText(cause));
				}
			}
		} finally {
			busyRef.current = false;
		}
	}, []);

	const send = useCallback(
		(event: PageInputEvent) => {
			const queue = queueRef.current;
			const last = queue[queue.length - 1];
			const merged = last === undefined ? null : merge(last, event);
			if (merged !== null) queue[queue.length - 1] = merged;
			else queue.push(event.kind === "wheel" ? { ...event, deltaX: clampDelta(event.deltaX), deltaY: clampDelta(event.deltaY) } : event);
			void drain();
		},
		[drain],
	);

	const reset = useCallback(() => {
		queueRef.current = [];
	}, []);

	useEffect(() => reset, [reset]);

	return { send, reset };
}
