// Getting the baked head into the page. A component bundle is fetched, hash-checked and imported from a
// Blob URL, so it has no file path of its own, and the engine's /plugin-assets route serves only
// allow-listed extensions (`.bin` is not one). The head therefore ships INSIDE the bundle as a base64 data
// URL (vite `?inline`, see head-source.ts) and is decoded here with no network round trip.
import { useEffect, useState } from "react";
import { decodeHead, type HeadAsset } from "../face/head-asset";

const BASE64_PREFIX = /^data:[^,;]*;base64,/;

export function dataUrlBytes(url: string): Uint8Array {
	const prefix = BASE64_PREFIX.exec(url);
	if (!prefix) throw new Error("the head asset is not a base64 data URL");
	const binary = atob(url.slice(prefix[0].length));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

const loading = new Map<string, Promise<HeadAsset>>();

/** Decode once per page per asset; a failure is not remembered, so the next mount tries again. */
export function loadHead(dataUrl: string): Promise<HeadAsset> {
	let started = loading.get(dataUrl);
	if (!started) {
		started = Promise.resolve().then(() => decodeHead(dataUrlBytes(dataUrl)));
		loading.set(dataUrl, started);
		const own = started;
		own.catch(() => {
			if (loading.get(dataUrl) === own) loading.delete(dataUrl);
		});
	}
	return started;
}

export type HeadState =
	| { status: "loading" }
	| { status: "ready"; asset: HeadAsset }
	| { status: "failed"; message: string };

export function useHead(dataUrl: string): HeadState {
	const [state, setState] = useState<HeadState>({ status: "loading" });
	useEffect(() => {
		let live = true;
		loadHead(dataUrl).then(
			(asset) => live && setState({ status: "ready", asset }),
			(error) => live && setState({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
		);
		return () => {
			live = false;
		};
	}, [dataUrl]);
	return state;
}
