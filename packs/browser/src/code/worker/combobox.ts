import type { ElementHandle, JSHandle, Page } from "puppeteer-core";
import { ToolError } from "../errors";
import { sleep, untilAborted } from "./abortable";

export type SelectTarget = "native" | "combobox" | "other";

const LIST_POLL_MS = 50;
const LIST_WAIT_MS = 3_000;
const VERIFY_MS = 1_500;
const MAX_OFFERED_NAMES = 30;

export const SELECT_TARGET_SCRIPT = (el: Element): SelectTarget => {
	if (el.localName === "select") return "native";
	const role = el.getAttribute("role");
	const popup = el.getAttribute("aria-haspopup");
	return role === "combobox" || popup === "listbox" ? "combobox" : "other";
};

interface OptionSearch {
	state: "waiting" | "missing" | "found";
	expanded: boolean;
	offered: string[];
	label: string;
	disabled: boolean;
	option: Element | null;
}

type SearchSummary = Omit<OptionSearch, "option">;

const FIND_OPTION_SCRIPT = (combobox: Element, wanted: string, maxOffered: number): OptionSearch => {
	const doc = combobox.ownerDocument;
	const owners = [combobox, ...combobox.querySelectorAll('[role="combobox"]')];
	const expanded = owners.some((owner) => owner.getAttribute("aria-expanded") === "true");
	const shown = (node: Element): boolean => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
	const named: Element[] = [];
	for (const owner of owners) {
		for (const attribute of ["aria-controls", "aria-owns"]) {
			for (const id of (owner.getAttribute(attribute) ?? "").split(/\s+/)) {
				const list = id === "" ? null : doc.getElementById(id);
				if (list !== null && shown(list)) named.push(list);
			}
		}
	}
	const lists = named.length > 0 ? named : [...doc.querySelectorAll('[role="listbox"]')].filter(shown);
	const options = lists.flatMap((list) => (list.getAttribute("role") === "option" ? [list] : [...list.querySelectorAll('[role="option"]')])).filter(shown);
	if (options.length === 0) return { state: "waiting", expanded, offered: [], label: "", disabled: false, option: null };
	// The name assistive tech reads: aria-labelledby, then aria-label, then the visible text with every aria-hidden or undisplayed
	// subtree left out (an icon-font glyph is text, but not part of the name) and a space at each non-inline element's edges.
	const textOf = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
		if (!(node instanceof Element) || node.getAttribute("aria-hidden") === "true") return "";
		const style = getComputedStyle(node);
		if (style.display === "none" || style.visibility === "hidden") return "";
		const inner = [...node.childNodes].map(textOf).join("");
		return style.display.startsWith("inline") ? inner : ` ${inner} `;
	};
	const nameOf = (option: Element): string => {
		const labelledBy = (option.getAttribute("aria-labelledby") ?? "").split(/\s+/).flatMap((id) => {
			const label = id === "" ? null : doc.getElementById(id);
			return label === null ? [] : [textOf(label)];
		});
		const name = labelledBy.length > 0 ? labelledBy.join(" ") : (option.getAttribute("aria-label") ?? textOf(option));
		return name.replace(/\s+/g, " ").trim();
	};
	const valueOf = (option: Element): string | null => option.getAttribute("data-value") ?? option.getAttribute("value");
	const loose = wanted.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	const match = options.find((option) => nameOf(option) === wanted || valueOf(option) === wanted) ?? options.find((option) => nameOf(option).toLocaleLowerCase() === loose);
	if (match === undefined) return { state: "missing", expanded, offered: options.slice(0, maxOffered).map(nameOf), label: "", disabled: false, option: null };
	return { state: "found", expanded, offered: [], label: nameOf(match), disabled: match.getAttribute("aria-disabled") === "true", option: match };
};

