// The frame loop. One sequential walker, never more than one call in flight:
//   • live            → `browser_frame` jpeg every ~100 ms, naming the frame on
//                       screen (`since`); the server answers from memory and,
//                       while the page is still, sends back only the state — no
//                       pixels cross the host for a frame already shown.
//   • frozen          → annotating: the picture MUST NOT move under a drawing,
//                       so pixels stop and `browser_state` keeps tabs and task
//                       progress live at a slow cadence.
//   • document hidden → the seat is off screen; nothing is polled until it
//                       returns.
// Failures back off exponentially and are reported; an unknown browserId is
// terminal (the browser was closed elsewhere) and stops the loop.
import { useEffect, useRef, useState } from "react";
import type { BrowserFrame, BrowserState } from "../../src/contracts";
import { type BrowserClient, failureText } from "./browser-client";

const LIVE_INTERVAL_MS = 100;
const FROZEN_INTERVAL_MS = 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;
const GONE = /unknown or already closed browserId/i;

export type Connection = "connecting" | "live" | "reconnecting" | "gone";

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
					const next = await client.frame(browserId, "jpeg", lastFrameId || undefined);
					if (!alive || currentRef.current !== browserId) return;
					if (!("unchanged" in next) && next.frameId !== lastFrameId && !frozenRef.current) {
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
				setConnection("reconnecting");
				schedule(backoff);
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			} finally {
				inFlight = false;
			}
		};

		const onVisibility = () => {
			window.clearTimeout(timer);
			if (alive && !document.hidden && !inFlight) schedule(0);
		};
		document.addEventListener("visibilitychange", onVisibility);
		kickRef.current = () => {
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
