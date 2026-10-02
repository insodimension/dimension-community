import { afterEach, describe, expect, test } from "bun:test";
import { AccountVoices } from "../src/catalog.js";
import { FakeHttp, Harness, jsonResponse, KEY, makeRig, type RecordedRequest } from "./support.js";

const harness = new Harness();
afterEach(() => harness.dispose());

const CURATED = [
	["EXAVITQu4vr4xnSDxMaL", "Sarah"],
	["CwhRBWXzGAHq8TQ4Fs17", "Roger"],
	["FGY2WhTYpPnrIDTdsKH5", "Laura"],
	["IKne3meq5aSn9XLyUdCD", "Charlie"],
	["JBFqnCBsd6RMkjVDRZzb", "George"],
] as const;
const CURATED_IDS = CURATED.map(([id]) => id);

const ACCOUNT_BODY = {
	voices: [
		// Also curated: must not appear twice, and the curated label wins.
		{ voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah (account copy)", category: "premade" },
		{ voice_id: "aria-id", name: "Aria", category: "premade" },
		{ voice_id: "clone-id", name: "My Clone", category: "cloned" },
		{ name: "no id" },
		{ voice_id: 7, name: "numeric id" },
		"junk",
		null,
	],
};

const MINUTE = 60_000;

describe("catalog", () => {
	test("without a key: the three models, each with the five curated voices, and no request at all", async () => {
		const rig = await makeRig(harness, { env: {} });
		const catalog = await rig.provider.catalog(rig.ctx);

		expect(catalog.speak?.map(model => model.id)).toEqual(["eleven_v4_turbo", "eleven_v4", "eleven_flash_v2_5"]);
		for (const model of catalog.speak ?? []) {
			expect(model.voices?.map(voice => [voice.id, voice.label.split(" ")[0]])).toEqual(CURATED.map(pair => [...pair]));
		}
		expect(catalog.freeFormVoice).toBe(true);
		expect(catalog.audioTags).toBe(true);
		expect(catalog.listen).toBeUndefined();
		expect(rig.http.requests).toHaveLength(0);
	});

	test("the picker learns per model which ones perform audio tags: v4 does, Flash does not", async () => {
		const rig = await makeRig(harness, { env: {} });
		const catalog = await rig.provider.catalog(rig.ctx);

		expect(Object.fromEntries((catalog.speak ?? []).map(model => [model.id, model.audioTags]))).toEqual({
			eleven_v4_turbo: true,
			eleven_v4: true,
			eleven_flash_v2_5: false,
		});
	});

	test("the writing guide ships for the v4 models that perform tags and for no other: a Flash reply is told never to write a bracket", async () => {
		const rig = await makeRig(harness, { env: {} });
		const catalog = await rig.provider.catalog(rig.ctx);
		const guides = new Map((catalog.speak ?? []).map(model => [model.id, model.guide]));

		expect(guides.get("eleven_v4_turbo")).toBeString();
		expect(guides.get("eleven_v4")).toBe(guides.get("eleven_v4_turbo"));
		expect(guides.get("eleven_flash_v2_5")).toBeUndefined();
		// A guide on a model that does not perform tags would have the rewriter write brackets Flash drops or reads aloud.
		for (const model of catalog.speak ?? []) if (model.guide !== undefined) expect(model.audioTags).toBe(true);
	});

	test("the guide stays small enough to ride a small model's prompt and keeps its tags inside the engine's tag stripper", async () => {
		const rig = await makeRig(harness, { env: {} });
		const guide = (await rig.provider.catalog(rig.ctx)).speak?.find(model => model.id === "eleven_v4_turbo")?.guide ?? "";

		expect(guide.split(/\s+/).length).toBeLessThan(250);
		// `vocalizer/tags.ts` recognises a bracket of 1..60 characters on one line; a longer one in an example would be copied and read aloud.
		const brackets = guide.match(/\[[^\]]*\]/g) ?? [];
		expect(brackets.length).toBeGreaterThan(10);
		expect(brackets.filter(bracket => bracket.length > 60 || bracket.includes("\n"))).toEqual([]);
	});

	test("with a key: the account's voices follow the curated ones, once each, cloned voices say so", async () => {
		const rig = await makeRig(harness, { respond: () => jsonResponse(ACCOUNT_BODY) });
		const catalog = await rig.provider.catalog(rig.ctx);

		expect(rig.http.requests).toHaveLength(1);
		const request = rig.http.requests[0]!;
		expect(request.url).toBe("https://api.elevenlabs.io/v1/voices");
		expect(request.method).toBe("GET");
		expect(request.headers.get("xi-api-key")).toBe(KEY);

		for (const model of catalog.speak ?? []) {
			const voices = model.voices ?? [];
			expect(voices.map(voice => voice.id)).toEqual([...CURATED_IDS, "aria-id", "clone-id"]);
			expect(voices[0]?.label).toStartWith("Sarah - ");
			expect(voices[5]?.label).toBe("Aria");
			expect(voices[6]?.label).toBe("My Clone (cloned)");
		}
	});

	test.each([
		{ name: "permission denied", respond: () => jsonResponse({ detail: "missing_permissions" }, 401) },
		{ name: "server error", respond: () => jsonResponse({}, 500) },
		{ name: "network failure", respond: () => Promise.reject(new Error("offline")) },
		{ name: "body that is not JSON", respond: () => new Response("<html>", { status: 200 }) },
		{ name: "body without a voices list", respond: () => jsonResponse({}) },
		{ name: "voices that is not a list", respond: () => jsonResponse({ voices: "nope" }) },
	])("a failing voices lookup yields the curated list and never throws: $name", async ({ respond }) => {
		const rig = await makeRig(harness, { respond });
		const catalog = await rig.provider.catalog(rig.ctx);
		for (const model of catalog.speak ?? []) expect(model.voices?.map(voice => voice.id)).toEqual(CURATED_IDS);
	});

	test("concurrent catalog calls share one request", async () => {
		const gate = Promise.withResolvers<Response>();
		const rig = await makeRig(harness, { respond: () => gate.promise });
		const both = Promise.all([rig.provider.catalog(rig.ctx), rig.provider.catalog(rig.ctx)]);
		await rig.http.whenCalled(1);
		gate.resolve(jsonResponse(ACCOUNT_BODY));
		const [first, second] = await both;

		expect(rig.http.requests).toHaveLength(1);
		expect(first).toEqual(second);
		expect(first.speak?.[0]?.voices?.map(voice => voice.id)).toContain("clone-id");
	});
});

