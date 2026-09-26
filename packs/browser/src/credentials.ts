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
 * The value leaves this process only on the task worker's stdin, and the worker
 * types it into password fields of that origin alone.
 *
 * Stored as `credentials.json` in the profile's own 0700 directory (mode 0600),
 * beside the Chrome profile whose cookies are the same class of secret.
 */
import { randomInt } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_MODES, type CredentialRequest } from "./contracts.js";
import { fail } from "./store.js";


const FILE = "credentials.json";
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

function read(file: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never echo the file: it holds the values this module exists to keep.
    fail("credentials_unreadable", "this profile's saved passwords could not be read");
  }
  // A file of any other shape is refused, never treated as empty: the next
  // sign-up would rewrite it and silently drop every password it held.
  const origins = (parsed as { origins?: unknown } | null)?.origins;
  if (!origins || typeof origins !== "object" || Array.isArray(origins) || Object.values(origins).some((v) => typeof v !== "string")) {
    fail("credentials_unreadable", "this profile's saved passwords could not be read");
  }
  return origins as Record<string, string>;
}

/**
 * The password this profile saved for exactly `origin`, if any; never mints
 * one. browser_act types it instead of the text it was given when the field
 * it types into is a password input of that origin.
 */
export function savedPassword(profileDir: string, origin: string): string | undefined {
  const origins = read(join(profileDir, FILE));
  return Object.hasOwn(origins, origin) ? origins[origin] : undefined;
}

/**
 * The password for `origin` in the profile at `profileDir`, minting and saving
 * one for a sign-up. Callers hold the profile lock, so there is one writer.
 */
export function resolveCredential(profileDir: string, request: CredentialRequest): { origin: string; password: string; created: boolean } {
  if (!CREDENTIAL_MODES.includes(request.mode)) fail("bad_credential", `credential.mode must be one of: ${CREDENTIAL_MODES.join(", ")}`);
  const origin = credentialOrigin(request.origin);
  const file = join(profileDir, FILE);
  const origins = read(file);
  const saved = origins[origin];
  if (saved) return { origin, password: saved, created: false };
  if (request.mode === "login") {
    fail("no_credential", `this profile has no saved password for ${origin}; log in with browser_act, or put the password in a browser_task`);
  }
  const password = generatePassword();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, origins: { ...origins, [origin]: password } })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    // A failed rename (a scanner holding the file on Windows) must not strand a
    // second copy of every saved password; after a good rename this is a no-op.
    rmSync(tmp, { force: true });
  }
  return { origin, password, created: true };
}
