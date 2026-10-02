import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createElevenLabsProvider } from "../src/index.js";
import { frames, hangUpAll, type LiveRig, makeLiveRig, openConverse, startCall } from "./live-support.js";
import { Harness, KEY, makeRig } from "./support.js";

const harness = new Harness();
afterEach(async () => {
	hangUpAll();
	await harness.dispose();
});

const recordPath = (rig: LiveRig) => join(rig.home, "speech", "elevenlabs-agents.json");
const readRecord = async (rig: LiveRig): Promise<Record<string, string>> => JSON.parse(await readFile(recordPath(rig), "utf8"));

/** Every leaf of a nested object as a dotted path: the shape of an override, ignoring values. */
function leafPaths(value: unknown, prefix = ""): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
	return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

/** Open a call, walk the handshake, hang up. */
async function openAndHangUp(rig: LiveRig, entry: { model?: string } = {}): Promise<void> {
	const { session } = await startCall(rig, entry);
	session.close();
}

const firstKey = (map: ReadonlyMap<string, unknown>): string => [...map.keys()][0] ?? "";

describe("provisioning the one shared agent", () => {
	test("first use creates the tool and then the agent, and the call connects to that agent", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);

		expect(rig.api.calls).toEqual([
			"POST /v1/convai/tools",
			"POST /v1/convai/agents/create",
			"GET /v1/convai/conversation/get-signed-url",
		]);
		const agentId = firstKey(rig.api.agents);
		expect(rig.api.requests[2]?.url).toContain(`agent_id=${agentId}`);
		expect(rig.sockets[0]?.url).toContain(`agent_id=${agentId}`);

		expect(rig.api.toolPayload(0).tool_config).toMatchObject({ type: "client", name: "delegate_to_agent", expects_response: false });
		const agent = rig.api.agentPayload(1);
		const config = agent.conversation_config;
		expect(agent.name).toBe("dimension-live");
		expect(config.agent.prompt.tool_ids).toEqual([firstKey(rig.api.tools)]);
		expect(config.agent.first_message).toBe("");
		expect(config.conversation.max_duration_seconds).toBe(7200);
		expect(config.turn.silence_end_call_timeout).toBeGreaterThanOrEqual(10);
		// -1: ElevenLabs must not speak on its own after 7 s of a quiet user while the coding agent works.
		expect(config.turn.turn_timeout).toBe(-1);
		expect(config.conversation.client_events).toEqual(
			expect.arrayContaining(["client_tool_call", "agent_response_correction", "agent_response_complete", "audio", "interruption", "agent_response", "user_transcript", "ping"]),
		);
		expect(agent.platform_settings.auth).toEqual({ enable_auth: true });
	});

	test("the agent allows exactly the overrides the engine sends: one more is a refused call, one fewer a dead feature", async () => {
		const rig = await makeLiveRig(harness);
		const { socket } = await startCall(rig, { voice: "v" });
		const sent = socket.frames[0]?.conversation_config_override;
		const allowed = rig.api.agentPayload(1).platform_settings.overrides.conversation_config_override;

		expect(leafPaths(allowed).sort()).toEqual(leafPaths(sent).sort());
		expect(leafPaths(allowed).sort()).toEqual(["agent.first_message", "agent.prompt.prompt", "tts.voice_id"]);
	});

	test("the ids are kept in the engine home, never the key, and a restarted engine reuses them without touching the account", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);

		const text = await readFile(recordPath(rig), "utf8");
		expect(text).not.toContain(KEY);
		expect(await readRecord(rig)).toMatchObject({ agentId: firstKey(rig.api.agents), toolId: firstKey(rig.api.tools) });

		rig.restart();
		const before = rig.api.calls.length;
		await openAndHangUp(rig);
		expect(rig.api.calls.slice(before)).toEqual(["GET /v1/convai/conversation/get-signed-url"]);
	});

	test("the key travels only in the xi-api-key header to api.elevenlabs.io", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);

		for (const request of rig.api.requests) {
			expect(new URL(request.url).host).toBe("api.elevenlabs.io");
			expect(request.headers.get("xi-api-key")).toBe(KEY);
			expect(request.url).not.toContain(KEY);
			expect(request.body ?? "").not.toContain(KEY);
		}
	});

	test("changing the agent's voice model PATCHes the same agent instead of creating another", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig, { model: "eleven_v4_turbo" });
		const agentId = firstKey(rig.api.agents);
		const before = rig.api.calls.length;

		await openAndHangUp(rig, { model: "eleven_v4" });
		expect(rig.api.calls.slice(before)).toEqual([`PATCH /v1/convai/agents/${agentId}`, "GET /v1/convai/conversation/get-signed-url"]);
		expect(rig.api.agents.size).toBe(1);
		expect(rig.api.agentPayload(before).conversation_config.tts.model_id).toBe("eleven_v4");

		// Same model again: nothing to send.
		const settled = rig.api.calls.length;
		await openAndHangUp(rig, { model: "eleven_v4" });
		expect(rig.api.calls.slice(settled)).toEqual(["GET /v1/convai/conversation/get-signed-url"]);
	});

	test("a tool whose stored hash no longer matches the body this code wants is PATCHed, not recreated", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);
		await writeFile(recordPath(rig), JSON.stringify({ ...(await readRecord(rig)), toolHash: "from-an-older-pack" }));
		const before = rig.api.calls.length;

		await openAndHangUp(rig);
		expect(rig.api.calls.slice(before)).toEqual([`PATCH /v1/convai/tools/${firstKey(rig.api.tools)}`, "GET /v1/convai/conversation/get-signed-url"]);
		expect(rig.api.tools.size).toBe(1);
		expect((await readRecord(rig)).toolHash).not.toBe("from-an-older-pack");
	});

	test("an agent deleted in the dashboard is recreated on the next call, which then connects", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);
		const oldAgent = firstKey(rig.api.agents);
		const tool = firstKey(rig.api.tools);
		rig.api.deleteRemote({ agents: true });
		const before = rig.api.calls.length;

		await openAndHangUp(rig);
		const newAgent = firstKey(rig.api.agents);
		expect(newAgent).not.toBe("");
		expect(newAgent).not.toBe(oldAgent);
		expect(rig.sockets[1]?.url).toContain(`agent_id=${newAgent}`);
		expect((await readRecord(rig)).agentId).toBe(newAgent);
		// The tool survived, so it is reused rather than duplicated.
		expect(firstKey(rig.api.tools)).toBe(tool);
		expect(rig.api.calls.slice(before)).not.toContain("POST /v1/convai/tools");
	});

	test("the tool deleted along with the agent: both come back, and the new agent points at the new tool", async () => {
		const rig = await makeLiveRig(harness);
		await openAndHangUp(rig);
		rig.api.deleteRemote({ agents: true, tools: true });

		await openAndHangUp(rig);
		const toolId = firstKey(rig.api.tools);
		const agentId = firstKey(rig.api.agents);
		expect(rig.api.agentById(agentId).conversation_config.agent.prompt.tool_ids).toEqual([toolId]);
		expect(await readRecord(rig)).toMatchObject({ agentId, toolId });
	});

	test("a first call that fails after the tool was created keeps that tool: the next call reuses it instead of creating another", async () => {
		const rig = await makeLiveRig(harness);
		rig.api.refuseAgentCreate = true;
		await expect(openConverse(rig)).rejects.toThrow();
		const tool = firstKey(rig.api.tools);
		expect(tool).not.toBe("");

		rig.api.refuseAgentCreate = false;
		await openAndHangUp(rig);
		expect(rig.api.calls.filter(call => call === "POST /v1/convai/tools")).toHaveLength(1);
		expect([...rig.api.tools.keys()]).toEqual([tool]);
		expect(rig.api.agentById(firstKey(rig.api.agents)).conversation_config.agent.prompt.tool_ids).toEqual([tool]);
	});

	test("a corrupt id file is treated as no file", async () => {
		const rig = await makeLiveRig(harness);
		await mkdir(dirname(recordPath(rig)), { recursive: true });
		await writeFile(recordPath(rig), '{"agentId": "agent_1", "tool');

		await openAndHangUp(rig);
		expect(rig.api.calls.slice(0, 2)).toEqual(["POST /v1/convai/tools", "POST /v1/convai/agents/create"]);
	});

	test("two calls opened together create the agent once", async () => {
		const rig = await makeLiveRig(harness);
		const first = openConverse(rig);
		const second = openConverse(rig);
		const sockets = await Promise.all([rig.socket(0), rig.socket(1)]);
		for (const socket of sockets) {
			socket.open();
			socket.receive(frames.metadata());
		}
		for (const session of await Promise.all([first, second])) session.close();

		expect(rig.api.calls.filter(call => call === "POST /v1/convai/agents/create")).toHaveLength(1);
		expect(rig.api.calls.filter(call => call === "POST /v1/convai/tools")).toHaveLength(1);
	});

	test("a call ElevenLabs closes over a refused override makes the next call re-send the whole agent", async () => {
		const rig = await makeLiveRig(harness);
		const { socket, log } = await startCall(rig);
		socket.serverClose(1008, "Override for field 'tts.model_id' is not allowed by config.");
		await log.settled();
		const before = rig.api.calls.length;

		await openAndHangUp(rig);
		expect(rig.api.calls.slice(before)).toEqual([
			`PATCH /v1/convai/tools/${firstKey(rig.api.tools)}`,
			`PATCH /v1/convai/agents/${firstKey(rig.api.agents)}`,
			"GET /v1/convai/conversation/get-signed-url",
		]);
	});

	test("a key without the Agents permissions fails the call before any socket, naming the permission and not the key", async () => {
		const rig = await makeLiveRig(harness, { scope: "none" });
		const error = await openConverse(rig).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);

		expect(error?.message).toContain("convai read + write");
		expect(error?.message).not.toContain(KEY);
		expect(rig.sockets).toHaveLength(0);
	});

	test("without a key it says so and reaches for nothing", async () => {
		const base = await makeRig(harness, { env: {} });
		const { api } = await makeLiveRig(harness);
		const provider = createElevenLabsProvider({ fetch: api.http.fetch, userHome: base.home });

		await expect(
			provider.openConverse?.(base.ctx, {}, { signal: new AbortController().signal, instructions: "x", agentName: "A", sessionId: "s" }),
		).rejects.toThrow("ElevenLabs needs an API key");
		expect(api.requests).toHaveLength(0);
	});
});
