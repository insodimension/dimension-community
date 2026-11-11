import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";

export function configFile(name: string): string {
	return join(homedir(), ".config", "dimension-youtube", name);
}

const CONNECT_TARGET = "token.json";
const CHANNELS_DIR = "channels";
const CONNECT_SEEN = "connect-seen";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const REFRESH_SKEW_MS = 60_000;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
});
type StoredCredential = typeof storedCredential.infer;

const connectedChannel = storedCredential.and({
	channelId: type(CHANNEL_ID),
	title: "string",
	"handle?": "string",
	connectedAt: "string",
	connectedWith: "string",
});
export type ConnectedChannel = typeof connectedChannel.infer;

function fingerprint(refresh: string): string {
	return createHash("sha256").update(refresh).digest("hex").slice(0, 32);
}

function signedInWith(channel: ConnectedChannel, connecting: StoredCredential): boolean {
	return channel.refresh === connecting.refresh || channel.connectedWith === fingerprint(connecting.refresh);
}

export const NOT_CONNECTED =
	"No YouTube channel is connected yet. Open Plugins → YouTube → Connect and sign in with the Google account (and pick the channel) to add it; connect again to add each further channel.";

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf-8"));
}

function channelFile(channelId: string): string {
	if (!CHANNEL_ID.test(channelId)) throw new Error(`${channelId} is not a channel id.`);
	return configFile(join(CHANNELS_DIR, `${channelId}.json`));
}

const forgotten = new Set<string>();
const fresh = new Map<string, { from: string; renewed: ConnectedChannel }>();

async function writeChannel(channel: ConnectedChannel): Promise<void> {
	if (forgotten.has(channel.channelId)) return;
	const file = channelFile(channel.channelId);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(channel, null, 2), { mode: 0o600 });
}

