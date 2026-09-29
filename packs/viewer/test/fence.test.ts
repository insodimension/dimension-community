import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredRoots, createFence, denyReason, insideRoot } from "../src/fence";

describe("insideRoot", () => {
	test("is segment-wise: a sibling that shares a prefix is outside", () => {
		expect(insideRoot("/a/b/c.png", "/a/b", "linux")).toBe(true);
		expect(insideRoot("/a/b", "/a/b", "linux")).toBe(true);
		expect(insideRoot("/a/bc/c.png", "/a/b", "linux")).toBe(false);
		expect(insideRoot("/a/c.png", "/a/b", "linux")).toBe(false);
	});

	test("is case-insensitive on Windows and exact on Linux", () => {
		expect(insideRoot("C:\\Users\\Me\\Docs\\a.png", "c:\\users\\me", "win32")).toBe(true);
		expect(insideRoot("/A/b/c.png", "/a", "linux")).toBe(false);
	});

	test("a path on another drive is outside", () => {
		expect(insideRoot("D:\\Docs\\a.png", "C:\\Docs", "win32")).toBe(false);
	});
});

describe("denyReason", () => {
	const denied = [
		"/home/me/.ssh/id_rsa",
		"C:\\Users\\Me\\.SSH\\config",
		"/work/app/.env",
		"/work/app/.env.production",
		"/work/app/prod.ENV",
		"/work/app/.envrc",
		"/work/certs/server.PEM",
		"/home/me/.aws/credentials",
		"/home/me/.inso/agent/agent.db",
		"/home/me/.inso/agent/agent.db-wal",
		"C:\\Users\\Me\\.inso-dev\\profiles\\p1\\agent\\config.yml",
		"/home/me/.omp/agent/models.yml",
		"/home/me/.inso/vault/notes.sqlite",
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json",
		"C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Credentials\\ABC",
		"/work/app/.git/config",
		"/home/me/.npmrc",
	];
	for (const path of denied) {
		test(`refuses ${path}`, () => expect(denyReason(path)).toBeString());
	}

	const allowed = [
		"/home/me/.inso/vault/report.pdf",
		"/home/me/.inso/vault/agent/photo.png", // an `agent` folder inside the vault is not the engine's
		"/home/me/docs/environment.md",
		"/home/me/docs/key-notes.md",
		"/home/me/docs/token-economics.md",
		"/home/me/docs/constructor",
		"C:\\Work\\Docs\\quarterly.docx",
	];
	for (const path of allowed) {
		test(`allows ${path}`, () => expect(denyReason(path)).toBeUndefined());
	}
});

describe("configuredRoots", () => {
	test("reads VIEWER_ROOTS with the platform's delimiter and drops relative entries", () => {
		expect(configuredRoots({ VIEWER_ROOTS: "C:\\Work;relative\\dir;D:\\More" }, "C:\\Users\\Me", "win32")).toEqual(
			expect.arrayContaining(["C:\\Work", "D:\\More"]),
		);
		const posix = configuredRoots({ VIEWER_ROOTS: "/srv/docs:not/absolute:/tmp/x" }, "/home/me", "linux");
		expect(posix).toEqual(expect.arrayContaining(["/srv/docs", "/tmp/x", "/home/me/.inso/vault", "/home/me/.inso-dev/vault"]));
		expect(posix).not.toContain("not/absolute");
	});
});

describe("fence on Windows paths (platform injected, no disk)", () => {
	const fence = createFence({
		platform: "win32",
		home: "C:\\Users\\Me",
		env: { VIEWER_ROOTS: "C:\\Work\\Docs" },
		realpath: async path => path,
	});

	test("compares drive, folder and file case-insensitively", async () => {
		expect(await fence.check("c:\\work\\DOCS\\Report.PNG")).toEqual({ ok: true, real: "c:\\work\\DOCS\\Report.PNG" });
	});

	test("a `..` traversal that leaves the root is refused", async () => {
		const verdict = await fence.check("C:\\Work\\Docs\\..\\Secrets\\plan.txt");
		expect(verdict).toMatchObject({ ok: false });
		expect(verdict.ok ? "" : verdict.reason).toContain("VIEWER_ROOTS");
	});

	test("deny beats allow even inside an allowed root", async () => {
		expect(await fence.check("C:\\Work\\Docs\\.ENV")).toMatchObject({ ok: false });
	});

	test("device paths and alternate data streams are refused", async () => {
		expect(await fence.check("\\\\?\\C:\\Work\\Docs\\a.png")).toMatchObject({ ok: false });
		expect(await fence.check("C:\\Work\\Docs\\a.txt:hidden")).toMatchObject({ ok: false });
	});
});

