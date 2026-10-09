// The live connection to the browser, replacing the old tool-call poll. One `browser_stream` call (when a browser is bound, and again
// only to reconnect) names the pack's loopback listener; from then on pictures and state arrive on ONE open stream and the human's
// input goes back on small POSTs. No tool call is made per picture, per state, or per click.
//
//   • live            → pictures are decoded off the main thread (createImageBitmap, newest wins) and drawn straight onto the
//                       page's canvas, never through React state. State (tabs, address, task, publish) arrives on the same stream.
//   • frozen          → annotating: the stream is re-opened for state only, so the picture cannot move under a drawing.
//   • document hidden → the stream is closed (Chrome stops casting for nobody) and re-opened when the View is seen again.
//
// A failure backs off and is reported; an unknown browserId is terminal (the browser was closed elsewhere). So is a call the HOST
// refused to approve (a third-party pack's View calls are consent-gated): retrying would raise a fresh consent prompt on every
// backoff tick, so it waits for `refresh()`, the human asking again.
//
// A loopback request can HANG, neither refused nor answered (a host's local-network policy that prompts no one, a pack that stopped
// answering). Every request this file makes to the pack has a deadline, enforced by aborting its AbortController so the socket really
// closes: a connect that never answers becomes the same "reconnecting" state and backoff as one that was refused. The open stream is held
// to silence instead: a page that is not changing sends nothing, so the pack sends this View a nine-byte ping whenever it has written it
// nothing for HEARTBEAT_MS (src/stream.ts), and a stream that carries nothing at all for STREAM_SILENCE_MS after its first ping is dead
// (the pack's event loop wedged with the socket still open) and takes the same road. A ping is never parsed and costs no render. The host
// call that names the listener is not timed here: it waits on the human's consent prompt, and the MCP SDK fails it by itself after its own 60 s.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserState, Viewport } from "../../src/contracts";
import type { PageInputEvent } from "../../src/input";
import { KIND_PICTURE, KIND_PING, KIND_STATE, type Message, PING_QUERY, Reader } from "../../src/wire";
import { type BrowserClient, failureText, type StreamGrant, stateFromStream } from "./browser-client";

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;
/** How long the stream's connect may go unanswered before it counts as a failure. `fetch` settles on the response headers, which the pack sends with its first message (the browser's state, read at once). */
export const CONNECT_TIMEOUT_MS = 5000;
/** How long one input POST may go unanswered. The pack answers a batch once the page has taken it, however long that is (a batch waits its turn behind another View's, then applies), so past this the View reports it and closes the POST's socket, but the batch may still be applied late. The stream is not restarted for it: nothing says the stream is unhealthy. */
export const INPUT_TIMEOUT_MS = 8000;
/** How long an open stream may carry nothing at all (no picture, no state, no ping) before it counts as dead. A pack that pings (every View it pings is written to at least every HEARTBEAT_MS, 2 s, in src/stream.ts) is never this silent while it lives: a stream this quiet has stalled, it is not a still page. The watch starts at the pack's first ping, so a pack that does not ping is never judged by it. */
export const STREAM_SILENCE_MS = 6000;
/** A timer that fires this much later than set was held up by this View's own thread, not by the pack going quiet (see `arm`). */
const TIMER_STALL_MS = 1000;
/** A stream the pack ended (its browser closed, or its token was dropped): ask for a new one at once, but not in a spin. */
const ENDED_RETRY_MS = 150;
const GONE = /unknown or already closed browserId/i;
/** The host's consent refusal (a denied or expired prompt), not a server failure. */
const NOT_APPROVED = /was not approved/i;

export type Connection = "connecting" | "live" | "reconnecting" | "unapproved" | "gone";

/** What the page needs to know of the live picture. The pixels are not here: they never pass through React. */
export interface Picture {
	/** The page size (CSS px) the newest picture was taken at: a click on the picture maps to the page by this. */
	readonly viewport: Viewport;
}

