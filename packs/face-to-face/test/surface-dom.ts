// A linkedom page for mounting the surface and the door with react-dom, and the few browser APIs they read
// stubbed to "nothing to observe". Globals are installed as own properties and their original descriptors put
// back by `unmountAll`, so no sibling suite inherits this DOM. Not a test file: bun only runs *.test.*.
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const GLOBALS = [
	"window",
	"document",
	"Element",
	"HTMLElement",
	"Event",
	"MutationObserver",
	"IntersectionObserver",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

const prior = new Map<string, PropertyDescriptor | undefined>();
const roots: Root[] = [];

class Watcher {
	observe() {}
	disconnect() {}
}

let restoreFocus: (() => void) | undefined;

// linkedom's focus() only fires a "focus" event: it never moves `document.activeElement`, which is what a menu's
// arrow keys read. Record the focused element the way a browser does; `unmountAll` puts the real focus() back.
function trackFocus(window: Window & typeof globalThis): void {
	if (restoreFocus) return;
	const proto = window.HTMLElement.prototype;
	const focus = proto.focus;
	Object.defineProperty(proto, "focus", {
		configurable: true,
		writable: true,
		value(this: HTMLElement) {
			// linkedom's Document takes a plain assignment to `activeElement`; lib.dom types it read-only
			const page: { activeElement: Element | null } = this.ownerDocument;
			page.activeElement = this;
			focus.call(this);
		},
	});
	restoreFocus = () => {
		Reflect.deleteProperty(proto, "focus");
	};
}

function installDom(): HTMLElement {
	const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
	const raf = () => 0;
	Object.assign(window, {
		requestAnimationFrame: raf,
		cancelAnimationFrame: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	});
	const values: Record<(typeof GLOBALS)[number], unknown> = {
		window,
		document: window.document,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
		MutationObserver: Watcher,
		IntersectionObserver: Watcher,
		getComputedStyle: () => ({ backgroundColor: "" }),
		requestAnimationFrame: raf,
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	trackFocus(window);
	for (const key of GLOBALS) {
		// the FIRST install's originals are the ones to restore, not a previous mount's stubs
		if (!prior.has(key)) prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
	}
	return window.document.getElementById("root") as HTMLElement;
}

/** Unmount every mounted root (running effect cleanups) and restore the real globals. */
export async function unmountAll(): Promise<void> {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	for (const [key, descriptor] of prior) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	prior.clear();
	restoreFocus?.();
	restoreFocus = undefined;
}

/** Unmount the mounted roots but keep the page, for "what happens after it is gone". */
export async function unmountRoots(): Promise<void> {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
}

export async function mountPage(element: ReactElement) {
	const container = installDom();
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(element);
	});
	return {
		container,
		find: (selector: string) => container.querySelector(selector),
		buttonByText: (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text),
		async press(el: Element | null | undefined) {
			if (!el) throw new Error("nothing to press");
			await act(async () => {
				el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
			});
		},
		async key(key: string) {
			await act(async () => {
				const ev = new window.Event("keydown", { cancelable: true });
				Object.assign(ev, { key });
				window.dispatchEvent(ev);
			});
		},
		async keyOn(el: Element | null | undefined, key: string) {
			if (!el) throw new Error("nothing to press a key on");
			// A keydown that bubbles from `el`, through the tree to the window: what a focused element receives.
			const ev = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(ev, { key });
			await act(async () => {
				el.dispatchEvent(ev);
			});
			return ev;
		},
		async pointerDown(el: Element | null | undefined) {
			if (!el) throw new Error("nothing to press");
			await act(async () => {
				el.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
			});
		},
		focused: () => window.document.activeElement as HTMLElement | null,
	};
}
