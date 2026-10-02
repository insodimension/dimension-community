// CPU-side face animation at 60 Hz: turns state + the audio clock + audio energy into the 52 ARKit weights,
// head pose and colour drift. Pure (no DOM, no GL): deterministic for a given seed and input sequence.
//
// The weights are built from three layers. The MOUTH group (MOUTH_MASK: jaw, mouth, cheek, nose, tongue) comes
// from one of two sources that both produce the same ARKit vector: the audio model (engine-computed, played
// back through `PoseSource`) or the procedural lip-sync (visemes projected through VISEME_RIG, plus the voice
// itself). Everything else (blink, gaze, brows, head pose, state attitude, [tag] expressions) is always
// procedural and is added on top, because the model emits none of it.
import { type ExprEvent, expressionEvents, exprEnvelope } from "./expressions";
import { type CaptionWord, VISEME_RIG, VISEMES, VisemeTrack } from "./lipsync";
import type { FaceFrame } from "./renderer";
import { ARKIT_52, type ArkitName, arkitIndex, MOUTH_MASK, POSE_SIZE } from "./shapes";

export type FaceState = "idle" | "listening" | "thinking" | "speaking";

export interface AnimatorInput {
	state: FaceState;
	/** Seconds into the current speech turn's audio, or null when nothing is playing. */
	playhead: number | null;
	/** RMS (0..1) of the audio being played, for jaw coupling. */
	audioRms: number;
	/** RMS (0..1) of the microphone while the person talks. */
	micRms: number;
}

/**
 * Where the mouth group comes from. `arkit()` returns the 52-vector (ARKit alphabetical order, 0..1) already
 * sampled at the audio playhead, or null while no model frame covers it (start of a turn, no model, interrupted).
 * It is called once per step; a vector of the wrong length or with a NaN counts as null.
 */
export type PoseSource = "procedural" | { arkit(): Float32Array | null };

export type Spring = [x: number, v: number];

/**
 * Critically damped spring, exact closed form (no integration error, any dt): advances `sp` in place
 * by dt seconds toward `target` with natural frequency `omega` rad/s.
 */
export function springStep(sp: Spring, target: number, omega: number, dt: number): void {
	const k = Math.exp(-omega * dt);
	const d = sp[0] - target;
	const j = (sp[1] + omega * d) * dt;
	sp[0] = target + (d + j) * k;
	sp[1] = (sp[1] - omega * j) * k;
}

/** Eyelid closure 0..1 at `age` seconds into a blink: quick close, a beat shut, slower open. */
export function blinkCurve(age: number): number {
	if (age <= 0 || age >= 0.26) return 0;
	if (age < 0.07) return Math.sin((age / 0.07) * Math.PI * 0.5);
	if (age < 0.1) return 1;
	return Math.cos(((age - 0.1) / 0.16) * Math.PI * 0.5);
}

/**
 * Per-source gains, one place to trim how far each mouth source opens (1 = as designed). Per-shape limits of
 * the model live in the renderer's rig table; `model` here is only a global trim on its whole mouth group.
 */
export const GAIN = {
	/** Everything the viseme rig contributes (procedural path). */
	viseme: 1,
	/** The audio-RMS coupling of the jaw and lower lip (procedural path). */
	voice: 1,
	/** jawOpen itself on the procedural path: speech opens through mouthLowerDown far more than through the jaw. */
	jaw: 1,
	/** The audio model's whole mouth group. */
	model: 1,
} as const;

/** Soft ceilings of the summed procedural opening (viseme rig + voice) before the springs: x -> limit * tanh(x / limit). */
const LIMIT = { jaw: 0.42, lower: 0.62 } as const;
/** How much the voice alone opens jaw / lower lip / upper lip at full loudness (before GAIN.voice and the compressor). */
const VOICE = { jaw: 0.2, lower: 0.3, upper: 0.08 } as const;
/** Audio RMS that reads as fully loud; loudness beyond it only feeds the compressor. */
const VOICE_REF = 0.1;

