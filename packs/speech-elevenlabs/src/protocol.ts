// What goes over the wire to ElevenLabs and what comes back, as pure functions: request
// URLs and bodies, and parsers for the two response shapes. No sockets, no timers.

export const API_HOST = "api.elevenlabs.io";
/** Raw PCM16 little-endian mono: the format the engine's speech runtime plays, no decode step. */
export const OUTPUT_FORMAT = "pcm_24000";
export const SAMPLE_RATE = 24_000;

/** Eleven v3 and v4 are only served by the Text-to-Dialogue socket; the plain TTS socket rejects them. */
const DIALOGUE_MODELS = /^eleven_v[34]/;

export function usesDialogueSocket(model: string): boolean {
	return DIALOGUE_MODELS.test(model);
}

/** Audio tags such as [warmly] are only performed by the Eleven v3/v4 model families. */
export function modelSupportsAudioTags(model: string): boolean {
	return DIALOGUE_MODELS.test(model);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(item => typeof item === "number");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

// ---- Text-to-Dialogue stream-input socket (Eleven v3/v4) --------------------------------------

export function dialogueSocketUrl(model: string): string {
	return `wss://${API_HOST}/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(model)}&output_format=${OUTPUT_FORMAT}&sync_alignment=true`;
}

/** The first frame: registers the one voice this connection speaks with. */
export function dialogueHello(voice: string): Record<string, unknown> {
	return { voices: [voice] };
}

/**
 * One speakable segment. `flush` makes the server generate now instead of waiting for ~40
 * characters, so a short first sentence is audible at once. The trailing space keeps
 * consecutive segments from fusing into one word.
 */
export function dialogueInput(text: string, voice: string): Record<string, unknown> {
	return { inputs: [{ text: `${text} `, voice_id: voice }], flush: true };
}

/** Finish the reply: the server flushes what it holds, then sends `is_final`. */
export const DIALOGUE_CLOSE = { close_socket: true } as const;
/** The socket closes itself after 20 s without a client frame. */
export const DIALOGUE_KEEP_ALIVE = { keep_alive: true } as const;

export interface DialogueChunkAlignment {
	readonly chars: string[];
	readonly startsMs: number[];
	readonly durationsMs: number[];
}

export type DialogueEvent =
	| { readonly kind: "audio"; readonly pcm: Uint8Array; readonly alignment?: DialogueChunkAlignment }
	/** `is_final_audio_for_turn`: the audio for one flushed input is complete. */
	| { readonly kind: "unit-done" }
	/** `is_final`: the reply after `close_socket` is complete. */
	| { readonly kind: "final" }
	| { readonly kind: "error"; readonly message: string };

/** A frame that is none of these (or not JSON) is ignored: the server may add fields. */
export function parseDialogueEvent(raw: string): DialogueEvent | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(data)) return null;
	if (typeof data.error === "string") {
		return { kind: "error", message: typeof data.message === "string" ? data.message : data.error };
	}
	if (data.is_final === true) return { kind: "final" };
	if (data.is_final_audio_for_turn === true) return { kind: "unit-done" };
	if (typeof data.audio !== "string") return null;
	const pcm = Buffer.from(data.audio, "base64");
	const a = data.alignment;
	if (
		isRecord(a) &&
		isStringArray(a.chars) &&
		isNumberArray(a.char_start_times_ms) &&
		isNumberArray(a.char_durations_ms)
	) {
		return {
			kind: "audio",
			pcm,
			alignment: { chars: a.chars, startsMs: a.char_start_times_ms, durationsMs: a.char_durations_ms },
		};
	}
	return { kind: "audio", pcm };
}

// ---- per-segment HTTP stream (every other model) ------------------------------------------------

export function segmentUrl(voice: string): string {
	return `https://${API_HOST}/v1/text-to-speech/${encodeURIComponent(voice)}/stream/with-timestamps?output_format=${OUTPUT_FORMAT}`;
}

export function segmentBody(text: string, model: string): { text: string; model_id: string } {
	return { text, model_id: model };
}

export interface SegmentChunk {
	readonly pcm?: Uint8Array;
	/** Seconds, relative to the start of this segment's own audio. */
	readonly alignment?: { readonly chars: string[]; readonly starts: number[]; readonly ends: number[] };
}

/** One NDJSON line of the with-timestamps stream: audio and alignment ride together. */
export function parseSegmentLine(line: string): SegmentChunk | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const pcm = typeof parsed.audio_base64 === "string" ? Buffer.from(parsed.audio_base64, "base64") : undefined;
	const a = parsed.alignment;
	const alignment =
		isRecord(a) &&
		isStringArray(a.characters) &&
		isNumberArray(a.character_start_times_seconds) &&
		isNumberArray(a.character_end_times_seconds)
			? { chars: a.characters, starts: a.character_start_times_seconds, ends: a.character_end_times_seconds }
			: undefined;
	return { ...(pcm ? { pcm } : {}), ...(alignment ? { alignment } : {}) };
}

// ---- failures -------------------------------------------------------------------------------

/** The sentence a human is shown for a non-2xx answer to a synthesis request. The key is never part of it. */
export function describeHttpFailure(status: number, body: string): string {
	if (status === 401 || status === 403) return "ElevenLabs rejected the API key (it needs the Text to Speech permission)";
	return `ElevenLabs answered ${status}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/**
 * Why a socket that never opened failed, read off the answer to `GET /v1/user`. A key limited to
 * Text to Speech cannot read that endpoint, so a "missing_permissions" answer clears the key of
 * blame rather than convicting it.
 */
export function describeHandshakeFailure(status: number, body: string): string {
	const permissionOnly = body.includes("missing_permissions");
	if ((status === 401 || status === 403) && !permissionOnly) return "ElevenLabs rejected the API key";
	if ((status >= 200 && status < 300) || permissionOnly) {
		return "ElevenLabs refused the voice connection (check the model, the voice id and the key's Text to Speech permission)";
	}
	return `ElevenLabs answered ${status}`;
}
