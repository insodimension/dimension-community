// Public, unretractable X writes (post, thread, DM, delete) must stop for a human
// click in EVERY approval mode, yolo included — a bare "write" tier is
// auto-approved there. The gate is decided by the engine's own `resolveApproval`
// (the pack's `@oh-my-pi/pi-coding-agent` peer), fed the tool exactly as the
// default-exported factory registers it. The approval card is what the human
// reads before clicking, so it must carry everything that goes out, verbatim.
//
// `CONFIG_TARGET` is derived from `homedir()` at module load, so HOME is pointed
// at a temp dir around the dynamic import only: the account tests swap the
// stored credential there and stub `fetch`, never touching the real token.

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";

const home = await mkdtemp(join(tmpdir(), "dimension-x-approval-"));
const tokenDir = join(home, ".config", "dimension-x");
await mkdir(tokenDir, { recursive: true });
const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
// Dynamic on purpose: a static import is hoisted above the HOME override.
const { default: xExtension } = await import("../index");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

/** Store a credential for one account. Both accounts share the OAuth app. */
async function connect(access: string, refresh: string): Promise<void> {
	await writeFile(
		join(tokenDir, "token.json"),
		JSON.stringify({ access, refresh, expires: Date.now() + 3_600_000, clientId: "shared-app" }),
	);
}

/** Stub X: /users/me answers as `username`; every POST /tweets is recorded. */
function stubX(username: string, posted: unknown[] = []): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/users/me")) return Response.json({ data: { id: "42", username } });
		if (url.endsWith("/tweets")) {
			posted.push(JSON.parse(String(init?.body)));
			return Response.json({ data: { id: "1790000000000000009", text: "x" } });
		}
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;
}

interface RegisteredTool {
	name: string;
	approval?: unknown;
	formatApprovalDetails?: (args: unknown) => string[];
	execute?: (id: string, params: unknown) => Promise<unknown>;
}

type Session = Map<string, RegisteredTool>;

function loadSession(): Session {
	const session: Session = new Map();
	xExtension({
		registerTool(tool: RegisteredTool) {
			session.set(tool.name, tool);
		},
	} as unknown as Parameters<typeof xExtension>[0]);
	return session;
}

const tools = loadSession();

function tool(name: string, session: Session = tools): RegisteredTool {
	const found = session.get(name);
	if (!found) throw new Error(`x extension did not register ${name}`);
	return found;
}

function card(name: string, args: unknown, session: Session = tools): string {
	const format = tool(name, session).formatApprovalDetails;
	if (!format) throw new Error(`${name} has no approval card`);
	return format(args).join("\n");
}

const yolo = (name: string, args: unknown) =>
	resolveApproval(tool(name) as Parameters<typeof resolveApproval>[0], args, "yolo").policy;

test("publishing, deleting and DMing prompt the human even in yolo mode", () => {
	expect(yolo("x_post", { text: "shipping today" })).toBe("prompt");
	expect(yolo("x_post", { text: "agreed", replyTo: "1790000000000000000" })).toBe("prompt");
	expect(yolo("x_thread", { posts: ["one", "two"] })).toBe("prompt");
	expect(yolo("x_dm", { username: "@someone", text: "hi" })).toBe("prompt");
	expect(yolo("x_delete", { post: "1790000000000000000" })).toBe("prompt");
});

test("a private bookmark stays auto-approved in yolo mode", () => {
	expect(yolo("x_bookmark", { post: "1790000000000000000" })).toBe("allow");
});

test("the x_post card shows the whole text, untruncated, and the post it replies to", () => {
	const text = `${"long form update, every word matters. ".repeat(10)}END-OF-POST`;
	expect(text.length).toBeGreaterThan(280);
	const shown = card("x_post", { text, replyTo: "https://x.com/someone/status/1790000000000000001" });
	expect(shown).toContain(text);
	expect(shown).toContain("1790000000000000001");
});

test("the x_thread card lists every post, in publishing order", () => {
	const posts = ["first: the setup", "second: the turn", "third: the payoff"];
	const shown = card("x_thread", { posts });
	const positions = posts.map(post => shown.indexOf(post));
	expect(positions.every(at => at >= 0)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("the x_dm card names the recipient and carries the full message", () => {
	const shown = card("x_dm", { username: "@recipient_handle", text: "the exact private message body" });
	expect(shown).toContain("@recipient_handle");
	expect(shown).toContain("the exact private message body");
});

test("malformed args still render a card instead of throwing", () => {
	for (const name of ["x_post", "x_thread", "x_dm", "x_delete"]) {
		for (const args of [undefined, 42, { text: 7 }, { posts: [1, null] }]) {
			expect(card(name, args)).toContain("As:");
		}
	}
});

test("the card names the handle only for the account whose credential is connected now", async () => {
	await connect("access-alice", "refresh-alice");
	stubX("alice");
	await tool("x_me").execute?.("call-1", {});
	expect(card("x_post", { text: "hi" })).toContain("As: @alice");

	// Reconnected as another account through the same OAuth app.
	await connect("access-brand", "refresh-brand");
	const shown = card("x_post", { text: "hi" });
	expect(shown).not.toContain("@alice");
	expect(shown).toContain("As: the connected X account");
});

test("an empty or blank replyTo is no reply target: the card and the post both go top-level", async () => {
	await connect("access-alice", "refresh-alice");
	for (const replyTo of ["", "   "]) {
		const shown = card("x_post", { text: "top level", replyTo });
		expect(shown).not.toContain("Reply to");
		const posted: unknown[] = [];
		stubX("alice", posted);
		await tool("x_post").execute?.("call-2", { text: "top level", replyTo });
		expect(posted).toEqual([{ text: "top level" }]);
	}
});

function countLookups(): string[] {
	const lookups: string[] = [];
	const stubbed = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("/users/me")) lookups.push(String(input));
		return stubbed(input, init);
	}) as typeof fetch;
	return lookups;
}

test("sessions share one account lookup: the handle one session cached names the account in the other's card", async () => {
	await connect("access-carol", "refresh-carol");
	stubX("carol");
	const lookups = countLookups();
	const first = loadSession();
	const second = loadSession();

	await tool("x_me", first).execute?.("call-a", {});
	await tool("x_me", second).execute?.("call-b", {});

	expect(lookups).toHaveLength(1);
	expect(card("x_post", { text: "hi" }, first)).toContain("As: @carol");
	expect(card("x_post", { text: "hi" }, second)).toContain("As: @carol");
});

test("a reconnect as another account drops the old handle in every session at once", async () => {
	await connect("access-erin", "refresh-erin");
	stubX("erin");
	const first = loadSession();
	const second = loadSession();
	await tool("x_me", first).execute?.("call-a", {});

	await connect("access-frank", "refresh-frank");
	stubX("frank");
	const lookups = countLookups();
	for (const session of [first, second]) {
		const shown = card("x_post", { text: "hi" }, session);
		expect(shown).not.toContain("@erin");
		expect(shown).toContain("As: the connected X account");
	}

	await tool("x_me", second).execute?.("call-b", {});
	expect(lookups).toHaveLength(1);
	expect(card("x_post", { text: "hi" }, first)).toContain("As: @frank");
});

test("every session registers its own tool objects over the same tool surface", () => {
	const first = loadSession();
	const second = loadSession();

	expect([...second.keys()]).toEqual([...first.keys()]);
	expect(first.size).toBe(tools.size);
	for (const [name, registered] of first) expect(second.get(name)).not.toBe(registered);
});
