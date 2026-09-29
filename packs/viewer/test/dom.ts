// A DOM for the Office renderer tests, on linkedom (the workspace's DOM for
// headless tests; the browser pack and the kit use it too). Rendering fidelity is
// judged in a real browser; what these tests need from a DOM is structure: which
// text, which elements, which attributes, and that nothing throws.
//
// Two facts about linkedom the renderers' libraries trip over, patched here and
// nowhere else:
//   - its XML parser keeps the qualified name in `localName` (`w:body`), where the
//     standard says `body`, and docx-preview looks parts up by local name;
//   - it has no ResizeObserver/IntersectionObserver, which the pptx renderer reads
//     when it lays a slide out.
// `Event`, `CustomEvent` and `EventTarget` stay Bun's own: the pptx viewer extends
// EventTarget and dispatches CustomEvents on itself, and a linkedom `Event` is not one
// Bun's dispatcher accepts. A test that fires an event at an element uses `window.Event`.
import { DOMParser as LinkedomParser, parseHTML } from "linkedom";

const GLOBALS = [
	"window",
	"document",
	"Node",
	"Element",
	"HTMLElement",
	"SVGElement",
	"MutationObserver",
	"getComputedStyle",
	"XMLSerializer",
] as const;

/** Give every namespaced XML element and attribute the unqualified `localName` the DOM standard defines. */
function unqualify(node: Node): void {
	if (node.nodeType === 1) {
		const element = node as Element;
		const colon = element.localName.indexOf(":");
		if (colon >= 0) Object.defineProperty(element, "localName", { value: element.localName.slice(colon + 1), configurable: true });
		for (const attribute of Array.from(element.attributes)) {
			const at = attribute.localName.indexOf(":");
			if (at >= 0) Object.defineProperty(attribute, "localName", { value: attribute.localName.slice(at + 1), configurable: true });
		}
	}
	for (const child of Array.from(node.childNodes)) unqualify(child);
}

class XmlSafeDomParser {
	parseFromString(text: string, type: DOMParserSupportedType): Document {
		const parsed = new LinkedomParser().parseFromString(text, type as "text/xml") as unknown as Document;
		unqualify(parsed);
		return parsed;
	}
}

class Observer {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): [] {
		return [];
	}
}

export interface TestDom {
	readonly document: Document;
	/** Put the globals back the way they were. Call from `afterAll`. */
	restore(): void;
}

export function installDom(): TestDom {
	const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const target = globalThis as unknown as Record<string, unknown>;
	const source = window as unknown as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const set = (name: string, value: unknown): void => {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	};
	for (const name of GLOBALS) if (source[name] !== undefined) set(name, source[name]);
	set("document", document);
	set("window", window);
	set("DOMParser", XmlSafeDomParser);
	set("ResizeObserver", Observer);
	set("IntersectionObserver", Observer);
	// Left installed for the rest of the process on purpose: the pptx viewer queues
	// layout on animation frames that can fire after the test that started it ended.
	target.requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);
	return {
		document: document as unknown as Document,
		restore: () => {
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete target[name];
			}
		},
	};
}

/** A fresh empty stage, the way the viewer hands one to a renderer. */
export function stage(document: Document): HTMLElement {
	const el = document.createElement("div");
	document.body.append(el);
	return el;
}
