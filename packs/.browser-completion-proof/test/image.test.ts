/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `annotate` reads the page under
 *  the wrong rectangle, or dies on a bad region instead of refusing it. This is
 *  the pure half of annotation (no browser needed) and it pins the geometry
 *  contract the real-Chrome annotate test relies on: a region that runs off the
 *  edge is CLAMPED, a region that starts off the frame is REFUSED (never
 *  silently moved to somewhere the human never pointed at), and the origin of a
 *  clamped region is the one that was asked for.
 */
import { expect, test } from "bun:test";
import type { BrowserRegion, Viewport } from "../src/contracts";
import { clampRegion } from "../src/image";
import { BrowserRuntimeError } from "../src/store";

const FRAME: Viewport = { width: 8, height: 8 };

/** Run `work`, require a refusal, and yield its code. Resolving fails the test. */
function refusalCode(work: () => unknown): string {
	try {
		work();
	} catch (err) {
		if (err instanceof BrowserRuntimeError) return err.code;
		throw err;
	}
	throw new Error("expected clampRegion to refuse the region, but it returned");
}

test("clampRegion keeps a region that lies inside the frame exactly as asked", () => {
	expect(clampRegion({ x: 4, y: 0, width: 4, height: 8 }, FRAME)).toEqual({ x: 4, y: 0, width: 4, height: 8 });
});

test("clampRegion cuts a region that starts inside the frame and runs off its edge, keeping its origin", () => {
	expect(clampRegion({ x: 2, y: 6, width: 100, height: 100 }, FRAME)).toEqual({ x: 2, y: 6, width: 6, height: 2 });
});

test("clampRegion floors a fractional region to whole pixels", () => {
	expect(clampRegion({ x: 1.9, y: 2.2, width: 3.9, height: 1.1 }, FRAME)).toEqual({ x: 1, y: 2, width: 3, height: 1 });
});

const refused: ReadonlyArray<{ name: string; region: BrowserRegion }> = [
	{ name: "an origin at the right edge", region: { x: 8, y: 0, width: 4, height: 4 } },
	{ name: "an origin below the bottom edge", region: { x: 0, y: 9, width: 4, height: 4 } },
	{ name: "a negative origin", region: { x: -1, y: 0, width: 4, height: 4 } },
	{ name: "zero width", region: { x: 0, y: 0, width: 0, height: 4 } },
	{ name: "a negative height", region: { x: 0, y: 0, width: 4, height: -4 } },
	{ name: "a width that floors to nothing", region: { x: 0, y: 0, width: 0.4, height: 4 } },
	{ name: "a non-finite width", region: { x: 0, y: 0, width: Number.NaN, height: 4 } },
];

for (const { name, region } of refused) {
	test(`clampRegion refuses a region with ${name}`, () => {
		expect(refusalCode(() => clampRegion(region, FRAME))).toBe("bad_region");
	});
}
