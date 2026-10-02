// Where the ElevenLabs API key comes from. The key never leaves this module except as the header
// of a request to ElevenLabs: it is not logged, not put in a URL, not echoed in an error.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./protocol.js";

/**
 * The connect form's target, relative to the user's home (the same `~` `connect.configTarget` in
 * plugin.json expands). MUST match it. The connect template writes `{ "access": "<key>" }`, the
 * house shape for form connectors; a hand-written file uses the same one.
 */
export const KEY_FILE = join(".config", "dimension-speech", "elevenlabs.json");

/** `ELEVENLABS_API_KEY` from the session's environment, else the connect form's file. */
export async function resolveApiKey(
	env: Readonly<Record<string, string | undefined>>,
	userHome: string,
): Promise<string | undefined> {
	const fromEnv = env.ELEVENLABS_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const stored: unknown = JSON.parse(await readFile(join(userHome, KEY_FILE), "utf8"));
		if (isRecord(stored) && typeof stored.access === "string" && stored.access.trim()) return stored.access.trim();
	} catch {
		// Not connected, or unreadable. A parse error would quote the file, which holds the key, so
		// it is never passed on: the provider simply reports it needs a key.
	}
	return undefined;
}
