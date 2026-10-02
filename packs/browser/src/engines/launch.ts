/**
 * How the Browser View's browser is launched: WHICH browser, and with what
 * switches and identity. Pure functions over an injectable filesystem probe,
 * so the choice is testable without a browser.
 *
 * The View's browser is meant to be the user's real browser, launched as that
 * browser: sites must see what they would see from the same Chrome started by
 * hand. Two things puppeteer adds by default made sites (x.com answers 403
 * before any page loads) treat it as a bot:
 *  - headless Chrome names itself `HeadlessChrome/<v>` in the User-Agent;
 *    that token alone is what x.com's edge refuses. The View IS headless (it is
 *    a screencast inside the app, not a desktop window), so the browser
 *    presents the SAME binary's headful identity: its User-Agent with the
 *    headless token taken out, and its own User-Agent client hints, both read
 *    from that binary (`headfulIdentity`), never made up.
 *  - `--enable-automation`, puppeteer's "controlled by automated test
 *    software" switch, is dropped. Nothing is added in its place for the View
 *    or a saved profile: no `AutomationControlled` blink switch, no stealth,
 *    no fingerprint changes (doc 77 §12 decision 2). A THROWAWAY agent
 *    browser is the one exception, and `agent-browser.ts` is all of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Browser as CachedBrowser, type BrowserPlatform, detectBrowserPlatform, getInstalledBrowsers } from "@puppeteer/browsers";
import type { LaunchOptions, Protocol } from "puppeteer-core";
import type { BrowserApp } from "../contracts.js";
import { fail } from "../store.js";
import { AGENT_IGNORED_DEFAULT_ARGS, AGENT_LAUNCH_ARGS, SOFTWARE_RENDERER } from "./agent-browser.js";

export interface ResolvedBrowser {
	app: BrowserApp;
	executablePath: string;
}

/** What `resolveBrowser` may look at; tests pass a fake. */
export interface BrowserProbe {
	platform: NodeJS.Platform;
	/** puppeteer's name for this OS/arch, which picks the cached build; undefined when unsupported. */
	browserPlatform: BrowserPlatform | undefined;
	env: Record<string, string | undefined>;
	home: string;
	exists(path: string): boolean;
}

export const systemProbe: BrowserProbe = {
	platform: process.platform,
	browserPlatform: detectBrowserPlatform(),
	env: process.env,
	home: homedir(),
	exists: existsSync,
};

/**
 * The browser the View launches: an explicit binary when configured; else the
 * installed Google Chrome; else Microsoft Edge; else a Chromium — a system
 * install, then the newest Chrome for Testing puppeteer has downloaded into
 * its cache for this platform. Nothing is downloaded here.
 */
export async function resolveBrowser(explicitPath: string | undefined, probe: BrowserProbe = systemProbe): Promise<ResolvedBrowser> {
	if (explicitPath) return { app: "custom", executablePath: explicitPath };
	const candidates = installedCandidates(probe);
	for (const app of ["chrome", "msedge", "chromium"] as const) {
		const executablePath = candidates[app].find((path) => probe.exists(path));
		if (executablePath) return { app, executablePath };
	}
	const cacheDir = probe.env.PUPPETEER_CACHE_DIR || join(probe.home, ".cache", "puppeteer");
	const cached = (await getInstalledBrowsers({ cacheDir }))
		.filter((build) => build.browser === CachedBrowser.CHROME && build.platform === probe.browserPlatform && probe.exists(build.executablePath))
		.sort((a, b) => compareVersions(b.buildId, a.buildId))[0];
	if (cached) return { app: "chromium", executablePath: cached.executablePath };
	return fail(
		"browser_not_found",
		`No Google Chrome, Microsoft Edge or Chromium found (looked in ${Object.values(candidates).flat().join(", ")} and puppeteer's cache ${cacheDir}). ` +
			`Install Google Chrome, or set DIMENSION_BROWSER_EXECUTABLE to a Chrome/Chromium binary.`,
	);
}

