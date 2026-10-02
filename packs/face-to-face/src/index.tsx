// Face to face: one bundle, two components. `FaceSurface` (default export) fills the Chat space's `face`
// workspace surface; `FaceDoor` (named export, declared with `"export": "FaceDoor"` in plugin.json) is the
// pinned orb that opens it. This module is the ONLY place the two are wired to the host: the surface's
// voice comes from the kit hook through `surface/voice.ts`, the head from `surface/head-source.ts`.
import { memo, useCallback, useRef } from "react";
import { FaceSurfaceBody } from "./surface/face-surface";
import type { Intent } from "./surface/surface-model";
import { useHead } from "./surface/head";
import headUrl from "./surface/head-source";
import { STYLES } from "./surface/styles";
import { useFaceVoice } from "./surface/voice";

export { FaceDoor } from "./surface/face-door";

/** The workspace-surface fill props this pack reads (the host passes many more) plus the seat's `store`. */
export interface FaceSurfaceProps {
	readonly activeSurface: string;
	readonly onIntent: (intent: Intent) => void;
	readonly store?: object;
}

const Seated = memo(function Seated({ onIntent }: Pick<FaceSurfaceProps, "onIntent">) {
	const voice = useFaceVoice();
	const head = useHead(headUrl);
	return <FaceSurfaceBody voice={voice} head={head} onIntent={onIntent} />;
});

const FaceSurfaceSeat = memo(
	function FaceSurfaceSeat({ store, onIntent }: FaceSurfaceProps) {
		// The host passes a new `onIntent` (and a dozen other props) on many of its renders. The surface needs none of that:
		// the latest intent is read through a ref, so the seat below re-renders for its own voice and for nothing the host does.
		const latest = useRef(onIntent);
		latest.current = onIntent;
		const intent = useCallback((i: Parameters<FaceSurfaceProps["onIntent"]>[0]) => latest.current(i), []);
		/** A surface the host seated has a `store`; without one there is nothing to talk through, and this says so. */
		if (store) return <Seated onIntent={intent} />;
		return (
			<div className="f2f-root" role="alert" style={{ display: "grid", placeItems: "center", padding: 24 }}>
				<style>{STYLES}</style>
				<div className="f2f-card">
					<h2>This build cannot seat surfaces</h2>
					<p>Face to face talks through the seat the host gives it, and this host did not give it one.</p>
					<p>Update the app, then open Face to face again.</p>
					<button type="button" className="f2f-btn" onClick={() => latest.current({ t: "mount", surface: "session" })}>
						Back to thread
					</button>
				</div>
			</div>
		);
	},
	// Memoised on the one prop it talks through: the host re-renders the fill with changed closures on most of its own
	// renders, and nothing here depends on those (the latest `onIntent` is read through a ref).
	(a, b) => a.store === b.store,
);

/** The workspace-surface fill (the bundle's default export stays a plain function component; the memo is the seat inside it). */
export default function FaceSurface(props: FaceSurfaceProps) {
	return <FaceSurfaceSeat {...props} />;
}
