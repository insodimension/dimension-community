// Pure surface logic: what the voice conversation's state means on screen, and the two navigation rules
// (Back and Esc). No React, no DOM, no audio: the component draws what this returns.
import type { FaceState } from "../face/animator";
import { micSilentNotice } from "./mic-model";
import type { FaceVoice } from "./voice";

/** The surface's own vocabulary: the kit's phases plus the two honest states before a conversation can start. */
export type SurfacePhase =
	| "checking"
	| "unavailable"
	| "dormant"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "error";

type OpenPhase = "listening" | "thinking" | "speaking";

function isOpen(phase: SurfacePhase): phase is OpenPhase {
	return phase === "listening" || phase === "thinking" || phase === "speaking";
}

export type VoiceFacts = Pick<
	FaceVoice,
	"supported" | "phase" | "error" | "notice" | "refusal" | "micLive" | "muted" | "micSilent" | "micLabel" | "partial"
>;

export interface Problem {
	title: string;
	/** The engine's own words, verbatim. */
	detail: string;
	/** What to do about it, only when the words say what it is. */
	hint?: string;
}

export interface SurfaceView {
	phase: SurfacePhase;
	faceState: FaceState;
	/** The word beside the waveform mark while a conversation is open. */
	label: string;
	/** The only control that can start the microphone. */
	tap: "talk" | "retry" | null;
	/** Mute is a control of an open conversation. */
	canMute: boolean;
	/** A non-fatal word from the engine ("Downloading the voice model (42%)…"), or the reason the person's words were not sent. */
	status: string | undefined;
	/** The status says the person's last words were NOT sent (they are still on screen, and ride with the next thing said). */
	unsent: boolean;
	/** The microphone is open and delivering only silence: the label and the status say so instead of "Listening". */
	micSilent: boolean;
	/** The person's words so far, shown while they are talking. */
	userCaption: string;
	problem: Problem | null;
}

/** `engine` says a speech lane exists only after its probe answers; a surface that never gets one must say so. */
const UNAVAILABLE: Problem = {
	title: "Voice is not ready",
	detail: "Face to face needs an engine with a speech provider connected, and audio in this window.",
	hint: "Connect a speech provider in Capabilities (ElevenLabs needs an API key; an on-device voice may download a model first), then open this again.",
};

const HINTS: readonly [RegExp, string][] = [
	[/api key|apikey|unauthori[sz]ed|\b40[13]\b|invalid key/i, "Connect the provider's API key in Capabilities, then try again."],
	[/microphone|permission|denied|notallowed|not allowed/i, "Allow microphone access for this app in your system settings, then try again."],
	[/download|model|loading/i, "A speech model is loading or downloading. Wait for it to finish, then try again."],
	[/connection|disconnect|lost|closed|socket|unreachable/i, "Check that the engine is still running, then try again."],
];

export function hintFor(message: string): string | undefined {
	return HINTS.find(([pattern]) => pattern.test(message))?.[1];
}

function problemOf(v: VoiceFacts): Problem {
	const detail = v.error?.trim() || "The voice conversation stopped.";
	const hint = hintFor(detail);
	return { title: "Voice stopped", detail, ...(hint ? { hint } : {}) };
}

function surfacePhase(v: VoiceFacts, probeGraceOver: boolean): SurfacePhase {
	if (v.phase !== "idle") return v.phase;
	if (v.supported) return "dormant";
	return probeGraceOver ? "unavailable" : "checking";
}

const LABELS: Partial<Record<SurfacePhase, string>> = {
	checking: "Getting ready",
	connecting: "Connecting",
	listening: "Listening",
	thinking: "Thinking",
	speaking: "Speaking",
};

/** `probeGraceOver`: the engine has had time to answer whether it can speak; until then "not supported" means "not known yet". */
export function describeSurface(v: VoiceFacts, probeGraceOver: boolean): SurfaceView {
	const phase = surfacePhase(v, probeGraceOver);
	const open = isOpen(phase);
	// Mute releases the microphone, so it only changes what "listening" means; a reply being thought or spoken goes on.
	const muted = phase === "listening" && v.muted;
	// A microphone that hears nothing is not "listening": the surface says so, and the face stops leaning in.
	const deaf = phase === "listening" && !muted && v.micSilent;
	const unsent = open && v.refusal !== undefined;
	const faceState: FaceState = open && !muted && !deaf ? phase : "idle";
	return {
		phase,
		faceState,
		label: muted ? "Muted" : deaf ? "No sound" : (LABELS[phase] ?? ""),
		tap: phase === "dormant" ? "talk" : phase === "error" ? "retry" : null,
		canMute: open,
		// Words that went nowhere are the one thing the person must not miss while the conversation runs.
		status: unsent ? v.refusal : deaf ? micSilentNotice(v.micLabel) : phase === "error" || phase === "unavailable" ? undefined : v.notice,
		unsent,
		micSilent: deaf,
		userCaption: phase === "listening" && !muted ? v.partial.trim() : "",
		problem: phase === "error" ? problemOf(v) : phase === "unavailable" ? UNAVAILABLE : null,
	};
}

export type Intent = { readonly t: "mount"; readonly surface: string };

/** Leave for the thread: end the conversation (releasing the microphone) and navigate. Both, whatever the phase. */
export function leaveSurface(voice: Pick<FaceVoice, "stop">, onIntent: (intent: Intent) => void): void {
	void voice.stop();
	onIntent({ t: "mount", surface: "session" });
}

/** Whether two lists of blendshape names are the same names in the same order (the kit's `faceAt()` order vs this rig's). */
export function sameArkitOrder(granted: readonly string[], ours: readonly string[]): boolean {
	return granted.length === ours.length && granted.every((name, i) => name === ours[i]);
}

/** Esc leaves, unless something else already used it or the person is typing. */
export function isLeaveKey(e: { key: string; defaultPrevented: boolean; target?: unknown }): boolean {
	if (e.key !== "Escape" || e.defaultPrevented) return false;
	const el = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
	const tag = el?.tagName?.toUpperCase();
	return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true);
}
