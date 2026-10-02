// How to WRITE for Eleven v4 and Eleven v4 Turbo: the guide the engine hands the small model that rewrites a reply
// into speech (`SpeechModelInfo.guide`, doc 91 §4). Eleven Flash v2.5 and every other voice get none, and the rewriter
// is then told never to write a bracket.
//
// Written from ElevenLabs' own documentation, read 2026-10-02:
//   Prompting Eleven v4: audio tags, punctuation, tips
//     https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4
//   Eleven v4: variants, tag handling, no SSML, no style or speed sliders
//     https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4
//   The v4 audio tags list: emotion, delivery, pacing and reaction vocabulary; "one tag per clause"; natural-language tags
//     https://elevenlabs.io/blog/elevenlabs-audio-tags-list
//   Text to Dialogue: tags go inside the text of the turn they affect, and the same tags work through the stream API
//     https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue
//   Text to Speech guide: write numbers and symbols out as words
//     https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech
//
// Every tag named below appears in those pages. The count rule (how many per message) is this product's, not
// ElevenLabs': a spoken status line is one to three sentences, so the guide asks for far fewer than a script would carry.
// A tag longer than 60 characters is not recognised by the engine's tag stripper (`vocalizer/tags.ts`), so a fallback
// voice would read it aloud; the guide keeps tags short for that reason too.

export const AUDIO_TAG_GUIDE = `Direct delivery with a short tag in square brackets, placed before the words it changes. The voice performs it and never says it. A tag carries forward until you write another, so add one only where the feeling shifts.

**How many.** Speak plainly by default. At most one tag per sentence; a message of one to three sentences usually needs none or one. Never tag every line.

**Vocabulary.** [warmly] [reassuring] [sympathetic] [thoughtful] [curious] [excited] [amazed] [proud] [playful] [softly] [quietly] [slowly] [rushed] [pause] [sighs] [exhales] [chuckles]. Plain words work too, alone or joined in one bracket: [quiet, thoughtful].

**Writing them.** Describe the voice, not the scene: [low, steady voice], never [smiling] or [standing]. A few words on one line, one tag per clause; opposite tags on the same words blur. Punctuation shapes delivery too: an ellipsis for a pause, a capitalised word for one real emphasis. Write numbers and symbols out as words.

**Avoid.** Sound effects, accents, singing, SSML such as <break>, and tags against the voice's character: a calm voice should not [shout].`;
