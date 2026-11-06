const ACCOUNT_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/;
const REFUSAL =
	'`account` must be the name of a himalaya account, like company: letters, digits, "_", "." and "-", at most 64 characters, not starting with a dash. Leave it out to use the default account.';

export function parseAccount(value: unknown): string | null {
	if (value === undefined) return null;
	const name = typeof value === "string" ? value.trim() : "";
	if (!ACCOUNT_NAME.test(name)) throw new Error(REFUSAL);
	return name;
}

export function accountFlag(account: string | null): readonly string[] {
	return account === null ? [] : ["--account", account];
}
