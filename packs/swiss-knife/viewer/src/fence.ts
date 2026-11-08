// The path fence: which files the viewer will open. Everything the model or the
// View can ask for passes `Fence.check` first, and `check` answers with a REAL
// path (symlinks resolved) or a refusal that names the reason.
//
// Policy (v1):
//   1. The path must be absolute and free of tricks (NUL, Windows device paths,
//      alternate data streams, network/UNC paths). The tricks are refused on the
//      text alone, BEFORE any filesystem call: `realpath` on `\\host\share` or a
//      WebDAV spelling would make the OS authenticate to a host the model chose.
//   2. DENY beats allow: private keys, `.env*`, credential and token stores, the
//      Personal vault's Locker (its `locker` folders, `_locker.json`,
//      `*.secret.json`), the engine's agent state and databases are refused
//      wherever they live, even inside an allowed folder. The deny check runs on
//      the path as written AND on the resolved real path, so a symlink to
//      `~/.ssh/id_rsa` is refused for what it is, not what it is called.
//   3. The REAL path must sit under an allowed root. Symlinks, `..` and 8.3 short
//      names all collapse in `realpath`, so an escape by link is refused by the
//      same containment test as any other outside path.
//   4. A path that is OUTSIDE the roots gets ONE sentence, whatever the cause
//      (missing, unreadable, a link that leads out, a plain outside file): the
//      answer must not say which outside paths exist. The cause goes to the
//      `log` option (the server's stderr). Inside the roots the errors are
//      specific (no such file, permission denied).
//   5. A host-lent FILE (doc 86 §5). A human clicking Open lends ONE file: the
//      engine stamps `_meta["ai.insodimension/grant"] = { read: [<realpath>] }` on
//      the calls of that View, and this server treats it as ONE extra file, never
//      a folder. It is checked AFTER 1 and 2 and never instead of them: a click
//      cannot open a secret. A file is lent only when the REQUESTED path, resolved
//      to its real path, equals a lent entry (no prefix, no sibling, no parent, and
//      the entry is not resolved again) and is a regular file. The engine strips the
//      key from every call it did not stamp, but this server does not rely on that:
//      a grant with any flaw (not an object, `read` not a list, a non-string or
//      relative entry, more than 8 files) is NO grant, and no grant changes nothing.
//
// The ROOTS are configuration, not a lent fact: the server is not told which
// workspace a session lives in (doc 84 gap G4) nor the engine home (the engine
// scrubs its home pointers from the environment of every child it spawns). Roots
// come from `VIEWER_ROOTS` (a path list) and `INSO_VAULT_DIR`, plus the managed
// homes an install puts under `~/.inso` / `~/.inso-dev` (`vault` = the Personal
// home, `machinist`). Refusals name `VIEWER_ROOTS` so the fix is in the message.
//
// Pure where it can be: `denyReason`, `insideRoot` and `configuredRoots` take
// their platform and inputs as arguments. Only `createFence` touches the disk
// (one `realpath` per check; a few more, on the refusal path only, and one `stat`
// for a lent file that matches), and it accepts the `realpath` and `isFile` to use.
import { realpath as nativeRealpath, stat as nativeStat } from "node:fs/promises";
import * as nodePath from "node:path";
import { ARTIFACTORY_GRANT_META_KEY, type ArtifactoryGrantMeta } from "@dimension/sdk/artifactory";
import type { Library } from "../../src/library/types";

type Platform = NodeJS.Platform;
type PathApi = typeof nodePath.posix;

const pathApi = (platform: Platform): PathApi => (platform === "win32" ? nodePath.win32 : nodePath.posix);

/** Windows and macOS volumes compare names without regard to case by default. */
const foldsCase = (platform: Platform): boolean => platform === "win32" || platform === "darwin";

/** `path` as the platform compares names. Containment and "the same file" both go through it, so they can never disagree about case. */
const comparable = (path: string, platform: Platform): string => (foldsCase(platform) ? path.toLowerCase() : path);

