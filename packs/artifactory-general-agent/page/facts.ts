// How the page reads the Store: one watch per key, per page. `sessions/list` is
// republished on every streaming event, so it is read COALESCED (the newest
// value at most every ~250 ms) and folded once for the whole roster.
import { useObservable } from "@fraym/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentActivity, foldActivity, shareActivity } from "./kpis";
import type { ObservableFact, PageStore, SessionRow } from "./types";
import { SESSIONS_KEY } from "./types";

const ABSENT: ObservableFact<never> = { getSnapshot: () => undefined, subscribe: () => () => undefined };

/** A root fact, live. */
export function useFact<T>(store: PageStore, key: string): T | undefined {
	const observable = useMemo(() => store.watch<T>(key) ?? ABSENT, [store, key]);
	return useObservable(observable as Parameters<typeof useObservable>[0]) as T | undefined;
}

/** A fact read at most once per `ms`: the newest value after a quiet window,
 *  so a stream of republishes costs one render, not one per event. */
export function useCoalescedFact<T>(store: PageStore, key: string, ms: number): T | undefined {
	const observable = useMemo(() => store.watch<T>(key) ?? ABSENT, [store, key]);
	const [value, setValue] = useState<T | undefined>(() => observable.getSnapshot());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			timer = undefined;
			setValue(observable.getSnapshot());
		};
		const unsubscribe = observable.subscribe(() => {
			timer ??= setTimeout(flush, ms);
		});
		setValue(observable.getSnapshot());
		return () => {
			unsubscribe();
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [observable, ms]);
	return value;
}

/** Wall-clock time, ticking every `ms` (relative times and the 7-day window). */
export function useNow(ms: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(id);
	}, [ms]);
	return now;
}

/** Every agent's activity, folded once per coalesced catalog. An agent whose
 *  numbers did not move keeps the object it had (`shareActivity`), so its card
 *  can be skipped. */
export function useActivity(store: PageStore, now: number, defaultAgent: string): ReadonlyMap<string, AgentActivity> {
	const rows = useCoalescedFact<readonly SessionRow[]>(store, SESSIONS_KEY, 250);
	const previous = useRef<ReadonlyMap<string, AgentActivity> | undefined>(undefined);
	return useMemo(() => {
		const next = shareActivity(previous.current, foldActivity(rows, now, defaultAgent));
		previous.current = next;
		return next;
	}, [rows, now, defaultAgent]);
}

/** A read that is repeated on demand and while the page is visible. */
export interface Polled<T> {
	readonly value: T | undefined;
	readonly error: string | undefined;
	/** Read again. Resolves once that read has settled, its answer or its
	 *  error shown (or a newer read has taken over); never rejects. */
	readonly refresh: () => Promise<void>;
}

/** `key` re-reads at once when it changes (the workspace the read is for). */
export function usePolled<T>(read: () => Promise<T>, ms: number | null, key: unknown): Polled<T> {
	const [value, setValue] = useState<T | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const readRef = useRef(read);
	readRef.current = read;
	const seq = useRef(0);
	const refresh = useCallback((): Promise<void> => {
		const mine = ++seq.current;
		return readRef.current().then(
			next => {
				if (mine !== seq.current) return;
				setValue(next);
				setError(undefined);
			},
			(cause: unknown) => {
				if (mine !== seq.current) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
	}, []);
	useEffect(() => {
		void refresh();
		if (ms === null) return;
		const id = setInterval(() => {
			if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
		}, ms);
		return () => clearInterval(id);
	}, [refresh, ms, key]);
	return { value, error, refresh };
}
