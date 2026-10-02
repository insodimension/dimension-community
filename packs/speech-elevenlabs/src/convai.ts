// What goes over the wire to ElevenLabs Agents (doc 92 §8): the bodies that provision the one shared
// agent and its one tool, the frames the engine sends on a call, and a parser for the frames that come
// back. Pure functions; no sockets, no timers, no files.
//
// Every fact here was observed against the live API on 2026-10-02 (`.scratch/live-spikes/`):
//   - audio is PCM16 mono, rate read from `conversation_initiation_metadata` (16 kHz both ways)
//   - a field the client SENDS in `conversation_config_override` must be ENABLED on the agent, or the
//     socket closes with code 1008 ("Override for field '<f>' is not allowed by config."); so the agent
//     enables exactly the three fields the engine sends and no more
//   - `client_events` is agent-level and must name `client_tool_call`, `agent_response_correction` and
//     `agent_response_complete` or those frames never arrive
//   - `turn.silence_end_call_timeout` accepts 10 s..2 h and ends a silent call with close code 1000 (observed at
//     10.9 s for a 10 s value); `conversation.max_duration_seconds` accepts 7200
import { isRecord } from "./protocol.js";

export const AGENT_NAME = "dimension-live";
export const TOOL_NAME = "delegate_to_agent";
/** The agent's TTS models. The choice is provisioned on the shared agent (PATCHed when it changes), not overridden per call. */
export const DEFAULT_CONVERSE_MODEL = "eleven_v4_turbo";
export const CONVERSE_MODELS = [DEFAULT_CONVERSE_MODEL, "eleven_v4"] as const;
export const DEFAULT_CONVERSE_VOICE = "EXAVITQu4vr4xnSDxMaL";

/**
 * The agent's LLM, chosen by measurement (2026-10-02, n=3 each, one machine): end of the user's speech to
 * the first agent audio on a chat-plus-repo-request question, and whether it called the delegate tool.
 * claude-haiku-4-5 1.70-1.75 s, delegated 3/3 (the tool call itself lands ~2.6 s, after it has answered
 * the chat half); gemini-3.5-flash-lite 1.66-2.26 s, gemini-3.1-flash-lite 1.70-2.29 s,
 * gpt-4.1-mini 2.18-2.56 s, gpt-5.4-nano 2.45-2.90 s. On an ambiguous request the Gemini lites twice
 * said "I am checking it" WITHOUT calling the tool (a false claim); Haiku, 4.1-mini and nano did not.
 * It takes no `reasoning_effort` (ElevenLabs rejects the field for it). `gemini-2.5-flash-lite`, which the
 * spike used unmeasured, is deprecated by ElevenLabs (provider date 2026-11-30).
 */
export const AGENT_LLM = "claude-haiku-4-5";

/** ElevenLabs' own ceiling for one call. Reaching it ends the call from their side. */
export const MAX_CALL_SECONDS = 7200;
/**
 * Server-side idle backstop: ElevenLabs ends a call after this many seconds without the USER speaking
 * (their field; accepts 10..7200). The engine's own idle hang-up (minutes) acts first; this only
 * catches an engine that died with the socket still open, which is billed per connected second.
 */
export const IDLE_END_CALL_SECONDS = 900;
/**
 * `turn.turn_timeout` is how long ElevenLabs waits for the user before it speaks again on its own (default 7 s:
 * measured, a silent user 8 s into a call got a synthetic "..." user turn and an unprompted "Is there something I can
 * help you with?"). A live call spends minutes silent while the coding agent works, so it is switched off (-1,
 * accepted by the API; verified the agent then stays silent until the idle end).
 */
const NO_REENGAGEMENT = -1;

/** The generic placeholder prompt: the engine supplies the real persona on every call (`agent.prompt.prompt` override). */
const GENERIC_PROMPT = "You are Dimension's live voice. Your instructions are supplied for every conversation.";