const segmentsOf = (path: string): string[] => path.toLowerCase().split(/[\\/]+/).filter(part => part !== "");

/** Folders an install always lends the viewer, relative to the home directory. */
const MANAGED_HOMES = [".inso", ".inso-dev"] as const;
const MANAGED_FOLDERS = ["vault", "machinist"] as const;

/** The allowed roots for an environment. Relative entries are dropped: a root
 *  that depends on the working directory is not a root. */
export function configuredRoots(env: Readonly<Record<string, string | undefined>>, home: string, platform: Platform): string[] {
	const api = pathApi(platform);
	const roots: string[] = [];
	const delimiter = platform === "win32" ? ";" : ":";
	for (const entry of (env.VIEWER_ROOTS ?? "").split(delimiter)) roots.push(entry.trim());
	roots.push((env.INSO_VAULT_DIR ?? "").trim());
	for (const managed of MANAGED_HOMES) for (const folder of MANAGED_FOLDERS) roots.push(api.join(home, managed, folder));
	return [...new Set(roots.filter(root => root !== "" && api.isAbsolute(root)).map(root => api.resolve(root)))];
}

/** Whether `target` is `root` or below it. Segment-wise, so `/a/bc` is not under `/a/b`. */
export function insideRoot(target: string, root: string, platform: Platform): boolean {
	const api = pathApi(platform);
	const relative = api.relative(comparable(root, platform), comparable(target, platform));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

// The deny tables below are the plugin's ONE definition of a secret path: the
// viewer's fence reads them, and so does `present` (`src/present.ts` imports them
// from here and bundles them into `dist/index.mjs`). Change a table here and both
// tools follow; `test/deny.test.ts` holds every entry to a refusal.
export const SECRET_DIRECTORIES: Readonly<Record<string, true>> = {
	".ssh": true,
	".gnupg": true,
	".aws": true,
	".azure": true,
	".kube": true,
	".docker": true,
	".git": true,
	".password-store": true,
	keyrings: true,
	// The Personal vault's Locker (`<vault>/locker`, `<vault>/projects/<p>/locker`):
	// sealed entries beside a plaintext control file and audit log that carry the
	// scrypt salt and a passphrase oracle. Any folder of that name is refused: a
	// vault can live at any `INSO_VAULT_DIR`, and over-denying a folder called
	// `locker` is harmless where under-denying one is not.
	locker: true,
};

/** Consecutive folder names that mark a credential store. */
export const SECRET_PATHS: readonly (readonly string[])[] = [
	[".config", "gcloud"],
	["microsoft", "credentials"],
	["microsoft", "protect"],
	["microsoft", "vault"],
	["library", "keychains"],
];

export const SECRET_FILES: Readonly<Record<string, true>> = {
	".netrc": true,
	_netrc: true,
	".npmrc": true,
	".pypirc": true,
	".pgpass": true,
	".git-credentials": true,
	".s3cfg": true,
	credentials: true,
	"credentials.json": true,
	"credentials.db": true,
	"secrets.json": true,
	"secrets.yml": true,
	"secrets.yaml": true,
	token: true,
	"token.json": true,
	"tokens.json": true,
	"auth.json": true,
	"service-account.json": true,
	// Browser profile stores.
	"login data": true,
	cookies: true,
	"cookies.sqlite": true,
	"logins.json": true,
	"key3.db": true,
	"key4.db": true,
	// The desktop app's install identity: a bearer for the crowd API.
	"activation.json": true,
	// The Locker's control file, wherever a copy of it ended up (a backup, an export).
	"_locker.json": true,
};

export const PRIVATE_KEY_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx))$/;
export const ENVIRONMENT_FILE = /^(?:\.env.*|.*\.env)$/;
export const OTHER_SECRET_FILE = /^(?:client_secret.*\.json|.*\.tfstate(?:\.backup)?|.*\.kubeconfig|.*\.secret\.json)$/;
export const DATABASE_FILE = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/;
/** `.inso`, `.inso-dev`, `.omp` and their suffixed variants. */
export const ENGINE_HOME = /^\.(?:inso|omp)(?:-[a-z0-9._-]+)?$/;
const DURABLE_COPY_SUFFIX = /\.(?:bak|corrupt-[a-z0-9-]+|shrink-[a-z0-9-]+\.bak|\d+\.[0-9a-f-]+\.(?:tmp|move|aside))$/;

