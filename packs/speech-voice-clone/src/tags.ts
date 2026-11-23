import type { CaptionWord } from "@dimension/sdk/provider";
import type { TagStyle } from "./registry.js";

const AUDIO_TAG = /\s*\[[A-Za-z][A-Za-z ,'-]{0,31}\]\s*/g;
const BREEZE_EVENT = /\s*\((?:laugh|sigh|cough|clears throat)\)\s*/gi;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu;

const BREEZE_EVENTS: Readonly<Record<string, string>> = {
	laugh: "(laugh)",
	laughs: "(laugh)",
	laughing: "(laugh)",
	chuckles: "(laugh)",
	sigh: "(sigh)",
	sighs: "(sigh)",
	cough: "(cough)",
	coughs: "(cough)",
	"clears throat": "(clears throat)",
};

const SPACE_BEFORE_PUNCTUATION = /\s+([.,!?;:…])/g;

export function captionText(text: string): string {
	return text
		.replace(AUDIO_TAG, " ")
		.replace(BREEZE_EVENT, " ")
		.replace(EMOJI, "")
		.replace(/\s+/g, " ")
		.replace(SPACE_BEFORE_PUNCTUATION, "$1")
		.trim();
}

export function voiceText(text: string, style: TagStyle, tagsAllowed: boolean): string {
	const withoutEmoji = text.replace(EMOJI, "");
	if (!tagsAllowed || style === "none") return captionText(withoutEmoji);
	if (style === "brackets") return withoutEmoji.replace(/\s+/g, " ").trim();
	return withoutEmoji
		.replace(AUDIO_TAG, tag => {
			const event = BREEZE_EVENTS[tag.trim().slice(1, -1).trim().toLowerCase()];
			return event ? ` ${event} ` : " ";
		})
		.replace(/\s+/g, " ")
		.replace(SPACE_BEFORE_PUNCTUATION, "$1")
		.trim();
}

function pauseWeight(token: string): number {
	if (/[.!?…]["')\]]*$/.test(token)) return 4;
	if (/[,;:—–]["')\]]*$/.test(token)) return 2;
	return 0;
}

export function estimateWords(text: string, startSeconds: number, durationSeconds: number): CaptionWord[] {
	const tokens = captionText(text).split(" ").filter(Boolean);
	if (tokens.length === 0) return [];
	const weights = tokens.map(token => token.length + pauseWeight(token));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const words: CaptionWord[] = [];
	let cursor = startSeconds;
	tokens.forEach((token, index) => {
		const end = cursor + ((weights[index] ?? 0) / total) * durationSeconds;
		words.push({ w: token, s: Math.round(cursor * 1000) / 1000, e: Math.round(end * 1000) / 1000 });
		cursor = end;
	});
	return words;
}

export const BRACKET_GUIDE = `Direct delivery with a short direction in square brackets, placed before the words it changes. The voice performs it and never says it.

**How many.** Speak plainly by default. At most one direction per sentence; a message of one to three sentences usually needs none or one.

**Vocabulary.** Any short plain-English direction works: [whisper] [softly] [excited] [sarcastic] [deadpan] [sad] [angry] [laughing] [sigh] [pause] [emphasis]. Join two in one bracket when they go together: [quiet, amused].

**Avoid.** Long stage directions, sound effects, accents, singing, and SSML.`;

export const BREEZE_GUIDE = `This voice performs four sounds and nothing else. Write one in square brackets where it happens: [laughs], [sighs], [coughs] or [clears throat]. Any other bracket is dropped, never spoken.

**How many.** Speak plainly by default; at most one sound in a short message, and only where a person would really make it.`;

export function guideFor(style: TagStyle): string | undefined {
	if (style === "brackets") return BRACKET_GUIDE;
	if (style === "breeze") return BREEZE_GUIDE;
	return undefined;
}
