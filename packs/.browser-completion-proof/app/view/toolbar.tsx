// The toolbar: navigation, the omnibox, and the few controls a browser
// surface needs beyond them — annotate, who this browser is (the profile chip and its menu), and a menu.
import { type FormEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import { addressParts, guessAddress } from "../../src/address";
import { ProfileSwitcher, type ProfileSwitcherProps } from "./profile-menu";
import { useMenu } from "./use-menu";

export function LockIcon({ open = false, size = 13 }: { readonly open?: boolean; readonly size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="5" y="11" width="14" height="10" rx="2.5" />
			<path d={open ? "M8 11V7a4 4 0 0 1 7.75-1.4" : "M8 11V7a4 4 0 0 1 8 0v4"} />
		</svg>
	);
}

export interface OmniboxHandle {
	focus(): void;
	/** Submit what is typed, exactly as Enter would. */
	submit(): void;
}

interface OmniboxProps {
	readonly url: string;
	readonly loading: boolean;
	readonly disabled: boolean;
	readonly size?: "toolbar" | "hero";
	readonly placeholder?: string;
	readonly autoFocus?: boolean;
	/** Enter on an empty field submits "" (a blank tab) instead of complaining. */
	readonly allowEmpty?: boolean;
	readonly onNavigate: (url: string) => void;
}

/** The address field. At rest it shows the page's address the way the eye
 *  reads it — host first, path quieter, scheme as a lock. Focused it is the
 *  full URL, selected, ready to be replaced. */
export const Omnibox = forwardRef<OmniboxHandle, OmniboxProps>(function Omnibox(
	{ url, loading, disabled, size = "toolbar", placeholder = "Enter address", autoFocus, allowEmpty, onNavigate },
	ref,
) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [focused, setFocused] = useState(false);
	const [draft, setDraft] = useState(url);
	const [error, setError] = useState<string | null>(null);

	const commit = () => {
		if (allowEmpty && draft.trim().length === 0) {
			onNavigate("");
			return;
		}
		const guess = guessAddress(draft);
		if (!guess.ok) {
			setError(guess.reason);
			return;
		}
		setError(null);
		onNavigate(guess.url);
		inputRef.current?.blur();
	};

	useImperativeHandle(ref, () => ({
		focus: () => {
			inputRef.current?.focus();
			inputRef.current?.select();
		},
		submit: commit,
	}));

	// The page moved on under an unfocused address bar: show where it is now. A
	// launcher (`hero`) has no page — what is typed there is only ever the person's own.
	useEffect(() => {
		if (size === "toolbar" && !focused) setDraft(addressParts(url).blank ? "" : url);
	}, [url, focused, size]);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		commit();
	};

	const parts = addressParts(url);
	const showParts = !focused && !parts.blank && draft === url;

	return (
		<form className="bx-omni" data-size={size} data-focused={focused || undefined} data-error={error !== null || undefined} onSubmit={submit} role="search">
			<span className="bx-omni-lead" aria-hidden="true">
				{parts.blank || focused ? (
					<Icon name="search" size={size === "hero" ? 17 : 14} strokeWidth={2} />
				) : parts.secure ? (
					<LockIcon />
				) : (
					<LockIcon open />
				)}
			</span>
			<input
				ref={inputRef}
				className="bx-omni-input"
				data-masked={showParts || undefined}
				value={draft}
				disabled={disabled}
				placeholder={placeholder}
				spellCheck={false}
				autoComplete="off"
				autoCapitalize="off"
				autoFocus={autoFocus}
				aria-label="Address"
				aria-invalid={error !== null || undefined}
				aria-describedby={error !== null ? "bx-omni-error" : undefined}
				onFocus={event => {
					setFocused(true);
					event.currentTarget.select();
				}}
				onBlur={() => {
					setFocused(false);
					setError(null);
				}}
				onChange={event => {
					setDraft(event.target.value);
					setError(null);
				}}
				onKeyDown={event => {
					if (event.key === "Escape") {
						event.preventDefault();
						setDraft(parts.blank ? "" : url);
						setError(null);
						event.currentTarget.blur();
					}
				}}
			/>
			{showParts && (
				<span className="bx-omni-display" aria-hidden="true">
					{!parts.secure && size === "toolbar" && url.startsWith("http:") && <span className="bx-omni-flag">Not secure</span>}
					<span className="bx-omni-host">{parts.host}</span>
					<span className="bx-omni-rest">{parts.rest}</span>
				</span>
			)}
			{loading && size === "toolbar" && <span className="bx-omni-progress" aria-hidden="true" />}
			{error !== null && (
				<p id="bx-omni-error" className="bx-omni-error" role="alert">
					<Icon name="warnTri" size={13} strokeWidth={2} />
					{error}
				</p>
			)}
		</form>
	);
});

