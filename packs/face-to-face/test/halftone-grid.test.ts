import { describe, expect, test } from "bun:test";
import { type GridInput, halftoneGrid } from "../src/face/halftone-grid";

/** A 1600x900 CSS workspace at `ratio` device pixels per CSS pixel, head crown-to-chin at half the height. */
function input(ratio: number, extra: Partial<GridInput> = {}): GridInput {
	const w = 1600 * ratio, h = 900 * ratio;
	return { width: w, height: h, ratio, headPx: h * 0.5, origin: [w * 0.5, h * 0.43], halfExtent: [300 * ratio, 330 * ratio], low: false, ...extra };
}

describe("halftone grid", () => {
	test("the dot pitch follows the head in CSS pixels, not the device pixel ratio", () => {
		const a = halftoneGrid(input(1));
		const b = halftoneGrid(input(2));
		expect(b.cell / 2).toBeCloseTo(a.cell, 6);
		expect(b.cols).toBe(a.cols);
		expect(b.rows).toBe(a.rows);
		// the G-buffer is sized per cell, so a sharper screen does not cost more rasterisation
		expect(Math.abs(b.gw - a.gw)).toBeLessThanOrEqual(1);
	});

	test("the grid covers everything that can draw around the anchor, and a cell centre sits on the anchor", () => {
		const i = input(1);
		const g = halftoneGrid(i);
		expect(g.x0).toBeLessThanOrEqual(i.origin[0] - i.halfExtent[0]);
		expect(g.x0 + g.cols * g.cell).toBeGreaterThanOrEqual(i.origin[0] + i.halfExtent[0]);
		expect(g.y0).toBeLessThanOrEqual(i.origin[1] - i.halfExtent[1]);
		expect(g.y0 + g.rows * g.cell).toBeGreaterThanOrEqual(i.origin[1] + i.halfExtent[1]);
		const col = (i.origin[0] - g.x0) / g.cell - 0.5;
		expect(col).toBeCloseTo(Math.round(col), 6);
	});

	test("a head larger than the canvas spends no cells off-screen", () => {
		const i = input(1, { halfExtent: [5000, 5000] });
		const g = halftoneGrid(i);
		expect(g.x0).toBeGreaterThanOrEqual(-g.cell);
		expect(g.y0).toBeGreaterThanOrEqual(-g.cell);
		expect(g.x0 + g.cols * g.cell).toBeLessThanOrEqual(i.width + g.cell);
		expect(g.y0 + g.rows * g.cell).toBeLessThanOrEqual(i.height + g.cell);
	});

	test("a tiny head keeps a readable dot pitch", () => {
		const g = halftoneGrid(input(1, { headPx: 60 }));
		expect(g.cell).toBeGreaterThanOrEqual(4);
	});

	test("low quality draws fewer, larger dots into a coarser G-buffer", () => {
		const hi = halftoneGrid(input(1));
		const lo = halftoneGrid(input(1, { low: true }));
		expect(lo.cell).toBeGreaterThan(hi.cell);
		expect(lo.cols * lo.rows).toBeLessThan(hi.cols * hi.rows);
		expect(lo.gw * lo.gh).toBeLessThan(hi.gw * hi.gh);
	});
});
