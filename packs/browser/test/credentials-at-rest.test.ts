/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a password the browser saved for
 *  a profile is readable by anything that can read a file — a backup, a sync, a
 *  copy of the profile folder, a stray search — or a store somebody altered is
 *  read as if it were the person's, or silently emptied by the next sign-up, or
 *  a store written before encryption keeps its plain text for ever, or a lost or
 *  damaged key is quietly replaced (orphaning every password it protected).
 *
 *  No browser: the module is exercised over real files in temp directories, and
 *  "on disk" means every byte of every file under the pack's root, not the one
 *  file the module is known to write.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CredentialKey, readCredentials, resolveCredential, savedPassword, savedPasswords } from "../src/credentials";
import { BrowserRuntimeError } from "../src/store";
import { createRoot, teardown } from "./fixture";

afterEach(teardown);

const SHOP = "https://shop.example";
const BANK = "https://bank.example";

interface Fresh {
	rootDir: string;
	profileDir: string;
	file: string;
	keyFile: string;
	key: CredentialKey;
}

/** A profile directory under a fresh root, and the key that root would hold. */
async function fresh(): Promise<Fresh> {
	const rootDir = await createRoot();
	const profileDir = join(rootDir, "profiles", "work");
	mkdirSync(profileDir, { recursive: true });
	return { rootDir, profileDir, file: join(profileDir, "credentials.json"), keyFile: join(rootDir, "credentials.key"), key: new CredentialKey(rootDir) };
}

/** Every file under `root`, whole, as bytes: what a backup of the folder would carry. */
function everythingUnder(root: string): Buffer[] {
	return readdirSync(root, { recursive: true, encoding: "utf8" })
		.map((name) => join(root, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path));
}

/** Whether `secret` is in any file under `root`, as text or as base64 of the text. */
function onDisk(root: string, secret: string): boolean {
	const needles = [Buffer.from(secret, "utf8"), Buffer.from(Buffer.from(secret, "utf8").toString("base64"), "utf8")];
	return everythingUnder(root).some((bytes) => needles.some((needle) => bytes.includes(needle)));
}