/**
 * Why `path` must never be opened, or `undefined` when nothing on it is
 * forbidden. Matching is case-insensitive on every platform: over-denying
 * `.ENV` on a case-sensitive disk is harmless, under-denying it on NTFS is not.
 * A refusal names a CATEGORY, never the content.
 */
export function denyReason(path: string): string | undefined {
	const segments = segmentsOf(path);
	const named = segments[segments.length - 1] ?? "";
	const base = named.replace(DURABLE_COPY_SUFFIX, "");
	for (const segment of segments) if (Object.hasOwn(SECRET_DIRECTORIES, segment)) return `it is inside a credentials folder (${segment})`;
	for (const secret of SECRET_PATHS) {
		for (let at = 0; at + secret.length <= segments.length; at++) {
			if (secret.every((part, index) => segments[at + index] === part)) return `it is inside a credentials store (${secret.join("/")})`;
		}
	}
	if (ENVIRONMENT_FILE.test(base)) return "it is an environment file (.env), which holds secrets";
	if (PRIVATE_KEY_FILE.test(base)) return "it is a private key or certificate file";
	if (Object.hasOwn(SECRET_FILES, base) || OTHER_SECRET_FILE.test(base)) return "it is a credentials or token file";
	for (let at = 0; at < segments.length; at++) {
		if (!ENGINE_HOME.test(segments[at] ?? "")) continue;
		const next = segments[at + 1];
		if (next === "agent" || (next === "profiles" && segments[at + 3] === "agent")) {
			return "it is the engine's agent state (credentials, sessions and databases)";
		}
		if (DATABASE_FILE.test(named) || DATABASE_FILE.test(base)) return "it is a database inside an engine home";
	}
	return undefined;
}

/**
 * Why `requested` is refused on its TEXT alone, before any filesystem call, or
 * `undefined`. These are the Windows spellings the operating system acts on:
 * a device path, an alternate data stream, a network path (resolving one is a
 * network request to a host the model chose). Pure: the platform is an argument.
 * The empty, NUL and not-absolute refusals stay in `check`, which answers them
 * first. `what` finishes the sentence ("... are not <what>"): the fence says
 * `viewable`, and `present`, which screens the same spellings through this
 * function, says `presentable`.
 */
export function textRefusal(requested: string, platform: Platform, what: "viewable" | "presentable" = "viewable"): string | undefined {
	if (platform !== "win32") return undefined;
	if (/^[\\/]{2}[.?][\\/]/.test(requested)) return `Windows device paths (\\\\.\\ and \\\\?\\) are not ${what}`;
	if (requested.slice(2).includes(":")) return `alternate data streams (a ':' after the drive) are not ${what}`;
	// Any two leading separators, either kind: `\\host\share`, `//host/share`,
	// `\\host@SSL@443\DavWWWRoot\x`. Every root is a local folder, so no
	// legitimate one exists.
	if (/^[\\/]{2}/.test(requested)) return `network paths (\\\\host\\share) are not ${what}`;
	return undefined;
}

export type FenceVerdict =
	| { readonly ok: true; /** The path with every symlink resolved: open THIS, never the request. */ readonly real: string }
	| { readonly ok: false; /** Names the reason; safe to show the model and the user. */ readonly reason: string };

