import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDriver, type SqlDriver, type SqlValue } from "../src/library/driver";
import { createLibrary, type LibraryOptions } from "../src/library/library";
import { pathKey } from "../src/library/paths";
import { SCHEMA_VERSION } from "../src/library/schema";
import { MAX_TAGS } from "../src/library/tags";
import type { Library, LibraryQuery, ShareRow } from "../src/library/types";
import { TINY_PNG, makeTempDir } from "./fixtures";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let clock: number;
let libraries: Library[];
let revoked: ShareRow[];
let trashed: string[];

async function openLibrary(overrides: Partial<LibraryOptions> = {}): Promise<Library> {
	const library = await createLibrary({
		home: join(root, "home"),
		now: () => clock,
		revokeRemote: async share => {
			revoked.push(share);
		},
		trash: async path => {
			trashed.push(path);
		},
		...overrides,
	});
	libraries.push(library);
	return library;
}

async function put(name: string, content: string | Buffer = name, ageMs = 60_000): Promise<string> {
	const path = join(root, "files", name);
	await mkdir(join(root, "files"), { recursive: true });
	await writeFile(path, content);
	const at = new Date(clock - ageMs);
	await utimes(path, at, at);
	return path;
}

function shareFor(artifactId: string, id = `share-${artifactId}`): ShareRow {
	return {
		id,
		artifactId,
		host: "p2p",
		remoteId: `remote-${id}`,
		baseUrl: "https://relay.example/p/tunnel",
		key: "k".repeat(43),
		ownerToken: "owner",
		audience: { kind: "link" },
		version: 1,
		versionAt: clock,
		allowComments: true,
		createdAt: clock,
	};
}

function allIds(library: Library, query: LibraryQuery = {}): string[] {
	return library.query({ ...query, limit: 200 }).items.map(item => item.id);
}

function pagedIds(library: Library, query: LibraryQuery, limit: number): string[] {
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 100; pages++) {
		const page = library.query({ ...query, limit, ...(cursor === undefined ? {} : { cursor }) });
		ids.push(...page.items.map(item => item.id));
		if (page.next === undefined) return ids;
		cursor = page.next;
	}
	throw new Error("paging did not end");
}

beforeEach(async () => {
	root = await makeTempDir();
	clock = Date.now();
	libraries = [];
	revoked = [];
	trashed = [];
});

afterEach(async () => {
	for (const library of libraries) library.close();
	await rm(root, { recursive: true, force: true });
});

describe("stamping", () => {
	test("one file is one row: a re-stamp refreshes facts and recency and keeps the first source", async () => {
		const library = await openLibrary();
		const file = await put("report.md", "# one");
		const first = await library.stamp({ path: file, source: "present", workspace: join(root, "ws") });
		expect(first).toMatchObject({ name: "report.md", kind: "markdown", size: 5, state: "live", source: "present", hasThumb: false, shares: [] });

		clock += 5_000;
		await writeFile(file, "# version two");
		const second = await library.stamp({ path: file, source: "stamp", title: "  Quarterly report  ", tags: ["Finance", "finance", " q3 "] });
		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({ size: 13, title: "Quarterly report", tags: ["Finance", "q3"], source: "present", workspace: join(root, "ws") });
		expect(second.presentedAt).toBe(clock);
		expect(library.query({}).total).toBe(1);
	});

	test("a file that went missing shows as missing and a re-present revives it", async () => {
		const library = await openLibrary();
		const file = await put("clip.mp4", MP4);
		const { id } = await library.stamp({ path: file, source: "present" });
		await rm(file);
		expect(await library.check([id])).toEqual([expect.objectContaining({ id, state: "missing" })]);
		expect(library.query({}).items[0]?.state).toBe("missing");
		expect(library.isLent(file)).toBe(true);

		await put("clip.mp4", MP4);
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("live");
	});

	test("a discarded file stays out when re-presented unchanged, and returns when it was made again or a human adds it", async () => {
		const library = await openLibrary();
		const file = await put("deck.pptx", "deck");
		const { id } = await library.stamp({ path: file, source: "present" });
		clock += 10_000;
		await library.discard(id, { trash: false });

		clock += 10_000;
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("discarded");
		expect(library.isLent(file)).toBe(false);
		expect(library.query({}).total).toBe(0);

		clock += 10_000;
		await utimes(file, new Date(clock), new Date(clock));
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("live");

		await library.discard(id, { trash: false });
		clock += 10_000;
		expect((await library.stamp({ path: file, source: "human" })).state).toBe("live");
	});

	test("secrets and non-files are refused and never indexed", async () => {
		const library = await openLibrary();
		const env = await put(".env", "TOKEN=1");
		await mkdir(join(root, ".ssh"), { recursive: true });
		await writeFile(join(root, ".ssh", "notes.txt"), "x");
		await put("id_rsa", "key");
		const refused: readonly [string, RegExp][] = [
			[env, /environment file/],
			[join(root, ".ssh", "notes.txt"), /credentials folder/],
			[join(root, "files", "id_rsa"), /private key/],
			[join(root, "files"), /not a regular file/],
			[join(root, "files", "absent.txt"), /no such file/],
			["relative.txt", /not an absolute path/],
		];
		for (const [path, reason] of refused) {
			await expect(library.stamp({ path, source: "stamp" })).rejects.toThrow(reason);
		}
		expect(library.query({}).total).toBe(0);
	});

	test("a link into a secret is refused for what it resolves to", async () => {
		const library = await openLibrary();
		const secret = await put(".env", "TOKEN=1");
		const link = join(root, "files", "harmless.txt");
		const linked = await symlink(secret, link).then(
			() => true,
			() => false,
		);
		if (!linked) return;
		await expect(library.stamp({ path: link, source: "stamp" })).rejects.toThrow(/protected location|environment file/);
		expect(library.query({}).total).toBe(0);
	});

	test("path keys fold case on Windows and macOS and slashes on Windows only", () => {
		expect(pathKey("C:\\Users\\Me\\Clip.MP4", "win32")).toBe("c:/users/me/clip.mp4");
		expect(pathKey("/Users/Me/Clip.MP4", "darwin")).toBe("/users/me/clip.mp4");
		expect(pathKey("/home/me/Clip.MP4", "linux")).toBe("/home/me/Clip.MP4");
		expect(pathKey("/home/me/a\\b", "linux")).toBe("/home/me/a\\b");
	});
});

