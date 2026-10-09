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
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Reserved slug for the chrome-relay engine: the human's own running Chrome,
 * one cookie jar, one lease per profile root. No other engine accepts it, and
 * it is never reported.
 */
export const RELAY_PROFILE = "relay";

/**
 * The saved profile a person's own Browser opens (the View's start page and the
 * dock's "Open a page"). They never name it: the word "profile" stays out of
 * the UI. An agent that passes no profile gets a throwaway browser instead.
 */
export const DEFAULT_PROFILE = "default";

/** `raw` as the slug the runtime stores it under (trimmed, lower-cased), or null when it is not one. */
export function profileSlug(raw: string): string | null {
	const slug = raw.trim().toLowerCase();
	return PROFILE_NAME.test(slug) ? slug : null;
}

/** A saved profile as a person sees it: the implicit one has no name of its own. */
export function loginSetLabel(profile: string): string {
	return profile === DEFAULT_PROFILE ? "Default" : profile;
}

export type NameCheck = { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly problem: string };

/** A name a person typed for a new set of saved logins: its slug, or a plain sentence saying why not. */
export function checkProfileName(raw: string): NameCheck {
	const slug = profileSlug(raw);
	if (slug === null) return { ok: false, problem: "Use letters, numbers, - or _ (up to 48), starting with a letter or number." };
	if (slug === RELAY_PROFILE) return { ok: false, problem: "That name is reserved. Pick another." };
	return { ok: true, slug };
}
