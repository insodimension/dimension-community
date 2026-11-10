import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { type ConnectedChannel, channelFor, channelLabel, configFile, connectedChannels, googleJson, NOT_CONNECTED, ownerOfVideo, tokenOf, videoIdOf } from "./api";

const REPORTING_API = "https://youtubereporting.googleapis.com/v1";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const REACH_JOBS_DIR = "reach-jobs";
const REACH_REPORT_TYPES = ["channel_reach_basic_a1", "channel_reach_combined_a1"] as const;
type ReachReportType = (typeof REACH_REPORT_TYPES)[number];
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_DAYS = 28;
const MAX_REACH_DAYS = 60;
const TOP_VIDEOS = 25;
const RETENTION_POINTS = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;
const PARALLEL_DOWNLOADS = 6;

const TRAFFIC_SOURCE_NAMES: Readonly<Record<string, string>> = {
	"0": "Direct or unknown",
	"1": "YouTube advertising",
	"3": "Browse features",
	"4": "Channel pages",
	"5": "YouTube search",
	"7": "Suggested videos",
	"8": "Other YouTube features",
	"9": "External",
	"11": "Cards and annotations",
	"14": "Playlists",
	"17": "Notifications",
	"18": "Playlist pages",
	"19": "Programming from claimed content",
	"20": "End screens",
	"23": "Stories",
	"24": "Shorts feed",
	"25": "Product pages",
	"26": "Hashtag pages",
	"27": "Sound pages",
	"28": "Live redirect",
	"29": "Podcasts",
	"30": "Remixed video",
	"31": "Vertical live feed",
	"32": "Related video",
};

interface ReportingJob {
	readonly id: string;
	readonly reportTypeId: string;
	readonly createTime?: string;
}

interface ReportFile {
	readonly id: string;
	readonly startTime: string;
	readonly createTime: string;
	readonly downloadUrl: string;
}

const reachJobsRecord = type({
	credential: "string",
	jobs: type({ "[string]": { id: "string", "createTime?": "string" } }),
});
type ReachJobs = typeof reachJobsRecord.infer;

async function reportingJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	return googleJson<T>(`${REPORTING_API}${path}`, accessToken, `YouTube Reporting ${op}`, init);
}

function reachJobsFile(channelId: string): string {
	return configFile(join(REACH_JOBS_DIR, `${channelId}.json`));
}

async function readReachJobs(channelId: string): Promise<ReachJobs | undefined> {
	try {
		const parsed = reachJobsRecord(JSON.parse(await readFile(reachJobsFile(channelId), "utf-8")));
		return parsed instanceof type.errors ? undefined : parsed;
	} catch {
		return undefined;
	}
}

export interface EnsuredReachJobs {
	readonly jobs: Readonly<Record<ReachReportType, { readonly id: string; readonly createTime?: string }>>;
	readonly created: readonly ReachReportType[];
}

const pendingReachJobs = new Map<string, Promise<EnsuredReachJobs>>();

export function ensureReachJobs(channel: ConnectedChannel): Promise<EnsuredReachJobs> {
	let pending = pendingReachJobs.get(channel.channelId);
	if (!pending) {
		pending = loadOrCreateReachJobs(channel).finally(() => pendingReachJobs.delete(channel.channelId));
		pendingReachJobs.set(channel.channelId, pending);
	}
	return pending;
}

export async function ensureAllReachJobs(): Promise<void> {
	for (const channel of await connectedChannels()) await ensureReachJobs(channel).catch(() => undefined);
}

