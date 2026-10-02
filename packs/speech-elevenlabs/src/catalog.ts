// What the picker offers: the models, a curated voice list that works with no key, and — when a
// key exists — the account's own voices. The catalog is a suggestion (`freeFormVoice`): any
// voice id ElevenLabs knows is accepted.
import type { SpeechModelInfo, SpeechProviderCatalog, SpeechVoiceInfo } from "@dimension/sdk/provider";
import { DEFAULT_CONVERSE_MODEL } from "./convai.js";
import { AUDIO_TAG_GUIDE } from "./guide.js";
import { API_HOST, describeHttpFailure, isRecord, modelSupportsAudioTags } from "./protocol.js";

export const DEFAULT_MODEL = "eleven_v4_turbo";

const MODELS: readonly Omit<SpeechModelInfo, "voices">[] = [
	{
		id: DEFAULT_MODEL,
		label: "Eleven v4 Turbo",
		description: "The default. Streams over one live connection and understands audio tags like [warmly].",
		guide: AUDIO_TAG_GUIDE,
	},
	{
		id: "eleven_v4",
		label: "Eleven v4",
		description: "The full v4 model. Streams over one live connection and understands audio tags like [warmly].",
		guide: AUDIO_TAG_GUIDE,
	},
	{
		id: "eleven_flash_v2_5",
		label: "Eleven Flash v2.5",
		description: "Built for low latency. Speaks one sentence per request; audio tags are dropped, not performed.",
	},
];

/** The voice model of the live agent (`converse`): it talks with you and hands repository work to your coding agent. */
const CONVERSE_MODELS_INFO: readonly Omit<SpeechModelInfo, "voices">[] = [
	{
		id: DEFAULT_CONVERSE_MODEL,
		label: "Eleven v4 Turbo (live agent)",
		description: "The default. The live agent's voice, tuned for fast replies.",
	},
	{
		id: "eleven_v4",
		label: "Eleven v4 (live agent)",
		description: "The full Eleven v4 model as the live agent's voice.",
	},
];

/** Premade voices every ElevenLabs account has, so a profile works before the account list loads. */
export const DEFAULT_VOICES: readonly SpeechVoiceInfo[] = [
	{ id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah - Mature, Reassuring, Confident" },
	{ id: "CwhRBWXzGAHq8TQ4Fs17", label: "Roger - Laid-Back, Casual, Resonant" },
	{ id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura - Enthusiast, Quirky Attitude" },
	{ id: "IKne3meq5aSn9XLyUdCD", label: "Charlie - Deep, Confident, Energetic" },
	{ id: "JBFqnCBsd6RMkjVDRZzb", label: "George - Warm, Captivating Storyteller" },
];

/** The curated voices first, then whatever else the account holds; an id appears once. */
export function buildCatalog(accountVoices: readonly SpeechVoiceInfo[]): SpeechProviderCatalog {
	const seen = new Set(DEFAULT_VOICES.map(voice => voice.id));
	const voices = [...DEFAULT_VOICES, ...accountVoices.filter(voice => !seen.has(voice.id))];
	return {
		// The same rule openSpeak applies when it decides whether tags reach the voice.
		speak: MODELS.map(model => ({ ...model, audioTags: modelSupportsAudioTags(model.id), voices })),
		converse: CONVERSE_MODELS_INFO.map(model => ({ ...model, voices })),
		// The engine holds the agent socket and carries the PCM: the client builds no WebRTC call.
		converseMedia: "relay",
		freeFormVoice: true,
		audioTags: true,
	};
}

const VOICES_TIMEOUT_MS = 5_000;

/** `GET /v1/voices`, reduced to what a picker needs. Voices you made or cloned say so in their label. */
async function fetchAccountVoices(apiKey: string, doFetch: typeof fetch): Promise<SpeechVoiceInfo[]> {
	const res = await doFetch(`https://${API_HOST}/v1/voices`, {
		headers: { "xi-api-key": apiKey },
		signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(describeHttpFailure(res.status, ""));
	const body: unknown = await res.json();
	if (!isRecord(body) || !Array.isArray(body.voices)) return [];
	const voices: SpeechVoiceInfo[] = [];
	for (const voice of body.voices) {
		if (!isRecord(voice) || typeof voice.voice_id !== "string" || typeof voice.name !== "string") continue;
		const own = typeof voice.category === "string" && voice.category !== "premade" ? ` (${voice.category})` : "";
		voices.push({ id: voice.voice_id, label: `${voice.name}${own}` });
	}
	return voices;
}

const VOICES_TTL_MS = 5 * 60_000;
/** A failed lookup (a key without the voices permission, a network blip) is not retried on every picker open. */
const VOICES_FAILURE_TTL_MS = 30_000;

/** The account's voices for one key, fetched once per {@link VOICES_TTL_MS}. Never throws: a failure is an empty list. */
export class AccountVoices {
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#entry: { readonly key: string; expires: number; readonly voices: Promise<SpeechVoiceInfo[]> } | null = null;

	constructor(doFetch: typeof fetch, now: () => number = Date.now) {
		this.#fetch = doFetch;
		this.#now = now;
	}

	get(apiKey: string): Promise<SpeechVoiceInfo[]> {
		const current = this.#entry;
		if (current && current.key === apiKey && this.#now() < current.expires) return current.voices;
		const entry = {
			key: apiKey,
			expires: this.#now() + VOICES_TTL_MS,
			voices: fetchAccountVoices(apiKey, this.#fetch).catch(() => {
				entry.expires = this.#now() + VOICES_FAILURE_TTL_MS;
				return [];
			}),
		};
		this.#entry = entry;
		return entry.voices;
	}
}
