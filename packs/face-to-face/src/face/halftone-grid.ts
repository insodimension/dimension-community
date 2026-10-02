// Layout of the screen-space halftone: one dot per cell of a square grid locked to the head anchor, and the
// G-buffer the head is rasterised into, which maps exactly the grid's rectangle. Pure maths, shared by the
// renderer and its tests; recomputed on resize and quality changes only.

/** Grid rows across the crown-to-chin span (the reference reads ~72 rows chin to crown). */
export const CELLS_PER_HEAD = 72;
/** A cell never shrinks below this many CSS pixels, however small the head is drawn. */
export const MIN_CELL_CSS = 4;
/** 'low' spends fewer, larger dots. */
export const LOW_CELL_SCALE = 1.35;
/** G-buffer texels per cell pitch: enough for the bilinear tone to stay smooth between neighbouring dots. */
export const TEXELS_PER_CELL = { high: 3, low: 1.8 } as const;

export interface GridInput {
	/** Canvas size, device pixels. */
	width: number;
	height: number;
	/** Device pixels per CSS pixel. */
	ratio: number;
	/** Crown-to-chin height, device pixels. */
	headPx: number;
	/** Head anchor, device pixels (y down). */
	origin: readonly [number, number];
	/** Half size of everything that may draw around the anchor (head, rim scatter, the forming orb), device pixels. */
	halfExtent: readonly [number, number];
	low: boolean;
}

export interface HalftoneGrid {
	/** Cell pitch, device pixels. */
	cell: number;
	cols: number;
	rows: number;
	/** Top-left corner of the grid rectangle, device pixels (y down); cell (i, j) is centred at x0 + (i + 0.5) * cell. */
	x0: number;
	y0: number;
	/** G-buffer size in texels; it covers exactly cols * cell by rows * cell. */
	gw: number;
	gh: number;
}

/** Cells whose centre lies within `half` of the anchor and inside the canvas, along one axis. */
function span(origin: number, half: number, size: number, cell: number): [first: number, count: number] {
	const reach = Math.ceil(half / cell);
	const first = Math.max(-reach, -Math.floor(origin / cell));
	const last = Math.min(reach, Math.floor((size - origin) / cell));
	return [first, Math.max(0, last - first + 1)];
}

export function halftoneGrid(i: GridInput): HalftoneGrid {
	const cell = Math.max(MIN_CELL_CSS * i.ratio, i.headPx / CELLS_PER_HEAD) * (i.low ? LOW_CELL_SCALE : 1);
	const [c0, cols] = span(i.origin[0], i.halfExtent[0], i.width, cell);
	const [r0, rows] = span(i.origin[1], i.halfExtent[1], i.height, cell);
	const texels = (i.low ? TEXELS_PER_CELL.low : TEXELS_PER_CELL.high) / cell;
	const scale = Math.min(1, texels);
	return {
		cell,
		cols,
		rows,
		x0: i.origin[0] + (c0 - 0.5) * cell,
		y0: i.origin[1] + (r0 - 0.5) * cell,
		gw: Math.max(1, Math.ceil(cols * cell * scale)),
		gh: Math.max(1, Math.ceil(rows * cell * scale)),
	};
}