function installedCandidates(probe: BrowserProbe): Record<"chrome" | "msedge" | "chromium", string[]> {
	if (probe.platform === "win32") {
		const roots = [probe.env.PROGRAMFILES, probe.env["PROGRAMFILES(X86)"], probe.env.LOCALAPPDATA].filter(
			(root): root is string => typeof root === "string" && root.length > 0,
		);
		return {
			chrome: roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
			msedge: roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
			chromium: roots.map((root) => join(root, "Chromium", "Application", "chrome.exe")),
		};
	}
	if (probe.platform === "darwin") {
		const apps = ["/Applications", join(probe.home, "Applications")];
		return {
			chrome: apps.map((dir) => join(dir, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")),
			msedge: apps.map((dir) => join(dir, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")),
			chromium: apps.map((dir) => join(dir, "Chromium.app", "Contents", "MacOS", "Chromium")),
		};
	}
	return {
		chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
		msedge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"],
		chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
	};
}

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The high-entropy User-Agent client hints a page may ask for; `headfulIdentity` replays the binary's own answers. */
export const UA_HINTS = ["architecture", "bitness", "brands", "formFactors", "fullVersionList", "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"] as const;

/** What the binary itself reports: its User-Agent, `navigator.userAgentData.getHighEntropyValues(UA_HINTS)` and its WebGL vendor and renderer. */
export interface ReportedIdentity {
	userAgent: string;
	/** The unmasked WebGL vendor and renderer, as one string; undefined when the page has no WebGL. */
	graphics?: string;
	hints: {
		brands?: Protocol.Emulation.UserAgentBrandVersion[];
		fullVersionList?: Protocol.Emulation.UserAgentBrandVersion[];
		uaFullVersion?: string;
		platform?: string;
		platformVersion?: string;
		architecture?: string;
		model?: string;
		mobile?: boolean;
		bitness?: string;
		wow64?: boolean;
		formFactors?: string[];
	};
}

/** The identity a headless View presents: the binary's own, as its headful build reports it. */
export interface HeadfulIdentity {
	userAgent: string;
	metadata: Protocol.Emulation.UserAgentMetadata;
	/** The binary renders WebGL in software here (no GPU): an agent browser masks it, see `SOFTWARE_GRAPHICS_MASK`. */
	softwareGraphics: boolean;
}

/**
 * The same binary's headful identity from what it reported headless. Only the
 * `HeadlessChrome/` product token differs between the two; the client hints
 * already name the real brand ("Google Chrome", "Microsoft Edge") and are
 * passed through as reported.
 */
export function headfulIdentity(reported: ReportedIdentity): HeadfulIdentity {
	const { hints } = reported;
	return {
		userAgent: reported.userAgent.replace(/\bHeadlessChrome\//, "Chrome/"),
		softwareGraphics: SOFTWARE_RENDERER.test(reported.graphics ?? ""),
		metadata: {
			platform: hints.platform ?? "",
			platformVersion: hints.platformVersion ?? "",
			architecture: hints.architecture ?? "",
			model: hints.model ?? "",
			mobile: hints.mobile ?? false,
			...(hints.brands ? { brands: hints.brands } : {}),
			...(hints.fullVersionList ? { fullVersionList: hints.fullVersionList } : {}),
			...(hints.uaFullVersion ? { fullVersion: hints.uaFullVersion } : {}),
			...(hints.bitness !== undefined ? { bitness: hints.bitness } : {}),
			...(hints.wow64 !== undefined ? { wow64: hints.wow64 } : {}),
			...(hints.formFactors ? { formFactors: hints.formFactors } : {}),
		},
	};
}

/** A throwaway launch of one binary, read for its identity and then retired. */
export interface IdentityProbe {
	read(): Promise<ReportedIdentity>;
	close(): Promise<void>;
	/** Hard stop, for a close that failed or hung. */
	kill(): void;
}

/** The headful identity of each browser binary; see `identityPerBinary`. */
export interface BinaryIdentities {
	/** This binary's identity, probed once per build and set of `launchArgs` (which can change what it renders with). */
	of(executablePath: string, launchArgs?: readonly string[]): Promise<HeadfulIdentity>;
	/**
	 * The identity for a browser of this binary that is already running and
	 * reports `runningVersion` (`Browser.getVersion`'s product version, which
	 * is the binary's `uaFullVersion`): `identity` when it names that version,
	 * else probed again, once, with no further check.
	 */
	confirm(executablePath: string, identity: HeadfulIdentity, runningVersion: string, launchArgs?: readonly string[]): Promise<HeadfulIdentity>;
	/** This binary's identity when it is already known or being probed; undefined otherwise. Starts nothing. */
	known(executablePath: string, launchArgs?: readonly string[]): Promise<HeadfulIdentity> | undefined;
	/** Record what a running browser of this binary reported about itself, so no probe is ever launched for it. */
	learn(executablePath: string, identity: HeadfulIdentity, launchArgs?: readonly string[]): void;
}

/**
 * The headful identity of each browser binary, probed once per build: keyed
 * on the path AND the binary's `stamp` (its mtime), because Chrome, Edge and
 * Chromium update in place at the same path, and a stale identity would name
 * the old version beside the new binary's own. A stamp cannot see every
 * update (a snap Chromium refreshes behind a symlink and a wrapper script),
 * so `confirm` checks the identity against the version the launched browser
 * reports. Failures are not cached.
 *
 * The probe's close is bounded by `closeTimeoutMs`, and a close that fails or
 * hangs kills the probe. What was read stands whatever the close outcome: a
 * probe that will not shut down cleanly must not fail the open it was read for.
 */
export function identityPerBinary(options: {
	launch(executablePath: string, launchArgs: readonly string[]): Promise<IdentityProbe>;
	stamp(executablePath: string): number;
	closeTimeoutMs: number;
}): BinaryIdentities {
	const known = new Map<string, Promise<HeadfulIdentity>>();
	/** One build of one binary under one set of arguments: the path, its stamp and the arguments. */
	const buildOf = (executablePath: string, launchArgs: readonly string[]): string => `${executablePath}\0${options.stamp(executablePath)}\0${launchArgs.join("\0")}`;
	const probe = async (executablePath: string, launchArgs: readonly string[]): Promise<HeadfulIdentity> => {
		const launched = await options.launch(executablePath, launchArgs);
		try {
			return headfulIdentity(await launched.read());
		} finally {
			await withTimeout(launched.close(), options.closeTimeoutMs, "identity probe close").catch(() => launched.kill());
		}
	};
	const of = (executablePath: string, launchArgs: readonly string[] = []): Promise<HeadfulIdentity> => {
		const key = buildOf(executablePath, launchArgs);
		let identity = known.get(key);
		if (!identity) {
			identity = probe(executablePath, launchArgs);
			identity.catch(() => known.delete(key));
			known.set(key, identity);
		}
		return identity;
	};
	return {
		of,
		known: (executablePath, launchArgs = []) => known.get(buildOf(executablePath, launchArgs)),
		learn(executablePath, identity, launchArgs = []) {
			known.set(buildOf(executablePath, launchArgs), Promise.resolve(identity));
		},
		async confirm(executablePath, identity, runningVersion, launchArgs = []) {
			if (identity.metadata.fullVersion === undefined || identity.metadata.fullVersion === runningVersion) return identity;
			const key = buildOf(executablePath, launchArgs);
			// Only the stale entry is dropped: a concurrent open may already have re-probed.
			if ((await known.get(key)?.catch(() => undefined)) === identity) known.delete(key);
			return await of(executablePath, launchArgs);
		},
	};
}

/** Bound a call that would otherwise hang the caller forever. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise: expired, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Puppeteer launch options for the View's browser. `userAgent` (headless only;
 * a headful Chrome already sends its own) goes in as `--user-agent`: that
 * switch is the only thing that reaches shared and service workers'
 * `navigator.userAgent` and a service worker's script fetch. It also blanks
 * the high-entropy client hints, so the driver restores them per target with
 * the binary's own metadata (`presentAsHeadful` in puppeteer.ts).
 */
export function viewLaunchOptions(input: {
	browser: ResolvedBrowser;
	userDataDir: string;
	headless: boolean;
	args: readonly string[];
	userAgent?: string;
	/** A throwaway agent browser (see `agent-browser.ts`): headless, it launches with `navigator.webdriver` false. Never for the View or a saved profile. */
	agent?: boolean;
	timeout: number;
}): LaunchOptions {
	return {
		executablePath: input.browser.executablePath,
		headless: input.headless,
		userDataDir: input.userDataDir,
		timeout: input.timeout,
		defaultViewport: null,
		args: [...input.args, ...(input.agent && input.headless ? AGENT_LAUNCH_ARGS : []), ...(input.headless && input.userAgent ? [`--user-agent=${input.userAgent}`] : [])],
		ignoreDefaultArgs: input.agent ? [...AGENT_IGNORED_DEFAULT_ARGS] : ["--enable-automation"],
	};
}

/**
 * Turn off Chrome's own "Offer to save passwords" in a profile we own, before
 * Chrome starts on it. The pack keeps its own credentials (credentials.ts);
 * Chrome's store would be a second copy, and its save prompt — which
 * `--enable-automation` used to suppress — takes focus from the page after a
 * sign-in, invisibly in a headless View. It is the same setting a user flips
 * in chrome://settings/passwords; only these two keys are written.
 */
export function turnOffPasswordSaving(userDataDir: string): void {
	const path = join(userDataDir, "Default", "Preferences");
	let prefs: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return; // Unreadable: Chrome resets it itself; never overwrite what we cannot read.
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		prefs = parsed as Record<string, unknown>;
	}
	const profile = prefs.profile && typeof prefs.profile === "object" ? (prefs.profile as Record<string, unknown>) : {};
	if (prefs.credentials_enable_service === false && profile.password_manager_enabled === false) return;
	mkdirSync(join(userDataDir, "Default"), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify({ ...prefs, credentials_enable_service: false, profile: { ...profile, password_manager_enabled: false } }), { mode: 0o600 });
}
