import { describe, expect, test } from "bun:test";
import { GRID_LAYOUT, gridGeometry, itemRange, LIST_LAYOUT, moveSelection, revealScrollTop, rowTop, visibleRows, wantsNextPage } from "@fraym/ui/features/media-library";

const ROWS = 50_000;

describe("library window math", () => {
	test("columns fill the width and never drop below one", () => {
		expect(gridGeometry(12 + 168 + 12, 10, GRID_LAYOUT).columns).toBe(1);
		expect(gridGeometry(12 * 2 + 168 * 3 + 12 * 2, 10, GRID_LAYOUT).columns).toBe(3);
		expect(gridGeometry(12 * 2 + 168 * 3 + 12 * 2 - 1, 10, GRID_LAYOUT).columns).toBe(2);
		expect(gridGeometry(0, 10, GRID_LAYOUT).columns).toBe(1);
		expect(gridGeometry(2000, 10, LIST_LAYOUT).columns).toBe(1);
	});

	test("the total height is every row, its gaps and the padding, and nothing for no rows", () => {
		const list = gridGeometry(800, ROWS, LIST_LAYOUT);
		expect(list.totalHeight).toBe(LIST_LAYOUT.padding * 2 + ROWS * LIST_LAYOUT.rowHeight);
		expect(gridGeometry(800, 0, GRID_LAYOUT).totalHeight).toBe(0);
	});

	test("at the top only the rows on screen and the overscan below are mounted", () => {
		const geometry = gridGeometry(800, ROWS, LIST_LAYOUT);
		const range = visibleRows(0, 480, geometry, 3);
		expect(range.first).toBe(0);
		expect(range.end).toBe(Math.ceil((480 - LIST_LAYOUT.padding) / LIST_LAYOUT.rowHeight) + 3);
	});

	test("deep in 50k rows the window is the same small size, overscan on both sides", () => {
		const geometry = gridGeometry(800, ROWS, LIST_LAYOUT);
		const scrollTop = rowTop(30_000, geometry);
		const range = visibleRows(scrollTop, 480, geometry, 3);
		expect(range.first).toBe(30_000 - 3);
		expect(range.end - range.first).toBeLessThanOrEqual(Math.ceil(480 / LIST_LAYOUT.rowHeight) + 1 + 6);
		const items = itemRange(range, geometry, ROWS);
		expect(items).toEqual(range);
	});

	test("the last row is reachable and the window never runs past the end", () => {
		const geometry = gridGeometry(800, ROWS, LIST_LAYOUT);
		const range = visibleRows(geometry.totalHeight - 480, 480, geometry, 3);
		expect(range.end).toBe(ROWS);
		expect(visibleRows(geometry.totalHeight * 2, 480, geometry, 3).end).toBe(ROWS);
	});

	test("a grid window maps rows to items and clamps the ragged last row", () => {
		const geometry = gridGeometry(12 * 2 + 168 * 4 + 12 * 3, 10, GRID_LAYOUT);
		expect(geometry.columns).toBe(4);
		expect(geometry.rowCount).toBe(3);
		expect(itemRange(visibleRows(0, 2000, geometry, 3), geometry, 10)).toEqual({ first: 0, end: 10 });
	});

	test("a resize that changes the column count changes the window, not the scroll math", () => {
		const wide = gridGeometry(1400, ROWS, GRID_LAYOUT);
		const narrow = gridGeometry(400, ROWS, GRID_LAYOUT);
		expect(wide.columns).toBeGreaterThan(narrow.columns);
		const wideItems = itemRange(visibleRows(0, 600, wide, 0), wide, ROWS);
		const narrowItems = itemRange(visibleRows(0, 600, narrow, 0), narrow, ROWS);
		expect(wideItems.end).toBeGreaterThan(narrowItems.end);
		expect(visibleRows(0, 0, wide, 0)).toEqual({ first: 0, end: 1 });
	});

	test("computing the window for every scroll position of 50k rows is far inside a frame", () => {
		const geometry = gridGeometry(1200, ROWS, GRID_LAYOUT);
		const started = performance.now();
		let mounted = 0;
		for (let top = 0; top < geometry.totalHeight; top += 37) {
			const range = itemRange(visibleRows(top, 900, geometry), geometry, ROWS);
			mounted = Math.max(mounted, range.end - range.first);
		}
		const perStep = (performance.now() - started) / (geometry.totalHeight / 37);
		expect(perStep).toBeLessThan(0.05);
		expect(mounted).toBeLessThanOrEqual(geometry.columns * (Math.ceil(900 / (GRID_LAYOUT.rowHeight + GRID_LAYOUT.gap)) + 1 + 6));
	});

	test("revealing a row scrolls only as far as needed, and not at all when it is on screen", () => {
		const geometry = gridGeometry(800, ROWS, LIST_LAYOUT);
		expect(revealScrollTop(2, 0, 480, geometry)).toBeNull();
		const below = revealScrollTop(100, 0, 480, geometry);
		expect(below).toBe(rowTop(100, geometry) + LIST_LAYOUT.rowHeight + LIST_LAYOUT.padding - 480);
		expect(revealScrollTop(0, 5000, 480, geometry)).toBe(0);
	});

	test("arrows move by one or by a row of columns and stop at the ends", () => {
		expect(moveSelection(-1, "ArrowDown", 4, 10, 3)).toBe(0);
		expect(moveSelection(1, "ArrowDown", 4, 10, 3)).toBe(5);
		expect(moveSelection(9, "ArrowDown", 4, 10, 3)).toBe(9);
		expect(moveSelection(0, "ArrowLeft", 4, 10, 3)).toBe(0);
		expect(moveSelection(2, "End", 4, 10, 3)).toBe(9);
		expect(moveSelection(9, "PageUp", 4, 10, 1)).toBe(5);
		expect(moveSelection(0, "ArrowRight", 4, 0, 3)).toBe(-1);
	});

	test("the next page is asked for once the window nears the loaded end, and never without a cursor", () => {
		expect(wantsNextPage(150, 200, true, 60)).toBe(true);
		expect(wantsNextPage(100, 200, true, 60)).toBe(false);
		expect(wantsNextPage(200, 200, false, 60)).toBe(false);
	});
});
