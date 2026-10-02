// The head reaches the component as a base64 data URL inside the bundle (a pack has no asset base): this is
// the chain from the bytes vite inlines back to a decoded asset, run on the real baked file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataUrlBytes, loadHead } from "../src/surface/head";

const HEAD = readFileSync(resolve(import.meta.dir, "../assets/head-f01.bin"));
// what vite's `?inline` emits for a .bin
const asDataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const dataUrl = asDataUrl(HEAD);

describe("inlined head asset", () => {
	test("the data URL decodes back to the exact file bytes", () => {
		expect(Buffer.from(dataUrlBytes(dataUrl)).equals(HEAD)).toBe(true);
	});

	test("anything that is not a base64 data URL is refused, not decoded into garbage", () => {
		expect(() => dataUrlBytes("https://engine.test/plugin-assets/x/head.bin")).toThrow("base64 data URL");
		expect(() => dataUrlBytes("data:text/plain,hello")).toThrow("base64 data URL");
	});

	test("a corrupt asset rejects with a readable reason and does not poison the good one", async () => {
		await expect(loadHead(asDataUrl(Buffer.from("NOPE, not a head asset")))).rejects.toThrow("not a face head asset");
		const head = await loadHead(dataUrl);
		expect(head.header.n).toBeGreaterThan(0);
	});

	test("the real asset decodes to GPU-ready dots and one delta block per declared shape", async () => {
		const head = await loadHead(dataUrl);
		expect(head.header.n).toBeGreaterThan(5000);
		expect(head.instances.byteLength).toBe(head.header.n * 16);
		expect(head.deltas.length).toBe(head.header.shapes.length * head.header.n * 4);
		expect(head.pose.length).toBe(head.header.shapes.length);
	});
});
