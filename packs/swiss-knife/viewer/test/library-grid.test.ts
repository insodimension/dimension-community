import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type * as GridModule from "@fraym/ui/features/media-library";
import type { RowRange } from "@fraym/ui/features/media-library";
import type { LibraryItem } from "../../src/library/types";
import { installReact, type ReactEnv } from "./media-react";

const ROWS = 50_000;
const VIEWPORT = { width: 900, height: 480 };

let env: ReactEnv;
let grid: typeof GridModule;
const scrolls = new WeakMap<object, number>();

const itemAt = (id: string, index: number): LibraryItem => ({
	id,
	path: `/work/${index}.png`,
	name: `${index}.png`,
	tags: [],
	kind: "image",
	mime: "image/png",
	size: index,
	mtimeMs: 1,
	source: "present",
	starred: false,
	state: "live",
	createdAt: 1,
	presentedAt: 1,
	hasThumb: false,
	shares: [],
});

const items: readonly LibraryItem[] = Array.from({ length: ROWS }, (_, index) => itemAt(`a${index}`, index));

beforeAll(async () => {
	env = await installReact();
	const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
	Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => VIEWPORT.width });
	Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => VIEWPORT.height });
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: object) {
			return scrolls.get(this) ?? 0;
		},
		set(this: object, value: number) {
			scrolls.set(this, value);
		},
	});
	grid = await import("@fraym/ui/features/media-library");
});

afterEach(() => env.cleanup());
afterAll(() => {
	const proto = (globalThis as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
	for (const name of ["clientWidth", "clientHeight", "scrollTop"]) delete proto[name];
	env.restore();
});

function gridOf(rows: readonly LibraryItem[], layout: GridModule.LibraryLayout, ranges: RowRange[], selectedIndex: number) {
	return createElement(grid.LibraryGrid<LibraryItem>, {
		items: rows,
		layout,
		selectedIndex,
		label: "Artifacts",
		footer: null,
		renderItem: (item: LibraryItem) => createElement("span", null, item.name),
		onSelect: () => undefined,
		onOpen: () => undefined,
		onKey: () => undefined,
		onRange: mounted => void ranges.push(mounted),
	});
}

function render(layout: GridModule.LibraryLayout, ranges: RowRange[], selectedIndex = -1) {
	return env.mount(gridOf(items, layout, ranges, selectedIndex));
}

const options = (container: HTMLElement) => [...container.querySelectorAll('[role="option"]')];
const positions = (container: HTMLElement) => options(container).map(option => Number(option.getAttribute("aria-posinset")));

describe("the library grid with 50 000 rows", () => {
	test("mounts only the rows on screen and the overscan, not the list", async () => {
		const ranges: RowRange[] = [];
		const { container } = await render("list", ranges);
		const mounted = options(container).length;
		expect(mounted).toBeGreaterThan(0);
		expect(mounted).toBeLessThanOrEqual(Math.ceil(VIEWPORT.height / 48) + 1 + 3);
		expect(positions(container)[0]).toBe(1);
		expect(ranges.at(-1)).toEqual({ first: 0, end: mounted });
	});

	test("scrolling deep swaps the window on the next frame and keeps it the same size", async () => {
		const ranges: RowRange[] = [];
		const { container } = await render("list", ranges);
		const scroller = container.querySelector('[data-slot="library-grid"]') as HTMLElement;
		scroller.scrollTop = 4 + 30_000 * 48;
		await env.act(async () => {
			scroller.dispatchEvent(new window.Event("scroll"));
		});
		expect(env.pendingFrames()).toBe(1);
		await env.runFrames();
		const shown = positions(container);
		expect(Math.min(...shown)).toBe(30_000 - 3 + 1);
		expect(shown.length).toBeLessThanOrEqual(Math.ceil(VIEWPORT.height / 48) + 1 + 6);
		expect(ranges.at(-1)?.first).toBe(30_000 - 3);
	});

	test("a burst of scroll events costs one frame of work", async () => {
		const { container } = await render("grid", []);
		const scroller = container.querySelector('[data-slot="library-grid"]') as HTMLElement;
		await env.act(async () => {
			for (let step = 1; step <= 20; step++) {
				scroller.scrollTop = step * 50;
				scroller.dispatchEvent(new window.Event("scroll"));
			}
		});
		expect(env.pendingFrames()).toBe(1);
		await env.runFrames();
		expect(env.pendingFrames()).toBe(0);
	});

	test("a selection far below is scrolled into view and mounted", async () => {
		const { container } = await render("list", [], 40_000);
		expect(positions(container)).toContain(40_001);
		const listbox = container.querySelector('[role="listbox"]');
		expect(listbox?.getAttribute("aria-activedescendant")).toBe(`${grid.OPTION_ID_PREFIX}a40000`);
	});

	test("rows inserted or removed above the selected row shift its index but do not scroll: a view scrolled away from the selection stays where it is", async () => {
		const view = await env.mount(gridOf(items, "list", [], 100));
		const scroller = view.container.querySelector('[data-slot="library-grid"]') as HTMLElement;
		scroller.scrollTop = 0;
		await env.act(async () => {
			scroller.dispatchEvent(new window.Event("scroll"));
		});
		await env.runFrames();
		expect(positions(view.container)[0]).toBe(1);

		const above = Array.from({ length: 3 }, (_, index) => itemAt(`new${index}`, index));
		await view.render(gridOf([...above, ...items], "list", [], 103));
		expect(scroller.scrollTop).toBe(0);
		expect(positions(view.container)[0]).toBe(1);

		await view.render(gridOf(items, "list", [], 100));
		expect(scroller.scrollTop).toBe(0);
		expect(positions(view.container)[0]).toBe(1);
	});

	test("moving the selection to another row below the view scrolls to it", async () => {
		const view = await env.mount(gridOf(items, "list", [], 0));
		expect(positions(view.container)).not.toContain(101);

		await view.render(gridOf(items, "list", [], 100));

		expect(positions(view.container)).toContain(101);
		const listbox = view.container.querySelector('[role="listbox"]');
		expect(listbox?.getAttribute("aria-activedescendant")).toBe(`${grid.OPTION_ID_PREFIX}a100`);
	});
});
