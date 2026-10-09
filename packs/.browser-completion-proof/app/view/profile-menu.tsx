// Who this browser is, and the way to be someone else: the chip in the toolbar (avatar and name) and the menu under it. The menu is
// Chrome's: the profile you are in on top with where it is signed in, the others below it, and one click on another opens it here.
// A profile somebody else has open is shown, not hidden, with the reason it cannot be opened. Add profile happens inside the menu.
//
// It knows nothing about how the page is drawn. Everything it needs arrives as props, so the page area can be replaced by a native
// window later and this stays as it is.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import type { BrowserEngine, NewProfileRequest, OpenBrowserListing, ProfileConsent, ProfileHold, ProfileListing, ProfileSiteListing } from "../../src/contracts";
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

/** What a browser this chat holds is doing, in a row's words; the dot's colour says whether it is the person's or an agent's. */
function holdLine(hold: ProfileHold | undefined): { readonly line: string; readonly tone: "open" | "agent" } {
	if (hold?.takenOver) return { line: "You have control", tone: "open" };
	if (hold?.post) return { line: "A post is waiting for you", tone: "open" };
	if (hold?.task) return { line: "An agent task is running", tone: "agent" };
	if (hold?.by === "agent") return { line: "Your agent has it open", tone: "agent" };
	return { line: "Open here", tone: "open" };
}

/** What a row says about its profile, and whether the person can open it from here. */
export function profileStatus(profile: ProfileListing): { readonly line: string; readonly openable: boolean; readonly tone?: "open" | "agent" } {
	const { heldBy, hold } = profile;
	if (heldBy === null) return { line: signInSummary(profile.sites), openable: true };
	if (heldBy === "this chat") return { ...holdLine(hold), openable: true };
	return { line: heldBy === "human" ? "Open in another chat" : "In use by another chat", openable: false };
}

/** What closing a browser left open here costs, said on the button that does it. */
function closeTitle(hold: ProfileHold | undefined): string {
	if (hold?.post) return "Close it: the post waiting for you is discarded";
	if (hold?.task) return "Close it: the task stops";
	return "Close it";
}

/** What closing a browser would lose, as the question a row asks before it does it; nothing when closing loses only a page. */
function closeAsk(hold: ProfileHold | undefined): { readonly question: string; readonly confirm: string } | undefined {
	if (hold?.post && hold.task) return { question: "Discard the waiting post and stop the task?", confirm: "Discard and stop" };
	if (hold?.post) return { question: "Discard the post waiting for you?", confirm: "Discard post" };
	if (hold?.task) return { question: "Stop the running task?", confirm: "Stop task" };
	return undefined;
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
	/** An agent acted here a moment ago (the same fact the page's pill is drawn from). */
	readonly agentActive: boolean;
	/** The person may take the wheel: no task runs here and no post awaits confirmation. */
	readonly canTakeOver: boolean;
	/** The menu opened or closed: the page keeps its own floating cards out from under it. */
	readonly onMenu: (open: boolean) => void;
	/** The menu just opened: read the profiles again, who holds each changes. */
	readonly onOpen: () => void;
	/** The browsers this chat holds that are not saved profiles and are not the one on screen: a Private browser or Your Chrome left open. */
	readonly consents: readonly ProfileConsent[];
	readonly onConsent: (name: string, decision: "allow" | "deny" | "revoke", scope: "chat" | "loop", expectedSubject?: ProfileConsent["subject"]) => void;
	readonly browsers: readonly OpenBrowserListing[];
	/** Open `profile` here (`null`: a Private browser). */
	readonly onSwitch: (profile: string | null) => void;
	/** Show a browser that was left open. */
	readonly onSwitchBrowser: (browserId: string) => void;
	/** Close a browser that was left open. The menu stays, so several can be closed. */
	readonly onCloseOther: (browserId: string) => void;
	/** Create a profile and open it here. Rejects with the sentence to show. */
	readonly onAdd: (request: NewProfileRequest) => Promise<void>;
	readonly onTakeOver: () => void;
	readonly onHandBack: () => void;
}

