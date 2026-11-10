import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";

export function configFile(name: string): string {
	return join(homedir(), ".config", "dimension-youtube", name);
}

const CONNECT_TARGET = "token.json";
const CHANNELS_DIR = "channels";
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
	channelId: "string",
	title: "string",
	"handle?": "string",
	connectedAt: "string",
});
export type ConnectedChannel = typeof connectedChannel.infer;

export const NOT_CONNECTED =
	"No YouTube channel is connected yet. Open Plugins → YouTube → Connect and sign in with the Google account (and pick the channel) to add it; connect again to add each further channel.";

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf-8"));
}

function channelFile(channelId: string): string {
	return configFile(join(CHANNELS_DIR, `${channelId}.json`));
}

async function writeChannel(channel: ConnectedChannel): Promise<void> {
	const file = channelFile(channel.channelId);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(channel, null, 2));
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

async function adoptConnectedToken(known: readonly ConnectedChannel[]): Promise<ConnectedChannel | undefined> {
	const raw = await readJson(configFile(CONNECT_TARGET)).catch(() => undefined);
	if (raw === undefined) return undefined;
	const parsed = storedCredential(raw);
	if (parsed instanceof type.errors) return undefined;
	if (known.some(channel => channel.refresh === parsed.refresh)) return undefined;
	const cred = await refreshed(parsed);
	const res = await fetch(`${YOUTUBE_API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${cred.access}` } });
	const payload = (await res.json().catch(() => null)) as { items?: MineChannel[] } | null;
	const mine = payload?.items?.[0];
	if (!res.ok || !mine?.id) {
		throw new Error(
			`The Google account that just connected has no YouTube channel YouTube would name (${googleError(payload, res.statusText)}). Connect again and pick the account or brand account that owns the channel.`,
		);
	}
	const channel: ConnectedChannel = {
		...cred,
		channelId: mine.id,
		title: mine.snippet?.title ?? mine.id,
		...(mine.snippet?.customUrl ? { handle: mine.snippet.customUrl } : {}),
		connectedAt: new Date().toISOString(),
	};
	await writeChannel(channel);
	return channel;
}

let pendingAdoption: Promise<ConnectedChannel[]> | undefined;

export function connectedChannels(): Promise<ConnectedChannel[]> {
	pendingAdoption ??= (async () => {
		const known = await listedChannels();
		const adopted = await adoptConnectedToken(known);
		if (adopted === undefined) return known;
		return [...known.filter(channel => channel.channelId !== adopted.channelId), adopted];
	})().finally(() => {
		pendingAdoption = undefined;
	});
	return pendingAdoption;
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
	const found = channels.find(channel => matches(channel, wanted));
	if (!found) {
		throw new Error(
			`No connected channel is "${wanted}". Connected: ${channels.map(channelLabel).join("; ")}. To add it, connect again (Plugins → YouTube → Connect) and pick that channel.`,
		);
	}
	return found;
}

export async function tokenOf(channel: ConnectedChannel): Promise<string> {
	const fresh = await refreshed(channel);
	if (fresh !== channel) await writeChannel(fresh);
	return fresh.access;
}

export async function channelToken(wanted?: string): Promise<string> {
	return tokenOf(await channelFor(wanted));
}

export async function anyToken(): Promise<string> {
	const [first] = await connectedChannels();
	if (!first) throw new Error(NOT_CONNECTED);
	return tokenOf(first);
}

export async function ownerOfVideo(videoId: string): Promise<ConnectedChannel> {
	const channels = await connectedChannels();
	if (channels.length === 0) throw new Error(NOT_CONNECTED);
	const only = channels[0];
	if (channels.length === 1 && only) return only;
	let owner: { channelId?: string; channelTitle?: string } | undefined;
	for (const channel of channels) {
		const listed = await youtubeJson<{ items?: { snippet?: { channelId?: string; channelTitle?: string } }[] }>(
			`/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
			await tokenOf(channel),
			"videos.list",
		);
		owner = listed.items?.[0]?.snippet;
		if (owner?.channelId) break;
	}
	if (!owner?.channelId) throw new Error(`YouTube returned no video ${videoId} to any connected channel.`);
	const found = channels.find(channel => channel.channelId === owner.channelId);
	if (!found) {
		throw new Error(
			`Video ${videoId} belongs to ${owner.channelTitle ?? owner.channelId} [${owner.channelId}], which is not connected. Connect it (Plugins → YouTube → Connect, pick that channel), or read it in YouTube Studio.`,
		);
	}
	return found;
}

export async function forgetChannel(channel: ConnectedChannel): Promise<void> {
	if (!CHANNEL_ID.test(channel.channelId)) throw new Error(`${channel.channelId} is not a channel id.`);
	const connecting = storedCredential(await readJson(configFile(CONNECT_TARGET)).catch(() => null));
	if (!(connecting instanceof type.errors) && connecting.refresh === channel.refresh) {
		await rm(configFile(CONNECT_TARGET), { force: true });
	}
	await rm(channelFile(channel.channelId), { force: true });
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
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		throw new Error(`YouTube ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

export function videoIdOf(input: string): string {
	const trimmed = input.trim();
	const fromUrl = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(trimmed);
	return fromUrl?.[1] ?? trimmed;
}

export const MISSING_ANALYTICS_SCOPE =
	"YouTube refused: this channel was connected before the plugin asked for YouTube Analytics access (yt-analytics.readonly). Connect it again (Plugins → YouTube → Connect, pick the same channel), with the YouTube Analytics API and the YouTube Reporting API enabled in the same Google Cloud project.";

export function googleError(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error: unknown = Reflect.get(payload, "error");
	if (typeof error === "object" && error !== null) {
		const message: unknown = Reflect.get(error, "message");
		if (typeof message === "string" && message.length > 0) return message;
	}
	return fallback;
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
