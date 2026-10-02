// Decoder for the baked head asset (assets/head-<id>.bin, written by the authoring-time bake).
//   "DFH2" | u32 headerLen | header JSON (padded to 4) | deflate-raw payload:
//   pos Int16[n*3] | normal+fade Int8[n*4] | colour+kind Uint8[n*4] | per shape: Int8[n*3] running-difference deltas
// A shape is one Rocketbox `AK_xx` morph, stored under its ARKit name; the header lists only the ones that move
// visible dots (the bake drops the rest), so the renderer maps baked slots to the 52-float pose by name.
import { arkitIndexOf } from "./shapes";

export interface HeadHeader {
	v: 2;
	id: string;
	n: number;
	/** ARKit names of the baked morphs, in payload order. */
	shapes: string[];
	/** Max |delta| in metres per shape; a stored int8 of 127 equals this. */
	scales: number[];
	center: [number, number, number];
	half: [number, number, number];
	landmarks: {
		eyeY: number;
		mouthY: number;
		chinY: number;
		crownY: number;
		noseZ: number;
		neckBottom: number;
		pivot: [number, number, number];
	};
	rowSpacing: number;
	/** Distance between neighbouring dots along a row, metres: the grid cell width the renderer sizes dots against. */
	colSpacing: number;
	source: { project: string; repo: string; commit: string; fbx: string; albedo: string };
}

export interface HeadAsset {
	header: HeadHeader;
	/** GPU-ready per-dot vertex data, 16-byte stride: int16 xyz+pad, int8 nx ny nz fade, uint8 r g b kind. */
	instances: ArrayBuffer;
	/** Per-shape per-dot deltas as int8 xyz, index = (slot * n + dot) * 4, w unused. */
	deltas: Int8Array;
	/** Baked slot -> index into the 52-float ARKit pose vector. */
	pose: Uint8Array;
}

const MAGIC = "DFH2";

export async function decodeHead(bytes: ArrayBuffer | Uint8Array): Promise<HeadAsset> {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== MAGIC) throw new Error("not a face head asset");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const hl = dv.getUint32(4, true);
	const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl))) as HeadHeader;
	if (header.v !== 2) throw new Error(`unsupported head asset v${header.v}`);
	const pose = Uint8Array.from(header.shapes, (name) => {
		const i = arkitIndexOf(name);
		if (i === undefined) throw new Error(`head asset carries unknown shape ${name}`);
		return i;
	});

	const inflated = await new Response(
		new Blob([u8.slice(8 + hl)]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
	).arrayBuffer();
	const { n } = header;
	const shapeCount = header.shapes.length;
	const posQ = new Int16Array(inflated, 0, n * 3);
	const nrm = new Int8Array(inflated, n * 6, n * 4);
	const col = new Uint8Array(inflated, n * 10, n * 4);
	const raw = new Int8Array(inflated, n * 14);

	const instances = new ArrayBuffer(n * 16);
	const i16 = new Int16Array(instances);
	const i8 = new Int8Array(instances);
	for (let i = 0; i < n; i++) {
		i16[i * 8] = posQ[i * 3];
		i16[i * 8 + 1] = posQ[i * 3 + 1];
		i16[i * 8 + 2] = posQ[i * 3 + 2];
		for (let c = 0; c < 4; c++) {
			i8[i * 16 + 8 + c] = nrm[i * 4 + c];
			i8[i * 16 + 12 + c] = col[i * 4 + c];
		}
	}

	const deltas = new Int8Array(shapeCount * n * 4);
	for (let s = 0; s < shapeCount; s++) {
		const base = s * n * 3;
		for (let c = 0; c < 3; c++) {
			let acc = 0;
			for (let i = 0; i < n; i++) {
				acc = (acc + raw[base + i * 3 + c]) << 24 >> 24;
				deltas[(s * n + i) * 4 + c] = acc;
			}
		}
	}
	return { header, instances, deltas, pose };
}