function refusal(work: () => unknown): BrowserRuntimeError {
	try {
		work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return error;
		throw error;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

/** The store as JSON, for a test that alters it. */
const stored = (file: string): { version: number; origins: Record<string, string> } => JSON.parse(readFileSync(file, "utf8"));

describe("a saved password at rest", () => {
	test("is sealed: no file under the root holds it, in the clear or in base64 — and it still comes back whole, from this process and from a fresh one", async () => {
		const { rootDir, profileDir, key } = await fresh();

		const minted = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key);

		expect(minted).toMatchObject({ origin: SHOP, created: true });
		expect(minted.password).toMatch(/^.{20}$/);
		expect(onDisk(rootDir, minted.password)).toBe(false);
		expect(savedPassword(profileDir, SHOP, key)).toBe(minted.password);
		// A server that starts later has only the files.
		const later = new CredentialKey(rootDir);
		expect(savedPassword(profileDir, SHOP, later)).toBe(minted.password);
		expect(resolveCredential(profileDir, { origin: SHOP, mode: "login" }, later)).toEqual({ origin: SHOP, password: minted.password, created: false });
		expect(savedPasswords(profileDir, later)).toEqual([minted.password]);
	});

	test("is sealed afresh each time: the same password under the same origin is never the same bytes twice", async () => {
		const { profileDir, file, key } = await fresh();
		writeFileSync(file, JSON.stringify({ version: 1, origins: { [SHOP]: "Same-Pw_1#x" } }));
		savedPasswords(profileDir, key);
		const first = stored(file).origins[SHOP];
		writeFileSync(file, JSON.stringify({ version: 1, origins: { [SHOP]: "Same-Pw_1#x" } }));
		savedPasswords(profileDir, key);

		expect(stored(file).origins[SHOP]).not.toBe(first);
	});
});

describe("a store written before encryption (version 1, plain text)", () => {
	test("is encrypted in place the first time it is read: the passwords still work, nothing readable is left on disk, and the next sign-up keeps them", async () => {
		const { rootDir, profileDir, file, key } = await fresh();
		const first = "Plain-One_1#fixture";
		const second = "Plain-Two_2#fixture";
		writeFileSync(file, `${JSON.stringify({ version: 1, origins: { [SHOP]: first, [BANK]: second } })}\n`);
		expect(onDisk(rootDir, first)).toBe(true);

		expect(savedPassword(profileDir, SHOP, key)).toBe(first);

		expect(onDisk(rootDir, first)).toBe(false);
		expect(onDisk(rootDir, second)).toBe(false);
		expect(stored(file).version).toBe(2);
		expect(Object.keys(stored(file).origins).sort()).toEqual([BANK, SHOP]);
		expect(readCredentials(profileDir, new CredentialKey(rootDir))).toEqual({ [SHOP]: first, [BANK]: second });
		// A new origin joins the migrated ones; none is lost or rewritten as something else.
		const minted = resolveCredential(profileDir, { origin: "https://news.example", mode: "signup" }, key);
		expect(readCredentials(profileDir, key)).toEqual({ [SHOP]: first, [BANK]: second, "https://news.example": minted.password });
		expect(onDisk(rootDir, minted.password)).toBe(false);
	});

	test("a store with no `version` at all (a hand-made one) is the same: read as plain text, then sealed", async () => {
		const { rootDir, profileDir, file, key } = await fresh();
		writeFileSync(file, JSON.stringify({ origins: { [SHOP]: "Hand-Made_3#fixture" } }));

		expect(savedPassword(profileDir, SHOP, key)).toBe("Hand-Made_3#fixture");

		expect(onDisk(rootDir, "Hand-Made_3#fixture")).toBe(false);
		expect(stored(file).version).toBe(2);
	});

	test("reading a profile that holds no passwords makes no key: an empty store, or none, leaves nothing behind", async () => {
		const { profileDir, file, keyFile, key } = await fresh();
		expect(savedPasswords(profileDir, key)).toEqual([]);
		writeFileSync(file, JSON.stringify({ version: 1, origins: {} }));
		expect(savedPasswords(profileDir, key)).toEqual([]);

		expect(existsSync(keyFile)).toBe(false);
	});
});

describe("a store that does not authenticate", () => {
	const SECRET = "Old-Secret_9#fixture";

	/** A sealed store holding `SECRET` for SHOP, and the bytes it is on disk. */
	async function sealed(): Promise<Fresh & { before: string }> {
		const f = await fresh();
		writeFileSync(f.file, JSON.stringify({ version: 1, origins: { [SHOP]: SECRET, [BANK]: "Other-Pw_4#fixture" } }));
		savedPasswords(f.profileDir, f.key);
		return { ...f, before: readFileSync(f.file, "utf8") };
	}

	/** The ways a sealed value can be altered by someone who can write the file but does not hold the key. */
	function alterations(entry: string, other: string): Array<[name: string, value: string]> {
		const [, iv, tag, data] = entry.split(":") as [string, string, string, string];
		const flipped = (text: string): string => `${text[0] === "A" ? "B" : "A"}${text.slice(1)}`;
		return [
			["a flipped ciphertext", `gcm1:${iv}:${tag}:${flipped(data)}`],
			["a flipped tag", `gcm1:${iv}:${flipped(tag)}:${data}`],
			["a flipped nonce", `gcm1:${flipped(iv)}:${tag}:${data}`],
			["another origin's sealed value moved here", other],
			["plain text where a sealed value belongs", "Attacker-Chosen_1#"],
			["a truncated value", entry.slice(0, -6)],
		];
	}

	test("is refused, never read as empty, never rewritten, and never says what it held — whichever way it was altered", async () => {
		const { profileDir, file, key, before } = await sealed();
		const origins = stored(file).origins;
		for (const [name, value] of alterations(origins[SHOP] as string, origins[BANK] as string)) {
			const altered = JSON.stringify({ version: 2, origins: { ...origins, [SHOP]: value } });
			writeFileSync(file, altered);

			for (const run of [() => savedPassword(profileDir, SHOP, key), () => savedPasswords(profileDir, key), () => resolveCredential(profileDir, { origin: "https://new.example", mode: "signup" }, key)]) {
				const refused = refusal(run);
				expect(refused.code, name).toBe("credentials_unreadable");
				expect(refused.message, name).not.toContain(SECRET);
			}
			// Left as it was found: a sign-up that rewrote it would have dropped every password in it.
			expect(readFileSync(file, "utf8"), name).toBe(altered);
		}
		writeFileSync(file, before);
		expect(savedPassword(profileDir, SHOP, key)).toBe(SECRET);
	});

	test("a store that says it is a version this module does not know is refused, not read as plain text", async () => {
		const { profileDir, file, key } = await fresh();
		const body = JSON.stringify({ version: 3, origins: { [SHOP]: "Future-Pw_5#fixture" } });
		writeFileSync(file, body);

		expect(refusal(() => savedPassword(profileDir, SHOP, key)).code).toBe("credentials_unreadable");
		expect(readFileSync(file, "utf8")).toBe(body);
	});

	test("under another key it does not open: a copy of the profile folder on another machine reads nothing", async () => {
		const { profileDir, file, before } = await sealed();
		const elsewhere = new CredentialKey(await createRoot());

		const refused = refusal(() => savedPassword(profileDir, SHOP, elsewhere));

		expect(refused.code).toBe("credentials_unreadable");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});

describe("the key", () => {
	test("is one file in the root, outside every profile folder, made once and the same for every profile and every later start", async () => {
		const { rootDir, profileDir, keyFile, key } = await fresh();
		const other = join(rootDir, "profiles", "play");
		mkdirSync(other, { recursive: true });
		resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key);
		const made = readFileSync(keyFile, "utf8");
		resolveCredential(other, { origin: SHOP, mode: "signup" }, new CredentialKey(rootDir));

		expect(Buffer.from(made.trim(), "base64")).toHaveLength(32);
		expect(readFileSync(keyFile, "utf8")).toBe(made);
		expect(readdirSync(join(rootDir, "profiles"), { recursive: true, encoding: "utf8" }).filter((name) => name.includes("credentials.key"))).toEqual([]);
	});

	test("is only the user's to read: mode 0600 where modes exist, an ACL of one account on Windows", async () => {
		const { profileDir, keyFile, file, key } = await fresh();
		resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key);

		if (process.platform !== "win32") {
			expect(statSync(keyFile).mode & 0o777).toBe(0o600);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			return;
		}
		// icacls lists one line per entry after the path: `DOMAIN\user:(F)`. Exactly one, and it is this account, with nothing inherited.
		const listing = spawnSync("icacls", [keyFile], { encoding: "utf8", windowsHide: true }).stdout;
		const entries = listing
			.split(/\r?\n/)
			.map((line) => line.replace(keyFile, "").trim())
			.filter((line) => /:\(/.test(line));
		expect(entries).toHaveLength(1);
		expect(entries[0]?.toLowerCase()).toContain((process.env.USERNAME ?? "").toLowerCase());
		expect(entries[0]).not.toContain("(I)");
	});

	test("a key file that cannot be read as a key is refused and left as it was: it is never replaced, which would orphan every sealed password", async () => {
		const { rootDir, profileDir, file, keyFile, key } = await fresh();
		resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key);
		const sealedBefore = readFileSync(file, "utf8");

		for (const [name, body] of [["garbage", "not a key\n"], ["too short", `${Buffer.alloc(16, 7).toString("base64")}\n`], ["empty", ""]] as const) {
			writeFileSync(keyFile, body);
			const refused = refusal(() => savedPasswords(profileDir, new CredentialKey(rootDir)));
			expect(refused.code, name).toBe("credentials_unreadable");
			expect(readFileSync(keyFile, "utf8"), name).toBe(body);
			expect(readFileSync(file, "utf8"), name).toBe(sealedBefore);
			expect(refusal(() => resolveCredential(profileDir, { origin: BANK, mode: "signup" }, new CredentialKey(rootDir))).code, name).toBe("credentials_unreadable");
		}
	});
});