export interface BrowserStream {
	/** The newest state — from the stream or a caller push — for the CURRENT browserId. */
	readonly state: BrowserState | null;
	/** Null until the first picture of this browser has been drawn. */
	readonly picture: Picture | null;
	readonly connection: Connection;
	/** The live failure, cleared by the next success. */
	readonly error: string | null;
	/** Give the stream the canvas it draws into (a ref callback); `null` lets go. The newest picture is redrawn into a new canvas at once. */
	canvas(element: HTMLCanvasElement | null): void;
	/** Send one batch of the human's input to the page. Rejects with the pack's reason (a task owns the page, the browser is gone, ...). */
	post(events: readonly PageInputEvent[]): Promise<void>;
	/** Fold a state the UI obtained itself (an action, a tab op) into the view. */
	push(state: BrowserState): void;
	/** Reconnect now rather than at the next backoff, or ask again after a refusal. */
	refresh(): void;
}

function draw(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
	if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
	}
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
}

/** The reason a refused input gives, or a plain sentence when it gave none. */
function refusalText(body: unknown, status: number): string {
	if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
	return `The page did not take the input (HTTP ${status}).`;
}

interface Deadline {
	/** True once the deadline itself aborted the request, as opposed to the View aborting it (hidden, unmounted, token gone). */
	readonly expired: boolean;
	/** Start the time over: the request is not idle after all. Nothing once the request is aborted. */
	restart(): void;
	clear(): void;
}

/**
 * After `ms`, abort `controller`. The timer is gone when the deadline is cleared or the controller aborts for any reason, so none outlives its request.
 * A timer that fires more than TIMER_STALL_MS later than it was set was held up by this View's own thread (a blocked main thread, a long GC), not by
 * the other end going quiet: what the pack sent meanwhile is queued behind the timer, unread. The deadline then starts one more window, long enough
 * to read it, instead of aborting a healthy request. Hearing something (`restart()`) earns the next stall the same forgiveness.
 */
function arm(controller: AbortController, ms: number): Deadline {
	let armedAt = performance.now();
	let forgiven = false;
	const expire = () => {
		if (!forgiven && performance.now() - armedAt - ms > TIMER_STALL_MS) {
			forgiven = true;
			armedAt = performance.now();
			timer = window.setTimeout(expire, ms);
			return;
		}
		deadline.expired = true;
		controller.abort();
	};
	let timer = window.setTimeout(expire, ms);
	const deadline = {
		expired: false,
		restart: () => {
			if (controller.signal.aborted) return;
			window.clearTimeout(timer);
			armedAt = performance.now();
			forgiven = false;
			timer = window.setTimeout(expire, ms);
		},
		clear: () => {
			window.clearTimeout(timer);
			controller.signal.removeEventListener("abort", deadline.clear);
		},
	};
	controller.signal.addEventListener("abort", deadline.clear);
	return deadline;
}

/** A request that never answered, as the human is told it. */
function silence(ms: number): string {
	return `no answer within ${Math.round(ms / 1000)} s`;
}

/** What this View asks of the stream: pings (it understands them, and holds the stream to them), and no pictures while it is frozen for annotating. */
function streamQuery(frozen: boolean): string {
	const query = new URLSearchParams({ [PING_QUERY]: "1" });
	if (frozen) query.set("frames", "0");
	return query.toString();
}

