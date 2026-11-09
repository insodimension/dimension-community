// The host-lent one-file grant (doc 86 §5), as the FENCE reads it. The engine that
// stamps `_meta` is not here: these tests hand the fence the `_meta` a stamped call
// would carry, and hold it to "exactly that file, after the deny rules, and nothing
// a forged or malformed value can widen".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { ARTIFACTORY_GRANT_META_KEY } from "@dimension/sdk/artifactory";
import { createFence, type FenceVerdict } from "../src/fence";

const lend = (...files: unknown[]) => ({ [ARTIFACTORY_GRANT_META_KEY]: { read: files } });
const reasonOf = (verdict: FenceVerdict) => (verdict.ok ? "" : verdict.reason);

// ── Windows paths on a model of NTFS, so the spellings are tested on every OS ──────────────

interface Entry {
	readonly path: string;
	readonly kind: "file" | "dir";
	/** A link: what the path RESOLVES to. */
	readonly linkTo?: string;
}

/** A disk that answers like Win32: names fold case, `.`/`..` collapse, trailing dots and spaces are dropped. */
function ntfs(entries: readonly Entry[]) {
	const byName: Record<string, Entry | undefined> = Object.fromEntries(entries.map(entry => [entry.path.toLowerCase(), entry]));
	const calls: string[] = [];
	const win32Name = (path: string) =>
		nodePath.win32
			.resolve(path)
			.split("\\")
			.map(part => part.replace(/[. ]+$/, ""))
			.join("\\");
	const realpathOf = async (path: string): Promise<string> => {
		calls.push(path);
		const entry = byName[win32Name(path).toLowerCase()];
		if (entry === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return entry.linkTo === undefined ? entry.path : realpathOf(entry.linkTo);
	};
	const isFile = async (path: string) => byName[path.toLowerCase()]?.kind === "file";
	return { realpath: realpathOf, isFile, calls };
}

const OUT = "C:\\Elsewhere\\Out";
const REPORT = `${OUT}\\report.pdf`;
const disk = ntfs([
	{ path: "C:\\Work\\Docs", kind: "dir" },
	{ path: "C:\\Work\\Docs\\inside.txt", kind: "file" },
	{ path: "C:\\Elsewhere", kind: "dir" },
	{ path: OUT, kind: "dir" },
	{ path: REPORT, kind: "file" },
	{ path: `${OUT}\\other.pdf`, kind: "file" },
	{ path: `${OUT}\\benign.txt`, kind: "file" },
	{ path: `${OUT}\\.ENV`, kind: "file" },
	{ path: `${OUT}\\key.pem`, kind: "file" },
	{ path: "C:\\Elsewhere\\Out2", kind: "dir" },
	{ path: "C:\\Elsewhere\\Out2\\report.pdf", kind: "file" },
	// A name that is harmless, leading to a secret: only the RESOLVED path can give it away.
	{ path: `${OUT}\\notes.txt`, kind: "file", linkTo: "C:\\Users\\Me\\.ssh\\id_rsa" },
	{ path: "C:\\Users\\Me\\.ssh\\id_rsa", kind: "file" },
	// A name that is a secret's, leading to something harmless: only the TEXT gives it away.
	{ path: "C:\\Elsewhere\\Env\\.env", kind: "file", linkTo: `${OUT}\\benign.txt` },
	{ path: "C:\\Elsewhere\\Vault\\locker\\entry.json", kind: "file" },
	{ path: "C:\\Users\\Me\\.inso\\agent\\sessions.jsonl", kind: "file" },
	// A lent file the agent has since replaced by a link to another file.
	{ path: "C:\\Elsewhere\\Swap\\report.pdf", kind: "file", linkTo: `${OUT}\\other.pdf` },
]);

const windows = () =>
	createFence({
		platform: "win32",
		home: "C:\\Users\\Me",
		env: { VIEWER_ROOTS: "C:\\Work\\Docs" },
		realpath: disk.realpath,
		isFile: disk.isFile,
	});

describe("a lent file on Windows paths (injected disk)", () => {
	test("without a grant the file is outside the folders; with its exact path it opens", async () => {
		expect(reasonOf(await windows().check(REPORT))).toContain("outside the folders");
		expect(await windows().check(REPORT, lend(REPORT))).toEqual({ ok: true, real: REPORT });
	});

	test("a lent file widens nothing: the roots behave as before, with a grant, a foreign grant or none", async () => {
		for (const meta of [undefined, lend(REPORT), lend("C:\\Nowhere\\x.txt")]) {
			expect(await windows().check("C:\\Work\\Docs\\inside.txt", meta)).toMatchObject({ ok: true });
		}
	});

	test.each([
		["another case, drive letter included", "c:\\elsewhere\\OUT\\REPORT.PDF"],
		["a `..` that comes back", `${OUT}\\sub\\..\\report.pdf`],
		["forward slashes", "C:/Elsewhere/Out/report.pdf"],
		["a trailing dot", `${REPORT}.`],
		["a trailing space", `${REPORT} `],
	])("%s is the lent file, and opens the lent file only", async (_name, spelling) => {
		expect(await windows().check(spelling, lend(REPORT))).toEqual({ ok: true, real: REPORT });
	});

	test("a lent entry in another case still names the file (volumes ignore case)", async () => {
		expect(await windows().check(REPORT, lend("c:\\ELSEWHERE\\out\\Report.PDF"))).toMatchObject({ ok: true });
	});

	test.each([
		["a sibling", `${OUT}\\other.pdf`],
		["a sibling with a trailing dot", `${OUT}\\other.pdf.`],
		["a longer name", `${REPORT}.bak`],
		["the same name in a folder that shares the prefix", "C:\\Elsewhere\\Out2\\report.pdf"],
		["the same name on another drive", "D:\\Elsewhere\\Out\\report.pdf"],
		["the parent folder", OUT],
		["the grandparent folder", "C:\\Elsewhere"],
		["a `..` that leaves the folder", `${OUT}\\sub\\..\\..\\Secrets\\plan.txt`],
	])("%s is not the lent file", async (_name, path) => {
		const verdict = await windows().check(path, lend(REPORT));
		expect(verdict.ok).toBe(false);
		expect(reasonOf(verdict)).toContain("outside the folders");
	});

	test("a path a lent file is merely BELOW is not lent: a grant is a file, never a folder", async () => {
		expect(reasonOf(await windows().check(REPORT, lend(OUT)))).toContain("outside the folders");
		expect(reasonOf(await windows().check(OUT, lend(OUT)))).toContain("outside the folders");
	});

	test("a lent file replaced by a link to another file lends what it was, not where the link now leads", async () => {
		const swapped = "C:\\Elsewhere\\Swap\\report.pdf";
		const verdict = await windows().check(swapped, lend(swapped));
		expect(verdict.ok).toBe(false);
		expect(reasonOf(verdict)).toContain("outside the folders");
	});

	test("device paths, streams and network paths are refused on their text, lent or not, with no disk call", async () => {
		const before = disk.calls.length;
		for (const path of [`\\\\?\\${REPORT}`, `${REPORT}:stream`, "\\\\attacker\\share\\report.pdf", "//attacker/share/report.pdf"]) {
			expect(await windows().check(path, lend(REPORT, path))).toMatchObject({ ok: false });
		}
		expect(disk.calls.length).toBe(before);
	});

	test("an entry that is not an absolute path voids the WHOLE grant", async () => {
		expect(reasonOf(await windows().check(REPORT, lend(REPORT, "report.pdf")))).toContain("outside the folders");
		expect(reasonOf(await windows().check(REPORT, lend("\\\\?\\C:\\Elsewhere\\Out\\report.pdf")))).toContain("outside the folders");
	});

	describe("the deny rules come first and still refuse what a click lent", () => {
		const refused = async (path: string, lent: string, words: string) => {
			const verdict = await windows().check(path, lend(lent));
			expect(verdict.ok).toBe(false);
			expect(reasonOf(verdict)).toContain(words);
			expect(reasonOf(verdict)).not.toContain("outside the folders");
		};

		test("an environment file", () => refused(`${OUT}\\.ENV`, `${OUT}\\.ENV`, "environment file"));
		test("a key file, however the name is spelled (a trailing dot hides it from the text, not from the disk)", () =>
			refused(`${OUT}\\key.pem.`, `${OUT}\\key.pem`, "private key"));
		test("a name the text refuses, though it leads to a harmless file", () =>
			refused("C:\\Elsewhere\\Env\\.env", `${OUT}\\benign.txt`, "environment file"));
		test("a harmless name that leads to a secret is refused by what it resolves to", () =>
			refused(`${OUT}\\notes.txt`, "C:\\Users\\Me\\.ssh\\id_rsa", "credentials folder"));
		test("the Locker", () => refused("C:\\Elsewhere\\Vault\\locker\\entry.json", "C:\\Elsewhere\\Vault\\locker\\entry.json", "locker"));
		test("an engine home's agent state", () =>
			refused("C:\\Users\\Me\\.inso\\agent\\sessions.jsonl", "C:\\Users\\Me\\.inso\\agent\\sessions.jsonl", "agent state"));
		test("the same harmless file, lent and not denied, does open (the refusals above are the deny rules, not a broken grant)", async () => {
			expect(await windows().check(`${OUT}\\benign.txt`, lend(`${OUT}\\benign.txt`))).toMatchObject({ ok: true });
		});
	});

	describe("a grant that is not exactly { read: [absolute paths] } is no grant, and says the same as none", () => {
		const tooMany = Array.from({ length: 9 }, (_, index) => `C:\\Elsewhere\\Out\\f${index}.txt`);
		const garbage: [string, unknown][] = [
			["a string", "C:\\Elsewhere\\Out\\report.pdf"],
			["null", null],
			["a number", 42],
			["an array of paths", [REPORT]],
			["an empty object", {}],
			["the grant itself, without its key", { read: [REPORT] }],
			["the key in another case", { "ai.insodimension/GRANT": { read: [REPORT] } }],
			["an inherited key", Object.create({ [ARTIFACTORY_GRANT_META_KEY]: { read: [REPORT] } })],
			["a grant that is a string", { [ARTIFACTORY_GRANT_META_KEY]: REPORT }],
			["a grant that is an array", { [ARTIFACTORY_GRANT_META_KEY]: [REPORT] }],
			["a grant that is null", { [ARTIFACTORY_GRANT_META_KEY]: null }],
			["no read", { [ARTIFACTORY_GRANT_META_KEY]: {} }],
			["read that is a string", { [ARTIFACTORY_GRANT_META_KEY]: { read: REPORT } }],
			["read that is an object", { [ARTIFACTORY_GRANT_META_KEY]: { read: { 0: REPORT, length: 1 } } }],
			["read that is an inherited array", { [ARTIFACTORY_GRANT_META_KEY]: Object.create({ read: [REPORT] }) }],
			["a non-string entry beside the right one", lend(REPORT, 42)],
			["a null entry beside the right one", lend(REPORT, null)],
			["an empty entry beside the right one", lend(REPORT, "")],
			["a relative entry beside the right one", lend(REPORT, "report.pdf")],
			["more than eight files, the right one among them", lend(REPORT, ...tooMany.slice(0, 8))],
			["an entry longer than any path", lend(REPORT, `C:\\${"a".repeat(4097)}`)],
		];

		test.each(garbage)("%s", async (_name, meta) => {
			const none = await windows().check(REPORT);
			expect(none.ok).toBe(false);
			expect(await windows().check(REPORT, meta)).toEqual(none);
		});

		test("eight files is the most, and the control (the same shape, well-formed) opens", async () => {
			expect(await windows().check(REPORT, lend(REPORT, ...tooMany.slice(0, 7)))).toMatchObject({ ok: true });
		});
	});
});

// ── a real disk ────────────────────────────────────────────────────────────────────────────

async function canLinkFiles(): Promise<boolean> {
	const probe = await mkdtemp(nodePath.join(tmpdir(), "viewer-link-probe-"));
	try {
		await writeFile(nodePath.join(probe, "target"), "x");
		await symlink(nodePath.join(probe, "target"), nodePath.join(probe, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		await rm(probe, { recursive: true, force: true });
	}
}
const linkable = await canLinkFiles();

describe("a lent file on a real disk", () => {
	let base: string;
	let root: string;
	let project: string;
	const home = "/nonexistent-home";
	const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
	const engine = (...parts: string[]) => nodePath.join(base, "home", ".inso", ...parts);

	beforeAll(async () => {
		// `realpath` first: the temp dir may be spelled with 8.3 short names or a link.
		base = await realpath(await mkdtemp(nodePath.join(tmpdir(), "viewer-grant-")));
		root = nodePath.join(base, "root");
		project = nodePath.join(base, "project");
		await mkdir(root);
		await mkdir(nodePath.join(project, "sub"), { recursive: true });
		await mkdir(nodePath.join(project, "locker"), { recursive: true });
		await mkdir(nodePath.join(base, "outside"));
		await mkdir(nodePath.join(base, "home", ".inso", "agent"), { recursive: true });
		await writeFile(nodePath.join(root, "inside.txt"), "inside");
		await writeFile(nodePath.join(project, "granted.txt"), "GRANTED_CONTENT");
		await writeFile(nodePath.join(project, "sibling.txt"), "SIBLING_CONTENT");
		await writeFile(nodePath.join(project, "sub", "deep.txt"), "DEEP_CONTENT");
		await writeFile(nodePath.join(project, ".env"), "TOKEN=SECRET_VALUE_123");
		await writeFile(nodePath.join(project, "id_rsa"), "PRIVATE_KEY_MATERIAL");
		await writeFile(nodePath.join(project, "locker", "entry.json"), "SEALED_ENTRY");
		await writeFile(nodePath.join(base, "home", ".inso", "agent", "sessions.jsonl"), "AGENT_CREDENTIALS");
		await mkdir(nodePath.join(base, "home", ".inso", "agent", "blobs", "nested"), { recursive: true });
		await mkdir(nodePath.join(base, "home", ".inso", "profiles", "p1", "agent", "blobs"), { recursive: true });
		for (const blob of [
			engine("agent", "blobs", `${HASH}.png`),
			engine("profiles", "p1", "agent", "blobs", `${HASH}.jpg`),
			engine("agent", "blobs", HASH),
			engine("agent", "blobs", "nested", `${HASH}.png`),
			engine("agent", "blobs", `${HASH}.db`),
		]) {
			await writeFile(blob, "SNAPSHOT_BYTES");
		}
		await writeFile(nodePath.join(base, "outside", "secret.txt"), "OUTSIDE_SECRET");
		if (linkable) {
			await symlink(nodePath.join(project, "granted.txt"), nodePath.join(project, "via-link.txt"), "file");
			await symlink(nodePath.join(project, "sibling.txt"), nodePath.join(project, "link-to-sibling.txt"), "file");
			await symlink(nodePath.join(base, "outside", "secret.txt"), nodePath.join(project, "escape.txt"), "file");
		}
	});

	afterAll(() => rm(base, { recursive: true, force: true }));

	const fence = () => createFence({ home, env: { VIEWER_ROOTS: root } });
	const at = (...parts: string[]) => nodePath.join(project, ...parts);

	test("the exact file opens, and only with its grant", async () => {
		expect(reasonOf(await fence().check(at("granted.txt")))).toContain("outside the folders");
		expect(await fence().check(at("granted.txt"), lend(at("granted.txt")))).toEqual({ ok: true, real: at("granted.txt") });
	});

	test("a sibling, the parent folder and the folder's other contents are not lent", async () => {
		for (const path of [at("sibling.txt"), at("sub", "deep.txt"), project, base]) {
			const verdict = await fence().check(path, lend(at("granted.txt")));
			expect(verdict.ok).toBe(false);
			expect(reasonOf(verdict)).toContain("outside the folders");
		}
	});

	test("a folder is never lent, so neither it nor anything below it opens (files only)", async () => {
		for (const path of [project, at("sub"), at("granted.txt"), at("sub", "deep.txt")]) {
			expect(await fence().check(path, lend(project, at("sub")))).toMatchObject({ ok: false });
		}
	});

	test.skipIf(!linkable)("a link to the lent file opens the lent file; a link to another file does not", async () => {
		expect(await fence().check(at("via-link.txt"), lend(at("granted.txt")))).toEqual({ ok: true, real: at("granted.txt") });
		const other = await fence().check(at("link-to-sibling.txt"), lend(at("granted.txt")));
		expect(other.ok).toBe(false);
		expect(reasonOf(other)).toContain("outside the folders");
	});

	test.skipIf(!linkable)("a link beside the lent file cannot reach outside it, and never leaks what it leads to", async () => {
		const verdict = await fence().check(at("escape.txt"), lend(at("granted.txt")));
		expect(verdict.ok).toBe(false);
		expect(reasonOf(verdict)).not.toContain("OUTSIDE_SECRET");
	});

	test("secrets, the Locker and an engine home's agent state are refused even when lent, without leaking a byte", async () => {
		const lentSecrets = [at(".env"), at("id_rsa"), at("locker", "entry.json"), nodePath.join(base, "home", ".inso", "agent", "sessions.jsonl")];
		const words = ["environment file", "private key", "locker", "agent state"];
		for (const [index, path] of lentSecrets.entries()) {
			const verdict = await fence().check(path, lend(...lentSecrets));
			expect(verdict.ok).toBe(false);
			expect(reasonOf(verdict)).toContain(words[index] as string);
			expect(reasonOf(verdict)).not.toMatch(/SECRET_VALUE|PRIVATE_KEY_MATERIAL|SEALED_ENTRY|AGENT_CREDENTIALS/);
		}
	});

	test("a presented file's copy in the engine's blob store opens only with its grant, as that exact file", async () => {
		for (const copy of [engine("agent", "blobs", `${HASH}.png`), engine("profiles", "p1", "agent", "blobs", `${HASH}.jpg`)]) {
			expect(reasonOf(await fence().check(copy))).toContain("agent state");
			expect(await fence().check(copy, lend(copy))).toEqual({ ok: true, real: copy });
		}
	});

	test("a root the user configured over the engine home never opens the blob store on its own: the copy still needs its grant", async () => {
		const wide = () => createFence({ home, env: { VIEWER_ROOTS: nodePath.join(base, "home") } });
		for (const copy of [engine("agent", "blobs", `${HASH}.png`), engine("profiles", "p1", "agent", "blobs", `${HASH}.jpg`)]) {
			for (const meta of [undefined, lend(at("granted.txt"))]) {
				const verdict = await wide().check(copy, meta);
				expect(verdict.ok, copy).toBe(false);
				expect(reasonOf(verdict), copy).toContain("agent state");
				expect(reasonOf(verdict), copy).not.toContain("SNAPSHOT_BYTES");
			}
			expect(await wide().check(copy, lend(copy))).toEqual({ ok: true, real: copy });
		}
	});

	test("a copy that does not exist is refused exactly as one that does, so the blob store's contents are no oracle", async () => {
		const wide = () => createFence({ home, env: { VIEWER_ROOTS: nodePath.join(base, "home") } });
		const missing = engine("agent", "blobs", `${"0".repeat(64)}.png`);
		const stored = engine("agent", "blobs", `${HASH}.png`);
		for (const make of [wide, fence]) {
			const answer = async (path: string, meta: unknown) => reasonOf(await make().check(path, meta)).replaceAll(path, "<path>");
			for (const meta of [undefined, lend(at("granted.txt"))]) {
				expect(await answer(missing, meta)).toContain("agent state");
				expect(await answer(missing, meta)).toBe(await answer(stored, meta));
			}
		}
	});

	test("beside a lent copy the engine home stays closed even when lent: a blob with no extension, a nested one and a database", async () => {
		const closed = [engine("agent", "blobs", HASH), engine("agent", "blobs", "nested", `${HASH}.png`), engine("agent", "blobs", `${HASH}.db`)];
		for (const path of closed) {
			const verdict = await fence().check(path, lend(...closed));
			expect(verdict.ok, path).toBe(false);
			expect(reasonOf(verdict), path).toContain("agent state");
			expect(reasonOf(verdict), path).not.toContain("SNAPSHOT_BYTES");
		}
	});

	test("a lent file deleted before it was read says so, instead of naming the roots", async () => {
		const gone = at("gone.txt");
		expect(reasonOf(await fence().check(gone, lend(gone)))).toContain("no such file");
		expect(reasonOf(await fence().check(at("never-lent.txt"), lend(gone)))).toContain("outside the folders");
	});

	test.skipIf(process.platform !== "win32")("a different spelling of the lent file opens it on Windows; a trailing dot or space opens nothing", async () => {
		const granted = at("granted.txt");
		const lowerDrive = `${granted[0]?.toLowerCase()}${granted.slice(1)}`.replace("granted.txt", "GRANTED.TXT");
		expect(await fence().check(lowerDrive, lend(granted))).toEqual({ ok: true, real: granted });
		expect(await fence().check(at("sub", "..", "granted.txt"), lend(granted))).toEqual({ ok: true, real: granted });
		for (const spelled of [`${granted}.`, `${granted} `, `${at("sibling.txt")}.`]) {
			const verdict = await fence().check(spelled, lend(granted));
			if (verdict.ok) expect(verdict.real).toBe(granted); // the OS may fold the name to the lent file; never to another
		}
		expect(await fence().check(`\\\\?\\${granted}`, lend(granted))).toMatchObject({ ok: false });
	});
});