const SHOWN_CHOICE_SCRIPT = (combobox: Element, option: Element, label: string): { shows: boolean; text: string } => {
	const fields = [combobox, ...combobox.querySelectorAll("input")].filter((node): node is HTMLInputElement => node instanceof HTMLInputElement);
	const words: string[] = fields.map((field) => field.value);
	const walker = combobox.ownerDocument.createTreeWalker(combobox, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const list = node.parentElement?.closest('[role="listbox"]');
		if (list === null || list === undefined || !combobox.contains(list)) words.push(node.textContent ?? "");
	}
	const text = words.join(" ").replace(/\s+/g, " ").trim();
	const selectedInOpenList = option.isConnected && option.getAttribute("aria-selected") === "true";
	return { shows: selectedInOpenList || text.toLocaleLowerCase().includes(label.toLocaleLowerCase()), text };
};

export interface ComboboxPickOptions {
	readonly signal: AbortSignal;
	readonly budgetMs: number;
	readonly beforeEffect: () => Promise<void>;
	readonly describe: string;
}

async function searchOptions(combobox: ElementHandle, wanted: string, signal: AbortSignal): Promise<{ search: JSHandle<OptionSearch>; found: SearchSummary }> {
	const search: JSHandle<OptionSearch> = await untilAborted(signal, () => combobox.evaluateHandle(FIND_OPTION_SCRIPT, wanted, MAX_OFFERED_NAMES));
	const found = await search.evaluate(({ option: _option, ...summary }) => summary);
	return { search, found };
}

export async function pickInCombobox(page: Page, combobox: ElementHandle, wanted: string, options: ComboboxPickOptions): Promise<string> {
	const { signal, beforeEffect, describe } = options;
	let opened = false;
	let nudged = false;
	const listWaitMs = Math.min(LIST_WAIT_MS, options.budgetMs / 2);
	const deadline = Date.now() + listWaitMs;
	let { search, found } = await searchOptions(combobox, wanted, signal);
	try {
		while (found.state === "waiting") {
			if (!opened && !found.expanded) {
				await beforeEffect();
				opened = true;
				await untilAborted(signal, () => combobox.click());
			} else if (opened && !nudged && Date.now() >= deadline - listWaitMs / 2) {
				await beforeEffect();
				nudged = true;
				await untilAborted(signal, () => combobox.press("ArrowDown"));
			} else if (Date.now() >= deadline) {
				throw new ToolError(`${describe} opened no list of options: nothing with role="option" became visible. Look at the page (tab.observe()) and click the combobox's own options instead.`);
			} else {
				await untilAborted(signal, () => sleep(LIST_POLL_MS));
			}
			await search.dispose();
			({ search, found } = await searchOptions(combobox, wanted, signal));
		}
		if (found.state === "missing") {
			if (opened) {
				await beforeEffect();
				await untilAborted(signal, () => page.keyboard.press("Escape"));
			}
			throw new ToolError(`${describe} has no option named or valued ${JSON.stringify(wanted)}. It offers: ${found.offered.map((name) => JSON.stringify(name)).join(", ")}.`);
		}
		const { label, disabled } = found;
		if (disabled) throw new ToolError(`${describe}: the option ${JSON.stringify(label)} is disabled.`);
		const option = await search.evaluateHandle((result) => {
			if (result.option === null) throw new Error("the matched option is gone");
			return result.option;
		});
		try {
			await beforeEffect();
			await untilAborted(signal, () => option.click());
			const verifyBy = Date.now() + Math.min(VERIFY_MS, options.budgetMs / 4);
			for (;;) {
				const shown = await untilAborted(signal, () => combobox.evaluate(SHOWN_CHOICE_SCRIPT, option, label));
				if (shown.shows) return label;
				if (Date.now() >= verifyBy) throw new ToolError(`${describe} clicked the option ${JSON.stringify(label)}, but the combobox does not show it (it shows ${JSON.stringify(shown.text)}).`);
				await untilAborted(signal, () => sleep(LIST_POLL_MS));
			}
		} finally {
			await option.dispose().catch(() => undefined);
		}
	} finally {
		await search.dispose().catch(() => undefined);
	}
}
