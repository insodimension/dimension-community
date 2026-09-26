/**
 * How the Browser View's browser is launched: WHICH browser, and with what
 * switches. Pure functions over an injectable filesystem probe, so the choice
 * is testable without a browser.
 *
 * The View's browser is meant to be the user's real browser, launched as that
 * browser: sites must see what they would see from the same Chrome started by
 * hand. Two things puppeteer adds by default made sites (x.com answers 403
 * before any page loads) treat it as a bot:
 *  - headless Chrome names itself `HeadlessChrome/<v>` in the User-Agent;
 *    that token alone is what x.com's edge refuses. The View IS headless (it is
 *    a screencast inside the app, not a desktop window), so the browser is
 *    started with its own headful User-Agent — the same binary's string with
 *    the headless token taken out, read from that binary, never made up.
 *  - `--enable-automation`, puppeteer's "controlled by automated test
 *    software" switch, is dropped. Nothing is added in its place: no
 *    `AutomationControlled` blink switch, no stealth, no fingerprint changes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchOptions } from "puppeteer-core";
import type { BrowserApp } from "../contracts.js";
import { fail } from "../store.js";

export interface ResolvedBrowser {
	app: BrowserApp;
	executablePath: string;
}

/** What `resolveBrowser` may look at; tests pass a fake. */
export interface BrowserProbe {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
	exists(path: string): boolean;
	/** Entry names in `dir`; empty when it is missing or unreadable. */
	list(dir: string): string[];
}

export const systemProbe: BrowserProbe = {
	platform: process.platform,
	env: process.env,
	home: homedir(),
	exists: existsSync,
	list: (dir) => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
};

/**
 * The browser the View launches: an explicit binary when configured; else the
 * installed Google Chrome; else Microsoft Edge; else a Chromium — a system
 * install, then the newest one puppeteer has downloaded into its cache.
 * Nothing is downloaded here.
 */
export function resolveBrowser(explicitPath: string | undefined, probe: BrowserProbe = systemProbe): ResolvedBrowser {
	if (explicitPath) return { app: "custom", executablePath: explicitPath };
	const candidates = installedCandidates(probe);
	for (const app of ["chrome", "msedge", "chromium"] as const) {
		const executablePath = candidates[app].find((path) => probe.exists(path));
		if (executablePath) return { app, executablePath };
	}
	const cached = puppeteerCacheChrome(probe);
	if (cached) return { app: "chromium", executablePath: cached };
	return fail(
		"browser_not_found",
		`No Google Chrome, Microsoft Edge or Chromium found (looked in ${Object.values(candidates).flat().join(", ")}). ` +
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

/** Newest Chrome for Testing in puppeteer's download cache (`<cache>/chrome/<platform>-<version>/…`). */
function puppeteerCacheChrome(probe: BrowserProbe): string | undefined {
	const root = join(probe.env.PUPPETEER_CACHE_DIR || join(probe.home, ".cache", "puppeteer"), "chrome");
	const builds = probe.list(root)
		.map((name) => ({ name, version: /-(\d+(?:\.\d+)*)$/.exec(name)?.[1] }))
		.filter((build): build is { name: string; version: string } => build.version !== undefined)
		.sort((a, b) => compareVersions(b.version, a.version));
	for (const { name } of builds) {
		const platform = name.slice(0, name.lastIndexOf("-"));
		const path = probe.platform === "win32"
			? join(root, name, `chrome-${platform}`, "chrome.exe")
			: probe.platform === "darwin"
				? join(root, name, `chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
				: join(root, name, `chrome-${platform}`, "chrome");
		if (probe.exists(path)) return path;
	}
	return undefined;
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

/** The User-Agent the same binary sends when it is not headless. */
export function headfulUserAgent(userAgent: string): string {
	return userAgent.replace(/\bHeadlessChrome\//, "Chrome/");
}

/**
 * Puppeteer launch options for the View's browser. `userAgent` is this
 * binary's own headful string (`headfulUserAgent` of what it reports), set only
 * when headless: a headful Chrome already sends it.
 */
export function viewLaunchOptions(input: {
	browser: ResolvedBrowser;
	userDataDir: string;
	headless: boolean;
	args: readonly string[];
	userAgent?: string;
	timeout: number;
}): LaunchOptions {
	return {
		executablePath: input.browser.executablePath,
		headless: input.headless,
		userDataDir: input.userDataDir,
		timeout: input.timeout,
		defaultViewport: null,
		args: [...input.args, ...(input.headless && input.userAgent ? [`--user-agent=${input.userAgent}`] : [])],
		ignoreDefaultArgs: ["--enable-automation"],
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
