import { describe, expect, test } from "bun:test";
import { MAX_ZOOM, MIN_ZOOM, stepZoom } from "../app/view/zoom";

describe("stepZoom", () => {
	test("moves one rung and never leaves the limits", () => {
		expect(stepZoom(1, "in")).toBeGreaterThan(1);
		expect(stepZoom(1, "out")).toBeLessThan(1);
		expect(stepZoom(MAX_ZOOM, "in")).toBe(MAX_ZOOM);
		expect(stepZoom(MIN_ZOOM, "out")).toBe(MIN_ZOOM);
	});

	test("from a value between rungs, the next rung in that direction", () => {
		expect(stepZoom(1.2, "in")).toBe(1.25);
		expect(stepZoom(1.2, "out")).toBe(1.1);
	});

	test("in then out returns to the start from a rung", () => {
		expect(stepZoom(stepZoom(1.5, "in"), "out")).toBe(1.5);
	});
});
