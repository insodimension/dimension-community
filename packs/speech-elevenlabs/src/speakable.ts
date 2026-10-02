// What may be sent to ElevenLabs as one segment. The service refuses (and, on the dialogue
// socket, ends the whole reply for) an input that is empty once audio tags and emojis are
// removed, so a bare "[laughs]" or "🙂" must never be sent on its own.
import { stripAudioTags } from "./alignment.js";

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu;

function hasSpeakableText(text: string): boolean {
	return stripAudioTags(text).replace(EMOJI, "").trim() !== "";
}

/** Turns pushed segments into the text a voice is sent, one call per segment, in order. */
export class SpeakableText {
	readonly #tags: boolean;
	/** Directions with nothing to say yet: they lead the next segment instead of being lost. */
	#held = "";

	/** `tags`: audio tags reach the voice; otherwise they are removed. */
	constructor(tags: boolean) {
		this.#tags = tags;
	}

	/** The text to send for `segment`, or null when there is nothing speakable to send yet. */
	next(segment: string): string | null {
		const trimmed = segment.trim();
		const text = this.#tags ? (this.#held ? `${this.#held} ${trimmed}` : trimmed) : stripAudioTags(trimmed);
		if (!hasSpeakableText(text)) {
			if (this.#tags) this.#held = text.replace(EMOJI, "").trim();
			return null;
		}
		this.#held = "";
		return text;
	}
}