describe("search", () => {
	async function seed(library: Library): Promise<Record<string, string>> {
		const ids: Record<string, string> = {};
		const files: readonly [string, string | Buffer, string][] = [
			["16-locomotion-slice.mp4", MP4, "alpha"],
			["16-locomotion-intro.mp4", MP4, "alpha"],
			["Locomotion Spec.md", "# spec", "beta"],
			["quarterly-report.pdf", "%PDF-1.7", "beta"],
			["notes.txt", "notes", "alpha"],
			["ab.txt", "ab", "alpha"],
		];
		for (const [name, content, workspace] of files) {
			clock += 1_000;
			ids[name] = (await library.stamp({ path: await put(name, content), source: "present", workspace: join(root, workspace) })).id;
		}
		return ids;
	}

	test("a substring of 3 or more characters finds a name in the middle, case-insensitively", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		expect(new Set(allIds(library, { q: "locom" }))).toEqual(new Set([ids["16-locomotion-slice.mp4"], ids["16-locomotion-intro.mp4"], ids["Locomotion Spec.md"]]));
		expect(allIds(library, { q: "LOCOMOTION-SLICE" })).toEqual([ids["16-locomotion-slice.mp4"]]);
		expect(allIds(library, { q: "locomotion slice" })).toEqual([ids["16-locomotion-slice.mp4"]]);
		expect(allIds(library, { q: "nothing-like-this" })).toEqual([]);
	});

	test("a query shorter than 3 characters is a name prefix, and a quote in the query is only text", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		expect(allIds(library, { q: "ab" })).toEqual([ids["ab.txt"]]);
		expect(allIds(library, { q: "no" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "lo" })).toEqual([ids["Locomotion Spec.md"]]);
		expect(allIds(library, { q: 'spec" OR "notes' })).toEqual([]);
	});

	test("title, note, tags and the folder name are searchable once set", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		library.update(ids["notes.txt"] as string, { title: "Standup minutes", tags: ["retro"] });
		expect(allIds(library, { q: "standup" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "retro" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "files" }).length).toBe(6);
		library.update(ids["notes.txt"] as string, { title: null });
		expect(allIds(library, { q: "standup" })).toEqual([]);
	});

	test("kind, workspace, starred and shared narrow the list and the facets count what is shown", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		library.update(ids["notes.txt"] as string, { starred: true });
		library.shares.insert(shareFor(ids["quarterly-report.pdf"] as string));

		expect(allIds(library, { kinds: ["video"] }).length).toBe(2);
		expect(allIds(library, { workspace: join(root, "beta") }).length).toBe(2);
		expect(allIds(library, { starred: true })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { shared: true })).toEqual([ids["quarterly-report.pdf"]]);
		expect(allIds(library, { q: "locom", kinds: ["video"], workspace: join(root, "alpha") }).length).toBe(2);

		expect(library.facets({})).toMatchObject({ kinds: { video: 2, markdown: 1, pdf: 1, text: 2 }, starred: 1, shared: 1, discarded: 0 });
		expect(library.facets({ workspace: join(root, "beta") })).toMatchObject({ kinds: { markdown: 1, pdf: 1 }, starred: 0, shared: 1 });
		expect(library.facets({}).workspaces).toEqual([
			{ path: join(root, "alpha"), count: 4 },
			{ path: join(root, "beta"), count: 2 },
		]);
	});

	test("totals and facets are never stale: a write here or from another process shows on the next ask", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		const before = library.query({}).total;
		expect(library.facets({}).starred).toBe(0);

		library.update(ids["notes.txt"] as string, { starred: true });
		expect(library.facets({}).starred).toBe(1);
		await library.discard(ids["notes.txt"] as string, { trash: false });
		expect(library.query({}).total).toBe(before - 1);
		expect(library.facets({}).discarded).toBe(1);

		const other = await openLibrary();
		await other.stamp({ path: await put("late.txt"), source: "present" });
		expect(library.query({}).total).toBe(before);
		expect(library.facets({}).kinds.text).toBe(2);

		clock += 2 * 60_000;
		library.shares.insert(shareFor(ids["quarterly-report.pdf"] as string));
		expect(library.query({ shared: true }).total).toBe(1);
		expect(library.facets({}).shared).toBe(1);
	});

	test("a revoked or expired share does not make an artifact shared", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		const pdf = ids["quarterly-report.pdf"] as string;
		library.shares.insert(shareFor(pdf, "revoked"));
		library.shares.update("revoked", { revokedAt: clock });
		library.shares.insert({ ...shareFor(pdf, "expired"), expiresAt: clock - 1 });
		expect(allIds(library, { shared: true })).toEqual([]);
		expect(library.facets({}).shared).toBe(0);
	});

	test("keyset pages cover every row exactly once, in the same order as one big page, for every sort and with ties", async () => {
		const library = await openLibrary();
		const tied = clock;
		for (let index = 0; index < 23; index++) {
			clock = tied;
			const id = (await library.stamp({ path: await put(`item-${String(index).padStart(2, "0")}.txt`, "x".repeat(index % 4)), source: "present" })).id;
			if (index % 3 === 0) {
				clock = tied + index * 1_000;
				library.markOpened(id);
			}
		}
		clock = tied + 1_000_000;
		for (const sort of ["recent", "name", "size", "opened"] as const) {
			const whole = allIds(library, { sort });
			expect(whole.length).toBe(23);
			expect(new Set(whole).size).toBe(23);
			for (const limit of [1, 4, 7, 23]) expect(pagedIds(library, { sort }, limit)).toEqual(whole);
		}
		const searched = { q: "item-", sort: "relevance" } as const;
		const whole = allIds(library, searched);
		expect(whole.length).toBe(23);
		for (const limit of [3, 10]) expect(pagedIds(library, searched, limit)).toEqual(whole);
		expect(library.query({ sort: "opened", limit: 5 }).total).toBe(23);
	});

	test("a cursor from another query is refused", async () => {
		const library = await openLibrary();
		await library.stamp({ path: await put("a.txt"), source: "present" });
		await library.stamp({ path: await put("b.txt"), source: "present" });
		const cursor = library.query({ sort: "name", limit: 1 }).next;
		expect(cursor).toBeDefined();
		expect(() => library.query({ sort: "size", limit: 1, cursor: cursor as string })).toThrow(/cursor/);
		expect(() => library.query({ cursor: "not-a-cursor" })).toThrow(/cursor/);
	});
});

