/**
 * Filesystem state for the browser runtime.
 *
 * Owns five things and nothing else:
 *   1. Profile directory layout + filesystem-safe slug validation.
 *   2. The per-profile process lock (atomic create, owner-token release,
 *      NEVER steals a stale lock and NEVER kills a foreign process).
 *   3. Each profile's sign-in observations (`connections.json`, see
 *      connection.ts), kept in the profile's own directory so a deleted
 *      profile takes them with it and a restart can report them again.
 *   4. Each profile's metadata (`profile.json`: label, colour, avatar, last
 *      used, the browser build that made it), beside `chrome/`. Optional: a
 *      profile without one works, with defaults derived from its slug.
 *   5. Throwaway browser directories (`<root>/ephemeral/<id>`): created for a
 *      browser opened without a profile, deleted when it closes, and swept
 *      after a server that died before it could delete them. They are never
 *      profiles: no lock, no listing, no observations.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ConnectionObservations, keepFirst, type SiteObservation, type SiteObservations } from "./connection.js";
import { PROFILE_NAME, profileSlug } from "./profile-name.js";
import type { ArtifactoryLoopPrincipal } from "./contracts.js";
import { cleanAvatar, cleanLabel, isProfileColour, type StoredProfileMeta } from "./profile-meta.js";

/** The most profiles the pack lists and the View will create. */
export const MAX_PROFILES = 256;
const CONNECTIONS_FILE = "connections.json";
const PROFILE_FILE = "profile.json";
/** Inside a throwaway directory: the pid of the server that made it. */
const OWNER_FILE = "owner.pid";
/** Sites remembered per profile; the oldest observation goes first. */
const MAX_SITES_PER_PROFILE = 64;
/** Versioned, fixed-width names keep host identities out of filenames and bound path length. */
const CONSENT_VERSION = 1;
function consentFile(principal: ArtifactoryLoopPrincipal, profile: string): string {
	return createHash("sha256").update(JSON.stringify([CONSENT_VERSION, principal.workspaceId, principal.id, principal.origin, profile])).digest("hex") + ".json";
}
function validPrincipal(principal: ArtifactoryLoopPrincipal): boolean {
	return [principal.workspaceId, principal.id, principal.origin].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024)
		&& typeof principal.label === "string" && principal.label.length <= 1024;
}
const MAX_ACCOUNT_CHARS = 1_024;

export class BrowserRuntimeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "BrowserRuntimeError";
		this.code = code;
	}
}

export function fail(code: string, message: string): never {
	throw new BrowserRuntimeError(code, message);
}

/** Thrown by a driver when provably nothing reached the page (no target, bad input). */
export class ActionNotDispatched extends BrowserRuntimeError {}

/**
 * Validate a profile name into a filesystem-safe slug. Rejects (never rewrites)
 * anything that could escape the profile root: separators, `..`, drive letters,
 * NUL, or anything outside the conservative charset.
 */
export function validateProfile(raw: unknown): string {
	if (typeof raw !== "string") fail("bad_profile", "profile must be a string");
	const slug = profileSlug(raw);
	if (slug === null) {
		fail(
			"bad_profile",
			`profile ${JSON.stringify(raw)} is not a valid slug: use 1-48 chars of [a-z0-9_-] starting alphanumeric`,
		);
	}
	return slug;
}

export interface LockHandle {
	readonly path: string;
	readonly token: string;
}

