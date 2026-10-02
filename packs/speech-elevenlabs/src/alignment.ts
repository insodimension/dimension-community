// Turning ElevenLabs' character alignment into caption words.
// Audio tags like [warmly] are directions to the voice, never caption text.
import type { CaptionWord } from "@dimension/sdk/provider";

const TAG_FIRST = /[A-Za-z]/;
const TAG_REST = /[A-Za-z ,'-]/;
/** Longest tag body (between the brackets) treated as an audio tag. */
const MAX_TAG_BODY = 32;
const TAG_PATTERN = /\s*\[[A-Za-z][A-Za-z ,'-]{0,31}\]\s*/g;

const SECONDS_PER_MS = 0.001;

/** Remove audio tags from text bound for a voice that cannot perform them. */
export function stripAudioTags(text: string): string {
	return text.replace(TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
}

interface TimedChar {
	ch: string;
	s: number;
	e: number;
}

/**
 * Character-level timings → caption words, across as many fragments as the
 * provider splits the alignment into. A word (or a tag) may straddle two
 * fragments, so state carries between {@link push} calls; {@link flush} ends it.
 */
export class WordAssembler {
	#word: { text: string; s: number; e: number } | null = null;
	/** Characters of a possible tag (starting at "[") until it closes or is disproved. */
	#tag: TimedChar[] | null = null;

	/** `starts`/`ends` are absolute seconds on the turn timeline, one per entry of `chars`. */
	push(chars: readonly string[], starts: readonly number[], ends: readonly number[]): CaptionWord[] {
		const out: CaptionWord[] = [];
		const count = Math.min(chars.length, starts.length, ends.length);
		for (let i = 0; i < count; i += 1) {
			const s = starts[i]!;
			const e = ends[i]!;
			// An entry is normally one character; expand defensively so tag and
			// whitespace detection never sees a multi-character string.
			for (const ch of chars[i]!) this.#consume({ ch, s, e }, out);
		}
		return out;
	}

	/** Emit the word still open at the end of a text unit. */
	flush(): CaptionWord[] {
		const out: CaptionWord[] = [];
		this.#abandonTag(out);
		this.#finish(out);
		return out;
	}

	#consume(entry: TimedChar, out: CaptionWord[]): void {
		const tag = this.#tag;
		if (tag === null) {
			if (entry.ch === "[") this.#tag = [entry];
			else this.#literal(entry, out);
			return;
		}
		if (entry.ch === "]" && tag.length > 1) {
			this.#tag = null;
			return;
		}
		const body = tag.length - 1;
		const accepted = body === 0 ? TAG_FIRST.test(entry.ch) : TAG_REST.test(entry.ch) && body < MAX_TAG_BODY;
		if (accepted) {
			tag.push(entry);
			return;
		}
		// Not a tag after all ("[0]", "a[", an unterminated bracket): it was text.
		this.#abandonTag(out);
		this.#consume(entry, out);
	}

	#abandonTag(out: CaptionWord[]): void {
		const tag = this.#tag;
		if (tag === null) return;
		this.#tag = null;
		for (const entry of tag) this.#literal(entry, out);
	}

	#literal(entry: TimedChar, out: CaptionWord[]): void {
		if (/\s/.test(entry.ch)) {
			this.#finish(out);
			return;
		}
		const word = this.#word;
		if (word === null) this.#word = { text: entry.ch, s: entry.s, e: entry.e };
		else {
			word.text += entry.ch;
			word.e = entry.e;
		}
	}

	#finish(out: CaptionWord[]): void {
		const word = this.#word;
		if (word === null) return;
		this.#word = null;
		const end = Math.max(word.e, word.s);
		out.push({ w: word.text, s: Math.round(word.s * 1000) / 1000, e: Math.round(end * 1000) / 1000 });
	}
}

export interface DialogueAlignment {
	chars: readonly string[];
	startsMs: readonly number[];
	durationsMs: readonly number[];
}

/**
 * ElevenLabs Text-to-Dialogue alignment. Audio and alignment arrive in
 * separate pieces: each alignment fragment covers the text since the previous
 * fragment and its times restart at 0. A fragment therefore begins where the
 * audio delivered up to the previous fragment ended; anchoring to the audio
 * actually received keeps the words locked to the samples with no drift.
 */
export class DialogueTimeline {
	#audioSeconds = 0;
	#anchor = 0;
	readonly #words = new WordAssembler();

	/** Account for PCM16 audio received at `sampleRate`. */
	audio(bytes: number, sampleRate: number): void {
		this.#audioSeconds += bytes / 2 / sampleRate;
	}

	/** Call after {@link audio} for the same message. */
	alignment(fragment: DialogueAlignment): CaptionWord[] {
		const base = this.#anchor;
		const starts = fragment.startsMs.map(ms => base + ms * SECONDS_PER_MS);
		const ends = fragment.startsMs.map((ms, i) => base + (ms + (fragment.durationsMs[i] ?? 0)) * SECONDS_PER_MS);
		this.#anchor = this.#audioSeconds;
		return this.#words.push(fragment.chars, starts, ends);
	}

	/**
	 * A text unit ended (the provider said its audio is complete): close the open word, and start
	 * the next unit where every sample delivered so far ended, including audio that arrived after
	 * the unit's last alignment fragment.
	 */
	flush(): CaptionWord[] {
		this.#anchor = this.#audioSeconds;
		return this.#words.flush();
	}
}
