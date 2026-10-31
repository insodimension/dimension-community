import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AnimatorInput, FaceAnimator, type PoseSource } from "../face/animator";
import { Captions } from "../face/captions";
import { detectDark, FaceView } from "../face/face-view";
import { FaceBoundary } from "./face-boundary";
import type { HeadState } from "./head";
import { type FaceLive, LivePresence } from "./live";
import { LiveMouth } from "./live-mouth";
import { MicPicker, sameMicVoice } from "./mic-picker";
import { SilenceBar } from "./silence-bar";
import { STYLES } from "./styles";
import { describeLive, describeSurface, type Intent, isLeaveKey, leaveSurface, liveHolds, type Problem, type SurfaceView } from "./surface-model";
import type { FaceVoice } from "./voice";
import { Waveform } from "./waveform";

/** Long enough for an engine that has a speech lane to say so; past it, "not supported" is an answer. */
const PROBE_GRACE_MS = 2500;
/** Sustained CPU cost per frame (ms) above which the renderer drops to its lighter quality for good. */
const SLOW_FRAME_MS = 9;
const SLOW_FRAMES_TO_DEGRADE = 120;
const ANIMATOR_SEED = 7;

/** The face fills the surface. A constant, so the memoised `FaceView` sees the same style every render. */
const FACE_STYLE: CSSProperties = { position: "absolute", inset: 0 };
/** The face draws no captions of its own here: the surface places them (below), so a new word re-renders them alone. */
const NO_WORDS: readonly never[] = [];

