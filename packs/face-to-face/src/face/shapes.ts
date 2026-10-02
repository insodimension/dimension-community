// The pose vector every part of the face speaks: 52 ARKit blendshape weights, Apple's names, alphabetical.
// The audio model (myned-ai/wav2arkit_cpu via the engine's `face` speech events) emits exactly this vector;
// the procedural lip-sync, the tag expressions and the idle behaviours PRODUCE the same vector, so the model
// and the fallback are interchangeable and the renderer only ever sees one thing.
//
// The order is the authoritative `ARKIT52` in packages/session-protocol/src/speech.ts and `ARKIT_52_NAMES` in
// the kit's voice-conversation hook. The pack cannot import either (it ships standalone), so it carries its
// own copy; test/shapes.test.ts pins the literal.

export const ARKIT_52 = [
	"browDownLeft",
	"browDownRight",
	"browInnerUp",
	"browOuterUpLeft",
	"browOuterUpRight",
	"cheekPuff",
	"cheekSquintLeft",
	"cheekSquintRight",
	"eyeBlinkLeft",
	"eyeBlinkRight",
	"eyeLookDownLeft",
	"eyeLookDownRight",
	"eyeLookInLeft",
	"eyeLookInRight",
	"eyeLookOutLeft",
	"eyeLookOutRight",
	"eyeLookUpLeft",
	"eyeLookUpRight",
	"eyeSquintLeft",
	"eyeSquintRight",
	"eyeWideLeft",
	"eyeWideRight",
	"jawForward",
	"jawLeft",
	"jawOpen",
	"jawRight",
	"mouthClose",
	"mouthDimpleLeft",
	"mouthDimpleRight",
	"mouthFrownLeft",
	"mouthFrownRight",
	"mouthFunnel",
	"mouthLeft",
	"mouthLowerDownLeft",
	"mouthLowerDownRight",
	"mouthPressLeft",
	"mouthPressRight",
	"mouthPucker",
	"mouthRight",
	"mouthRollLower",
	"mouthRollUpper",
	"mouthShrugLower",
	"mouthShrugUpper",
	"mouthSmileLeft",
	"mouthSmileRight",
	"mouthStretchLeft",
	"mouthStretchRight",
	"mouthUpperUpLeft",
	"mouthUpperUpRight",
	"noseSneerLeft",
	"noseSneerRight",
	"tongueOut",
] as const;

export type ArkitName = (typeof ARKIT_52)[number];
export const POSE_SIZE = ARKIT_52.length;

const INDEX: Record<string, number> = Object.fromEntries(ARKIT_52.map((n, i) => [n, i]));

/** Index of an ARKit shape in the pose vector; throws on an unknown name so a typo cannot silently drop a morph. */
export function arkitIndex(name: ArkitName): number {
	const i = INDEX[name];
	if (i === undefined) throw new Error(`unknown ARKit shape ${name}`);
	return i;
}

/** Same, for a name that arrives as data (an asset header): undefined instead of a throw. */
export function arkitIndexOf(name: string): number | undefined {
	return INDEX[name];
}

/**
 * The shapes the audio model owns: everything it actually emits (jaw, mouth, cheek, nose). Blink, gaze, brows,
 * head pose and the [tag] expressions never come from the model (it emits eyeBlink max 0.001), so they stay
 * procedural and are added on top of whichever source drives this group.
 */
export function isMouthShape(name: ArkitName): boolean {
	return name.startsWith("jaw") || name.startsWith("mouth") || name.startsWith("cheek") || name.startsWith("nose") || name === "tongueOut";
}
export const MOUTH_MASK: Uint8Array = Uint8Array.from(ARKIT_52, (n) => (isMouthShape(n) ? 1 : 0));

/**
 * Rig table: how a weight of 1.0 on each shape is realised on the Rocketbox head. The renderer applies
 * `min(weight, max) * gain` to the baked delta (a delta at weight 1.0 is what Blender's slider at 1.0 gives).
 * This is the ONE place a shape that reads wrong on this head is tuned, rather than amplifying blindly.
 * Anything not listed is gain 1, max 1.
 */
export interface Rig {
	gain?: number;
	max?: number;
}
export const RIG: Partial<Record<ArkitName, Rig>> = {};

export const RIG_GAIN: Float32Array = Float32Array.from(ARKIT_52, (n) => RIG[n]?.gain ?? 1);
export const RIG_MAX: Float32Array = Float32Array.from(ARKIT_52, (n) => RIG[n]?.max ?? 1);
