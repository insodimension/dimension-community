import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type } from "arktype";

const execFileAsync = promisify(execFile);
const PUBLIC_APPVIEW = "https://public.api.bsky.app/xrpc";
const APPVIEW_PROXY = "did:web:api.bsky.app#bsky_appview";

const storedCredential = type({ handle: "string > 0", appPassword: "string > 0" });
type Credential = typeof storedCredential.infer;

const storedSession = type({
	fingerprint: "string",
	did: "string",
	handle: "string",
	pds: "string",
	accessJwt: "string",
	refreshJwt: "string",
});

export type BlueskySession = typeof storedSession.infer;

const sessionReply = type({ did: "string", handle: "string", accessJwt: "string", refreshJwt: "string" });
const xrpcFailure = type({ "error?": "string", "message?": "string" });
const didDocument = type({
	"service?": type({ "id?": "string", "type?": "string", "serviceEndpoint?": "unknown" }).array(),
});

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export class XrpcError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
		readonly status: number,
	) {
		super(message);
	}
}

function configDir(): string {
	return join(homedir(), ".config", "dimension-bluesky");
}

let current: BlueskySession | null = null;
let pending: Promise<BlueskySession> | null = null;
let refreshing: Promise<BlueskySession> | null = null;

export function forgetSession(): void {
	current = null;
	pending = null;
	refreshing = null;
}

function queryString(query: Query): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) params.append(key, item);
		else params.set(key, String(value));
	}
	const text = params.toString();
	return text ? `?${text}` : "";
}

async function failure(res: Response, method: string): Promise<XrpcError> {
	const parsed = xrpcFailure(await res.json().catch(() => ({})));
	const body = parsed instanceof type.errors ? {} : parsed;
	if (res.status === 429) {
		return new XrpcError(
			`Bluesky rate limit hit on ${method} (429). Wait a few minutes; never retry in a loop.`,
			body.error,
			429,
		);
	}
	const detail = [body.error, body.message].filter(Boolean).join(": ") || `HTTP ${res.status}`;
	return new XrpcError(`Bluesky ${method} failed: ${detail}`, body.error, res.status);
}

export async function publicGet<T>(method: string, query: Query): Promise<T> {
	const res = await fetch(`${PUBLIC_APPVIEW}/${method}${queryString(query)}`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw await failure(res, method);
	return (await res.json()) as T;
}

async function readCredential(): Promise<Credential> {
	let raw: string;
	try {
		raw = await readFile(join(configDir(), "credential.json"), "utf8");
	} catch {
		throw new Error(
			"Bluesky isn't connected. Open Plugins, Bluesky, Connect, and enter your handle and an app password (Settings, Privacy and security, App passwords). Never paste the password in chat.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors)
		throw new Error("Bluesky's stored credential is malformed. Reconnect on the Bluesky card.");
	return { handle: parsed.handle.trim().replace(/^@/, "").toLowerCase(), appPassword: parsed.appPassword.trim() };
}

export async function resolveDid(handle: string): Promise<string> {
	const { did } = await publicGet<{ did: string }>("com.atproto.identity.resolveHandle", { handle });
	return did;
}

async function resolvePds(handle: string): Promise<string> {
	const did = await resolveDid(handle);
	const docUrl = did.startsWith("did:web:")
		? `https://${did.slice("did:web:".length)}/.well-known/did.json`
		: `https://plc.directory/${did}`;
	const res = await fetch(docUrl, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`Could not read the DID document for ${handle} (${did}): HTTP ${res.status}`);
	const doc = didDocument(await res.json());
	const services = doc instanceof type.errors ? [] : (doc.service ?? []);
	const endpoint = services.find(
		service => service.id === "#atproto_pds" || service.type === "AtprotoPersonalDataServer",
	)?.serviceEndpoint;
	if (typeof endpoint !== "string") throw new Error(`${handle} (${did}) names no PDS in its DID document.`);
	if (!/^https:\/\/[^/\s]+/i.test(endpoint))
		throw new Error(
			`${handle} (${did}) names a PDS that is not https (${endpoint}), so the app password is not sent to it.`,
		);
	return endpoint.replace(/\/+$/, "");
}

async function onlyTheUser(file: string): Promise<void> {
	if (process.platform !== "win32") return;
	const user =
		process.env.USERDOMAIN && process.env.USERNAME
			? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
			: process.env.USERNAME;
	const restricted =
		user !== undefined &&
		(await execFileAsync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true }).then(
			() => true,
			() => false,
		));
	if (!restricted)
		console.error("The Bluesky session file could not be restricted to your account; it keeps the folder's permissions.");
}

async function save(session: BlueskySession): Promise<BlueskySession> {
	await mkdir(configDir(), { recursive: true, mode: 0o700 });
	const target = join(configDir(), "session.json");
	const staging = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const handle = await openFile(staging, "wx", 0o600);
		try {
			await onlyTheUser(staging);
			await handle.writeFile(JSON.stringify(session));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(staging, target);
	} finally {
		await rm(staging, { force: true });
	}
	current = session;
	return session;
}

async function sessionFrom(res: Response, method: string): Promise<typeof sessionReply.infer> {
	if (!res.ok) throw await failure(res, method);
	const body = sessionReply(await res.json());
	if (body instanceof type.errors) throw new Error(`Bluesky ${method} answered without a session: ${body.summary}`);
	return body;
}

async function login(credential: Credential, fingerprint: string): Promise<BlueskySession> {
	const pds = await resolvePds(credential.handle);
	const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ identifier: credential.handle, password: credential.appPassword }),
	});
	if (res.status === 401) {
		throw new Error(
			"Bluesky refused the handle or app password (401). Make a new app password and reconnect on the Bluesky card.",
		);
	}
	if (res.status === 429) {
		throw new Error("Bluesky's sign-in limit is hit (createSession, 429). It resets within a day; do not retry now.");
	}
	const body = await sessionFrom(res, "createSession");
	return save({
		fingerprint,
		did: body.did,
		handle: body.handle.toLowerCase(),
		pds,
		accessJwt: body.accessJwt,
		refreshJwt: body.refreshJwt,
	});
}

