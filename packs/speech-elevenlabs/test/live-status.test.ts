import { afterEach, describe, expect, test } from "bun:test";
import { createElevenLabsProvider } from "../src/index.js";
import { makeLiveRig } from "./live-support.js";
import { Harness, KEY, makeRig } from "./support.js";

const harness = new Harness();
afterEach(() => harness.dispose());

const NEEDS_PERMISSIONS = "the key needs the ElevenLabs Agents permissions (convai read + write)";

describe("converse readiness", () => {
	test("ready when the key reaches the Agents API; asked once, then remembered", async () => {
		const rig = await makeLiveRig(harness);
		const first = await rig.provider.status(rig.ctx);
		const second = await rig.provider.status(rig.ctx);

		expect(first).toEqual({ speak: { ready: true }, converse: { ready: true } });
		expect(second.converse).toEqual({ ready: true });
		expect(rig.api.calls).toEqual(["GET /v1/convai/agents"]);
		expect(rig.api.requests[0]?.headers.get("xi-api-key")).toBe(KEY);
	});

	test.each([
		{ scope: "none", name: "a key limited to Text to Speech (401 missing_permissions)" },
		{ scope: "forbidden", name: "a 403" },
	] as const)("$name: needs-key, saying which permissions to add, while speaking stays ready", async ({ scope }) => {
		const rig = await makeLiveRig(harness, { scope });
		const status = await rig.provider.status(rig.ctx);

		expect(status.converse).toEqual({ ready: false, reason: "needs-key", detail: NEEDS_PERMISSIONS });
		expect(status.speak).toEqual({ ready: true });
	});

	test("a key ElevenLabs does not know is needs-key without blaming the permissions", async () => {
		const rig = await makeLiveRig(harness, { scope: "invalid-key" });
		const status = await rig.provider.status(rig.ctx);

		expect(status.converse).toMatchObject({ ready: false, reason: "needs-key" });
		expect(JSON.stringify(status.converse)).not.toContain("convai");
	});

	test("an unreachable ElevenLabs is unavailable, not needs-key, and the failure is remembered briefly instead of re-asked on every call", async () => {
		const base = await makeRig(harness);
		let up = false;
		const { api } = await makeLiveRig(harness);
		const provider = createElevenLabsProvider({
			fetch: ((input: string | URL | Request, init?: RequestInit) => {
				if (!up) return Promise.reject(new Error("offline"));
				return api.http.fetch(input, init);
			}) as typeof fetch,
			userHome: base.home,
		});

		const down = await provider.status(base.ctx);
		expect(down.converse).toMatchObject({ ready: false, reason: "unavailable" });
		expect(down.speak).toEqual({ ready: true });
		// Cached: the failure is not retried on every status call.
		up = true;
		expect((await provider.status(base.ctx)).converse).toMatchObject({ ready: false, reason: "unavailable" });
	});

	test("without a key, converse needs one too, and nothing is asked of ElevenLabs", async () => {
		const base = await makeRig(harness, { env: {} });
		const { api } = await makeLiveRig(harness);
		const provider = createElevenLabsProvider({ fetch: api.http.fetch, userHome: base.home });

		const status = await provider.status(base.ctx);
		expect(status.converse).toMatchObject({ ready: false, reason: "needs-key" });
		expect(api.requests).toHaveLength(0);
	});

	test("the answer is per key: a different key is asked afresh, not judged by the first key's refusal", async () => {
		const rig = await makeLiveRig(harness, { scope: "none" });
		expect((await rig.provider.status(rig.ctx)).converse).toMatchObject({ detail: NEEDS_PERMISSIONS });

		// The account was fixed, but this is a different (unknown) key: ElevenLabs is asked again and rejects it.
		rig.api.scope = "full";
		const other = await rig.provider.status({ ...rig.ctx, env: { ELEVENLABS_API_KEY: "sk-another-key" } });
		expect(rig.api.requests).toHaveLength(2);
		expect(other.converse).toEqual({ ready: false, reason: "needs-key", detail: "ElevenLabs rejected the API key" });
	});
});

describe("the converse catalog", () => {
	test("the agent's two voice models, the default first, each offering the curated voices, with relay media declared", async () => {
		const rig = await makeLiveRig(harness);
		const catalog = await rig.provider.catalog({ ...rig.ctx, env: {} });

		expect(catalog.converse?.map(model => model.id)).toEqual(["eleven_v4_turbo", "eleven_v4"]);
		for (const model of catalog.converse ?? []) expect(model.voices?.map(voice => voice.id)).toContain("EXAVITQu4vr4xnSDxMaL");
		expect(catalog.converseMedia).toBe("relay");
		expect(catalog.freeFormVoice).toBe(true);
	});

	test("speaking models are untouched by the live ones", async () => {
		const rig = await makeLiveRig(harness);
		const catalog = await rig.provider.catalog({ ...rig.ctx, env: {} });
		expect(catalog.speak?.map(model => model.id)).toEqual(["eleven_v4_turbo", "eleven_v4", "eleven_flash_v2_5"]);
	});
});
