import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const ENV = ["HOME", "USERPROFILE", "INSO_HOME"] as const;
const prior = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const root = await mkdtemp(join(tmpdir(), "youtube-writes-"));
const home = join(root, "home");
const insoHome = join(root, "inso");
const approvals = join(insoHome, "browser", "publish-approvals");
const thumbs = join(root, "thumbs");

process.env.HOME = home;
process.env.USERPROFILE = home;
const { createUpdateVideoTool, updateBinding, snippetWithTitle } = await import("../update.ts?youtube-writes");
const { createReachReportTool, createVideoAnalyticsTool, ensureReachJobs, parseCsv, addReach } = await import("../analytics.ts?youtube-writes");
const { CONFIG_DIR, MISSING_ANALYTICS_SCOPE } = await import("../api.ts");
for (const name of ["HOME", "USERPROFILE"] as const) {
	if (prior[name] === undefined) delete process.env[name];
	else process.env[name] = prior[name];
}

if (!resolve(CONFIG_DIR).startsWith(resolve(tmpdir()) + sep)) {
	throw new Error(`refusing to write a test token into ${CONFIG_DIR}: it is not under the temp directory`);
}
const TOKEN_FILE = join(CONFIG_DIR, "token.json");
const REACH_JOBS_FILE = join(CONFIG_DIR, "reach-jobs.json");
const priorToken = await readFile(TOKEN_FILE).catch(() => null);
const configHome = dirname(dirname(CONFIG_DIR));
const configHomeExisted = await readdir(configHome).then(
	() => true,
	() => false,
);

