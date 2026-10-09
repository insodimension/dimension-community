/** A live React tree on a linkedom document — the marketplace's pack convention
 *  (`react`, `react-dom` and `linkedom` come from the Dimension monorepo the pack
 *  is mounted into). Shared by the dock panel's tests and the View's, so the
 *  typing and clicking tricks below live once.
 *
 *  A test file calls `afterEach(unmountAll)`: it unmounts every tree and puts the
 *  process's DOM globals back, so a later file never sees this document. */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];
let priorDomGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
const roots: Root[] = [];

export async function unmountAll(): Promise<void> {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	if (priorDomGlobals) {
		for (const key of DOM_GLOBALS) {
			const descriptor = priorDomGlobals[key];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		priorDomGlobals = undefined;
	}
}

export interface Dom {
	readonly find: (selector: string) => Element[];
	readonly text: () => string;
	readonly click: (element: Element) => Promise<void>;
	/** Type `value` into a text input, as a person would (replacing what is there). */
	readonly type: (input: Element, value: string) => Promise<void>;
	readonly submit: (form: Element) => Promise<void>;
	/** Tick or untick a checkbox, as a click does. */
	readonly check: (input: Element, checked: boolean) => Promise<void>;
	/** Press `key` with `target` focused, as a keyboard does: the event bubbles from it. */
	readonly key: (target: Element, key: string) => Promise<void>;
	/** Let pending promises and effects settle (a stream message arriving, a tool call returning). */
	readonly settle: () => Promise<void>;
}

/** Things the View reaches for that linkedom does not have. */
class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

export async function mount(element: ReactElement): Promise<Dom> {
	const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	// An address bar selects its text on focus.
	Object.assign(window.HTMLInputElement.prototype, { select() {} });
	// No layout in linkedom: every box is 800×600 at the origin, which is all a drawing surface needs to place a mark.
	Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
	});
	// A selected tab scrolls itself into view, and the page schedules its mouse moves per display frame; linkedom has neither.
	Object.assign(window.HTMLElement.prototype, { scrollIntoView() {} });
	Object.assign(window, { requestAnimationFrame: (callback: (at: number) => void) => setTimeout(() => callback(performance.now()), 16), cancelAnimationFrame: (handle: number) => clearTimeout(handle) });
	// A type-less <input> is a text input. linkedom says `null`, and React removes a type
	// attribute it was not given on every re-render, so an input that re-renders on focus
	// (an address bar) would stop being a text input to React's change detection.
	Object.defineProperty(window.HTMLInputElement.prototype, "type", {
		configurable: true,
		get(this: Element) {
			return this.getAttribute("type") ?? "text";
		},
		set(this: Element, value: string) {
			this.setAttribute("type", value);
		},
	});
	priorDomGlobals ??= Object.fromEntries(DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<
		DomGlobal,
		PropertyDescriptor | undefined
	>;
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Event: window.Event,
		ResizeObserver: StubResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const container = window.document.getElementById("root") as unknown as HTMLElement;
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	return {
		find: selector => [...container.querySelectorAll(selector)],
		text: () => container.textContent ?? "",
		// React 19 delegates events at the root container, so a bubbling native event reaches the handler.
		click: async target => {
			await act(async () => {
				target.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		},
		// The kit's own typing path (fraym/packages/ui/test/plugins-page.create.test.tsx): react-dom
		// loaded without a DOM, so it picked its IE-era value-change polyfill, which arms on
		// `focusin` through `attachEvent` (no-ops here: linkedom has none) and notices a new value on
		// `keyup`. The value goes through the PROTOTYPE setter so React's node-level tracker is left
		// stale and reads it as changed.
		type: async (input, value) => {
			Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
			if (!setter) throw new Error("input prototype exposes no value setter");
			await act(async () => {
				input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
			});
			setter.call(input, value);
			await act(async () => {
				input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
			});
			// Leaving the field armed hands a later test a dangling node in react-dom's module state.
			await act(async () => {
				input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
			});
		},
		submit: async form => {
			await act(async () => {
				form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
			});
		},
		// linkedom has no activation behaviour and no `checked` property: a click alone changes
		// nothing and React would read `undefined`. Setting the property first is what a browser's
		// click does before it dispatches.
		check: async (input, checked) => {
			Object.assign(input, { checked });
			await act(async () => {
				input.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		},
		key: async (target, key) => {
			await act(async () => {
				target.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key }));
			});
		},
		settle: () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 20))),
	};
}
