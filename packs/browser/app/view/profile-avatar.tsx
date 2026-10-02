// A profile's face: its colour as a disc, with the emoji the person chose or the label's first letter. The same rule draws it in the
// chip, the menu, the start page and the dock panel (src/profile-look.ts). A browser that is not a profile (Private, your own Chrome)
// is the same disc in grey with a glyph.
import type { CSSProperties } from "react";
import { Icon, type IconName } from "@fraym/ui/icons";
import type { ProfileColour } from "../../src/profile-meta";
import { avatarGlyph, avatarStyle } from "../../src/profile-look";

export interface ProfileAvatarProps {
	readonly label: string;
	readonly colour: ProfileColour;
	readonly avatar?: string;
	/** A glyph instead of letters or an emoji. */
	readonly icon?: IconName;
	readonly size?: "sm" | "md" | "lg";
}

const GLYPH_PX = { sm: 12, md: 14, lg: 20 } as const;

export function ProfileAvatar({ label, colour, avatar, icon, size = "md" }: ProfileAvatarProps) {
	const emoji = avatar !== undefined && icon === undefined;
	return (
		<span className="bx-avatar" data-size={size} data-emoji={emoji ? "" : undefined} style={avatarStyle(colour, emoji) as CSSProperties} aria-hidden="true">
			{icon === undefined ? avatarGlyph(label, avatar) : <Icon name={icon} size={GLYPH_PX[size]} strokeWidth={2} />}
		</span>
	);
}
