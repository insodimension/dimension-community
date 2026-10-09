/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the View and the agent lose the
 *  browser whenever a page moves between sites. A cross-site navigation swaps
 *  the renderer process and briefly detaches the page's CDP session ("Not
 *  attached to an active page"); a state read that lands in that window used to
 *  throw, so polling the View — or an agent reading state while a task agent
 *  browses — failed on ordinary navigations nobody asked the runtime to make.
 */
import { afterEach, expect, test } from "bun:test";
import type { BrowserState } from "../src/contracts";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, perform, startFixture, teardown } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const BOUNCES = 24;
const READERS = 3;

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("state", () => {
	test(
		"state reads never fail while the page bounces between two sites on its own",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "bouncer", viewport: VIEWPORT }, { caller: "app" });
			// Even bounce count: the chain ends on the host it started from.
			const end = fixture.url("/bounce?left=0");

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url(`/bounce?left=${BOUNCES}`) });
			let midChainReads = 0;
			let last: BrowserState | undefined;
			const deadline = Date.now() + 60_000;
			while (last?.url !== end) {
				if (Date.now() > deadline) throw new Error(`bounce chain never finished; last at ${last?.url}`);
				// Several readers at once, as the View's poll and an agent would be.
				const reads = await Promise.all(Array.from({ length: READERS }, () => runtime.state(browserId)));
				midChainReads += reads.filter((read) => read.url !== end).length;
				last = reads.at(-1);
			}

			expect(last.title).toBe("bounced");
			// Not vacuous: the page really crossed sites on every hop (one request
			// per hop, no reloads), and reads really ran while it did. How many
			// land mid-chain depends on machine load, so only "some" is asserted.
			expect(fixture.hits("/bounce")).toBe(BOUNCES + 1);
			expect(midChainReads).toBeGreaterThan(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
