// A one-cell observable: the shape the fenced Store's `watch` returns, plus the harness's own writer.
export interface Observable<T> {
	getSnapshot(): T | undefined;
	subscribe(listener: () => void): () => void;
	set(next: T | undefined): void;
}

export function observable<T>(initial: T | undefined): Observable<T> {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		set(next: T | undefined) {
			value = next;
			for (const listener of listeners) listener();
		},
	};
}
