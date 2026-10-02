// The page's utilities must never reach a host element. They are injected into
// the host's document, in the host's own `utilities` layer, after the host's
// rules: an unscoped `.hidden` or `.grid-cols-2` there beats the host's
// `sm:block` / `md:grid-cols-4` (equal specificity, later wins) and breaks
// host layouts for the rest of the session. So every rule is read off the BUILT
// sheet and must sit under the page root's `data-slot`; and the sheet is held
// while a page is mounted and released with the last one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { holdSheet } from "../page/sheet";
import { PAGE_SLOT } from "../page/types";

const BUNDLE = resolve(import.meta.dir, "../dist/index.mjs");
const SCOPE = `:where([data-slot="${PAGE_SLOT}"])`;

/** The stylesheet the bundle injects: the one string literal that opens with Tailwind's banner. */
function embeddedSheet(): string {
	const source = readFileSync(BUNDLE, "utf8");
	const literal = source.match(/"\/\*! tailwindcss(?:[^"\\\n]|\\.)*"/);
	if (literal === null) throw new Error("no Tailwind sheet in dist/index.mjs — rebuild the pack (bun run build)");
	return JSON.parse(literal[0]) as string;
}

/** The top-level rules of a stylesheet, each as its text (nested braces kept inside). */
function rulesOf(css: string): string[] {
	const rules: string[] = [];
	let depth = 0;
	let start = 0;
	for (let at = 0; at < css.length; at++) {
		const char = css[at];
		if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			rules.push(css.slice(start, at + 1).trim());
			start = at + 1;
		} else if (char === ";" && depth === 0) {
			rules.push(css.slice(start, at + 1).trim());
			start = at + 1;
		}
	}
	return rules;
}

const head = (rule: string): string => rule.slice(0, rule.indexOf("{")).trim();
const body = (rule: string): string => rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));

/** Every style rule's selector under `rule`, through @media / @supports / @container wrappers. */
function selectorsIn(rule: string): string[] {
	return rulesOf(body(rule)).flatMap(inner => (head(inner).startsWith("@") ? selectorsIn(inner) : [head(inner)]));
}

describe("the page's sheet is scoped to the page root", () => {
	const css = embeddedSheet().replace(/\/\*[\s\S]*?\*\//g, "");
	const top = rulesOf(css);
	const utilities = top.find(rule => head(rule) === "@layer utilities");

	test("every selector in the utilities layer starts at the page root, so no host element can match one", () => {
		expect(utilities).toBeDefined();
		const selectors = selectorsIn(utilities as string);
		// Not vacuous: the page really does ship a few hundred utilities.
		expect(selectors.length).toBeGreaterThan(200);
		const loose = selectors.filter(selector => !selector.startsWith(SCOPE) && !selector.startsWith(`:where(${SCOPE}`));
		expect(loose).toEqual([]);
	});

	test("the classes that collide with the host's responsive variants exist only as scoped rules", () => {
		const selectors = selectorsIn(utilities as string);
		for (const name of ["hidden", "block", "flex", "grid-cols-2"]) {
			expect(selectors).toContain(`${SCOPE} .${name}`);
			// The bare `.hidden` — a rule any host element could match — is nowhere in the sheet.
			expect(selectors).not.toContain(`.${name}`);
		}
	});

	test("outside the utilities layer the sheet holds no class rule: only @layer headers, @property and @keyframes", () => {
		const stray = top.filter(rule => rule !== utilities && !head(rule).startsWith("@"));
		expect(stray).toEqual([]);
	});
});

// A document with only what `holdSheet` uses.
class FakeElement {
	id = "";
	textContent = "";
	dataset: Record<string, string | undefined> = {};
	constructor(private readonly owner: FakeDocument) {}
	remove(): void {
		this.owner.attached = this.owner.attached.filter(element => element !== this);
	}
}
class FakeDocument {
	attached: FakeElement[] = [];
	head = { append: (element: FakeElement): void => void this.attached.push(element) };
	getElementById(id: string): FakeElement | null {
		return this.attached.find(element => element.id === id) ?? null;
	}
	createElement(): FakeElement {
		return new FakeElement(this);
	}
}
const asDocument = (fake: FakeDocument): Document => fake as unknown as Document;

describe("holding the page's sheet", () => {
	test("the first page adds it once, the next share it, and it goes with the LAST one, not before", () => {
		const doc = new FakeDocument();
		const releaseA = holdSheet(asDocument(doc), "sheet", "css-a");
		const releaseB = holdSheet(asDocument(doc), "sheet", "css-a");
		expect(doc.attached).toHaveLength(1);
		expect(doc.attached[0]?.textContent).toBe("css-a");

		releaseA();
		expect(doc.attached).toHaveLength(1);
		releaseB();
		expect(doc.attached).toHaveLength(0);
	});

	test("releasing twice releases once: it cannot take another page's sheet with it", () => {
		const doc = new FakeDocument();
		const releaseA = holdSheet(asDocument(doc), "sheet", "css");
		holdSheet(asDocument(doc), "sheet", "css");
		releaseA();
		releaseA();
		expect(doc.attached).toHaveLength(1);
	});

	test("a page mounted after the last one left gets the sheet afresh", () => {
		const doc = new FakeDocument();
		holdSheet(asDocument(doc), "sheet", "css")();
		expect(doc.attached).toHaveLength(0);
		holdSheet(asDocument(doc), "sheet", "css");
		expect(doc.attached).toHaveLength(1);
	});

	test("a sheet already in the document (another copy of the bundle holds it) is joined, not duplicated", () => {
		const doc = new FakeDocument();
		const other = holdSheet(asDocument(doc), "sheet", "css");
		const mine = holdSheet(asDocument(doc), "sheet", "css");
		other();
		expect(doc.attached).toHaveLength(1);
		mine();
		expect(doc.attached).toHaveLength(0);
	});

	test("with no document (rendered on a server) there is nothing to hold", () => {
		expect(() => holdSheet(undefined, "sheet", "css")()).not.toThrow();
	});
});
