// Google Meet LIVE tools — spawn/observe the detached caption-scraper bot
// (bot/meet-bot.ts) and read its files. The agent process NEVER blocks on the
// bot: all coordination is filesystem-only (`.active.json` pointer + per-meeting
// status.json / transcript.txt), mirroring Hermes' process_manager.py.
//
// ---------------------------------------------------------------------------
// TRANSCRIBE-ONLY — non-goal (deliberate)
// ---------------------------------------------------------------------------
// This bot LISTENS via Meet's own live captions. It cannot speak, stream audio,
// or "be a voice in the call" — that (Hermes v2 "realtime" mode) needs a
// virtual-audio device + a realtime voice model and is a documented FUTURE
// capability, deliberately not built here. There is NO auto-consent
// announcement: the agent using these tools is responsible for announcing its
// presence and honoring recording-consent norms/laws for the meeting.
// ---------------------------------------------------------------------------
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { MEET_URL_RE, meetingIdFromUrl } from "./bot/meet-url";

const CONFIG_ROOT = join(homedir(), ".config", "dimension-google-meet");
const MEETINGS_DIR = join(CONFIG_ROOT, "meetings");
const ACTIVE_FILE = join(MEETINGS_DIR, ".active.json");
// Resolve the standalone bot relative to THIS module so it works from any cwd.
const BOT_SCRIPT = join(import.meta.dir, "bot", "meet-bot.ts");

interface ActiveRecord {
	pid: number;
	meetingId: string;
	outDir: string;
	url: string;
	startedAt: number;
	logPath: string;
}

interface BotStatus {
	meetingId?: string;
	url?: string;
	inCall?: boolean;
	lobbyWaiting?: boolean;
	captioning?: boolean;
	captionsEnabledAttempted?: boolean;
	joinAttemptedAt?: number | null;
	joinedAt?: number | null;
	lastCaptionAt?: number | null;
	transcriptLines?: number;
	transcriptPath?: string;
	error?: string | null;
	exited?: boolean;
	pid?: number;
	leaveReason?: string | null;
}

// ---------------------------------------------------------------------------
// Active-pointer + process helpers (cross-platform)
// ---------------------------------------------------------------------------

function readActive(): ActiveRecord | null {
	if (!existsSync(ACTIVE_FILE)) return null;
	try {
		return JSON.parse(readFileSync(ACTIVE_FILE, "utf8")) as ActiveRecord;
	} catch {
		return null;
	}
}

