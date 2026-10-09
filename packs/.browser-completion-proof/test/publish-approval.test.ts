/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the browser posts text no human
 *  approved, posts one approval twice, or refuses a post the human did approve.
 *  A post may go out only if a record a human-only surface wrote
 *  (`<draftId>.json`) covers EXACTLY that site, profile, shipped preset (or
 *  none, for a hand-written recipe) and every value, is
 *  unexpired, and its one-shot spend (`<draftId>.<nonce>.used`, created
 *  exclusively) is still free.
 *
 *  Pure filesystem: a temp folder per test, an injected clock, no browser. The
 *  records are written here in the contract's own format and hashed with this
 *  file's own `node:crypto` expression, so a `bindingOf` that drifts from the
 *  contract (the Traction pack computes the same digest) fails instead of
 *  agreeing with itself.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindingOf, PublishApprovals, type PublishBinding } from "../src/publish-approval";
import { BrowserRuntimeError } from "../src/store";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-05-01T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** The golden vectors' text, spelled in escapes so no editor can renormalise it: NFC "ö", an em dash, a newline, an astral emoji. */
const VALUE = "hello \u2014 w\u00f6rld\n\u{1F680}";
/** Golden vector A: a post through a shipped preset. */
const POST: PublishBinding = { origin: "https://x.com", profile: "traction-x-brand", preset: "x-post", values: [VALUE] };
/** The same post written by hand: no preset, so its selectors and submit button are nobody's approved ones. */
const HAND_WRITTEN: PublishBinding = { origin: POST.origin, profile: POST.profile, values: POST.values };

/** The contract's string, hashed here and not by the module under test. */
const contractBinding = (post: PublishBinding): string =>
	createHash("sha256").update(JSON.stringify(["publish-approval/v1", post.origin, post.profile, post.preset ?? null, post.values])).digest("hex");

/** The injected clock: an hour-long approval written at T0 is live one second in. */
let now = T0 + 1_000;
beforeEach(() => {
	now = T0 + 1_000;
});

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A path for an approvals folder that does not exist yet. */
async function folder(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "publish-approval-"));
	roots.push(root);
	return join(root, "publish-approvals");
}

const approvalsIn = (dir: string): PublishApprovals => new PublishApprovals(dir, () => now);

let sequence = 0;
/** A well-formed nonce (32 lowercase hex), distinct per call and the same on every run. */
const nonce = (): string => (++sequence).toString(16).padStart(32, "0");

interface Raw {
	v?: unknown;
	draftId?: unknown;
	nonce?: unknown;
	binding?: unknown;
	approvedAt?: unknown;
	expiresAt?: unknown;
}

/** Write one approval in the contract's format; `over` replaces any field (`undefined` drops it), `file` renames it. */
async function approve(dir: string, post: PublishBinding, over: Raw = {}, file?: string): Promise<{ draftId: string; nonce: string }> {
	const record: Raw = { v: 1, draftId: "draft-a", nonce: nonce(), binding: contractBinding(post), approvedAt: iso(T0), expiresAt: iso(T0 + HOUR), ...over };
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, file ?? `${String(record.draftId)}.json`), JSON.stringify(record));
	return { draftId: String(record.draftId), nonce: String(record.nonce) };
}

/** The spent-approval marker files in `dir`, sorted. */
async function markers(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter((name) => name.endsWith(".used")).sort();
}

/** Run `work`, require it to be refused `publish_unapproved`, and yield the message the model reads. */
async function refusal(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError && error.code === "publish_unapproved") return error.message;
		throw error;
	}
	throw new Error("expected the call to be refused publish_unapproved, but it resolved");
}

const NO_APPROVAL = "no board approval covers";

// ---------------------------------------------------------------------------
// The binding: what an approval is a hash of
// ---------------------------------------------------------------------------

