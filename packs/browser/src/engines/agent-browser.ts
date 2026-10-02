/**
 * How a THROWAWAY AGENT browser presents itself to the sites it visits.
 *
 * An agent that opens a browser without a profile does real work on the real
 * web, and the first bot check it meets decides whether the work happens. A
 * stock puppeteer Chrome fails public headless checks that the same Chrome
 * started by hand passes; this module closes exactly those, once, in the
 * browser itself:
 *
 *  - `navigator.webdriver` (page and iframes; a worker has no such property):
 *    the `AutomationControlled` Blink switch, a launch argument. No page
 *    script is involved.
 *  - a page larger than its own "screen", a window smaller than its page, a
 *    1280x800 desktop page reporting `portrait-primary`: headless Chrome's
 *    virtual screen is 800x600 whatever the viewport. A device-metrics
 *    override and the window bounds, both native CDP commands, made again
 *    whenever the viewport changes (`fitAgentScreen`).
 *  - CDP `Runtime.enable`, which stock puppeteer sends in every page, frame
 *    and worker and a page can detect, and the driver's own DOM reads, which
 *    stock puppeteer runs in the page's own JavaScript world (a hook on
 *    `document.getElementById` sees each), under a script name that holds the
 *    pack's file path (`pptr:evaluate;<callsite>`): an agent browser is driven
 *    with a patched puppeteer-core (`agent-puppeteer.ts`) that sends no
 *    Runtime.enable, reads in the utility world and names no script.
 *  - a software renderer (SwiftShader, llvmpipe) on a host with no GPU: the
 *    one signal that needs a page script, so it exists only for such hosts,
 *    decided once per browser binary (`SOFTWARE_GRAPHICS_MASK`).
 *
 * The User-Agent, its client hints and the workers' view of both are
 * `presentAsHeadful`'s (puppeteer.ts), for the View and for this alike.
 *
 * THE EXCEPTION, and why it is explicit: doc 77 §12 decision 2 refuses the
 * automation-hiding switch so that a person signing in, in the View or a saved
 * profile, is not disguised and Google is not given a reason to challenge a
 * sign-in. That decision stands for the View and every saved profile, which
 * stay the real, honest browser: nothing in this module touches them. It is
 * reversed, on the lead's reading of the owner's parity ruling with OMP's
 * browser (doc 77 §12, awaiting his signature; he may flip it), ONLY for a
 * throwaway browser (no profile; nothing is kept, nobody signs in).
 * `EngineOptions.agent` is the one switch; the runtime sets it from
 * `profile === null`, never from tool input.
 *
 * `browser_read`'s reader is NOT covered by that reading: OMP has no reader, so
 * the parity ruling says nothing about it. It launches as stock puppeteer
 * does, as it did before this module existed, until the owner says otherwise;
 * `READER_PRESENTS_AS_CHROME` turns the shaping below on for it in one line.
 */
import type { CDPSession, Protocol } from "puppeteer-core";
import type { Viewport } from "../contracts.js";
import { LOOPBACK_EXCEPTIONS } from "./page-log.js";

/**
 * Whether `browser_read`'s reader is shaped like a throwaway agent browser (no `navigator.webdriver`, the binary's own headful
 * User-Agent, a screen that fits, the patched puppeteer-core, a masked software renderer). FALSE: the reader is stock puppeteer,
 * as on main, because OMP has no reader and the owner's parity ruling (doc 77 §12 decision 8) does not reach it; this is a
 * decision for him. Setting it to `true` is the whole change: `launchReader` (puppeteer.ts) reads it, and a test launches the
 * reader both ways.
 */
export const READER_PRESENTS_AS_CHROME: boolean = false;

/**
 * Launch arguments for a HEADLESS agent browser: `navigator.webdriver` is false in every page and iframe, from the browser
 * itself. Not for a browser with a window: Chrome pins a yellow "unsupported command-line flag" bar to every window it opens
 * with this switch, which changes what the person watching sees and takes 40 px off the page.
 */
export const AGENT_LAUNCH_ARGS: readonly string[] = ["--disable-blink-features=AutomationControlled"];

/**
 * Switches puppeteer adds by default that a person's Chrome does not carry and a page can observe: `--enable-automation`
 * (webdriver, the infobar), `--disable-popup-blocking` (a `window.open` with no gesture succeeds), `--disable-ipc-flooding-protection`
 * (a `pushState` flood is never throttled), `--allow-pre-commit-input`. The privacy switches in `CHROMIUM_ARGS` (puppeteer.ts) are kept on
 * purpose: a page cannot see them. So is puppeteer's `--disable-features` list (the patched library does not drop it as OMP's does): the
 * detection page reads nothing from it, and without it Chrome starts an extra renderer process per browser (WebUIOmniboxPopup, WebUIOmniboxAimPopup).
 */
