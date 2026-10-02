/**
 * What a person calls a saved profile, and how a profile's sign-in observations
 * are read — the ONE rule the agent's list (`browser_profiles`), the host
 * connection report and the dock panel share.
 *
 * Pure and dependency-free on purpose, like profile-name.ts: the dock panel
 * runs in the host's page, so it cannot reach this through store.ts
 * (node:fs). The slug (profile-name.ts) names the folder and never changes;
 * the label, colour and avatar here are separate, free to edit, and optional:
 * a profile with no metadata file gets defaults derived from its slug.
 */
import { DEFAULT_PROFILE, loginSetLabel, RELAY_PROFILE } from "./profile-name.js";

/** The fixed palette. A colour is one of these names, never a free value. */
export const PROFILE_COLOURS = ["blue", "orange", "green", "red", "purple", "pink", "teal", "grey"] as const;
export type ProfileColour = (typeof PROFILE_COLOURS)[number];

/** The longest label, in characters, after trimming. */
export const MAX_LABEL_CHARS = 48;

/** What a profile's metadata file holds. Every field is optional; a bad one is dropped, never trusted. */
export interface StoredProfileMeta {
	label?: string;
	colour?: ProfileColour;
	/** One emoji. Absent: the View draws the label's first letter. */
	avatar?: string;
	/** Epoch ms of the last open or close. */
	lastUsed?: number;
	/** The browser application that last ran this profile (`chrome`, `msedge`, ...): its cookies are encrypted for that build. */
	app?: string;
}

/** A profile as a person sees it: always a label and a colour. */
export interface ResolvedProfileMeta {
	label: string;
	colour: ProfileColour;
	avatar?: string;
}

/** `raw` as a label: trimmed, inner whitespace collapsed, control characters removed; undefined when blank or too long. */
export function cleanLabel(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	const label = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	// Characters, not UTF-16 units: an emoji or a letter outside the BMP is one character to the person and to the length rule in `checkNewProfile`.
	const characters = [...label].length;
	return characters > 0 && characters <= MAX_LABEL_CHARS ? label : undefined;
}

/** One emoji (a ZWJ sequence or a variation selector counts as one), or undefined. */
const EMOJI = /^\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*$/u;
export function cleanAvatar(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length <= 16 && EMOJI.test(raw) ? raw : undefined;
}

export function isProfileColour(raw: unknown): raw is ProfileColour {
	return typeof raw === "string" && (PROFILE_COLOURS as readonly string[]).includes(raw);
}

/** A stable colour for a slug with none chosen: the same slug is always the same colour. */
export function defaultColour(slug: string): ProfileColour {
	let hash = 0;
	for (let i = 0; i < slug.length; i += 1) hash = (Math.imul(hash, 31) + slug.charCodeAt(i)) >>> 0;
	return PROFILE_COLOURS[hash % PROFILE_COLOURS.length] as ProfileColour;
}

/** `slug`'s label, colour and avatar: what was stored, else what the slug gives. */
export function resolveProfileMeta(slug: string, stored: StoredProfileMeta = {}): ResolvedProfileMeta {
	return {
		label: cleanLabel(stored.label) ?? loginSetLabel(slug),
		colour: isProfileColour(stored.colour) ? stored.colour : defaultColour(slug),
		...(cleanAvatar(stored.avatar) === undefined ? {} : { avatar: stored.avatar }),
	};
}

const fold = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The profiles `query` names, ignoring case and surrounding or repeated
 * spaces. A slug is a folder name, so it is unique: an exact slug names its
 * own profile and nothing else, however another profile is labelled (else a
 * label equal to a slug would make that profile impossible to open, `default`
 * included). Only when no slug is the query is it matched against labels, where
 * two profiles that differ only by case are both returned and the caller says
 * so. Nothing is ever the "closest": no match is empty.
 */
export function matchProfiles<T extends { slug: string; label: string }>(query: string, profiles: readonly T[]): T[] {
	const wanted = fold(query);
	if (wanted.length === 0) return [];
	const named = profiles.find((profile) => profile.slug === wanted);
	return named === undefined ? profiles.filter((profile) => fold(profile.label) === wanted) : [named];
}

