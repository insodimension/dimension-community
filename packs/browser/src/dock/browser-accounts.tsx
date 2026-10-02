// The Browser panel — the dock's Browser tab. At the top a person opens a page in
// the live Browser beside the chat; below it, which sites they are signed in to,
// and a sign-in they do THEMSELVES in that same live Browser.
//
//   THE IMPORT SURFACE: `react` + the granted `@fraym/ui` bricks.
//
// DATA: this pack's own connection fact (`report.ts`), the one Store key the
// host admits this seat to beyond the public ones.
//
// INTENT: `store.act("openArtifactoryView", { tool: "browser_view", args })`,
// admitted by the `artifactory:open` grant the manifest declares. The host
// resolves the server itself (this pack's artifactory) and opens the View in
// the seat's session; a refusal is the host's console warning, never a throw.

import { Button, Input, Pill, useObservable } from "@fraym/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { guessAddress } from "../address";
import { checkProfileName, DEFAULT_PROFILE, loginSetLabel } from "../profile-name";
import { effectiveSignedIn } from "../profile-meta";
import { avatarGlyph, avatarStyle } from "../profile-look";
import { CONNECTION_KEY, observedAgo, type ProfileRow, profileRows, type SiteRow } from "./report";
import { knownSite, SIGN_IN_SITES, signInUrl } from "./sites";

/** The Store's contract shape, restated by the members this panel uses. */
export interface BrowserStoreShape {
	watch<T = unknown>(key: string): { getSnapshot(): T | undefined; subscribe(fn: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface BrowserAccountsProps {
	readonly sessionId: string | null;
	readonly store?: BrowserStoreShape;
}

type SignIn = (profile: string, url: string) => void;
/** Open a page: `url` null is a blank browser; private opens with nothing saved. */
type OpenPage = (url: string | null, isPrivate: boolean) => void;

const NONE = { getSnapshot: () => undefined, subscribe: () => () => {} };
const MINUTE_MS = 60_000;

function SiteLine({ site, now, onSignIn }: { readonly site: SiteRow; readonly now: number; readonly onSignIn: (() => void) | null }) {
	const label = knownSite(site.host)?.label ?? site.host;
	// Never claimed from a visit with no check, nor from an observation over 7 days old: the line says when it was seen.
	const state = effectiveSignedIn(site.signedIn, site.observedAt, now);
	return (
		<li className="flex min-w-0 items-center gap-2 py-1" data-slot="browser-accounts-site" data-signed-in={state}>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="fr-overflow text-fr-sm text-fr-text">{label}</span>
					<Pill tint={state === true ? "bg-fr-add-bg" : state === false ? "bg-fr-warn/15" : undefined}>{state === true ? "Signed in" : state === false ? "Signed out" : "Not checked"}</Pill>
				</span>
				<span className="fr-overflow font-secondary text-fr-xs text-fr-text-3">
					{site.account ? `${site.account} · ` : ""}
					{observedAgo(site.observedAt, now)}
				</span>
			</span>
			<Button size="sm" variant={state === true ? "ghost" : "outline"} disabled={!onSignIn} onClick={onSignIn ?? undefined}>
				Sign in
			</Button>
		</li>
	);
}

function ProfileSection({
	profile,
	now,
	signIn,
	onPick,
}: {
	readonly profile: ProfileRow;
	readonly now: number;
	readonly signIn: SignIn | null;
	readonly onPick: () => void;
}) {
	return (
		<section className="flex flex-col border-fr-border-soft border-b px-3 py-2" data-slot="browser-accounts-profile">
			<button
				type="button"
				className="flex min-w-0 items-center gap-1.5 text-left text-fr-text-2 hover:text-fr-text"
				title="Use these logins for a new sign-in"
				onClick={onPick}
			>
				<span
					className="grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-semibold leading-none"
					style={avatarStyle(profile.colour, profile.avatar !== undefined)}
					aria-hidden="true"
					data-slot="browser-accounts-avatar"
				>
					{avatarGlyph(profile.label, profile.avatar)}
				</span>
				<span className="fr-overflow font-secondary text-fr-xs" data-slot="browser-accounts-profile-label">
					{profile.label}
				</span>
			</button>
			<ul className="flex flex-col">
				{profile.sites.map(site => (
					<SiteLine
						key={site.host}
						site={site}
						now={now}
						onSignIn={signIn ? () => signIn(profile.name, signInUrl(site.host)) : null}
					/>
				))}
			</ul>
		</section>
	);
}

/** `name` is what a person typed or picked, never the slug: empty is the implicit set. */
function NewSignIn({ name, onName, signIn }: { readonly name: string; readonly onName: (value: string) => void; readonly signIn: SignIn | null }) {
	const [host, setHost] = useState(SIGN_IN_SITES[0]?.host ?? "");
	const [touched, setTouched] = useState(false);
	const check = name.trim().length === 0 ? ({ ok: true, slug: DEFAULT_PROFILE } as const) : checkProfileName(name);
	const problem = check.ok ? null : check.problem;
	const site = knownSite(host);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (!signIn || !site || !check.ok) return;
		signIn(check.slug, site.loginUrl);
	};
	return (
		<form className="flex flex-col gap-2 px-3 py-2" data-slot="browser-accounts-new" onSubmit={submit}>
			<span className="fr-eyebrow text-fr-text-3">Sign in to a site</span>
			<div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Site">
				{SIGN_IN_SITES.map(option => (
					<Button
						key={option.host}
						type="button"
						size="sm"
						variant={option.host === host ? "outline" : "ghost"}
						role="radio"
						aria-checked={option.host === host}
						onClick={() => setHost(option.host)}
					>
						{option.label}
					</Button>
				))}
			</div>
			<div className="flex items-center gap-2">
				<Input
					size="sm"
					value={name}
					placeholder="Default, or a name like work"
					aria-label="Name for these logins"
					aria-invalid={touched && problem !== null}
					data-state={touched && problem !== null ? "invalid" : undefined}
					onChange={event => onName(event.target.value)}
					onBlur={() => setTouched(name.length > 0)}
				/>
				<Button type="submit" size="sm" disabled={!signIn}>
					Sign in
				</Button>
			</div>
			{touched && problem !== null ? (
				<span className="text-fr-xs text-fr-del" data-slot="browser-accounts-problem">
					{problem}
				</span>
			) : null}
		</form>
	);
}

function OpenPageForm({ openPage }: { readonly openPage: OpenPage | null }) {
	const [text, setText] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!openPage) return;
		if (text.trim().length === 0) {
			setProblem(null);
			openPage(null, isPrivate);
			return;
		}
		const guess = guessAddress(text);
		setProblem(guess.ok ? null : guess.reason);
		if (guess.ok) openPage(guess.url, isPrivate);
	};
	return (
		<form className="flex flex-col gap-2 border-fr-border-soft border-b px-3 py-2" data-slot="browser-accounts-open" onSubmit={submit}>
			<span className="fr-eyebrow text-fr-text-3">Open a page</span>
			<div className="flex items-center gap-2">
				<Input
					size="sm"
					value={text}
					placeholder="Type a website address"
					aria-label="Website address"
					aria-invalid={problem !== null}
					data-state={problem !== null ? "invalid" : undefined}
					onChange={event => {
						setText(event.target.value);
						setProblem(null);
					}}
				/>
				<Button type="submit" size="sm" disabled={!openPage}>
					Open
				</Button>
			</div>
			<label className="flex items-center gap-2 text-fr-xs text-fr-text-2">
				<input type="checkbox" checked={isPrivate} onChange={event => setPrivate(event.target.checked)} />
				Private — nothing is saved
			</label>
			{problem !== null ? (
				<span className="text-fr-xs text-fr-del" data-slot="browser-accounts-problem">
					{problem}
				</span>
			) : null}
		</form>
	);
}