export interface Fence {
	/** The allowed roots as configured (lexical, absolute). */
	readonly roots: readonly string[];
	/**
	 * `meta` is the `_meta` of the tool call being answered: the host-lent file
	 * grant (policy 5) is read from it, and nothing else in it is. Absent or
	 * malformed ⇒ no grant, which is the fence's answer without one.
	 */
	check(requested: unknown, meta?: unknown): Promise<FenceVerdict>;
}

export interface FenceOptions {
	/** The user's home directory (`os.homedir()`). */
	readonly home: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly platform?: Platform;
	/** Extra absolute roots, beyond the environment's. */
	readonly roots?: readonly string[];
	/** Defaults to the native `fs.promises.realpath` (long names, links resolved). */
	readonly realpath?: (path: string) => Promise<string>;
	/** Whether a real path is a regular file (not a directory or a device). Defaults to a native `stat`. */
	readonly isFile?: (path: string) => Promise<boolean>;
	/** Where the cause of an outside-the-roots refusal goes: it is kept out of the answer. Defaults to nowhere. */
	readonly log?: (detail: string) => void;
	readonly indexed?: Pick<Library, "isLent">;
}

const refuse = (reason: string): FenceVerdict => ({ ok: false, reason });

/** The most files one grant may lend, and the longest path in it: the engine's own caps (doc 86 C2). */
const MAX_LENT_FILES = 8;
const MAX_LENT_PATH = 4096;

