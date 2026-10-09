import { Button, Input, Pill, useObservable } from "@fraym/ui";
import { useEffect, useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/address.ts
var LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d{1,5})?(\/|$)/i;
var IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(:\d{1,5})?(\/|$)/;
/** `name.tld` with an optional port and path — the shape an address has
*  before anyone typed a scheme. The TLD is letters, at least two of them. */
var DOTTED_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/|[?#]|$)/i;
/** The browser only opens http and https. A bare host is guessed: https for
*  the public web, http for this machine and bare IPs (dev servers rarely
*  carry certificates). Anything else is refused with a sentence, not guessed
*  into a search — this browser has no search engine to send words to. */
function guessAddress(raw) {
	const text = raw.trim();
	if (text.length === 0) return {
		ok: false,
		reason: "Type an address, like example.com."
	};
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
	if (scheme === "http" || scheme === "https") try {
		return {
			ok: true,
			url: new URL(text).href
		};
	} catch {
		return {
			ok: false,
			reason: `“${text}” is not a valid address.`
		};
	}
	if (/\s/.test(text)) return {
		ok: false,
		reason: `“${text}” isn't an address. Try something like example.com.`
	};
	const local = LOCAL_HOST.test(text) || IPV4_HOST.test(text);
	if (scheme !== void 0 && !local && !/^[^:]+:\d/.test(text)) return {
		ok: false,
		reason: `Only http and https addresses can be opened here, not ${scheme}:.`
	};
	if (!local && !DOTTED_HOST.test(text)) return {
		ok: false,
		reason: `“${text}” isn't an address. Try something like ${text.toLowerCase()}.com.`
	};
	try {
		return {
			ok: true,
			url: new URL(`${local ? "http" : "https"}://${text}`).href
		};
	} catch {
		return {
			ok: false,
			reason: `“${text}” is not a valid address.`
		};
	}
}
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/profile-name.ts
/**
* The profile-name grammar — the ONE rule every door that takes a profile name
* applies: the MCP tools' input schema (server.ts), the runtime's filesystem
* slug check (store.ts), and the Browser dock panel's sign-in form (dock/).
*
* Pure and dependency-free on purpose: the dock panel runs in the host's page,
* so it cannot reach the rule through store.ts (node:fs) or connection.ts
* (tldts), and a copy of the regex there would drift from the one the server
* enforces.
*/
/** 1-48 chars of [a-z0-9_-], starting alphanumeric: no dots, separators or drive letters. */
var PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/**
* The saved profile a person's own Browser opens (the View's start page and the
* dock's "Open a page"). They never name it: the word "profile" stays out of
* the UI. An agent that passes no profile gets a throwaway browser instead.
*/
var DEFAULT_PROFILE = "default";
/** `raw` as the slug the runtime stores it under (trimmed, lower-cased), or null when it is not one. */
function profileSlug(raw) {
	const slug = raw.trim().toLowerCase();
	return PROFILE_NAME.test(slug) ? slug : null;
}
/** A saved profile as a person sees it: the implicit one has no name of its own. */
function loginSetLabel(profile) {
	return profile === "default" ? "Default" : profile;
}
/** A name a person typed for a new set of saved logins: its slug, or a plain sentence saying why not. */
function checkProfileName(raw) {
	const slug = profileSlug(raw);
	if (slug === null) return {
		ok: false,
		problem: "Use letters, numbers, - or _ (up to 48), starting with a letter or number."
	};
	if (slug === "relay") return {
		ok: false,
		problem: "That name is reserved. Pick another."
	};
	return {
		ok: true,
		slug
	};
}
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/profile-meta.ts
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
/** The fixed palette. A colour is one of these names, never a free value. */
var PROFILE_COLOURS = [
	"blue",
	"orange",
	"green",
	"red",
	"purple",
	"pink",
	"teal",
	"grey"
];
/** `raw` as a label: trimmed, inner whitespace collapsed, control characters removed; undefined when blank or too long. */
function cleanLabel(raw) {
	if (typeof raw !== "string") return void 0;
	const label = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	const characters = [...label].length;
	return characters > 0 && characters <= 48 ? label : void 0;
}
/** One emoji (a ZWJ sequence or a variation selector counts as one), or undefined. */
var EMOJI = /^\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*$/u;
function cleanAvatar(raw) {
	return typeof raw === "string" && raw.length <= 16 && EMOJI.test(raw) ? raw : void 0;
}
function isProfileColour(raw) {
	return typeof raw === "string" && PROFILE_COLOURS.includes(raw);
}
/** A stable colour for a slug with none chosen: the same slug is always the same colour. */
function defaultColour(slug) {
	let hash = 0;
	for (let i = 0; i < slug.length; i += 1) hash = Math.imul(hash, 31) + slug.charCodeAt(i) >>> 0;
	return PROFILE_COLOURS[hash % PROFILE_COLOURS.length];
}
/** `slug`'s label, colour and avatar: what was stored, else what the slug gives. */
function resolveProfileMeta(slug, stored = {}) {
	return {
		label: cleanLabel(stored.label) ?? loginSetLabel(slug),
		colour: isProfileColour(stored.colour) ? stored.colour : defaultColour(slug),
		...cleanAvatar(stored.avatar) === void 0 ? {} : { avatar: stored.avatar }
	};
}
/**
* What an observation says NOW. `null` is "not known": the site was visited but
* never checked, the check is over 7 days old, or its time is in the future
* (a wrong clock or a copied file: a sign-in is not claimed for days that have
* not happened). Signed in is never claimed from old data (nor signed out: a
* session may have been renewed since).
*/
function effectiveSignedIn(signedIn, observedAt, now) {
	const age = now - observedAt;
	return signedIn !== null && age >= -6e4 && age <= 6048e5 ? signedIn : null;
}
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/profile-look.ts
/** OKLCH hue (degrees) and chroma of each named colour. */
var PROFILE_LOOK = {
	blue: {
		hue: 255,
		chroma: .15
	},
	orange: {
		hue: 55,
		chroma: .16
	},
	green: {
		hue: 150,
		chroma: .14
	},
	red: {
		hue: 25,
		chroma: .18
	},
	purple: {
		hue: 300,
		chroma: .16
	},
	pink: {
		hue: 350,
		chroma: .16
	},
	teal: {
		hue: 195,
		chroma: .11
	},
	grey: {
		hue: 260,
		chroma: .015
	}
};
/**
* The inline style of an avatar disc. A letter sits on the colour as a soft diagonal gradient, in white; an emoji keeps its
* own colours and sits on a tint of the profile's colour, ringed in it. Sizes, centring and type are the host's.
*/
function avatarStyle(colour, emoji) {
	const { hue, chroma } = PROFILE_LOOK[colour];
	if (emoji) return {
		background: `color-mix(in oklab, oklch(0.62 ${chroma} ${hue}) 20%, var(--fr-surface))`,
		boxShadow: `inset 0 0 0 1.5px oklch(0.62 ${chroma} ${hue} / 0.7)`
	};
	return {
		color: "oklch(0.99 0 0)",
		background: `linear-gradient(150deg, oklch(0.64 ${chroma} ${hue}), oklch(0.5 ${chroma} ${hue + 22}))`,
		boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.2)"
	};
}
/** What an avatar disc shows: the chosen emoji, else the label's first letter or number, upper-case. */
function avatarGlyph(label, avatar) {
	if (avatar !== void 0 && avatar.length > 0) return avatar;
	const first = [...label.trim()].find((char) => /[\p{L}\p{N}]/u.test(char));
	return first === void 0 ? "?" : first.toUpperCase();
}
/** A plain JSON object's entries, or none for anything else (null, an array, a primitive). */
function entriesOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
}
/** Every reported profile with its well-formed sites, both sorted by name.
*  Empty when the pack has reported nothing yet, or retracted its report. */
function profileRows(fact) {
	const profiles = fact?.reported?.profiles;
	const rows = [];
	for (const [name, profile] of entriesOf(profiles)) {
		const { sites, label, colour, avatar } = Object.fromEntries(entriesOf(profile));
		if (typeof sites !== "object" || sites === null || Array.isArray(sites)) continue;
		const siteRows = [];
		for (const [host, value] of Object.entries(sites)) {
			const site = Object.fromEntries(entriesOf(value));
			if (typeof site.signedIn !== "boolean" && site.signedIn !== null || typeof site.observedAt !== "number" || !Number.isFinite(site.observedAt)) continue;
			siteRows.push({
				host,
				signedIn: site.signedIn,
				...typeof site.account === "string" && site.account.length > 0 ? { account: site.account } : {},
				observedAt: site.observedAt
			});
		}
		const meta = resolveProfileMeta(name, {
			...typeof label === "string" ? { label } : {},
			...isProfileColour(colour) ? { colour } : {},
			...typeof avatar === "string" ? { avatar } : {}
		});
		rows.push({
			name,
			...meta,
			sites: siteRows.sort((a, b) => a.host.localeCompare(b.host))
		});
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}
/** "just now", "5m ago", "3h ago", "2d ago" — for an epoch-ms observation. */
function observedAgo(at, now) {
	const seconds = Math.max(0, Math.round((now - at) / 1e3));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/recipes/bluesky-post.json
var platform$2 = "Bluesky";
var origin$3 = "https://bsky.app";
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/recipes/linkedin-post.json
var platform$1 = "LinkedIn";
var origin$2 = "https://www.linkedin.com";
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/recipes/reddit-comment.json
var platform = "Reddit";
var origin$1 = "https://www.reddit.com";
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/recipes/x-post.json
var origin = "https://x.com";
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/dock/sites.ts
/** `connection.ts` keys a site by its registrable domain (tldts). Every preset
*  origin is either that domain or its `www.` host, so dropping the `www.`
*  yields the same key without shipping the Public Suffix List into the page. */
function fromPreset(platform, presetOrigin, loginPath) {
	const origin = new URL(presetOrigin);
	return {
		host: origin.hostname.replace(/^www\./, ""),
		label: platform,
		loginUrl: new URL(loginPath, origin).href
	};
}
var SIGN_IN_SITES = [
	fromPreset("X", origin, "/login"),
	fromPreset(platform$1, origin$2, "/login"),
	fromPreset(platform, origin$1, "/login"),
	fromPreset(platform$2, origin$3, "/"),
	{
		host: "google.com",
		label: "Google",
		loginUrl: "https://accounts.google.com/"
	}
];
var BY_HOST = new Map(SIGN_IN_SITES.map((site) => [site.host, site]));
/** The known site for a report key, if the panel has one. */
function knownSite(host) {
	return BY_HOST.get(host);
}
/** Where to start signing in to `host`: its login page when known, else the site itself. */
function signInUrl(host) {
	return BY_HOST.get(host)?.loginUrl ?? `https://${host}/`;
}
//#endregion
//#region ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/dock/browser-accounts.tsx
var NONE = {
	getSnapshot: () => void 0,
	subscribe: () => () => {}
};
var MINUTE_MS = 6e4;
function SiteLine({ site, now, onSignIn }) {
	const label = knownSite(site.host)?.label ?? site.host;
	const state = effectiveSignedIn(site.signedIn, site.observedAt, now);
	return /* @__PURE__ */ jsxs("li", {
		className: "flex min-w-0 items-center gap-2 py-1",
		"data-slot": "browser-accounts-site",
		"data-signed-in": state,
		children: [/* @__PURE__ */ jsxs("span", {
			className: "flex min-w-0 flex-1 flex-col",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 items-center gap-1.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: "fr-overflow text-fr-sm text-fr-text",
					children: label
				}), /* @__PURE__ */ jsx(Pill, {
					tint: state === true ? "bg-fr-add-bg" : state === false ? "bg-fr-warn/15" : void 0,
					children: state === true ? "Signed in" : state === false ? "Signed out" : "Not checked"
				})]
			}), /* @__PURE__ */ jsxs("span", {
				className: "fr-overflow font-secondary text-fr-xs text-fr-text-3",
				children: [site.account ? `${site.account} · ` : "", observedAgo(site.observedAt, now)]
			})]
		}), /* @__PURE__ */ jsx(Button, {
			size: "sm",
			variant: state === true ? "ghost" : "outline",
			disabled: !onSignIn,
			onClick: onSignIn ?? void 0,
			children: "Sign in"
		})]
	});
}
function ProfileSection({ profile, now, signIn, onPick }) {
	return /* @__PURE__ */ jsxs("section", {
		className: "flex flex-col border-fr-border-soft border-b px-3 py-2",
		"data-slot": "browser-accounts-profile",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "flex min-w-0 items-center gap-1.5 text-left text-fr-text-2 hover:text-fr-text",
			title: "Use these logins for a new sign-in",
			onClick: onPick,
			children: [/* @__PURE__ */ jsx("span", {
				className: "grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-semibold leading-none",
				style: avatarStyle(profile.colour, profile.avatar !== void 0),
				"aria-hidden": "true",
				"data-slot": "browser-accounts-avatar",
				children: avatarGlyph(profile.label, profile.avatar)
			}), /* @__PURE__ */ jsx("span", {
				className: "fr-overflow font-secondary text-fr-xs",
				"data-slot": "browser-accounts-profile-label",
				children: profile.label
			})]
		}), /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col",
			children: profile.sites.map((site) => /* @__PURE__ */ jsx(SiteLine, {
				site,
				now,
				onSignIn: signIn ? () => signIn(profile.name, signInUrl(site.host)) : null
			}, site.host))
		})]
	});
}
/** `name` is what a person typed or picked, never the slug: empty is the implicit set. */
function NewSignIn({ name, onName, signIn }) {
	const [host, setHost] = useState(SIGN_IN_SITES[0]?.host ?? "");
	const [touched, setTouched] = useState(false);
	const check = name.trim().length === 0 ? {
		ok: true,
		slug: DEFAULT_PROFILE
	} : checkProfileName(name);
	const problem = check.ok ? null : check.problem;
	const site = knownSite(host);
	const submit = (event) => {
		event.preventDefault();
		setTouched(true);
		if (!signIn || !site || !check.ok) return;
		signIn(check.slug, site.loginUrl);
	};
	return /* @__PURE__ */ jsxs("form", {
		className: "flex flex-col gap-2 px-3 py-2",
		"data-slot": "browser-accounts-new",
		onSubmit: submit,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "fr-eyebrow text-fr-text-3",
				children: "Sign in to a site"
			}),
			/* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-1",
				role: "radiogroup",
				"aria-label": "Site",
				children: SIGN_IN_SITES.map((option) => /* @__PURE__ */ jsx(Button, {
					type: "button",
					size: "sm",
					variant: option.host === host ? "outline" : "ghost",
					role: "radio",
					"aria-checked": option.host === host,
					onClick: () => setHost(option.host),
					children: option.label
				}, option.host))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ jsx(Input, {
					size: "sm",
					value: name,
					placeholder: "Default, or a name like work",
					"aria-label": "Name for these logins",
					"aria-invalid": touched && problem !== null,
					"data-state": touched && problem !== null ? "invalid" : void 0,
					onChange: (event) => onName(event.target.value),
					onBlur: () => setTouched(name.length > 0)
				}), /* @__PURE__ */ jsx(Button, {
					type: "submit",
					size: "sm",
					disabled: !signIn,
					children: "Sign in"
				})]
			}),
			touched && problem !== null ? /* @__PURE__ */ jsx("span", {
				className: "text-fr-xs text-fr-del",
				"data-slot": "browser-accounts-problem",
				children: problem
			}) : null
		]
	});
}
function OpenPageForm({ openPage }) {
	const [text, setText] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const [problem, setProblem] = useState(null);
	const submit = (event) => {
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
	return /* @__PURE__ */ jsxs("form", {
		className: "flex flex-col gap-2 border-fr-border-soft border-b px-3 py-2",
		"data-slot": "browser-accounts-open",
		onSubmit: submit,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "fr-eyebrow text-fr-text-3",
				children: "Open a page"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ jsx(Input, {
					size: "sm",
					value: text,
					placeholder: "Type a website address",
					"aria-label": "Website address",
					"aria-invalid": problem !== null,
					"data-state": problem !== null ? "invalid" : void 0,
					onChange: (event) => {
						setText(event.target.value);
						setProblem(null);
					}
				}), /* @__PURE__ */ jsx(Button, {
					type: "submit",
					size: "sm",
					disabled: !openPage,
					children: "Open"
				})]
			}),
			/* @__PURE__ */ jsxs("label", {
				className: "flex items-center gap-2 text-fr-xs text-fr-text-2",
				children: [/* @__PURE__ */ jsx("input", {
					type: "checkbox",
					checked: isPrivate,
					onChange: (event) => setPrivate(event.target.checked)
				}), "Private — nothing is saved"]
			}),
			problem !== null ? /* @__PURE__ */ jsx("span", {
				className: "text-fr-xs text-fr-del",
				"data-slot": "browser-accounts-problem",
				children: problem
			}) : null
		]
	});
}
function BrowserAccounts({ sessionId, store }) {
	const fact = useObservable(useMemo(() => store?.watch("plugin/browser/connection") ?? NONE, [store]));
	const profiles = useMemo(() => profileRows(fact), [fact]);
	const [name, setName] = useState("");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	const launch = useMemo(() => store && sessionId ? (args) => store.act("openArtifactoryView", {
		tool: "browser_view",
		args
	}) : null, [store, sessionId]);
	const signIn = useMemo(() => launch ? (name, url) => launch({
		profile: name,
		url
	}) : null, [launch]);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
		"data-slot": "browser-accounts",
		children: [
			/* @__PURE__ */ jsx(OpenPageForm, { openPage: useMemo(() => launch ? (url, isPrivate) => {
				const args = {};
				if (url !== null) args.url = url;
				if (!isPrivate) args.profile = DEFAULT_PROFILE;
				launch(args);
			} : null, [launch]) }),
			profiles.length > 0 ? /* @__PURE__ */ jsx("span", {
				className: "fr-eyebrow px-3 pt-2 text-fr-text-3",
				children: "Signed-in sites"
			}) : null,
			profiles.map((row) => /* @__PURE__ */ jsx(ProfileSection, {
				profile: row,
				now,
				signIn,
				onPick: () => setName(loginSetLabel(row.name))
			}, row.name)),
			/* @__PURE__ */ jsx(NewSignIn, {
				name,
				onName: setName,
				signIn
			}),
			!signIn ? /* @__PURE__ */ jsx("p", {
				className: "px-3 pb-3 text-fr-xs text-fr-text-3",
				"data-slot": "browser-accounts-hint",
				children: "Start or open a chat first — the browser opens beside it."
			}) : profiles.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "px-3 pb-3 text-fr-xs text-fr-text-3",
				"data-slot": "browser-accounts-hint",
				children: "Sites you sign in to in the browser are listed here."
			}) : null
		]
	});
}
//#endregion
export { BrowserAccounts, BrowserAccounts as default };
