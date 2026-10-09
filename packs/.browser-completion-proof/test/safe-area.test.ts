/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the host's assistant orb sits on top of
 *  "Request edits" in the annotation panel. The kit's footer pads itself with the host's
 *  safe-area numbers, but only if the View puts them on its document; this View has its
 *  own root, so it must do it itself, at connect and whenever the host moves the orb.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { followSafeArea, type SafeAreaHost } from "../app/view/safe-area";

type Listener = (context: unknown) => void;

/** A connected App's host context and its change notifications, and the document the numbers must land on. */
function host(initial: unknown) {
	const listeners = new Set<Listener>();
	const app = {
		getHostContext: () => initial,
		addEventListener: (_event: string, listener: Listener) => void listeners.add(listener),
		removeEventListener: (_event: string, listener: Listener) => void listeners.delete(listener),
	} as unknown as SafeAreaHost;
	const doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document;
	const inset = (edge: string) => doc.documentElement.style.getPropertyValue(`--fr-safe-area-inset-${edge}`);
	const announce = (context: unknown) => {
		for (const listener of [...listeners]) listener(context);
	};
	return { app, doc, inset, announce, listening: () => listeners.size };
}

describe("the host's safe area", () => {
	test("is on the document as soon as the View is connected, and follows the orb when the host moves it", () => {
		const { app, doc, inset, announce } = host({ safeAreaInsets: { top: 0, right: 72, bottom: 0, left: 0 } });

		followSafeArea(app, doc);
		expect(inset("right")).toBe("72px");
		expect(inset("left")).toBe("");

		announce({ safeAreaInsets: { top: 0, right: 0, bottom: 56, left: 0 } });
		expect(inset("right")).toBe("");
		expect(inset("bottom")).toBe("56px");

		// A change that says nothing about the safe area (a new theme) leaves what is applied alone.
		announce({ theme: "light" });
		expect(inset("bottom")).toBe("56px");

		// The host takes the orb away.
		announce({ safeAreaInsets: null });
		expect(inset("bottom")).toBe("");
	});

	test("stops following when the View goes away", () => {
		const { app, doc, inset, announce, listening } = host({});

		const stop = followSafeArea(app, doc);
		expect(listening()).toBe(1);
		stop();
		announce({ safeAreaInsets: { top: 0, right: 90, bottom: 0, left: 0 } });

		expect(listening()).toBe(0);
		expect(inset("right")).toBe("");
	});
});