export function createFence(options: FenceOptions): Fence {
	const platform = options.platform ?? process.platform;
	const api = pathApi(platform);
	const resolveReal = options.realpath ?? nativeRealpath;
	const isRegularFile = options.isFile ?? (async (path: string) => (await nativeStat(path)).isFile());
	const log = options.log ?? (() => undefined);
	const extra = (options.roots ?? []).filter(root => api.isAbsolute(root)).map(root => api.resolve(root));
	const roots = [...new Set([...configuredRoots(options.env ?? {}, options.home, platform), ...extra])];
	const realRootCache = new Map<string, string>();

	// A root's real path is resolved once it exists and then kept: a root that is
	// a link (`/tmp` on macOS) must be compared by where it POINTS.
	async function realRoots(): Promise<string[]> {
		const out: string[] = [];
		for (const root of roots) {
			let real = realRootCache.get(root);
			if (real === undefined) {
				try {
					real = await resolveReal(root);
					realRootCache.set(root, real);
				} catch {
					continue; // Not there (yet): it allows nothing until it exists.
				}
			}
			out.push(real);
		}
		return out;
	}

	const outside = (requested: string): string =>
		`"${requested}" is outside the folders the viewer may open (${roots.join(", ")}). ` +
		`Ask the user to add its folder to the VIEWER_ROOTS environment variable (separate folders with "${platform === "win32" ? ";" : ":"}").`;

	/** The one answer for a path outside the roots; what actually happened is logged, not said. */
	const refuseOutside = (requested: string, cause: string): FenceVerdict => {
		log(`refused ${JSON.stringify(requested)}: ${cause}`);
		return refuse(outside(requested));
	};

	/** The real path of the deepest ancestor of `path` that resolves: where a path
	 *  that will not resolve REALLY is. Without it, `<root>/link/missing` (a link
	 *  inside a root that leads out) would answer "no such file" while
	 *  `<root>/link/present` answered "outside", and tell the caller which
	 *  outside files exist. */
	async function nearestReal(path: string): Promise<string | undefined> {
		for (let current = api.dirname(path); ; current = api.dirname(current)) {
			try {
				return await resolveReal(current);
			} catch {
				if (api.dirname(current) === current) return undefined;
			}
		}
	}

	/** The grant in a call's `_meta`, or `undefined`. ANY flaw voids all of it, as the engine refuses a whole open rather than grant part of one. */
	function readGrant(meta: unknown): ArtifactoryGrantMeta | undefined {
		if (typeof meta !== "object" || meta === null || !Object.hasOwn(meta, ARTIFACTORY_GRANT_META_KEY)) return undefined;
		const grant: unknown = Reflect.get(meta, ARTIFACTORY_GRANT_META_KEY);
		if (typeof grant !== "object" || grant === null || !Object.hasOwn(grant, "read")) return undefined;
		const read: unknown = Reflect.get(grant, "read");
		if (!Array.isArray(read) || read.length > MAX_LENT_FILES) return undefined;
		const files: string[] = [];
		for (const entry of read) {
			if (typeof entry !== "string" || entry.length > MAX_LENT_PATH || !api.isAbsolute(entry)) return undefined;
			files.push(entry);
		}
		return { read: files };
	}

	async function isPresentFile(real: string): Promise<boolean> {
		try {
			return await isRegularFile(real);
		} catch {
			return false;
		}
	}

	/**
	 * Whether `real` is a file the host lent: the SAME path as a lent entry, and a
	 * regular file. A lent entry is what the engine stamped, a real path, and is NOT
	 * resolved again: a lent file swapped for a link after the click lends what it
	 * was, not wherever the link now leads.
	 */
	async function isLent(real: string, lent: readonly string[]): Promise<boolean> {
		const wanted = comparable(real, platform);
		return lent.some(file => comparable(file, platform) === wanted) && (await isPresentFile(real));
	}

	async function isIndexed(real: string): Promise<boolean> {
		return options.indexed?.isLent(real) === true && (await isPresentFile(real));
	}

	async function check(requested: unknown, meta?: unknown): Promise<FenceVerdict> {
		if (typeof requested !== "string" || requested.trim() === "") return refuse("the path is empty");
		if (requested.includes("\0")) return refuse("the path contains a NUL byte");
		if (!api.isAbsolute(requested)) return refuse(`"${requested}" is not an absolute path; pass the full path to the file`);
		const refused = textRefusal(requested, platform);
		if (refused !== undefined) return refuse(refused);
		const lexical = api.resolve(requested);
		// Deny first, on the text, before any filesystem call and whatever was lent.
		const early = denyReason(lexical);
		if (early !== undefined) return refuse(`refused to open "${requested}": ${early}`);
		const lent = readGrant(meta)?.read ?? [];

		let real: string;
		try {
			real = await resolveReal(lexical);
		} catch (error) {
			const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
			const anchor = await nearestReal(lexical);
			// A lent file the human named is theirs to hear about: "no such file" beats "outside the folders" for one they just clicked.
			const within =
				lent.some(file => comparable(file, platform) === comparable(lexical, platform)) ||
				options.indexed?.isLent(lexical) === true ||
				(anchor !== undefined && [...roots, ...(await realRoots())].some(root => insideRoot(anchor, root, platform)));
			if (!within) return refuseOutside(requested, `it does not resolve (${code ?? "unknown error"})`);
			if (code === "ENOENT" || code === "ENOTDIR") return refuse(`no such file: "${requested}"`);
			if (code === "EACCES" || code === "EPERM") return refuse(`"${requested}" cannot be read: permission denied`);
			return refuse(`"${requested}" cannot be resolved${code ? ` (${code})` : ""}`);
		}

		// Containment BEFORE the real-path deny check: a link that leads out to
		// `~/.ssh` must read as "outside", like every other outside path, not as
		// "a credentials folder", which would say what the outside target is. A
		// lent file is the one other way in, and the deny check below still runs on it.
		const allowed = await realRoots();
		if (!allowed.some(root => insideRoot(real, root, platform)) && !(await isLent(real, lent)) && !(await isIndexed(real))) {
			return refuseOutside(requested, `it resolves to ${JSON.stringify(real)}`);
		}
		const denied = denyReason(real);
		if (denied !== undefined) return refuse(`refused to open "${requested}": ${denied}`);
		return { ok: true, real };
	}

	return { roots, check };
}
