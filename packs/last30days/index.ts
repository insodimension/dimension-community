import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import {
	classifyDoctor,
	type DoctorReport,
	engineConfigDir,
	environmentWarnings,
	pythonInstallHint,
	type ResolvedPython,
	readConnectorKeys,
	renderDoctor,
	resolvePython,
	runHidden,
	writeEngineConfig,
} from "./setup.js";

const RUNNER = fileURLToPath(new URL("./run.py", import.meta.url));
const DOCTOR_TIMEOUT_MS = 90_000;
const CREDIT_BALANCE_URL = "https://api.scrapecreators.com/v1/credit/balance";
const CREDIT_TIMEOUT_MS = 10_000;
const SCRAPECREATORS_OFFER =
	"not connected, so TikTok and Instagram are not covered. ScrapeCreators is a paid third-party API (10,000 free calls, then pay-as-you-go) that adds TikTok, Instagram and Reddit/YouTube backfill: Capabilities, last30days, Connect, ScrapeCreators";

let resolvedPython: ResolvedPython | null = null;

async function scrapeCreatorsBalance(): Promise<string> {
	try {
		const stored = JSON.parse(
			await readFile(join(homedir(), ".config", "dimension-last30days", "scrapecreators.json"), "utf-8"),
		) as { access?: string };
		const response = await fetch(CREDIT_BALANCE_URL, {
			headers: { "x-api-key": stored.access ?? "" },
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
	const result = await runHidden(python.path, [RUNNER, "doctor", "--json"], { timeoutMs: DOCTOR_TIMEOUT_MS });
	try {
		return renderDoctor(classifyDoctor(JSON.parse(result.stdout) as DoctorReport));
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
			"Set up and check last30days the Dimension way, instead of its own setup wizard: finds a real Python 3.12+ (never the Windows Store alias), checks yt-dlp, marks setup complete with browser-cookie reading OFF, checks the ScrapeCreators and Bluesky keys connected on the last30days card, reports which sources are live, and returns the command every engine run must start with. Call it once per session before the first last30days run, and after the person connects or removes a key.",
		parameters: setupSchema,
		approval: "write" as const,
		async execute() {
			const python = resolvedPython ?? (await resolvePython(runHidden, name => Bun.which(name)));
			if (!python) {
				const hint = pythonInstallHint(process.platform, Bun.which("uv") !== null);
				return {
					content: [
						{
							type: "text" as const,
							text: `last30days needs Python 3.12 or newer and none was found (the Windows Store alias does not count). Ask the person before installing; on their yes run: ${hint} and call last30days_setup again. Until then last30days cannot run; research with the Reddit, YouTube and X plugins directly and say last30days was unavailable.`,
						},
					],
				};
			}
			resolvedPython = python;
			const configDir = engineConfigDir();
			const config = configDir ? await writeEngineConfig(configDir) : null;
			const keys = await readConnectorKeys();
			const [balance, sources] = await Promise.all([
				keys.scrapecreators ? scrapeCreatorsBalance() : Promise.resolve(SCRAPECREATORS_OFFER),
				doctorLines(python),
			]);
			const warnings = environmentWarnings(process.env);
			const lines = [
				`Python: ${python.version} at ${python.path}`,
				`yt-dlp: ${Bun.which("yt-dlp") ?? "missing, so YouTube is not covered (Capabilities, last30days, Connect, Install)"}`,
				config
					? `Config: ${config.path} (setup complete, browser cookies off, project config untrusted; keys are not stored here)`
					: "Config: no config file is read",
				`ScrapeCreators: ${balance}`,
				`Bluesky: ${keys.bluesky ? `connected as @${keys.bluesky}` : "not connected (optional: Capabilities, last30days, Connect, Bluesky)"}`,
				...keys.refused.map(
					field =>
						`Refused: the ${field} on the last30days card has characters outside printable ASCII; reconnect it`,
				),
				...(config?.removed.length
					? [`Removed key copies from the engine's config: ${config.removed.join(", ")}`]
					: []),
				...warnings.map(
					warning => `Warning: ${warning}; the engine runner overrides it, but check where it comes from`,
				),
				"",
				"Sources:",
				...sources,
				"",
				"Run every engine command (research, doctor, library) as:",
				`  "${python.path}" "${RUNNER}" <the arguments the skill gives scripts/last30days.py>`,
				"never scripts/last30days.py directly: the runner supplies the card's keys for that run only, forces browser cookies off and adds --no-browser-cookies.",
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

export default function last30daysExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSetupTool());
}
