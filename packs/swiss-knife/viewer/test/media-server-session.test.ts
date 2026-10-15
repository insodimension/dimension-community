import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { request as nodeRequest } from "node:http";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	HOST_CONTEXT_REFERENCE_META_KEY,
	MEDIA_TOKEN_PATTERN,
	RECORDING_SLOT_REFUSAL_FIRST_WORDS,
	SESSION_META_KEY,
} from "../src/contract";
import { createViewerServer } from "../src/server";

const HEAD = Buffer.from([0, 0, 0, 32, ...Buffer.from("ftypisom"), ...new Uint8Array(52)]);
const TAKE_SIZE = HEAD.length + 1024 * 1024;
const HOST_CONTEXT_ENDED = "notifications/ai.insodimension/host-context-ended";
const LEASES_PER_SERVER = 64;
const CALLER_META_KEY = "ai.insodimension/caller";
const GRANT_META_KEY = "ai.insodimension/grant";
const HOST_STAMP_TOKEN = "0".repeat(64);

const recordingSourceSchema = z.object({ token: z.string().regex(MEDIA_TOKEN_PATTERN), mime: z.string().min(1), url: z.string() });
const slotRefusalText = z.string().startsWith(RECORDING_SLOT_REFUSAL_FIRST_WORDS).min(1);

let directory = "";
let takePath = "";
let otherPath = "";
let takeMtimeMs = 0;
let otherMtimeMs = 0;

const refusalText = (answer: CallToolResult): string =>
	slotRefusalText.parse(answer.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));

interface ServerHandle {
	client: Client;
	finish(): Promise<void>;
}

async function connectedServer(session: string): Promise<ServerHandle> {
	const server = await createViewerServer({ home: directory, viewDir: join(import.meta.dir, "..", "app", "dist"), env: {} });
	const client = new Client({ name: "viewer-1863", version: "0.0.0" });
	const [hostTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(hostTransport), client.connect(clientTransport)]);
	const listed = await client.callTool(
		{
			name: "view_file",
			arguments: { path: takePath, size: TAKE_SIZE, mtimeMs: takeMtimeMs },
			_meta: { [CALLER_META_KEY]: "model", [SESSION_META_KEY]: { sessionId: session }, [GRANT_META_KEY]: { read: [takePath, otherPath] }, [HOST_CONTEXT_REFERENCE_META_KEY]: { sessionId: session, token: HOST_STAMP_TOKEN } },
		},
		undefined,
	);
	expect(listed.isError ?? false).toBe(false);
	return {
		client,
		finish: async () => {
			await Promise.allSettled([client.close(), server.close()]);
			clientTransport.close();
			hostTransport.close();
		},
	};
}