/** A folder name Windows reserves for a device: a profile folder cannot be called this there. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** Characters a path cannot carry. A name with one is refused, not rewritten: it is a mistake, not a style. */
const PATH_UNSAFE = /[\\/:*?"<>|]/;

/** The folder name a label gives: lower-case ASCII letters and digits joined by `-`, at most 48; empty when the label has none. */
function slugOf(label: string): string {
	const ascii = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
	return ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
}

/** A short stable tag for a label that gives no ASCII slug (a name in another script). */
function tagOf(label: string): string {
	let hash = 0;
	for (const char of label) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
	return `p-${hash.toString(36)}`;
}

export type NewProfileCheck = { readonly ok: true; readonly slug: string; readonly label: string } | { readonly ok: false; readonly problem: string };

/**
 * The name a person typed for a NEW profile: the label it will be shown as and the folder it will live in, or a
 * plain sentence saying why not. Only the label is theirs: a name may hold spaces, capitals and any script (up to
 * 48 characters), and the folder is derived from it and made unique, so it never needs to be understood. A name that
 * could be a path (a separator, a drive colon, a leading dot), is blank, or has no letter or number at all is refused.
 * Names are unique, ignoring case and spacing, against both the labels and the folder names already taken (and the
 * implicit `default`), because an agent opens a profile by either and must never have two answers.
 *
 * `taken` is every profile that exists. Pure and dependency-free, like the rest of this file: the View checks while
 * a person types, and the runtime checks again before it creates anything.
 */
export function checkNewProfile(raw: string, taken: readonly { slug: string; label: string }[]): NewProfileCheck {
	const typed = raw.replace(/\s+/g, " ").trim();
	if (typed.length === 0) return { ok: false, problem: "Give the profile a name." };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not kept
	if (PATH_UNSAFE.test(typed) || /[\u0000-\u001f\u007f]/.test(typed) || typed.startsWith(".")) {
		return { ok: false, problem: "A name can't contain \\ / : * ? \" < > | or start with a dot." };
	}
	if ([...typed].length > MAX_LABEL_CHARS) return { ok: false, problem: `Use ${MAX_LABEL_CHARS} characters or fewer.` };
	if (!/[\p{L}\p{N}]/u.test(typed)) return { ok: false, problem: "Use at least one letter or number." };
	const label = cleanLabel(typed);
	if (label === undefined) return { ok: false, problem: "Give the profile a name." };
	const wanted = fold(label);
	const slugs = new Set<string>([DEFAULT_PROFILE, ...taken.map((profile) => profile.slug)]);
	const names = new Set<string>([...slugs, ...taken.map((profile) => fold(profile.label)), fold(loginSetLabel(DEFAULT_PROFILE))]);
	if (wanted === RELAY_PROFILE || DEVICE_NAME.test(wanted)) return { ok: false, problem: "That name is reserved. Pick another." };
	if (names.has(wanted)) return { ok: false, problem: "You already have a profile with that name." };
	const base = slugOf(label);
	const stem = base.length > 0 && !DEVICE_NAME.test(base) && base !== RELAY_PROFILE ? base : tagOf(label);
	let slug = stem;
	for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${stem.slice(0, 44)}-${suffix}`;
	return { ok: true, slug, label };
}

/** A sign-in observation older than this is not evidence of anything now. */
export const SIGNED_IN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far ahead of this clock an observation's time may be (two clocks, a resume) and still count as now. */
const CLOCK_SKEW_MS = 60_000;

/**
 * What an observation says NOW. `null` is "not known": the site was visited but
 * never checked, the check is over 7 days old, or its time is in the future
 * (a wrong clock or a copied file: a sign-in is not claimed for days that have
 * not happened). Signed in is never claimed from old data (nor signed out: a
 * session may have been renewed since).
 */
export function effectiveSignedIn(signedIn: boolean | null, observedAt: number, now: number): boolean | null {
	const age = now - observedAt;
	return signedIn !== null && age >= -CLOCK_SKEW_MS && age <= SIGNED_IN_MAX_AGE_MS ? signedIn : null;
}
