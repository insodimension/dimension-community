import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AnimatorInput, FaceAnimator, type PoseSource } from "../face/animator";
import { Captions } from "../face/captions";
import { detectDark, FaceView } from "../face/face-view";
import { FaceBoundary } from "./face-boundary";
import type { HeadState } from "./head";
import { MicPicker, sameMicVoice } from "./mic-picker";
import { SilenceBar } from "./silence-bar";
import { STYLES } from "./styles";
import { describeSurface, type Intent, isLeaveKey, leaveSurface, type Problem } from "./surface-model";
import type { FaceVoice } from "./voice";
import { Waveform } from "./waveform";

/** Long enough for an engine that has a speech lane to say so; past it, "not supported" is an answer. */
const PROBE_GRACE_MS = 2500;
/** Sustained CPU cost per frame (ms) above which the renderer drops to its lighter quality for good. */
const SLOW_FRAME_MS = 9;
const SLOW_FRAMES_TO_DEGRADE = 120;
const ANIMATOR_SEED = 7;

/** Where the captions sit: the same box `FaceView` gives them, for the fallback that draws them without a face. */
const CAPTION_BOX: CSSProperties = { position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: "8.5%", width: "min(92%, 60em)" };
/** The face fills the surface. A constant, so the memoised `FaceView` sees the same style every render. */
const FACE_STYLE: CSSProperties = { position: "absolute", inset: 0 };
/** The face draws no captions of its own here: the surface places them (below), so a new word re-renders them alone. */
const NO_WORDS: readonly never[] = [];

export interface FaceSurfaceBodyProps {
	voice: FaceVoice;
	head: HeadState;
	onIntent: (intent: Intent) => void;
}

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" } as const;

function MicIcon({ off }: { off?: boolean }) {
	return (
		<svg {...ICON} aria-hidden="true">
			<rect x="9" y="3" width="6" height="12" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
			{off && <path d="M4 4l16 16" />}
		</svg>
	);
}

function ProblemCard({ problem, action }: { problem: Problem; action?: { label: string; run: () => void } }) {
	return (
		<div className="f2f-card f2f-fade" role="alert">
			<h2>{problem.title}</h2>
			<p>{problem.detail}</p>
			{problem.hint && <p>{problem.hint}</p>}
			{action && (
				<button type="button" className="f2f-btn" onClick={action.run}>
					{action.label}
				</button>
			)}
		</div>
	);
}

interface TopBarProps {
	onBack: () => void;
	micLive: boolean;
	canMute: boolean;
	muted: boolean;
	voice: FaceVoice;
}

/** Back, the mic status, Mute and the input picker. It depends on six things that change when you act, not on the words being said, so it does not re-render with them. */
const TopBar = memo(
	function TopBar({ onBack, micLive, canMute, muted, voice }: TopBarProps) {
		return (
			<div className="f2f-top">
				<button type="button" className="f2f-btn" onClick={onBack} aria-label="Back to thread (Esc)">
					<svg {...ICON} aria-hidden="true">
						<path d="M15 5l-7 7 7 7" />
					</svg>
					Back to thread
				</button>
				<div className="f2f-cluster">
					<span className="f2f-mic" data-on={micLive} role="status">
						<span className="f2f-dot" aria-hidden="true" />
						{micLive ? "Mic on" : "Mic off"}
					</span>
					{canMute && (
						<>
							<button type="button" className="f2f-btn" onClick={() => voice.toggleMute()} aria-pressed={muted}>
								<MicIcon off={muted} />
								{muted ? "Unmute" : "Mute"}
							</button>
							<MicPicker voice={voice} />
						</>
					)}
				</div>
			</div>
		);
	},
	(a, b) =>
		a.onBack === b.onBack &&
		a.micLive === b.micLive &&
		a.canMute === b.canMute &&
		a.muted === b.muted &&
		a.voice.toggleMute === b.voice.toggleMute &&
		sameMicVoice(a, b),
);

/** The host's theme, read off the first painted background above the surface; re-read when the host flips its
 * theme (an attribute on <html> or <body>) or the OS scheme changes. */
