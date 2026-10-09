// Written for the Browser pack. The texts a host answers a cell with when it refuses something the contract says it must refuse, kept in one place so the host, prompt.md and the tests say the same thing.

/**
 * What a host answers, as the `code_needs_consent` refusal (contract rule 6), when a cell asks for a saved profile: the profile holds logins and code runs with full Node, so it stays refused until the
 * "human yes" gate exists (doc 77 §7.8 decision 2). The text says what the model tells the person and what it can do meanwhile, with the tools a code space has; prompt.md says the same in fewer words.
 */
export function savedProfileRefusal(profile: string): string {
  const name = JSON.stringify(profile);
  return `a saved profile (${name}) cannot be driven by code yet: it holds logins, and code runs with full Node. Tell the user so. They can work in it themselves: call browser_view({ profile: ${name} }) and they sign in or do the step in the View. `
    + "Meanwhile code can use a throwaway browser (leave profile out) or, if the user has allowed it, their own Chrome (app: { relay: true }).";
}