/** Model open-proxy (the larger of jawOpen and the mean lower-lip drop) below REST_LO reads as a closed mouth; its opening ramps in until REST_HI. */
const REST_LO = 0.07;
const REST_HI = 0.2;
/** mouthClose held at rest (model below the knee, procedural without voice or visemes). */
const CLOSE_REST = 0.25;
/** Latched audioRms above this proves the host supplies audio energy this turn. */
const RMS_SEEN = 0.02;
/** How much an audibly silent moment (audioRms present and ~0) attenuates the model's opening. */
const RMS_CLOSE = 0.5;
/** Seconds to cross-fade the mouth group between the model and the procedural source, either way. */
const XFADE = 0.1;
/** Stress (brow lift, nod) from how fast the model's opening rises, when there is no audio energy to read it from. */
const MODEL_STRESS = 8;

/** Seconds the mouth leads the audio clock so closures land before the sound. */
const LEAD = 0.035;
const TAU = Math.PI * 2;

const ix = arkitIndex;
const JAW = ix("jawOpen");
const LOW_L = ix("mouthLowerDownLeft");
const LOW_R = ix("mouthLowerDownRight");
const UP_L = ix("mouthUpperUpLeft");
const UP_R = ix("mouthUpperUpRight");
const FUNNEL = ix("mouthFunnel");
const CLOSE = ix("mouthClose");
const SMILE_L = ix("mouthSmileLeft");
const SMILE_R = ix("mouthSmileRight");
const FROWN_L = ix("mouthFrownLeft");
const FROWN_R = ix("mouthFrownRight");
const BROW_IN = ix("browInnerUp");
const BROW_OUT_L = ix("browOuterUpLeft");
const BROW_OUT_R = ix("browOuterUpRight");
const BROW_DOWN_L = ix("browDownLeft");
const BROW_DOWN_R = ix("browDownRight");
const WIDE_L = ix("eyeWideLeft");
const WIDE_R = ix("eyeWideRight");
const SQUINT_L = ix("eyeSquintLeft");
const SQUINT_R = ix("eyeSquintRight");
const BLINK_L = ix("eyeBlinkLeft");
const BLINK_R = ix("eyeBlinkRight");