const CLIENT_EVENTS = [
	"audio",
	"interruption",
	"agent_response",
	"user_transcript",
	"conversation_initiation_metadata",
	"ping",
	"client_tool_call",
	"agent_response_correction",
	"agent_response_complete",
] as const;

/** The one client tool. `expects_response: false`: the platform answers the model itself, so our result frame is optional. */
export function toolBody(): Record<string, unknown> {
	return {
		tool_config: {
			type: "client",
			name: TOOL_NAME,
			description:
				"Ask the coding agent to do repository work (anything that touches files, code, tools, tests, builds or verification), then keep chatting.",
			parameters: {
				type: "object",
				properties: { task: { type: "string", description: "The complete request, in plain language" } },
				required: ["task"],
			},
			expects_response: false,
		},
	};
}

/**
 * The shared agent. Exactly three fields are overridable per call, and they are exactly the ones
 * {@link initiationFrame} sends: the persona, the (empty) first message and the voice.
 */
export function agentBody(toolId: string, ttsModel: string, voiceId: string): Record<string, unknown> {
	return {
		name: AGENT_NAME,
		conversation_config: {
			agent: {
				first_message: "",
				language: "en",
				prompt: {
					prompt: GENERIC_PROMPT,
					llm: AGENT_LLM,
					tool_ids: [toolId],
				},
			},
			tts: { model_id: ttsModel, voice_id: voiceId },
			turn: { turn_timeout: NO_REENGAGEMENT, silence_end_call_timeout: IDLE_END_CALL_SECONDS },
			conversation: { max_duration_seconds: MAX_CALL_SECONDS, client_events: [...CLIENT_EVENTS] },
		},
		platform_settings: {
			auth: { enable_auth: true },
			overrides: {
				conversation_config_override: {
					agent: { prompt: { prompt: true }, first_message: true },
					tts: { voice_id: true },
				},
			},
		},
	};
}

// ---- frames the engine sends --------------------------------------------------------------------

/** First frame after the socket opens. Sends only fields {@link agentBody} enabled. */
export function initiationFrame(instructions: string, voiceId: string): Record<string, unknown> {
	return {
		type: "conversation_initiation_client_data",
		conversation_config_override: {
			agent: { first_message: "", prompt: { prompt: instructions } },
			tts: { voice_id: voiceId },
		},
	};
}

/** Microphone PCM16 up. Built as text: base64 needs no escaping, and this runs ten times a second. */
export function audioChunkFrame(pcm: Uint8Array): string {
	return `{"user_audio_chunk":"${Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64")}"}`;
}

export function pongFrame(eventId: number): Record<string, unknown> {
	return { type: "pong", event_id: eventId };
}

export function toolResultFrame(toolCallId: string, result: string, isError: boolean): Record<string, unknown> {
	return { type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError };
}

/** A stable `context_id` keeps only the latest progress line: older ones are replaced, not accumulated. */
export const PROGRESS_CONTEXT_ID = "progress";

/** Quiet context: observed to produce no speech in 3/3 tries (doc 92 §8). */
export function progressFrame(text: string): Record<string, unknown> {
	return { type: "contextual_update", text, context_id: PROGRESS_CONTEXT_ID };
}

/** A text turn from the "user". It SPEAKS, and sent mid-speech it cuts the agent off. */
export function userMessageFrame(text: string): Record<string, unknown> {
	return { type: "user_message", text };
}

// ---- frames that come back ----------------------------------------------------------------------

export type AgentFrame =
	| { readonly kind: "metadata"; readonly inputRate: number; readonly outputRate: number }
	| { readonly kind: "audio"; readonly pcm: Uint8Array }
	| { readonly kind: "user"; readonly text: string }
	| { readonly kind: "agent"; readonly text: string; readonly responseId: string | undefined }
	| {
			readonly kind: "correction";
			readonly corrected: string;
			readonly responseId: string | undefined;
	  }
	| { readonly kind: "complete" }
	| { readonly kind: "interruption" }
	| {
			readonly kind: "tool";
			readonly name: string;
			readonly callId: string;
			/** `parameters.task` when it is a non-empty string. */
			readonly task: string | undefined;
	  }
	| { readonly kind: "ping"; readonly eventId: number; readonly delayMs: number }
	| { readonly kind: "error"; readonly message: string };

