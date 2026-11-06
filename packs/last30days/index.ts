import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import {
	type DoctorReport,
	engineConfigDir,
	pythonInstallHint,
	type ResolvedPython,
	readConnectorKeys,
	resolvePython,
	runHidden,
	summarizeDoctor,
	writeEngineConfig,
} from "./setup.js";

const ENGINE = fileURLToPath(new URL("./skills/last30days/scripts/last30days.py", import.meta.url));
const DOCTOR_TIMEOUT_MS = 90_000;
const CREDIT_BALANCE_URL = "https://api.scrapecreators.com/v1/credit/balance";
const CREDIT_TIMEOUT_MS = 10_000;
const SCRAPECREATORS_OFFER =
	"not connected, so TikTok and Instagram are not covered. ScrapeCreators is a paid third-party API (10,000 free calls, then pay-as-you-go) that adds TikTok, Instagram and Reddit/YouTube backfill: Capabilities, last30days, Connect, ScrapeCreators";

let resolvedPython: ResolvedPython | null = null;

async function scrapeCreatorsBalance(key: string): Promise<string> {
	try {
		const response = await fetch(CREDIT_BALANCE_URL, {
			headers: { "x-api-key": key },
			signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
		});
		if (!response.ok) return `connected, but ScrapeCreators refused the key (HTTP ${response.status}); reconnect it`;
		const body = (await response.json()) as Record<string, unknown>;
		const credits = Object.entries(body).find(([key, value]) => /credit/i.test(key) && typeof value === "number");
		return credits ? `connected, ${credits[1]} credits left` : "connected, key accepted";
	} catch {
		return "connected; the credit balance could not be read right now";
	}
}

async function doctorLines(python: ResolvedPython): Promise<string[]> {
	const result = await runHidden(python.path, [ENGINE, "doctor", "--json", "--cached"], {
		timeoutMs: DOCTOR_TIMEOUT_MS,
	});
	try {
		return summarizeDoctor(JSON.parse(result.stdout) as DoctorReport);
	} catch {
		return [
			`The source check failed (exit ${result.code ?? "killed"}): ${result.stderr.trim().slice(-400) || "no output"}`,
		];
	}
}

const setupSchema = type({});

function createSetupTool(): ToolDefinition<typeof setupSchema> {
	return {
		name: "last30days_setup",
		label: "last30days: Setup",
		description:
			"Set up and check last30days the Dimension way, instead of its own setup wizard: finds a real Python 3.12+ (never the Windows Store alias; installs a managed one through uv when uv is present), checks yt-dlp, marks setup complete with browser-cookie reading OFF, copies the ScrapeCreators and Bluesky keys connected on the last30days card into its config, and reports which sources are live. Call it once per session before the first last30days run, and after the person connects or removes a key.",
		parameters: setupSchema,
		approval: "write" as const,
		async execute() {
			const python = resolvedPython ?? (await resolvePython(runHidden, name => Bun.which(name)));
			if (!python) {
				return {
					content: [
						{
							type: "text" as const,
							text: `last30days needs Python 3.12 or newer and none was found (the Windows Store alias does not count). Ask the person before installing, then run: ${pythonInstallHint(process.platform)} and call last30days_setup again. Until then last30days cannot run; research with the Reddit, YouTube and X plugins directly and say last30days was unavailable.`,
						},
					],
				};
			}
			resolvedPython = python;
			const configDir = engineConfigDir();
			const keys = await readConnectorKeys();
			const config = configDir ? await writeEngineConfig(configDir, keys) : null;
			const ytDlp = Bun.which("yt-dlp");
			const lines = [
				`Python: ${python.version} at ${python.path}`,
				`yt-dlp: ${ytDlp ?? "missing, so YouTube is not covered (Capabilities, last30days, Connect, Install)"}`,
				config
					? `Config: ${config.path} (setup complete, browser cookies off: last30days never reads them; X comes from the X plugin)`
					: "Config: LAST30DAYS_CONFIG_DIR is empty, so last30days runs without a config file",
				`ScrapeCreators: ${keys.scrapecreators ? await scrapeCreatorsBalance(keys.scrapecreators) : SCRAPECREATORS_OFFER}`,
				`Bluesky: ${keys.bluesky ? `connected as @${keys.bluesky.handle}` : "not connected (optional: Capabilities, last30days, Connect, Bluesky)"}`,
				...(config?.removed.length
					? [`Removed from last30days' config after disconnect: ${config.removed.join(", ")}`]
					: []),
				"",
				"Sources:",
				...(await doctorLines(python)),
				"",
				`Begin every engine command with: LAST30DAYS_PYTHON="${python.path}"`,
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

export default function last30daysExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSetupTool());
}
