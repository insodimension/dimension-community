/**
 * How a profile is drawn — the ONE rule the View's chip and menu and the dock panel share, so a profile has the same
 * face in all of them. Pure and dependency-free like profile-meta.ts (the dock runs in the host's page, which does not
 * load the View's stylesheet — so the colours are inline styles built here, not CSS classes).
 *
 * A profile's colour is one of the eight names in profile-meta.ts. Here each name becomes an OKLCH hue and chroma, so
 * "blue" is blue in a dark theme and a light one, and `grey` is the only colourless one. An avatar is the one emoji
 * the person chose, else the first letter of the label.
 */
import type { ProfileColour } from "./profile-meta.js";

/** OKLCH hue (degrees) and chroma of each named colour. */
export const PROFILE_LOOK: Record<ProfileColour, { readonly hue: number; readonly chroma: number }> = {
	blue: { hue: 255, chroma: 0.15 },
	orange: { hue: 55, chroma: 0.16 },
	green: { hue: 150, chroma: 0.14 },
	red: { hue: 25, chroma: 0.18 },
	purple: { hue: 300, chroma: 0.16 },
	pink: { hue: 350, chroma: 0.16 },
	teal: { hue: 195, chroma: 0.11 },
	grey: { hue: 260, chroma: 0.015 },
};

/**
 * The inline style of an avatar disc. A letter sits on the colour as a soft diagonal gradient, in white; an emoji keeps its
 * own colours and sits on a tint of the profile's colour, ringed in it. Sizes, centring and type are the host's.
 */
export function avatarStyle(colour: ProfileColour, emoji: boolean): Record<string, string> {
	const { hue, chroma } = PROFILE_LOOK[colour];
	if (emoji) {
		return {
			background: `color-mix(in oklab, oklch(0.62 ${chroma} ${hue}) 20%, var(--fr-surface))`,
			boxShadow: `inset 0 0 0 1.5px oklch(0.62 ${chroma} ${hue} / 0.7)`,
		};
	}
	return {
		color: "oklch(0.99 0 0)",
		background: `linear-gradient(150deg, oklch(0.64 ${chroma} ${hue}), oklch(0.5 ${chroma} ${hue + 22}))`,
		boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.2)",
	};
}

/** What an avatar disc shows: the chosen emoji, else the label's first letter or number, upper-case. */
export function avatarGlyph(label: string, avatar?: string): string {
	if (avatar !== undefined && avatar.length > 0) return avatar;
	const first = [...label.trim()].find((char) => /[\p{L}\p{N}]/u.test(char));
	return first === undefined ? "?" : first.toUpperCase();
}

/** Emoji offered when adding a profile: a spread of things a person keeps apart (work, home, money, fun, a project). */
export const AVATAR_CHOICES = ["💼", "🏠", "🎮", "🎓", "🛒", "💡", "🎧", "🌱", "✈️", "🧪"] as const;
