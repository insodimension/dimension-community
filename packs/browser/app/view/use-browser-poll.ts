// The frame loop. One sequential walker, never more than one call in flight:
//   • live            → `browser_frame` jpeg every ~100 ms; the server answers
//                       the latest screencast frame from memory, so this is
//                       cheap on both sides. An unchanged frameId is not
//                       re-decoded.
//   • frozen          → annotating: the picture MUST NOT move under a drawing,
//                       so pixels stop and `browser_state` keeps tabs and task
//                       progress live at a slow cadence.
//   • document hidden → the seat is off screen; nothing is polled until it
//                       returns.
// Failures back off exponentially and are reported; an unknown browserId is
// terminal (the browser was closed elsewhere) and stops the loop. So does a
// call the HOST refused to approve (a third-party pack's View calls are
// consent-gated): retrying it would raise a fresh consent prompt on every
// backoff tick, forever, and bury whatever else is waiting for the human
// (friction #59). It waits for `refresh()` — the human asking again.
import { useEffect, useRef, useState } from "react";
import type { BrowserFrame, BrowserState } from "../../src/contracts";
import { type BrowserClient, failureText } from "./browser-client";

const LIVE_INTERVAL_MS = 100;
const FROZEN_INTERVAL_MS = 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;
const GONE = /unknown or already closed browserId/i;
/** The host's consent refusal (a denied or expired prompt), not a server failure. */
const NOT_APPROVED = /was not approved/i;

export type Connection = "connecting" | "live" | "reconnecting" | "unapproved" | "gone";

export interface BrowserPoll {
	/** The newest live frame for the CURRENT browserId, or null before the first. */
	readonly frame: BrowserFrame | null;
	/** The newest state — from a frame, a frozen state read, or a caller push. */
	readonly state: BrowserState | null;
	readonly connection: Connection;
	/** The live failure, cleared by the next success. */
	readonly error: string | null;
	/** Fold a state the UI obtained itself (an action, a tab op) into the loop. */
	push(state: BrowserState): void;
	/** Poll now rather than at the next interval. */
	refresh(): void;
}

export function useBrowserPoll(client: BrowserClient, browserId: string | null, frozen: boolean): BrowserPoll {
	const [frame, setFrame] = useState<BrowserFrame | null>(null);
	const [state, setState] = useState<BrowserState | null>(null);
	const [connection, setConnection] = useState<Connection>("connecting");
	const [error, setError] = useState<string | null>(null);

	const frozenRef = useRef(frozen);
	frozenRef.current = frozen;
	const currentRef = useRef<string | null>(browserId);
	currentRef.current = browserId;
	const kickRef = useRef<() => void>(() => {});
	const stateKeyRef = useRef("");

	useEffect(() => {
		setFrame(null);
		setState(null);
		setError(null);
		setConnection("connecting");
		stateKeyRef.current = "";
		if (browserId === null) return;

		let alive = true;
		let timer: number | undefined;
		let backoff = BACKOFF_START_MS;
		let inFlight = false;
		let kicked = false;
		let lastFrameId = "";
		/** Refused by the host: only `refresh()` polls again, never a timer or a visibility change. */
		let halted = false;

		const schedule = (delay: number) => {
			if (!alive) return;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => void tick(), delay);
		};

		const accept = (next: BrowserState) => {
			const key = JSON.stringify(next);
			if (key === stateKeyRef.current) return;
			stateKeyRef.current = key;
			setState(next);
		};

		const tick = async (): Promise<void> => {
			if (!alive || inFlight || document.hidden) return;
			inFlight = true;
			kicked = false;
			try {
				if (frozenRef.current) {
					const next = await client.state(browserId);
					if (!alive || currentRef.current !== browserId) return;
					accept(next);
				} else {
					const next = await client.frame(browserId, "jpeg");
					if (!alive || currentRef.current !== browserId) return;
					if (next.frameId !== lastFrameId && !frozenRef.current) {
						lastFrameId = next.frameId;
						setFrame(next);
					}
					accept(next.state);
				}
				setError(null);
				setConnection("live");
				backoff = BACKOFF_START_MS;
				schedule(kicked ? 0 : frozenRef.current ? FROZEN_INTERVAL_MS : LIVE_INTERVAL_MS);
			} catch (cause) {
				if (!alive || currentRef.current !== browserId) return;
				const detail = failureText(cause);
				setError(detail);
				if (GONE.test(detail)) {
					setConnection("gone");
					return;
				}
				if (NOT_APPROVED.test(detail)) {
					setConnection("unapproved");
					backoff = BACKOFF_START_MS;
					halted = true;
					return;
				}
				setConnection("reconnecting");
				schedule(backoff);
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			} finally {
				inFlight = false;
			}
		};

		const onVisibility = () => {
			window.clearTimeout(timer);
			if (alive && !halted && !document.hidden && !inFlight) schedule(0);
		};
		document.addEventListener("visibilitychange", onVisibility);
		kickRef.current = () => {
			halted = false;
			if (inFlight) kicked = true;
			else schedule(0);
		};
		void tick();

		return () => {
			alive = false;
			kickRef.current = () => {};
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [client, browserId]);

	const push = (next: BrowserState) => {
		if (currentRef.current !== next.browserId) return;
		const key = JSON.stringify(next);
		if (key === stateKeyRef.current) return;
		stateKeyRef.current = key;
		setState(next);
	};

	return {
		frame: frame?.state.browserId === browserId ? frame : null,
		state: state?.browserId === browserId ? state : null,
		connection,
		error,
		push,
		refresh: () => kickRef.current(),
	};
}
