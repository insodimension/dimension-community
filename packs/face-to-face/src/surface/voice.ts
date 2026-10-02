// The ONE file that touches the kit's voice hook. Everything else in the pack talks to `FaceVoice`, a
// structural slice of `VoiceConversation`, so the surface's state logic runs against a fake in tests
// and the pack never depends on more of the hook than it draws and drives.
import { ARKIT_52_NAMES, useVoiceConversation, type VoiceConversation } from "@fraym/ui";
import { useMemo } from "react";
import { ARKIT_52 } from "../face/shapes";
import { sameArkitOrder } from "./surface-model";

export type FaceVoice = Pick<
	VoiceConversation,
	| "supported"
	| "phase"
	| "error"
	| "notice"
	| "refusal"
	| "micLive"
	| "muted"
	| "micDevices"
	| "micDeviceId"
	| "micLabel"
	| "micSilent"
	| "setMicDevice"
	| "partial"
	| "words"
	| "turn"
	| "faceModel"
	| "levels"
	| "audioClock"
	| "faceAt"
	| "start"
	| "stop"
	| "toggleMute"
>;

const NO_FACE = (): null => null;

// The pack ships its own copy of the 52 names (it cannot import the engine's); the kit grants its list
// with the hook. If the two ever disagree, `faceAt()` would move the wrong shapes, so the model is
// ignored and the procedural mouth takes over: a wrong face is worse than a simple one.
const ORDER_AGREES = sameArkitOrder(ARKIT_52_NAMES, ARKIT_52);
if (!ORDER_AGREES) {
	console.warn("[face-to-face] the host's ARKIT_52_NAMES order differs from this pack's rig; using the procedural mouth");
}

export function useFaceVoice(): FaceVoice {
	const voice = useVoiceConversation();
	return useMemo(() => (ORDER_AGREES ? voice : { ...voice, faceModel: false, faceAt: NO_FACE }), [voice]);
}
