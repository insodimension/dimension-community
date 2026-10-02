// Who this browser is, and the way to be someone else: the chip in the toolbar (avatar and name) and the menu under it. The menu is
// Chrome's: the profile you are in on top with where it is signed in, the others below it, and one click on another opens it here.
// A profile somebody else has open is shown, not hidden, with the reason it cannot be opened. Add profile happens inside the menu.
//
// It knows nothing about how the page is drawn. Everything it needs arrives as props, so the page area can be replaced by a native
// window later and this stays as it is.
import { useCallback, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import type { BrowserEngine, NewProfileRequest, ProfileListing, ProfileSiteListing } from "../../src/contracts";
import { defaultColour, type ProfileColour, type ResolvedProfileMeta, resolveProfileMeta } from "../../src/profile-meta";
import { DEFAULT_PROFILE } from "../../src/profile-name";
import { AddProfileForm } from "./add-profile-form";
import { ProfileAvatar } from "./profile-avatar";
import { useMenu } from "./use-menu";

/** What the chip shows for the browser on screen. */
export interface Identity {
	readonly kind: "profile" | "private" | "chrome";
	readonly label: string;
	readonly colour: ProfileColour;
	readonly avatar?: string;
	/** One line under the name; null until it is known (the profiles have not loaded). */
	readonly detail: string | null;
}

/** "Signed in to google.com, x.com +2": only what was seen signed in, newest first, never more than two named. */
export function signInSummary(sites: readonly ProfileSiteListing[]): string {
	const signedIn = sites.filter(site => site.signedIn === true).map(site => site.site);
	if (signedIn.length === 0) return "No sign-ins yet";
	const named = signedIn.slice(0, 2).join(", ");
	return signedIn.length > 2 ? `Signed in to ${named} +${signedIn.length - 2}` : `Signed in to ${named}`;
}

/** The profiles as a person is offered them: the implicit Default always there, first; the rest by name. */
export function offered(profiles: readonly ProfileListing[]): ProfileListing[] {
	const fallback: ProfileListing = { name: DEFAULT_PROFILE, label: "Default", colour: defaultColour(DEFAULT_PROFILE), heldBy: null, sites: [] };
	const all = profiles.some(profile => profile.name === DEFAULT_PROFILE) ? [...profiles] : [fallback, ...profiles];
	return all.sort((a, b) => (a.name === DEFAULT_PROFILE ? -1 : b.name === DEFAULT_PROFILE ? 1 : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })));
}

/** The browser on screen as the chip shows it. `look` is its profile's own face, carried by its state; the sign-ins are read from the listing, and unknown until it loads. */
export function identityOf(profile: string | null, engine: BrowserEngine, look: ResolvedProfileMeta | null, profiles: readonly ProfileListing[] | null): Identity {
	if (engine === "chrome-relay") return { kind: "chrome", label: "Your Chrome", colour: "grey", detail: "Signed in as you" };
	if (profile === null) return { kind: "private", label: "Private", colour: "grey", detail: "Nothing is saved" };
	const listed = profiles?.find(candidate => candidate.name === profile);
	const { label, colour, avatar } = look ?? resolveProfileMeta(profile, listed === undefined ? {} : { label: listed.label, colour: listed.colour, avatar: listed.avatar });
	return { kind: "profile", label, colour, ...(avatar === undefined ? {} : { avatar }), detail: profiles === null ? null : signInSummary(listed?.sites ?? []) };
}

/** What a row says about its profile, and whether the person can open it from here. */
export function profileStatus(profile: ProfileListing): { readonly line: string; readonly openable: boolean; readonly tone?: "open" | "agent" } {
	const { heldBy, hold } = profile;
	if (heldBy === null) return { line: signInSummary(profile.sites), openable: true };
	if (heldBy === "this chat") {
		if (hold?.takenOver) return { line: "You have control", openable: true, tone: "open" };
		if (hold?.task) return { line: "An agent task is running", openable: true, tone: "agent" };
		if (hold?.by === "agent") return { line: "Your agent has it open", openable: true, tone: "agent" };
		return { line: "Open here", openable: true, tone: "open" };
	}
	return { line: heldBy === "human" ? "Open in another chat" : "In use by another chat", openable: false };
}

export interface ProfileSwitcherProps {
	readonly profile: string | null;
	/** How that profile looks, as the browser's state carries it; null for a throwaway browser and your own Chrome. */
	readonly look: ResolvedProfileMeta | null;
	readonly engine: BrowserEngine;
	/** null while they load */
	readonly profiles: readonly ProfileListing[] | null;
	readonly profilesError: string | null;
	/** The profile being opened right now (`""`: a Private one), or null. */
	readonly switching: string | null;
	readonly takenOver: boolean;
	/** The person may take the wheel: no task runs here and no post awaits confirmation. */
	readonly canTakeOver: boolean;
	/** The menu just opened: read the profiles again, who holds each changes. */
	readonly onOpen: () => void;
	/** Open `profile` here (`null`: a Private browser). */
	readonly onSwitch: (profile: string | null) => void;
	/** Create a profile and open it here. Rejects with the sentence to show. */
	readonly onAdd: (request: NewProfileRequest) => Promise<void>;
	readonly onTakeOver: () => void;
	readonly onHandBack: () => void;
}