async function loadOrCreateReachJobs(channel: ConnectedChannel): Promise<EnsuredReachJobs> {
	const credential = createHash("sha256").update(channel.refresh).digest("hex").slice(0, 16);
	const known = await readReachJobs(channel.channelId);
	if (known?.credential === credential && REACH_REPORT_TYPES.every(id => known.jobs[id] !== undefined)) {
		return { jobs: known.jobs as EnsuredReachJobs["jobs"], created: [] };
	}
	const accessToken = await tokenOf(channel);
	const listed = await reportingJson<{ jobs?: ReportingJob[] }>("/jobs", accessToken, "jobs.list");
	const jobs: Record<string, { id: string; createTime?: string }> = {};
	for (const job of listed.jobs ?? []) {
		if ((REACH_REPORT_TYPES as readonly string[]).includes(job.reportTypeId)) {
			jobs[job.reportTypeId] = { id: job.id, createTime: job.createTime };
		}
	}
	const created: ReachReportType[] = [];
	for (const reportTypeId of REACH_REPORT_TYPES) {
		if (jobs[reportTypeId] !== undefined) continue;
		const job = await reportingJson<ReportingJob>("/jobs", accessToken, "jobs.create", {
			method: "POST",
			body: JSON.stringify({ reportTypeId, name: `dimension ${reportTypeId}` }),
		});
		jobs[reportTypeId] = { id: job.id, createTime: job.createTime ?? new Date().toISOString() };
		created.push(reportTypeId);
	}
	const file = reachJobsFile(channel.channelId);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ credential, jobs }, null, 2));
	return { jobs: jobs as EnsuredReachJobs["jobs"], created };
}

export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			row.push(field);
			if (row.some(value => value !== "")) rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	row.push(field);
	if (row.some(value => value !== "")) rows.push(row);
	return rows;
}