export class ProfileStore {
	readonly rootDir: string;
	constructor(rootDir?: string) {
		this.rootDir = resolve(rootDir ?? defaultRootDir());
		mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 });
	}

	get profilesRoot(): string {
		return join(this.rootDir, "profiles");
	}

	/** A grant is one file per exact subject and profile: distinct grants never overwrite each other. */
	private get consentRoot(): string { return join(this.rootDir, "profile-consents"); }

	hasLoopConsent(principal: ArtifactoryLoopPrincipal, profile: string): boolean {
		if (!validPrincipal(principal) || profileSlug(profile) !== profile) return false;
		try {
			const raw = readFileSync(join(this.consentRoot, consentFile(principal, profile)), "utf8");
			// Three 1024-character identity fields still fit when JSON-escaped.
			if (raw.length > 32 * 1024) return false;
			const grant: unknown = JSON.parse(raw);
			if (typeof grant !== "object" || grant === null || Array.isArray(grant)) return false;
			const value = grant as Record<string, unknown>;
			return value.version === CONSENT_VERSION && value.workspaceId === principal.workspaceId
				&& value.id === principal.id && value.origin === principal.origin && value.profile === profile
				&& value.granted === true && Object.keys(value).length === 6;
		} catch { return false; }
	}

	setLoopConsent(principal: ArtifactoryLoopPrincipal, profile: string, granted: boolean): void {
		if (!validPrincipal(principal) || profileSlug(profile) !== profile) fail("bad_principal", "Invalid Loop subject or profile.");
		mkdirSync(this.consentRoot, { recursive: true, mode: 0o700 });
		writeJsonAtomic(this.consentRoot, consentFile(principal, profile), {
			version: CONSENT_VERSION, workspaceId: principal.workspaceId, id: principal.id,
			origin: principal.origin, profile, granted,
		});
	}

	profileDir(slug: string): string {
		return join(this.profilesRoot, slug);
	}

	/** Chrome `userDataDir` for a persistent, isolated profile. */
	userDataDir(slug: string): string {
		return join(this.profileDir(slug), "chrome");
	}

	/** Whether a folder for `slug` is on disk, listed or not (the listing stops at MAX_PROFILES). Creates nothing. */
	exists(slug: string): boolean {
		return existsSync(this.profileDir(slug));
	}

	/** Reserve a new profile's canonical directory atomically. An existing directory is never treated as ours. */
	claimNewProfile(slug: string): boolean {
		try {
			mkdirSync(this.profileDir(slug), { mode: 0o700 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	}
	ensureProfile(slug: string): string {
		const dir = this.profileDir(slug);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	/** Profiles that have ever been materialized on disk, sorted, at most MAX_PROFILES: beyond that they are not listed (and `addProfile` refuses to make more). */
	list(): string[] {
		let entries: string[];
		try {
			entries = readdirSync(this.profilesRoot);
		} catch {
			return [];
		}
		return entries
			.filter((name) => PROFILE_NAME.test(name))
			.filter((name) => {
				try {
					return statSync(join(this.profilesRoot, name)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort()
			.slice(0, MAX_PROFILES);
	}

	get ephemeralRoot(): string {
		return join(this.rootDir, "ephemeral");
	}

	/**
	 * A fresh directory for one throwaway browser, marked with this server's
	 * pid so a later start can tell it was abandoned. Chrome's user-data dir is
	 * `userDataDir`; the marker sits beside it, outside anything Chrome writes.
	 */
	createEphemeral(): { dir: string; userDataDir: string } {
		const dir = join(this.ephemeralRoot, randomBytes(8).toString("hex"));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			writeFileSync(join(dir, OWNER_FILE), String(process.pid), { mode: 0o600 });
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		return { dir, userDataDir: join(dir, "chrome") };
	}

	/**
	 * Delete a throwaway directory once its browser is gone. Chrome's helper
	 * processes can hold files for a moment after it exits (Windows), so the
	 * delete retries. Never throws: a directory that would not go stays marked
	 * with its owner and is swept once that server is dead. Refuses anything
	 * that is not a direct child of `ephemeral/`, so a bad path can never reach
	 * a profile.
	 */
	async removeEphemeral(dir: string): Promise<void> {
		if (dirname(resolve(dir)) !== this.ephemeralRoot) {
			throw new Error(`refusing to delete ${dir}: not a throwaway browser directory`);
		}
		try {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			console.error(`Throwaway browser data was not deleted (${dir}); it is removed once this server exits:`, error instanceof Error ? error.message : error);
		}
	}

	/**
	 * Delete throwaway directories a dead server left behind. One goes only
	 * when its recorded owner is provably gone AND no browser still holds it;
	 * a directory without a readable owner, or held by anything, stays. Never
	 * touches `profiles/`.
	 */
	sweepEphemeral(): void {
		let names: string[];
		try {
			names = readdirSync(this.ephemeralRoot);
		} catch {
			return;
		}
		for (const name of names) {
			const dir = join(this.ephemeralRoot, name);
			const owner = readOwner(dir);
			if (owner === undefined || processAlive(owner) || browserHolds(join(dir, "chrome"))) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch (error) {
				console.error(`Abandoned throwaway browser data was not deleted (${dir}); it is retried at the next start:`, error instanceof Error ? error.message : error);
			}
		}
	}

	/**
	 * Acquire the per-profile lock atomically (`O_CREAT | O_EXCL`). A lock held
	 * by a LIVE process is always honoured: we never kill its owner. A lock whose
	 * owning process is provably gone (the engine was killed, the machine
	 * restarted) is reclaimed once — otherwise every hard stop would strand the
	 * profile until a human deleted a file. A Chrome that outlived its runtime
	 * still holds Chrome's own profile lock, so the launch that follows fails
	 * rather than forking the profile.
	 */
	acquireLock(slug: string): LockHandle {
		this.ensureProfile(slug);
		const path = join(this.profileDir(slug), "runtime.lock");
		const token = randomBytes(16).toString("hex");
		const body = `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`;
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (err) {
			const existing = readLock(path);
			if (existing?.pid !== undefined && existing.pid !== process.pid && !processAlive(existing.pid)) {
				unlinkSync(path);
				return this.acquireLock(slug);
			}
			const who = existing
				? `pid ${existing.pid} since ${existing.at}`
				: `code ${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			fail(
				"profile_locked",
				`profile "${slug}" is already in use (${who}). Close that browser first (browser_close), or use another profile.`,
			);
		}
		let failure: unknown;
		try {
			writeFileSync(fd, body);
			fsyncSync(fd);
		} catch (error) {
			failure = error;
			try {
				// The open descriptor pins our file identity even after a partial write.
				const owned = fstatSync(fd, { bigint: true });
				const current = lstatSync(path, { bigint: true });
				const replacement = readLock(path);
				if (owned.dev === current.dev && owned.ino === current.ino && (!replacement || replacement.token === token)) unlinkSync(path);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					failure = new AggregateError([error, cleanupError], "Profile lock initialization failed and owned lock cleanup could not be confirmed.");
				}
			}
		}
		try {
			closeSync(fd);
		} catch (error) {
			if (failure !== undefined) {
				failure = new AggregateError([failure, error], "Profile lock initialization failed and its descriptor could not be closed.");
			} else {
				failure = error;
				try {
					// The complete token was written: a close failure must not orphan it.
					if (readLock(path)?.token === token) unlinkSync(path);
				} catch (cleanupError) {
					failure = new AggregateError([error, cleanupError], "Profile lock descriptor close failed and owned lock cleanup could not be confirmed.");
				}
			}
		}
		if (failure !== undefined) throw failure;
		return { path, token };
	}

	/** Release only if the on-disk token still matches ours. Never throws. */
	releaseLock(lock: LockHandle): void {
		const existing = readLock(lock.path);
		if (!existing || existing.token !== lock.token) return;
		try {
			unlinkSync(lock.path);
		} catch {
			/* already gone */
		}
	}

	/**
	 * Whether a live process holds this profile's lock right now. Asked of a
	 * profile this runtime holds no browser for: then it is another server's (or
	 * another runtime's on this root), and the profile is not free to open.
	 */
	heldElsewhere(slug: string): boolean {
		const pid = readLock(join(this.profileDir(slug), "runtime.lock"))?.pid;
		return pid !== undefined && processAlive(pid);
	}

	/** This profile's persisted sign-in observations; none when it was never observed or the file is unreadable. */
	connections(slug: string): SiteObservations {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(this.profileDir(slug), CONNECTIONS_FILE), "utf8"));
		} catch {
			return {};
		}
		const sites: SiteObservations = {};
		const stored = (parsed as { sites?: unknown } | null)?.sites;
		if (typeof stored !== "object" || stored === null) return sites;
		for (const [host, value] of Object.entries(stored as Record<string, unknown>)) {
			const site = value as Partial<SiteObservation> | null;
			if ((typeof site?.signedIn !== "boolean" && site?.signedIn !== null) || typeof site.observedAt !== "number" || !Number.isFinite(site.observedAt)) continue;
			const valid: SiteObservation = { signedIn: site.signedIn, observedAt: site.observedAt };
			if (typeof site.account === "string" && site.account.length <= MAX_ACCOUNT_CHARS) valid.account = site.account;
			sites[host] = valid;
		}
		return sites;
	}

	/**
	 * Persist one observation of `host`, replacing that host's last one. A site
	 * that was only visited (`signedIn: null`) is the first to go when the
	 * profile is full: it never pushes out a site that was actually checked.
	 */
	recordConnection(slug: string, host: string, observation: SiteObservation): void {
		const sites = { ...this.connections(slug), [host]: observation };
		const kept = Object.entries(sites).sort(([, a], [, b]) => keepFirst(a, b)).slice(0, MAX_SITES_PER_PROFILE);
		writeJsonAtomic(this.ensureProfile(slug), CONNECTIONS_FILE, { sites: Object.fromEntries(kept) });
	}

	/** Every on-disk profile that has observations. A deleted profile directory is simply not here. */
	allConnections(): ConnectionObservations {
		const all: ConnectionObservations = {};
		for (const slug of this.list()) {
			const sites = this.connections(slug);
			if (Object.keys(sites).length > 0) all[slug] = sites;
		}
		return all;
	}

	/** This profile's metadata: only the fields the rules allow; `{}` when there is no file or it is unreadable. */
	meta(slug: string): StoredProfileMeta {
		let parsed: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(readFileSync(join(this.profileDir(slug), PROFILE_FILE), "utf8"));
			if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
			parsed = value as Record<string, unknown>;
		} catch {
			return {};
		}
		const meta: StoredProfileMeta = {};
		const label = cleanLabel(parsed.label);
		if (label !== undefined) meta.label = label;
		if (isProfileColour(parsed.colour)) meta.colour = parsed.colour;
		const avatar = cleanAvatar(parsed.avatar);
		if (avatar !== undefined) meta.avatar = avatar;
		if (typeof parsed.lastUsed === "number" && Number.isFinite(parsed.lastUsed) && parsed.lastUsed >= 0) meta.lastUsed = parsed.lastUsed;
		if (typeof parsed.app === "string" && /^[a-z0-9-]{1,24}$/.test(parsed.app)) meta.app = parsed.app;
		return meta;
	}

	/**
	 * Change some of a profile's metadata, keeping the fields the patch does not
	 * name. Atomic like the observations. Never renames or moves the folder.
	 */
	saveMeta(slug: string, patch: StoredProfileMeta): void {
		writeJsonAtomic(this.ensureProfile(slug), PROFILE_FILE, { ...this.meta(slug), ...patch });
	}
}

/**
 * Write `value` as `<dir>/<file>`. Atomic and durable: the staging file is
 * fsynced before the rename, so a crash or power loss leaves the old file or
 * the new one; a failure at any step removes the staging file.
 */
export function writeJsonAtomic(dir: string, file: string, value: unknown): void {
	const path = join(dir, file);
	const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(staging, "w", 0o600);
		writeSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(staging, path);
	} catch (error) {
		if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
		try { unlinkSync(staging); } catch { /* never created, or already gone */ }
		throw error;
	}
}

function readLock(path: string): { pid?: number; token?: string; at?: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			token: typeof parsed.token === "string" ? parsed.token : undefined,
			at: typeof parsed.at === "string" ? parsed.at : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Signal 0 probes existence only. EPERM means it exists but is not ours to signal. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid recorded in a throwaway directory; undefined when it is missing or not a pid (never guessed at). */
function readOwner(dir: string): number | undefined {
	try {
		const text = readFileSync(join(dir, OWNER_FILE), "utf8").trim();
		return /^\d{1,10}$/.test(text) ? Number(text) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a Chrome still runs on `userDataDir`, by the marker Chrome itself
 * keeps for as long as it does. Windows: `lockfile`, held open without write
 * sharing and deleted by the OS when the process ends. Elsewhere:
 * `SingletonLock`, a symlink to `<host>-<pid>` that a crash leaves behind, so
 * it counts only while that pid is alive. An unreadable marker counts as held.
 */
function browserHolds(userDataDir: string): boolean {
	if (process.platform === "win32") {
		try {
			closeSync(openSync(join(userDataDir, "lockfile"), "r+"));
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ENOENT";
		}
	}
	let target: string;
	try {
		target = readlinkSync(join(userDataDir, "SingletonLock"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	const pid = /-(\d+)$/.exec(target)?.[1];
	return pid === undefined || processAlive(Number(pid));
}

export function defaultRootDir(): string {
	const insoHome = process.env.INSO_HOME?.trim();
	if (insoHome) return join(insoHome, "browser");
	return join(homedir(), ".inso", "browser");
}
