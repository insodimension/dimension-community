import type { ViewerKind } from "../../src/contract";
import { RECORDING_SLOT_REFUSAL_FIRST_WORDS } from "../../src/contract";
import { describeMediaError, OPEN_TIMEOUT_SENTENCE } from "./media-messages";

/** Audio and video: played, not shown. */
export const isRecording = (kind: ViewerKind): boolean => kind === "audio" || kind === "video";

/**
 * Where opening a recording failed. `load`: getting the viewer's code for it or reading its bytes (the file changed while
 * it was read, the read itself failed). `open`: the browser's player looking at bytes it has in hand.
 */
export type FailureStage = "load" | "open";

export type RecordingFailure = { readonly where: FailureStage; readonly message: string };

export type FailureAction = "try-again" | "copy-path";

/**
 * The sentences of an `open` failure a second try can fix: the player never answered in time, or said its read of the
 * bytes failed. Taken from the same words the renderer says them with (`media-messages`), not retyped.
 */
const WORTH_ANOTHER_GO: readonly string[] = [OPEN_TIMEOUT_SENTENCE, describeMediaError("video", undefined, true, 2)];

export function failureAction(failure: RecordingFailure): FailureAction {
	if (failure.where === "load") return "try-again";
	return WORTH_ANOTHER_GO.includes(failure.message) ? "try-again" : "copy-path";
}

export function slotRefusalFor(message: string): boolean {
	return message.startsWith(RECORDING_SLOT_REFUSAL_FIRST_WORDS);
}