interface Tool {
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

interface Call {
	method: string;
	url: URL;
	headers: Headers;
	body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function serve(handler: Handler): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const raw = init?.body;
		const call: Call = {
			method: init?.method ?? "GET",
			url: new URL(input instanceof Request ? input.url : String(input)),
			headers: new Headers(init?.headers),
			body: raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
}

async function writeToken(refresh = "refresh-A"): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(TOKEN_FILE, JSON.stringify({ access: "tok", refresh, expires: Date.now() + 24 * 3_600_000, clientId: "c" }));
}

beforeEach(async () => {
	process.env.INSO_HOME = insoHome;
	await rm(insoHome, { recursive: true, force: true });
	await rm(thumbs, { recursive: true, force: true });
	await rm(REACH_JOBS_FILE, { force: true });
	await mkdir(approvals, { recursive: true });
	await mkdir(thumbs, { recursive: true });
	await writeToken();
	calls = [];
	serve(call => {
		throw new Error(`unexpected request ${call.method} ${call.url}`);
	});
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(REACH_JOBS_FILE, { force: true });
	if (!configHomeExisted) await rm(configHome, { recursive: true, force: true });
	else if (priorToken === null) await rm(TOKEN_FILE, { force: true });
	else await writeFile(TOKEN_FILE, priorToken);
	await rm(root, { recursive: true, force: true });
});

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function titleValues(title: string): string[] {
	return ["title", title];
}

function thumbnailValues(path: string, bytes: Uint8Array): string[] {
	return ["thumbnail", JSON.stringify([path, sha256Hex(bytes)])];
}

interface Approval {
	nonce: string;
	marker: string;
}

async function approve(draftId: string, videoId: string, values: string[], over: { expired?: boolean } = {}): Promise<Approval> {
	const nonce = randomBytes(16).toString("hex");
	const now = Date.now();
	const approvedAt = over.expired ? now - 2 * 3_600_000 : now - 1_000;
	const expiresAt = over.expired ? now - 3_600_000 : now + 3_600_000;
	await writeFile(
		join(approvals, `${draftId}.json`),
		JSON.stringify({
			v: 1,
			draftId,
			nonce,
			binding: sha256Hex(JSON.stringify(["publish-approval/v1", "https://www.youtube.com", videoId, "youtube_update_video", values])),
			approvedAt: new Date(approvedAt).toISOString(),
			expiresAt: new Date(expiresAt).toISOString(),
		}),
	);
	return { nonce, marker: join(approvals, `${draftId}.${nonce}.used`) };
}

async function usedMarkers(): Promise<string[]> {
	return (await readdir(approvals)).filter(name => name.endsWith(".used"));
}

async function exists(path: string): Promise<boolean> {
	return readFile(path).then(
		() => true,
		() => false,
	);
}

function jsonBody(call: Call): Record<string, unknown> {
	return JSON.parse(String(call.body)) as Record<string, unknown>;
}

describe("youtube_update_video", () => {
	const VIDEO = "dQw4w9WgXcQ";
	const OTHER_VIDEO = "aaaaaaaaaaa";
	const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO}`;
	const READ_SNIPPET = {
		title: "Old title",
		description: "First line\nSecond line with https://example.com",
		tags: ["unreal", "gamedev"],
		categoryId: "28",
		defaultLanguage: "en",
		defaultAudioLanguage: "en-US",
		publishedAt: "2026-11-01T00:00:00Z",
		channelId: "UCabc",
		thumbnails: { default: { url: "https://i.ytimg.com/vi/x/default.jpg" } },
	};

	function update(params: Record<string, unknown>): Promise<{ content: { text: string }[] }> {
		return (createUpdateVideoTool() as unknown as Tool).execute("call-1", params);
	}

	function titleCall(title: string, draftId = "draft1", videoUrl = VIDEO_URL): Promise<{ content: { text: string }[] }> {
		return update({ draftId, videoUrl, title });
	}

	function serveVideo(put: () => Response = () => Response.json({ id: VIDEO })): void {
		serve(call => {
			if (call.url.pathname === "/youtube/v3/videos" && call.method === "GET") return Response.json({ items: [{ id: VIDEO, snippet: READ_SNIPPET }] });
			if (call.url.pathname === "/youtube/v3/videos" && call.method === "PUT") return put();
			throw new Error(`unexpected request ${call.method} ${call.url}`);
		});
	}

	function summary(): string[] {
		return calls.map(call => `${call.method} ${call.url.pathname}`);
	}

	test("with no approval file the call is refused as unapproved and nothing is requested", async () => {
		await expect(titleCall("New title")).rejects.toThrow(/publish_unapproved/);
		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);
	});

	test("an approval minted for a different title is refused, nothing requested, approval unspent", async () => {
		await approve("draft1", VIDEO, titleValues("A different title"));
		await expect(titleCall("New title")).rejects.toThrow(/publish_unapproved/);
		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);
	});

	test("an approval minted for a different video is refused, nothing requested, approval unspent", async () => {
		await approve("draft1", OTHER_VIDEO, titleValues("New title"));
		await expect(titleCall("New title")).rejects.toThrow(/publish_unapproved/);
		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);
	});

	test("a draft id that could escape the approvals folder is refused before anything is read", async () => {
		await expect(titleCall("New title", "../evil")).rejects.toThrow();
		expect(calls).toEqual([]);
	});

	test("a matching title approval reads the snippet, then PUTs it whole with only the title changed, and spends the approval", async () => {
		const { marker } = await approve("draft1", VIDEO, titleValues("New title"));
		serveVideo();

		await titleCall("New title");

		expect(summary()).toEqual(["GET /youtube/v3/videos", "PUT /youtube/v3/videos"]);
		const [get, put] = calls;
		expect(get?.url.searchParams.get("part")).toBe("snippet");
		expect(get?.url.searchParams.get("id")).toBe(VIDEO);
		expect(put?.url.searchParams.get("part")).toBe("snippet");
		const body = jsonBody(put as Call);
		expect(body.id).toBe(VIDEO);
		expect(body.snippet).toMatchObject({
			title: "New title",
			description: READ_SNIPPET.description,
			tags: READ_SNIPPET.tags,
			categoryId: "28",
			defaultLanguage: "en",
		});
		expect(await exists(marker)).toBe(true);
	});

	test("the same approval cannot be spent twice: the second call is refused as already used and sends nothing", async () => {
		await approve("draft1", VIDEO, titleValues("New title"));
		serveVideo();
		await titleCall("New title");
		const before = calls.length;

		await expect(titleCall("New title")).rejects.toThrow(/already used/);

		expect(calls.length).toBe(before);
		expect(summary().filter(line => line.startsWith("PUT"))).toHaveLength(1);
	});

	test("two simultaneous calls on one approval produce exactly one PUT", async () => {
		await approve("draft1", VIDEO, titleValues("New title"));
		serveVideo();

		const results = await Promise.allSettled([titleCall("New title"), titleCall("New title")]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]?.reason)).toMatch(/already used/);
		expect(summary().filter(line => line.startsWith("PUT"))).toHaveLength(1);
	});

	test("a clear 400 refusal on the PUT says the approval still stands, frees the approval, and a retry can spend it", async () => {
		const { marker } = await approve("draft1", VIDEO, titleValues("New title"));
		serveVideo(() => Response.json({ error: { message: "Invalid video title" } }, { status: 400 }));

		await expect(titleCall("New title")).rejects.toThrow(/approval still stands/);
		expect(await exists(marker)).toBe(false);

		serveVideo();
		await titleCall("New title");
		expect(summary().filter(line => line.startsWith("PUT"))).toHaveLength(2);
		expect(await exists(marker)).toBe(true);
	});

	for (const status of [500, 429]) {
		test(`an unclear ${status} on the PUT says the change may be live, keeps the approval spent, and refuses a retry`, async () => {
			const { marker } = await approve("draft1", VIDEO, titleValues("New title"));
			serveVideo(() => Response.json({ error: { message: "Backend Error" } }, { status }));

			await expect(titleCall("New title")).rejects.toThrow(/may be live/);
			expect(await exists(marker)).toBe(true);

			const before = calls.length;
			await expect(titleCall("New title")).rejects.toThrow(/already used/);
			expect(calls.length).toBe(before);
		});
	}

	test("a video the channel cannot read leaves the approval unspent", async () => {
		const { marker } = await approve("draft1", VIDEO, titleValues("New title"));
		serve(() => Response.json({ items: [] }));

		await expect(titleCall("New title")).rejects.toThrow();

		expect(summary()).toEqual(["GET /youtube/v3/videos"]);
		expect(await exists(marker)).toBe(false);
	});

	test("an expired approval is refused as expired and nothing is requested", async () => {
		await approve("draft1", VIDEO, titleValues("New title"), { expired: true });
		await expect(titleCall("New title")).rejects.toThrow(/expired/);
		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);
	});

	test("a title of 101 characters is refused before any request even with a valid approval, while 100 goes through", async () => {
		const tooLong = "a".repeat(101);
		await approve("draft1", VIDEO, titleValues(tooLong));
		await expect(titleCall(tooLong)).rejects.toThrow();
		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);

		const longest = "a".repeat(100);
		await approve("draft2", VIDEO, titleValues(longest));
		serveVideo();
		await titleCall(longest, "draft2");
		expect(summary()).toEqual(["GET /youtube/v3/videos", "PUT /youtube/v3/videos"]);
	});

	for (const title of ["Fast <b>build</b>", "a > b", "   "]) {
		test(`the title ${JSON.stringify(title)} is refused before any request even with a valid approval`, async () => {
			await approve("draft1", VIDEO, titleValues(title));
			await expect(titleCall(title)).rejects.toThrow();
			expect(calls).toEqual([]);
			expect(await usedMarkers()).toEqual([]);
		});
	}

	test("passing both a title and a thumbnail path, or neither, is refused even with valid approvals", async () => {
		const path = join(thumbs, "a.png");
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		await writeFile(path, bytes);
		await approve("draft1", VIDEO, titleValues("New title"));
		await approve("draft2", VIDEO, thumbnailValues(path, bytes));

		await expect(update({ draftId: "draft1", videoUrl: VIDEO_URL, title: "New title", thumbnailPath: path })).rejects.toThrow();
		await expect(update({ draftId: "draft2", videoUrl: VIDEO_URL, title: "New title", thumbnailPath: path })).rejects.toThrow();
		await expect(update({ draftId: "draft1", videoUrl: VIDEO_URL })).rejects.toThrow();

		expect(calls).toEqual([]);
		expect(await usedMarkers()).toEqual([]);
	});

	describe("thumbnail", () => {
		const BYTES_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const BYTES_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 5]);

		function thumbnailCall(path: string, draftId = "draft1"): Promise<{ content: { text: string }[] }> {
			return update({ draftId, videoUrl: VIDEO_URL, thumbnailPath: path });
		}

		test("a file rewritten after Approve is refused and nothing is uploaded", async () => {
			const path = join(thumbs, "cover.png");
			await writeFile(path, BYTES_A);
			await approve("draft1", VIDEO, thumbnailValues(path, BYTES_A));
			await writeFile(path, BYTES_B);

			await expect(thumbnailCall(path)).rejects.toThrow(/publish_unapproved/);

			expect(calls).toEqual([]);
			expect(await usedMarkers()).toEqual([]);
		});

		test("an unchanged file is uploaded once to the thumbnail endpoint as image/png with exactly its bytes, and the approval is spent", async () => {
			const path = join(thumbs, "cover.png");
			await writeFile(path, BYTES_A);
			const { marker } = await approve("draft1", VIDEO, thumbnailValues(path, BYTES_A));
			serve(() => Response.json({ items: [{ default: { url: "https://i.ytimg.com/vi/x/default.jpg" } }] }));

			await thumbnailCall(path);

			expect(calls).toHaveLength(1);
			const [upload] = calls;
			expect(upload?.method).toBe("POST");
			expect(`${upload?.url.host}${upload?.url.pathname}`).toBe("www.googleapis.com/upload/youtube/v3/thumbnails/set");
			expect(upload?.url.searchParams.get("videoId")).toBe(VIDEO);
			expect(upload?.headers.get("content-type")).toBe("image/png");
			expect(Buffer.compare(Buffer.from(upload?.body as Uint8Array), Buffer.from(BYTES_A))).toBe(0);
			expect(await exists(marker)).toBe(true);
		});

		test("a clear 400 on the upload frees the approval; the same approval then uploads", async () => {
			const path = join(thumbs, "cover.png");
			await writeFile(path, BYTES_A);
			const { marker } = await approve("draft1", VIDEO, thumbnailValues(path, BYTES_A));
			serve(() => Response.json({ error: { message: "Invalid image" } }, { status: 400 }));

			await expect(thumbnailCall(path)).rejects.toThrow(/approval still stands/);
			expect(await exists(marker)).toBe(false);

			serve(() => Response.json({ items: [] }));
			await thumbnailCall(path);
			expect(calls).toHaveLength(2);
			expect(await exists(marker)).toBe(true);
		});
	});
});

describe("updateBinding", () => {
	test("golden vector: the title binding is the sha256 of the literal domain-separated JSON array", () => {
		const literal = '["publish-approval/v1","https://www.youtube.com","dQw4w9WgXcQ","youtube_update_video",["title","New title"]]';
		const expected = createHash("sha256").update(literal).digest("hex");

		expect(updateBinding("dQw4w9WgXcQ", ["title", "New title"])).toBe(expected);
		expect(expected).toBe("5f2f91d696703f2cd619f5012a891358e49992a906594e460a3b17cbb01c2697");
	});

	test("a different video or a different value changes the binding", () => {
		const base = updateBinding("dQw4w9WgXcQ", ["title", "New title"]);
		expect(updateBinding("aaaaaaaaaaa", ["title", "New title"])).not.toBe(base);
		expect(updateBinding("dQw4w9WgXcQ", ["title", "New title."])).not.toBe(base);
		expect(updateBinding("dQw4w9WgXcQ", ["thumbnail", "New title"])).not.toBe(base);
	});
});

describe("snippetWithTitle", () => {
	test("a snippet read without a description is resent with an empty one so the update cannot blank it by omission, and absent tags stay absent", () => {
		const resent = snippetWithTitle({ title: "Old", categoryId: "22" }, "New");

		expect(resent).toEqual({ title: "New", categoryId: "22", description: "" });
		expect("tags" in resent).toBe(false);
	});
});

describe("parseCsv", () => {
	test("plain rows split on commas and newlines, with empty fields kept", () => {
		expect(parseCsv("a,b,c\n1,,3\n")).toEqual([
			["a", "b", "c"],
			["1", "", "3"],
		]);
	});

	test("quoted fields keep their commas and turn doubled quotes into one quote", () => {
		expect(parseCsv('h1,h2\n"a, b","say ""hi"""\n')).toEqual([
			["h1", "h2"],
			["a, b", 'say "hi"'],
		]);
	});

	test("CRLF ends rows without leaving a carriage return in the last field or an empty row at the end", () => {
		expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", "4"],
		]);
	});

	test("a quoted field may span lines, and a CRLF inside quotes is kept", () => {
		expect(parseCsv('k,v\r\n"line1\r\nline2",x\r\n')).toEqual([
			["k", "v"],
			["line1\r\nline2", "x"],
		]);
	});

	test("blank lines are skipped and a final row without a newline is kept", () => {
		expect(parseCsv("a,b\n\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});

describe("addReach", () => {
	test("CTR is accumulated as impressions-weighted clicks, and a row with unreadable impressions is ignored", () => {
		const totals = new Map<string, { impressions: number; clicks: number }>();

		addReach(totals, "v1", { video_thumbnail_impressions: "100", video_thumbnail_impressions_ctr: "0.10" });
		addReach(totals, "v1", { video_thumbnail_impressions: "300", video_thumbnail_impressions_ctr: "0.02" });
		addReach(totals, "v1", { video_thumbnail_impressions: "n/a", video_thumbnail_impressions_ctr: "0.5" });

		const entry = totals.get("v1");
		expect(entry?.impressions).toBe(400);
		expect(entry?.clicks).toBeCloseTo(16, 10);
	});
});

describe("youtube_reach_report", () => {
	const REPORTING = "youtubereporting.googleapis.com";
	const VIDEO = "dQw4w9WgXcQ";
	const CSV_HEADER = "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr";

	function reach(params: Record<string, unknown> = {}): Promise<{ content: { text: string }[] }> {
		return (createReachReportTool() as unknown as Tool).execute("call-1", params);
	}

	interface Fixture {
		jobs?: { id: string; reportTypeId: string; createTime?: string }[];
		reports?: Record<string, unknown[]>;
		downloads?: Record<string, string>;
	}

	function serveReporting(fixture: Fixture = {}): void {
		serve(call => {
			if (call.url.host !== REPORTING) throw new Error(`unexpected request ${call.method} ${call.url}`);
			const path = call.url.pathname;
			if (path === "/v1/jobs" && call.method === "GET") return Response.json(fixture.jobs ? { jobs: fixture.jobs } : {});
			if (path === "/v1/jobs" && call.method === "POST") {
				const { reportTypeId } = jsonBody(call) as { reportTypeId: string };
				return Response.json({ id: `job-${reportTypeId}`, reportTypeId, createTime: "2026-11-09T00:00:00Z" });
			}
			const reports = /^\/v1\/jobs\/([^/]+)\/reports$/.exec(path);
			if (reports && call.method === "GET") return Response.json({ reports: fixture.reports?.[reports[1] ?? ""] ?? [] });
			const download = fixture.downloads?.[path];
			if (download !== undefined) return new Response(download);
			throw new Error(`unexpected request ${call.method} ${call.url}`);
		});
	}

	function posts(): string[] {
		return calls.filter(call => call.method === "POST" && call.url.pathname === "/v1/jobs").map(call => jsonBody(call).reportTypeId as string);
	}

	test("with no jobs listed both reach jobs are created, and a second call creates none", async () => {
		serveReporting();

		await reach();
		expect(posts().sort()).toEqual(["channel_reach_basic_a1", "channel_reach_combined_a1"]);

		const before = calls.length;
		await reach();
		expect(posts()).toHaveLength(2);
		expect(calls.slice(before).filter(call => call.method === "POST")).toEqual([]);
	});

	test("only the missing reach job is created when the other already exists, and a job of another report type is ignored", async () => {
		serveReporting({
			jobs: [
				{ id: "job-existing", reportTypeId: "channel_reach_basic_a1", createTime: "2026-10-01T00:00:00Z" },
				{ id: "job-other", reportTypeId: "channel_basic_a3" },
			],
		});

		const ensured = await ensureReachJobs();

		expect(posts()).toEqual(["channel_reach_combined_a1"]);
		expect(ensured.created).toEqual(["channel_reach_combined_a1"]);
		expect(ensured.jobs.channel_reach_basic_a1.id).toBe("job-existing");
		expect(ensured.jobs.channel_reach_combined_a1.id).toBe("job-channel_reach_combined_a1");
	});

	test("reconnecting a different account does not reuse the remembered jobs", async () => {
		serveReporting();
		await ensureReachJobs();
		expect(posts()).toHaveLength(2);

		await writeToken("refresh-B");
		serveReporting({ jobs: [] });
		const again = await ensureReachJobs();

		expect(again.created).toHaveLength(2);
		expect(posts()).toHaveLength(4);
	});

	for (const order of ["earlier listed first", "later listed first"]) {
		test(`when two reports exist for one day only the one with the later createTime is downloaded (${order})`, async () => {
			const earlier = {
				id: "r-early",
				startTime: "2026-11-01T08:00:00Z",
				createTime: "2026-11-03T01:00:00Z",
				downloadUrl: `https://${REPORTING}/v1/media/early`,
			};
			const later = {
				id: "r-late",
				startTime: "2026-11-01T08:00:00Z",
				createTime: "2026-11-03T09:00:00Z",
				downloadUrl: `https://${REPORTING}/v1/media/late`,
			};
			serveReporting({
				reports: { "job-channel_reach_basic_a1": order === "earlier listed first" ? [earlier, later] : [later, earlier] },
				downloads: {
					"/v1/media/early": `${CSV_HEADER}\n20261101,UCabc,${VIDEO},111,0.10\n`,
					"/v1/media/late": `${CSV_HEADER}\n20261101,UCabc,${VIDEO},222,0.10\n`,
				},
			});

