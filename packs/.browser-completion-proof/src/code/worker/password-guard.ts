// Written for the Browser pack (matrix D18). OMP has no such rule: here code does not type into a password field, and this is where that is decided. Keys go to whatever has focus, not to the element a helper was
// pointed at, so the check is on the field the keys would reach, after focus has been given.

import type { ElementHandle, Frame, Page } from "puppeteer-core";
import { ToolError } from "../errors";
import { untilAborted } from "./abortable";

/** Frames are followed through their iframe elements. A page nested deeper than this is a way round the check, not a page: it is refused. */
const MAX_FRAME_HOPS = 16;

/** The code names of the keys that produce text: a single character is one too (the model's code can pass any string, whatever puppeteer's `KeyInput` type says). Enter, Tab, the arrows, Backspace and the rest do not, and stay allowed: Enter in a password field is how a login is sent. */
const TEXT_KEY_NAME = /^(?:Key[A-Z]|Digit\d|Numpad(?:\d|Add|Subtract|Multiply|Divide|Decimal)|Space|Backquote|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash)$/;

/** Whether pressing `key` types a character. */
export function producesText(key: string): boolean {
  return [...key].length === 1 || TEXT_KEY_NAME.test(key);
}

/** Page side: what keys sent now reach in THIS document (its active element, through open shadow roots), as far as one document can tell. */
function focusedKindHere(): "password" | "frame" | "other" {
  let element: Element | null = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) return "frame";
  return element instanceof HTMLInputElement && element.type === "password" ? "password" : "other";
}

/** Page side: the element {@link focusedKindHere} looked at. */
function focusedElementHere(): Element | null {
  let element: Element | null = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/**
 * Whether a key sent now would reach a password input: the deepest focused element of the page, through open shadow roots and through iframes (each by its own document, a cross-origin one too: puppeteer has a
 * frame for it). Not seen: a CLOSED shadow root, which no page script can look into and which shows its host as the focused element.
 */
async function keysReachPasswordField(page: Page, sig: AbortSignal | undefined): Promise<boolean> {
  let frame: Frame = page.mainFrame();
  for (let hop = 0; hop < MAX_FRAME_HOPS; hop++) {
    const kind = await untilAborted(sig, () => frame.evaluate(focusedKindHere));
    if (kind !== "frame") return kind === "password";
    const iframe = (await untilAborted(sig, () => frame.evaluateHandle(focusedElementHere))).asElement();
    if (!iframe) return false;
    try {
      const inner = await untilAborted(sig, () => (iframe as ElementHandle<HTMLIFrameElement>).contentFrame());
      if (!inner) return false;
      frame = inner;
    } finally {
      await iframe.dispose().catch(() => undefined);
    }
  }
  return true;
}

/**
 * The refusal, written for the model that can read it: a cell runs only in the spaces that have `browser_run`, and those see `browser_view`, `browser_read`, `browser_profiles` and `browser_close` besides it, never the step tools
 * (`browser_act`, `browser_open`) or the task tools (Traction's). So the routes are the person's: they type it themselves in the Browser View, or sign in to a saved profile there.
 */
function refusal(subject: string): ToolError {
  return new ToolError(
    `${subject}; browser_run does not type into password fields from code. Ask the user to type it themselves in the Browser View, where they can drive this browser, or to sign in to a saved profile with browser_view({ profile }) so the login is kept. Then carry on from the page they leave.`,
  );
}

export interface PasswordGuard {
  /**
   * Before text is typed into `target` (a handle; `label` names it for the model): refuse when it is a password input, then give it focus and refuse when what holds focus is one (a custom element that
   * hands focus on, an `onfocus` that moves it, an iframe, a target that cannot take focus so the field a click focused earlier keeps it).
   */
  beforeTyping(target: ElementHandle, label: string, sig: AbortSignal | undefined): Promise<void>;
  /** Before `tab.press(key)`: refuse a key that types a character while a password input holds focus (`label` names the call). A key that does not type stays allowed, Enter above all. */
  beforePress(key: string, label: string, sig: AbortSignal | undefined): Promise<void>;
}

export function createPasswordGuard(page: Page): PasswordGuard {
  return {
    async beforeTyping(target, label, sig) {
      if (await untilAborted(sig, () => target.evaluate(el => el instanceof HTMLInputElement && el.type === "password"))) throw refusal(`${label} is a password field`);
      // Not `target.focus()`: that throws for an element that cannot take focus, and what the helper then does says so in its own words. Here it is only the check that needs focus given.
      await untilAborted(sig, () => target.evaluate(el => (el as HTMLElement).focus?.()));
      if (await keysReachPasswordField(page, sig)) throw refusal(`typing into ${label} would reach a password field (the focused element is one)`);
    },
    async beforePress(key, label, sig) {
      if (producesText(key) && (await keysReachPasswordField(page, sig))) throw refusal(`${label} would reach a password field (the focused element is one)`);
    },
  };
}
