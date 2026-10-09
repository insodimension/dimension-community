// Partly copied from OMP (https://github.com/can1357/oh-my-pi, MIT): the proxy flags are packages/coding-agent/src/tools/browser/launch.ts:455-468 (buildHeadlessLaunchArgs) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the same three environment names, read from an injectable environment; the sandbox switches are added only for a Linux root user (OMP adds them to every launch); certificate errors being ignored is said once on stderr.

/**
 * Launch switches that come from the environment rather than from the engine: the proxy a person routes the browser through, and the sandbox
 * switches a Linux root user needs. Pure over an injectable environment, so the choice is testable without a browser.
 *
 *  - `PUPPETEER_PROXY` → `--proxy-server`; with `PUPPETEER_PROXY_BYPASS_LOOPBACK` also `--proxy-bypass-list=<-loopback>` (Chrome bypasses a proxy for
 *    localhost since v72; this sends localhost traffic to it too, for a capturing proxy such as mitmdump).
 *  - `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` → `--ignore-certificate-errors`. Off unless set; the browser then stops verifying HTTPS, which is why it is
 *    said on stderr the first time it is applied.
 *  - Linux, running as root: Chrome refuses to start with its sandbox unless these two switches are given (a container habit, not a default).
 */

const TRUTHY = new Set(["true", "1", "yes", "on"]);

/** True for "true", "1", "yes", "on" in any case (OMP's reading of these three variables). */
function flag(value: string | undefined): boolean {
	return value !== undefined && TRUTHY.has(value.toLowerCase());
}

let warnedInsecureTls = false;

/** The switches the environment asks for. `uid` is the effective user id (undefined where there is none, as on Windows). */
export function environmentLaunchArgs(
	env: Record<string, string | undefined> = process.env,
	system: { platform?: NodeJS.Platform; uid?: number | undefined } = { platform: process.platform, uid: process.getuid?.() },
): string[] {
	const args: string[] = [];
	if (system.platform === "linux" && system.uid === 0) args.push("--no-sandbox", "--disable-setuid-sandbox");
	const proxy = env.PUPPETEER_PROXY;
	if (proxy) {
		args.push(`--proxy-server=${proxy}`);
		if (flag(env.PUPPETEER_PROXY_BYPASS_LOOPBACK)) args.push("--proxy-bypass-list=<-loopback>");
	}
	if (flag(env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS)) {
		args.push("--ignore-certificate-errors");
		if (!warnedInsecureTls) {
			warnedInsecureTls = true;
			console.error("[browser] PUPPETEER_PROXY_IGNORE_CERT_ERRORS is set: browsers this server launches do not verify HTTPS certificates");
		}
	}
	return args;
}