			const result = await reach();

			const downloaded = calls.filter(call => call.url.pathname.startsWith("/v1/media/")).map(call => call.url.pathname);
			expect(downloaded).toEqual(["/v1/media/late"]);
			expect(result.content[0]?.text).toMatch(/impressions 222\b/);
			expect(result.content[0]?.text).not.toMatch(/impressions 111\b/);
		});
	}

	test("CTR across days is weighted by impressions: 100 at 10% and 300 at 2% is 4.00%, not the 6% mean of the daily rates", async () => {
		serveReporting({
			reports: {
				"job-channel_reach_basic_a1": [
					{ id: "r1", startTime: "2026-11-01T08:00:00Z", createTime: "2026-11-02T09:00:00Z", downloadUrl: `https://${REPORTING}/v1/media/day1` },
					{ id: "r2", startTime: "2026-11-02T08:00:00Z", createTime: "2026-11-03T09:00:00Z", downloadUrl: `https://${REPORTING}/v1/media/day2` },
				],
			},
			downloads: {
				"/v1/media/day1": `${CSV_HEADER}\n20261101,UCabc,${VIDEO},100,0.10\n`,
				"/v1/media/day2": `${CSV_HEADER}\n20261102,UCabc,${VIDEO},300,0.02\n`,
			},
		});

		const result = await reach({ videoId: `https://youtu.be/${VIDEO}` });

		const text = result.content[0]?.text ?? "";
		expect(text).toMatch(new RegExp(`${VIDEO}\\s+impressions 400\\s+CTR 4\\.00%`));
		expect(text).not.toMatch(/CTR 6\.00%/);
	});

	test("a 403 about insufficient authentication scopes surfaces the reconnect message", async () => {
		serve(() => Response.json({ error: { message: "Request had insufficient authentication scopes." } }, { status: 403 }));

		await expect(reach()).rejects.toThrow(MISSING_ANALYTICS_SCOPE);
	});

	test("a 403 that is not about scopes is reported as it is, not as a reconnect", async () => {
		serve(() => Response.json({ error: { message: "YouTube Reporting API has not been used in project 123 before or it is disabled." } }, { status: 403 }));

		const failure = await reach().then(
			() => null,
			(error: Error) => error,
		);

		expect(failure?.message).toMatch(/has not been used in project 123/);
		expect(failure?.message).not.toBe(MISSING_ANALYTICS_SCOPE);
	});
});