function useHostDark(root: { current: HTMLElement | null }): boolean {
	const [dark, setDark] = useState(false);
	useLayoutEffect(() => {
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const read = () => setDark(detectDark(root.current?.parentElement ?? null, scheme.matches));
		read();
		const watch = new MutationObserver(read);
		for (const el of [document.documentElement, document.body]) watch.observe(el, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
		scheme.addEventListener("change", read);
		return () => {
			watch.disconnect();
			scheme.removeEventListener("change", read);
		};
	}, [root]);
	return dark;
}

/** The full-screen face: paper, the face, captions, the waveform mark, and the four controls (Tap to talk, Mute, Back, Esc). */
export function FaceSurfaceBody({ voice, head, onIntent }: FaceSurfaceBodyProps) {
	const [graceOver, setGraceOver] = useState(false);
	const [quality, setQuality] = useState<"high" | "low">("high");
	const root = useRef<HTMLDivElement>(null);
	const dark = useHostDark(root);
	const view = describeSurface(voice, graceOver);

	// Latest voice and view, read by the per-frame callbacks below without re-creating them.
	const live = useRef({ voice, view });
	live.current = { voice, view };

	const animator = useMemo(() => {
		const a = new FaceAnimator(ANIMATOR_SEED);
		// the orb gathers into the face on entry (the door click that mounted this surface)
		a.setFormation(0);
		a.setFormationTarget(1);
		return a;
	}, []);

	const input = useRef<AnimatorInput>({ state: "idle", playhead: null, audioRms: 0, micRms: 0 }).current;
	const getInput = useCallback(() => {
		const { voice: v, view: s } = live.current;
		const speaking = s.phase === "speaking";
		input.state = s.faceState;
		input.playhead = speaking ? v.audioClock() : null;
		input.audioRms = speaking ? v.levels.getAgent() : 0;
		input.micRms = s.phase === "listening" ? v.levels.getMic() : 0;
		return input;
	}, [input]);
	const getCaptionTime = useCallback(() => live.current.voice.audioClock(), []);
	const getWaveLevel = useCallback(() => {
		const { voice: v, view: s } = live.current;
		return s.phase === "speaking" ? v.levels.getAgent() : v.levels.getMic();
	}, []);
	const getSilence = useCallback(() => live.current.voice.levels.getSilence(), []);

	useEffect(() => animator.setWords(voice.words), [animator, voice.words]);

	// The mouth follows the audio-to-face model when the engine runs one; the animator falls back to
	// procedural lip-sync on its own whenever the model has no frame for this instant.
	const poseSource = useMemo<PoseSource>(
		() => (voice.faceModel ? { arkit: () => live.current.voice.faceAt() } : "procedural"),
		[voice.faceModel],
	);

	const slowFrames = useRef(0);
	const onFrameCost = useCallback((ms: number) => {
		slowFrames.current = ms > SLOW_FRAME_MS ? slowFrames.current + 1 : Math.max(0, slowFrames.current - 1);
		if (slowFrames.current > SLOW_FRAMES_TO_DEGRADE) setQuality("low");
	}, []);

	useEffect(() => {
		const id = setTimeout(() => setGraceOver(true), PROBE_GRACE_MS);
		return () => clearTimeout(id);
	}, []);

	// Latest `onIntent` by ref: the host hands a new closure on many of its renders, and `leave` must not change with it.
	const intentRef = useRef(onIntent);
	intentRef.current = onIntent;
	const leave = useCallback(() => leaveSurface(live.current.voice, (intent) => intentRef.current(intent)), []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isLeaveKey(e)) return;
			e.preventDefault();
			leave();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [leave]);

	// Consent: the microphone opens from THIS click and nowhere else.
	const startTalking = useCallback(() => void live.current.voice.start(), []);
	const faceFailed = head.status === "failed" ? head.message : null;
	const cannotLoad = (message: string): Problem => ({
		title: "The face could not be loaded",
		detail: message,
		hint: "Update or reinstall Face to face, then open it again.",
	});
	const cannotDraw = (message: string): Problem => ({
		title: "The face could not be drawn",
		detail: message,
		hint: "Face to face draws with WebGL2. Turn on hardware acceleration for this window, then reopen it.",
	});

	return (
		// Follows the host theme: warm paper on a light host, warm near-black on a dark one (the halftone then
		// turns from ink into light, see halftone-shaders.ts).
		<div ref={root} className="f2f-root" data-dark={dark} data-phase={view.phase} data-quality={quality}>
			<style>{STYLES}</style>
			{head.status === "ready" && (
				<FaceBoundary
					fallback={(message) => (
						<>
							<div className="f2f-center">
								<ProblemCard problem={cannotDraw(message)} />
							</div>
							{!view.userCaption && (
								<Captions words={voice.words} getTime={getCaptionTime} dark={dark} style={CAPTION_BOX} />
							)}
						</>
					)}
				>
					<FaceView
						head={head.asset}
						animator={animator}
						getInput={getInput}
						words={NO_WORDS}
						getCaptionTime={getCaptionTime}
						dark={dark}
						showCaptions={false}
						poseSource={poseSource}
						quality={quality}
						onFrameCost={onFrameCost}
						style={FACE_STYLE}
					/>
					{!view.userCaption && <Captions words={voice.words} getTime={getCaptionTime} dark={dark} style={CAPTION_BOX} />}
				</FaceBoundary>
			)}

			<TopBar onBack={leave} micLive={voice.micLive} canMute={view.canMute} muted={voice.muted} voice={voice} />

			{faceFailed !== null && (
				<div className="f2f-center">
					<ProblemCard problem={cannotLoad(faceFailed)} />
				</div>
			)}
			<div className="f2f-stage">
				{view.tap === "talk" && (
					<button type="button" className="f2f-talk f2f-fade" onClick={startTalking}>
						<span className="f2f-talk-orb" aria-hidden="true" />
						Tap to talk
					</button>
				)}
				{view.problem && (
					<ProblemCard
						problem={view.problem}
						action={view.tap === "retry" ? { label: "Try again", run: startTalking } : undefined}
					/>
				)}
				{view.userCaption && (
					<>
						<p className="f2f-usercap f2f-fade" style={{ margin: 0 }}>
							{view.userCaption}
						</p>
						<SilenceBar getSilence={getSilence} />
					</>
				)}
			</div>

			<div className="f2f-bottom">
				{view.status && (
					<span className="f2f-note" data-warn={view.micSilent || view.unsent} role="status">
						{view.status}
					</span>
				)}
				{view.label && (
					<div className="f2f-state">
						<Waveform getLevel={getWaveLevel} phase={view.phase} />
						<span className="f2f-label" role="status">
							{view.label}
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
