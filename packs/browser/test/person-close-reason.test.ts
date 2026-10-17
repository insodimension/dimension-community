import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const GONE = "unknown or already closed browserId";
const NEVER_OPENED_ID = "never-opened-by-anyone-0123456789abcdef";
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

interface Who {
	caller: "model" | "app";
	session: string;
}
const CHAT_A: Who = { caller: "model", session: "chat-a" };
const CHAT_B: Who = { caller: "model", session: "chat-b" };
const PERSON_IN_A: Who = { caller: "app", session: "chat-a" };
const PERSON_ALONE: Who = { caller: "app", session: "view-only" };

const OpenedSchema = z.object({ browserId: z.string() }).passthrough();

interface Rig {
	call(name: string, args: Record<string, unknown>, who: Who): Promise<ToolResult>;
}

async function rig(): Promise<Rig> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "person-close-reason-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return {
		call: async (name, args, who) =>
			(await client.callTool({
				name,
				arguments: args,
				_meta: { [CALLER]: who.caller, [SESSION]: { sessionId: who.session } },
			})) as ToolResult,
	};
}

function openedId(result: ToolResult): string {
	if (result.isError) throw new Error(`the open failed: ${textOf(result)}`);
	return OpenedSchema.parse(result.structuredContent).browserId;
}

function learnedId(result: ToolResult): string {
	if (result.isError) throw new Error(`the state read failed: ${textOf(result)}`);
	return OpenedSchema.parse(result.structuredContent).browserId;
}

function refusal(result: ToolResult): string {
	if (!result.isError) throw new Error(`expected a refusal, got: ${textOf(result).slice(0, 200)}`);
	return textOf(result);
}

function closeAnswer(result: ToolResult): unknown {
	if (result.isError) throw new Error(`the close was refused: ${textOf(result)}`);
	return result.structuredContent;
}

function reasonGiven(result: ToolResult): string {
	const text = refusal(result);
	expect(text).toStartWith(`${GONE}: `);
	return text.slice(GONE.length + 2);
}

function expectToldPersonClosedIt(reason: string, reopenTool: string): void {
	expect(reason).toMatch(/person/i);
	expect(reason).toMatch(/closed/i);
	expect(reason).toContain(`open it again with ${reopenTool}`);
}

const stateOn = (r: Rig, who: Who, browserId: string): Promise<ToolResult> => r.call("browser_state", { browserId }, who);
const actOn = (r: Rig, who: Who, browserId: string): Promise<ToolResult> => r.call("browser_act", { browserId, actions: [{ kind: "reload" }] }, who);

describeWithChrome("what a chat is told when the person closes its browser in the Browser View", () => {
	test(
		"both chats on one saved-profile browser are told the person closed it and how to open it again, on state and on act",
		async () => {
			const r = await rig();
			const browserId = openedId(await r.call("browser_open", { profile: "shared-a" }, CHAT_A));
			expect(openedId(await r.call("browser_open", { profile: "shared-a" }, CHAT_B))).toBe(browserId);

			expect(closeAnswer(await r.call("browser_close", { browserId }, PERSON_IN_A))).toEqual({ closed: true });

			for (const chat of [CHAT_A, CHAT_B]) {
				expectToldPersonClosedIt(reasonGiven(await stateOn(r, chat, browserId)), "browser_open");
				expectToldPersonClosedIt(reasonGiven(await actOn(r, chat, browserId)), "browser_open");
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a chat's throwaway the person viewed and then closed is refused with a reason that names the person",
		async () => {
			const r = await rig();
			const browserId = openedId(await r.call("browser_open", {}, CHAT_A));
			expect((await r.call("browser_view", { browserId }, PERSON_IN_A)).isError).toBeFalsy();

			expect(closeAnswer(await r.call("browser_close", { browserId }, PERSON_IN_A))).toEqual({ closed: true });

			expectToldPersonClosedIt(reasonGiven(await stateOn(r, CHAT_A, browserId)), "browser_open");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a chat that only read the person's browser through the View, never opening or joining it, is told the person closed it",
		async () => {
			const r = await rig();
			const shown = openedId(await r.call("browser_view", {}, PERSON_IN_A));
			const browserId = learnedId(await r.call("browser_state", {}, CHAT_A));
			expect(browserId).toBe(shown);

			expect(closeAnswer(await r.call("browser_close", { browserId }, PERSON_IN_A))).toEqual({ closed: true });

			expectToldPersonClosedIt(reasonGiven(await stateOn(r, CHAT_A, browserId)), "browser_view");
			expectToldPersonClosedIt(reasonGiven(await actOn(r, CHAT_A, browserId)), "browser_view");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("closes that already answer well and must keep answering the same", () => {
	test(
		"a chat closing its own last hold ends the browser and answers closed: true",
		async () => {
			const r = await rig();
			const browserId = openedId(await r.call("browser_open", {}, CHAT_A));

			expect(closeAnswer(await r.call("browser_close", { browserId }, CHAT_A))).toEqual({ closed: true });

			expect(refusal(await stateOn(r, CHAT_A, browserId))).toStartWith(GONE);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an id that never existed is refused with no reason, even after the person closed a different browser with one",
		async () => {
			const r = await rig();
			const other = openedId(await r.call("browser_open", {}, CHAT_A));
			expect(closeAnswer(await r.call("browser_close", { browserId: other }, PERSON_IN_A))).toEqual({ closed: true });

			expect(refusal(await stateOn(r, CHAT_A, NEVER_OPENED_ID))).toBe(GONE);
			expect(refusal(await actOn(r, CHAT_A, NEVER_OPENED_ID))).toBe(GONE);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the person closing the same browser twice answers closed: true both times, and the id stays refused after",
		async () => {
			const r = await rig();
			const browserId = openedId(await r.call("browser_view", {}, PERSON_ALONE));

			expect(closeAnswer(await r.call("browser_close", { browserId }, PERSON_ALONE))).toEqual({ closed: true });
			expect(closeAnswer(await r.call("browser_close", { browserId }, PERSON_ALONE))).toEqual({ closed: true });

			expect(refusal(await stateOn(r, PERSON_ALONE, browserId))).toStartWith(GONE);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
