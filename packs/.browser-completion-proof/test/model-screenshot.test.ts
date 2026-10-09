/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a screenshot costs an agent as
 *  much as reading the whole page (a 1280x800 PNG is ~1.4k image tokens, a big
 *  monitor's is several times that), or comes back shrunk with no way to map a
 *  point in it back to the page (so a click lands beside its target), or it
 *  quietly fills the frames the human's annotation crops from (so the picture
 *  the person circled is evicted).
 *
 *  A model's picture is the browser's own webp, its longest edge at most 1024
 *  CSS px, for the viewport, the whole page or one element. It is never
 *  retained. Real Chrome; sizes are read out of the webp's own header.
 */
import { afterEach, expect, test } from "bun:test";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, failureCode, startFixture, teardown } from "./fixture";

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

/** Width and height in pixels, from the header of a lossy, lossless or extended webp. */
function webpSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") throw new Error("not a webp");
	const chunk = bytes.toString("latin1", 12, 16);
	if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
	if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
	if (chunk === "VP8L") {
		const bits = bytes.readUInt32LE(21);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
	}
	throw new Error(`unknown webp chunk ${chunk}`);
}

const BIG = { width: 1600, height: 1000 };

describeWithChrome("a model's screenshot", () => {
	test(
		"is a webp whose longest edge is at most 1024 px, and says how far it was shrunk",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: BIG });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/tall") });

			const shot = await runtime.shot(browserId);

			expect(shot.mimeType).toBe("image/webp");
			expect(shot.url).toBe(fixture.url("/tall"));
			expect({ width: shot.width, height: shot.height }).toEqual(BIG);
			expect(shot.scale).toBeCloseTo(1024 / 1600, 2);
			const size = webpSize(Buffer.from(shot.data, "base64"));
			expect(Math.max(size.width, size.height)).toBe(1024);
			// What the text promises is what the image is: the CSS size times the scale.
			expect(size).toEqual({ width: Math.round(BIG.width * shot.scale), height: Math.round(BIG.height * shot.scale) });

			// A page that already fits is not shrunk.
			await runtime.act(browserId, { kind: "resize", width: 800, height: 600 });
			const small = await runtime.shot(browserId);
			expect(small.scale).toBe(1);
			expect(webpSize(Buffer.from(small.data, "base64"))).toEqual({ width: 800, height: 600 });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"fullPage covers the whole document and selector one element, wherever they are scrolled; scale shrinks further",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: BIG });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/tall") });
			// Scrolled by script, so the position is settled before the picture is taken.
			await runtime.actMany(browserId, [{ kind: "eval", expression: "window.scrollTo(0, 1000)" }]);

			const whole = await runtime.shot(browserId, { fullPage: true });
			expect({ width: whole.width, height: whole.height }).toEqual({ width: 1600, height: 3000 });
			const wholeSize = webpSize(Buffer.from(whole.data, "base64"));
			expect(wholeSize.height).toBe(1024);
			expect(Math.abs(wholeSize.width - 1600 * whole.scale)).toBeLessThan(1);

			// The 21st block: 2000 CSS px down and 100 tall, below the viewport that was scrolled to.
			const element = await runtime.shot(browserId, { selector: "body > div:nth-child(21)" });
			expect(element).toMatchObject({ width: 1600, height: 100 });
			expect(webpSize(Buffer.from(element.data, "base64"))).toEqual({ width: 1024, height: 64 });

			const halved = await runtime.shot(browserId, { selector: "body > div:nth-child(1)", scale: 0.5 });
			expect(halved.scale).toBeCloseTo(0.32, 2);
			expect(webpSize(Buffer.from(halved.data, "base64")).width).toBe(512);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"asks for nothing it cannot give: both fullPage and selector, a bad scale, a selector that matches nothing or is not plain CSS",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: BIG });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/tall") });

			expect(await failureCode(() => runtime.shot(browserId, { fullPage: true, selector: "body" }))).toBe("bad_shot");
			expect(await failureCode(() => runtime.shot(browserId, { scale: 0 }))).toBe("bad_shot");
			expect(await failureCode(() => runtime.shot(browserId, { scale: 1.5 }))).toBe("bad_shot");
			expect(await failureCode(() => runtime.shot(browserId, { selector: "#nothing-here" }))).toBe("no_element");
			expect(await failureCode(() => runtime.shot(browserId, { selector: "text/block 3" }))).toBe("bad_action");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is never retained: the frame a person is about to annotate survives any number of them",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: { width: 800, height: 600 } });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/tall") });
			const frame = await runtime.frame(browserId);

			// The runtime keeps 8 frames; a shot filed among them would push this one out.
			for (let i = 0; i < 9; i += 1) await runtime.shot(browserId);

			const annotated = await runtime.annotate(browserId, frame.frameId, [{ x: 0, y: 0, width: 100, height: 100 }]);
			expect(annotated.regions).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