describe("tags", () => {
	interface TagSpec {
		readonly name: string;
		readonly tags: readonly string[];
		readonly workspace?: string;
	}

	const CATALOGUE: readonly TagSpec[] = [
		{ name: "a", tags: ["film", "launch", "Draft"] },
		{ name: "b", tags: ["film", "launch"] },
		{ name: "c", tags: ["films", "launch"] },
		{ name: "d", tags: ["Film"] },
		{ name: "e", tags: [] },
		{ name: "f", tags: ["short film", "Launch"] },
		{ name: "g", tags: ["Éclair"] },
	];

	const SHELF: readonly TagSpec[] = [
		{ name: "a", tags: ["Zine", "launch"], workspace: "alpha" },
		{ name: "b", tags: ["zine", "launch", "apple"], workspace: "alpha" },
		{ name: "c", tags: ["ZINE", "launch", "retro"], workspace: "beta" },
		{ name: "d", tags: ["retro", "zine"], workspace: "beta" },
		{ name: "e", tags: [], workspace: "alpha" },
		{ name: "g", tags: ["zine"], workspace: "beta" },
	];

	const ROTATION: readonly (readonly string[])[] = [["film", "x"], ["Film"], ["films"]];

	async function seedTags(library: Library, specs: readonly TagSpec[]): Promise<Record<string, string>> {
		const ids: Record<string, string> = {};
		for (const { name, tags, workspace } of specs) {
			clock += 1_000;
			const item = await library.stamp({
				path: await put(`${name}.txt`),
				source: "present",
				tags,
				...(workspace === undefined ? {} : { workspace: join(root, workspace) }),
			});
			ids[name] = item.id;
		}
		return ids;
	}

	function namesOf(library: Library, ids: Record<string, string>, query: LibraryQuery): string[] {
		const nameOf = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
		return allIds(library, query)
			.map(id => nameOf.get(id) ?? id)
			.sort();
	}

	async function seedRotation(library: Library): Promise<(...indexes: number[]) => string[]> {
		const ids: string[] = [];
		for (let index = 0; index < 15; index++) {
			clock += 1_000;
			const name = `item-${String(index).padStart(2, "0")}.${index % 5 === 4 ? "md" : "txt"}`;
			const item = await library.stamp({
				path: await put(name, "x".repeat(index % 4)),
				source: "present",
				workspace: join(root, index < 8 ? "alpha" : "beta"),
				tags: ROTATION[index % 3] as readonly string[],
			});
			ids.push(item.id);
			if (index % 3 === 0) library.markOpened(item.id);
		}
		return (...indexes) => indexes.map(index => ids[index] as string).sort();
	}

	const tagCounts = (facets: { readonly tags: readonly { readonly tag: string; readonly count: number }[] }): [string, number][] => facets.tags.map(({ tag, count }) => [tag.toLowerCase(), count]);

	const filters: ReadonlyArray<{ readonly name: string; readonly tags: readonly string[]; readonly expected: readonly string[] }> = [
		{ name: "a whole tag is not matched inside a longer one or a phrase", tags: ["film"], expected: ["a", "b", "d"] },
		{ name: "the requested case does not matter", tags: ["FILM"], expected: ["a", "b", "d"] },
		{ name: "the stored case does not matter", tags: ["launch"], expected: ["a", "b", "c", "f"] },
		{ name: "spaces around a requested tag are ignored", tags: [" film "], expected: ["a", "b", "d"] },
		{ name: "two tags need both", tags: ["film", "launch"], expected: ["a", "b"] },
		{ name: "three tags need all three, in any order and case", tags: ["Launch", "DRAFT", "film"], expected: ["a"] },
		{ name: "one tag nobody carries empties the answer", tags: ["film", "absent"], expected: [] },
		{ name: "a tag of several words is one tag", tags: ["short film"], expected: ["f"] },
		{ name: "a plural is another tag", tags: ["films"], expected: ["c"] },
		{ name: "a non-ASCII tag matches as written", tags: ["Éclair"], expected: ["g"] },
		{ name: "no tags filter nothing", tags: [], expected: ["a", "b", "c", "d", "e", "f", "g"] },
		{ name: "blank tags filter nothing", tags: ["", "   "], expected: ["a", "b", "c", "d", "e", "f", "g"] },
	];

	for (const { name, tags, expected } of filters) {
		test(`filtering by tags: ${name}`, async () => {
			const library = await openLibrary();
			const ids = await seedTags(library, CATALOGUE);
			expect(namesOf(library, ids, { tags })).toEqual(expected);
			expect(library.query({ tags }).total).toBe(expected.length);
		});
	}

	test("the filter takes at most the tags an artifact can carry, counting a tag once whatever its case", async () => {
		const library = await openLibrary();
		const every = Array.from({ length: MAX_TAGS }, (_, index) => `t${index}`);
		const item = await library.stamp({ path: await put("full.txt"), source: "present", tags: every });
		expect(allIds(library, { tags: every })).toEqual([item.id]);
		expect(allIds(library, { tags: [...every, "T0"] })).toEqual([item.id]);
		expect(() => library.query({ tags: [...every, "extra"] })).toThrow(`filter by at most ${MAX_TAGS} tags`);
	});

	test("paging a tag filter covers exactly the matching rows for every sort, with an honest total", async () => {
		const library = await openLibrary();
		const at = await seedRotation(library);
		const film = at(0, 1, 3, 4, 6, 7, 9, 10, 12, 13);
		for (const sort of ["recent", "name", "size", "opened"] as const) {
			const query = { tags: ["film"], sort } as const;
			const whole = allIds(library, query);
			expect([...whole].sort()).toEqual(film);
			for (const limit of [1, 4]) expect(pagedIds(library, query, limit)).toEqual(whole);
			expect(library.query({ ...query, limit: 4 }).total).toBe(film.length);
		}
		expect(pagedIds(library, { tags: ["FILM", "x"] }, 2).sort()).toEqual(at(0, 3, 6, 9, 12));
	});

	test("the filter holds inside the discarded and shared scopes, page by page", async () => {
		const library = await openLibrary();
		const at = await seedRotation(library);
		const idOf = (index: number): string => at(index)[0] as string;
		for (const index of [0, 1, 2]) await library.discard(idOf(index), { trash: false });
		for (const index of [3, 5, 6]) library.shares.insert(shareFor(idOf(index)));

		const discarded = { tags: ["FILM"], state: "discarded" } as const;
		expect(pagedIds(library, discarded, 1).sort()).toEqual(at(0, 1));
		expect(library.query(discarded).total).toBe(2);
		expect(pagedIds(library, { tags: ["films"], state: "discarded" }, 1)).toEqual(at(2));

		expect(pagedIds(library, { tags: ["film"] }, 3).sort()).toEqual(at(3, 4, 6, 7, 9, 10, 12, 13));
		const shared = { tags: ["film"], shared: true } as const;
		expect(pagedIds(library, shared, 1).sort()).toEqual(at(3, 6));
		expect(library.query(shared).total).toBe(2);
		const unshared = { tags: ["film"], shared: false } as const;
		expect(pagedIds(library, unshared, 2).sort()).toEqual(at(4, 7, 9, 10, 12, 13));
		expect(library.query(unshared).total).toBe(6);
	});

	test("the filter narrows a kind, workspace, starred or text search further and never widens it", async () => {
		const library = await openLibrary();
		const at = await seedRotation(library);
		for (const index of [0, 9, 11, 12]) library.update(at(index)[0] as string, { starred: true });

		expect(pagedIds(library, { tags: ["film"], kinds: ["markdown"] }, 1).sort()).toEqual(at(4, 9));
		expect(pagedIds(library, { tags: ["film"], kinds: ["markdown"], workspace: join(root, "alpha") }, 1)).toEqual(at(4));
		expect(pagedIds(library, { tags: ["film"], workspace: join(root, "beta"), starred: true }, 1).sort()).toEqual(at(9, 12));

		const searched = { q: "item-1", tags: ["film"], sort: "relevance" } as const;
		expect(pagedIds(library, searched, 1).sort()).toEqual(at(10, 12, 13));
		expect(library.query(searched).total).toBe(3);
	});

	test("tag facets count each tag over the items in scope, folding case into one entry, most used first", async () => {
		const library = await openLibrary();
		await seedTags(library, SHELF);
		expect(tagCounts(library.facets({}))).toEqual([
			["zine", 5],
			["launch", 3],
			["retro", 2],
			["apple", 1],
		]);
		expect(tagCounts(library.facets({ workspace: join(root, "beta") }))).toEqual([
			["zine", 3],
			["retro", 2],
			["launch", 1],
		]);
	});

	test("a discarded item leaves the tag counts and a tag only it carried leaves the list", async () => {
		const library = await openLibrary();
		const ids = await seedTags(library, SHELF);
		expect(Object.fromEntries(tagCounts(library.facets({})))).toEqual({ zine: 5, launch: 3, retro: 2, apple: 1 });

		await library.discard(ids["b"] as string, { trash: false });
		expect(Object.fromEntries(tagCounts(library.facets({})))).toEqual({ zine: 4, launch: 2, retro: 2 });
		expect(Object.fromEntries(tagCounts(library.facets({ state: "discarded" })))).toEqual({ zine: 1, launch: 1, apple: 1 });
	});
});

