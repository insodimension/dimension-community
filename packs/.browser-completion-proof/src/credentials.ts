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
 * Windows, where modes mean nothing, an ACL reduced to the user before a key byte is in the file. It is published
 * whole and durable (staged and restricted, then written and fsynced, then given its name), and made
 * only when no profile already holds a sealed store. A file that does not
 * authenticate (tampered, or under another key) is refused, never read as empty
 * and never rewritten; a key file that is missing, empty or damaged is refused,
 * never replaced (a new key would orphan every password it protected). A store
 * written before this (version 1: plain text) is encrypted in place the first
 * time it is read; a sealed value found inside one (a server from before this
 * one copies what it read into a version-1 file) is opened, never taken for the
 * password.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CREDENTIAL_MODES, type CredentialRequest } from "./contracts.js";
import { fail, writeJsonAtomic } from "./store.js";

const FILE = "credentials.json";
const KEY_FILE = "credentials.key";
/** The stored form of a password: `gcm1:<iv>:<tag>:<ciphertext>`, each part base64 (a 12-byte nonce, a 16-byte tag). */
const SEALED = /^gcm1:([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]{22}==):([A-Za-z0-9+/]*={0,2})$/;
const UNREADABLE = "this profile's saved passwords could not be read";
const NO_KEY = "the key that protects saved passwords (credentials.key in the browser's data folder) is missing, so the passwords sealed under it cannot be opened; restore it from a backup, and until then nothing new is saved";
const BAD_KEY = "the key that protects saved passwords (credentials.key in the browser's data folder) is empty or damaged, so the passwords sealed under it cannot be opened; restore it from a backup, or delete the file if none of them matter and a new key is made at the next save";
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
 * The key that protects every profile's saved passwords: 32 random bytes in `<root>/credentials.key`. One key for the pack: it sits
 * beside `profiles/`, not inside one. Loaded once.
 *
 * Every password depends on this one file, so it is made carefully and used in one direction each way. `get()` is the key to SEAL
 * with: the file, else a new one, which exists whole and durable on disk before `get()` returns. `existing()` is the key to OPEN with:
 * the file or a refusal, never a new key (a new key opens nothing the lost one sealed, and a read must not make one).
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
    return (this.#key ??= keyFrom(this.#load() ?? this.#create()));
  }

  existing(): Buffer {
    if (this.#key !== undefined) return this.#key;
    const text = this.#load();
    if (text === undefined) fail("credentials_unreadable", NO_KEY);
    return (this.#key = keyFrom(text));
  }

  #load(): string | undefined {
    try {
      return readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail("credentials_unreadable", "the key that protects saved passwords could not be read");
    }
  }

  /**
   * Make the key and publish it whole. It is staged in the same folder, restricted to the user BEFORE any key byte is written into it
   * (created empty at mode 0600, its ACL cut where modes mean nothing, and only then filled), fsynced, and only then given its name, so
   * `credentials.key` is never seen empty or half-written (by a second server on this root, or after a crash), the key is never readable
   * by another account even for a moment, and a crash leaves either no key or the whole one. The name is taken with a hard link, which fails when it exists: two servers on one root
   * cannot each publish a different key, and the loser reads the winner's. A filesystem with no hard links takes the name with a rename
   * instead, which is atomic but cannot tell it lost a race (the read-back below still catches one that has already finished).
   * Whatever is returned has been read back from the published file: nothing is sealed under a key that is not what is on disk.
   */
  #create(): string {
    // A key made while stores sealed under a lost one exist would sit beside passwords it can never open, and the lost key coming back would then orphan the ones sealed under this.
    if (this.#holdsSealedStores()) fail("credentials_unreadable", NO_KEY);
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    const text = `${randomBytes(32).toString("base64")}\n`;
    const staging = `${this.#file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      closeSync(openSync(staging, "wx", 0o600));
      onlyTheUser(staging);
      const fd = openSync(staging, "r+");
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(staging, this.#file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.#raced();
        if (this.#load() !== undefined) return this.#raced();
        renameSync(staging, this.#file);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "credentials_unreadable") throw error;
      fail("credentials_unreadable", `the key that protects saved passwords could not be made (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    } finally {
      rmSync(staging, { force: true });
    }
    syncFolder(this.#rootDir);
    if (this.#load() !== text) fail("credentials_unreadable", "the key that protects saved passwords could not be made whole");
    return text;
  }

  /** The key another server published first. */
  #raced(): string {
    const text = this.#load();
    if (text === undefined) fail("credentials_unreadable", "the key that protects saved passwords could not be read");
    return text;
  }

  /**
   * Whether any profile under this root already holds a store sealed under a key (so a key that is not on disk was lost, not never made):
   * a version 2 store, or a version 1 one with a sealed value inside, which a server from before this one leaves when it signs up on a
   * profile this one had sealed (a rollback).
   */
  #holdsSealedStores(): boolean {
    const profiles = join(this.#rootDir, "profiles");
    let names: string[];
    try {
      names = readdirSync(profiles);
    } catch {
      return false;
    }
    return names.some((name) => {
      try {
        const store = JSON.parse(readFileSync(join(profiles, name, FILE), "utf8")) as { version?: unknown; origins?: unknown } | null;
        if (store?.version === 2) return true;
        return typeof store?.origins === "object" && store.origins !== null && Object.values(store.origins).some((value) => typeof value === "string" && SEALED.test(value));
      } catch {
        // No store, or one that read() refuses on its own account.
        return false;
      }
    });
  }
}

/** The key `text` holds. Anything but 32 bytes is not our key: refused, never replaced, since a new key would orphan every password the old one sealed. */
function keyFrom(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) fail("credentials_unreadable", BAD_KEY);
  return key;
}

/** Flush a folder's new entry to disk where the platform lets a folder be opened (Windows does not; its journal covers a rename). */
function syncFolder(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported here */
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

/** Write the store: every password sealed, durably, to a temporary file renamed over the old one, so a crash leaves one whole file. */
function write(file: string, origins: Record<string, string>, key: CredentialKey): void {
  const sealed: Record<string, string> = {};
  for (const [origin, password] of Object.entries(origins)) sealed[origin] = seal(password, origin, key.get());
  writeJsonAtomic(dirname(file), basename(file), { version: 2, origins: sealed });
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
  if (version !== 1 && version !== 2 && version !== undefined) fail("credentials_unreadable", UNREADABLE);
  // Version 1 is plain text, but a value in one that is sealed is opened, never taken for the password: a server from before this one
  // (it ignores `version` and writes back everything it read, ciphertext included) may have signed up on a profile this one had sealed.
  const clear: Record<string, string> = {};
  for (const [origin, value] of Object.entries(stored)) clear[origin] = version === 2 || SEALED.test(value) ? open(value, origin, key.existing()) : value;
  if (version !== 2 && Object.keys(clear).length > 0) migrate(file, clear, key);
  return clear;
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
 * Save `password` as the one the profile at `profileDir` uses for `origin`, keeping every other. The only way a password is written:
 * a sign-up's minted one (`resolveCredential`) and the benchmark's fixture one (bench/seed-credential.ts) both come through here, so
 * nothing writes the file by hand. Callers hold the profile lock, so there is one writer.
 */
export function saveCredential(profileDir: string, origin: string, password: string, key: CredentialKey): void {
  const file = join(profileDir, FILE);
  write(file, { ...read(file, key), [credentialOrigin(origin)]: password }, key);
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
  saveCredential(profileDir, origin, password, key);
  return { origin, password, created: true };
}
