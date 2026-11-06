import { expect, test } from "bun:test";
import { accountFlag, parseAccount } from "../account";

const REFUSAL = "`account` must be the name of a himalaya account";

test("no account means the default account: nothing is passed to himalaya", () => {
	expect(parseAccount(undefined)).toBeNull();
	expect(accountFlag(null)).toEqual([]);
});

test("a plain account name is kept, trimmed, up to 64 characters", () => {
	for (const name of ["company", "gmail", "work-2", "my_account", "a.b", "0", "_x", ".hidden", "A".repeat(64)]) {
		expect(parseAccount(name)).toBe(name);
	}
	expect(parseAccount("  company  ")).toBe("company");
});

test("anything that is not a plain name is refused, so it can never read as an option or carry a second line", () => {
	const refused: unknown[] = [
		"",
		"   ",
		"--debug",
		"-x",
		"-",
		"a b",
		"a;b",
		"a=b",
		"a/b",
		"a\\b",
		"a\nb",
		"a\u0000b",
		"$(whoami)",
		"caf\u00e9",
		"x".repeat(65),
		null,
		7,
		true,
		{},
		["company"],
	];
	for (const value of refused) expect(() => parseAccount(value)).toThrow(REFUSAL);
});

test("the flag goes out as two arguments: the flag, then the name", () => {
	expect(accountFlag("company")).toEqual(["--account", "company"]);
});