async function latestReportsSince(jobId: string, since: Date, accessToken: string): Promise<ReportFile[]> {
	const byDay = new Map<string, ReportFile>();
	let pageToken: string | undefined;
	do {
		const query = new URLSearchParams({ startTimeAtOrAfter: since.toISOString() });
		if (pageToken) query.set("pageToken", pageToken);
		const page = await reportingJson<{ reports?: ReportFile[]; nextPageToken?: string }>(
			`/jobs/${encodeURIComponent(jobId)}/reports?${query.toString()}`,
			accessToken,
			"reports.list",
		);
		for (const report of page.reports ?? []) {
			const current = byDay.get(report.startTime);
			if (!current || current.createTime < report.createTime) byDay.set(report.startTime, report);
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return [...byDay.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
}

async function downloadRows(report: ReportFile, accessToken: string): Promise<Record<string, string>[]> {
	const res = await fetch(report.downloadUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`YouTube Reporting download of the ${report.startTime.slice(0, 10)} report failed: ${res.statusText}`);
	const [header, ...rows] = parseCsv(await res.text());
	if (!header) return [];
	return rows.map(values => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

interface ReachTotals {
	impressions: number;
	clicks: number;
}

export function addReach(totals: Map<string, ReachTotals>, key: string, row: Record<string, string>): void {
	const impressions = Number(row.video_thumbnail_impressions);
	const ctr = Number(row.video_thumbnail_impressions_ctr);
	if (!Number.isFinite(impressions)) return;
	const entry = totals.get(key) ?? { impressions: 0, clicks: 0 };
	entry.impressions += impressions;
	entry.clicks += Number.isFinite(ctr) ? impressions * ctr : 0;
	totals.set(key, entry);
}

function reachLine(label: string, totals: ReachTotals): string {
	const ctr = totals.impressions > 0 ? `${((totals.clicks / totals.impressions) * 100).toFixed(2)}%` : "n/a";
	return `${label}  impressions ${Math.round(totals.impressions)}  CTR ${ctr}`;
}

const reachReportSchema = type({
	"videoId?": type("string").describe("A video id or URL to report on alone (its own channel is used); omit for each channel's top videos by impressions."),
	"channel?": type("string").describe("One connected channel (title, @handle or id); omit for every connected channel."),
	"days?": type("number").describe(`Days back to read, default ${DEFAULT_DAYS}, at most ${MAX_REACH_DAYS} (YouTube keeps reports 60 days).`),
	"bySource?": type("boolean").describe("Break impressions and CTR down by traffic source (the combined reach report) instead of by video."),
});
type ReachParams = typeof reachReportSchema.infer;

async function reachSection(channel: ConnectedChannel, params: ReachParams, videoId: string | undefined): Promise<string[]> {
	const heading = channelLabel(channel);
	const ensured = await ensureReachJobs(channel);
	const reportType: ReachReportType = params.bySource ? "channel_reach_combined_a1" : "channel_reach_basic_a1";
	const job = ensured.jobs[reportType];
	const days = Math.min(Math.max(Math.round(params.days ?? DEFAULT_DAYS), 1), MAX_REACH_DAYS);
	const since = new Date(Date.now() - days * DAY_MS);
	const accessToken = await tokenOf(channel);
	const reports = await latestReportsSince(job.id, since, accessToken);
	if (reports.length === 0) {
		const started = job.createTime ? ` (job created ${job.createTime})` : "";
		return [
			`${heading}: no ${reportType} reports yet${started}. YouTube generates the first ones within 48 hours of the job, then one a day; read Studio until then.`,
		];
	}
	const totals = new Map<string, ReachTotals>();
	const perDay = new Map<string, ReachTotals>();
	for (let start = 0; start < reports.length; start += PARALLEL_DOWNLOADS) {
		const batch = reports.slice(start, start + PARALLEL_DOWNLOADS);
		const downloaded = await Promise.all(batch.map(report => downloadRows(report, accessToken)));
		downloaded.forEach((rows, index) => {
			const day = batch[index]?.startTime.slice(0, 10) ?? "?";
			for (const row of rows) {
				if (videoId && row.video_id !== videoId) continue;
				const key = params.bySource
					? (TRAFFIC_SOURCE_NAMES[row.traffic_source_type ?? ""] ?? `source ${row.traffic_source_type}`)
					: (row.video_id ?? "?");
				addReach(totals, key, row);
				if (videoId) addReach(perDay, row.date ?? day, row);
			}
		});
	}
	const first = reports[0]?.startTime.slice(0, 10);
	const last = reports.at(-1)?.startTime.slice(0, 10);
	const ranked = [...totals.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
	return [
		`${heading} — ${reportType}: ${reports.length} daily reports, ${first} to ${last}${videoId ? `, video ${videoId}` : ""}.`,
		...(ranked.length === 0
			? ["No impressions in these reports."]
			: ranked.slice(0, videoId || params.bySource ? ranked.length : TOP_VIDEOS).map(([key, value]) => reachLine(key, value))),
		...(videoId && perDay.size > 0
			? ["By day:", ...[...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => reachLine(`  ${day}`, value))]
			: []),
	];
}

export function createReachReportTool(): ToolDefinition<typeof reachReportSchema> {
	return {
		name: "youtube_reach_report",
		label: "YouTube: Reach report",
		description:
			"Thumbnail impressions and impressions click-through rate for connected channels' videos, from the YouTube Reporting API reach reports (channel_reach_basic_a1, and channel_reach_combined_a1 by traffic source). A video id reports that video on the channel that owns it; otherwise one channel, or every connected channel. Daily reports, Pacific days, arriving about a day late; YouTube starts them only once a channel's job exists, with 30 days of history, so the first ones can take up to 48 hours. Studio stays the only source for a video's first 48 hours.",
		parameters: reachReportSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: ReachParams) {
			const videoId = params.videoId ? videoIdOf(params.videoId) : undefined;
			const channels = videoId
				? [await ownerOfVideo(videoId)]
				: params.channel
					? [await channelFor(params.channel)]
					: await connectedChannels();
			if (channels.length === 0) throw new Error(NOT_CONNECTED);
			const sections: string[] = [];
			for (const channel of channels) {
				if (channels.length === 1) {
					sections.push(...(await reachSection(channel, params, videoId)), "");
					continue;
				}
				const section = await reachSection(channel, params, videoId).catch((error: unknown) => [
					`${channelLabel(channel)}: ${error instanceof Error ? error.message : String(error)}`,
				]);
				sections.push(...section, "");
			}
			sections.push("CTR is clicks over impressions, weighted by impressions across days.");
			return { content: [{ type: "text" as const, text: sections.join("\n") }] };
		},
	};
}

interface AnalyticsResponse {
	readonly columnHeaders?: readonly { readonly name: string }[];
	readonly rows?: readonly (readonly (string | number)[])[];
}

async function analyticsQuery(query: Record<string, string>, accessToken: string): Promise<Record<string, string | number>[]> {
	const search = new URLSearchParams({ ids: "channel==MINE", ...query });
	const { columnHeaders = [], rows = [] } = await googleJson<AnalyticsResponse>(
		`${ANALYTICS_API}?${search.toString()}`,
		accessToken,
		"YouTube Analytics reports.query",
	);
	return rows.map(row => Object.fromEntries(columnHeaders.map((header, index) => [header.name, row[index] ?? ""])));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const videoAnalyticsSchema = type({
	videoId: type("string").describe("The connected channel's video, by id or URL."),
	"startDate?": type("string").describe(`First day, YYYY-MM-DD (Pacific). Default ${DEFAULT_DAYS} days ago.`),
	"endDate?": type("string").describe("Last day, YYYY-MM-DD (Pacific). Default today."),
});

export function createVideoAnalyticsTool(): ToolDefinition<typeof videoAnalyticsSchema> {
	return {
		name: "youtube_video_analytics",
		label: "YouTube: Video analytics",
		description:
			"A video on any connected channel (the channel that owns it is used) in YouTube Analytics (API v2): views, engaged views, watch time, average view duration and average percentage viewed; views, engaged views and watch time by traffic source; and the audience retention curve (audienceWatchRatio). Analytics trails by about two days, so Studio is the only source for a video's first 48 hours.",
		parameters: videoAnalyticsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof videoAnalyticsSchema.infer) {
			const videoId = videoIdOf(params.videoId);
			const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);
			const startDate = params.startDate ?? new Date(Date.now() - DEFAULT_DAYS * DAY_MS).toISOString().slice(0, 10);
			if (!DATE.test(startDate) || !DATE.test(endDate)) throw new Error("startDate and endDate are YYYY-MM-DD.");
			const accessToken = await tokenOf(await ownerOfVideo(videoId));
			const filters = `video==${videoId}`;
			const [totals, sources, retention] = await Promise.all([
				analyticsQuery(
					{
						startDate,
						endDate,
						filters,
						metrics: "views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
					},
					accessToken,
				),
				analyticsQuery(
					{
						startDate,
						endDate,
						filters,
						dimensions: "insightTrafficSourceType",
						metrics: "views,engagedViews,estimatedMinutesWatched",
						sort: "-views",
					},
					accessToken,
				),
				analyticsQuery(
					{
						startDate,
						endDate,
						filters,
						dimensions: "elapsedVideoTimeRatio",
						metrics: "audienceWatchRatio,relativeRetentionPerformance",
					},
					accessToken,
				),
			]);
			const total = totals[0];
			const lines = [`Video ${videoId}, ${startDate} to ${endDate} (YouTube Analytics, read ${new Date().toISOString()}).`];
			if (!total || Number(total.views) === 0) {
				lines.push("No views reported in this range yet. Analytics trails about two days; read Studio for a new video.");
			} else {
				lines.push(
					`Views ${total.views}  Engaged views ${total.engagedViews}  Watch time ${total.estimatedMinutesWatched} min  Avg view duration ${total.averageViewDuration}s  Avg viewed ${Number(total.averageViewPercentage).toFixed(1)}%`,
				);
			}
			if (sources.length > 0) {
				lines.push("By traffic source (YouTube reports no average duration or percentage per source; avg is watch time over views):");
				for (const row of sources) {
					const views = Number(row.views);
					const average = views > 0 ? `${Math.round((Number(row.estimatedMinutesWatched) * 60) / views)}s` : "n/a";
					lines.push(`  ${row.insightTrafficSourceType}  views ${row.views}  engaged ${row.engagedViews}  watch ${row.estimatedMinutesWatched} min  avg ${average}`);
				}
			}
			if (retention.length > 0) {
				lines.push("Retention (share of views still watching at each point; relative is against videos of similar length, 0.5 = median):");
				for (const point of RETENTION_POINTS) {
					const nearest = retention.reduce((best, row) =>
						Math.abs(Number(row.elapsedVideoTimeRatio) - point) < Math.abs(Number(best.elapsedVideoTimeRatio) - point) ? row : best,
					);
					lines.push(
						`  ${Math.round(Number(nearest.elapsedVideoTimeRatio) * 100)}%  watch ratio ${Number(nearest.audienceWatchRatio).toFixed(2)}  relative ${Number(nearest.relativeRetentionPerformance).toFixed(2)}`,
					);
				}
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}
