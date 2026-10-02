// Pure microphone logic for the surface: how a device is named to a person, what the input menu lists and
// which entry is the live one, and the sentence for a microphone that delivers only silence. No React, no DOM.
import type { FaceVoice } from "./voice";

export type MicFacts = Pick<FaceVoice, "micDevices" | "micDeviceId" | "micLabel">;

export interface MicMenuItem {
	readonly id: string;
	readonly label: string;
	readonly checked: boolean;
}

/** Chrome lists every system default twice more, under virtual ids, with these label prefixes. */
const ALIAS_PREFIX = /^(default|communications)\s*-\s*/i;
/** A driver's channel name appended to the device's ("INZONE H9 II - Chat"): not part of what the device is called. */
const CHANNEL_SUFFIX = /\s+-\s+(chat|game|media|aux)$/i;

/**
 * What to call a device in a sentence: "Default - Headset Microphone (INZONE H9 II - Chat)" is "INZONE H9 II".
 * The label's generic front ("Headset Microphone") and the OS's alias and numbering noise go; a label with
 * none of that is returned as it is. Undefined when there is no label to go on.
 */
export function micName(label: string | undefined): string | undefined {
	let name = label?.trim().replace(ALIAS_PREFIX, "");
	if (!name) return undefined;
	const inner = /^.+?\s\((.+)\)$/.exec(name)?.[1];
	if (inner) name = inner;
	name = name.replace(/^\d+-\s*/, "").replace(CHANNEL_SUFFIX, "").trim();
	return name || undefined;
}

/** The warning for a microphone that has delivered nothing but silence. */
export function micSilentNotice(label: string | undefined): string {
	return `No sound from ${micName(label) ?? "your microphone"}. Pick another microphone.`;
}

/**
 * The entries of the input menu, the live one checked. The browser's own "communications" alias is left
 * out (it repeats the default); the default entry says what it currently resolves to. The live entry is found
 * by the id the capture reports, then by its label; with no capture and no choice it is the system default.
 */
export function describeMicMenu(v: MicFacts): MicMenuItem[] {
	const devices = v.micDevices.filter(device => device.id !== "communications");
	const byId = v.micDeviceId === undefined ? undefined : devices.find(device => device.id === v.micDeviceId);
	const byLabel = v.micLabel === undefined ? undefined : devices.find(device => device.label === v.micLabel);
	const fallback = v.micDeviceId === undefined ? devices.find(device => device.id === "default") : undefined;
	const live = byId ?? byLabel ?? fallback;
	return devices.map(device => {
		const rest = device.label.replace(ALIAS_PREFIX, "");
		const label = device.id === "default" ? (rest ? `System default \u00b7 ${rest}` : "System default") : device.label;
		return { id: device.id, label, checked: device === live };
	});
}
