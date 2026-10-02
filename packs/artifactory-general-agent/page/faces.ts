// The faces an agent can wear and the one it shows. WHICH face is the host's
// answer: `agentPresenceFace` (the kit's rule for a surface that names an
// agent) over the user's own avatar and the host's agent bindings, so the
// user's Vibr-off switch wins, a Mochi keeps its skin and accent, and a
// contributed `plugin:` face paints through the host's bridge. The page only
// decides a face itself when the human picks a new one in the gallery.
import { AVATAR_IDS } from "@fraym/config";
import { MOCHI_ACCENTS } from "@fraym/vibr/avatars/mochi-skins";
import type { BridgedPresences, FaceBinding } from "./types";

/** One face the gallery offers. */
export interface FaceOption {
	readonly id: string;
	readonly label: string;
	/** A contributed face: painted in a sandboxed frame, so mounted lazily. */
	readonly bridged: boolean;
}

/** Every face an agent may wear: the host's first-party roster minus `none`
 *  (the user's Vibr switch, never an agent's to pick), then every contributed
 *  face the host lends. */
export function faceOptions(bridged: BridgedPresences | undefined): FaceOption[] {
	const own = AVATAR_IDS.filter(id => id !== "none").map(id => ({ id, label: faceLabel(id), bridged: false }));
	const lent = (bridged ?? []).map(def => ({ id: def.id, label: def.label, bridged: true }));
	return [...own, ...lent];
}

export function isBridgedFace(id: string): boolean {
	return id.startsWith("plugin:");
}

/** A face's name, as the gallery prints it. */
export function faceLabel(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The colour an agent's face carries when it pinned one (Mochi's accent), for
 *  the wash behind it; `undefined` (the app accent's wash) otherwise. `theme`
 *  is no colour of its own: it follows the app accent. */
export function faceHue(face: FaceBinding): string | undefined {
	return MOCHI_ACCENTS.find(option => option.id === face.accent)?.hex;
}

/** The wash behind a face tile: the pinned accent, else the app's. */
export function faceWash(face: FaceBinding, strength: number): string {
	return `color-mix(in oklab, ${faceHue(face) ?? "var(--fr-accent)"} ${strength}%, transparent)`;
}

/** `resolve`, remembered per name. The host's rule builds a new binding on every
 *  call, so a card handed a fresh one each render could never be skipped; one
 *  memo per (avatar, bindings) hands every card the same object until they change. */
export function rememberFaces(resolve: (name: string) => FaceBinding): (name: string) => FaceBinding {
	const faces = new Map<string, FaceBinding>();
	return name => {
		let face = faces.get(name);
		if (face === undefined) {
			face = resolve(name);
			faces.set(name, face);
		}
		return face;
	};
}
