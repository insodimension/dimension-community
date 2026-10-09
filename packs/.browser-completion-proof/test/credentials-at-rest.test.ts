/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a password the browser saved for
 *  a profile is readable by anything that can read a file — a backup, a sync, a
 *  copy of the profile folder, a stray search — or a store somebody altered is
 *  read as if it were the person's, or silently emptied by the next sign-up, or
 *  a store written before encryption keeps its plain text for ever, or a lost or
 *  damaged key is quietly replaced (orphaning every password it protected), or
 *  a password is lost for good: a sign-up by a server from before encryption
 *  turns sealed text into "passwords", or a key that was never fully on disk is
 *  the one every store was sealed under.
 *
 *  No browser: the module is exercised over real files in temp directories, and
 *  "on disk" means every byte of every file under the pack's root, not the one
 *  file the module is known to write.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

/** A version 1 store as a server from before encryption leaves it after a sign-up on a profile that was already sealed: it ignores `version` and writes back everything it read, ciphertext included. */
function olderServerSignsUp(file: string, origin: string, password: string): void {
	writeFileSync(file, `${JSON.stringify({ version: 1, origins: { ...stored(file).origins, [origin]: password } })}\n`);
}

/** Whether only the user can read `path`: the mode bits where there are any, else an ACL of exactly this account with nothing inherited. */
function onlyTheUserCanRead(path: string): boolean {
	if (process.platform !== "win32") return (statSync(path).mode & 0o777) === 0o600;
	// icacls lists one line per entry after the path: `DOMAIN\user:(F)`.
	const listing = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true }).stdout;
	const [entry, ...others] = listing
		.split(/\r?\n/)
		.map((line) => line.replace(path, "").trim())
		.filter((line) => /:\(/.test(line));
	return entry !== undefined && others.length === 0 && entry.toLowerCase().includes((process.env.USERNAME ?? "").toLowerCase()) && !entry.includes("(I)");
}

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

	test("one an older server wrote back with sealed values inside (a sign-up during an upgrade or rollback) is read through: every password comes back whole, and sealed text is never taken for one", async () => {
		const { rootDir, profileDir, file, key } = await fresh();
		const first = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key).password;
		const second = resolveCredential(profileDir, { origin: BANK, mode: "signup" }, key).password;
		olderServerSignsUp(file, "https://news.example", "Older-Plain_7#fixture");
		expect(stored(file).version).toBe(1);
		expect(stored(file).origins[SHOP]).toStartWith("gcm1:");

		const later = new CredentialKey(rootDir);
		expect(readCredentials(profileDir, later)).toEqual({ [SHOP]: first, [BANK]: second, "https://news.example": "Older-Plain_7#fixture" });

		// Sealed again as a whole: nothing readable is left, and a start after that still opens every one of them.
		expect(stored(file).version).toBe(2);
		expect(onDisk(rootDir, "Older-Plain_7#fixture")).toBe(false);
		expect(Object.values(readCredentials(profileDir, new CredentialKey(rootDir))).sort()).toEqual([first, second, "Older-Plain_7#fixture"].sort());
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe(first);
	});

	test("with the key gone, or a sealed value moved under another origin, it is refused and left as it was: the sealed text is never answered as a password", async () => {
		const { rootDir, profileDir, file, keyFile, key } = await fresh();
		resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key);
		const bank = resolveCredential(profileDir, { origin: BANK, mode: "signup" }, key).password;
		olderServerSignsUp(file, "https://news.example", "Older-Plain_7#fixture");
		const body = readFileSync(file, "utf8");

		// A value taken from another origin's entry does not authenticate here.
		const moved = JSON.stringify({ version: 1, origins: { ...stored(file).origins, [SHOP]: stored(file).origins[BANK] } });
		writeFileSync(file, moved);
		expect(refusal(() => savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).code).toBe("credentials_unreadable");
		expect(readFileSync(file, "utf8")).toBe(moved);

		writeFileSync(file, body);
		const keyBody = readFileSync(keyFile);
		rmSync(keyFile);
		for (const run of [() => savedPassword(profileDir, SHOP, new CredentialKey(rootDir)), () => savedPasswords(profileDir, new CredentialKey(rootDir)), () => resolveCredential(profileDir, { origin: "https://x.example", mode: "signup" }, new CredentialKey(rootDir))]) {
			expect(refusal(run).code).toBe("credentials_unreadable");
		}
		expect(existsSync(keyFile)).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(body);

		// The key comes back: nothing was lost in the meantime.
		fs.writeFileSync(keyFile, keyBody);
		expect(savedPassword(profileDir, BANK, new CredentialKey(rootDir))).toBe(bank);
	});

	test("the benchmark's seeding goes through the module: a root already holding a sealed profile keeps every password it had, and the practice one is sealed beside them", async () => {
		const { rootDir, profileDir, file, key } = await fresh();
		const existing = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key).password;

		const seeded = spawnSync(process.execPath, [fileURLToPath(new URL("../bench/seed-credential.ts", import.meta.url))], {
			input: JSON.stringify({ root: rootDir, profile: "work", origin: "http://127.0.0.1:4777", password: "Practice-Fixture_1#" }),
			encoding: "utf8",
			windowsHide: true,
		});
		expect(seeded.status, seeded.stderr).toBe(0);

		expect(readCredentials(profileDir, new CredentialKey(rootDir))).toEqual({ [SHOP]: existing, "http://127.0.0.1:4777": "Practice-Fixture_1#" });
		expect(stored(file).version).toBe(2);
		expect(onDisk(rootDir, "Practice-Fixture_1#")).toBe(false);
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

	test("under another key it does not open: a copy of the profile folder on another machine, which has a key of its own, reads nothing", async () => {
		const { profileDir, file, before } = await sealed();
		const elsewhere = await fresh();
		resolveCredential(elsewhere.profileDir, { origin: SHOP, mode: "signup" }, elsewhere.key);
		expect(existsSync(elsewhere.keyFile)).toBe(true);

		const refused = refusal(() => savedPassword(profileDir, SHOP, new CredentialKey(elsewhere.rootDir)));

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
		expect(onlyTheUserCanRead(keyFile)).toBe(true);
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

	test("a key lost while stores sealed under it exist is refused and never made afresh: not by the profile that holds them, not by any other, and it comes back as it was", async () => {
		const { rootDir, profileDir, file, keyFile, key } = await fresh();
		const password = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key).password;
		const sealedBefore = readFileSync(file, "utf8");
		const keyBody = readFileSync(keyFile);
		const other = join(rootDir, "profiles", "play");
		mkdirSync(other, { recursive: true });
		rmSync(keyFile);

		for (const [name, run] of [
			["reading the profile that holds them", () => savedPasswords(profileDir, new CredentialKey(rootDir))],
			["signing up on that profile", () => resolveCredential(profileDir, { origin: BANK, mode: "signup" }, new CredentialKey(rootDir))],
			["signing up on another profile", () => resolveCredential(other, { origin: BANK, mode: "signup" }, new CredentialKey(rootDir))],
		] as const) {
			const refused = refusal(run);
			expect(refused.code, name).toBe("credentials_unreadable");
			expect(refused.message, name).toContain("credentials.key");
			expect(existsSync(keyFile), name).toBe(false);
		}
		expect(readFileSync(file, "utf8")).toBe(sealedBefore);
		expect(existsSync(join(other, "credentials.json"))).toBe(false);

		fs.writeFileSync(keyFile, keyBody);
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe(password);
	});

	test("a key lost while a version 1 store holds sealed values (an older server wrote it back during a rollback) is never made afresh either, by any profile, and it comes back as it was", async () => {
		const { rootDir, profileDir, file, keyFile, key } = await fresh();
		const password = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, key).password;
		const keyBody = readFileSync(keyFile);
		// The rollback: the older server read the sealed store and wrote everything back as a version 1 file, adding its own plain sign-up.
		olderServerSignsUp(file, BANK, "Older-Plain_7#fixture");
		expect(stored(file).version).toBe(1);
		const v1Before = readFileSync(file, "utf8");
		const other = join(rootDir, "profiles", "play");
		mkdirSync(other, { recursive: true });
		rmSync(keyFile);

		for (const [name, run] of [
			["reading the profile that holds them", () => savedPasswords(profileDir, new CredentialKey(rootDir))],
			["signing up on another profile", () => resolveCredential(other, { origin: BANK, mode: "signup" }, new CredentialKey(rootDir))],
			["a plain store on another profile, sealed at its first read", () => {
				writeFileSync(join(other, "credentials.json"), `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture" } })}\n`);
				return savedPasswords(other, new CredentialKey(rootDir));
			}],
		] as const) {
			const refused = refusal(run);
			expect(refused.code, name).toBe("credentials_unreadable");
			expect(refused.message, name).toContain("credentials.key");
			expect(existsSync(keyFile), name).toBe(false);
		}
		expect(readFileSync(file, "utf8")).toBe(v1Before);

		fs.writeFileSync(keyFile, keyBody);
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe(password);
		expect(savedPassword(profileDir, BANK, new CredentialKey(rootDir))).toBe("Older-Plain_7#fixture");
	});

	test("is published whole: staged and fsynced, restricted to the user, and only then given its name, which is never taken twice", async () => {
		const { rootDir, profileDir, keyFile } = await fresh();
		const events: string[] = [];
		let published: { staged: string; nameTaken: boolean; private: boolean } | undefined;
		const realFsync = fs.fsyncSync;
		const realLink = fs.linkSync;
		const syncing = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			events.push("fsync");
			return realFsync(fd);
		});
		const linking = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			events.push("publish");
			published = { staged: readFileSync(from, "utf8"), nameTaken: existsSync(to), private: onlyTheUserCanRead(String(from)) };
			return realLink(from, to);
		});
		try {
			resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, new CredentialKey(rootDir));
		} finally {
			syncing.mockRestore();
			linking.mockRestore();
		}

		// The key's bytes reached the disk before the name existed, and the file that was staged is the file that is there.
		expect(events.indexOf("fsync")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("fsync")).toBeLessThan(events.indexOf("publish"));
		expect(published?.nameTaken).toBe(false);
		expect(published?.private).toBe(true);
		expect(Buffer.from((published?.staged ?? "").trim(), "base64")).toHaveLength(32);
		expect(readFileSync(keyFile, "utf8")).toBe(published?.staged ?? "no key was staged");
		expect(readdirSync(rootDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("is restricted to the user before a byte of it is written: the staging file is never readable by anyone else, not even for a moment", async () => {
		const { rootDir, profileDir } = await fresh();
		const realWrite = fs.writeSync as (...args: unknown[]) => number;
		// What the staging file's access was when the key's bytes went into it (`undefined`: no key was written).
		let restrictedWhenWritten: boolean | undefined;
		const writing = spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
			const data = args[1];
			if (restrictedWhenWritten === undefined && typeof data === "string" && Buffer.from(data.trim(), "base64").length === 32) {
				const staged = readdirSync(rootDir).find((name) => name.endsWith(".tmp"));
				restrictedWhenWritten = staged !== undefined && onlyTheUserCanRead(join(rootDir, staged));
			}
			return realWrite(...args);
		}) as typeof fs.writeSync);
		try {
			resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, new CredentialKey(rootDir));
		} finally {
			writing.mockRestore();
		}

		expect(restrictedWhenWritten).toBe(true);
	});

	test("when it cannot be made whole nothing is published and nothing is sealed: the plain passwords stay where they were and are encrypted at the next read", async () => {
		const { rootDir, profileDir, file, keyFile } = await fresh();
		const plain = `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture" } })}\n`;
		writeFileSync(file, plain);
		const failing = spyOn(fs, "fsyncSync").mockImplementation(() => {
			throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		});
		try {
			const refused = refusal(() => savedPassword(profileDir, SHOP, new CredentialKey(rootDir)));
			expect(refused.code).toBe("credentials_unreadable");
			expect(refused.message).toContain("EIO");
		} finally {
			failing.mockRestore();
		}

		expect(existsSync(keyFile)).toBe(false);
		expect(readdirSync(rootDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(plain);
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe("Kept-Plain_1#fixture");
		expect(stored(file).version).toBe(2);
	});

	test("a crash between making the key and the first seal loses nothing: the next start finds the whole key and the plain store, and seals under that key", async () => {
		const { rootDir, profileDir, file, keyFile } = await fresh();
		writeFileSync(file, `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture", [BANK]: "Kept-Plain_2#fixture" } })}\n`);
		// The key exists on disk; the process is gone before it sealed anything. A leftover staging file of a key that never got its name is there too.
		const made = new CredentialKey(rootDir).get();
		writeFileSync(`${keyFile}.deadbeef0000.tmp`, "half a key, then the power went");
		expect(stored(file).version).toBe(1);

		const next = new CredentialKey(rootDir);
		expect(readCredentials(profileDir, next)).toEqual({ [SHOP]: "Kept-Plain_1#fixture", [BANK]: "Kept-Plain_2#fixture" });

		expect(next.existing().equals(made)).toBe(true);
		expect(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64").equals(made)).toBe(true);
		expect(stored(file).version).toBe(2);
		expect(readCredentials(profileDir, new CredentialKey(rootDir))).toEqual({ [SHOP]: "Kept-Plain_1#fixture", [BANK]: "Kept-Plain_2#fixture" });
	});

	test("a key file an older version left empty (it was made in two steps) is refused with what to do about it, the plain passwords are untouched, and once it is deleted they are encrypted", async () => {
		const { rootDir, profileDir, file, keyFile } = await fresh();
		const plain = `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture" } })}\n`;
		writeFileSync(file, plain);
		writeFileSync(keyFile, "");

		const refused = refusal(() => savedPassword(profileDir, SHOP, new CredentialKey(rootDir)));

		expect(refused.code).toBe("credentials_unreadable");
		expect(refused.message).toMatch(/credentials\.key.*(empty|damaged).*delete/);
		expect(readFileSync(file, "utf8")).toBe(plain);
		expect(readFileSync(keyFile, "utf8")).toBe("");

		rmSync(keyFile);
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe("Kept-Plain_1#fixture");
		expect(stored(file).version).toBe(2);
	});

	test("two servers making the key at once end with one: the one that lost adopts the winner's, and what either sealed opens for both", async () => {
		const { rootDir, profileDir } = await fresh();
		const winner = new CredentialKey(rootDir);
		const loser = new CredentialKey(rootDir);
		const realFsync = fs.fsyncSync;
		let winnerKey: Buffer | undefined;
		let racing = false;
		// The winner publishes its key while the loser is still staging its own.
		const racingSync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (!racing) {
				racing = true;
				winnerKey = winner.get();
			}
			return realFsync(fd);
		});
		let adopted: Buffer;
		try {
			adopted = loser.get();
		} finally {
			racingSync.mockRestore();
		}

		expect(winnerKey).toBeDefined();
		expect(adopted.equals(winnerKey as Buffer)).toBe(true);
		const sealedByLoser = resolveCredential(profileDir, { origin: SHOP, mode: "signup" }, loser).password;
		expect(savedPassword(profileDir, SHOP, winner)).toBe(sealedByLoser);
		expect(readdirSync(rootDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("nothing is sealed under a key that is not the one on disk: a name overwritten by another key straight after it was published is refused", async () => {
		const { rootDir, profileDir, file, keyFile } = await fresh();
		const plain = `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture" } })}\n`;
		writeFileSync(file, plain);
		const realLink = fs.linkSync;
		const clobbering = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			realLink(from, to);
			fs.writeFileSync(to, `${randomBytes(32).toString("base64")}\n`);
		});
		try {
			expect(refusal(() => savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).code).toBe("credentials_unreadable");
		} finally {
			clobbering.mockRestore();
		}

		// Not sealed under the key it made: the store is still the plain one, and the next read seals it under the key that is there.
		expect(readFileSync(file, "utf8")).toBe(plain);
		expect(existsSync(keyFile)).toBe(true);
		expect(savedPassword(profileDir, SHOP, new CredentialKey(rootDir))).toBe("Kept-Plain_1#fixture");
		expect(stored(file).version).toBe(2);
	});
});

describe("the sealed store, as it is written", () => {
	test("is staged whole and fsynced before it takes the old store's place, so a crash leaves the old file or the new one and never half of one", async () => {
		const { rootDir, profileDir, file } = await fresh();
		writeFileSync(file, `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture" } })}\n`);
		const key = new CredentialKey(rootDir);
		key.get();
		const events: string[] = [];
		let staged: { version?: number; origins?: Record<string, string> } | undefined;
		const realRename = fs.renameSync;
		const realFsync = fs.fsyncSync;
		const syncing = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			events.push("fsync");
			return realFsync(fd);
		});
		const renaming = spyOn(fs, "renameSync").mockImplementation((from, to) => {
			events.push("rename");
			if (String(to) === file) staged = JSON.parse(readFileSync(from, "utf8"));
			return realRename(from, to);
		});
		try {
			savedPasswords(profileDir, key);
		} finally {
			syncing.mockRestore();
			renaming.mockRestore();
		}

		// The bytes were on disk before the rename, and what was renamed in was the whole sealed store.
		expect(events.indexOf("fsync")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("fsync")).toBeLessThan(events.indexOf("rename"));
		expect(staged?.version).toBe(2);
		expect(Object.keys(staged?.origins ?? {})).toEqual([SHOP]);
		expect(readdirSync(profileDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("a write that fails half way leaves the old store as it was and nothing behind: the passwords are still answered and sealed at the next read", async () => {
		const { rootDir, profileDir, file } = await fresh();
		const plain = `${JSON.stringify({ version: 1, origins: { [SHOP]: "Kept-Plain_1#fixture", [BANK]: "Kept-Plain_2#fixture" } })}\n`;
		writeFileSync(file, plain);
		const key = new CredentialKey(rootDir);
		key.get();
		const saying = spyOn(console, "error").mockImplementation(() => undefined);
		const failing = spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		});
		try {
			// A scanner holds the file: the passwords still come back, the file is untouched and no staging file is left.
			expect(savedPasswords(profileDir, key).sort()).toEqual(["Kept-Plain_1#fixture", "Kept-Plain_2#fixture"]);
			expect(readFileSync(file, "utf8")).toBe(plain);
			expect(readdirSync(profileDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
			// Said once, however often it is read.
			savedPasswords(profileDir, key);
			expect(saying.mock.calls.filter(([message]) => String(message).includes("could not be encrypted")).length).toBe(1);
		} finally {
			failing.mockRestore();
			saying.mockRestore();
		}

		expect(savedPasswords(profileDir, key).sort()).toEqual(["Kept-Plain_1#fixture", "Kept-Plain_2#fixture"]);
		expect(stored(file).version).toBe(2);
		expect(onDisk(rootDir, "Kept-Plain_1#fixture")).toBe(false);
	});
});