export function useBrowserStream(client: BrowserClient, browserId: string | null, frozen: boolean): BrowserStream {
	const [state, setState] = useState<BrowserState | null>(null);
	const [picture, setPicture] = useState<Picture | null>(null);
	const [connection, setConnection] = useState<Connection>("connecting");
	const [error, setError] = useState<string | null>(null);

	const currentRef = useRef<string | null>(browserId);
	currentRef.current = browserId;
	const stateKeyRef = useRef("");
	const grantRef = useRef<StreamGrant | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	/** The newest decoded picture, kept so a canvas that appears later (the page remounts) is not blank. */
	const shownRef = useRef<ImageBitmap | null>(null);
	const wakeRef = useRef<() => void>(() => {});
	const restartRef = useRef<() => void>(() => {});

	useEffect(() => {
		setState(null);
		setPicture(null);
		setError(null);
		setConnection("connecting");
		stateKeyRef.current = "";
		grantRef.current = null;
		shownRef.current?.close();
		shownRef.current = null;
	}, [browserId]);

	useEffect(() => {
		if (browserId === null) return;
		let alive = true;
		/** The open stream, if any. Only this effect aborts it (the View was hidden, or input found the token gone), so an abort is never a failure. */
		let controller: AbortController | undefined;
		let pending: Extract<Message, { kind: typeof KIND_PICTURE }> | null = null;
		let decoding = false;

		const accept = (next: BrowserState) => {
			if (currentRef.current !== next.browserId) return;
			const key = JSON.stringify(next);
			if (key === stateKeyRef.current) return;
			stateKeyRef.current = key;
			setState(next);
		};

		const paint = (bitmap: ImageBitmap, viewport: Viewport) => {
			shownRef.current?.close();
			shownRef.current = bitmap;
			if (canvasRef.current) draw(canvasRef.current, bitmap);
			setPicture(current => (current && current.viewport.width === viewport.width && current.viewport.height === viewport.height ? current : { viewport }));
		};

		// Only the newest picture is worth decoding: while one decodes, a newer one replaces the waiting one.
		const decode = async () => {
			if (decoding) return;
			decoding = true;
			try {
				while (pending !== null && alive) {
					const next = pending;
					pending = null;
					const bitmap = await createImageBitmap(new Blob([next.jpeg as BlobPart], { type: "image/jpeg" })).catch(() => null);
					if (bitmap === null) continue;
					if (!alive || currentRef.current !== browserId) {
						bitmap.close();
						return;
					}
					paint(bitmap, next.head.viewport);
				}
			} finally {
				decoding = false;
			}
		};

		const handle = (message: Message) => {
			if (message.kind === KIND_STATE) {
				try {
					accept(stateFromStream(message.state));
				} catch (cause) {
					setError(failureText(cause));
				}
				return;
			}
			// A ping has done its work already (the loop below read it); the page has nothing to show for it.
			if (message.kind === KIND_PICTURE) {
				pending = message;
				void decode();
			}
		};

		// A sleep that `wake()` ends early: the backoff, the wait for a hidden View to be seen, or a refused call waiting to be asked again.
		const rest = (ms: number): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = ms === Number.POSITIVE_INFINITY ? undefined : window.setTimeout(resolve, ms);
			wakeRef.current = () => {
				window.clearTimeout(timer);
				wakeRef.current = () => {};
				resolve();
			};
			return promise;
		};

		const run = async () => {
			let backoff = BACKOFF_START_MS;
			while (alive) {
				if (document.hidden) {
					await rest(Number.POSITIVE_INFINITY);
					continue;
				}
				const open = new AbortController();
				controller = open;
				/** The connect's deadline, then the open stream's silence watch: whichever of them aborted `open` is why that abort is a failure and not the View's own. The host call just below is not timed here: it waits on the human's consent prompt, and the MCP SDK fails it after its own 60 s, a plain failure (reconnecting, and the next backoff tick asks again). */
				let deadline: Deadline | undefined;
				try {
					const grant = await client.stream(browserId);
					if (!alive) return;
					if (open.signal.aborted) continue;
					grantRef.current = grant;
					deadline = arm(open, CONNECT_TIMEOUT_MS);
					let response: Response;
					try {
						response = await fetch(`${grant.origin}/s/${grant.token}?${streamQuery(frozen)}`, { signal: open.signal, cache: "no-store" });
					} catch (cause) {
						if (open.signal.aborted && !deadline.expired) throw cause;
						throw new Error(`The live picture could not be reached (${deadline.expired ? silence(CONNECT_TIMEOUT_MS) : failureText(cause)}). A host that blocks http://127.0.0.1 does this.`);
					} finally {
						deadline.clear();
					}
					if (!response.ok || response.body === null) throw new Error(`The live picture answered ${response.status}.`);
					setError(null);
					setConnection("live");
					backoff = BACKOFF_START_MS;
					const reader = response.body.getReader();
					const messages = new Reader();
					/** The open stream's silence watch. Set up by the pack's first ping, which is the first thing it sends a View that asked for them: a pack that sends none (older than this View) is trusted as it always was, never read as stalled. */
					let watch: Deadline | undefined;
					try {
						for (;;) {
							const step = await reader.read();
							if (step.done) break;
							// Any bytes at all prove the pack is alive, whatever frame they carry: nothing is read to know that.
							watch?.restart();
							for (const message of messages.push(step.value)) {
								if (message.kind === KIND_PING && watch === undefined) watch = deadline = arm(open, STREAM_SILENCE_MS);
								else handle(message);
							}
						}
					} catch (cause) {
						if (watch?.expired !== true) throw cause;
						throw new Error(`The live picture went quiet (nothing arrived for ${Math.round(STREAM_SILENCE_MS / 1000)} s).`);
					} finally {
						watch?.clear();
					}
					// The pack ended it: its browser closed or the token was dropped. A new token tells which.
					grantRef.current = null;
					await rest(ENDED_RETRY_MS);
				} catch (cause) {
					if (!alive) return;
					// An abort the View made is not a failure; one a deadline made is.
					if (open.signal.aborted && deadline?.expired !== true) continue;
					grantRef.current = null;
					const detail = failureText(cause);
					setError(detail);
					if (GONE.test(detail)) {
						setConnection("gone");
						return;
					}
					if (NOT_APPROVED.test(detail)) {
						setConnection("unapproved");
						await rest(Number.POSITIVE_INFINITY);
						continue;
					}
					setConnection("reconnecting");
					await rest(backoff);
					backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
				}
			}
		};

		const onVisibility = () => {
			if (document.hidden) controller?.abort();
			else wakeRef.current();
		};
		document.addEventListener("visibilitychange", onVisibility);
		restartRef.current = () => controller?.abort();
		void run();

		return () => {
			alive = false;
			restartRef.current = () => {};
			wakeRef.current();
			controller?.abort();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [client, browserId, frozen]);

	const canvas = useCallback((element: HTMLCanvasElement | null) => {
		canvasRef.current = element;
		if (element && shownRef.current) draw(element, shownRef.current);
	}, []);

	// The input POSTs in flight: an unmount ends them, so none keeps a socket or a timer after the View is gone.
	const [posting] = useState(() => new Set<AbortController>());
	useEffect(() => () => posting.forEach(request => request.abort()), [posting]);

	const post = useCallback(async (events: readonly PageInputEvent[]) => {
		const grant = grantRef.current;
		if (grant === null) throw new Error("The live view is not connected yet.");
		const request = new AbortController();
		posting.add(request);
		const deadline = arm(request, INPUT_TIMEOUT_MS);
		try {
			let response: Response;
			try {
				response = await fetch(`${grant.origin}/i/${grant.token}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(events), signal: request.signal });
			} catch (cause) {
				// A deadline the View set is a page that was slow to answer, not a stream that is broken: the batch may still be applied, and the stream, which is held to its own silence watch, is left alone.
				// Any other failure (the socket refused or reset) may be a dead connection, so the stream is asked for afresh.
				if (!deadline.expired) restartRef.current();
				throw new Error(`Input could not be sent (${deadline.expired ? silence(INPUT_TIMEOUT_MS) : failureText(cause)}).`);
			}
			if (response.ok) return;
			// The token is gone (the pack restarted, or the View was away long enough): a new one.
			if (response.status === 404) restartRef.current();
			throw new Error(refusalText(await response.json().catch(() => null), response.status));
		} finally {
			deadline.clear();
			posting.delete(request);
		}
	}, [posting]);

	const push = useCallback((next: BrowserState) => {
		if (currentRef.current !== next.browserId) return;
		const key = JSON.stringify(next);
		if (key === stateKeyRef.current) return;
		stateKeyRef.current = key;
		setState(next);
	}, []);

	const refresh = useCallback(() => wakeRef.current(), []);

	return {
		state: state?.browserId === browserId ? state : null,
		picture: browserId === null ? null : picture,
		connection,
		error,
		canvas,
		post,
		push,
		refresh,
	};
}