function writeActive(rec: ActiveRecord): void {
	mkdirSync(MEETINGS_DIR, { recursive: true });
	const tmp = `${ACTIVE_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
	// Atomic replace — renameSync overwrites an existing file on POSIX and Windows.
	renameSync(tmp, ACTIVE_FILE);
}

function clearActive(): void {
	try {
		rmSync(ACTIVE_FILE, { force: true });
	} catch {
		// already gone
	}
}

/** Cross-platform liveness check. `process.kill(pid, 0)` sends no signal; it
 *  throws ESRCH when the pid is dead and EPERM when it's alive but unsignalable. */
function pidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Signal a pid, swallowing "already gone". Works on Windows (SIGTERM →
 *  TerminateProcess) and POSIX alike via Bun/Node's `process.kill`. */
function signalPid(pid: number, sig: NodeJS.Signals): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, sig);
		return true;
	} catch {
		return false;
	}
}

function readStatus(outDir: string): BotStatus | null {
	const p = join(outDir, "status.json");
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as BotStatus;
	} catch {
		return null;
	}
}

/** SIGTERM the active bot, escalating to SIGKILL after ~10s, then clear the
 *  pointer. Returns the record it acted on (for the final transcript path). */
async function stopActive(): Promise<ActiveRecord | null> {
	const active = readActive();
	if (!active) return null;
	const pid = Number(active.pid) || 0;
	if (pid && pidAlive(pid)) {
		signalPid(pid, "SIGTERM");
		// Wait up to ~10s for a clean leave (transcript finalized), then hard-kill.
		for (let i = 0; i < 20; i++) {
			if (!pidAlive(pid)) break;
			await Bun.sleep(500);
		}
		if (pidAlive(pid)) signalPid(pid, "SIGKILL");
	}
	clearActive();
	return active;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const joinSchema = type({
	url: type("string").describe(
		"The meeting URL, e.g. https://meet.google.com/abc-defg-hij. Only meet.google.com URLs are accepted.",
	),
	"guestName?": type("string").describe('Display name shown in the call. Defaults to "Dimension Agent".'),
	"duration?": type("string").describe(
		'Auto-leave after this long, e.g. "30m", "90s", "2h". Omit to stay until you leave.',
	),
	"headed?": type("boolean").describe("Launch a VISIBLE browser (debugging). Defaults to headless."),
});

const liveStatusSchema = type({});

const liveTranscriptSchema = type({
	"last?": type("number").describe("Return only the last N non-empty transcript lines. Omit for the full transcript."),
});

const leaveSchema = type({});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function createJoinTool(): ToolDefinition<typeof joinSchema> {
	return {
		name: "google_meet_join",
		label: "Google Meet: Join & Transcribe",
		description:
			"Join a Google Meet call in a headless browser and live-transcribe it via Meet's own captions. Spawns a " +
			"detached background bot and returns immediately — poll google_meet_live_status for join/lobby/caption " +
			"progress and google_meet_live_transcript for the text. LISTEN-ONLY: the bot cannot speak. There is NO " +
			"automatic 'this call is being transcribed' announcement — you MUST announce your presence and honor the " +
			"meeting's recording-consent rules. Single active meeting: joining a new call leaves the current one first.",
		parameters: joinSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof joinSchema.infer) {
			const url = params.url.trim();
			if (!MEET_URL_RE.test(url)) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Refusing: only https://meet.google.com/ URLs are allowed. Got: ${JSON.stringify(url)}`,
						},
					],
				};
			}

			// Single-active-meeting: leave any live bot before starting a new one.
			const existing = readActive();
			if (existing && pidAlive(Number(existing.pid) || 0)) {
				await stopActive();
			}

			const meetingId = meetingIdFromUrl(url);
			const outDir = join(MEETINGS_DIR, meetingId);
			mkdirSync(outDir, { recursive: true });
			// Wipe stale transcript/status so polling isn't confused by a prior run.
			for (const name of ["transcript.txt", "status.json"]) {
				rmSync(join(outDir, name), { force: true });
			}

			const logPath = join(outDir, "bot.log");
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				MEET_URL: url,
				MEET_OUT_DIR: outDir,
				MEET_GUEST_NAME: params.guestName?.trim() || "Dimension Agent",
			};
			if (params.duration) env.MEET_DURATION = params.duration.trim();
			if (params.headed) env.MEET_HEADED = "1";

			// Detached spawn: stdout+stderr → bot.log (fd owned by the child after
			// spawn, so we close our copy), detached so it outlives this agent turn.
			const logFd = openSync(logPath, "a");
			let pid: number;
			try {
				const proc = Bun.spawn(["bun", BOT_SCRIPT], {
					env,
					stdin: "ignore",
					stdout: logFd,
					stderr: logFd,
					detached: process.platform !== "win32",
					windowsHide: true,
				});
				proc.unref();
				pid = proc.pid;
			} finally {
				// The child holds its own fd now; drop ours so the log isn't pinned open.
				try {
					closeSync(logFd);
				} catch {
					// fd already closed
				}
			}

			const record: ActiveRecord = { pid, meetingId, outDir, url, startedAt: Date.now(), logPath };
			writeActive(record);

			const text = [
				`Joining ${url} as "${env.MEET_GUEST_NAME}" (bot pid ${pid}, meeting ${meetingId}).`,
				params.duration
					? `Auto-leaving after ${params.duration.trim()}.`
					: "Stays until you call google_meet_leave.",
				"",
				"The bot is now connecting in the background. Poll google_meet_live_status for join/lobby/caption",
				"progress and google_meet_live_transcript for captured text.",
				"",
				"REMINDER: there is NO automatic announcement that this call is being transcribed — announce your",
				"presence in the meeting and honor its recording-consent rules yourself.",
			].join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createLiveStatusTool(): ToolDefinition<typeof liveStatusSchema> {
	return {
		name: "google_meet_live_status",
		label: "Google Meet: Live Status",
		description:
			"Report the current live-transcription bot's state: whether the bot process is alive, whether it has joined " +
			"or is waiting in the lobby, whether captioning is active, how many transcript lines were captured, and any error.",
		parameters: liveStatusSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, _params: typeof liveStatusSchema.infer) {
			const active = readActive();
			if (!active) {
				return { content: [{ type: "text" as const, text: "No active meeting." }] };
			}
			const alive = pidAlive(Number(active.pid) || 0);
			const status = readStatus(active.outDir);

			const lines: string[] = [
				`Meeting: ${active.meetingId}  (${active.url})`,
				`Bot pid ${active.pid} — ${alive ? "alive" : "not running"}`,
				`Started: ${new Date(active.startedAt).toLocaleString()}`,
			];
			if (status) {
				const phase = status.error
					? `error: ${status.error}`
					: status.exited
						? `exited${status.leaveReason ? ` (${status.leaveReason})` : ""}`
						: status.inCall
							? "in call"
							: status.lobbyWaiting
								? "waiting in lobby for host admission"
								: "connecting";
				lines.push(`State: ${phase}`);
				lines.push(
					`Captioning: ${status.captioning ? "on" : "off"}  ·  Transcript lines: ${status.transcriptLines ?? 0}`,
				);
				if (status.joinedAt) lines.push(`Joined at: ${new Date(status.joinedAt).toLocaleString()}`);
				if (status.lastCaptionAt) lines.push(`Last caption: ${new Date(status.lastCaptionAt).toLocaleString()}`);
				if (status.transcriptPath) lines.push(`Transcript file: ${status.transcriptPath}`);
			} else {
				lines.push("State: starting up (no status file yet).");
			}
			if (!alive && !status?.exited) {
				lines.push("(Bot process is gone but did not report a clean exit — it may have crashed; check bot.log.)");
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createLiveTranscriptTool(): ToolDefinition<typeof liveTranscriptSchema> {
	return {
		name: "google_meet_live_transcript",
		label: "Google Meet: Live Transcript",
		description:
			"Read the live transcript captured so far by the transcription bot (from Meet's live captions). Returns all " +
			"lines, or the last N when `last` is given. Each line is `[HH:MM:SS] Speaker: text`.",
		parameters: liveTranscriptSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof liveTranscriptSchema.infer) {
			const active = readActive();
			if (!active) {
				return { content: [{ type: "text" as const, text: "No active meeting." }] };
			}
			const transcriptPath = join(active.outDir, "transcript.txt");
			if (!existsSync(transcriptPath)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No transcript yet for ${active.meetingId} (nobody has spoken with captions on).`,
						},
					],
				};
			}
			const raw = readFileSync(transcriptPath, "utf8");
			const allLines = raw.split("\n").filter(l => l.trim().length > 0);
			const total = allLines.length;
			const last = params.last && params.last > 0 ? Math.floor(params.last) : undefined;
			const shown = last ? allLines.slice(-last) : allLines;
			const header =
				total === 0
					? `Transcript for ${active.meetingId} is empty so far.`
					: last && total > shown.length
						? `Transcript for ${active.meetingId} — last ${shown.length} of ${total} lines:`
						: `Transcript for ${active.meetingId} — ${total} lines:`;
			const text = total === 0 ? header : `${header}\n${shown.join("\n")}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createLeaveTool(): ToolDefinition<typeof leaveSchema> {
	return {
		name: "google_meet_leave",
		label: "Google Meet: Leave",
		description:
			"Leave the current Meet call and stop the transcription bot (SIGTERM, then SIGKILL after ~10s if needed), " +
			"then clear the active pointer. Returns the path to the finalized transcript.",
		parameters: leaveSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, _params: typeof leaveSchema.infer) {
			const active = readActive();
			if (!active) {
				return { content: [{ type: "text" as const, text: "No active meeting to leave." }] };
			}
			const stopped = await stopActive();
			const rec = stopped ?? active;
			const transcriptPath = join(rec.outDir, "transcript.txt");
			const status = readStatus(rec.outDir);
			const lineCount =
				status?.transcriptLines ??
				(existsSync(transcriptPath)
					? readFileSync(transcriptPath, "utf8")
							.split("\n")
							.filter(l => l.trim().length > 0).length
					: 0);
			const text = [
				`Left ${rec.meetingId} and stopped the transcription bot (pid ${rec.pid}).`,
				`Transcript (${lineCount} lines): ${existsSync(transcriptPath) ? transcriptPath : "(none captured)"}`,
			].join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

export function createMeetLiveTools(): ToolDefinition<any>[] {
	return [createJoinTool(), createLiveStatusTool(), createLiveTranscriptTool(), createLeaveTool()];
}
