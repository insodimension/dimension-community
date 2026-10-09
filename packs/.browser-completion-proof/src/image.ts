/**
 * What annotation shares about a captured frame: the byte ceiling a capture may
 * have, and the arithmetic that turns a region the human marked into one the
 * page can be read under. The picture itself is never cut here: the View hands
 * the whole frame to the shared annotation kit, which paints the marks and
 * crops the details.
 */
import type { BrowserRegion, Viewport } from "./contracts";
import { fail } from "./store";

/** Upper bound on encoded PNG bytes we will hold or hand back. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Validate `requested` and clamp it to `frame`.
 *
 * Non-finite, negative, or zero-sized regions are REFUSED (not silently
 * repaired). A region that starts inside the frame but runs off its edge is
 * clamped to the frame; one that starts entirely outside is refused. A frame is
 * captured at one device pixel per CSS pixel, so `frame` is the viewport the
 * capture was taken at.
 */
export function clampRegion(requested: BrowserRegion, frame: Viewport): BrowserRegion {
	for (const [name, value] of Object.entries(requested)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			fail("bad_region", `region.${name} must be a finite number`);
		}
	}
	const x = Math.floor(requested.x);
	const y = Math.floor(requested.y);
	const w = Math.floor(requested.width);
	const h = Math.floor(requested.height);
	if (w <= 0 || h <= 0) fail("bad_region", "region width and height must be > 0");
	if (x < 0 || y < 0) fail("bad_region", "region origin must be >= 0");
	if (x >= frame.width || y >= frame.height) {
		fail("bad_region", `region origin (${x},${y}) is outside the ${frame.width}x${frame.height} frame`);
	}
	return { x, y, width: Math.min(w, frame.width - x), height: Math.min(h, frame.height - y) };
}
