import { afterEach, beforeEach, expect, test } from "bun:test";
import { readLaneStatus } from "../x-reads";

const LANE_ENV = [
	"INSO_X_READ_BACKEND",
	"X_AUTH_TOKEN",
	"X_CT0",
	"AUTH_TOKEN",
	"CT0",
	"TWITTER_AUTH_TOKEN",
	"TWITTER_CT0",
	"BIRD_QUERY_IDS_CACHE",
	"BIRD_DISABLE_BROWSER_COOKIES",
] as const;

let prior: Record<string, string | undefined> = {};

beforeEach(() => {
	prior = Object.fromEntries(LANE_ENV.map(name => [name, process.env[name]]));
	for (const name of LANE_ENV) delete process.env[name];
	process.env.BIRD_DISABLE_BROWSER_COOKIES = "1";
});

afterEach(() => {
	for (const name of LANE_ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
});

test("sessions reading a cold lane together share one probe, and the answer stays cached", async () => {
	process.env.X_AUTH_TOKEN = "auth-shared";
	process.env.X_CT0 = "ct0-shared";

	const [first, second, third] = await Promise.all([readLaneStatus(), readLaneStatus(), readLaneStatus()]);

	expect(first.backend).toBe("bird");
	expect(second).toBe(first);
	expect(third).toBe(first);
	expect(await readLaneStatus()).toBe(first);
});

test("a probe that finds no cookies is shared by concurrent readers and cached like any other answer", async () => {
	const [first, second] = await Promise.all([readLaneStatus(), readLaneStatus()]);

	expect(first.backend).toBe("official");
	expect(first.cookieSource).toBeNull();
	expect(second).toBe(first);
	expect(await readLaneStatus()).toBe(first);
});

test("a reader under another backend mode never joins a probe resolved for the first mode", async () => {
	process.env.AUTH_TOKEN = "auth-mode-flip";
	process.env.CT0 = "ct0-mode-flip";

	const auto = readLaneStatus();
	process.env.INSO_X_READ_BACKEND = "official";
	const official = readLaneStatus();

	expect((await auto).backend).toBe("bird");
	expect((await official).backend).toBe("official");
});

test("setting cookie env vars takes effect at once instead of after the cached answer expires", async () => {
	const without = await readLaneStatus();
	expect(without.backend).toBe("official");

	process.env.X_AUTH_TOKEN = "auth-late";
	process.env.X_CT0 = "ct0-late";
	const withCookies = await readLaneStatus();

	expect(withCookies.backend).toBe("bird");
	expect(withCookies).not.toBe(without);
});
