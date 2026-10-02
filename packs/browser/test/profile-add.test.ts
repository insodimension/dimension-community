/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: "Add profile" in the Browser
 *  View makes a profile nobody can use or one that should never exist — a name
 *  that is a path writes outside the profiles folder (`../evil`), a Windows
 *  device name (`con`, `nul`) becomes a folder Windows will not create, a
 *  second "Work" derives the folder of the first and signs the person into the
 *  wrong account, `default` or `relay` is shadowed by a new profile, a refused
 *  name still leaves a half-made folder behind, two clicks on Add make two
 *  profiles, the View offers an avatar the server then refuses, an agent is
 *  sent the person's avatar, or an agent told "use the Work Account profile"
 *  cannot open what the person just made.
 *
 *  The shared rule (`checkNewProfile`) is pure and tested as a table; what a
 *  consumer sees is tested through `addProfile` over real temp folders and
 *  through the real MCP server over an in-memory transport, as a host reaches
 *  it. Chrome only where a browser has to be opened by the new profile's label.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { ProfileListing } from "../src/contracts";
import { MAX_PROFILES_FOR_MODEL, profilesForModel } from "../src/profile-list";
import { AVATAR_CHOICES } from "../src/profile-look";
import { checkNewProfile, MAX_LABEL_CHARS, PROFILE_COLOURS } from "../src/profile-meta";
import { PROFILE_NAME } from "../src/profile-name";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BrowserRuntimeError, MAX_PROFILES, ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, newRuntime, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("");
/** The marker a host reads off a tool to leave it out of a model's list: `visibility: ["app"]`. */
const ToolMeta = z.object({ ui: z.object({ visibility: z.array(z.string()).optional() }).optional() });

interface Who {
	caller: "model" | "app";
	session?: string;
}
const VIEW: Who = { caller: "app", session: "s-view" };
const MODEL: Who = { caller: "model", session: "s-chat" };

/** The real MCP server over `runtime`, reached the way a host reaches it. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<{ client: Client; call: (name: string, args: Record<string, unknown>, who?: Who) => Promise<ToolResult> }> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "profile-add-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call = async (name: string, args: Record<string, unknown>, who?: Who): Promise<ToolResult> =>
		(await client.callTool({
			name,
			arguments: args,
			...(who === undefined ? {} : { _meta: { [CALLER]: who.caller, ...(who.session === undefined ? {} : { [SESSION]: { sessionId: who.session } }) } }),
		})) as ToolResult;
	return { client, call };
}

/** Everything under the root, so a refusal that wrote a folder anywhere (inside `profiles/` or beside it) shows. */
const tree = async (rootDir: string): Promise<string[]> => (await readdir(rootDir, { recursive: true })).map(String).sort();

/** A fresh runtime on a fresh root; its store reads the same folders from outside. */
async function fresh(seed: (store: ProfileStore) => void = () => undefined): Promise<{ runtime: BrowserRuntime; rootDir: string; store: ProfileStore }> {
	const rootDir = await createRoot();
	const store = new ProfileStore(rootDir);
	seed(store);
	return { runtime: newRuntime(rootDir), rootDir, store };
}

// ---------------------------------------------------------------------------
// The shared rule
// ---------------------------------------------------------------------------

