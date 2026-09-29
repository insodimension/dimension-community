import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { utils, type WorkBook, type WorkSheet } from "xlsx/dist/xlsx.mini.min.js";
import xlsx, { MAX_CELL_CHARS, MAX_COLS, MAX_ROWS } from "../app/view/renderers/xlsx";
import { installDom, stage, type TestDom } from "./dom";
import { buildXlsx } from "./office-fixtures";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = { filename: "book.xlsx", theme: "light" } as const;

/** 2026-09-30 as Excel stores a date: days since 1899-12-30. */
const SEPTEMBER_30_2026 = (Date.UTC(2026, 8, 30) - Date.UTC(1899, 11, 30)) / 86_400_000;

function salesSheet(): WorkSheet {
	const sheet = utils.aoa_to_sheet([
		["Sales 2026"],
		["Region", "Units", "Price", "Revenue", "Share", "Closed"],
		["EMEA", 120, 9.5],
		["APAC", 90, 11.25],
		["Total"],
		["Note", "<img src=x onerror=alert(1)>"],
	]);
	sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
	sheet.C3.z = "$#,##0.00";
	sheet.C4.z = "$#,##0.00";
	// A formula with the result the app that saved it calculated...
	sheet.D3 = { t: "n", v: 1140, f: "B3*C3", z: "$#,##0.00" };
	sheet.E3 = { t: "n", v: 0.256, z: "0.0%" };
	sheet.F3 = { t: "n", v: SEPTEMBER_30_2026, z: "yyyy-mm-dd" };
	// ...and one a script wrote without ever calculating it.
	sheet.D5 = { t: "n", f: "SUM(D3:D4)" };
	sheet["!ref"] = "A1:F6";
	return sheet;
}

function workbook(): WorkBook {
	const notes = utils.aoa_to_sheet([["Task", "Done"], ["Ship viewer", true]]);
	const archive = utils.aoa_to_sheet([["old"]]);
	return {
		SheetNames: ["Sales", "Notes", "Archive"],
		Sheets: { Sales: salesSheet(), Notes: notes, Archive: archive },
		Workbook: { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] },
	};
}

const cell = (el: HTMLElement, address: string): Element | null => el.querySelector(`td[data-cell="${address}"]`);

describe("xlsx renderer", () => {
	test("shows the values a person sees in Excel: formats, dates, merges, formulas", async () => {
		const el = stage(dom.document);
		const mounted = await xlsx.mount(el, buildXlsx(workbook()), ctx);

		// Number formats come from the cell's format, not the raw number.
		expect(cell(el, "C3")?.textContent).toBe("$9.50");
		expect(cell(el, "D3")?.textContent).toBe("$1,140.00");
		expect(cell(el, "E3")?.textContent).toBe("25.6%");
		expect(cell(el, "F3")?.textContent).toBe("2026-09-30");
		expect(cell(el, "A3")?.textContent).toBe("EMEA");

		// A merged block spans, and the cells it covers are not drawn.
		const merged = cell(el, "A1") as HTMLTableCellElement;
		expect(merged.colSpan).toBe(4);
		expect(cell(el, "B1")).toBeNull();
		expect(cell(el, "E1")).not.toBeNull();

		// A formula nobody calculated shows itself, not a blank.
		expect(cell(el, "D5")?.textContent).toBe("=SUM(D3:D4)");
		expect(cell(el, "D5")?.className).toContain("vo-raw");
		// A calculated one keeps its formula for the tooltip.
		expect(cell(el, "D3")?.getAttribute("title")).toBe("=B3*C3");
		mounted.destroy();
	});

	test("a cell is text, never markup", async () => {
		const el = stage(dom.document);
		await xlsx.mount(el, buildXlsx(workbook()), ctx);
		expect(cell(el, "B6")?.textContent).toBe("<img src=x onerror=alert(1)>");
		expect(el.querySelector("img")).toBeNull();
	});

	test("hidden sheets stay hidden, and the tabs and pager count what is visible", async () => {
		const el = stage(dom.document);
		const mounted = await xlsx.mount(el, buildXlsx(workbook()), ctx);
		const tabs = Array.from(el.querySelectorAll("[role=tab]")).map(tab => tab.textContent);
		expect(tabs).toEqual(["Sales", "Notes"]);
		expect(mounted.pageCount).toBe(2);

		const picked: number[] = [];
		const withPager = await xlsx.mount(stage(dom.document), buildXlsx(workbook()), { ...ctx, onPage: page => picked.push(page) });
		withPager.goto?.(2);
		expect(picked).toEqual([]); // a goto needs no echo
		mounted.goto?.(2);
		expect(cell(el, "A2")?.textContent).toBe("Ship viewer");
		expect(cell(el, "A1")?.textContent).toBe("Task");
		expect(el.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Notes");
	});

	test("a sheet past the caps shows its first window and says so", async () => {
		const rows = MAX_ROWS + 1500;
		const cols = MAX_COLS + 10;
		const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r + 1}c${c + 1}`));
		const book: WorkBook = { SheetNames: ["Big"], Sheets: { Big: utils.aoa_to_sheet(grid) } };

		const el = stage(dom.document);
		await xlsx.mount(el, buildXlsx(book), ctx);
		expect(el.querySelectorAll("tbody tr")).toHaveLength(MAX_ROWS);
		expect(el.querySelectorAll("thead th")).toHaveLength(MAX_COLS + 1); // + the row-number corner
		expect(cell(el, `A${MAX_ROWS}`)?.textContent).toBe(`r${MAX_ROWS}c1`);
		expect(cell(el, `A${MAX_ROWS + 1}`)).toBeNull();
		const note = el.querySelector("[role=status]")?.textContent ?? "";
		expect(note).toContain(`first ${MAX_ROWS.toLocaleString("en-US")} of ${rows.toLocaleString("en-US")} rows`);
		expect(note).toContain(`first ${MAX_COLS} of ${cols} columns`);
	});

	test("one enormous cell cannot become enormous DOM", async () => {
		const book: WorkBook = { SheetNames: ["S"], Sheets: { S: utils.aoa_to_sheet([["x".repeat(MAX_CELL_CHARS * 5)]]) } };
		const el = stage(dom.document);
		await xlsx.mount(el, buildXlsx(book), ctx);
		expect(cell(el, "A1")?.textContent?.length).toBeLessThanOrEqual(MAX_CELL_CHARS + 1);
	});

	test("a workbook whose every sheet is hidden says so instead of drawing nothing", async () => {
		const book = workbook();
		book.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 1 }, { Hidden: 2 }] };
		const el = stage(dom.document);
		await xlsx.mount(el, buildXlsx(book), ctx);
		expect(el.querySelector("[role=alert]")?.textContent).toMatch(/no visible sheets/i);
	});
});