describe("bindingOf", () => {
	test("golden vector A, through a shipped preset, shared with the Traction pack's tests", () => {
		expect(bindingOf(POST)).toBe("665e674add0643d3ddafde4e6f9dbfd7878e149199cc7f5f3ede220b2a3c8489");
	});

	test("golden vector B, with no preset, shared with the Traction pack's tests", () => {
		expect(bindingOf({ origin: "https://example.com", profile: "p", values: ["a", "", "b"] })).toBe("4b7543122234daf9c7c7fbf047f786cad8acf666ce804c709eea7f47313b1182");
	});

	test("matches an independent hash of the contract string for value lists a lazy join would get wrong", () => {
		const base = { origin: "https://social.example", profile: "traction-linkedin-acme" };
		const rows: Array<{ name: string; values: string[] }> = [
			{ name: "two values with an empty one between them", values: ["first", "", "third \"quoted\" \\ line"] },
			{ name: "one value that is two joined", values: ["ab"] },
			{ name: "the same two values split", values: ["a", "b"] },
			{ name: "the same two values reversed", values: ["b", "a"] },
			{ name: "a trailing empty value", values: ["a", "b", ""] },
			{ name: "no values", values: [] },
		];
		for (const row of rows) {
			const post = { ...base, values: row.values };
			expect({ name: row.name, digest: bindingOf(post) }).toEqual({ name: row.name, digest: contractBinding(post) });
		}
	});

	test("the preset is hashed as it is: no preset, an empty name and each name are different posts", () => {
		const base = { origin: "https://x.com", profile: "traction-x-brand", values: ["hello"] };
		const rows: Array<{ name: string; post: PublishBinding }> = [
			{ name: "no preset", post: base },
			{ name: "an empty preset name", post: { ...base, preset: "" } },
			{ name: "x-post", post: { ...base, preset: "x-post" } },
			{ name: "X-Post", post: { ...base, preset: "X-Post" } },
		];
		for (const row of rows) {
			expect({ name: row.name, digest: bindingOf(row.post) }).toEqual({ name: row.name, digest: contractBinding(row.post) });
		}
		expect(new Set(rows.map((row) => bindingOf(row.post))).size).toBe(rows.length);
	});
});

// ---------------------------------------------------------------------------
// require: does a live approval cover exactly this post
// ---------------------------------------------------------------------------