describe("checkNewProfile: the name a person types for a new profile", () => {
	const taken = [
		{ slug: "work-account", label: "Work Account" },
		{ slug: "acme", label: "Acme Corp" },
	];

	test("the label is the person's, tidied; the folder is derived from it and always a valid profile name", () => {
		const rows: Array<{ name: string; typed: string; label: string; slug: string | RegExp }> = [
			{ name: "capitals and a space stay in the label", typed: "Q3 Budget", label: "Q3 Budget", slug: "q3-budget" },
			{ name: "stray whitespace is tidied in the label", typed: "  Q3 \t  Budget\n", label: "Q3 Budget", slug: "q3-budget" },
			{ name: "accents fold away in the folder only", typed: "Café Münchën", label: "Café Münchën", slug: "cafe-munchen" },
			{ name: "punctuation joins words in the folder", typed: "R&D, Ops!", label: "R&D, Ops!", slug: "r-d-ops" },
			{ name: "another script gets a short stable tag", typed: "工作", label: "工作", slug: /^p-[0-9a-z]+$/ },
			{ name: "48 characters is allowed", typed: "a".repeat(MAX_LABEL_CHARS), label: "a".repeat(MAX_LABEL_CHARS), slug: "a".repeat(MAX_LABEL_CHARS) },
			{ name: "a device name with punctuation is a different label, never that folder", typed: "Con!", label: "Con!", slug: /^p-[0-9a-z]+$/ },
			{ name: "the relay name with punctuation is a different label, never that folder", typed: "Relay!", label: "Relay!", slug: /^p-[0-9a-z]+$/ },
			{ name: "names that only look like reserved ones are fine", typed: "Console 2", label: "Console 2", slug: "console-2" },
			{ name: "com10 is not a device name", typed: "com10", label: "com10", slug: "com10" },
			{ name: "relay-2 is not the relay", typed: "relay-2", label: "relay-2", slug: "relay-2" },
			{ name: "Defaults is not default", typed: "Defaults", label: "Defaults", slug: "defaults" },
		];
		for (const row of rows) {
			const check = checkNewProfile(row.typed, taken);
			expect({ name: row.name, ok: check.ok }).toEqual({ name: row.name, ok: true });
			if (!check.ok) continue;
			expect({ name: row.name, label: check.label }).toEqual({ name: row.name, label: row.label });
			if (typeof row.slug === "string") expect({ name: row.name, slug: check.slug }).toEqual({ name: row.name, slug: row.slug });
			else expect({ name: row.name, slug: row.slug.test(check.slug) }).toEqual({ name: row.name, slug: true });
			expect({ name: row.name, valid: PROFILE_NAME.test(check.slug) }).toEqual({ name: row.name, valid: true });
		}
	});

	// 96 UTF-16 units but 48 characters: counted as characters, as the 49th is refused (below).
	test("48 characters outside the BMP is allowed, and a name of 25 such characters is not mistaken for an empty one", () => {
		const full = checkNewProfile("𝒜".repeat(MAX_LABEL_CHARS), []);
		expect(full).toEqual({ ok: true, slug: "a".repeat(MAX_LABEL_CHARS), label: "𝒜".repeat(MAX_LABEL_CHARS) });
		const emoji = checkNewProfile(`${"🚀".repeat(24)}a`, []);
		expect(emoji.ok).toBe(true);
	});

	test("nothing that could be a path, a duplicate, empty, over long or reserved passes, and every refusal says why", () => {
		const unsafe = [...'\\/:*?"<>|'].map((char) => ({ name: `a path character ${char}`, typed: `a${char}b` }));
		const rows: Array<{ name: string; typed: string }> = [
			{ name: "empty", typed: "" },
			{ name: "only spaces", typed: "   " },
			{ name: "only a tab and a newline", typed: "\t\n" },
			{ name: "the same label in another case and spacing", typed: "  work   ACCOUNT " },
			{ name: "the same label exactly", typed: "Work Account" },
			{ name: "the folder name of an existing profile", typed: "acme" },
			{ name: "the folder name of an existing profile, in capitals", typed: "WORK-ACCOUNT" },
			{ name: "the implicit default profile, which has no folder yet", typed: "Default" },
			{ name: "the implicit default profile in lower case", typed: "default" },
			{ name: "the implicit default profile with padding", typed: " DEFAULT " },
			...unsafe,
			{ name: "a parent traversal", typed: "../evil" },
			{ name: "a bare parent", typed: ".." },
			{ name: "a drive", typed: "C:" },
			{ name: "a leading dot", typed: ".hidden" },
			{ name: "a NUL", typed: "bad\u0000name" },
			{ name: "a bell", typed: "bad\u0007name" },
			{ name: "a DEL", typed: "bad\u007fname" },
			{ name: "49 characters", typed: "a".repeat(MAX_LABEL_CHARS + 1) },
			{ name: "49 characters outside the BMP", typed: "𝒜".repeat(MAX_LABEL_CHARS + 1) },
			{ name: "punctuation only", typed: "!!!" },
			{ name: "dashes only", typed: "---" },
			{ name: "an emoji only", typed: "🚀" },
			{ name: "the relay", typed: "relay" },
			{ name: "the relay in capitals with padding", typed: "  RELAY " },
			{ name: "a device name", typed: "CON" },
			{ name: "another device name", typed: "nul" },
			{ name: "a numbered device name", typed: "Com1" },
			{ name: "the last numbered device name", typed: "LPT9" },
		];
		for (const row of rows) {
			const check = checkNewProfile(row.typed, taken);
			expect({ name: row.name, ok: check.ok }).toEqual({ name: row.name, ok: false });
			// The View shows the sentence under the field: a refusal with none would leave the person with nothing to fix.
			if (!check.ok) expect({ name: row.name, said: check.problem.trim().length > 0 }).toEqual({ name: row.name, said: true });
		}
	});

	test("added one after another, every folder is unique and valid, taken ones get -2, -3 …, and no label repeats", () => {
		// 23 + 1 + 24 = 48 characters whose folder is also 48: a clash must still leave a valid folder name.
		const near = `${"a".repeat(23)} ${"b".repeat(24)}`;
		const names = [
			"Work Account", "Work account!", "work_account", "WORK ACCOUNT #4",
			"工作", "工作 2024", "学习 2024", "Café", "Cafe!", "Default 2", "default!", "Relay!", "relay 2", "Con!", "NUL.", "COM1!",
			near, `${"a".repeat(23)},${"b".repeat(24)}`,
		];
		const added: Array<{ slug: string; label: string }> = [];
		for (const name of names) {
			const check = checkNewProfile(name, added);
			expect({ name, ok: check.ok }).toEqual({ name, ok: true });
			if (check.ok) added.push({ slug: check.slug, label: check.label });
		}
		expect(added.slice(0, 4).map((profile) => profile.slug)).toEqual(["work-account", "work-account-2", "work-account-3", "work-account-4"]);
		const slugs = added.map((profile) => profile.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		for (const slug of slugs) {
			expect({ slug, valid: PROFILE_NAME.test(slug) }).toEqual({ slug, valid: true });
			expect({ slug, reserved: ["default", "relay", "con", "nul", "com1"].includes(slug) }).toEqual({ slug, reserved: false });
		}
		const labels = added.map((profile) => profile.label.toLowerCase().replace(/\s+/g, " "));
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("a name in another script gets the same folder every time, and different names get different ones", () => {
		const first = checkNewProfile("工作", []);
		const again = checkNewProfile("工作", taken);
		const other = checkNewProfile("学习", []);
		expect(first.ok && again.ok && other.ok).toBe(true);
		if (!first.ok || !again.ok || !other.ok) return;
		expect(again.slug).toBe(first.slug);
		expect(other.slug).not.toBe(first.slug);
	});

	test("the same letters in another encoding are the same name: composed or decomposed accents, other case, full-width forms", () => {
		const composed = [{ slug: "cafe", label: "Café" }];
		for (const typed of ["Cafe\u0301", "CAFÉ", "Ｃａｆé", "  Cafe\u0301  "]) {
			expect({ typed, ok: checkNewProfile(typed, composed).ok }).toEqual({ typed, ok: false });
		}
		// The other way round: a profile stored decomposed refuses the composed spelling.
		expect(checkNewProfile("Café", [{ slug: "cafe", label: "Cafe\u0301" }]).ok).toBe(false);
		// A different word is still a different name.
		expect(checkNewProfile("Cafés", composed).ok).toBe(true);
	});

	test("a folder the caller knows exists is never the new profile's: the folder name steps past it", () => {
		const check = checkNewProfile("Legacy", [], (slug) => slug === "legacy" || slug === "legacy-2");
		expect(check).toEqual({ ok: true, slug: "legacy-3", label: "Legacy" });
	});
});

// ---------------------------------------------------------------------------
// What the model is sent
// ---------------------------------------------------------------------------

describe("what a model is sent of a profile", () => {
	const listing = (name: string, over: Partial<ProfileListing> = {}): ProfileListing => ({
		name,
		label: name,
		colour: "blue",
		avatar: "💼",
		heldBy: "this chat",
		hold: { by: "agent", task: false, takenOver: true, post: false },
		browserId: "b-1",
		sites: [],
		...over,
	});

	test("the person's avatar, the View's hold detail and a browser id never reach it, and a profile the person took over is the human's — under the cap and over it", () => {
		const keysOf = (profile: object): string[] => Object.keys(profile);
		const under = profilesForModel([listing("work"), listing("idle", { heldBy: null, hold: undefined }), listing("busy", { hold: { by: "person", task: true, takenOver: false, post: false } })]);
		expect(under.profiles.map((profile) => [profile.name, profile.heldBy])).toEqual([["work", "human"], ["idle", null], ["busy", "this chat"]]);
		for (const profile of under.profiles) expect(keysOf(profile)).toEqual(["name", "label", "colour", "heldBy", "sites"]);

		// Over the cap the same mapping holds for the profiles that are kept.
		const many = Array.from({ length: MAX_PROFILES_FOR_MODEL + 5 }, (_, i) => listing(`p-${String(i).padStart(2, "0")}`, { heldBy: null, hold: undefined }));
		many[3] = listing("p-03");
		const over = profilesForModel(many);
		expect(over.omitted).toBe(5);
		const kept = over.profiles.find((profile) => profile.name === "p-03");
		expect(kept?.heldBy).toBe("human");
		for (const profile of over.profiles) expect(keysOf(profile)).toEqual(["name", "label", "colour", "heldBy", "sites"]);
	});
});

// ---------------------------------------------------------------------------
// What a consumer sees of addProfile
// ---------------------------------------------------------------------------

describe("addProfile", () => {
	test("a good name makes the folder, saves what was chosen, answers the listing, and is still there after a restart", async () => {
		const { runtime, rootDir, store } = await fresh();
		const added = await runtime.addProfile({ name: "  Work   Account ", colour: "teal", avatar: "💼" }, "app");

		expect(added).toEqual({ name: "work-account", label: "Work Account", colour: "teal", avatar: "💼", heldBy: null, sites: [] });
		expect(existsSync(join(rootDir, "profiles", "work-account"))).toBe(true);
		expect(JSON.parse(readFileSync(join(rootDir, "profiles", "work-account", "profile.json"), "utf8"))).toMatchObject({ label: "Work Account", colour: "teal", avatar: "💼" });
		expect(store.list()).toEqual(["work-account"]);
		expect(await runtime.profileList()).toEqual([added]);
		// Another server on the same folder (a restart) lists it the same.
		expect(await newRuntime(rootDir).profileList()).toEqual([added]);
	});

	test("a profile added with no colour and no avatar has a colour from the palette and no avatar key", async () => {
		const { runtime } = await fresh();
		const added = await runtime.addProfile({ name: "Plain" }, "app");
		expect(PROFILE_COLOURS).toContain(added.colour);
		expect("avatar" in added).toBe(false);
	});

	test("a second name that derives the same folder is allowed and gets -2; both are listed", async () => {
		const { runtime, rootDir } = await fresh();
		const first = await runtime.addProfile({ name: "Work Account" }, "app");
		const second = await runtime.addProfile({ name: "Work account!" }, "app");

		expect([first.name, second.name]).toEqual(["work-account", "work-account-2"]);
		expect([first.label, second.label]).toEqual(["Work Account", "Work account!"]);
		expect((await runtime.profileList()).map((profile) => profile.name)).toEqual(["work-account", "work-account-2"]);
		expect(await readdir(join(rootDir, "profiles"))).toEqual(["work-account", "work-account-2"]);
	});

	test("a name in another script gets a valid folder, the same on a fresh root", async () => {
		const first = await (await fresh()).runtime.addProfile({ name: "工作" }, "app");
		const again = await (await fresh()).runtime.addProfile({ name: "工作" }, "app");
		expect(first.label).toBe("工作");
		expect(PROFILE_NAME.test(first.name)).toBe(true);
		expect(again.name).toBe(first.name);
	});

	test("two adds of one name at once make one profile; the other is refused", async () => {
		const { runtime, store } = await fresh();
		const settled = await Promise.allSettled([runtime.addProfile({ name: "Twin" }, "app"), runtime.addProfile({ name: "twin" }, "app")]);
		expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const refused = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		expect(refused).toHaveLength(1);
		expect(refused[0]?.reason).toBeInstanceOf(BrowserRuntimeError);
		expect(refused[0]?.reason instanceof BrowserRuntimeError ? refused[0].reason.code : undefined).toBe("bad_profile_name");
		expect(store.list()).toEqual(["twin"]);
	});

	test("every avatar the View offers is accepted, and so is a ZWJ emoji", async () => {
		const { runtime } = await fresh();
		for (const [index, avatar] of [...AVATAR_CHOICES, "👨‍💻"].entries()) {
			const added = await runtime.addProfile({ name: `Profile ${index}`, avatar }, "app");
			expect({ avatar, saved: added.avatar }).toEqual({ avatar, saved: avatar });
		}
	});

	test("a refused name is bad_profile_name and creates nothing, anywhere under the root", async () => {
		const { runtime, rootDir, store } = await fresh((seed) => {
			seed.saveMeta("work-account", { label: "Work Account" });
			seed.ensureProfile("legacy");
		});
		const before = await tree(rootDir);
		const listed = store.list();
		const refused = [
			"", "   ", "work   ACCOUNT", "WORK-ACCOUNT", "legacy", "Legacy",
			"default", "relay", "CON", "nul", "../evil", "..\\evil", "a/b", "C:", "..", ".hidden", "bad\u0000name", "bad\nname\u0007",
			"a".repeat(MAX_LABEL_CHARS + 1), "!!!",
		];
		for (const name of refused) {
			expect({ name, code: await failureCode(() => runtime.addProfile({ name }, "app")) }).toEqual({ name, code: "bad_profile_name" });
			expect({ name, same: JSON.stringify(await tree(rootDir)) === JSON.stringify(before) }).toEqual({ name, same: true });
			expect({ name, list: store.list() }).toEqual({ name, list: listed });
		}
		expect(existsSync(join(rootDir, "evil"))).toBe(false);
	});

	test("a colour outside the eight, or an avatar that is not one emoji, is bad_profile and creates nothing", async () => {
		const { runtime, rootDir } = await fresh();
		const before = await tree(rootDir);
		const refused: Array<{ name: string; request: { name: string; colour?: never; avatar?: string } | { name: string; colour: string } }> = [
			{ name: "an unknown colour", request: { name: "Fine", colour: "chartreuse" } },
			{ name: "letters", request: { name: "Fine", avatar: "abc" } },
			{ name: "an empty avatar", request: { name: "Fine", avatar: "" } },
			{ name: "two emoji", request: { name: "Fine", avatar: "💼💼" } },
			{ name: "an emoji and a letter", request: { name: "Fine", avatar: "💼a" } },
		];
		for (const row of refused) {
			// Reason: the request is deliberately outside the port's types, as a client's input can be.
			const code = await failureCode(() => runtime.addProfile(row.request as never, "app"));
			expect({ name: row.name, code }).toEqual({ name: row.name, code: "bad_profile" });
			expect({ name: row.name, same: JSON.stringify(await tree(rootDir)) === JSON.stringify(before) }).toEqual({ name: row.name, same: true });
		}
		// The same name is still free: nothing of the refused attempts was kept.
		expect((await runtime.addProfile({ name: "Fine" }, "app")).name).toBe("fine");
	});

	test("past the cap nothing more is made: add and an agent's new name are too_many_profiles, and a folder the listing no longer shows is never relabelled", async () => {
		const { runtime, rootDir, store } = await fresh((seed) => {
			for (let i = 0; i < MAX_PROFILES; i += 1) seed.ensureProfile(`p${String(i).padStart(3, "0")}`);
			// Sorts after all 256 listed folders, so the listing does not show it.
			seed.saveMeta("zz-hidden", { label: "Hidden" });
		});
		expect(store.list()).toHaveLength(MAX_PROFILES);
		expect(store.list()).not.toContain("zz-hidden");
		const before = await tree(rootDir);

		expect(await failureCode(() => runtime.addProfile({ name: "One More" }, "app"))).toBe("too_many_profiles");
		// The name of the folder that is past the listing: refused, not merged into that profile's label.
		expect(await failureCode(() => runtime.addProfile({ name: "zz-hidden" }, "app"))).toBe("too_many_profiles");
		expect(await failureCode(() => runtime.open({ profile: "brand-new" }))).toBe("too_many_profiles");
		expect(await tree(rootDir)).toEqual(before);
		expect(store.meta("zz-hidden").label).toBe("Hidden");
	});

	test("a folder that is not a profile directory is never taken for a free name, and its content is left alone", async () => {
		const { runtime, rootDir } = await fresh();
		await writeFile(join(rootDir, "profiles", "notes"), "mine");
		const added = await runtime.addProfile({ name: "Notes" }, "app");
		expect(added.name).toBe("notes-2");
		expect(readFileSync(join(rootDir, "profiles", "notes"), "utf8")).toBe("mine");
	});
});

// ---------------------------------------------------------------------------
// Over the MCP surface
// ---------------------------------------------------------------------------

describe("browser_profile_add, as a host offers it", () => {
	test("only the View may call it: it is marked app-only, unlike browser_profiles beside it", async () => {
		const { runtime, rootDir } = await fresh();
		const { client } = await connect(runtime, rootDir);
		const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
		const visibility = (name: string): string[] | undefined => ToolMeta.parse(tools.get(name)?._meta ?? {}).ui?.visibility;
		expect(visibility("browser_profile_add")).toEqual(["app"]);
		expect(visibility("browser_profiles")).toBeUndefined();
	});

	test("a model, or a call no host stamped, is refused even where the host does not hide an app-only tool, and nothing is created", async () => {
		const { runtime, rootDir, store } = await fresh();
		const { call } = await connect(runtime, rootDir);
		const before = await tree(rootDir);
		for (const who of [MODEL, undefined]) {
			const refused = await call("browser_profile_add", { name: "Sneaky", colour: "teal" }, who);
			expect({ who: who?.caller, isError: refused.isError }).toEqual({ who: who?.caller, isError: true });
			expect(textOf(refused)).toContain("person in the View");
		}
		expect(await failureCode(() => runtime.addProfile({ name: "Sneaky" }))).toBe("human_only");
		expect(await failureCode(() => runtime.addProfile({ name: "Sneaky" }, "model"))).toBe("human_only");
		expect(await tree(rootDir)).toEqual(before);
		expect(store.list()).toEqual([]);
		// The View still can.
		expect((await call("browser_profile_add", { name: "Sneaky" }, VIEW)).isError).toBeFalsy();
	});

	test("the View is answered the new profile; a refused name is an error whose text is the sentence the View shows, and nothing is created", async () => {
		const { runtime, rootDir } = await fresh();
		const { call } = await connect(runtime, rootDir);

		const added = await call("browser_profile_add", { name: "Work Account", colour: "teal", avatar: "💼" }, VIEW);
		expect(added.isError).toBeFalsy();
		expect(added.structuredContent).toEqual({ profile: { name: "work-account", label: "Work Account", colour: "teal", avatar: "💼", heldBy: null, sites: [] } });

		const before = await tree(rootDir);
		for (const name of ["work   ACCOUNT", "../evil", "default", ""]) {
			const refused = await call("browser_profile_add", { name }, VIEW);
			expect({ name, isError: refused.isError }).toEqual({ name, isError: true });
			const sentence = checkNewProfile(name, [{ slug: "work-account", label: "Work Account" }]);
			expect({ name, text: textOf(refused) }).toEqual({ name, text: sentence.ok ? "" : sentence.problem });
		}
		expect(await tree(rootDir)).toEqual(before);
	});

	test("the person's profile reaches the View with its avatar and a model without it", async () => {
		const { runtime, rootDir } = await fresh();
		const { call } = await connect(runtime, rootDir);
		await call("browser_profile_add", { name: "Work Account", colour: "teal", avatar: "💼" }, VIEW);

		const asView = await call("browser_profiles", {}, VIEW);
		expect(asView.structuredContent).toEqual({ profiles: [{ name: "work-account", label: "Work Account", colour: "teal", avatar: "💼", heldBy: null, sites: [] }] });

		const asModel = await call("browser_profiles", {}, MODEL);
		expect(asModel.structuredContent).toBeUndefined();
		const sent = JSON.parse(textOf(asModel)) as { profiles: Array<Record<string, unknown>> };
		expect(sent.profiles).toEqual([{ name: "work-account", label: "Work Account", colour: "teal", heldBy: null, sites: [] }]);
		expect(Object.keys(sent.profiles[0] ?? {})).toEqual(["name", "label", "colour", "heldBy", "sites"]);
		expect(textOf(asModel)).not.toContain("💼");
	});
});

describeWithChrome("a profile the person just made", () => {
	test(
		"an agent opens it by the label it was shown as, in any case, and the folder keeps its slug",
		async () => {
			const { runtime, rootDir, store } = await fresh();
			await runtime.addProfile({ name: "Work Account", colour: "teal", avatar: "💼" }, "app");
			await runtime.addProfile({ name: "Work account!" }, "app");

			const first = await runtime.open({ profile: "  work ACCOUNT " });
			expect(first.profile).toBe("work-account");
			// The View draws the profile as the person made it.
			expect(first.look).toEqual({ label: "Work Account", colour: "teal", avatar: "💼" });
			const second = await runtime.open({ profile: "work account!" });
			expect(second.profile).toBe("work-account-2");
			// Opening made no new profile, and kept what the person chose.
			expect(store.list()).toEqual(["work-account", "work-account-2"]);
			expect(existsSync(join(rootDir, "profiles", "work-account", "chrome"))).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