export interface ToolbarProps {
	readonly url: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly locked: boolean;
	readonly annotating: boolean;
	/** The profile chip and its menu: everything about who this browser is. */
	readonly profiles: ProfileSwitcherProps;
	readonly offline: boolean;
	readonly onBack: () => void;
	readonly onForward: () => void;
	readonly onReload: () => void;
	readonly onStop: () => void;
	readonly onNavigate: (url: string) => void;
	readonly onAnnotate: () => void;
	readonly onCopyAddress: () => void;
	readonly onForgetAnnotation: () => void;
	readonly onCloseBrowser: () => void;
}

export const Toolbar = forwardRef<OmniboxHandle, ToolbarProps>(function Toolbar(props, ref) {
	const { url, loading, canGoBack, canGoForward, locked, annotating, offline } = props;
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const closeMenu = useCallback(() => setMenuOpen(false), []);
	useMenu(menuOpen, closeMenu, menuRef);

	const choose = (run: () => void) => () => {
		setMenuOpen(false);
		run();
	};

	return (
		<div className="bx-toolbar">
			<div className="bx-nav">
				<button type="button" className="bx-tb" aria-label="Back (Alt+Left)" title="Back  Alt+←" disabled={!canGoBack || locked} onClick={props.onBack}>
					<Icon name="back" size={16} strokeWidth={2} />
				</button>
				<button type="button" className="bx-tb" aria-label="Forward (Alt+Right)" title="Forward  Alt+→" disabled={!canGoForward || locked} onClick={props.onForward}>
					<Icon name="arrowR" size={16} strokeWidth={2} />
				</button>
				{loading ? (
					<button type="button" className="bx-tb" aria-label="Stop loading (Esc)" title="Stop  Esc" disabled={locked} onClick={props.onStop}>
						<Icon name="x" size={16} strokeWidth={2} />
					</button>
				) : (
					<button type="button" className="bx-tb" aria-label="Reload (Ctrl+R)" title="Reload  Ctrl+R" disabled={locked} onClick={props.onReload}>
						<Icon name="refresh" size={15} strokeWidth={2} />
					</button>
				)}
			</div>

			<Omnibox ref={ref} url={url} loading={loading} disabled={locked} onNavigate={props.onNavigate} />

			<div className="bx-actions">
				{offline && (
					<span className="bx-offline" role="status">
						<span className="bx-dot" data-tone="warn" aria-hidden="true" />
						Offline
					</span>
				)}
				<button
					type="button"
					className="bx-tb"
					data-on={annotating || undefined}
					aria-pressed={annotating}
					aria-label="Annotate for the agent (Ctrl+Shift+A)"
					title="Annotate for the agent  Ctrl+Shift+A"
					onClick={props.onAnnotate}
				>
					<Icon name="edit" size={15} strokeWidth={2} />
				</button>
				<ProfileSwitcher {...props.profiles} />
				<div className="bx-menu-wrap" ref={menuRef}>
					<button
						type="button"
						className="bx-tb"
						aria-label="More"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen(open => !open)}
					>
						<Icon name="dotsV" size={16} strokeWidth={2.5} />
					</button>
					{menuOpen && (
						<div className="bx-menu" role="menu" aria-label="Browser menu">
							<button type="button" role="menuitem" className="bx-menu-item" onClick={choose(props.onCopyAddress)}>
								<Icon name="copy" size={14} strokeWidth={2} />
								Copy page address
							</button>
							<button type="button" role="menuitem" className="bx-menu-item" onClick={choose(props.onForgetAnnotation)}>
								<Icon name="eye" size={14} strokeWidth={2} />
								Remove annotation from agent
							</button>
							<div className="bx-menu-sep" role="separator" />
							<button type="button" role="menuitem" className="bx-menu-item" data-tone="danger" onClick={choose(props.onCloseBrowser)}>
								<Icon name="logout" size={14} strokeWidth={2} />
								Close browser
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
