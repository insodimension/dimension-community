// Excel workbooks, read by SheetJS CE 0.20.3 (Apache-2.0, the `mini` build: 84 KB
// gzip in this pack's build; the npm `xlsx` 0.18.5 is frozen at 2022 with published
// advisories, which is why the pack installs SheetJS's own tarball) and drawn by us.
//
// SheetJS is used as a PARSER only. Its `sheet_to_html` is never called: the grid
// is built cell by cell with `textContent`, so a hostile cell can only ever be
// text, and the same pass is where the caps live. SheetJS CE reads values,
// formats, merges, widths and hidden rows/columns; it does not surface fills or
// fonts, so a sheet looks like a plain grid (measured, § Measured).
//
// What the pane promises:
//   - the values a person sees in Excel: number formats and dates come from the
//     cell's formatted text (`w`), not the raw number;
//   - a formula whose result was never calculated (openpyxl and most agent
//     scripts write formulas without a cached value) shows as its own text, muted
//     and italic, instead of an empty cell;
//   - merged cells span, hidden rows/columns/sheets stay hidden;
//   - a sheet larger than the caps shows its first MAX_ROWS x MAX_COLS window and
//     says so, and the parser is told to stop at MAX_ROWS (`sheetRows`) so a
//     million-row export is not read at all.
// The sheet tabs are a strip inside the pane; `pageCount`/`goto` mirror them.

import { read, utils, type CellObject, type WorkSheet } from "xlsx/dist/xlsx.mini.min.js";
import { clampZoom, EXCEL, mountOffice, ProblemError } from "./office/shared";
import type { Mounted, MountContext, Renderer } from "./types";

/** Rows drawn per sheet, and the count SheetJS is told to stop reading at. */
export const MAX_ROWS = 1000;
/** Columns drawn per sheet (A..AX). */
export const MAX_COLS = 50;
/** Sheet tabs offered. */
export const MAX_SHEETS = 100;
/** Characters of one cell drawn; a 32,000-character cell in every cell of a window would be gigabytes of DOM. */
export const MAX_CELL_CHARS = 1000;

const DEFAULT_COLUMN_PX = 64;
const GUTTER_PX = 44;

export type CellKind = "text" | "number" | "flag" | "raw";

export interface GridCell {
	/** What is drawn. */
	readonly text: string;
	readonly kind: CellKind;
	/** The formula behind a value, for the tooltip; for `raw` it is also the text. */
	readonly formula?: string;
}

/** A merged block whose top-left cell is inside the window, clipped to it. */
export interface Merge {
	readonly row: number;
	readonly col: number;
	readonly rowSpan: number;
	readonly colSpan: number;
}

/** One sheet, reduced to what is drawn. Rows and columns are 0-based and start at A1. */
export interface SheetModel {
	readonly name: string;
	readonly rows: number;
	readonly cols: number;
	/** The sheet's real extent, which is larger than `rows`/`cols` when it was capped. */
	readonly totalRows: number;
	readonly totalCols: number;
	readonly cells: ReadonlyArray<ReadonlyArray<GridCell | undefined>>;
	readonly merges: readonly Merge[];
	readonly columnWidths: readonly number[];
	readonly hiddenColumns: readonly boolean[];
	readonly hiddenRows: readonly boolean[];
	readonly rowHeights: readonly (number | undefined)[];
}