async function refresh(stale: BlueskySession): Promise<BlueskySession> {
	const res = await fetch(`${stale.pds}/xrpc/com.atproto.server.refreshSession`, {
		method: "POST",
		headers: { Authorization: `Bearer ${stale.refreshJwt}`, Accept: "application/json" },
	});
	if (!res.ok) return login(await readCredential(), stale.fingerprint);
	const body = await sessionFrom(res, "refreshSession");
	return save({ ...stale, handle: body.handle.toLowerCase(), accessJwt: body.accessJwt, refreshJwt: body.refreshJwt });
}

async function open(): Promise<BlueskySession> {
	const credential = await readCredential();
	const fingerprint = createHash("sha256").update(`${credential.handle}\u0000${credential.appPassword}`).digest("hex");
	if (current?.fingerprint === fingerprint) return current;
	const onDisk = await readFile(join(configDir(), "session.json"), "utf8")
		.then(raw => storedSession(JSON.parse(raw)))
		.catch(() => null);
	if (onDisk && !(onDisk instanceof type.errors) && onDisk.fingerprint === fingerprint) {
		current = onDisk;
		return onDisk;
	}
	return login(credential, fingerprint);
}

export function session(): Promise<BlueskySession> {
	if (refreshing) return refreshing;
	pending ??= open().finally(() => {
		pending = null;
	});
	return pending;
}

function renewed(stale: BlueskySession): Promise<BlueskySession> {
	if (current && current.accessJwt !== stale.accessJwt) return Promise.resolve(current);
	refreshing ??= refresh(stale).finally(() => {
		refreshing = null;
	});
	return refreshing;
}

export async function authed<T>(
	method: string,
	init: { query?: Query; json?: unknown; bytes?: Uint8Array<ArrayBuffer>; contentType?: string; appview?: boolean },
): Promise<T> {
	let active = await session();
	for (let attempt = 0; ; attempt++) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${active.accessJwt}`,
			Accept: "application/json",
		};
		if (init.appview) headers["atproto-proxy"] = APPVIEW_PROXY;
		let body: BodyInit | undefined;
		if (init.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(init.json);
		} else if (init.bytes !== undefined) {
			headers["Content-Type"] = init.contentType ?? "application/octet-stream";
			body = init.bytes;
		}
		const res = await fetch(`${active.pds}/xrpc/${method}${queryString(init.query ?? {})}`, {
			method: body === undefined ? "GET" : "POST",
			headers,
			body,
		});
		if (res.ok) return (await res.json()) as T;
		const error = await failure(res, method);
		if (attempt === 0 && (error.code === "ExpiredToken" || error.code === "InvalidToken" || res.status === 401)) {
			active = await renewed(active);
			continue;
		}
		throw error;
	}
}