export const AGENT_IGNORED_DEFAULT_ARGS: readonly string[] = ["--enable-automation", "--disable-popup-blocking", "--disable-ipc-flooding-protection", "--allow-pre-commit-input"];

/** What a stock Chrome window spends on its tab strip and address bar, in CSS px: `outerHeight - innerHeight`. */
const WINDOW_CHROME_HEIGHT = 88;
/** The smallest desktop display presented; it grows to hold a larger window. */
const MIN_SCREEN: Viewport = { width: 1920, height: 1080 };

/**
 * The device metrics that give a page `viewport` a screen that agrees with it:
 * headless Chrome's own screen is 800x600 whatever the page measures, and its
 * orientation portrait.
 */
export function deviceMetrics(viewport: Viewport, scale: number): Protocol.Emulation.SetDeviceMetricsOverrideRequest {
	return {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: scale,
		mobile: false,
		screenWidth: Math.max(MIN_SCREEN.width, viewport.width),
		screenHeight: Math.max(MIN_SCREEN.height, viewport.height + WINDOW_CHROME_HEIGHT),
		positionX: 0,
		positionY: 0,
		screenOrientation: { angle: 0, type: "landscapePrimary" },
	};
}

/**
 * Give a page `viewport` a screen and a window that agree with it. Call after
 * every `page.setViewport`: puppeteer's override replaces ours, and headless
 * Chrome's own window is 780x580 whatever the page measures. `cdp` is any
 * session on the page.
 */
export async function fitAgentScreen(cdp: CDPSession, viewport: Viewport, scale: number): Promise<void> {
	await cdp.send("Emulation.setDeviceMetricsOverride", deviceMetrics(viewport, scale));
	const { windowId } = await cdp.send("Browser.getWindowForTarget");
	await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: viewport.width, height: viewport.height + WINDOW_CHROME_HEIGHT } });
}

/** What an agent browser's targets are shaped with. */
export interface AgentShape {
	/** Give each page a screen and window that fit it. Not in a browser with a real window, which already has both. */
	screen: boolean;
	/** The GPU to report instead of a software renderer, when the binary renders in software here. */
	graphics: MaskedGraphics | undefined;
	/** `shapeTargetEarly` runs for every new target (a headless browser, where `presentAsHeadful` holds each one); otherwise the driver shapes each page as it adopts it. */
	early: boolean;
	/** The viewport and pixel ratio the driver is at now. The driver keeps it current, so a target shaped before its tab exists gets today's size. */
	view: { viewport: Viewport; scale: number };
}

/**
 * Shape a NEW target before it runs a line of its own: `presentAsHeadful`
 * (puppeteer.ts) holds every target Chrome opens (the first tab, a popup, a
 * `target=_blank` page, a cross-origin iframe, a worker) until these are
 * sent on its own session. Pages and out-of-process frames get the software
 * renderer mask in every document and, in a headless browser, a screen that
 * fits; dedicated and shared workers get the mask in their global scope, so a
 * worker's OffscreenCanvas names the same GPU as its page. The window's own
 * bounds are set when the tab is adopted (`fitAgentScreen`).
 */
export function shapeTargetEarly(session: CDPSession, targetType: string, shape: AgentShape): Array<Promise<unknown>> {
	const mask = shape.graphics ? graphicsMaskExpression(shape.graphics) : undefined;
	if (targetType === "page" || targetType === "iframe") {
		// A session's document scripts run only once its Page domain is on.
		const sent: Array<Promise<unknown>> = [session.send("Page.enable"), session.send("Page.addScriptToEvaluateOnNewDocument", { source: [mask, LOOPBACK_EXCEPTIONS].filter(Boolean).join(";\n") })];
		if (shape.screen && targetType === "page") sent.push(session.send("Emulation.setDeviceMetricsOverride", deviceMetrics(shape.view.viewport, shape.view.scale)));
		return sent;
	}
	if ((targetType === "worker" || targetType === "shared_worker") && mask) return [session.send("Runtime.evaluate", { expression: mask })];
	return [];
}

/** What a software renderer's strings look like (Chrome's SwiftShader, Mesa's llvmpipe/lavapipe). */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|lavapipe|software|mesa offscreen|google inc\. \(google\)/i;

/** A GPU a person's machine of this platform commonly has, as `WEBGL_debug_renderer_info` words it. */
export interface MaskedGraphics {
	vendor: string;
	renderer: string;
}