describe("AccountVoices cache", () => {
	function cache(respond: (request: RecordedRequest, index: number) => Response | Promise<Response>) {
		let now = 0;
		const http = new FakeHttp(respond);
		return {
			http,
			voices: new AccountVoices(http.fetch, () => now),
			at(ms: number) {
				now = ms;
			},
		};
	}

	const oneVoice = () => jsonResponse({ voices: [{ voice_id: "v1", name: "One", category: "premade" }] });

	test("is served from cache inside five minutes and refetched after", async () => {
		const c = cache(oneVoice);
		await c.voices.get(KEY);
		c.at(4 * MINUTE);
		expect(await c.voices.get(KEY)).toEqual([{ id: "v1", label: "One" }]);
		expect(c.http.requests).toHaveLength(1);

		c.at(5 * MINUTE + 1_000);
		await c.voices.get(KEY);
		expect(c.http.requests).toHaveLength(2);
	});

	test("is per key: another key never sees the first account's voices", async () => {
		const c = cache(request =>
			jsonResponse({ voices: [{ voice_id: `for-${request.headers.get("xi-api-key")}`, name: "V", category: "premade" }] }),
		);
		expect((await c.voices.get("key-a"))[0]?.id).toBe("for-key-a");
		expect((await c.voices.get("key-b"))[0]?.id).toBe("for-key-b");
		expect(c.http.requests).toHaveLength(2);
	});

	test("a failure is an empty list, retried after a short window rather than a full five minutes", async () => {
		const c = cache((_request, index) => (index === 0 ? jsonResponse({}, 403) : oneVoice()));
		expect(await c.voices.get(KEY)).toEqual([]);

		c.at(10_000);
		expect(await c.voices.get(KEY)).toEqual([]);
		expect(c.http.requests).toHaveLength(1);

		// One minute later, well inside the success window: the failure must not be held that long.
		c.at(MINUTE);
		expect(await c.voices.get(KEY)).toEqual([{ id: "v1", label: "One" }]);
		expect(c.http.requests).toHaveLength(2);
	});
});
