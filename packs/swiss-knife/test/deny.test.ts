import { describe, expect, test } from "bun:test";
import { textRefusal } from "../src/present";
import * as fence from "../viewer/src/fence";

const { blobCopyExtension, denyReason } = fence;

// `present` and the viewer's fence share ONE deny table, `viewer/src/fence.ts`: present imports
// it and bundles it into dist/index.mjs. This file holds that table to what it promises: a corpus
// of refused and allowed paths, and a path built from every entry of every table, so an entry
// that can never match (a capital letter in a table that is matched lower-case) is a red test.
const SECRET_FOLDERS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".git", ".password-store", "keyrings", "locker"];

const SECRET_FILE_NAMES = [
	".netrc",
	"_netrc",
	".npmrc",
	".pypirc",
	".pgpass",
	".git-credentials",
	".s3cfg",
	"credentials",
	"credentials.json",
	"credentials.db",
	"secrets.json",
	"secrets.yml",
	"secrets.yaml",
	"token",
	"token.json",
	"tokens.json",
	"auth.json",
	"service-account.json",
	"Login Data",
	"Cookies",
	"cookies.sqlite",
	"logins.json",
	"key3.db",
	"key4.db",
	"activation.json",
	"_locker.json",
];

/** Every path here must be refused, grouped by the rule that refuses it. */
const DENIED: Record<string, string[]> = {
	"credentials folders": SECRET_FOLDERS.flatMap(folder => [
		`/home/me/${folder}/notes.txt`, // a harmless name: only the folder gives it away
		`C:\\Users\\Me\\${folder.toUpperCase()}\\notes.txt`,
		`/home/me/${folder}`,
	]),
	"credential stores (consecutive folders)": [
		"/home/me/.config/gcloud/notes.txt",
		"C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Credentials\\ABC",
		"C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5\\x",
		"C:\\Users\\Me\\AppData\\Local\\MICROSOFT\\VAULT\\x",
		"/Users/me/Library/Keychains/login.keychain-db",
	],
	"secret file names": SECRET_FILE_NAMES.flatMap(name => [`/home/me/docs/${name}`, `C:\\Users\\Me\\${name.toUpperCase()}`]),
	"private keys and certificates": [
		...["pem", "key", "p12", "pfx", "ppk", "jks", "keystore", "kdbx"].flatMap(ext => [`/work/certs/server.${ext}`, `/work/certs/SERVER.${ext.toUpperCase()}`]),
		...["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa.pub", "id_ed25519.bak"].map(name => `/home/me/keys/${name}`),
	],
	"environment files": [
		"/work/app/.env",
		"/work/app/.env.production",
		"/work/app/.env.local",
		"/work/app/prod.ENV",
		"/work/app/.envrc",
		"C:\\Work\\Docs\\.ENV",
	],
	"other secret files": [
		"/work/gcp/client_secret_123.json",
		"/work/gcp/client_secret.json",
		"/work/infra/terraform.tfstate",
		"/work/infra/terraform.tfstate.backup",
		"/work/infra/prod.kubeconfig",
		"/backups/export/vps-root.SECRET.JSON",
		"C:\\Users\\Me\\.inso\\vault\\locker\\vps-root.secret.json",
	],
	"the engine's agent state": [
		"/home/me/.inso/agent",
		"/home/me/.inso/agent/agent.db",
		"/home/me/.inso/agent/agent.db-wal",
		"/home/me/.inso-dev/agent/config.yml",
		"/home/me/.inso-foo/agent/config.yml",
		"/home/me/.omp/agent/models.yml",
		"/home/me/.inso/profiles/p1/agent/config.yml",
		"C:\\Users\\Me\\.inso-dev\\profiles\\p1\\agent\\config.yml",
		"C:\\Users\\Me\\.OMP\\AGENT\\models.yml",
	],
	"databases inside an engine home": [
		...["db", "sqlite", "sqlite3", "db-wal", "db-shm", "db-journal"].map(ext => `/home/me/.inso/vault/notes.${ext}`),
		"/home/me/.omp/elsewhere/data.db",
		"C:\\Users\\Me\\.inso-dev\\vault\\notes.sqlite",
	],
	"the desktop install identity and the Locker": [
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json",
		"/home/me/.inso/vault/locker",
		"/home/me/.inso/vault/locker/_locker.json",
		"/home/me/.inso/vault/locker/audit.log",
		"D:\\Brain\\LOCKER\\anything.txt",
		"/backups/vault-2026/_locker.json",
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json.bak",
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json.corrupt-1787117067954",
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json.4242.1a2b3c4d.tmp",
		"/home/me/.inso/auth.json.shrink-2026-11-09t00-00-00-000z.bak",
		"/home/me/.inso/vault/notes.db.corrupt-k3x9",
	],
	"staged copies of a secret file's backup, quarantine copy or key": [
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json.bak.4242.1a2b3c4d.tmp",
		"/home/me/.inso/browser/credentials.json.corrupt-k3x9.4242.1a2b3c4d.tmp",
		"/home/me/.inso/auth.json.shrink-x.bak.12.ab12cd34.tmp",
		"/home/me/.inso/browser/credentials.key.4242.a1b2c3d4e5f6.tmp",
	],
};

