// The two "nothing here yet" surfaces. `StartPage` is what the View shows
// before a browser exists — and again after one ends: an address to open, and
// ONE folded row of choices about how. `BlankTab` covers a tab that is still at
// about:blank — a page with nothing on it is asked for an address, not shown as
// a white rectangle.
//
// A person's browser keeps their sign-ins (the profile named `default`, shown
// as Default) unless they ask for a private one; the other profiles, adding
// one, and their own Chrome sit inside "Options". The profiles are drawn and
// added exactly as in the toolbar's profile menu.
import { type ReactNode, useId, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import type { NewProfileRequest, ProfileListing } from "../../src/contracts";
import { DEFAULT_PROFILE } from "../../src/profile-name";
import { AddProfileForm } from "./add-profile-form";
import { Overlays } from "./page-view";
import { ProfileAvatar } from "./profile-avatar";
import { offered, profileStatus } from "./profile-menu";
import { Omnibox, type OmniboxHandle } from "./toolbar";

export interface StartPageProps {
	/** The profiles that exist; null while they load. */
	readonly profiles: readonly ProfileListing[] | null;
	readonly profilesError: string | null;
	/** The profile (by name) the next browser opens with. */
	readonly profile: string;
	/** Open with nothing saved. */
	readonly isPrivate: boolean;
	/** Open in the Chrome the person is already signed in to. */
	readonly ownChrome: boolean;
	readonly opening: boolean;
	readonly error: string | null;
	/** The last browser ended: say so once, calmly, above the address. */
	readonly closed: boolean;
	readonly onProfile: (name: string) => void;
	readonly onPrivate: (on: boolean) => void;
	readonly onOwnChrome: (on: boolean) => void;
	/** Make a profile and pick it for the next browser. Rejects with the sentence to show. */
	readonly onAddProfile: (request: NewProfileRequest) => Promise<void>;
	/** Open with an address (may be empty: a blank tab). */
	readonly onOpen: (url: string) => void;
}

export function StartPage({ profiles, profilesError, profile, isPrivate, ownChrome, opening, error, closed, onProfile, onPrivate, onOwnChrome, onAddProfile, onOpen }: StartPageProps) {
	const [expanded, setExpanded] = useState(false);
	const [adding, setAdding] = useState(false);
	const omniRef = useRef<OmniboxHandle | null>(null);
	const panelId = useId();

	// The implicit Default needs no picker: it appears once there is a second profile to pick.
	const choices = offered(profiles ?? []);
	const picking = choices.length > 1;
	const choosable = !opening && !isPrivate && !ownChrome;
	const chosen = choices.find(candidate => candidate.name === profile);

	const summary = ownChrome ? "Your Chrome" : isPrivate ? "Private" : chosen !== undefined && chosen.name !== DEFAULT_PROFILE ? `Profile: ${chosen.label}` : null;

	return (
		<div className="bx-start" data-busy={opening || undefined}>
			<div className="bx-start-glow" aria-hidden="true" />
			<div className="bx-start-body">
				{closed && (
					<p className="bx-start-closed" role="status">
						This browser was closed.
					</p>
				)}

				<header className="bx-start-head">
					<span className="bx-start-mark" aria-hidden="true">
						<Icon name="globe" size={22} strokeWidth={1.6} />
					</span>
					<h1>Open a page</h1>
					<p>A browser you and your agent share — you both see the same page.</p>
				</header>

				<div className="bx-start-omni">
					<Omnibox
						ref={omniRef}
						url=""
						loading={false}
						disabled={opening}
						size="hero"
						placeholder="Type a website address"
						autoFocus
						allowEmpty
						onNavigate={url => onOpen(url)}
					/>
				</div>

				<div className="bx-start-foot">
					<button type="button" className="bx-start-open" disabled={opening} onClick={() => omniRef.current?.submit()}>
						{opening ? (
							<>
								<span className="bx-tab-spinner" aria-hidden="true" />
								Opening…
							</>
						) : (
							<>
								Open
								<kbd>↵</kbd>
							</>
						)}
					</button>
					{error !== null && (
						<p className="bx-start-error" role="alert">
							<Icon name="warnTri" size={13} strokeWidth={2} />
							{error}
						</p>
					)}
				</div>

				<section className="bx-options" aria-label="Options">
					<button type="button" className="bx-options-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(open => !open)}>
						<Icon name={expanded ? "caretD" : "caretR"} size={12} strokeWidth={2.25} />
						Options
						{summary !== null && <span className="bx-options-summary">{summary}</span>}
					</button>

					{expanded && (
						<div className="bx-options-panel" id={panelId}>
							<label className="bx-option">
								<input type="checkbox" checked={isPrivate} disabled={opening || ownChrome} onChange={event => onPrivate(event.target.checked)} />
								<span>Private — nothing is saved</span>
							</label>

							<div className="bx-option-block">
								{picking && (
									<>
										<span className="bx-start-label" id={`${panelId}-logins`}>
											Profile
										</span>
										<div className="bx-chips" role="radiogroup" aria-labelledby={`${panelId}-logins`}>
											{choices.map(choice => {
												const status = profileStatus(choice);
												return (
													<button
														key={choice.name}
														type="button"
														role="radio"
														aria-checked={profile === choice.name}
														className="bx-chip"
														disabled={!choosable || !status.openable}
														title={status.openable ? undefined : `${choice.label}: ${status.line}`}
														onClick={() => onProfile(choice.name)}
													>
														<ProfileAvatar label={choice.label} colour={choice.colour} avatar={choice.avatar} size="sm" />
														{choice.label}
													</button>
												);
											})}
										</div>
									</>
								)}

								{adding ? (
									<AddProfileForm
										taken={choices.map(choice => ({ slug: choice.name, label: choice.label, colour: choice.colour }))}
										onSubmit={async request => {
											await onAddProfile(request);
											setAdding(false);
										}}
										onCancel={() => setAdding(false)}
									/>
								) : (
									<button type="button" className="bx-chip bx-chip-add" disabled={!choosable} onClick={() => setAdding(true)}>
										<Icon name="plus" size={13} strokeWidth={2.25} />
										Add profile
									</button>
								)}

								{profilesError !== null && <p className="bx-start-error">Couldn't load your profiles ({profilesError}).</p>}
							</div>

							<div className="bx-option-block">
								<label className="bx-option">
									<input type="checkbox" checked={ownChrome} disabled={opening} onChange={event => onOwnChrome(event.target.checked)} />
									<span>Use my own Chrome (the one I'm signed in to)</span>
								</label>
								{ownChrome && <p className="bx-start-note">Your agent only sees the tabs opened here.</p>}
							</div>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

export interface BlankTabProps {
	readonly disabled: boolean;
	readonly onNavigate: (url: string) => void;
	/** The same floating layers the page shows (agent pill, toasts). */
	readonly children?: ReactNode;
}

export function BlankTab({ disabled, onNavigate, children }: BlankTabProps) {
	return (
		<div className="bx-blank">
			<div className="bx-start-glow" aria-hidden="true" />
			<div className="bx-blank-body">
				<span className="bx-start-mark" aria-hidden="true">
					<Icon name="globe" size={22} strokeWidth={1.6} />
				</span>
				<Omnibox url="" loading={false} disabled={disabled} size="hero" placeholder="Enter an address" autoFocus onNavigate={onNavigate} />
				<p className="bx-blank-hint">
					<kbd>Ctrl</kbd>
					<kbd>L</kbd> address · <kbd>Ctrl</kbd>
					<kbd>T</kbd> new tab · <kbd>Ctrl</kbd>
					<kbd>W</kbd> close tab
				</p>
			</div>
			{children !== undefined && <Overlays>{children}</Overlays>}
		</div>
	);
}