describe("youtube_video_analytics", () => {
	const VIDEO = "dQw4w9WgXcQ";

	function analytics(params: Record<string, unknown>): Promise<{ content: { text: string }[] }> {
		return (createVideoAnalyticsTool() as unknown as Tool).execute("call-1", params);
	}

	function table(columns: string[], rows: (string | number)[][]): Response {
		return Response.json({ columnHeaders: columns.map(name => ({ name })), rows });
	}

	function serveAnalytics(): void {
		serve(call => {
			if (call.url.host !== "youtubeanalytics.googleapis.com" || call.url.pathname !== "/v2/reports") {
				throw new Error(`unexpected request ${call.method} ${call.url}`);
			}
			const dimensions = call.url.searchParams.get("dimensions");
			if (dimensions === "insightTrafficSourceType") {
				return table(
					["insightTrafficSourceType", "views", "engagedViews", "estimatedMinutesWatched"],
					[
						["YT_SEARCH", 120, 100, 30],
						["SUBSCRIBER", 7, 7, 3],
						["PLAYLIST", 0, 0, 0],
					],
				);
			}
			if (dimensions === "elapsedVideoTimeRatio") return table(["elapsedVideoTimeRatio", "audienceWatchRatio", "relativeRetentionPerformance"], []);
			return table(
				["views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage"],
				[[200, 150, 50, 90, 45.5]],
			);
		});
	}

	test("per-source average seconds are watch minutes times 60 over views, and every query is scoped to the one video and the given dates", async () => {
		serveAnalytics();

		const result = await analytics({ videoId: `https://youtu.be/${VIDEO}`, startDate: "2026-10-01", endDate: "2026-10-28" });

		const text = result.content[0]?.text ?? "";
		expect(text).toMatch(/YT_SEARCH.*avg 15s/);
		expect(text).toMatch(/SUBSCRIBER.*avg 26s/);
		expect(text).toMatch(/PLAYLIST.*avg n\/a/);
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.url.searchParams.get("ids")).toBe("channel==MINE");
			expect(call.url.searchParams.get("filters")).toBe(`video==${VIDEO}`);
			expect(call.url.searchParams.get("startDate")).toBe("2026-10-01");
			expect(call.url.searchParams.get("endDate")).toBe("2026-10-28");
		}
	});

	const BAD_DATES: [string, Record<string, string>][] = [
		["a startDate with unpadded month and day", { startDate: "2026-1-1" }],
		["a startDate in slash form", { startDate: "11/01/2026" }],
		["an endDate that is a word", { endDate: "tomorrow" }],
		["an endDate with a time part", { endDate: "2026-11-01T00:00:00Z" }],
	];
	for (const [label, dates] of BAD_DATES) {
		test(`${label} is refused before any request`, async () => {
			await expect(analytics({ videoId: VIDEO, ...dates })).rejects.toThrow();
			expect(calls).toEqual([]);
		});
	}

	test("a 403 about insufficient scopes on the analytics query surfaces the reconnect message", async () => {
		serve(() => Response.json({ error: { message: "Insufficient Permission: Request had insufficient authentication scopes." } }, { status: 403 }));

		await expect(analytics({ videoId: VIDEO, startDate: "2026-10-01", endDate: "2026-10-28" })).rejects.toThrow(MISSING_ANALYTICS_SCOPE);
	});
});
