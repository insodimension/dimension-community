import { afterAll, beforeAll } from "bun:test";

/**
 * The jev task tools (`browser_task*`) exist only where `TYPESAFE_API_KEY` is set when the server is created. A test file that
 * calls them registers this, so its servers are built with the key and the real environment is put back afterwards.
 */
export function withJevKey(): void {
	let saved: string | undefined;
	beforeAll(() => {
		saved = process.env.TYPESAFE_API_KEY;
		process.env.TYPESAFE_API_KEY = "test-key";
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = saved;
	});
}