function clip(text: string): string {
	return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

function describeCell(cell: CellObject): GridCell | undefined {
	// A formula nobody calculated has no cached value: a `z` stub (the file said `<v></v>`)
	// or, when SheetJS wrote it, an `e` cell with no value at all.
	if (cell.f && (cell.t === "z" || cell.v === undefined)) return { text: clip(`=${cell.f}`), kind: "raw", formula: cell.f };
	if (cell.t === "z") return undefined;
	const text = clip(cell.w ?? (cell.v == null ? "" : String(cell.v)));
	const kind: CellKind = cell.t === "n" || cell.t === "d" ? "number" : cell.t === "b" || cell.t === "e" ? "flag" : "text";
	return { text, kind, ...(cell.f ? { formula: cell.f } : {}) };
}

/** Reduce one parsed sheet to the capped window that is drawn. Pure. */
export function buildSheetModel(name: string, sheet: WorkSheet): SheetModel {
	const ref = sheet["!ref"];
	const extent = (sheet["!fullref"] as string | undefined) ?? ref;
	if (!ref || !extent) {
		return { name, rows: 0, cols: 0, totalRows: 0, totalCols: 0, cells: [], merges: [], columnWidths: [], hiddenColumns: [], hiddenRows: [], rowHeights: [] };
	}
	const readRange = utils.decode_range(ref);
	const full = utils.decode_range(extent);
	const rows = Math.min(readRange.e.r + 1, MAX_ROWS);
	const cols = Math.min(readRange.e.c + 1, MAX_COLS);

	const cells: (GridCell | undefined)[][] = [];
	for (let row = 0; row < rows; row++) {
		const line: (GridCell | undefined)[] = [];
		for (let col = 0; col < cols; col++) {
			const cell = sheet[utils.encode_cell({ r: row, c: col })] as CellObject | undefined;
			line.push(cell ? describeCell(cell) : undefined);
		}
		cells.push(line);
	}

	const merges: Merge[] = [];
	for (const merge of sheet["!merges"] ?? []) {
		if (merge.s.r >= rows || merge.s.c >= cols) continue;
		const rowSpan = Math.min(merge.e.r, rows - 1) - merge.s.r + 1;
		const colSpan = Math.min(merge.e.c, cols - 1) - merge.s.c + 1;
		if (rowSpan > 1 || colSpan > 1) merges.push({ row: merge.s.r, col: merge.s.c, rowSpan, colSpan });
	}

	const columnInfo = sheet["!cols"] ?? [];
	const rowInfo = sheet["!rows"] ?? [];
	const columnWidths: number[] = [];
	const hiddenColumns: boolean[] = [];
	for (let col = 0; col < cols; col++) {
		const info = columnInfo[col];
		// `width` is in Excel's own unit, characters of the default font at 7 px each;
		// SheetJS's `wpx` multiplies by a digit width it guesses, which can be narrower
		// than Excel's and clips numbers the author sized to fit.
		const width = info?.width === undefined ? (info?.wpx ?? DEFAULT_COLUMN_PX) : Math.round(info.width * 7);
		columnWidths.push(Math.min(480, Math.max(24, width)));
		hiddenColumns.push(info?.hidden === true);
	}
	const hiddenRows: boolean[] = [];
	const rowHeights: (number | undefined)[] = [];
	for (let row = 0; row < rows; row++) {
		const info = rowInfo[row];
		hiddenRows.push(info?.hidden === true);
		rowHeights.push(info?.hpx === undefined ? undefined : Math.min(240, Math.max(12, info.hpx)));
	}

	return {
		name,
		rows,
		cols,
		totalRows: full.e.r + 1,
		totalCols: full.e.c + 1,
		cells,
		merges,
		columnWidths,
		hiddenColumns,
		hiddenRows,
		rowHeights,
	};
}

/** The visible note under a capped sheet, or "" when the whole sheet is drawn. */
export function truncationNote(model: SheetModel, sheetsOffered: number, sheetsTotal: number): string {
	const parts: string[] = [];
	if (model.totalRows > model.rows) {
		parts.push(`the first ${model.rows.toLocaleString("en-US")} of ${model.totalRows.toLocaleString("en-US")} rows`);
	}
	if (model.totalCols > model.cols) {
		parts.push(`the first ${model.cols.toLocaleString("en-US")} of ${model.totalCols.toLocaleString("en-US")} columns`);
	}
	if (sheetsTotal > sheetsOffered) parts.push(`the first ${sheetsOffered} of ${sheetsTotal} sheets`);
	return parts.length === 0 ? "" : `Showing ${parts.join(", ")}.`;
}

function renderSheet(doc: Document, model: SheetModel): HTMLElement {
	if (model.rows === 0) {
		const empty = doc.createElement("p");
		empty.className = "vo-empty";
		empty.textContent = "This sheet is empty.";
		return empty;
	}
	const table = doc.createElement("table");
	table.className = "vo-grid";
	let width = GUTTER_PX;
	const group = doc.createElement("colgroup");
	const gutterColumn = doc.createElement("col");
	gutterColumn.style.width = `${GUTTER_PX}px`;
	group.append(gutterColumn);
	for (let col = 0; col < model.cols; col++) {
		const column = doc.createElement("col");
		column.style.width = `${model.columnWidths[col]}px`;
		if (model.hiddenColumns[col]) column.style.visibility = "collapse";
		else width += model.columnWidths[col];
		group.append(column);
	}
	table.style.width = `${width}px`;
	table.append(group);

	const head = doc.createElement("tr");
	head.append(doc.createElement("th"));
	for (let col = 0; col < model.cols; col++) {
		const letter = doc.createElement("th");
		letter.textContent = utils.encode_col(col);
		head.append(letter);
	}
	const thead = doc.createElement("thead");
	thead.append(head);
	table.append(thead);

	// A merged block's covered cells are not drawn; its top-left cell spans them.
	const covered = new Uint8Array(model.rows * model.cols);
	const spanAt = new Map<number, Merge>();
	for (const merge of model.merges) {
		spanAt.set(merge.row * model.cols + merge.col, merge);
		for (let row = merge.row; row < merge.row + merge.rowSpan; row++) {
			for (let col = merge.col; col < merge.col + merge.colSpan; col++) covered[row * model.cols + col] = 1;
		}
	}

	const tbody = doc.createElement("tbody");
	for (let row = 0; row < model.rows; row++) {
		const line = doc.createElement("tr");
		const height = model.rowHeights[row];
		if (height !== undefined) line.style.height = `${height}px`;
		if (model.hiddenRows[row]) line.style.visibility = "collapse";
		const number = doc.createElement("th");
		number.textContent = String(row + 1);
		line.append(number);
		for (let col = 0; col < model.cols; col++) {
			const index = row * model.cols + col;
			const merge = spanAt.get(index);
			if (covered[index] === 1 && !merge) continue;
			const td = doc.createElement("td");
			td.dataset.cell = `${utils.encode_col(col)}${row + 1}`;
			if (merge) {
				td.colSpan = merge.colSpan;
				td.rowSpan = merge.rowSpan;
			}
			const cell = model.cells[row][col];
			if (cell) {
				td.textContent = cell.text;
				if (cell.kind === "number") td.className = "vo-num";
				else if (cell.kind === "flag") td.className = "vo-flag";
				else if (cell.kind === "raw") td.className = "vo-raw";
				if (cell.formula && cell.kind !== "raw") td.title = clip(`=${cell.formula}`);
			}
			line.append(td);
		}
		tbody.append(line);
	}
	table.append(tbody);
	return table;
}

async function mountXlsx(root: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const doc = root.ownerDocument;
	const workbook = read(bytes, {
		type: "array",
		cellDates: true,
		cellStyles: true,
		sheetStubs: true,
		sheetRows: MAX_ROWS,
	});

	const visible: { readonly name: string; readonly sheet: WorkSheet }[] = [];
	workbook.SheetNames.forEach((name, index) => {
		const sheet = workbook.Sheets[name];
		if (sheet && !workbook.Workbook?.Sheets?.[index]?.Hidden) visible.push({ name, sheet });
	});
	if (visible.length === 0) {
		throw new ProblemError({ title: "This workbook has no visible sheets", detail: "Every sheet in it is hidden." });
	}
	const offered = visible.slice(0, MAX_SHEETS);

	const scroll = doc.createElement("div");
	scroll.className = "vo-scroll";
	const stage = doc.createElement("div");
	scroll.append(stage);
	const note = doc.createElement("div");
	note.className = "vo-note";
	note.setAttribute("role", "status");
	const strip = doc.createElement("div");
	strip.className = "vo-tabs";
	strip.setAttribute("role", "tablist");
	strip.setAttribute("aria-label", "Sheets");
	root.append(scroll, note, strip);

	const tabs = offered.map(({ name }, index) => {
		const tab = doc.createElement("button");
		tab.type = "button";
		tab.className = "vo-tab";
		tab.setAttribute("role", "tab");
		tab.title = name;
		tab.textContent = name;
		tab.addEventListener("click", () => select(index, true));
		return tab;
	});
	strip.append(...tabs);

	const drawn = new Map<number, { readonly grid: HTMLElement; readonly note: string }>();
	let active = -1;
	function select(index: number, byUser: boolean): void {
		if (index < 0 || index >= offered.length) return;
		let entry = drawn.get(index);
		if (!entry) {
			const model = buildSheetModel(offered[index].name, offered[index].sheet);
			entry = { grid: renderSheet(doc, model), note: truncationNote(model, offered.length, visible.length) };
			drawn.set(index, entry);
		}
		active = index;
		tabs.forEach((tab, at) => {
			tab.setAttribute("aria-selected", String(at === index));
			tab.tabIndex = at === index ? 0 : -1;
		});
		stage.replaceChildren(entry.grid);
		scroll.scrollTop = 0;
		scroll.scrollLeft = 0;
		note.textContent = entry.note;
		note.hidden = entry.note === "";
		if (byUser) ctx.onPage?.(index + 1);
	}
	const onKey = (event: KeyboardEvent): void => {
		const last = tabs.length - 1;
		let target = -1;
		switch (event.key) {
			case "ArrowRight":
				target = active + 1;
				break;
			case "ArrowLeft":
				target = active - 1;
				break;
			case "Home":
				target = 0;
				break;
			case "End":
				target = last;
				break;
		}
		if (target < 0 || target > last) return;
		event.preventDefault();
		select(target, true);
		tabs[target].focus();
	};
	strip.addEventListener("keydown", onKey);
	select(0, false);

	return {
		destroy: () => strip.removeEventListener("keydown", onKey),
		zoom: factor => {
			stage.style.zoom = String(clampZoom(factor));
		},
		pageCount: offered.length,
		goto: page => select(Math.trunc(page) - 1, false),
	};
}

const renderer: Renderer = {
	mount: (el, bytes, ctx) => mountOffice(el, bytes, ctx, EXCEL, root => mountXlsx(root, bytes, ctx)),
};

export default renderer;
