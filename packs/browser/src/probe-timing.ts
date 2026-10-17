/** When the pack looks at a saved profile's page for a sign-in. */

/** A page that loads (or changes route) is looked at this long after the last such event, once. */
export const PROBE_DEBOUNCE_MS = 400;

/** How long the first look waits for the signed-in marker on a page where its absence decides: a single-page app draws it after `load`. */
export const SETTLE_MS = 3_000;

/**
 * The first look's miss is not a verdict: a page still drawing (a cold first load after a sign-in, a redirect chain) shows no marker yet
 * and is not signed out. The page is looked at once more, as it is, this long after, and only that miss is written.
 */
export const RELOOK_MS = 4_000;
