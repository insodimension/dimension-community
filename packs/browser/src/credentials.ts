/**
 * Passwords the browser holds itself, per profile and origin, so a sign-up or
 * login task never puts one in front of a model.
 *
 * The caller (the outer agent) names only an ORIGIN and a mode; it never sees,
 * sends or receives the value. A tool-call argument is written by the outer
 * model and persisted verbatim in the session transcript, so a password passed
 * as an argument would already have leaked before the browser saw it. Instead:
 *  - `signup`: use the password saved for this profile + origin, or mint a
 *    strong random one and save it first. Reusing a saved one keeps a retried
 *    sign-up from orphaning the account an earlier attempt created.
 *  - `login`: use the saved password; there is none to invent.
 * browser_act's `generatePassword` applies the same `signup` rule to a password
 * field's own frame origin, and `useSavedPassword` the `login` rule.
 * The value leaves this process only as those keystrokes, or on the task
 * worker's stdin, and the worker
 * types it into password fields of that origin alone.
 *
 * Stored as `credentials.json` in the profile's own 0700 directory (mode 0600),
 * beside the Chrome profile whose cookies are the same class of secret, and
 * ENCRYPTED: every password is AES-256-GCM, bound to its origin (the origin is
 * the authenticated data, so a ciphertext moved under another origin does not
 * open), under one key that lives in the pack's root (`credentials.key`), never
 * in a profile folder. A copy, a backup or a sync of a profile folder therefore
 * carries no readable password and not the key. The pack has no OS credential
 * store accessor, so the key is a file only the user can read: mode 0600, and on
 * Windows, where modes mean nothing, an ACL reduced to the user. A file that
 * does not authenticate (tampered, or under another key) is refused, never read
 * as empty and never rewritten; a key file that cannot be read is refused, never
 * replaced (a new key would orphan every password it protected). A store written
 * before this (version 1: plain text) is encrypted in place the first time it is
 * read.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_MODES, type CredentialRequest } from "./contracts.js";
import { fail } from "./store.js";

const FILE = "credentials.json";
const KEY_FILE = "credentials.key";
/** The stored form of a password: `gcm1:<iv>:<tag>:<ciphertext>`, each part base64 (a 12-byte nonce, a 16-byte tag). */
const SEALED = /^gcm1:([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]{22}==):([A-Za-z0-9+/]*={0,2})$/;
const UNREADABLE = "this profile's saved passwords could not be read";
const LOOPBACK: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!#%+-=?@_";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;
const GENERATED_LENGTH = 20;

/**
 * The origin a credential is bound to. https anywhere; http only on loopback,
 * where a local app under test lives — a plain-http remote origin would send
 * the password over the wire in clear.
 */
export function credentialOrigin(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof raw === "string" ? raw : "");
  } catch {
    fail("bad_credential", "credential.origin must be a URL such as https://example.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK[url.hostname])) {
    fail("bad_credential", "credential.origin must be https (http only for localhost)");
  }
  return url.origin;
}

/** 20 characters from a CSPRNG, holding every class a password policy asks for. */
export function generatePassword(): string {
  const pick = (set: string): string => set[randomInt(set.length)] as string;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < GENERATED_LENGTH) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

/**
 * The key that protects every profile's saved passwords: 32 random bytes in `<root>/credentials.key`, made the first time something
 * must be sealed or opened (a read of a profile with no passwords never makes one). Loaded once. One key for the pack: it sits beside
 * `profiles/`, not inside one.
 */
export class CredentialKey {
  readonly #file: string;
  readonly #rootDir: string;
  #key: Buffer | undefined;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    this.#file = join(rootDir, KEY_FILE);
  }

  get(): Buffer {
    if (this.#key !== undefined) return this.#key;
    const text = this.#load() ?? this.#create();
    // Anything but 32 bytes is not our key. It is refused, never replaced: a new key would orphan every password the old one sealed.
    const key = Buffer.from(text.trim(), "base64");
    if (key.length !== 32) fail("credentials_unreadable", "the key that protects saved passwords could not be read");
    this.#key = key;
    return key;
  }

  #load(): string | undefined {
    try {
      return readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail("credentials_unreadable", "the key that protects saved passwords could not be read");
    }
  }

  /** Make the key with an exclusive create, so two servers on one root cannot each make a different one; the loser reads the winner's. */
  #create(): string {
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    const text = `${randomBytes(32).toString("base64")}\n`;
    try {
      writeFileSync(this.#file, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const raced = (error as NodeJS.ErrnoException).code === "EEXIST" ? this.#load() : undefined;
      if (raced === undefined) fail("credentials_unreadable", "the key that protects saved passwords could not be made");
      return raced;
    }
    onlyTheUser(this.#file);
    return text;
  }
}

/**
 * Windows ignores the mode of a created file; it would carry the folder's inherited ACL. Cut the inheritance and grant the one account
 * that runs this process. Best effort by nature (a root on a share that has no ACLs): said on stderr, never fatal.
 */