describe("require", () => {
	test("a live approval covers its exact post, at park and at confirm, and spends nothing", async () => {
		const dir = await folder();
		await approve(dir, POST);
		const approvals = approvalsIn(dir);

		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();
		await expect(approvals.require(POST, "confirm")).resolves.toBeUndefined();

		expect(await markers(dir)).toEqual([]);
		// Still spendable: the checks above took nothing.
		expect((await approvals.consume(POST, "confirm")).draftId).toBe("draft-a");
	});

	test("a post that differs in any way from the approved one is refused, and the approved one still stands", async () => {
		expect(VALUE.normalize("NFD")).not.toBe(VALUE);
		const dir = await folder();
		await approve(dir, POST);
		const approvals = approvalsIn(dir);
		const near: Array<{ name: string; post: PublishBinding }> = [
			{ name: "one character changed", post: { ...POST, values: [VALUE.replace("hello", "hellp")] } },
			{ name: "a trailing space", post: { ...POST, values: [`${VALUE} `] } },
			{ name: "a leading space", post: { ...POST, values: [` ${VALUE}`] } },
			{ name: "the other Unicode normalisation form", post: { ...POST, values: [VALUE.normalize("NFD")] } },
			{ name: "CRLF for LF", post: { ...POST, values: [VALUE.replace("\n", "\r\n")] } },
			{ name: "another case", post: { ...POST, values: [VALUE.toUpperCase()] } },
			{ name: "another profile", post: { ...POST, profile: "traction-x-other" } },
			{ name: "no preset: the same text written by hand", post: HAND_WRITTEN },
			{ name: "another shipped preset", post: { ...POST, preset: "bluesky-post" } },
			{ name: "the preset name in another case", post: { ...POST, preset: "X-Post" } },
			{ name: "an empty preset name", post: { ...POST, preset: "" } },
			{ name: "another site", post: { ...POST, origin: "https://twitter.com" } },
			{ name: "the same site over http", post: { ...POST, origin: "http://x.com" } },
			{ name: "the origin with a trailing slash", post: { ...POST, origin: "https://x.com/" } },
			{ name: "an extra empty value", post: { ...POST, values: [VALUE, ""] } },
			{ name: "an extra value", post: { ...POST, values: [VALUE, "and more"] } },
			{ name: "the value missing", post: { ...POST, values: [] } },
		];

		for (const row of near) {
			for (const stage of ["park", "confirm"] as const) {
				const message = await refusal(() => approvals.require(row.post, stage));
				expect({ name: row.name, stage, message }).toEqual({ name: row.name, stage, message: expect.stringContaining(NO_APPROVAL) });
				// A near miss is not "used" or "expired": those would tell the model the approved text is gone.
				expect(message).not.toContain("already used");
				expect(message).not.toContain("expired");
			}
		}
		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();
	});

	test("an approval written without a preset covers only a hand-written recipe: never the same post through a shipped preset", async () => {
		const dir = await folder();
		await approve(dir, HAND_WRITTEN);
		const approvals = approvalsIn(dir);

		await expect(approvals.require(HAND_WRITTEN, "park")).resolves.toBeUndefined();
		for (const preset of ["x-post", "bluesky-post", ""]) {
			for (const stage of ["park", "confirm"] as const) {
				const through = { ...HAND_WRITTEN, preset };
				expect({ preset, stage, message: await refusal(() => approvals.require(through, stage)) }).toEqual({ preset, stage, message: expect.stringContaining(NO_APPROVAL) });
			}
			expect(await refusal(() => approvals.consume({ ...HAND_WRITTEN, preset }, "confirm"))).toContain(NO_APPROVAL);
		}
		// None of those refusals spent the approval that does cover the hand-written post.
		expect(await markers(dir)).toEqual([]);
		expect((await approvals.consume(HAND_WRITTEN, "confirm")).draftId).toBe("draft-a");
	});

	test("the number and order of values are part of what was approved", async () => {
		const two: PublishBinding = { origin: "https://x.com", profile: "traction-x-brand", values: ["first", "second"] };
		const dir = await folder();
		await approve(dir, two);
		const approvals = approvalsIn(dir);

		for (const [name, values] of [["one value missing", ["first"]], ["reordered", ["second", "first"]], ["a third value", ["first", "second", "third"]], ["joined", ["firstsecond"]]] as const) {
			expect({ name, message: await refusal(() => approvals.require({ ...two, values: [...values] }, "park")) }).toEqual({ name, message: expect.stringContaining(NO_APPROVAL) });
		}
		await expect(approvals.require(two, "park")).resolves.toBeUndefined();
	});

	test("no approvals folder at all, or an empty one, refuses 'no board approval covers' for require and consume", async () => {
		const missing = await folder();
		const empty = await folder();
		await mkdir(empty, { recursive: true });

		for (const dir of [missing, empty]) {
			const approvals = approvalsIn(dir);
			expect(await refusal(() => approvals.require(POST, "park"))).toContain(NO_APPROVAL);
			expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain(NO_APPROVAL);
		}
		// The refusal of a missing folder must not have made one.
		await expect(readdir(missing)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("an approval is live up to the millisecond before it expires, and expired from that instant: named 'expired', never spent", async () => {
		const dir = await folder();
		await approve(dir, POST);
		const approvals = approvalsIn(dir);

		now = T0 + HOUR - 1;
		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();

		for (const at of [T0 + HOUR, T0 + HOUR + 1, T0 + 30 * HOUR]) {
			now = at;
			for (const work of [() => approvals.require(POST, "park"), () => approvals.consume(POST, "confirm")]) {
				const message = await refusal(work);
				expect({ at: at - T0, message }).toEqual({ at: at - T0, message: expect.stringContaining("expired") });
				expect(message).toContain("draft-a");
				expect(message).not.toContain(NO_APPROVAL);
			}
		}
		// Refusing an expired approval spent nothing: inside its life it is still there to spend.
		expect(await markers(dir)).toEqual([]);
		now = T0 + HOUR - 1;
		expect((await approvals.consume(POST, "confirm")).draftId).toBe("draft-a");
	});

	test("a spent approval refuses require and consume with 'already used'", async () => {
		const dir = await folder();
		const { nonce: spentNonce } = await approve(dir, POST);
		const approvals = approvalsIn(dir);

		await approvals.consume(POST, "confirm");

		const marker = `draft-a.${spentNonce}.used`;
		expect(await markers(dir)).toEqual([marker]);
		expect((await stat(join(dir, marker))).size).toBe(0);
		for (const work of [() => approvals.require(POST, "park"), () => approvals.consume(POST, "confirm")]) {
			const message = await refusal(work);
			expect(message).toContain("already used");
			expect(message).toContain("draft-a");
			expect(message).not.toContain(NO_APPROVAL);
		}
		expect(await markers(dir)).toEqual([marker]);
	});

	test("a spent approval beside an expired one for the same post says 'already used': the post may be up", async () => {
		const dir = await folder();
		await approve(dir, POST, { draftId: "draft-old", approvedAt: iso(T0 - 2 * HOUR), expiresAt: iso(T0 - HOUR) });
		await approve(dir, POST, { draftId: "draft-a" });
		const approvals = approvalsIn(dir);
		await approvals.consume(POST, "confirm");

		expect(await refusal(() => approvals.require(POST, "park"))).toContain("already used");
	});
});

// ---------------------------------------------------------------------------
// What is not an approval
// ---------------------------------------------------------------------------

describe("entries that are not approvals", () => {
	/** `over` is applied to a well-formed record whose draft id is `bad-<index>`; `body` is written verbatim instead; `file` renames it. */
	const MALFORMED: Array<{ name: string; over?: Raw; body?: string; file?: string }> = [
		{ name: "not JSON", body: "{ not json" },
		{ name: "an empty file", body: "" },
		{ name: "JSON null", body: "null" },
		{ name: "a JSON array", body: "[]" },
		{ name: "a JSON string", body: "\"approved\"" },
		{ name: "v is 2", over: { v: 2 } },
		{ name: "v is the string \"1\"", over: { v: "1" } },
		{ name: "v missing", over: { v: undefined } },
		{ name: "draftId missing", over: { draftId: undefined }, file: "no-draft-id.json" },
		{ name: "draftId is a number", over: { draftId: 7 }, file: "7.json" },
		{ name: "draftId with a space", over: { draftId: "draft a" } },
		{ name: "draftId of 65 characters", over: { draftId: "a".repeat(65) } },
		{ name: "draftId that climbs out of the folder", over: { draftId: "../escape" }, file: "escape.json" },
		{ name: "nonce missing", over: { nonce: undefined } },
		{ name: "nonce in capitals", over: { nonce: "A".repeat(32) } },
		{ name: "nonce one character short", over: { nonce: "a".repeat(31) } },
		{ name: "nonce one character long", over: { nonce: "a".repeat(33) } },
		{ name: "nonce that is a path out of the folder", over: { nonce: "..".padEnd(31, "/") + "a" } },
		{ name: "approvedAt is a number", over: { approvedAt: T0 } },
		{ name: "approvedAt does not parse", over: { approvedAt: "yesterday" } },
		{ name: "expiresAt missing", over: { expiresAt: undefined } },
		{ name: "expiresAt does not parse", over: { expiresAt: "soon" } },
		{ name: "expiresAt equal to approvedAt", over: { expiresAt: iso(T0) } },
		{ name: "expiresAt before approvedAt", over: { expiresAt: iso(T0 - HOUR) } },
		{ name: "a span of 24 hours and a millisecond", over: { expiresAt: iso(T0 + 24 * HOUR + 1) } },
	];

	async function write(dir: string, row: (typeof MALFORMED)[number], index: number): Promise<void> {
		if (row.body !== undefined) {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, row.file ?? `bad-${index}.json`), row.body);
			return;
		}
		await approve(dir, POST, { draftId: `bad-${index}`, ...row.over }, row.file);
	}

	test("each malformed entry is ignored, not thrown on: require and consume both say no approval covers the post", async () => {
		for (const [index, row] of MALFORMED.entries()) {
			const dir = await folder();
			await write(dir, row, index);
			const approvals = approvalsIn(dir);

			const fromRequire = await refusal(() => approvals.require(POST, "park"));
			const fromConsume = await refusal(() => approvals.consume(POST, "confirm"));

			expect({ name: row.name, fromRequire, fromConsume }).toEqual({
				name: row.name,
				fromRequire: expect.stringContaining(NO_APPROVAL),
				fromConsume: expect.stringContaining(NO_APPROVAL),
			});
			expect({ name: row.name, markers: await markers(dir) }).toEqual({ name: row.name, markers: [] });
		}
	});

	test("a span of exactly 24 hours is still an approval", async () => {
		const dir = await folder();
		await approve(dir, POST, { expiresAt: iso(T0 + 24 * HOUR) });

		await expect(approvalsIn(dir).require(POST, "park")).resolves.toBeUndefined();
	});

	test("every malformed entry beside a good approval neither hides it nor stops it being spent", async () => {
		const dir = await folder();
		for (const [index, row] of MALFORMED.entries()) await write(dir, row, index);
		const { draftId } = await approve(dir, POST, { draftId: "the-good-one" });
		const approvals = approvalsIn(dir);

		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();
		expect((await approvals.consume(POST, "confirm")).draftId).toBe(draftId);
	});

	test("an approval is the file named for its own draft: another name, a copy, or a leftover is nothing", async () => {
		const wrongName: Array<{ name: string; file: string }> = [
			{ name: "named for another draft", file: "draft-b.json" },
			{ name: "a copy of the approval", file: "copy-of-draft-a.json" },
			{ name: "a dotted twin", file: "draft-a.bak.json" },
			{ name: "a temp leftover", file: "draft-a.json.tmp" },
			{ name: "no extension", file: "draft-a" },
			{ name: "upper-case extension", file: "draft-a.JSON" },
		];
		for (const row of wrongName) {
			const dir = await folder();
			await approve(dir, POST, { draftId: "draft-a" }, row.file);

			const message = await refusal(() => approvalsIn(dir).require(POST, "park"));

			expect({ name: row.name, message }).toEqual({ name: row.name, message: expect.stringContaining(NO_APPROVAL) });
		}
		const dir = await folder();
		await approve(dir, POST, { draftId: "draft-a" }, "draft-a.json");
		await expect(approvalsIn(dir).require(POST, "park")).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// consume: the one-shot spend
// ---------------------------------------------------------------------------

describe("consume", () => {
	test("under 8 concurrent spends of one approval exactly one resolves, the other seven are refused 'already used', and one marker exists", async () => {
		const dir = await folder();
		const { nonce: spentNonce } = await approve(dir, POST);
		const approvals = approvalsIn(dir);

		const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => approvals.consume(POST, "confirm")));

		const spent = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		expect({ spent: spent.length, refused: refused.length }).toEqual({ spent: 1, refused: 7 });
		for (const outcome of refused) {
			expect(outcome.reason).toBeInstanceOf(BrowserRuntimeError);
			expect((outcome.reason as BrowserRuntimeError).code).toBe("publish_unapproved");
			expect((outcome.reason as BrowserRuntimeError).message).toContain("already used");
		}
		expect(await markers(dir)).toEqual([`draft-a.${spentNonce}.used`]);
	});

	test("a marker that appears after the check and before this spend's own create refuses 'already used' and is left alone", async () => {
		const dir = await folder();
		const { nonce: spentNonce } = await approve(dir, POST);
		const marker = join(dir, `draft-a.${spentNonce}.used`);
		// The clock is read after the folder is listed and before the marker is created: the moment a rival spender gets in.
		const approvals = new PublishApprovals(dir, () => {
			writeFileSync(marker, "");
			return now;
		});

		const message = await refusal(() => approvals.consume(POST, "confirm"));

		expect(message).toContain("already used");
		expect(await markers(dir)).toEqual([`draft-a.${spentNonce}.used`]);
	});

	test("release() gives the approval back, once: spendable again, then spent again", async () => {
		const dir = await folder();
		await approve(dir, POST);
		const approvals = approvalsIn(dir);
		const first = await approvals.consume(POST, "confirm");
		expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain("already used");

		await first.release();

		expect(await markers(dir)).toEqual([]);
		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();
		const second = await approvals.consume(POST, "confirm");
		expect(second.draftId).toBe("draft-a");
		expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain("already used");
		expect(await markers(dir)).toHaveLength(1);
	});

	test("approving the same draft again (a fresh nonce) is spendable although the old nonce's marker exists", async () => {
		const dir = await folder();
		const first = await approve(dir, POST, { draftId: "draft-a" });
		const approvals = approvalsIn(dir);
		await approvals.consume(POST, "confirm");
		expect(await refusal(() => approvals.require(POST, "park"))).toContain("already used");

		const again = await approve(dir, POST, { draftId: "draft-a" });
		expect(again.nonce).not.toBe(first.nonce);

		await expect(approvals.require(POST, "park")).resolves.toBeUndefined();
		await approvals.consume(POST, "confirm");
		expect(await markers(dir)).toEqual([`draft-a.${first.nonce}.used`, `draft-a.${again.nonce}.used`].sort());
		expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain("already used");
	});

	test("two drafts approved with the same post are two independent spends", async () => {
		const dir = await folder();
		await approve(dir, POST, { draftId: "draft-a" });
		await approve(dir, POST, { draftId: "draft-b" });
		const approvals = approvalsIn(dir);

		const spends = [await approvals.consume(POST, "confirm"), await approvals.consume(POST, "confirm")];

		expect(spends.map((spend) => spend.draftId).sort()).toEqual(["draft-a", "draft-b"]);
		expect(await markers(dir)).toHaveLength(2);
		expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain("already used");
		// Giving one back frees exactly one more spend.
		await spends[0]?.release();
		await approvals.consume(POST, "confirm");
		expect(await refusal(() => approvals.consume(POST, "confirm"))).toContain("already used");
	});
});

// ---------------------------------------------------------------------------
// The words the model acts on
// ---------------------------------------------------------------------------

describe("refusal wording by stage", () => {
	/** Everything before the closing "Nothing was ..." sentence, and the sentence. */
	const split = (message: string): { head: string; closing: string } => {
		const at = message.lastIndexOf(" Nothing was ");
		expect(at).toBeGreaterThan(0);
		return { head: message.slice(0, at), closing: message.slice(at + 1) };
	};

	test("park and confirm refusals differ only in the closing sentence: park says nothing was typed, confirm says the publish is still pending", async () => {
		const states: Array<{ name: string; prepare: (dir: string) => Promise<void> }> = [
			{ name: "no approval", prepare: async () => undefined },
			{
				name: "expired",
				prepare: async (dir) => {
					await approve(dir, POST);
					now = T0 + 2 * HOUR;
				},
			},
			{
				name: "already used",
				prepare: async (dir) => {
					await approve(dir, POST);
					await approvalsIn(dir).consume(POST, "confirm");
				},
			},
		];
		for (const state of states) {
			const dir = await folder();
			now = T0 + 1_000;
			await state.prepare(dir);
			const approvals = approvalsIn(dir);

			const park = split(await refusal(() => approvals.require(POST, "park")));
			const confirm = split(await refusal(() => approvals.require(POST, "confirm")));

			expect({ state: state.name, sameHead: park.head === confirm.head }).toEqual({ state: state.name, sameHead: true });
			expect(park.closing).toContain("typed");
			expect(park.closing).not.toContain("pending");
			expect(confirm.closing).toContain("still pending");
			expect(confirm.closing).toContain("browser_publish_cancel");
			// consume words its refusal by the same stage.
			expect(split(await refusal(() => approvals.consume(POST, "confirm"))).closing).toBe(confirm.closing);
		}
	});
});