async function refreshed<T extends StoredCredential>(cred: T): Promise<T> {
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(`YouTube token refresh failed: ${detail}. Connect that channel again (Plugins → YouTube → Connect).`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	return {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

async function listedChannels(): Promise<ConnectedChannel[]> {
	let names: string[];
	try {
		names = await readdir(configFile(CHANNELS_DIR));
	} catch {
		return [];
	}
	const channels: ConnectedChannel[] = [];
	for (const name of names.filter(entry => entry.endsWith(".json")).sort()) {
		const parsed = connectedChannel(await readJson(configFile(join(CHANNELS_DIR, name))).catch(() => null));
		if (!(parsed instanceof type.errors)) channels.push(parsed);
	}
	return channels;
}

interface MineChannel {
	readonly id?: string;
	readonly snippet?: { readonly title?: string; readonly customUrl?: string };
}

async function adoptConnectedToken(
	connecting: StoredCredential,
	known: readonly ConnectedChannel[],
): Promise<ConnectedChannel | undefined> {
	if (known.some(channel => signedInWith(channel, connecting))) return undefined;
	const cred = await refreshed(connecting);
	const res = await fetch(`${YOUTUBE_API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${cred.access}` } });
	const payload = (await res.json().catch(() => null)) as { items?: MineChannel[] } | null;
	const mine = payload?.items?.[0];
	if (!res.ok || !mine?.id || !CHANNEL_ID.test(mine.id)) {
		const reason = googleError(payload, res.statusText);
		throw new Error(
			isQuotaRefusal(payload)
				? `YouTube would not name the channel for the Google account that last connected: ${reason}`
				: `The Google account that last connected has no YouTube channel YouTube would name (${reason}). Connect again and pick the account or brand account that owns the channel.`,
		);
	}
	const channel: ConnectedChannel = {
		...cred,
		channelId: mine.id,
		title: mine.snippet?.title ?? mine.id,
		...(mine.snippet?.customUrl ? { handle: mine.snippet.customUrl } : {}),
		connectedAt: new Date().toISOString(),
		connectedWith: fingerprint(connecting.refresh),
	};
	forgotten.delete(channel.channelId);
	await writeChannel(channel);
	return channel;
}

async function disconnectAll(): Promise<void> {
	await rm(configFile(CHANNELS_DIR), { recursive: true, force: true });
	await rm(configFile(CONNECT_SEEN), { force: true });
	fresh.clear();
}

let lastAdoptionError: string | undefined;

export function adoptionProblem(): string | undefined {
	return lastAdoptionError;
}

async function readConnectTarget(): Promise<unknown> {
	try {
		return JSON.parse(await readFile(configFile(CONNECT_TARGET), "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return null;
	}
}

async function loadChannels(): Promise<ConnectedChannel[]> {
	const raw = await readConnectTarget();
	if (raw === undefined) {
		if (await stat(configFile(CONNECT_SEEN)).then(() => true, () => false)) await disconnectAll();
		lastAdoptionError = undefined;
		return listedChannels();
	}
	await mkdir(configFile(""), { recursive: true });
	await writeFile(configFile(CONNECT_SEEN), "", { flag: "a" });
	const known = await listedChannels();
	const connecting = storedCredential(raw);
	if (connecting instanceof type.errors) return known;
	try {
		const adopted = await adoptConnectedToken(connecting, known);
		lastAdoptionError = undefined;
		if (adopted === undefined) return known;
		return [...known.filter(channel => channel.channelId !== adopted.channelId), adopted];
	} catch (error) {
		lastAdoptionError = error instanceof Error ? error.message : String(error);
		if (known.length === 0) throw error;
		return known;
	}
}

let pendingLoad: Promise<ConnectedChannel[]> | undefined;

export function connectedChannels(): Promise<ConnectedChannel[]> {
	pendingLoad ??= loadChannels().finally(() => {
		pendingLoad = undefined;
	});
	return pendingLoad;
}

export function channelLabel(channel: ConnectedChannel): string {
	return `${channel.title}${channel.handle ? ` (${channel.handle})` : ""} [${channel.channelId}]`;
}

function matches(channel: ConnectedChannel, wanted: string): boolean {
	const key = wanted.trim().toLowerCase();
	const bare = key.replace(/^@/, "");
	return (
		channel.channelId.toLowerCase() === key ||
		channel.title.toLowerCase() === key ||
		(channel.handle !== undefined && channel.handle.toLowerCase().replace(/^@/, "") === bare)
	);
}

export async function channelFor(wanted: string | undefined): Promise<ConnectedChannel> {
	const channels = await connectedChannels();
	if (channels.length === 0) throw new Error(NOT_CONNECTED);
	if (wanted === undefined || wanted.trim() === "") {
		const only = channels[0];
		if (channels.length === 1 && only) return only;
		throw new Error(
			`Several channels are connected; pass channel as one of: ${channels.map(channelLabel).join("; ")}.`,
		);
	}
	const found = channels.filter(channel => matches(channel, wanted));
	const [one] = found;
	if (found.length === 1 && one) return one;
	if (found.length > 1) {
		throw new Error(`"${wanted}" names more than one connected channel; pass its id: ${found.map(channelLabel).join("; ")}.`);
	}
	throw new Error(
		`No connected channel is "${wanted}". Connected: ${channels.map(channelLabel).join("; ")}. To add it, connect again (Plugins → YouTube → Connect) and pick that channel.`,
	);
}

export async function tokenOf(channel: ConnectedChannel): Promise<string> {
	const held = fresh.get(channel.channelId);
	const current = held && (held.from === channel.refresh || held.renewed.refresh === channel.refresh) ? held.renewed : channel;
	const renewed = await refreshed(current);
	if (renewed !== current) await writeChannel(renewed);
	fresh.set(channel.channelId, { from: channel.refresh, renewed });
	return renewed.access;
}

export async function channelToken(wanted?: string): Promise<string> {
	return tokenOf(await channelFor(wanted));
}

async function firstWorking<T>(
	channels: readonly ConnectedChannel[],
	attempt: (channel: ConnectedChannel) => Promise<T | undefined>,
): Promise<T | undefined> {
	const failures: string[] = [];
	for (const channel of channels) {
		try {
			const result = await attempt(channel);
			if (result !== undefined) return result;
		} catch (error) {
			failures.push(`${channelLabel(channel)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length === channels.length && failures.length > 0) throw new Error(failures.join("\n"));
	return undefined;
}

export async function readToken(wanted?: string): Promise<string> {
	if (wanted?.trim()) return channelToken(wanted);
	const channels = await connectedChannels();
	if (channels.length === 0) throw new Error(NOT_CONNECTED);
	return (await firstWorking(channels, tokenOf)) as string;
}

export async function ownerOfVideo(videoId: string): Promise<ConnectedChannel> {
	const channels = await connectedChannels();
	if (channels.length === 0) throw new Error(NOT_CONNECTED);
	const only = channels[0];
	if (channels.length === 1 && only) return only;
	const owner = await firstWorking(channels, async channel => {
		const listed = await youtubeJson<{ items?: { snippet?: { channelId?: string; channelTitle?: string } }[] }>(
			`/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
			await tokenOf(channel),
			"videos.list",
		);
		const snippet = listed.items?.[0]?.snippet;
		return snippet?.channelId ? { channelId: snippet.channelId, channelTitle: snippet.channelTitle } : undefined;
	});
	if (!owner) throw new Error(`YouTube returned no video ${videoId} to any connected channel.`);
	const found = channels.find(channel => channel.channelId === owner.channelId);
	if (!found) {
		throw new Error(
			`Video ${videoId} belongs to ${owner.channelTitle ?? owner.channelId} [${owner.channelId}], which is not connected. Connect it (Plugins → YouTube → Connect, pick that channel), or read it in YouTube Studio.`,
		);
	}
	return found;
}

export async function forgetChannel(channel: ConnectedChannel): Promise<void> {
	const file = channelFile(channel.channelId);
	forgotten.add(channel.channelId);
	fresh.delete(channel.channelId);
	const connecting = storedCredential(await readJson(configFile(CONNECT_TARGET)).catch(() => null));
	if (!(connecting instanceof type.errors) && signedInWith(channel, connecting)) {
		await rm(configFile(CONNECT_TARGET), { force: true });
		await rm(configFile(CONNECT_SEEN), { force: true });
	}
	await rm(file, { force: true });
}

export async function youtubeFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${YOUTUBE_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("YouTube rejected the access token (401). Connect that channel again (Plugins → YouTube → Connect).");
	}
	return res;
}

export async function youtubeJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await youtubeFetch(path, accessToken, init);
	const payload: unknown = await res.json().catch(() => null);
	if (!res.ok || !payload) {
		throw new Error(`YouTube ${op} failed: ${googleError(payload, res.statusText)}`);
	}
	return payload as T;
}

export function videoIdOf(input: string): string {
	const trimmed = input.trim();
	const fromUrl = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(trimmed);
	return fromUrl?.[1] ?? trimmed;
}

export const MISSING_ANALYTICS_SCOPE =
	"YouTube refused: this channel was connected before the plugin asked for YouTube Analytics access (yt-analytics.readonly). Connect it again (Plugins → YouTube → Connect, pick the same channel), with the YouTube Analytics API and the YouTube Reporting API enabled in the same Google Cloud project.";

const QUOTA_REASON = /^(quotaExceeded|dailyLimitExceeded|rateLimitExceeded)$/;

const QUOTA_HINT =
	"Two causes: today's 10,000 units are spent (they return at midnight Pacific), or the project's \"Queries per day\" limit for the YouTube Data API v3 is 0 and never refills, so connecting again cannot fix it. The limit is shown at https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas; at 0, use a new Google Cloud project (its default is 10,000 a day) or ask YouTube for more quota with its API compliance audit form.";

function errorBody(payload: unknown): object | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const error: unknown = Reflect.get(payload, "error");
	return typeof error === "object" && error !== null ? error : undefined;
}