/** Every path here must be allowed: ordinary files, and near-misses of each rule above. */
const ALLOWED = [
	"/home/me/.inso/vault/report.pdf",
	"/home/me/.inso/vault/agent/photo.png", // an `agent` folder inside the vault is not the engine's
	"/home/me/docs/environment.md",
	"/home/me/docs/key-notes.md",
	"/home/me/docs/token-economics.md",
	"C:\\Work\\Docs\\quarterly.docx",
	"/home/me/.inso/vault/lockers-overview.md", // `locker` must be a whole folder name
	"/home/me/.inso/vault/projects/inso/audit.log", // an audit log that is not the Locker's
	"/home/me/docs/locker-room.pdf",
	"/home/me/docs/secret-recipe.json",
	"/home/me/docs/notes.txt",
	"/home/me/docs/data.db", // a database outside an engine home is an ordinary file
	"/home/me/.insomnia/data.sqlite", // `.insomnia` is not an engine home
	"/home/me/.insomnia/agent/photo.png",
	"/home/me/.ssh-notes/photo.png", // `.ssh` must be a whole folder name
	"/home/me/.config/notes.txt",
	"/home/me/microsoft/notes.txt", // the store is `microsoft/credentials`, consecutive
	"/home/me/docs/credentials-policy.pdf",
	"/home/me/docs/tokens.md",
	"/home/me/docs/idea_rsa_notes.md",
	"/home/me/docs/envelope.png",
	"/home/me/agent/photo.png",
	"C:\\Work\\reports\\a.png",
	"/home/me/docs/activation.json.md",
	"/home/me/docs/notes.txt.bak",
	"/home/me/docs/notes.txt.bak.4242.1a2b3c4d.tmp",
];

describe("denyReason refuses credentials, keys and engine state", () => {
	for (const [rule, paths] of Object.entries(DENIED)) {
		test(rule, () => {
			for (const path of paths) expect(denyReason(path), path).toBeString();
		});
	}

	test("a refusal names a category, never a path or content", () => {
		for (const path of Object.values(DENIED).flat()) {
			const reason = denyReason(path) ?? "";
			expect(reason, path).toStartWith("it ");
			expect(reason, path).not.toContain("/home/me");
			expect(reason, path).not.toContain("C:\\");
		}
	});
});

describe("denyReason leaves ordinary files alone", () => {
	for (const path of ALLOWED) test(`allows ${path}`, () => expect(denyReason(path)).toBeUndefined());
});