/** Saved-profile authority belongs to the displayed subject, not an open browser. */
export function ProfileConsents({ consents, onConsent, menu = false }: Pick<ProfileSwitcherProps, "consents" | "onConsent"> & { readonly menu?: boolean }) {
	if (consents.length === 0) return null;
	return (
		<div className="bx-pmenu-list" role="group" aria-label="Agent profile access">
			{consents.map(request => (
				<div className="bx-pmenu-control bx-consent" key={`${request.name}:${request.scope}`}>
					<span className="bx-pmenu-control-text">
						{request.status === "granted" ? request.scope === "loop" ? `${request.loopLabel} has standing access` : "This chat has access" : "Agent requests access"} to {request.label}: {request.sites.filter(site => site.signedIn === true).map(site => `${site.site}${site.account ? ` (${site.account})` : ""}`).join(", ") || "No observed sign-ins"}
					</span>
					{request.status === "pending" ? (
						<>
							<button type="button" role={menu ? "menuitem" : undefined} className="bx-pmenu-control-btn" onClick={() => onConsent(request.name, "allow", "chat", request.subject)}>Allow this chat</button>
							{request.scope === "loop" && <button type="button" role={menu ? "menuitem" : undefined} className="bx-pmenu-control-btn" onClick={() => onConsent(request.name, "allow", "loop", request.subject)}>Always allow {request.loopLabel}</button>}
							<button type="button" role={menu ? "menuitem" : undefined} className="bx-pmenu-control-btn" onClick={() => onConsent(request.name, "deny", request.scope, request.subject)}>Deny</button>
						</>
					) : <button type="button" role={menu ? "menuitem" : undefined} className="bx-pmenu-control-btn" onClick={() => onConsent(request.name, "revoke", request.scope, request.subject)}>{request.scope === "loop" ? `Revoke ${request.loopLabel}` : "Revoke this chat"}</button>}
				</div>
			))}
		</div>
	);
}