describe("discard and restore", () => {
	test("discard revokes live shares, drops the thumbnail and the row from every list, and restore brings it back", async () => {
		const library = await openLibrary();
		const file = await put("hero.png", TINY_PNG);
		const item = await library.stamp({ path: file, source: "present", thumb: { bytes: TINY_PNG, mime: "image/png" } });
		const thumb = library.thumbPath(item.id);
		expect(thumb).toBeDefined();
		expect((await stat(thumb as string)).isFile()).toBe(true);
		library.shares.insert(shareFor(item.id));

		clock += 1_000;
		const outcome = await library.discard(item.id, { trash: false });
		expect(outcome).toMatchObject({ trashed: false, revoked: 1, unrevoked: [], item: { state: "discarded", hasThumb: false } });
		expect(revoked.map(share => share.id)).toEqual([`share-${item.id}`]);
		expect(library.shares.get(`share-${item.id}`)?.revokedAt).toBe(clock);
		expect(library.thumbPath(item.id)).toBeUndefined();
		expect(await readdir(join(root, "home", "artifacts", "thumbs"))).toEqual([]);
		expect(allIds(library)).toEqual([]);
		expect(allIds(library, { q: "hero" })).toEqual([]);
		expect(allIds(library, { state: "discarded" })).toEqual([item.id]);
		expect(library.facets({})).toMatchObject({ discarded: 1 });
		expect(library.isLent(file)).toBe(false);
		expect((await stat(file)).isFile()).toBe(true);

		const restored = library.restore(item.id);
		expect(restored).toMatchObject({ state: "live" });
		expect(allIds(library, { q: "hero" })).toEqual([item.id]);
		expect(library.shares.get(`share-${item.id}`)?.revokedAt).toBeDefined();
	});

	test("a hosted share the host would not revoke stays live and is reported, and a later discard revokes it", async () => {
		let reachable = false;
		const library = await openLibrary({
			revokeRemote: async share => {
				if (!reachable) throw new Error("the link could not be revoked: host unreachable");
				revoked.push(share);
			},
		});
		const item = await library.stamp({ path: await put("page.html", "<p>x</p>"), source: "present" });
		const hosted: ShareRow = { ...shareFor(item.id), host: "static-host" };
		library.shares.insert(hosted);

		const first = await library.discard(item.id, { trash: false });
		expect(first).toMatchObject({
			revoked: 0,
			unrevoked: [{ shareId: hosted.id, host: "static-host", reason: "the link could not be revoked: host unreachable" }],
			item: { state: "discarded" },
		});
		expect(first.item.shares.map(share => share.revokedAt)).toEqual([undefined]);
		expect(library.shares.live().map(share => share.id)).toEqual([hosted.id]);
		expect(revoked).toEqual([]);

		reachable = true;
		clock += 1_000;
		const retry = await library.discard(item.id, { trash: false });
		expect(retry).toMatchObject({ revoked: 1, unrevoked: [] });
		expect(revoked.map(share => share.id)).toEqual([hosted.id]);
		expect(library.shares.get(hosted.id)?.revokedAt).toBe(clock);
		expect(library.shares.live()).toEqual([]);
	});

	test("a p2p share is stopped locally even when the relay revoke fails, because the desktop serves it", async () => {
		const library = await openLibrary({
			revokeRemote: async () => {
				throw new Error("the link could not be revoked: relay unreachable");
			},
		});
		const item = await library.stamp({ path: await put("page.html", "<p>x</p>"), source: "present" });
		library.shares.insert(shareFor(item.id));

		const outcome = await library.discard(item.id, { trash: false });
		expect(outcome).toMatchObject({ revoked: 1, unrevoked: [] });
		expect(library.shares.get(`share-${item.id}`)?.revokedAt).toBe(clock);
		expect(library.shares.live()).toEqual([]);
	});

	test("trash moves the file out through the OS hook; a failed trash is reported and the file stays", async () => {
		const library = await openLibrary();
		const first = await put("one.txt");
		const second = await put("two.txt");
		const a = await library.stamp({ path: first, source: "present" });
		const b = await library.stamp({ path: second, source: "present" });

		expect(await library.discard(a.id, { trash: true })).toMatchObject({ trashed: true });
		expect(trashed).toEqual([first]);

		const failing = await openLibrary({
			trash: async () => {
				throw new Error("gio could not move the file to the trash");
			},
		});
		const outcome = await failing.discard(b.id, { trash: true });
		expect(outcome).toMatchObject({ trashed: false, trashError: "gio could not move the file to the trash", item: { state: "discarded" } });
		expect((await stat(second)).isFile()).toBe(true);
	});

	test("trash reports a file that is already gone and never reaches the OS hook", async () => {
		const library = await openLibrary();
		const file = await put("gone.txt");
		const item = await library.stamp({ path: file, source: "present" });
		await rm(file);

		const outcome = await library.discard(item.id, { trash: true });
		expect(outcome).toMatchObject({ trashed: false, trashError: "the file no longer exists", item: { state: "discarded" } });
		expect(trashed).toEqual([]);
	});

	const swaps: readonly { readonly name: string; readonly elsewhere?: string; readonly swap: (folder: string, elsewhere: string) => Promise<void> }[] = [
		{
			name: "its folder became a link to another folder holding a file of the same name",
			elsewhere: "other",
			swap: async (folder, elsewhere) => {
				await rm(folder, { recursive: true });
				await symlink(elsewhere, folder, "junction");
			},
		},
		{
			name: "its folder became a link into a credentials folder holding a file of the same name",
			elsewhere: ".ssh",
			swap: async (folder, elsewhere) => {
				await rm(folder, { recursive: true });
				await symlink(elsewhere, folder, "junction");
			},
		},
		{
			name: "the file became a directory of the same name",
			swap: async folder => {
				await rm(join(folder, "notes.txt"));
				await mkdir(join(folder, "notes.txt"));
			},
		},
	];

	for (const { name, elsewhere, swap } of swaps) {
		test(`trash leaves the path alone, still discards the artifact and says why when ${name}`, async () => {
			const library = await openLibrary();
			const folder = join(root, "files", "stage");
			const other = join(root, elsewhere ?? "other");
			await mkdir(folder, { recursive: true });
			await mkdir(other, { recursive: true });
			await writeFile(join(folder, "notes.txt"), "the file that was added");
			await writeFile(join(other, "notes.txt"), "someone else's file");
			const item = await library.stamp({ path: join(folder, "notes.txt"), source: "present" });
			await swap(folder, other);

			const outcome = await library.discard(item.id, { trash: true });
			expect(trashed).toEqual([]);
			expect(outcome).toMatchObject({ trashed: false, item: { state: "discarded" } });
			expect(outcome.trashError).toContain("no longer leads to the file that was added");
			expect((await stat(join(other, "notes.txt"))).isFile()).toBe(true);
		});
	}

	test("rows discarded more than 30 days ago are purged on the next open, with their shares", async () => {
		const library = await openLibrary();
		const old = await library.stamp({ path: await put("old.txt"), source: "present" });
		const recent = await library.stamp({ path: await put("recent.txt"), source: "present" });
		library.shares.insert(shareFor(old.id));
		await library.discard(old.id, { trash: false });
		clock += 20 * DAY;
		await library.discard(recent.id, { trash: false });
		library.close();

		clock += 11 * DAY;
		const reopened = await openLibrary();
		expect(reopened.get(old.id)).toBeUndefined();
		expect(reopened.shares.get(`share-${old.id}`)).toBeUndefined();
		expect(reopened.get(recent.id)?.state).toBe("discarded");
		expect(allIds(reopened, { q: "old" })).toEqual([]);
	});
});