const BLOB = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("denyReason and the copy a card opens, which lives in the engine's blob store", () => {
	const OPENABLE = [
		`/home/me/.inso/agent/blobs/${BLOB}.png`,
		`/home/me/.inso/profiles/p1/agent/blobs/${BLOB}.jpg`,
		`/home/me/.inso-dev/agent/blobs/${BLOB}.pdf`,
		`/home/me/.omp/agent/blobs/${BLOB}.md`,
		`C:\\Users\\Me\\.inso\\agent\\blobs\\${BLOB}.png`,
		`C:\\Users\\Me\\.INSO-DEV\\PROFILES\\p1\\AGENT\\BLOBS\\${BLOB.toUpperCase()}.PNG`,
		`/home/me/.inso/agent/blobs/${BLOB}.tar.gz`,
		`/home/me/.inso/agent/blobs/${BLOB}.${"a".repeat(32)}`,
	];
	for (const path of OPENABLE) test(`opens ${path} once it is lent`, () => expect(denyReason(path, { allowBlobCopy: true })).toBeUndefined());
	for (const path of OPENABLE) test(`refuses ${path} unless it is lent`, () => expect(denyReason(path), path).toMatch(/agent state/));

	const REFUSED: { name: string; path: string; category: RegExp }[] = [
		{ name: "the same blob with no extension", path: `/home/me/.inso/agent/blobs/${BLOB}`, category: /agent state/ },
		{ name: "a copy nested below the blobs folder", path: `/home/me/.inso/agent/blobs/nested/${BLOB}.png`, category: /agent state/ },
		{ name: "a copy nested below a profile's blobs folder", path: `/home/me/.inso/profiles/p1/agent/blobs/nested/${BLOB}.png`, category: /agent state/ },
		{ name: "the blobs folder itself", path: "/home/me/.inso/agent/blobs", category: /agent state/ },
		{ name: "another file of the agent", path: "/home/me/.inso/agent/agent.db", category: /agent state/ },
		{ name: "a hash-shaped name outside the blobs folder", path: `/home/me/.inso/agent/sessions/${BLOB}.png`, category: /agent state/ },
		{ name: "a name one digit short of a hash", path: `/home/me/.inso/agent/blobs/${BLOB.slice(1)}.png`, category: /agent state/ },
		{ name: "a name one digit over a hash", path: `/home/me/.inso/agent/blobs/${BLOB}0.png`, category: /agent state/ },
		{ name: "a name that is not hex", path: `/home/me/.inso/agent/blobs/${BLOB.slice(1)}g.png`, category: /agent state/ },
		{ name: "a database under a blob's name", path: `/home/me/.inso/agent/blobs/${BLOB}.db`, category: /agent state/ },
		{ name: "a sqlite database under a blob's name", path: `/home/me/.inso/agent/blobs/${BLOB}.sqlite`, category: /agent state/ },
		{ name: "a database journal under a blob's name", path: `/home/me/.inso/agent/blobs/${BLOB}.db-wal`, category: /agent state/ },
		{ name: "a durable backup of a blob", path: `/home/me/.inso/agent/blobs/${BLOB}.png.bak`, category: /agent state/ },
		{ name: "a quarantined copy of a blob", path: `/home/me/.inso/agent/blobs/${BLOB}.png.corrupt-k3x9`, category: /agent state/ },
		{ name: "a staged write of a blob", path: `/home/me/.inso/agent/blobs/${BLOB}.png.4242.1a2b3c4d.tmp`, category: /agent state/ },
		{ name: "an extension over 32 characters", path: `/home/me/.inso/agent/blobs/${BLOB}.${"a".repeat(33)}`, category: /agent state/ },
		{ name: "an extension that starts with a dot", path: `/home/me/.inso/agent/blobs/${BLOB}..png`, category: /agent state/ },
		{ name: "a private key under a blob's name", path: `/home/me/.inso/agent/blobs/${BLOB}.pem`, category: /private key/ },
		{ name: "an environment file under a blob's name", path: `/home/me/.inso/agent/blobs/${BLOB}.env`, category: /environment file/ },
		{ name: "a blob inside a credentials folder", path: `/home/me/.ssh/.inso/agent/blobs/${BLOB}.png`, category: /credentials folder/ },
	];
	for (const { name, path, category } of REFUSED) test(`still refuses ${name}, even lent`, () => expect(denyReason(path, { allowBlobCopy: true }), path).toMatch(category));
});

describe("blobCopyExtension: the extension a presented file's copy would carry, when the fence would lend it", () => {
	test.each<readonly [string, string]>([
		["SHOT.PNG", "png"],
		["report.pdf", "pdf"],
		["archive.tar.gz", "gz"],
		["notes.md", "md"],
		[`longest.${"a".repeat(32)}`, "a".repeat(32)],
	])("%s is copied as .%s", (fileName, extension) => {
		expect(blobCopyExtension(fileName)).toBe(extension);
	});

	test.each<readonly [string, string]>([
		["no extension", "Makefile"],
		["a trailing dot", "notes."],
		["a space in the extension", "odd.with space"],
		["an extension over 32 characters", `too-long.${"a".repeat(33)}`],
		["a database", "data.db"],
		["a sqlite database", "data.sqlite"],
		["a sqlite3 database", "data.sqlite3"],
		["a database journal", "data.db-wal"],
		["a private key", "key.pem"],
		["an environment file", "prod.env"],
		["a durable backup extension", "notes.bak"],
	])("%s gets no copy: %s", (_name, fileName) => {
		expect(blobCopyExtension(fileName)).toBeUndefined();
	});

	test("an extension it returns is one the fence lends, once the host lent it", () => {
		for (const fileName of ["a.png", "a.tar.gz", "a.md", `a.${"b".repeat(32)}`]) {
			const extension = blobCopyExtension(fileName);
			expect(denyReason(`/home/me/.inso/agent/blobs/${BLOB}.${extension}`, { allowBlobCopy: true }), fileName).toBeUndefined();
		}
	});
});

