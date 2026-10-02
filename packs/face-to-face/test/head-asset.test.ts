import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeHead } from "../src/face/head-asset";
import { ARKIT_52 } from "../src/face/shapes";

describe.each(["f01", "m01"])("baked head %s", (id) => {
	const bytes = readFileSync(new URL(`../assets/head-${id}.bin`, import.meta.url));

	test("decodes to n dots carrying all 52 ARKit morphs, slot i = pose index i", async () => {
		const head = await decodeHead(new Uint8Array(bytes));
		const { n, shapes, scales } = head.header;
		expect(n).toBeGreaterThan(8000);
		expect(n).toBeLessThan(16000);
		expect(shapes).toEqual([...ARKIT_52]);
		expect(Array.from(head.pose)).toEqual(ARKIT_52.map((_, i) => i));
		expect(scales.every((s) => s > 0)).toBe(true);
		expect(head.instances.byteLength).toBe(n * 16);
		expect(head.deltas.length).toBe(ARKIT_52.length * n * 4);
	});

	test("jaw deltas move the lower face down and leave the forehead alone (running-difference decode is right)", async () => {
		const head = await decodeHead(new Uint8Array(bytes));
		const { n, center, half, landmarks, scales } = head.header;
		const i16 = new Int16Array(head.instances);
		const jaw = ARKIT_52.indexOf("jawOpen");
		let chin = 0;
		let chinN = 0;
		let brow = 0;
		let browN = 0;
		for (let i = 0; i < n; i++) {
			const y = center[1] + (i16[i * 8 + 1] / 32767) * half[1];
			const dy = (head.deltas[(jaw * n + i) * 4 + 1] / 127) * scales[jaw];
			if (y < landmarks.mouthY - 0.01 && y > landmarks.chinY) {
				chin += dy;
				chinN++;
			} else if (y > landmarks.eyeY + 0.03) {
				brow += dy;
				browN++;
			}
		}
		expect(chin / chinN).toBeLessThan(-0.0015); // the lower face drops by millimetres
		expect(Math.abs(brow / browN)).toBeLessThan(0.0005);
	});

	test("every dot sits inside the quantisation box and the colour/normal bytes are populated", async () => {
		const head = await decodeHead(new Uint8Array(bytes));
		const { n } = head.header;
		const i8 = new Int8Array(head.instances);
		const u8 = new Uint8Array(head.instances);
		let unit = 0;
		let lit = 0;
		for (let i = 0; i < n; i++) {
			const nx = i8[i * 16 + 8] / 127, ny = i8[i * 16 + 9] / 127, nz = i8[i * 16 + 10] / 127;
			if (Math.abs(Math.hypot(nx, ny, nz) - 1) < 0.05) unit++;
			if (u8[i * 16 + 12] + u8[i * 16 + 13] + u8[i * 16 + 14] > 60) lit++;
		}
		expect(unit / n).toBeGreaterThan(0.98);
		expect(lit / n).toBeGreaterThan(0.98);
	});
});
