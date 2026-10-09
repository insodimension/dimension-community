/**
 * Engines that are refused, with the reason. Neither is a missing adapter: both
 * are upstream safety defects, and the complete adapters are in this pack's git
 * history (e96c2fb for ABP, ff6dba3 for Browser4). When upstream fixes land, the
 * engine comes back as a thin pass-through to its own published server — we do
 * not maintain a workaround for somebody else's defect.
 */
export const REFUSED_ENGINES = {
	abp: {
		code: "abp_unauthenticated_control_port",
		message:
			"The ABP browser is refused: its embedded control server authenticates nothing (request headers are dropped before " +
			"routing and any body is parsed as JSON), so any page it visits could open tabs, navigate or shut it down with no " +
			"token. A browser that holds your logins is not started. Upstream: theredsix/agent-browser-protocol#16. " +
			"Use the chromium or chrome-relay engine.",
	},
	browser4: {
		code: "browser4_tls_verification_disabled",
		message:
			"The Browser4 engine is refused: every published bundle (through v4.14.0-rc.6) launches Chrome with " +
			"--ignore-certificate-errors and sends Security.setIgnoreCertificateErrors(true), with no supported setting that " +
			"restores HTTPS verification. A browser that holds your logins must verify HTTPS. Upstream: platonai/Browser4#602. " +
			"Use the chromium or chrome-relay engine.",
	},
} as const;

export type RefusedEngine = keyof typeof REFUSED_ENGINES;

export function isRefused(engine: string): engine is RefusedEngine {
	return Object.hasOwn(REFUSED_ENGINES, engine);
}