export interface FaceSurfaceBodyProps {
	voice: FaceVoice;
	/** The Live call on this session. Where the engine offers none it is inert and the surface behaves exactly as before. */
	live: FaceLive;
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

interface CardAction {
	label: string;
	run: () => void;
}

function ProblemCard({ problem, actions }: { problem: Problem; actions?: readonly CardAction[] }) {
	return (
		<div className="f2f-card f2f-fade" role="alert">
			<h2>{problem.title}</h2>
			<p>{problem.detail}</p>
			{problem.hint && <p>{problem.hint}</p>}
			{actions && (
				<div className="f2f-card-actions">
					{actions.map((action) => (
						<button key={action.label} type="button" className="f2f-btn" onClick={action.run}>
							{action.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

interface TopBarProps {
	onBack: () => void;
	micLive: boolean;
	canMute: boolean;
	muted: boolean;
	onToggleMute: () => void;
	picker: FaceVoice;
}

/** Back, the mic status, and the voice conversation's Mute and input picker (a Live call's Mute and End are the Live bar's). It depends on six things that change when you act, not on the words being said, so it does not re-render with them. */
const TopBar = memo(
	function TopBar({ onBack, micLive, canMute, muted, onToggleMute, picker }: TopBarProps) {
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
							<button type="button" className="f2f-btn" onClick={onToggleMute} aria-pressed={muted}>
								<MicIcon off={muted} />
								{muted ? "Unmute" : "Mute"}
							</button>
							<MicPicker voice={picker} />
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
		a.onToggleMute === b.onToggleMute &&
		sameMicVoice({ voice: a.picker }, { voice: b.picker }),
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

/** The newest voice, call and view: the per-frame callbacks read them through a ref, so they are never re-created. */
export interface Latest {
	readonly voice: FaceVoice;
	readonly live: FaceLive;
	readonly view: SurfaceView;
}

/** Back and Esc: end whichever conversation is open (both, whatever the phase) and navigate. The same function for the surface's whole life. */
function useLeave(latest: { readonly current: Latest }, onIntent: (intent: Intent) => void): () => void {
	// Latest `onIntent` by ref: the host hands a new closure on many of its renders, and `leave` must not change with it.
	const intentRef = useRef(onIntent);
	intentRef.current = onIntent;
	const leave = useCallback(
		() => leaveSurface([latest.current.voice, latest.current.live], (intent) => intentRef.current(intent)),
		[latest],
	);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isLeaveKey(e)) return;
			e.preventDefault();
			leave();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [leave]);
	return leave;
}

/**
 * What the face, the captions and the waveform read each frame. The animator and every callback are made once and read
 * `latest` through its ref: the face renders every frame, so none of them may change with a render.
 */
export function useFrameFeed(latest: { readonly current: Latest }, voice: FaceVoice, inLive: boolean) {
	const animator = useMemo(() => {
		const a = new FaceAnimator(ANIMATOR_SEED);
		// the dots gather into the face on entry
		a.setFormation(0);
		a.setFormationTarget(1);
		return a;
	}, []);

	const input = useRef<AnimatorInput>({ state: "idle", playhead: null, audioRms: 0, micRms: 0 }).current;
	// A Live call has no word schedule to play against; `LiveMouth` says how the mouth is fed instead.
	const mouth = useMemo(() => new LiveMouth(), []);
	const getInput = useCallback(() => {
		const { voice: v, live: l, view: s } = latest.current;
		if (s.mode === "live") return mouth.feed(input, s, l, performance.now());
		const speaking = s.phase === "speaking";
		input.state = s.faceState;
		input.playhead = speaking ? v.audioClock() : null;
		input.audioRms = speaking ? v.levels.getAgent() : 0;
		input.micRms = s.phase === "listening" ? v.levels.getMic() : 0;
		return input;
	}, [latest, input, mouth]);
	const getCaptionTime = useCallback(() => latest.current.voice.audioClock(), [latest]);
	const getWaveLevel = useCallback(() => {
		const { voice: v, view: s } = latest.current;
		return s.phase === "speaking" ? v.levels.getAgent() : v.levels.getMic();
	}, [latest]);
	const getSilence = useCallback(() => latest.current.voice.levels.getSilence(), [latest]);

	useEffect(() => animator.setWords(voice.words), [animator, voice.words]);

	// The mouth follows the audio-to-face model when the engine runs one; the animator falls back to
	// procedural lip-sync on its own whenever the model has no frame for this instant. The model runs on the voice conversation's
	// speech only; nothing runs it on a Live call's voice, so there it has nothing to read.
	const poseSource = useMemo<PoseSource>(
		() => (voice.faceModel && !inLive ? { arkit: () => latest.current.voice.faceAt() } : "procedural"),
		[latest, voice.faceModel, inLive],
	);

	return { animator, getInput, getCaptionTime, getWaveLevel, getSilence, poseSource };
}

interface StageProps {
	view: SurfaceView;
	live: FaceLive;
	getSilence: () => number;
	onTalk: () => void;
	onLive: () => void;
}

/** The middle of the surface: what starts a conversation, what stopped one, and the person's own words. */
function Stage({ view, live, getSilence, onTalk, onLive }: StageProps) {
	// Live is offered beside Tap to talk while nothing is open (and where the voice conversation is unavailable, since Live has its own route).
	const liveOffered = live.available && (view.tap === "talk" || view.phase === "unavailable");
	const actions =
		view.tap !== "retry"
			? undefined
			: view.mode === "live"
				? [
						{ label: "Try again", run: onLive },
						{ label: "Dismiss", run: live.stop },
					]
				: [{ label: "Try again", run: onTalk }];
	return (
		<div className="f2f-stage">
			{view.tap === "talk" && (
				<button type="button" className="f2f-talk f2f-fade" onClick={onTalk}>
					<span className="f2f-talk-orb" aria-hidden="true" />
					Tap to talk
				</button>
			)}
			{liveOffered && (
				<button type="button" className="f2f-live f2f-fade" onClick={onLive}>
					Talk live
					<span className="f2f-live-dest">Mic → {live.voice ?? "the voice provider"}</span>
				</button>
			)}
			{view.problem && <ProblemCard problem={view.problem} actions={actions} />}
			{view.userCaption && (
				<>
					<p className="f2f-usercap f2f-fade" style={{ margin: 0 }}>
						{view.userCaption}
					</p>
					<SilenceBar getSilence={getSilence} />
				</>
			)}
		</div>
	);
}

function StatusNote({ view }: { view: SurfaceView }) {
	if (!view.status) return null;
	return (
		<span className="f2f-note" data-warn={view.micSilent || view.unsent} role="status">
			{view.status}
		</span>
	);
}

/** The call's own surface: the Live bar under its status line in a Live call, the waveform mark with the word beside it in the voice conversation. A failed call is the card's, which can try again. */
function BottomBar({ view, live, getWaveLevel }: { view: SurfaceView; live: FaceLive; getWaveLevel: () => number }) {
	return (
		<div className="f2f-bottom">
			{view.mode === "live" && <StatusNote view={view} />}
			{view.mode === "live" && view.phase !== "error" && <LivePresence live={live} />}
			{view.label && (
				<div className="f2f-state">
					<Waveform getLevel={getWaveLevel} phase={view.phase} />
					<span className="f2f-label" role="status">
						{view.label}
					</span>
				</div>
			)}
		</div>
	);
}

/** The full-screen face: paper, the face, captions, the call's surface, and the controls (Tap to talk, Talk live, Back, Esc). */
export function FaceSurfaceBody({ voice, live, head, onIntent }: FaceSurfaceBodyProps) {
	const [graceOver, setGraceOver] = useState(false);
	const [quality, setQuality] = useState<"high" | "low">("high");
	const root = useRef<HTMLDivElement>(null);
	const dark = useHostDark(root);
	// A Live call holds the surface while it lasts; otherwise what is on screen is the voice conversation's state.
	const view = liveHolds(live) ? describeLive(live) : describeSurface(voice, graceOver);
	const inLive = view.mode === "live";

	// Latest voice, call and view, read by the per-frame callbacks without re-creating them.
	const latest = useRef<Latest>({ voice, live, view });
	latest.current = { voice, live, view };

	const { animator, getInput, getCaptionTime, getWaveLevel, getSilence, poseSource } = useFrameFeed(latest, voice, inLive);

	const slowFrames = useRef(0);
	const onFrameCost = useCallback((ms: number) => {
		slowFrames.current = ms > SLOW_FRAME_MS ? slowFrames.current + 1 : Math.max(0, slowFrames.current - 1);
		if (slowFrames.current > SLOW_FRAMES_TO_DEGRADE) setQuality("low");
	}, []);

	useEffect(() => {
		const id = setTimeout(() => setGraceOver(true), PROBE_GRACE_MS);
		return () => clearTimeout(id);
	}, []);

	const leave = useLeave(latest, onIntent);

	// Consent: the microphone opens from THIS click and nowhere else, and each conversation from its own button.
	const startTalking = useCallback(() => void latest.current.voice.start(), []);
	const startLive = useCallback(() => void latest.current.live.start(), []);
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
	// The voice conversation's words under the face. The person's own words take the floor instead; a Live call's words are the Live bar's.
	const wordCaptions = head.status === "ready" && !view.userCaption && !inLive ? <Captions words={voice.words} getTime={getCaptionTime} dark={dark} /> : null;

	return (
		// Follows the host theme: warm paper on a light host, warm near-black on a dark one (the halftone then
		// turns from ink into light, see halftone-shaders.ts).
		<div ref={root} className="f2f-root" data-dark={dark} data-phase={view.phase} data-mode={view.mode} data-quality={quality}>
			<style>{STYLES}</style>
			{head.status === "ready" && (
				<FaceBoundary
					fallback={(message) => (
						<div className="f2f-center">
							<ProblemCard problem={cannotDraw(message)} />
						</div>
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
				</FaceBoundary>
			)}

			<TopBar
				onBack={leave}
				micLive={view.micLive}
				canMute={view.canMute}
				muted={voice.muted}
				onToggleMute={voice.toggleMute}
				picker={voice}
			/>

			{faceFailed !== null && (
				<div className="f2f-center">
					<ProblemCard problem={cannotLoad(faceFailed)} />
				</div>
			)}
			<div className="f2f-lower">
				{view.mode === "voice" && <StatusNote view={view} />}
				<div className="f2f-words">
					{wordCaptions}
					<Stage view={view} live={live} getSilence={getSilence} onTalk={startTalking} onLive={startLive} />
				</div>
			</div>
			<BottomBar view={view} live={live} getWaveLevel={getWaveLevel} />
		</div>
	);
}