export function BrowserAccounts({ sessionId, store }: BrowserAccountsProps) {
	const observable = useMemo(() => store?.watch(CONNECTION_KEY) ?? NONE, [store]);
	const fact = useObservable(observable);
	const profiles = useMemo(() => profileRows(fact), [fact]);
	const [name, setName] = useState("");
	// Observations are minutes-to-days old; a minute tick keeps "5m ago" honest
	// without re-rendering on every frame.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	// The View opens in the seat's session, so with none there is nowhere to open it.
	const launch = useMemo<((args: { profile?: string; url?: string }) => void) | null>(
		() => (store && sessionId ? args => store.act("openArtifactoryView", { tool: "browser_view", args }) : null),
		[store, sessionId],
	);
	const signIn = useMemo<SignIn | null>(() => (launch ? (name, url) => launch({ profile: name, url }) : null), [launch]);
	// A person's own browser keeps their logins: the saved set `default`, unless Private.
	const openPage = useMemo<OpenPage | null>(
		() =>
			launch
				? (url, isPrivate) => {
						const args: { profile?: string; url?: string } = {};
						if (url !== null) args.url = url;
						if (!isPrivate) args.profile = DEFAULT_PROFILE;
						launch(args);
					}
				: null,
		[launch],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-slot="browser-accounts">
			<OpenPageForm openPage={openPage} />
			{profiles.length > 0 ? <span className="fr-eyebrow px-3 pt-2 text-fr-text-3">Signed-in sites</span> : null}
			{profiles.map(row => (
				<ProfileSection key={row.name} profile={row} now={now} signIn={signIn} onPick={() => setName(loginSetLabel(row.name))} />
			))}
			<NewSignIn name={name} onName={setName} signIn={signIn} />
			{!signIn ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3" data-slot="browser-accounts-hint">
					Start or open a chat first — the browser opens beside it.
				</p>
			) : profiles.length === 0 ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3" data-slot="browser-accounts-hint">
					Sites you sign in to in the browser are listed here.
				</p>
			) : null}
		</div>
	);
}