/** The longest a pong may be delayed on the server's say-so. */
const MAX_PONG_DELAY_MS = 5_000;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `pcm_16000` -> 16000. Anything else (a telephony codec) is not something this relay can play. */
export function pcmRate(format: unknown): number | undefined {
	const match = typeof format === "string" ? /^pcm_(\d{4,6})$/.exec(format) : null;
	return match ? Number(match[1]) : undefined;
}

function errorText(frame: Record<string, unknown>): string {
	const nested = [frame.error_event, frame.client_error_event, frame.error].find(isRecord);
	return (
		str(frame.message) ??
		str(frame.error) ??
		str(frame.detail) ??
		str(nested?.message) ??
		str(nested?.error_type) ??
		"ElevenLabs reported an error"
	).slice(0, 300);
}

/**
 * One text frame from the agent socket, or `null` for what is not one of these (the server may add
 * event types; an unknown one is ignored, never an error).
 */
export function parseAgentFrame(raw: string): AgentFrame | null {
	let frame: unknown;
	try {
		frame = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(frame)) return null;
	switch (frame.type) {
		case "conversation_initiation_metadata": {
			const event = frame.conversation_initiation_metadata_event;
			if (!isRecord(event)) return null;
			const inputRate = pcmRate(event.user_input_audio_format);
			const outputRate = pcmRate(event.agent_output_audio_format);
			if (inputRate === undefined || outputRate === undefined) {
				return {
					kind: "error",
					message: `ElevenLabs offered an audio format this relay cannot carry (in ${String(event.user_input_audio_format)}, out ${String(event.agent_output_audio_format)})`,
				};
			}
			return { kind: "metadata", inputRate, outputRate };
		}
		case "audio": {
			const event = frame.audio_event;
			const data = isRecord(event) ? str(event.audio_base_64) : undefined;
			if (!data) return null;
			const bytes = Buffer.from(data, "base64");
			return { kind: "audio", pcm: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
		}
		case "user_transcript": {
			const event = frame.user_transcription_event;
			const text = isRecord(event) ? str(event.user_transcript) : undefined;
			return text === undefined ? null : { kind: "user", text };
		}
		case "agent_response": {
			const event = frame.agent_response_event;
			if (!isRecord(event)) return null;
			const text = str(event.agent_response);
			return text === undefined ? null : { kind: "agent", text, responseId: str(event.response_id) };
		}
		case "agent_response_correction": {
			const event = frame.agent_response_correction_event;
			if (!isRecord(event)) return null;
			const corrected = str(event.corrected_agent_response);
			return corrected === undefined ? null : { kind: "correction", corrected, responseId: str(event.response_id) };
		}
		case "agent_response_complete":
			return { kind: "complete" };
		case "interruption":
			return { kind: "interruption" };
		case "client_tool_call": {
			const call = frame.client_tool_call;
			if (!isRecord(call)) return null;
			const callId = str(call.tool_call_id);
			if (!callId) return null;
			const task = isRecord(call.parameters) ? str(call.parameters.task)?.trim() : undefined;
			return { kind: "tool", name: str(call.tool_name) ?? "", callId, task: task || undefined };
		}
		case "ping": {
			const event = frame.ping_event;
			if (!isRecord(event) || typeof event.event_id !== "number") return null;
			// `ping_ms` is null on the first ping; answer at once then.
			const delay = typeof event.ping_ms === "number" && Number.isFinite(event.ping_ms) ? event.ping_ms : 0;
			return { kind: "ping", eventId: event.event_id, delayMs: Math.min(Math.max(0, delay), MAX_PONG_DELAY_MS) };
		}
		case "error":
		case "client_error":
			return { kind: "error", message: errorText(frame) };
		default:
			return null;
	}
}
