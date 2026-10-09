// Adding a profile, where the person already is: a name, a colour and an avatar, with the profile drawn as it will look. Used in the
// profile menu and on the start page. The name is checked by the shared rule (profile-meta.ts `checkNewProfile`) while they type, and
// the runtime checks it again; whichever sentence comes back is shown under the field.
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import type { NewProfileRequest } from "../../src/contracts";
import { AVATAR_CHOICES, avatarStyle } from "../../src/profile-look";
import { checkNewProfile, PROFILE_COLOURS, type ProfileColour } from "../../src/profile-meta";
import { failureText } from "./browser-client";
import { ProfileAvatar } from "./profile-avatar";

export interface AddProfileFormProps {
	/** Every profile that exists: the names the new one may not take, and the colours already used. */
	readonly taken: readonly { readonly slug: string; readonly label: string; readonly colour: ProfileColour }[];
	/** Resolves once the profile exists; rejects with the sentence to show when it could not be made. */
	readonly onSubmit: (request: NewProfileRequest) => Promise<void>;
	readonly onCancel: () => void;
}

export function AddProfileForm({ taken, onSubmit, onCancel }: AddProfileFormProps) {
	const id = useId();
	const nameRef = useRef<HTMLInputElement | null>(null);
	const mountedRef = useRef(true);
	// A colour nobody has yet, so profiles are told apart at a glance without anyone choosing.
	const unused = PROFILE_COLOURS.find(colour => !taken.some(profile => profile.colour === colour)) ?? PROFILE_COLOURS[taken.length % PROFILE_COLOURS.length] ?? "blue";
	const [name, setName] = useState("");
	const [colour, setColour] = useState<ProfileColour>(unused);
	const [avatar, setAvatar] = useState<string | undefined>(undefined);
	const [attempted, setAttempted] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		mountedRef.current = true;
		nameRef.current?.focus();
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const check = checkNewProfile(name, taken);
	// Nothing is said about an empty field until they try to add: a blank box is not a mistake yet.
	const problem = refusal ?? (check.ok || (name.trim().length === 0 && !attempted) ? null : check.problem);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setAttempted(true);
		if (!check.ok || busy) return;
		setBusy(true);
		setRefusal(null);
		try {
			await onSubmit({ name: check.label, colour, ...(avatar === undefined ? {} : { avatar }) });
		} catch (cause) {
			if (mountedRef.current) setRefusal(failureText(cause));
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};

	const shown = check.ok ? check.label : name.trim();
	return (
		<form
			className="bx-add"
			onSubmit={event => void submit(event)}
			// Escape backs out wherever the form is mounted (the start page has no menu to do it); not while the profile is being made.
			onKeyDown={event => {
				if (event.key !== "Escape" || busy) return;
				event.preventDefault();
				event.stopPropagation();
				onCancel();
			}}
			aria-label="New profile"
		>
			<div className="bx-add-head">
				<button type="button" className="bx-tb" aria-label="Back to profiles" onClick={onCancel}>
					<Icon name="back" size={15} strokeWidth={2} />
				</button>
				<h2 className="bx-add-title">New profile</h2>
			</div>

			<div className="bx-add-name">
				<ProfileAvatar label={shown.length > 0 ? shown : "New"} colour={colour} avatar={avatar} size="lg" />
				<div className="bx-add-field">
					<input
						ref={nameRef}
						className="bx-add-input"
						value={name}
						placeholder="Profile name, like Work"
						aria-label="Profile name"
						aria-invalid={problem !== null || undefined}
						aria-describedby={problem === null ? undefined : `${id}-problem`}
						maxLength={64}
						autoComplete="off"
						spellCheck={false}
						onChange={event => {
							setName(event.target.value);
							setRefusal(null);
						}}
					/>
					{problem !== null && (
						<p className="bx-add-problem" id={`${id}-problem`} role="alert">
							{problem}
						</p>
					)}
				</div>
			</div>

			<div className="bx-add-row">
				<span className="bx-add-label" id={`${id}-colour`}>
					Colour
				</span>
				<div className="bx-swatches" role="radiogroup" aria-labelledby={`${id}-colour`}>
					{PROFILE_COLOURS.map(option => (
						<button key={option} type="button" role="radio" aria-checked={colour === option} aria-label={option} title={option} className="bx-swatch" style={{ background: avatarStyle(option, false).background }} onClick={() => setColour(option)}>
							{colour === option && <Icon name="check" size={12} strokeWidth={3} />}
						</button>
					))}
				</div>
			</div>

			<div className="bx-add-row">
				<span className="bx-add-label" id={`${id}-avatar`}>
					Avatar
				</span>
				<div className="bx-avatars" role="radiogroup" aria-labelledby={`${id}-avatar`}>
					<button type="button" role="radio" aria-checked={avatar === undefined} aria-label="Initial" title="Initial" className="bx-avatar-pick" onClick={() => setAvatar(undefined)}>
						Aa
					</button>
					{AVATAR_CHOICES.map(option => (
						<button key={option} type="button" role="radio" aria-checked={avatar === option} aria-label={option} className="bx-avatar-pick" onClick={() => setAvatar(option)}>
							{option}
						</button>
					))}
				</div>
			</div>

			<div className="bx-add-foot">
				<button type="button" className="bx-add-cancel" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="bx-add-submit" disabled={busy}>
					{busy ? "Adding…" : "Add profile"}
				</button>
			</div>
		</form>
	);
}