export function isQuotaRefusal(payload: unknown): boolean {
	const error = errorBody(payload);
	if (!error) return false;
	const message: unknown = Reflect.get(error, "message");
	if (typeof message === "string" && /\bquota\b/i.test(message)) return true;
	const entries: unknown = Reflect.get(error, "errors");
	return (
		Array.isArray(entries) &&
		entries.some(entry => typeof entry === "object" && entry !== null && QUOTA_REASON.test(String(Reflect.get(entry, "reason"))))
	);
}

export function googleError(payload: unknown, fallback: string): string {
	const error = errorBody(payload);
	const message: unknown = error && Reflect.get(error, "message");
	if (typeof message !== "string" || message.length === 0) return fallback;
	return isQuotaRefusal(payload) ? `${message} ${QUOTA_HINT}` : message;
}

export async function googleJson<T>(url: string, accessToken: string, label: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: { Authorization: `Bearer ${accessToken}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
	});
	const payload: unknown = await res.json().catch(() => null);
	if (!res.ok || payload === null) {
		const message = googleError(payload, res.statusText);
		if (res.status === 403 && /insufficient|scope/i.test(message)) throw new Error(MISSING_ANALYTICS_SCOPE);
		throw new Error(`${label} failed: ${message}`);
	}
	return payload as T;
}