describe("thumbnails", () => {
	test("a thumbnail must be the image it says and small; the cache keeps one file per artifact", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("clip.mp4", MP4), source: "present" });
		await expect(library.setThumb(item.id, Buffer.from("not an image"), "image/png")).rejects.toThrow(/not image\/png/);
		await expect(library.setThumb(item.id, new Uint8Array(0), "image/png")).rejects.toThrow(/bytes/);
		await library.setThumb(item.id, TINY_PNG, "image/png");
		const jpeg = Buffer.from(await new Bun.Image(TINY_PNG).jpeg().bytes());
		await library.setThumb(item.id, jpeg, "image/jpeg");
		expect(await readdir(join(root, "home", "artifacts", "thumbs"))).toEqual([`${item.id}.jpg`]);
		expect(library.thumbPath(item.id)).toBe(join(root, "home", "artifacts", "thumbs", `${item.id}.jpg`));
		expect(library.get(item.id)?.hasThumb).toBe(true);
	});
});

describe("the database connection", () => {
	test("every connection is write-ahead logged with synchronous commits, waits for a busy writer and enforces foreign keys", async () => {
		await mkdir(root, { recursive: true });
		const db = await openDriver(join(root, "pragmas.db"));
		const pragma = <Row>(name: string): Row | undefined => {
			const statement = db.prepare(`PRAGMA ${name}`);
			try {
				return statement.get<Row>();
			} finally {
				statement.finalize();
			}
		};
		try {
			expect(pragma<{ journal_mode: string }>("journal_mode")?.journal_mode).toBe("wal");
			expect(pragma<{ synchronous: number }>("synchronous")?.synchronous).toBe(1);
			expect(pragma<{ timeout: number }>("busy_timeout")?.timeout).toBe(2_000);
			expect(pragma<{ foreign_keys: number }>("foreign_keys")?.foreign_keys).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("shares and comments", () => {
	test("comments sync is idempotent, counts unread per share and marks read in one call", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("deck.pptx"), source: "present" });
		library.shares.insert(shareFor(item.id));
		const comment = (id: string, createdAt: number) => ({ id, shareId: `share-${item.id}`, author: "Ana", body: `body ${id}`, version: 1, createdAt, anchor: { startMs: 1500 } });
		expect(library.comments.upsert(comment("c1", 10))).toBe(true);
		expect(library.comments.upsert(comment("c1", 10))).toBe(false);
		expect(library.comments.upsert(comment("c2", 20))).toBe(true);

		expect(library.get(item.id)?.shares[0]).toMatchObject({ unread: 2, url: `https://relay.example/p/tunnel/a/remote-share-${item.id}`, audience: { kind: "link" } });
		const listed = library.comments.forArtifact(item.id);
		expect(listed.map(row => row.id)).toEqual(["c1", "c2"]);
		expect(listed[0]).toMatchObject({ anchor: { startMs: 1500 }, shareUrl: `https://relay.example/p/tunnel/a/remote-share-${item.id}` });

		library.comments.markRead(["c1"], 99);
		expect(library.comments.forArtifact(item.id, { unread: true }).map(row => row.id)).toEqual(["c2"]);
		expect(library.get(item.id)?.shares[0]?.unread).toBe(1);
	});
});

const SCHEMA_V1 = `
CREATE TABLE artifacts(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE, title TEXT, note TEXT, tags TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  workspace TEXT, session_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('present','stamp','human')),
  starred INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','missing','discarded')),
  created_at INTEGER NOT NULL, presented_at INTEGER NOT NULL,
  opened_at INTEGER, discarded_at INTEGER, thumb TEXT
);
CREATE INDEX artifacts_recent ON artifacts(presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_ws ON artifacts(workspace, presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_kind ON artifacts(kind, presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_live ON artifacts(state) WHERE state != 'discarded';
CREATE INDEX artifacts_name ON artifacts(name, id) WHERE state != 'discarded';
CREATE INDEX artifacts_size ON artifacts(size DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_opened ON artifacts(opened_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_starred ON artifacts(presented_at DESC, id) WHERE starred = 1 AND state != 'discarded';
CREATE INDEX artifacts_discarded ON artifacts(discarded_at DESC, id) WHERE state = 'discarded';
CREATE VIRTUAL TABLE artifacts_fts USING fts5(name, title, note, tags, path,
  content='artifacts', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, name, title, note, tags, path)
  VALUES (new.rowid, new.name, new.title, new.note, new.tags, new.path);
END;
CREATE TRIGGER artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, name, title, note, tags, path)
  VALUES ('delete', old.rowid, old.name, old.title, old.note, old.tags, old.path);
END;
CREATE TRIGGER artifacts_fts_update AFTER UPDATE OF name, title, note, tags, path ON artifacts
WHEN old.name IS NOT new.name OR old.title IS NOT new.title OR old.note IS NOT new.note
  OR old.tags IS NOT new.tags OR old.path IS NOT new.path BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, name, title, note, tags, path)
  VALUES ('delete', old.rowid, old.name, old.title, old.note, old.tags, old.path);
  INSERT INTO artifacts_fts(rowid, name, title, note, tags, path)
  VALUES (new.rowid, new.name, new.title, new.note, new.tags, new.path);
END;
CREATE TABLE shares(
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  remote_id TEXT NOT NULL, base_url TEXT NOT NULL, key TEXT NOT NULL, owner_token TEXT NOT NULL,
  audience TEXT NOT NULL,
  version INTEGER NOT NULL, allow_comments INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
  comments_seen_at INTEGER
);
CREATE INDEX shares_artifact ON shares(artifact_id, created_at);
CREATE INDEX shares_live ON shares(artifact_id) WHERE revoked_at IS NULL;
CREATE TABLE comments(
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, read_at INTEGER, resolved_at INTEGER
);
CREATE INDEX comments_share ON comments(share_id, created_at);
CREATE INDEX comments_unread ON comments(share_id) WHERE read_at IS NULL;
`;

function execute(db: SqlDriver, text: string, ...params: SqlValue[]): void {
	const statement = db.prepare(text);
	try {
		statement.run(...params);
	} finally {
		statement.finalize();
	}
}

async function writeDatabase(version: number, seed?: (db: SqlDriver) => void): Promise<string> {
	const directory = join(root, "home", "artifacts");
	await mkdir(directory, { recursive: true });
	const file = join(directory, "library.db");
	const db = await openDriver(file);
	try {
		seed?.(db);
		db.exec(`PRAGMA user_version = ${version}`);
	} finally {
		db.close();
	}
	return file;
}

async function userVersion(file: string): Promise<number | undefined> {
	const db = await openDriver(file);
	const statement = db.prepare("PRAGMA user_version");
	try {
		return statement.get<{ readonly user_version: number }>()?.user_version;
	} finally {
		statement.finalize();
		db.close();
	}
}

function seedLegacyShare(db: SqlDriver, file: string, createdAt: number): void {
	execute(
		db,
		`INSERT INTO artifacts(id, path, path_key, name, kind, mime, size, mtime_ms, source, created_at, presented_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"legacy-artifact",
		file,
		pathKey(file, process.platform),
		"legacy.txt",
		"text",
		"text/plain",
		10,
		createdAt,
		"present",
		createdAt,
		createdAt,
	);
	execute(
		db,
		`INSERT INTO shares(id, artifact_id, host, remote_id, base_url, key, owner_token, audience, version, allow_comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"legacy-share",
		"legacy-artifact",
		"p2p",
		"remote-legacy",
		"https://relay.example/p/tunnel",
		"k".repeat(43),
		"owner",
		JSON.stringify({ kind: "link" }),
		3,
		1,
		createdAt,
	);
}

describe("library.db schema versions", () => {
	test("a v1 database upgrades in place: the artifact and share survive, an old share's version time is its creation time, and new shares insert", async () => {
		const file = await put("legacy.txt");
		const createdAt = clock - 10 * DAY;
		const database = await writeDatabase(1, db => {
			db.exec(SCHEMA_V1);
			seedLegacyShare(db, file, createdAt);
		});

		const library = await openLibrary();
		expect(library.get("legacy-artifact")).toMatchObject({ name: "legacy.txt", state: "live", shares: [{ id: "legacy-share", version: 3, versionAt: createdAt }] });
		expect(library.shares.get("legacy-share")).toMatchObject({ createdAt, version: 3, versionAt: createdAt });

		library.shares.insert({ ...shareFor("legacy-artifact", "fresh-share"), versionAt: clock + 5 });
		expect(library.shares.get("fresh-share")).toMatchObject({ createdAt: clock, versionAt: clock + 5 });
		expect(library.shares.live().map(share => share.id)).toEqual(["legacy-share", "fresh-share"]);
		library.close();
		expect(await userVersion(database)).toBe(SCHEMA_VERSION);
	});

	test("comments an older Dimension stored in the published anchor form read back as the anchors they mean, and one that cannot be read keeps its words", async () => {
		const file = await put("legacy.txt");
		const createdAt = clock - 10 * DAY;
		const stored: ReadonlyArray<readonly [id: string, anchor: string | null]> = [
			["c1", JSON.stringify({ kind: "time", startMs: 70_000, endMs: 75_000 })],
			["c2", JSON.stringify({ kind: "page", page: 3 })],
			["c3", JSON.stringify({ kind: "region", x: 0.25, y: 0.5, w: 0.25, h: 0.125 })],
			["c4", JSON.stringify({ startMs: 1500, shape: { kind: "pin", at: { x: 0.5, y: 0.5 } } })],
			["c5", JSON.stringify({ kind: "region", x: 1.2, y: 0, w: 0.1, h: 0.1 })],
			["c6", JSON.stringify({ startMs: 5000, endMs: 4000 })],
			["c7", null],
		];
		await writeDatabase(1, db => {
			db.exec(SCHEMA_V1);
			seedLegacyShare(db, file, createdAt);
			stored.forEach(([id, anchor], index) => {
				execute(
					db,
					`INSERT INTO comments(id, share_id, author, body, anchor, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					id,
					"legacy-share",
					"Ana",
					`body ${id}`,
					anchor,
					1,
					createdAt + index,
				);
			});
		});

		const library = await openLibrary();
		expect(library.comments.forArtifact("legacy-artifact").map(row => ({ id: row.id, body: row.body, anchor: row.anchor }))).toEqual([
			{ id: "c1", body: "body c1", anchor: { startMs: 70_000, endMs: 75_000 } },
			{ id: "c2", body: "body c2", anchor: { page: 3 } },
			{ id: "c3", body: "body c3", anchor: { shape: { kind: "box", from: { x: 0.25, y: 0.5 }, to: { x: 0.5, y: 0.625 } } } },
			{ id: "c4", body: "body c4", anchor: { startMs: 1500, shape: { kind: "pin", at: { x: 0.5, y: 0.5 } } } },
			{ id: "c5", body: "body c5", anchor: undefined },
			{ id: "c6", body: "body c6", anchor: undefined },
			{ id: "c7", body: "body c7", anchor: undefined },
		]);
	});

	test("a database written by a newer Dimension is refused and left at its version", async () => {
		const newer = SCHEMA_VERSION + 1;
		const database = await writeDatabase(newer);
		await expect(openLibrary()).rejects.toThrow(`library.db is schema version ${newer}; this Dimension reads version ${SCHEMA_VERSION}. Update Dimension.`);
		expect(await userVersion(database)).toBe(newer);
	});
});