describe("denyReason on long names: durable-copy suffixes are stripped in linear time and no name past 255 characters is opened", () => {
	const TIME_BUDGET_MS = 50;

	function timed(path: string): { reason: string | undefined; elapsedMs: number } {
		const started = performance.now();
		const reason = denyReason(path);
		return { reason, elapsedMs: performance.now() - started };
	}

	test("a 100 000-character chain of staged-copy suffixes is refused within the budget", () => {
		const { reason, elapsedMs } = timed(`/home/me/docs/${".1.1.tmp".repeat(12_500)}x`);
		expect(reason).toMatch(/longer than 255 characters/);
		expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
	});

	test("a 256-character name is refused, a 255-character one is not", () => {
		expect(denyReason(`/home/me/docs/${"a".repeat(256)}`)).toMatch(/longer than 255 characters/);
		expect(denyReason(`/home/me/docs/${"a".repeat(255)}`)).toBeUndefined();
	});

	test("a 248-character chain of suffixes over a plain name is opened, within the budget", () => {
		const { reason, elapsedMs } = timed(`/home/me/docs/notes${".1.ab.tmp".repeat(26)}${".bak".repeat(2)}x`);
		expect(reason).toBeUndefined();
		expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
	});

	test("a secret under 62 stacked backups is still refused as the secret", () => {
		expect(denyReason(`/home/me/docs/.env${".bak".repeat(62)}`)).toMatch(/environment file/);
	});
});

describe("every entry of the deny tables refuses the thing it names", () => {
	// The category in the refusal tells which rule fired, so another rule cannot make a dead entry look alive.
	const tables = [
		{
			table: "SECRET_DIRECTORIES",
			paths: Object.keys(fence.SECRET_DIRECTORIES).map(folder => `/home/me/${folder}/notes.txt`),
			category: /credentials folder/,
		},
		{
			table: "SECRET_FILES",
			paths: Object.keys(fence.SECRET_FILES).map(file => `/home/me/docs/${file}`),
			category: /credentials or token file/,
		},
		{
			table: "SECRET_PATHS",
			paths: fence.SECRET_PATHS.map(sequence => `/home/me/${sequence.join("/")}/notes.txt`),
			category: /credentials store/,
		},
	];
	for (const { table, paths, category } of tables) {
		test(`${table}: each entry is refused as its own category`, () => {
			expect(paths.length, `${table} is populated`).toBeGreaterThan(2);
			for (const path of paths) expect(denyReason(path), path).toMatch(category);
		});
	}
});

/** Spellings the operating system would act on, each refused from the text alone, by the rule that refuses it. */
const WINDOWS_REFUSED: { path: string; reason: string }[] = [
	{ path: "\\\\?\\C:\\a.png", reason: "device paths" },
	{ path: "//?/C:/a.png", reason: "device paths" },
	{ path: "\\\\.\\pipe\\x", reason: "device paths" },
	{ path: "C:\\a.txt:hidden", reason: "alternate data streams" },
	{ path: "C:\\dir\\a.png:Zone.Identifier", reason: "alternate data streams" },
	{ path: "\\\\attacker\\share\\a.pdf", reason: "network paths" },
	{ path: "//attacker/share/a.pdf", reason: "network paths" },
	{ path: "\\\\attacker@SSL@443\\DavWWWRoot\\a.pdf", reason: "network paths" },
];
/** Local paths in every spelling a Windows user types: none is refused from the text. */
const WINDOWS_ALLOWED = ["C:\\Work\\a.png", "reports\\a.png", "C:/Work/a.png", "/work/a.png", ".\\a.png"];

describe("textRefusal", () => {
	for (const { path, reason } of WINDOWS_REFUSED) {
		test(`win32 refuses ${path} as ${reason}`, () => {
			const said = textRefusal(path, "win32");
			expect(said, path).toBeString();
			expect(said, path).toContain(reason);
		});
	}

	for (const path of WINDOWS_ALLOWED) {
		test(`win32 allows ${path}`, () => expect(textRefusal(path, "win32")).toBeUndefined());
	}

	test("the Windows spellings are ordinary names elsewhere", () => {
		expect(textRefusal("//host/x", "linux")).toBeUndefined();
		expect(textRefusal("/tmp/a:b.png", "linux")).toBeUndefined();
		expect(textRefusal("/tmp/a:b.png", "darwin")).toBeUndefined();
	});

	for (const platform of ["win32", "linux"] as const) {
		test(`${platform} refuses an empty, blank or NUL-bearing path`, () => {
			expect(textRefusal("", platform)).toContain("empty");
			expect(textRefusal("  \t", platform)).toContain("empty");
			expect(textRefusal("/tmp/a.png\0.txt", platform)).toContain("NUL");
		});
	}
});

describe("present and the fence screen the same Windows spellings", () => {
	// One function: present passes the word its own sentence needs ("presentable"), the fence defaults to its own.
	test("the fence says 'viewable' where present says 'presentable', and the sentence is otherwise the same", () => {
		for (const { path } of WINDOWS_REFUSED) {
			const viewable = fence.textRefusal(path, "win32");
			expect(viewable, path).toContain("not viewable");
			expect(textRefusal(path, "win32"), path).toBe(viewable?.replace("viewable", "presentable"));
		}
	});
});
