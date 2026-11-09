import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

export const CONFIG_DIR = join(homedir(), ".config", "dimension-youtube");
const CONFIG_TARGET = join(CONFIG_DIR, "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const REFRESH_SKEW_MS = 60_000;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
});
export type StoredCredential = typeof storedCredential.infer;

export async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error("YouTube isn't connected yet. Open the plugin's Connect dialog (Plugins → YouTube) and sign in.");
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`YouTube's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
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
		throw new Error(`YouTube token refresh failed: ${detail}. Reconnect the plugin.`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	return refreshed;
}

export async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

export async function youtubeFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${YOUTUBE_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("YouTube rejected the access token (401). Reconnect the plugin.");
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
	"YouTube refused: the connection was made before the plugin asked for YouTube Analytics access (yt-analytics.readonly). Reconnect it: Plugins → YouTube → Reconnect, and enable the YouTube Analytics API and the YouTube Reporting API in the same Google Cloud project.";

export function googleError(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error: unknown = Reflect.get(payload, "error");
	if (typeof error === "object" && error !== null) {
		const message: unknown = Reflect.get(error, "message");
		if (typeof message === "string" && message.length > 0) return message;
	}
	return fallback;
}

export function isScopeRefusal(status: number, message: string): boolean {
	return status === 403 && /insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message);
}