const tokenOf = (index: number): string => {
	const low = index % 256;
	const high = Math.floor(index / 256) % 256;
	return [low, high, ...Array.from({ length: 22 }, (_, position) => (position + 1) * 11)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const GET = (url: string): Promise<number> =>
	new Promise((resolve, reject) => {
		const answer = nodeRequest(url, { method: "HEAD" });
		answer.end();
		answer.once("response", (response: { statusCode: number }) => {
			response.resume();
			resolve(response.statusCode);
		});
		answer.once("error", reject);
	});

const stamp = (session: string): Record<string, unknown> => ({
	[CALLER_META_KEY]: "app",
	[SESSION_META_KEY]: { sessionId: session },
	[GRANT_META_KEY]: { read: [takePath, otherPath] },
	[HOST_CONTEXT_REFERENCE_META_KEY]: { sessionId: session, token: HOST_STAMP_TOKEN },
});

const playerCi = async (client: Client, session: string, path: string, index: number): Promise<CallToolResult> =>
	client.callTool(
		{ name: "open_media", arguments: { path, size: TAKE_SIZE, mtimeMs: path === takePath ? takeMtimeMs : otherMtimeMs, token: tokenOf(index) }, _meta: stamp(session) },
		undefined,
	);

async function holdEverySlot(client: Client, session: string): Promise<CallToolResult[]> {
	const answers: CallToolResult[] = [];
	for (let index = 0; index < LEASES_PER_SERVER; index++) answers.push(await playerCi(client, session, index % 2 === 0 ? takePath : otherPath, index));
	return answers;
}

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "viewer-1863-")));
	takePath = join(directory, "take.mp4");
	otherPath = join(directory, "other.mp4");
	await Promise.all([writeFile(takePath, Buffer.concat([HEAD, Buffer.alloc(1024 * 1024)])), writeFile(otherPath, Buffer.concat([HEAD, Buffer.alloc(1024 * 1024)]))]);
	takeMtimeMs = (await stat(takePath)).mtimeMs;
	otherMtimeMs = (await stat(otherPath)).mtimeMs;
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("a recording slot lasts one session", () => {
	test("the session's end hands back every slot it held", async () => {
		const { client, finish } = await connectedServer("session-a");
		try {
			const held = await holdEverySlot(client, "session-a");
			expect(held.every((answer) => !(answer.isError ?? false))).toBe(true);
			const over = await playerCi(client, "session-a", takePath, 300);
			expect(over.isError).toBe(true);

			await client.notification({ method: HOST_CONTEXT_ENDED, params: { sessionId: "session-a", token: HOST_STAMP_TOKEN } });

			const reopened = await playerCi(client, "session-a", takePath, 301);
			expect(reopened.isError ?? false).toBe(false);
			const source = recordingSourceSchema.parse(reopened.structuredContent);
			expect(source.token).not.toEqual(tokenOf(0));
		} finally {
			await finish();
		}
	});

	test("a session nobody ended keeps its slots", async () => {
		const { client, finish } = await connectedServer("session-b");
		try {
			const first = await playerCi(client, "session-b", takePath, 0);
			expect(first.isError ?? false).toBe(false);
			await client.notification({ method: HOST_CONTEXT_ENDED, params: { sessionId: "session-other", token: HOST_STAMP_TOKEN } });
			const second = await playerCi(client, "session-b", otherPath, 1);
			expect(second.isError ?? false).toBe(false);
		} finally {
			await finish();
		}
	});

	test("an end notice whose stamp never arrived changes nothing", async () => {
		const { client, finish } = await connectedServer("session-c");
		try {
			const first = await playerCi(client, "session-c", takePath, 0);
			expect(first.isError ?? false).toBe(false);
			const served = recordingSourceSchema.parse(first.structuredContent);
			expect(await GET(served.url)).toBe(200);
			await client.notification({ method: HOST_CONTEXT_ENDED, params: { sessionId: "session-c", token: "f".repeat(64) } });
			expect(await GET(served.url)).toBe(200);
			await client.notification({ method: HOST_CONTEXT_ENDED, params: { sessionId: "session-c", token: HOST_STAMP_TOKEN } });
			expect(await GET(served.url)).toBe(404);
		} finally {
			await finish();
		}
	});

	test("the slot refusal names the count and a recording its tab can close", async () => {
		const { client, finish } = await connectedServer("session-d");
		try {
			await holdEverySlot(client, "session-d");
			const over = await playerCi(client, "session-d", takePath, 400);
			expect(over.isError).toBe(true);
			expect(refusalText(over)).toContain("take.mp4");
			expect(refusalText(over)).toContain("64");
		} finally {
			await finish();
		}
	});

	test("close other recordings frees the pane whose open was refused", async () => {
		const { client, finish } = await connectedServer("session-e");
		try {
			await holdEverySlot(client, "session-e");
			const refused = await playerCi(client, "session-e", takePath, 500);
			expect(refused.isError).toBe(true);
			const answer = await client.callTool({ name: "close_other_recordings", arguments: {}, _meta: stamp("session-e") }, undefined);
			expect(answer.isError ?? false).toBe(false);
			const now = await playerCi(client, "session-e", takePath, 501);
			expect(now.isError ?? false).toBe(false);
		} finally {
			await finish();
		}
	});
});