/** The shapes that widen the mouth: what the knee scales at rest and what a tag's mouthScale scales on the model. */
const OPEN_GROUP = Uint8Array.from(
	(["jawOpen", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight", "mouthShrugUpper", "mouthShrugLower", "mouthStretchLeft", "mouthStretchRight"] as const satisfies readonly ArkitName[]).map(ix),
);

/** VISEME_RIG as flat index/weight arrays, so a step never walks an object. */
const RIG_IDX = VISEMES.map((v) => Uint8Array.from(Object.keys(VISEME_RIG[v]), (n) => ix(n as ArkitName)));
const RIG_VAL = VISEMES.map((v) => Float32Array.from(Object.values(VISEME_RIG[v]) as number[]));
const V_PP = VISEMES.indexOf("PP");
const V_FF = VISEMES.indexOf("FF");
const V_CLOSERS = [VISEMES.indexOf("nn"), VISEMES.indexOf("DD"), VISEMES.indexOf("SS"), VISEMES.indexOf("KK")];
/** Vowels the mouth cycles through while the voice runs ahead of the word timings. */
const V_FALLBACK = (["aa", "E", "O", "I"] as const).map((v) => VISEMES.indexOf(v));

/**
 * Natural frequency (rad/s) of the spring behind each channel: the lips and jaw fast (they carry the
 * consonants), lip corners and cheeks slower, brows and lids slowest; a blink is near-instant.
 */
const OMEGA = Float32Array.from(ARKIT_52, (n) => {
	if (n.startsWith("eyeBlink")) return 90;
	if (n === "jawOpen") return 24;
	if (/^mouth(Smile|Frown|Dimple|Left|Right)/.test(n)) return 14;
	if (MOUTH_MASK[ARKIT_52.indexOf(n)] && !n.startsWith("cheek") && !n.startsWith("nose")) return 26;
	if (n.startsWith("cheek") || n.startsWith("nose")) return 14;
	return 11;
});
/** The model's frames are already smooth, so its mouth springs run this much tighter than the procedural ones (less lag). */
const MODEL_OMEGA_BOOST = 0.6;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** NaN reads as 0 so one bad input cannot poison a filter state for good. */
const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const soft = (x: number, limit: number) => limit * Math.tanh(x / limit);

/**
 * Size of the mouth opening 0..1 from the FINAL ARKit weights, for the renderer's mouth-interior dots (it fades
 * them in over smoothstep(0.05, 0.38, mouthOpen)): the larger of the jaw and the mean lower-lip drop, plus half
 * the mean upper-lip lift and 0.3 of the funnel (an O opens a hole without dropping the jaw). Closed lips read 0;
 * natural speech reads about 0.3 mean, 0.55 at its widest.
 */
export function mouthOpenOf(w: ArrayLike<number>): number {
	return clamp01(Math.max(w[JAW], (w[LOW_L] + w[LOW_R]) / 2) + 0.25 * (w[UP_L] + w[UP_R]) + 0.3 * w[FUNNEL]);
}

interface State {
	rnd: () => number;
	time: number;
	springs: Spring[];
	yaw: Spring;
	pitch: Spring;
	roll: Spring;
	gaze: { yaw: number; pitch: number; roll: number };
	nextGaze: number;
	nextBlink: number;
	blinkAt: number;
	secondBlinkAt: number;
	env: number;
	prevEnv: number;
	rmsSeen: boolean;
	mEnv: number;
	prevMEnv: number;
	micEnv: number;
	nodCooldown: number;
	warm: Spring;
	loosen: Spring;
	gazeX: Spring;
	gazeY: Spring;
	saccade: { x: number; y: number; next: number };
	fallbackShape: number;
	fallbackAt: number;
	/** 0 = procedural mouth, 1 = model mouth. */
	mix: number;
	/** Speaking seconds so far, and the head-turn schedule that runs on it. */
	spoke: number;
	sideFrom: number;
	sideTo: number;
	flipStart: number;
	flipNext: number;
}

/** Sustained three-quarter turn while speaking: how far, how long a side flip takes, and the gap between flips. */
const TURN = { amp: 0.45, flip: 3, every: [10, 14] } as const;
/** Smooth 0..1 tanh-shaped ease that starts and ends exactly at 0 and 1. */
const TANH3 = Math.tanh(3);
const ease = (u: number) => 0.5 + 0.5 * (Math.tanh(3 * (2 * clamp01(u) - 1)) / TANH3);

function makeState(seed: number): State {
	const rnd = mulberry32(seed);
	const side = rnd() < 0.5 ? -1 : 1;
	return {
		rnd,
		time: 0,
		springs: Array.from({ length: POSE_SIZE }, (): Spring => [0, 0]),
		yaw: [0, 0],
		pitch: [0, 0],
		roll: [0, 0],
		gaze: { yaw: 0, pitch: 0, roll: 0 },
		nextGaze: 0,
		nextBlink: 1 + rnd() * 2,
		blinkAt: -10,
		secondBlinkAt: -10,
		env: 0,
		prevEnv: 0,
		rmsSeen: false,
		mEnv: 0,
		prevMEnv: 0,
		micEnv: 0,
		nodCooldown: 0,
		warm: [0, 0],
		loosen: [0, 0],
		gazeX: [0, 0],
		gazeY: [0, 0],
		saccade: { x: 0, y: 0, next: 0.5 },
		fallbackShape: 0,
		fallbackAt: 0,
		mix: 0,
		spoke: 0,
		sideFrom: side,
		sideTo: side,
		flipStart: -TURN.flip,
		flipNext: TURN.every[0] + rnd() * (TURN.every[1] - TURN.every[0]),
	};
}

export class FaceAnimator {
	/** Reused every step; the renderer reads it immediately. */
	readonly frame: FaceFrame = {
		weights: new Float32Array(POSE_SIZE),
		yaw: 0, pitch: 0, roll: 0, warm: 0, hue: 0, formation: 1, mouthOpen: 0, loosen: 0, breath: 0, gazeX: 0, gazeY: 0,
	};
	private s: State;
	private readonly track = new VisemeTrack();
	private words: CaptionWord[] = [];
	private events: ExprEvent[] = [];
	private formationGoal = 1;
	private pose: PoseSource = "procedural";
	private readonly tgt = new Float32Array(POSE_SIZE);
	/** The two mouth groups being cross-faded; only MOUTH_MASK entries are ever non-zero. */
	private readonly proc = new Float32Array(POSE_SIZE);
	private readonly model = new Float32Array(POSE_SIZE);
	private readonly vis = new Float32Array(VISEMES.length);

	constructor(seed = 1) {
		this.s = makeState(seed);
	}

	/** Back to a fresh session (same seed gives the same motion). */
	reset(seed = 1): void {
		this.s = makeState(seed);
		this.frame.weights.fill(0);
		this.proc.fill(0);
		this.model.fill(0);
		this.frame.formation = 1;
		this.formationGoal = 1;
		this.setWords([]);
	}

	/** Replace the whole turn's caption words (also carries audio tags for expressions). */
	setWords(words: readonly CaptionWord[]): void {
		this.words = words.slice();
		this.track.setWords(this.words);
		this.events = expressionEvents(this.words);
	}

	/** Append an in-order batch of words to the current turn. */
	appendWords(batch: readonly CaptionWord[]): void {
		this.setWords([...this.words, ...batch]);
	}

	/** Choose where the mouth comes from; switching cross-fades over ~100 ms, so it is safe at any moment. */
	setPoseSource(src: PoseSource): void {
		this.pose = src;
	}

	/** Orb -> face gathers over ~2.4 s (and disperses over ~1.2 s) toward `goal` in 0..1 (1 = face, 0 = orb). */
	setFormationTarget(goal: number): void {
		this.formationGoal = clamp01(goal);
	}

	/** Jump the formation directly (0..1), e.g. to hold the intro at a fixed point (also set the target to hold it). */
	setFormation(v: number): void {
		this.frame.formation = clamp01(v);
	}

	private readPose(): Float32Array | null {
		const src = this.pose;
		if (src === "procedural") return null;
		const v = src.arkit();
		if (!v || v.length !== POSE_SIZE) return null;
		for (let i = 0; i < POSE_SIZE; i++) if (!Number.isFinite(v[i])) return null;
		return v;
	}

	/**
	 * The model's mouth group, made to read closed at rest. The ONNX is never quite still (open-proxy ~0.12 over
	 * near-silent frames), so the opening shapes are scaled by a smoothstep of the model's own open-proxy around
	 * that rest level (quiet speech above the knee is untouched) and a small mouthClose fills in below it. When the
	 * host also supplies audio energy, audible silence closes the mouth further. Returns the raw open-proxy.
	 */
	private shapeModel(v: Float32Array, mouthScale: number, silence: number): number {
		const M = this.model;
		for (let i = 0; i < POSE_SIZE; i++) M[i] = MOUTH_MASK[i] ? clamp01(v[i] * GAIN.model) : 0;
		// the model opens through the lower lip far more than the jaw, so its opening is the larger of the two
		const p = Math.max(M[JAW], (M[LOW_L] + M[LOW_R]) / 2);
		const g = smoothstep(REST_LO, REST_HI, p);
		const k = g * (1 - RMS_CLOSE * silence) * mouthScale;
		for (let j = 0; j < OPEN_GROUP.length; j++) M[OPEN_GROUP[j]] = clamp01(M[OPEN_GROUP[j]] * k);
		M[CLOSE] = Math.max(M[CLOSE], CLOSE_REST * Math.max(1 - g, silence));
		return p;
	}

	/**
	 * The procedural mouth group: visemes from the word schedule projected through VISEME_RIG, the voice's own
	 * loudness on the jaw and lower lip, both squeezed by a soft ceiling so a loud passage cannot pry the mouth
	 * wide, and lips pressed shut wherever a bilabial or the lack of any voice calls for it.
	 */
	private shapeProcedural(playhead: number | null, speaking: boolean, env: number, open: number, mouthScale: number): void {
		const P = this.proc;
		P.fill(0);
		let presence = 0;
		if (speaking && playhead !== null) {
			const s = this.s;
			const track = this.track;
			const raw = track.sample(playhead + LEAD);
			const vis = this.vis;
			// without audio energy the words alone drive the mouth; with it, near-silence dims all but the closures
			const gate = s.rmsSeen ? 0.3 + 0.7 * smoothstep(0.004, 0.03, env) : 1;
			for (let k = 0; k < vis.length; k++) vis[k] = track.out[k] * (k === V_PP || k === V_FF ? 1 : gate);
			if (raw < 0.05 && open > 0.12) {
				// voice with no viseme data yet (words arrive a beat late): keep the lips moving with the sound
				if (s.time > s.fallbackAt) {
					s.fallbackShape = (s.fallbackShape + 1) % V_FALLBACK.length;
					s.fallbackAt = s.time + 0.13 + s.rnd() * 0.08;
				}
				const k = V_FALLBACK[s.fallbackShape];
				vis[k] = Math.max(vis[k], open * 0.6);
			}
			// lips pressed or teeth on lip: the voice must not pry the jaw open
			let closed = vis[V_PP] + 0.7 * vis[V_FF];
			for (const k of V_CLOSERS) closed += 0.25 * vis[k];
			closed = Math.min(1, closed);
			const wv = GAIN.viseme * mouthScale;
			for (let k = 0; k < vis.length; k++) {
				const w = vis[k] * wv;
				if (w === 0) continue;
				const idx = RIG_IDX[k];
				const val = RIG_VAL[k];
				for (let j = 0; j < idx.length; j++) P[idx[j]] += w * val[j];
			}
			const voice = open * GAIN.voice * mouthScale * (1 - closed);
			P[JAW] = soft(GAIN.jaw * P[JAW] + VOICE.jaw * voice, LIMIT.jaw);
			P[LOW_L] = soft(P[LOW_L] + VOICE.lower * voice, LIMIT.lower);
			P[LOW_R] = soft(P[LOW_R] + VOICE.lower * voice, LIMIT.lower);
			P[UP_L] += VOICE.upper * voice;
			P[UP_R] += VOICE.upper * voice;
			presence = clamp01(Math.max(raw, open * 2));
		}
		P[CLOSE] = Math.max(P[CLOSE], CLOSE_REST * (1 - presence));
	}

	step(rawDt: number, input: AnimatorInput): FaceFrame {
		const dt = rawDt > 1e-4 ? Math.min(0.1, rawDt) : 1e-4;
		const s = this.s;
		s.time += dt;
		const t = s.time;
		const f = this.frame;
		const { state } = input;
		const speaking = state === "speaking";
		const tgt = this.tgt;
		tgt.fill(0);

		// audio energy: fast attack, slow release, so the jaw follows syllables without flicker
		s.prevEnv = s.env;
		const rms = clamp01(input.audioRms);
		s.env += (rms - s.env) * (rms > s.env ? 1 - Math.exp(-dt / 0.012) : 1 - Math.exp(-dt / 0.05));
		const open = clamp01((s.env / VOICE_REF) ** 0.7);
		if (input.playhead === null) s.rmsSeen = false;
		else if (rms > RMS_SEEN) s.rmsSeen = true;
		s.micEnv += (clamp01(input.micRms) - s.micEnv) * (1 - Math.exp(-dt / 0.08));
		const audioStress = clamp01((s.env - s.prevEnv) * 14);

		// ---- expressions from audio tags (only while a turn's audio is playing)
		let exprPulse = 0;
		let mouthScale = 1;
		let exprPitch = 0;
		let exprRoll = 0;
		if (input.playhead !== null) {
			for (const ev of this.events) {
				const a = exprEnvelope(ev, input.playhead);
				if (a <= 0) continue;
				const phase = ev.expr.pulseHz ? Math.sin(TAU * ev.expr.pulseHz * (input.playhead - ev.t0)) : 0;
				const pulse = ev.expr.pulseHz ? 0.78 + 0.22 * phase : 1;
				for (const name in ev.expr.shapes) {
					const i = ix(name as ArkitName);
					tgt[i] = Math.min(1, tgt[i] + (ev.expr.shapes[name as ArkitName] ?? 0) * a * pulse);
				}
				if (ev.expr.pulseHz) exprPulse = Math.max(exprPulse, a * (0.5 + 0.5 * phase));
				mouthScale *= 1 + ((ev.expr.mouthScale ?? 1) - 1) * a;
				exprPitch += (ev.expr.pitch ?? 0) * a;
				exprRoll += (ev.expr.roll ?? 0) * a;
			}
		}

		// ---- mouth: the model when it has a frame for this instant, else the procedural lip-sync, cross-faded
		const frameFromModel = this.readPose();
		const silence = s.rmsSeen ? 1 - smoothstep(0.002, 0.015, s.env) : 0;
		const pModel = frameFromModel ? this.shapeModel(frameFromModel, mouthScale, silence) : 0;
		const xstep = dt / XFADE;
		s.mix += Math.max(-xstep, Math.min(xstep, (frameFromModel ? 1 : 0) - s.mix));
		const b = s.mix * s.mix * (3 - 2 * s.mix);
		if (b < 1) this.shapeProcedural(input.playhead, speaking, s.env, open, mouthScale);
		const proc = this.proc;
		const model = this.model;
		for (let i = 0; i < POSE_SIZE; i++) if (MOUTH_MASK[i]) tgt[i] += proc[i] * (1 - b) + model[i] * b;
		tgt[JAW] += exprPulse * 0.1;

		// syllable stress: the audio's own attack when the host feeds it, else how fast the model's mouth is opening
		s.prevMEnv = s.mEnv;
		s.mEnv += (pModel - s.mEnv) * (pModel > s.mEnv ? 1 - Math.exp(-dt / 0.03) : 1 - Math.exp(-dt / 0.08));
		const stress = Math.max(audioStress, clamp01((s.mEnv - s.prevMEnv) * MODEL_STRESS));

		// ---- state baseline: brows/eyes/mouth attitude and how loose the edge dots are. Every state keeps the lids
		// a little open (eyeWide) so the face reads awake rather than heavy-lidded.
		let warmGoal = 0.05;
		let loosenGoal = 0;
		tgt[WIDE_L] += 0.12;
		tgt[WIDE_R] += 0.12;
		if (state === "idle") {
			tgt[SMILE_L] += 0.05;
			tgt[SMILE_R] += 0.05;
		} else if (state === "listening") {
			tgt[BROW_IN] += 0.22;
			tgt[BROW_OUT_L] += 0.1;
			tgt[BROW_OUT_R] += 0.1;
			tgt[WIDE_L] += 0.03;
			tgt[WIDE_R] += 0.03;
			warmGoal = -0.45;
		} else if (state === "thinking") {
			tgt[BROW_DOWN_L] += 0.12;
			tgt[BROW_DOWN_R] += 0.08;
			tgt[BROW_IN] += 0.08;
			tgt[FROWN_L] += 0.1;
			tgt[FROWN_R] += 0.1;
			tgt[SQUINT_L] += 0.03;
			tgt[SQUINT_R] += 0.03;
			tgt[WIDE_L] -= 0.02;
			tgt[WIDE_R] -= 0.02;
			warmGoal = -0.15;
			loosenGoal = 1;
		} else {
			tgt[SMILE_L] += 0.1;
			tgt[SMILE_R] += 0.1;
			tgt[BROW_IN] += 0.06 + 0.3 * stress;
			tgt[BROW_OUT_L] += 0.2 * stress;
			tgt[BROW_OUT_R] += 0.2 * stress;
			warmGoal = 0.55;
		}

		// ---- blinking: every 2-6 s, sometimes a double
		if (t >= s.nextBlink) {
			s.blinkAt = t;
			s.secondBlinkAt = s.rnd() < 0.22 ? t + 0.2 : -10;
			s.nextBlink = t + 2 + s.rnd() * 4;
		}
		const blink = Math.max(blinkCurve(t - s.blinkAt), blinkCurve(t - s.secondBlinkAt));
		tgt[BLINK_L] = Math.max(tgt[BLINK_L], blink);
		tgt[BLINK_R] = Math.max(tgt[BLINK_R], blink);
		tgt[WIDE_L] *= 1 - blink;
		tgt[WIDE_R] *= 1 - blink;

		// ---- springs
		const w = f.weights;
		const boost = 1 + MODEL_OMEGA_BOOST * b;
		for (let i = 0; i < POSE_SIZE; i++) {
			springStep(s.springs[i], clamp01(tgt[i]), MOUTH_MASK[i] ? OMEGA[i] * boost : OMEGA[i], dt);
			w[i] = clamp01(s.springs[i][0]);
		}

		// ---- head pose
		if (t >= s.nextGaze) {
			const side = s.rnd() < 0.5 ? -1 : 1;
			s.gaze.yaw = state === "thinking" ? side * (0.16 + s.rnd() * 0.08) : state === "listening" ? (s.rnd() - 0.5) * 0.06 : (s.rnd() - 0.5) * 0.14;
			s.gaze.pitch = state === "thinking" ? -0.07 : state === "listening" ? 0.02 : (s.rnd() - 0.5) * 0.06;
			s.gaze.roll = state === "listening" ? side * 0.035 : (s.rnd() - 0.5) * 0.06;
			s.nextGaze = t + (state === "thinking" ? 2.6 : 1.6) + s.rnd() * 2.4;
		}
		let yawGoal = s.gaze.yaw;
		let pitchGoal = s.gaze.pitch;
		let rollGoal = s.gaze.roll;
		if (speaking) {
			// sustained 3/4 turn toward one shoulder, flipping to the other every ~10-14 s of speech along a tanh ease,
			// a small wander on top; syllable stress nudges the chin
			s.spoke += dt;
			if (s.spoke >= s.flipNext) {
				s.sideFrom = s.sideTo;
				s.sideTo = -s.sideTo;
				s.flipStart = s.spoke;
				s.flipNext = s.spoke + TURN.every[0] + s.rnd() * (TURN.every[1] - TURN.every[0]);
			}
			const turn = s.sideFrom + (s.sideTo - s.sideFrom) * ease((s.spoke - s.flipStart) / TURN.flip);
			yawGoal = TURN.amp * turn + 0.05 * Math.sin((TAU * t) / 5.3 + 1.3) + 0.03 * Math.sin((TAU * t) / 2.9);
			pitchGoal = 0.035 * Math.sin((TAU * t) / 5.7) + 0.05 * stress;
			rollGoal = yawGoal * 0.12;
		}
		s.nodCooldown -= dt;
		if (state === "listening" && s.micEnv > 0.05 && s.nodCooldown <= 0) {
			s.pitch[1] += 0.9; // nod: chin down, the spring returns it
			s.nodCooldown = 0.8 + s.rnd() * 0.6;
		}
		if (speaking && stress > 0.6 && s.nodCooldown <= 0) {
			s.pitch[1] += 0.35;
			s.yaw[1] += (s.rnd() - 0.5) * 0.2;
			s.nodCooldown = 0.25;
		}
		const poseOmega = speaking ? 4.5 : 3.2;
		springStep(s.yaw, yawGoal, poseOmega, dt);
		springStep(s.pitch, pitchGoal + exprPitch, poseOmega, dt);
		springStep(s.roll, rollGoal + exprRoll, poseOmega, dt);
		f.yaw = Math.max(-0.55, Math.min(0.55, s.yaw[0]));
		f.pitch = Math.max(-0.3, Math.min(0.3, s.pitch[0]));
		f.roll = Math.max(-0.2, Math.min(0.2, s.roll[0]));

		// ---- eyes: micro-saccades toward the viewer; when thinking they wander off-axis
		if (t >= s.saccade.next) {
			const wander = state === "thinking" ? 0.9 : 0.25;
			s.saccade.x = (s.rnd() - 0.5) * 2 * wander + (state === "thinking" ? Math.sign(s.gaze.yaw) * 0.4 : 0);
			s.saccade.y = (s.rnd() - 0.5) * 1.2 * wander + (state === "thinking" ? 0.35 : 0);
			s.saccade.next = t + 0.4 + s.rnd() * (state === "thinking" ? 1.6 : 2.4);
		}
		springStep(s.gazeX, s.saccade.x, 40, dt);
		springStep(s.gazeY, s.saccade.y, 40, dt);
		f.gazeX = Math.max(-1, Math.min(1, s.gazeX[0]));
		f.gazeY = Math.max(-1, Math.min(1, s.gazeY[0]));

		// ---- slow colour drift (warmer when speaking, cooler when listening), breathing, loosening
		springStep(s.warm, warmGoal, 0.9, dt);
		springStep(s.loosen, loosenGoal, 2, dt);
		f.warm = Math.max(-1, Math.min(1, s.warm[0] + 0.25 * Math.sin((TAU * t) / 37)));
		f.hue = 0.1 * Math.sin((TAU * t) / 53) + 0.08 * Math.sin((TAU * t) / 29 + 2);
		f.loosen = clamp01(s.loosen[0]);
		f.breath = 0.0007 * Math.sin((TAU * t) / 4.2);
		f.mouthOpen = mouthOpenOf(w);

		const rate = this.formationGoal > f.formation ? 1 / 2.4 : -1 / 1.2;
		f.formation = clamp01(f.formation + rate * dt);
		if (Math.abs(f.formation - this.formationGoal) < 1e-4) f.formation = this.formationGoal;
		return f;
	}
}