export function ProfileSwitcher(props: ProfileSwitcherProps) {
	const { profile, look, engine, profiles, profilesError, switching, takenOver, canTakeOver } = props;
	const [open, setOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const identity = identityOf(profile, engine, look, profiles);

	const close = useCallback(() => {
		setOpen(false);
		setAdding(false);
	}, []);
	// Escape closes the form first, the menu on the second press.
	const onEscape = useCallback(() => {
		if (!adding) return false;
		setAdding(false);
		return true;
	}, [adding]);
	useMenu(open, close, wrapRef, { onEscape });

	const choose = (run: () => void) => () => {
		close();
		run();
	};
	const toggle = () => {
		if (!open) props.onOpen();
		setOpen(!open);
		setAdding(false);
	};

	const others = offered(profiles ?? []).filter(candidate => identity.kind !== "profile" || candidate.name !== profile);
	const busy = switching !== null;
	// Focus lands on a profile, not on Take over: Enter pressed straight after opening must never pause the agent.
	const firstOpenable = others.find(candidate => profileStatus(candidate).openable)?.name;

	return (
		<div className="bx-profile-wrap" ref={wrapRef}>
			<button
				type="button"
				className="bx-profile"
				data-state={takenOver ? "driving" : undefined}
				title={identity.detail === null ? identity.label : `${identity.label} · ${identity.detail}`}
				aria-label={identity.detail === null ? `${identity.label} — profiles` : `${identity.label}, ${identity.detail} — profiles`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={toggle}
			>
				<ProfileAvatar label={identity.label} colour={identity.colour} avatar={identity.avatar} icon={identity.kind === "private" ? "shield" : identity.kind === "chrome" ? "globe" : undefined} size="sm" />
				<span className="bx-profile-name">{identity.label}</span>
				<Icon name="caretD" size={12} strokeWidth={2.25} />
			</button>

			{open && (
				<div className="bx-pmenu" role={adding ? "dialog" : "menu"} aria-label={adding ? "New profile" : "Profiles"}>
					{adding ? (
						<AddProfileForm
							taken={offered(profiles ?? []).map(candidate => ({ slug: candidate.name, label: candidate.label, colour: candidate.colour }))}
							onSubmit={async request => {
								await props.onAdd(request);
								close();
							}}
							onCancel={() => setAdding(false)}
						/>
					) : (
						<>
							<div className="bx-pmenu-head" aria-current="true">
								<ProfileAvatar label={identity.label} colour={identity.colour} avatar={identity.avatar} icon={identity.kind === "private" ? "shield" : identity.kind === "chrome" ? "globe" : undefined} size="lg" />
								<span className="bx-pmenu-who">
									<span className="bx-pmenu-name">{identity.label}</span>
									<span className="bx-pmenu-detail">{identity.detail ?? "Checking sign-ins…"}</span>
								</span>
							</div>

							{(takenOver || canTakeOver) && (
								<div className="bx-pmenu-control" data-on={takenOver || undefined}>
									<span className="bx-pmenu-control-text">
										<Icon name="hand" size={14} strokeWidth={2} />
										{takenOver ? "You have control. Your agent is paused." : "Your agent can act here."}
									</span>
									<button type="button" role="menuitem" className="bx-pmenu-control-btn" onClick={choose(takenOver ? props.onHandBack : props.onTakeOver)}>
										{takenOver ? "Hand back" : "Take over"}
									</button>
								</div>
							)}

							<div className="bx-menu-sep" role="separator" />

							<div className="bx-pmenu-list" role="group" aria-label="Other profiles">
								{profiles === null && profilesError === null && <p className="bx-pmenu-note">Loading profiles…</p>}
								{profilesError !== null && <p className="bx-pmenu-note" role="alert">Couldn't load your profiles ({profilesError}).</p>}
								{profiles !== null &&
									others.map(candidate => {
										const state = profileStatus(candidate);
										const pending = switching === candidate.name;
										return (
											<button
												key={candidate.name}
												type="button"
												role="menuitemradio"
												aria-checked={false}
												className="bx-prow"
												data-tone={state.tone}
												data-menu-initial={candidate.name === firstOpenable ? "" : undefined}
												disabled={!state.openable || busy}
												title={state.openable ? undefined : `${candidate.label}: ${state.line}`}
												onClick={choose(() => props.onSwitch(candidate.name))}
											>
												<ProfileAvatar label={candidate.label} colour={candidate.colour} avatar={candidate.avatar} />
												<span className="bx-prow-text">
													<span className="bx-prow-name">{candidate.label}</span>
													<span className="bx-prow-sub">{state.line}</span>
												</span>
												{pending ? <span className="bx-tab-spinner" aria-hidden="true" /> : state.tone !== undefined && <span className="bx-prow-dot" aria-hidden="true" />}
											</button>
										);
									})}
							</div>

							<div className="bx-menu-sep" role="separator" />

							<button type="button" role="menuitem" className="bx-menu-item" disabled={busy} onClick={() => setAdding(true)}>
								<Icon name="plus" size={14} strokeWidth={2} />
								Add profile
							</button>
							{identity.kind !== "private" && (
								<button type="button" role="menuitem" className="bx-menu-item" disabled={busy} onClick={choose(() => props.onSwitch(null))}>
									<Icon name="shield" size={14} strokeWidth={2} />
									Private browser
								</button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