describe("fence on a real disk", () => {
	let base: string;
	let root: string;
	let outside: string;
	const home = "/nonexistent-home"; // never consulted: only VIEWER_ROOTS matters here

	beforeAll(async () => {
		// `realpath` first: the temp dir may be spelled with 8.3 short names or a link.
		base = await realpath(await mkdtemp(join(tmpdir(), "viewer-fence-")));
		root = join(base, "root");
		outside = join(base, "outside");
		await mkdir(join(root, "sub"), { recursive: true });
		await mkdir(join(root, ".ssh"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, "sub", "note.txt"), "hello");
		await writeFile(join(root, ".env"), "TOKEN=SECRET_VALUE_123");
		await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE_KEY_MATERIAL");
		await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET");
		// A directory junction (Windows, no privilege needed) or symlink (elsewhere).
		await symlink(outside, join(root, "escape"), "junction");
		await symlink(join(root, ".ssh"), join(root, "keys"), "junction");
	});

	afterAll(() => rm(base, { recursive: true, force: true }));

	const fence = () => createFence({ home, env: { VIEWER_ROOTS: root } });

	test("returns the real path of a file inside the root", async () => {
		expect(await fence().check(join(root, "sub", "note.txt"))).toEqual({ ok: true, real: join(root, "sub", "note.txt") });
	});

	test("refuses a file outside every root and names how to allow it", async () => {
		const verdict = await fence().check(join(outside, "secret.txt"));
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toContain("VIEWER_ROOTS");
	});

	test("refuses `..` traversal out of the root", async () => {
		expect(await fence().check(join(root, "sub", "..", "..", "outside", "secret.txt"))).toMatchObject({ ok: false });
	});

	test("refuses an escape through a link inside the root", async () => {
		const verdict = await fence().check(join(root, "escape", "secret.txt"));
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toContain("link");
	});

	test("refuses a link that leads to a secret inside the root, by what it resolves to", async () => {
		expect(await fence().check(join(root, "keys", "id_rsa"))).toMatchObject({ ok: false });
	});

	test("a refusal names the reason and never carries the file's content", async () => {
		for (const path of [join(root, ".env"), join(root, ".ssh", "id_rsa"), join(root, "escape", "secret.txt")]) {
			const verdict = await fence().check(path);
			expect(verdict.ok).toBe(false);
			const reason = verdict.ok ? "" : verdict.reason;
			expect(reason).not.toContain("SECRET_VALUE_123");
			expect(reason).not.toContain("PRIVATE_KEY_MATERIAL");
			expect(reason).not.toContain("OUTSIDE_SECRET");
		}
	});

	test("does not reveal which paths exist outside the fence", async () => {
		const existing = await fence().check(join(outside, "secret.txt"));
		const missing = await fence().check(join(outside, "missing.txt"));
		expect(existing.ok || missing.ok).toBe(false);
		expect(existing.ok ? "" : existing.reason.replace(/secret\.txt/g, "X")).toBe(missing.ok ? "" : missing.reason.replace(/missing\.txt/g, "X"));
	});

	test("a missing file inside the root says so", async () => {
		const verdict = await fence().check(join(root, "sub", "gone.txt"));
		expect(verdict.ok ? "" : verdict.reason).toContain("no such file");
	});

	test("refuses relative paths and NUL bytes", async () => {
		expect(await fence().check("sub/note.txt")).toMatchObject({ ok: false });
		expect(await fence().check(`${join(root, "sub", "note.txt")}\0.png`)).toMatchObject({ ok: false });
	});

	test.skipIf(process.platform !== "win32")("accepts a different spelling of the same path on Windows", async () => {
		expect(await fence().check(join(root, "SUB", "NOTE.TXT"))).toMatchObject({ ok: true });
	});
});