export function ProfileSwitcher(props: ProfileSwitcherProps) {
	const { profile, look, engine, profiles, profilesError, switching, takenOver, agentActive, canTakeOver, onMenu } = props;
	const [open, setOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	/** The browser whose close is waiting for the person's yes (it would discard a post or stop a task). */
	const [asking, setAsking] = useState<string | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	/** Each close button by its browser, so focus can go back to it when the question is answered no. */
	const closers = useRef(new Map<string, HTMLButtonElement>());
	const identity = identityOf(profile, engine, look, profiles);

	const close = useCallback(() => {
		setOpen(false);
		setAdding(false);
		setAsking(null);
	}, []);
	// Escape answers a question first, then closes the form, and the menu on the next press.
	const onEscape = useCallback(() => {
		if (asking !== null) {
			setAsking(null);
			closers.current.get(asking)?.focus();
			return true;
		}
		if (!adding) return false;
		setAdding(false);
		return true;
	}, [adding, asking]);
	useMenu(open, close, wrapRef, { onEscape, ready: profiles !== null });
	useEffect(() => {
		onMenu(open);
		return () => onMenu(false);
	}, [open, onMenu]);

	const choose = (run: () => void) => () => {
		close();
		run();
	};
	const toggle = () => {
		if (!open) props.onOpen();
		setOpen(!open);
		setAdding(false);
		setAsking(null);
	};

	const busy = switching !== null;
	/** The close at the end of a row, and under the row the question it asks first when closing would lose a post or a task. */
	const closeOf = (browserId: string, label: string, hold: ProfileHold | undefined) => {
		const ask = closeAsk(hold);
		const asked = ask !== undefined && asking === browserId;
		return (
			<>
				<RowClose
					label={label}
					hold={hold}
					disabled={busy}
					asked={asked}
					buttonRef={el => {
						if (el === null) closers.current.delete(browserId);
						else closers.current.set(browserId, el);
					}}
					onClose={() => {
						if (ask === undefined) props.onCloseOther(browserId);
						else setAsking(asked ? null : browserId);
					}}
				/>
				{asked && (
					<CloseAsk
						label={label}
						ask={ask}
						disabled={busy}
						onKeep={() => {
							setAsking(null);
							closers.current.get(browserId)?.focus();
						}}
						onConfirm={() => {
							setAsking(null);
							props.onCloseOther(browserId);
						}}
					/>
				)}
			</>
		);
	};

	const others = offered(profiles ?? []).filter(candidate => identity.kind !== "profile" || candidate.name !== profile);
	// Focus lands on a profile, or on Add profile when none can be opened: never on Take over, so Enter pressed straight after
	// opening cannot pause the agent, whoever is listed and whatever has not loaded.
	const firstOpenable = profiles === null ? undefined : others.find(candidate => profileStatus(candidate).openable)?.name;
	const firstBrowser = profiles === null || firstOpenable !== undefined ? undefined : props.browsers[0]?.browserId;
	const showControl = takenOver || (agentActive && canTakeOver);

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

							{showControl && (
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

							<ProfileConsents consents={props.consents} onConsent={props.onConsent} menu />
							<div className="bx-menu-sep" role="separator" />

							<div className="bx-pmenu-list" role="group" aria-label="Other profiles">
								{profiles === null && profilesError === null && <p className="bx-pmenu-note">Loading profiles…</p>}
								{profilesError !== null && <p className="bx-pmenu-note" role="alert">Couldn't load your profiles ({profilesError}).</p>}
								{profiles !== null &&
									others.map(candidate => {
										const state = profileStatus(candidate);
										const pending = switching === candidate.name;
										return (
											<div className="bx-prow-wrap" role="none" key={candidate.name}>
												<button
													type="button"
													role="menuitemradio"
													aria-checked={false}
													className="bx-prow"
													data-tone={state.tone}
													data-menu-initial={candidate.name === firstOpenable ? "" : undefined}
													aria-disabled={!state.openable || busy}
													title={state.openable ? undefined : `${candidate.label}: ${state.line}`}
													onClick={() => {
														if (!state.openable || busy) return;
														close();
														props.onSwitch(candidate.name);
													}}
												>
													<ProfileAvatar label={candidate.label} colour={candidate.colour} avatar={candidate.avatar} />
													<span className="bx-prow-text">
														<span className="bx-prow-name">{candidate.label}</span>
														<span className="bx-prow-sub">{state.line}</span>
													</span>
													{pending ? <span className="bx-tab-spinner" aria-hidden="true" /> : state.tone !== undefined && <span className="bx-prow-dot" aria-hidden="true" />}
												</button>
												{candidate.browserId !== undefined && closeOf(candidate.browserId, candidate.label, candidate.hold)}
											</div>
										);
									})}
								{profiles !== null &&
									props.browsers.map(item => {
										const label = item.kind === "private" ? "Private browser" : "Your Chrome";
										const state = holdLine(item.hold);
										return (
											<div className="bx-prow-wrap" role="none" key={item.browserId}>
												<button
													type="button"
													role="menuitemradio"
													aria-checked={false}
													className="bx-prow"
													data-tone={state.tone}
													data-menu-initial={item.browserId === firstBrowser ? "" : undefined}
													aria-disabled={busy}
													onClick={() => {
														if (busy) return;
														close();
														props.onSwitchBrowser(item.browserId);
													}}
												>
													<ProfileAvatar label={label} colour="grey" icon={item.kind === "private" ? "shield" : "globe"} />
													<span className="bx-prow-text">
														<span className="bx-prow-name">{label}</span>
														<span className="bx-prow-sub">{state.line}</span>
													</span>
													<span className="bx-prow-dot" aria-hidden="true" />
												</button>
												{closeOf(item.browserId, label, item.hold)}
											</div>
										);
									})}
							</div>

							{/* Add profile and Private browser stay in view however many browsers are left open: the list above scrolls under them. */}
							<div className="bx-pmenu-foot" role="none">
								<div className="bx-menu-sep" role="separator" />
								<button type="button" role="menuitem" className="bx-menu-item" data-menu-initial={firstOpenable === undefined && firstBrowser === undefined ? "" : undefined} disabled={busy} onClick={() => setAdding(true)}>
									<Icon name="plus" size={14} strokeWidth={2} />
									Add profile
								</button>
								{identity.kind !== "private" && (
									<button type="button" role="menuitem" className="bx-menu-item" disabled={busy} onClick={choose(() => props.onSwitch(null))}>
										<Icon name="shield" size={14} strokeWidth={2} />
										Private browser
									</button>
								)}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** The close button at the end of a row whose browser was left open: pressing it closes that browser, not the one on screen, or asks first (`asked`: the question is showing). */
function RowClose({ label, hold, disabled, asked, buttonRef, onClose }: { readonly label: string; readonly hold: ProfileHold | undefined; readonly disabled: boolean; readonly asked: boolean; readonly buttonRef: (el: HTMLButtonElement | null) => void; readonly onClose: () => void }) {
	return (
		<button type="button" role="menuitem" ref={buttonRef} className="bx-prow-close" aria-label={`Close ${label}`} aria-expanded={closeAsk(hold) === undefined ? undefined : asked} title={closeTitle(hold)} disabled={disabled} onClick={onClose}>
			<Icon name="x" size={13} strokeWidth={2.25} />
		</button>
	);
}

/** Under a row: what its close would lose, and the two answers. Focus lands on Keep, so Enter pressed straight after asking keeps what is there. */
function CloseAsk({ label, ask, disabled, onKeep, onConfirm }: { readonly label: string; readonly ask: { readonly question: string; readonly confirm: string }; readonly disabled: boolean; readonly onKeep: () => void; readonly onConfirm: () => void }) {
	const keep = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		keep.current?.focus();
	}, []);
	return (
		<div className="bx-prow-ask" role="group" aria-label={`${label}: ${ask.question}`}>
			<span className="bx-prow-ask-text">{ask.question}</span>
			<span className="bx-prow-ask-actions">
				<button type="button" role="menuitem" ref={keep} className="bx-pmenu-control-btn" onClick={onKeep}>
					Keep
				</button>
				<button type="button" role="menuitem" className="bx-pmenu-control-btn" data-danger="" disabled={disabled} onClick={onConfirm}>
					{ask.confirm}
				</button>
			</span>
		</div>
	);
}
