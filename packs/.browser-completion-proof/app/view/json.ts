// The View's one boundary reader. Tool results arrive as `unknown` from the
// host; this module is the single place that turns them into typed fields, so
// no component ever asserts a shape it did not check.

/** The pack's canonical object guard — fields stay `unknown` on purpose. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field readers: used by every result parser in `browser-client.ts`, so the
 *  "absent or wrong type ⇒ undefined" rule is written down once. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