function onlyTheUser(file: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const run = user === undefined ? undefined : spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, encoding: "utf8" });
  if (run === undefined || run.status !== 0) console.error("The key that protects saved passwords could not be restricted to your account; it keeps the folder's permissions.");
}

/** Seal `password` for `origin`: a fresh nonce each time, the origin as authenticated data. */
function seal(password: string, origin: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(origin, "utf8"));
  const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return `gcm1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

/** The password `sealed` holds for `origin`; a value that is not one of ours, or does not authenticate, is refused without saying what it held. */
function open(sealed: string, origin: string, key: Buffer): string {
  const parts = SEALED.exec(sealed);
  if (parts === null) fail("credentials_unreadable", UNREADABLE);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1] as string, "base64"));
    decipher.setAAD(Buffer.from(origin, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2] as string, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3] as string, "base64")), decipher.final()]).toString("utf8");
  } catch {
    fail("credentials_unreadable", UNREADABLE);
  }
}

/** Write the store: every password sealed, to a temporary file renamed over the old one, so a crash leaves one whole file. */
function write(file: string, origins: Record<string, string>, key: CredentialKey): void {
  const sealed: Record<string, string> = {};
  for (const [origin, password] of Object.entries(origins)) sealed[origin] = seal(password, origin, key.get());
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 2, origins: sealed })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    // A failed rename (a scanner holding the file on Windows) must not strand a second copy of every saved password; after a good rename this is a no-op.
    rmSync(tmp, { force: true });
  }
}

/** Plain-text stores already said to be unencryptable, by file: said once, not at every read. */
const unmigrated = new Set<string>();

/**
 * Every password in the store at `file`, by origin, in the clear. A version 1 store (plain text) is encrypted in place before this
 * returns; when it cannot be rewritten (a scanner holds the file) the passwords are still answered, the failure is said once, and the
 * next read tries again.
 */
function read(file: string, key: CredentialKey): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never echo the file: it holds the values this module exists to keep.
    fail("credentials_unreadable", UNREADABLE);
  }
  // A file of any other shape is refused, never treated as empty: the next
  // sign-up would rewrite it and silently drop every password it held.
  const version = (parsed as { version?: unknown } | null)?.version;
  const origins = (parsed as { origins?: unknown } | null)?.origins;
  if (!origins || typeof origins !== "object" || Array.isArray(origins) || Object.values(origins).some((v) => typeof v !== "string")) fail("credentials_unreadable", UNREADABLE);
  const stored = origins as Record<string, string>;
  if (version === 2) {
    const clear: Record<string, string> = {};
    for (const [origin, sealed] of Object.entries(stored)) clear[origin] = open(sealed, origin, key.get());
    return clear;
  }
  if (version !== 1 && version !== undefined) fail("credentials_unreadable", UNREADABLE);
  if (Object.keys(stored).length > 0) migrate(file, stored, key);
  return stored;
}

/** Encrypt a plain-text store in place. A key that cannot be had is the key's own refusal; a file that cannot be written yet is retried at the next read. */
function migrate(file: string, plain: Record<string, string>, key: CredentialKey): void {
  try {
    write(file, plain, key);
    unmigrated.delete(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "credentials_unreadable") throw error;
    if (!unmigrated.has(file)) console.error("Saved passwords could not be encrypted in place yet; they stay readable and the next read tries again.");
    unmigrated.add(file);
  }
}

/** Every password the profile at `profileDir` holds, by origin, in the clear. */
export function readCredentials(profileDir: string, key: CredentialKey): Record<string, string> {
  return read(join(profileDir, FILE), key);
}

/**
 * The password this profile saved for exactly `origin`, if any; never mints
 * one. browser_act's `useSavedPassword` types it into a password field of that
 * origin.
 */
export function savedPassword(profileDir: string, origin: string, key: CredentialKey): string | undefined {
  const origins = readCredentials(profileDir, key);
  return Object.hasOwn(origins, origin) ? origins[origin] : undefined;
}

/** Every password this profile holds, so page reads handed back can be scrubbed of them. */
export function savedPasswords(profileDir: string, key: CredentialKey): string[] {
  return Object.values(readCredentials(profileDir, key));
}

/**
 * The password for `origin` in the profile at `profileDir`, minting and saving
 * one for a sign-up. Callers hold the profile lock, so there is one writer.
 */
export function resolveCredential(profileDir: string, request: CredentialRequest, key: CredentialKey): { origin: string; password: string; created: boolean } {
  if (!CREDENTIAL_MODES.includes(request.mode)) fail("bad_credential", `credential.mode must be one of: ${CREDENTIAL_MODES.join(", ")}`);
  const origin = credentialOrigin(request.origin);
  const file = join(profileDir, FILE);
  const origins = read(file, key);
  const saved = origins[origin];
  if (saved) return { origin, password: saved, created: false };
  if (request.mode === "login") {
    fail("no_credential", `this profile has no saved password for ${origin}; log in with browser_act, or put the password in a browser_task`);
  }
  const password = generatePassword();
  write(file, { ...origins, [origin]: password }, key);
  return { origin, password, created: true };
}