/** The GPU an agent browser on a software renderer reports instead, by the platform it presents (`navigator.userAgentData.platform`). */
export function maskedGraphics(platform: string): MaskedGraphics {
	if (/mac/i.test(platform)) return { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" };
	if (/win/i.test(platform)) return { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" };
	return { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)" };
}

/**
 * Runs in every new document (`evaluateOnNewDocument`), and only in a browser
 * whose binary was found to render in software. Answers a masked vendor and
 * renderer for the two unmasked-info parameters, from a Proxy over the native
 * `getParameter` (so a wrong receiver still throws Chrome's own error), and
 * makes both it and `Function.prototype.toString` report `[native code]`. The
 * lower float precisions are answered with the highest's, as ANGLE on a real GPU
 * does. Not touched, and different from a real GPU's: texture and uniform limits
 * and the extension list; a TypeError thrown through a wrapper shows its
 * `Object.apply` frame (the same weakness oh-my-pi's scripts have).
 *
 * A Proxy reads `function () { [native code] }` (no name) to ANOTHER realm's own
 * `Function.prototype.toString`, so a same-origin frame's toString asked about this
 * window's replaced functions, or this window's asked about a frame's, tells them
 * from the real ones. THAT IS A KNOWN GAP, measured by the detect page's
 * `native-source-cross-realm` row (it flags on a host with no GPU, as OMP's own
 * does). An earlier revision closed it by having every frame call the topmost
 * window's `Function.prototype.toString` with a secret symbol (to register the
 * name of each function it replaced and to look one up). That call goes through
 * whatever the page has put at `Function.prototype.toString`: a page that wrapped it
 * before making a frame was handed the secret and every masked name (reproduced by a
 * reviewer, and by the detect page's `tostring-wrapper-heard` row), and no frame can
 * prove that what it calls is this script's own proxy. So nothing here calls into a
 * function the page can replace; each realm names only its own.
 * Self-contained: it is serialized into the page, and into each dedicated and
 * shared worker (`graphicsMaskExpression`), whose OffscreenCanvas would
 * otherwise name the host's renderer beside the page's masked one.
 */
export const SOFTWARE_GRAPHICS_MASK = (vendor: string, renderer: string, software: string): void => {
	const looksSoftware = new RegExp(software, "i");
	const nativeToString = Function.prototype.toString;
	const names = new WeakMap<object, string>();
	const toString = new Proxy(nativeToString, {
		apply(target, self, args) {
			const name = names.get(self as object);
			return name === undefined ? Reflect.apply(target, self, args) : `function ${name}() { [native code] }`;
		},
	});
	/** `fn` reads `function <name>() { [native code] }` to this realm's toString. */
	const known = <T extends object>(fn: T, name: string): T => {
		names.set(fn, name);
		return fn;
	};
	known(toString, "toString");
	Object.defineProperty(Function.prototype, "toString", { value: toString, writable: true, configurable: true, enumerable: false });
	const UNMASKED_VENDOR_WEBGL = 0x9245;
	const UNMASKED_RENDERER_WEBGL = 0x9246;
	for (const Context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
		if (typeof Context !== "function") continue;
		const original = Context.prototype.getParameter;
		const getParameter = new Proxy(original, {
			apply(target, self, args) {
				const value: unknown = Reflect.apply(target, self, args);
				if (typeof value !== "string" || !looksSoftware.test(value)) return value;
				if (args[0] === UNMASKED_VENDOR_WEBGL) return vendor;
				if (args[0] === UNMASKED_RENDERER_WEBGL) return renderer;
				return value;
			},
		});
		known(getParameter, "getParameter");
		Object.defineProperty(Context.prototype, "getParameter", { value: getParameter, writable: true, configurable: true, enumerable: true });
		// ANGLE on a real GPU reports one precision for every float type; SwiftShader gives the lower ones less. The higher type's
		// own native answer stands in, so the object is a real WebGLShaderPrecisionFormat.
		const LOW_FLOAT = 0x8df0;
		const MEDIUM_FLOAT = 0x8df1;
		const HIGH_FLOAT = 0x8df2;
		const precision = new Proxy(Context.prototype.getShaderPrecisionFormat, {
			apply(target, self, args) {
				const type: unknown = args[1];
				return Reflect.apply(target, self, type === LOW_FLOAT || type === MEDIUM_FLOAT ? [args[0], HIGH_FLOAT] : args);
			},
		});
		known(precision, "getShaderPrecisionFormat");
		Object.defineProperty(Context.prototype, "getShaderPrecisionFormat", { value: precision, writable: true, configurable: true, enumerable: true });
	}
};

/** `SOFTWARE_GRAPHICS_MASK` as an expression to run in a worker's global scope, before its script does. */
export function graphicsMaskExpression(graphics: MaskedGraphics): string {
	return `(${SOFTWARE_GRAPHICS_MASK.toString()})(${JSON.stringify(graphics.vendor)}, ${JSON.stringify(graphics.renderer)}, ${JSON.stringify(SOFTWARE_RENDERER.source)})`;
}
