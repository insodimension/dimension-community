/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a native list the page opened is not drawn over the Browser View's picture, so
 *  the person sees nothing open; or choosing in it (a click, or the arrow keys and Enter) does not reach the page as the
 *  pick of that list; or a click elsewhere leaves the page's list open behind the View's drawing; or the page gets keys the
 *  person meant for the list.
 *
 *  The View's page mounted on a linkedom document (`dom-harness.ts`), its input recorded instead of sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { NativePicker } from "../src/contracts";
import type { PageInputEvent } from "../src/input";
import { PageView } from "../app/view/page-view";
import { type Dom, mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

const VIEWPORT = { width: 800, height: 600 };

const PICKER: NativePicker = {
	id: "abc12345.1",
	box: { x: 40, y: 40, width: 200, height: 30 },
	options: [
		{ index: 0, label: "Alpha", disabled: false, group: null },
		{ index: 1, label: "Bravo", disabled: false, group: null },
		{ index: 2, label: "Charlie", disabled: true, group: null },
		{ index: 3, label: "Delta", disabled: false, group: "Later" },
		{ index: 4, label: "Echo", disabled: false, group: "Later" },
	],
	selected: 1,
	truncated: false,
};

async function page(picker: NativePicker | null, mode: "live" | "locked" = "live") {
	const sent: PageInputEvent[] = [];
	const dom = await mount(
		<PageView picture={{ viewport: VIEWPORT }} canvas={() => {}} viewport={VIEWPORT} mode={mode} onInput={(event) => sent.push(event)} onResize={() => {}} label="page" picker={picker} />,
	);
	return { dom, sent };
}

const option = (dom: Dom, label: string): Element => {
	const found = dom.find('[role="option"]').find((node) => node.textContent === label);
	if (found === undefined) throw new Error(`no option ${label}`);
	return found;
};

describe("the View draws a page's open native list", () => {
	test("every option in order, the group headings, the disabled one marked, the page's selected one highlighted, placed under the select", async () => {
		const { dom } = await page(PICKER);
		expect(dom.find('[role="option"]').map((node) => node.textContent)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
		expect(dom.find(".bx-picker-group").map((node) => node.textContent)).toEqual(["Later"]);
		expect(option(dom, "Charlie").getAttribute("aria-disabled")).toBe("true");
		expect(dom.find('[aria-selected="true"]').map((node) => node.textContent)).toEqual(["Bravo"]);
		const list = dom.find(".bx-picker")[0] as HTMLElement;
		expect(list.style.left).toBe("5%");
		expect(list.style.top).toBe(`${(70 / 600) * 100}%`);
	});

	test("no list is drawn when the page has none open", async () => {
		const { dom } = await page(null);
		expect(dom.find(".bx-picker")).toEqual([]);
	});

	test("a click on an option is that list's pick; a click on a disabled one is nothing", async () => {
		const { dom, sent } = await page(PICKER);
		await dom.click(option(dom, "Charlie"));
		expect(sent).toEqual([]);
		await dom.click(option(dom, "Delta"));
		expect(sent).toEqual([{ kind: "pick", picker: "abc12345.1", index: 3 }]);
	});

	test("the arrow keys move over the enabled options without reaching the page, and Enter picks the highlighted one", async () => {
		const { dom, sent } = await page(PICKER);
		const surface = dom.find(".bx-page")[0] as Element;
		await dom.key(surface, "ArrowDown");
		expect(dom.find('[aria-selected="true"]').map((node) => node.textContent)).toEqual(["Delta"]);
		await dom.key(surface, "End");
		await dom.key(surface, "ArrowUp");
		await dom.key(surface, "Enter");
		expect(sent).toEqual([{ kind: "pick", picker: "abc12345.1", index: 3 }]);
	});

	test("typing a letter jumps to the option it starts", async () => {
		const { dom, sent } = await page(PICKER);
		const surface = dom.find(".bx-page")[0] as Element;
		await dom.key(surface, "e");
		await dom.key(surface, "Enter");
		expect(sent).toEqual([{ kind: "pick", picker: "abc12345.1", index: 4 }]);
	});

	test("a press on the page outside the list closes the page's list with Escape and is not also a click on the page", async () => {
		const { dom, sent } = await page(PICKER);
		const surface = dom.find(".bx-page")[0] as Element;
		await dom.act(() => {
			surface.dispatchEvent(Object.assign(new Event("mousedown", { bubbles: true }), { button: 0, buttons: 1, detail: 1, clientX: 600, clientY: 500 }));
			surface.dispatchEvent(Object.assign(new Event("mouseup", { bubbles: true }), { button: 0, buttons: 0, detail: 1, clientX: 600, clientY: 500 }));
		});
		expect(sent).toEqual([
			{ kind: "key", type: "down", key: "Escape", code: "Escape", keyCode: 27 },
			{ kind: "key", type: "up", key: "Escape", code: "Escape", keyCode: 27 },
		]);
	});

	test("while an agent drives the page the list is shown but takes no pick", async () => {
		const { dom, sent } = await page(PICKER, "locked");
		expect(dom.find('[role="option"]')).toHaveLength(5);
		await dom.click(option(dom, "Alpha"));
		expect(sent).toEqual([]);
	});
});
